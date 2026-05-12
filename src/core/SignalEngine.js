'use strict';

const EventEmitter = require('events');
const { config } = require('../config');
const { getMonitor } = require('../monitor/HealthMonitor');

const monitor = getMonitor();
// SignalEngine 只在收到 dump 信号时 beat，没信号时不会心跳。砸盘信号本来就稀疏，
// 阈值 600s（10min）会经常误报。改 1h；如果 1h 没有任何砸盘信号才算异常。
monitor.registerModule('SignalEngine', { staleMs: 3600_000, label: 'Signal Engine' });

/**
 * SignalEngine
 * ============
 * 接收 DumpDetector 的 dumpSignal，应用：
 *   - 自触发过滤（不买自己刚卖出的）
 *   - 同代币冷却（cooldownMsPerToken）
 *   - 同砸单去重（v3.17.6: 同一 seller_tx 在 sellerTxDedupMs 内不重复触发）
 *   - 全局并发限制（maxConcurrentPositions）
 *
 * 通过后发出 buyOrder 事件给 Executor。
 *
 * v3.17.6 同砸单去重：
 *   实战发现:LaserStream 多 region 订阅时，同一笔砸单交易可能跨越 region 推送时间差，
 *   在 dedup TTL 过期后（5min）被某个慢 region 重新推过来。这会让冷却期失效:
 *   - mint 冷却是 60s，到 5+分钟时已经过了
 *   - 同一砸单的 LaserStream 重推 → mint 冷却通过 → 触发第二次 BUY
 *   - 但这时价格已经跌了 20%，根本不是反弹窗口 → 亏
 *
 *   修复思路:在 SignalEngine 层加 seller_tx 去重，同砸单 N 分钟内不重复触发。
 *   持久化:同时记录到 SQLite signals 表(已有 seller_tx 字段)。启动时从 DB
 *           恢复最近 N 分钟内 accepted=1 的 seller_tx 进内存，重启不丢。
 */
class SignalEngine extends EventEmitter {
  constructor({ tradeLogger, positionManager }) {
    super();
    this.tradeLogger = tradeLogger;
    this.positionManager = positionManager;
    this.lastTriggerTs = new Map();    // mint → ts
    this.ourSignatures = new Set();    // 我们自己发出的 tx 签名（避免自触发）
    this.inflightBuys = new Set();     // 正在 buy 但还没 registerOpen 的 mint（防并发超额）
    // v3.17.6: 已经触发过买入的砸单 tx → expireAt
    this.triggeredSellerTxs = new Map();

    // 启动时从 DB 恢复最近的 accepted seller_tx，防止重启后 LaserStream 重推同砸单
    this._restoreSellerTxsFromDb();

    // 后台定期清理过期项（避免内存泄漏；setTimeout 也有但 Map 用一个统一清理更可靠）
    this._cleanupInterval = setInterval(() => this._cleanupExpired(), 60_000);
    if (this._cleanupInterval.unref) this._cleanupInterval.unref();
  }

  shutdown() {
    if (this._cleanupInterval) clearInterval(this._cleanupInterval);
  }

  _restoreSellerTxsFromDb() {
    const dedupMs = config.strategy.sellerTxDedupMs;
    try {
      const rows = this.tradeLogger.getRecentAcceptedSellerTxs(dedupMs);
      const now = Date.now();
      let restored = 0;
      for (const row of rows) {
        if (!row.seller_tx) continue;
        const expireAt = row.ts + dedupMs;
        if (expireAt > now) {
          this.triggeredSellerTxs.set(row.seller_tx, expireAt);
          restored += 1;
        }
      }
      if (restored > 0) {
        console.log(
          `[SignalEngine] restored ${restored} triggered seller_tx from DB ` +
            `(within last ${Math.round(dedupMs / 60_000)}min, dedup window)`,
        );
        monitor.set('SignalEngine.sellerTxRestored', restored, 'SignalEngine');
      }
    } catch (err) {
      monitor.recordError('SignalEngine', err, { phase: 'restoreSellerTxs' });
      console.warn(`[SignalEngine] failed to restore seller_tx dedup: ${err.message}`);
    }
  }

  _cleanupExpired() {
    const now = Date.now();
    let cleaned = 0;
    for (const [sig, expireAt] of this.triggeredSellerTxs) {
      if (expireAt <= now) {
        this.triggeredSellerTxs.delete(sig);
        cleaned += 1;
      }
    }
    if (cleaned > 0) {
      monitor.set('SignalEngine.sellerTxsTracked', this.triggeredSellerTxs.size, 'SignalEngine');
    }
  }

  /**
   * 由 main 在调用 executor.buy 前后通知 SignalEngine。
   * 这样 openPositionCount + inflightBuys 一起算"占用槽位"。
   */
  markBuyInflight(mint) {
    this.inflightBuys.add(mint);
  }
  markBuyDone(mint) {
    this.inflightBuys.delete(mint);
  }

  registerOurSignature(sig) {
    if (!sig) return;
    this.ourSignatures.add(sig);
    setTimeout(() => this.ourSignatures.delete(sig), 5 * 60_000);
  }

