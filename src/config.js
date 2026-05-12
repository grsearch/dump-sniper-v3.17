'use strict';

require('dotenv').config();

const config = {
  // ============ Mode ============
  DRY_RUN: (process.env.DRY_RUN ?? 'true').toLowerCase() === 'true',

  // ============ Strategy ============
  strategy: {
    // 触发条件（DumpDetector）
    minSellSol: parseFloat(process.env.MIN_SELL_SOL || '15.0'),
    minPriceImpactPct: parseFloat(process.env.MIN_PRICE_IMPACT_PCT || '12.0'),
    // v3.10: 实盘观察 — 阈值过宽抓"伪砸盘"（大池子 10 SOL 卖单价格几乎不动），
    // 也抓"流动性已死"（小池子 30%+ impact 但反弹空间小且滑点巨大）
    // 加这两条过滤
    maxPriceImpactPct: parseFloat(process.env.MAX_PRICE_IMPACT_PCT || '30.0'),
    minPoolQuoteSol: parseFloat(process.env.MIN_POOL_QUOTE_SOL || '30.0'),

    // 仓位
    positionSizeSol: parseFloat(process.env.POSITION_SIZE_SOL || '0.1'),

    // v3.17 止盈策略改造，v3.17.6 实战调参：
    //   1) 主止盈 TAKE_PROFIT_PCT +50%（保留双确认）— 捕捉大反弹
    //   2) 移动止盈 TRAILING_* — 锁中等反弹利润（实战主要止盈来源）
    //      v3.17.6 调参：从 5%/2% 拉到 8%/3%
    //      - 实战发现 AMM 自买入会推高池子价格 5-10%（我们 3 SOL 进 30 SOL 池子约 +10%）
    //      - 这导致 5% activate 太敏感，会被自买入虚高触发
    //      - 但这个问题在 v3.17.6 用 stabilization 期 + 中位数 baseline 已根治
    //      - 所以 8% 是"双保险"：stabilization 过滤瞬态高价 + 8% 阈值再过滤一道
    //      - openclaw 拍脑袋拉到 15%/5% 过于保守，会错过大部分中等反弹
    //   3) 紧急止损 -15% 不变
    //   4) MAX_HOLD_MS 30min 不变
    takeProfitPct: parseFloat(process.env.TAKE_PROFIT_PCT || '50.0'),
    tpConfirmCount: parseInt(process.env.TP_CONFIRM_COUNT || '2', 10),
    tpConfirmMinGapMs: parseInt(process.env.TP_CONFIRM_MIN_GAP_MS || '300', 10),

    // 移动止盈（v3.17.6 调参）
    //   trailingActivatePct: HWM 涨过 entryPrice × (1 + 此值/100) 才 arm
    //   trailingDrawdownPct: armed 后，价格从 HWM 回撤此 % 立即 SELL
    //   trailingMinHwmAgeMs: HWM 必须稳定至少此毫秒数（防单 tick 污染）
    //   设 trailingActivatePct=0 或 trailingDrawdownPct=0 可禁用移动止盈
    trailingActivatePct: parseFloat(process.env.TRAILING_ACTIVATE_PCT || '8.0'),
    trailingDrawdownPct: parseFloat(process.env.TRAILING_DRAWDOWN_PCT || '3.0'),
    trailingMinHwmAgeMs: parseInt(process.env.TRAILING_MIN_HWM_AGE_MS || '2000', 10),

    // v3.17.6: Stabilization 期 —— reconcile 完成后等价格稳定，再开始 trailing 追踪
    //   原理：砸盘后 + 我们自买入 → 池子价格剧烈波动 + 虚高 5-10%
    //         如果 reconcile 完成立刻开始追 HWM，第一个 tick 就是虚高瞬态值
    //         → trailing 立刻 armed → 真实价格回归被误判"回撤" → 误杀
    //   修复：reconcile 完成后进入 stabilization 期（默认 5 秒）：
    //         - 收集所有 priceTick 进 buffer
    //         - 不更新 HWM，不武装 trailing，不检查 TP
    //         - emergency_stop 仍正常工作（救命路径不能屏蔽）
    //         期满取样本中位数作为 HWM 起点，过滤自买入推高和砸盘瞬态
    //   实战权衡：
    //     - 5 秒：覆盖砸盘后短暂剧烈波动（实测多数 < 3 秒就稳定）
    //     - 太短（< 3s）：保护不够，自买入虚高没消化完
    //     - 太长（> 10s）：错过早期快速反弹的入场窗口
    stabilizationMs: parseInt(process.env.STABILIZATION_MS || '5000', 10),

    // 紧急止损（防止灾难性下跌）
    // 设置为 0 可禁用紧急止损（恢复"硬扛"行为）
    emergencyStopLossPct: parseFloat(process.env.EMERGENCY_STOP_LOSS_PCT || '-15.0'),

    // 持仓上限时间（v3.17 默认 30min = 1800000ms）
    maxHoldMs: parseInt(process.env.MAX_HOLD_MS || '1800000', 10),

    // 滑点
    buySlippageBps: parseInt(process.env.BUY_SLIPPAGE_BPS || '1500', 10),  // 15%
    sellSlippageBps: parseInt(process.env.SELL_SLIPPAGE_BPS || '2000', 10), // 20%

    // 风控（v3.17 默认 maxConcurrent 5）
    cooldownMsPerToken: parseInt(process.env.COOLDOWN_MS_PER_TOKEN || '60000', 10),
    maxConcurrentPositions: parseInt(process.env.MAX_CONCURRENT_POSITIONS || '5', 10),

    // v3.17.6: 同砸单去重时间窗（毫秒）
    //   防 LaserStream 多 region 跨越 dedup TTL 后重推同一砸单导致二次触发
    //   实战案例：同一 seller_tx 在 2 分钟后被慢 region 重新推送 → 价格已跌 20% → 亏
    //   10 分钟覆盖最慢 region + 重启窗口，且通过 signals 表持久化（启动时恢复）
    sellerTxDedupMs: parseInt(process.env.SELLER_TX_DEDUP_MS || '600000', 10),
  },

  // ============ Price anomaly filter ============
  priceFilter: {
    // 单 tick 价格变化超过 maxJumpRatio 视为可疑
    // 1.5 表示 +50% 或 -33%（1/1.5）以上属于异常
    maxJumpRatio: parseFloat(process.env.PRICE_MAX_JUMP_RATIO || '1.5'),
    // 可疑样本必须在多少毫秒内连续出现并方向一致才接受
    confirmWindowMs: parseInt(process.env.PRICE_CONFIRM_WINDOW_MS || '3000', 10),
    confirmMinSamples: parseInt(process.env.PRICE_CONFIRM_MIN_SAMPLES || '2', 10),
  },

  // ============ Helius ============
  // v3.17: 支持多 region LaserStream + 多 region Sender
  //   - laserstreamEndpoints: 数组，多 region gRPC 订阅，最快的 region 命中即触发（signature 去重）
  //   - senderEndpoints:      数组，多 region Sender 并发提交，Promise.race 取最快返回
  //   - 向后兼容：未配 _ENDPOINTS 时回退到旧的单 endpoint 字段
  helius: {
    apiKey: process.env.HELIUS_API_KEY,
    rpcUrl: process.env.HELIUS_RPC_URL,
    stakedRpcUrl: process.env.HELIUS_STAKED_RPC_URL,

    // ---- LaserStream（多 region 订阅）----
    // 优先读 HELIUS_LASERSTREAM_ENDPOINTS（逗号分隔多个）
    // fallback 到旧的 HELIUS_LASERSTREAM_ENDPOINT（单 endpoint）
    laserstreamEndpoint: process.env.HELIUS_LASERSTREAM_ENDPOINT,
    laserstreamEndpoints: (() => {
      const multi = (process.env.HELIUS_LASERSTREAM_ENDPOINTS || '').trim();
      if (multi) {
        return multi.split(',').map((s) => s.trim()).filter(Boolean);
      }
      const single = (process.env.HELIUS_LASERSTREAM_ENDPOINT || '').trim();
      return single ? [single] : [];
    })(),
    laserstreamToken: process.env.HELIUS_LASERSTREAM_TOKEN,

    // ---- Sender（多 region 提交）----
    // 优先读 HELIUS_SENDER_ENDPOINTS（逗号分隔多个）
    // fallback 到旧的 HELIUS_SENDER_ENDPOINT
    senderEndpoint: process.env.HELIUS_SENDER_ENDPOINT || null,
    senderEndpoints: (() => {
      const multi = (process.env.HELIUS_SENDER_ENDPOINTS || '').trim();
      if (multi) {
        return multi.split(',').map((s) => s.trim()).filter(Boolean);
      }
      const single = (process.env.HELIUS_SENDER_ENDPOINT || '').trim();
      return single ? [single] : [];
    })(),
  },

  // ============ Birdeye ============
  birdeye: {
    apiKey: process.env.BIRDEYE_API_KEY,
    baseUrl: 'https://public-api.birdeye.so',
  },

  // ============ Wallet ============
  wallet: {
    privateKeyBs58: process.env.WALLET_PRIVATE_KEY_BS58,
  },

  // ============ Programs ============
  programs: {
    pumpAmm: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
    tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    associatedTokenProgram: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
    systemProgram: '11111111111111111111111111111111',
    wsol: 'So11111111111111111111111111111111111111112',
  },

  // ============ Server ============
  server: {
    port: parseInt(process.env.DASHBOARD_PORT || '3001', 10),
    bindHost: process.env.BIND_HOST || '0.0.0.0',
    webhookSecret: process.env.WEBHOOK_SECRET || null,
    dashboardToken: process.env.DASHBOARD_TOKEN || null,
  },

  // ============ Storage ============
  storage: {
    dbPath: './data/sniper.db',
    reportsDir: './reports',
    logsDir: './logs',
  },

  // ============ Priority fees ============
  // BUY 和 SELL 分开配置：
  //   - BUY 是抢 slot 的（砸盘后所有 sniper 同抢），需要高 fee
  //   - SELL 是平仓的（晚 1-3 个 slot 落链没差别），低 fee 即可
  // 实测竞争者：BUY 0.012-0.045 SOL，SELL <0.0001-0.003 SOL
  priorityFee: {
    // 静态模式（dynamic=false 时使用）
    buyMaxLamports: parseInt(process.env.BUY_MAX_PRIORITY_FEE_LAMPORTS || '20000000', 10),  // 0.02 SOL
    sellMaxLamports: parseInt(process.env.SELL_MAX_PRIORITY_FEE_LAMPORTS || '500000', 10),  // 0.0005 SOL

    // 动态模式：用 Helius getPriorityFeeEstimate 查 mempool 实时拥堵
    // 砸盘事件中整网 fee 飙升，动态调整能跟上竞争者节奏
    dynamic: (process.env.PRIORITY_FEE_DYNAMIC ?? 'true').toLowerCase() === 'true',

    // 动态模式参数
    // BUY 用 high (75th) 或 veryHigh (95th)，SELL 用 medium (50th)
    buyLevel: process.env.BUY_PRIORITY_LEVEL || 'veryHigh',  // 抢入用最高级别
    sellLevel: process.env.SELL_PRIORITY_LEVEL || 'medium',  // 卖出用中等

    // 动态查询的保底 (避免 RPC 返回 0/异常)
    buyMinLamports: parseInt(process.env.BUY_MIN_PRIORITY_FEE_LAMPORTS || '10000000', 10),  // 0.01 SOL
    sellMinLamports: parseInt(process.env.SELL_MIN_PRIORITY_FEE_LAMPORTS || '100000', 10),  // 0.0001 SOL

    // 动态查询的上限 (即使 mempool 极拥堵也不超过)
    buyCapLamports: parseInt(process.env.BUY_CAP_PRIORITY_FEE_LAMPORTS || '200000000', 10),  // 0.2 SOL — v3.11: 之前 0.05 SOL cap 把 μL/CU 卡死在 250K，竞争者实测 40M+ μL/CU
    sellCapLamports: parseInt(process.env.SELL_CAP_PRIORITY_FEE_LAMPORTS || '2000000', 10), // 0.002 SOL
  },

  // 旧字段保留，向后兼容（仅用于 fallback）
  maxPriorityFeeLamports: parseInt(process.env.MAX_PRIORITY_FEE_LAMPORTS || '5000000', 10), // 0.005 SOL

  // 启动时是否自动尝试补充缺失的 pool 信息（PoolFinder）
  autoFillPoolsOnStart: (process.env.AUTO_FILL_POOLS_ON_START ?? 'true').toLowerCase() === 'true',
};

function validateConfig() {
  const errors = [];
  if (!config.helius.apiKey) errors.push('HELIUS_API_KEY missing');
  if (!config.helius.rpcUrl) errors.push('HELIUS_RPC_URL missing');
  // v3.17: laserstreamEndpoints 数组非空（旧 _ENDPOINT 也会被收进数组）
  if (!config.helius.laserstreamEndpoints || config.helius.laserstreamEndpoints.length === 0) {
    errors.push('HELIUS_LASERSTREAM_ENDPOINT (or HELIUS_LASERSTREAM_ENDPOINTS) missing');
  }
  if (!config.helius.laserstreamToken) errors.push('HELIUS_LASERSTREAM_TOKEN missing');
  if (!config.birdeye.apiKey) errors.push('BIRDEYE_API_KEY missing');
  if (!config.DRY_RUN && !config.wallet.privateKeyBs58) {
    errors.push('WALLET_PRIVATE_KEY_BS58 required for LIVE mode');
  }
  return errors;
}

module.exports = { config, validateConfig };