  handleDumpSignal(signal) {
    monitor.beat('SignalEngine', 'signal');
    const { mint, symbol, sellSol, priceImpactPct, seller, signature, ts } = signal;

    // 1. 自触发过滤
    if (signature && this.ourSignatures.has(signature)) {
      monitor.inc('SignalEngine.rejectedSelfTrigger', 1, 'SignalEngine');
      this._logReject(signal, 'self-triggered');
      return;
    }

    // 2. v3.17.6: 同砸单去重 — 同一 seller_tx 在 sellerTxDedupMs 内不重复触发
    //    防止 LaserStream 多 region 跨越 dedup TTL 后重推同一砸单
    if (signature && this.triggeredSellerTxs.has(signature)) {
      const expireAt = this.triggeredSellerTxs.get(signature);
      if (expireAt > Date.now()) {
        monitor.inc('SignalEngine.rejectedDuplicateSellerTx', 1, 'SignalEngine');
        this._logReject(signal, `duplicate seller_tx (already triggered, expires in ${Math.round((expireAt - Date.now()) / 1000)}s)`);
        return;
      }
      // 已过期：删了走正常流程
      this.triggeredSellerTxs.delete(signature);
    }

    // 3. 冷却
    const last = this.lastTriggerTs.get(mint);
    if (last && Date.now() - last < config.strategy.cooldownMsPerToken) {
      monitor.inc('SignalEngine.rejectedCooldown', 1, 'SignalEngine');
      this._logReject(signal, `cooldown (${Math.round((Date.now() - last) / 1000)}s ago)`);
      return;
    }

    // 4. 并发限制（同时计算已开仓 + 正在 buy 的）
    const openCount = this.positionManager.openPositionCount();
    const inflightCount = this.inflightBuys.size;
    const totalSlotsUsed = openCount + inflightCount;
    if (totalSlotsUsed >= config.strategy.maxConcurrentPositions) {
      monitor.inc('SignalEngine.rejectedMaxConcurrent', 1, 'SignalEngine');
      this._logReject(
        signal,
        `max concurrent (${openCount} open + ${inflightCount} inflight / ${config.strategy.maxConcurrentPositions})`,
      );
      return;
    }

    // 5. 同代币当前已有持仓 OR 正在 buy 中
    if (this.positionManager.hasOpenPosition(mint) || this.inflightBuys.has(mint)) {
      monitor.inc('SignalEngine.rejectedAlreadyHolding', 1, 'SignalEngine');
      this._logReject(signal, this.inflightBuys.has(mint) ? 'buy in-flight' : 'already holding');
      return;
    }

    // ============ 通过 → 触发买入 ============
    monitor.inc('SignalEngine.signalsAccepted', 1, 'SignalEngine');
    this.lastTriggerTs.set(mint, Date.now());

    // v3.17.6: 记录此 seller_tx，避免后续 N 分钟内被同一砸单二次触发
    if (signature) {
      const dedupMs = config.strategy.sellerTxDedupMs;
      this.triggeredSellerTxs.set(signature, Date.now() + dedupMs);
      monitor.set('SignalEngine.sellerTxsTracked', this.triggeredSellerTxs.size, 'SignalEngine');
    }

    // v3.10: 先 emit buyOrder（让 Executor 立即开始工作），再异步写 DB
    // SQLite WAL 模式下写入也要 1-3ms，省下来给关键路径
    this.emit('buyOrder', {
      ...signal,
      reason: `dump: sell ${sellSol.toFixed(2)} SOL, impact -${priceImpactPct.toFixed(2)}%`,
      sizeSol: config.strategy.positionSizeSol,
    });

    console.log(
      `[SignalEngine] ✅ BUY_SIGNAL ${symbol || mint.slice(0, 6)}: sell=${sellSol.toFixed(
        2,
      )} SOL, impact=-${priceImpactPct.toFixed(2)}%, seller_tx=${signature ? signature.slice(0, 8) + '..' : 'n/a'}`,
    );

    // 异步写 DB（不阻塞 BUY 路径）
    // 写入时 accepted=1 + seller_tx，启动时 _restoreSellerTxsFromDb 就靠这个恢复
    setImmediate(() => {
      try {
        this.tradeLogger.logSignal({
          ts,
          mint,
          symbol,
          kind: 'BUY_SIGNAL',
          sellSol,
          priceImpactPct,
          seller,
          sellerTx: signature,
          notes: `dump signal accepted; sellSol=${sellSol.toFixed(2)}, impact=${priceImpactPct.toFixed(2)}%`,
          accepted: true,
        });
      } catch (err) {
        monitor.recordError('SignalEngine', err, { phase: 'logSignal_async' });
      }
    });
  }

  _logReject(signal, reason) {
    this.tradeLogger.logSignal({
      ts: signal.ts,
      mint: signal.mint,
      symbol: signal.symbol,
      kind: 'DUMP_DETECTED',
      sellSol: signal.sellSol,
      priceImpactPct: signal.priceImpactPct,
      seller: signal.seller,
      sellerTx: signal.signature,
      notes: 'detected but rejected',
      accepted: false,
      rejectReason: reason,
    });
    console.log(
      `[SignalEngine] ⏭  rejected ${signal.symbol || signal.mint.slice(0, 6)}: ${reason}`,
    );
  }
}

module.exports = SignalEngine;
