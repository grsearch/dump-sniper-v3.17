'use strict';

/**
 * TickStream (v3.17: 多 region 订阅)
 * ===================================
 * 同时订阅多个 Helius LaserStream gRPC region（例如 FRA + AMS + EWR），
 * 谁先收到砸单 tx 就触发下游 — 用 signature LRU 去重。
 *
 * 为什么多 region：
 *   实测 LaserStream 推送延迟 116ms ~ 1528ms（13x 差异），其中 1.2~1.8s 的尾延迟主要来自
 *   "砸单方 tx 发到了离你订阅 region 远的 leader" → shred 传播 + Helius 节点接收都要时间。
 *   多 region 订阅取最快到达的那一份，能把那部分尾延迟压平。
 *
 * 关键设计：
 *   - 每个 region 独立一个 Client/stream，各自重连，互不影响
 *   - 监控列表变化时重建**所有** stream（保持简单，频次不高 — 一般添 token 是稀疏事件）
 *   - LRU signature 去重：最多 2000 项，5 分钟 TTL（覆盖最慢 region 的延迟范围）
 *   - 向后兼容：env 只配单一 endpoint 时退化成单 region 行为
 *
 * v1.1 历史修复保留：
 *   - 监控列表为空时不订阅（避免误订全网 Pump 流量）
 *   - accountInclude=[mints] + accountRequired=[PUMP_AMM_PROGRAM]
 *   - 监控列表变化时重建 stream
 *   - 自动重连 + 指数退避
 */

const Client = require('@triton-one/yellowstone-grpc').default;
const yellowstoneGrpc = require('@triton-one/yellowstone-grpc');
const { CommitmentLevel } = yellowstoneGrpc;
// v3.17.6: @triton-one/yellowstone-grpc v1.4+ 要求 stream.write 收到 protobuf message
// 实例，而不是 plain JS object。新 napi-rs 路径下 plain object 会被静默拒收
// （TCP 连接 OK、subscribe 调用不报错、stream.write 不报错，但 server 端拒绝
//  序列化 → 永远收不到 data → "NEVER_BEAT" 告警）。
// SubscribeRequest.create() / SubscribeRequestFilterTransactions.create() 能把
// plain object 转成正确的 protobuf message。我们 defensive 导入：
//   - 优先用 .create()（新版 SDK）
//   - fallback 到 plain object（老版 SDK 兼容）
const SubscribeRequest = yellowstoneGrpc.SubscribeRequest || null;
const SubscribeRequestFilterTransactions =
  yellowstoneGrpc.SubscribeRequestFilterTransactions || null;
const EventEmitter = require('events');
const bs58Lib = require('bs58');
const bs58 = bs58Lib.default || bs58Lib;
const { config } = require('../config');
const { getMonitor } = require('../monitor/HealthMonitor');

const PUMP_AMM_PROGRAM_ID = config.programs.pumpAmm; // string

const monitor = getMonitor();
monitor.registerModule('TickStream', { staleMs: 90_000, label: 'LaserStream gRPC' });

// LRU + TTL signature 去重
// - 容量 2000：每秒砸盘信号数通常 < 10/s，5 分钟 = 300s → 最多 3000 项，2000 已经够
// - TTL 5 分钟：覆盖最慢 region 的尾延迟（实测 < 2s）+ 余量
const DEDUP_TTL_MS = 5 * 60_000;
const DEDUP_MAX = 2000;

class SignatureDedup {
  constructor() {
    this.map = new Map(); // signature → expireAt
  }
  /** 第一次见返回 true（应处理），重复返回 false（应丢弃） */
  shouldProcess(sig) {
    if (!sig) return true; // 没 signature 时不去重（保守）
    const now = Date.now();
    const existing = this.map.get(sig);
    if (existing && existing > now) {
      return false; // 重复
    }
    this.map.set(sig, now + DEDUP_TTL_MS);
    if (this.map.size > DEDUP_MAX) {
      this._evict(now);
    }
    return true;
  }
  _evict(now) {
    // 先清过期
    for (const [k, exp] of this.map) {
      if (exp <= now) this.map.delete(k);
      if (this.map.size <= DEDUP_MAX * 0.9) return;
    }
    // 还超容量 → 删最早写入的（Map 按插入顺序）
    while (this.map.size > DEDUP_MAX * 0.9) {
      const firstKey = this.map.keys().next().value;
      if (firstKey === undefined) break;
      this.map.delete(firstKey);
    }
  }
  size() {
    return this.map.size;
  }
}

/**
 * 单个 region 的连接实例。
 * 内部管理重连、订阅、生命周期。tx 来了上抛给 TickStream 由 dedup 统一过滤。
 */
class RegionStream {
  constructor({ endpoint, token, label, onTx, onConnected }) {
    this.endpoint = endpoint;
    this.token = token;
    this.label = label;
    this.onTx = onTx;
    this.onConnected = onConnected;

    this.client = null;
    this.stream = null;
    this.connected = false;
    this.reconnectAttempts = 0;
    this.shouldRun = false;
    this._currentMints = [];
  }

  async start(mints) {
    this.shouldRun = true;
    this._currentMints = Array.from(mints);
    if (this._currentMints.length === 0) {
      console.log(`[TickStream:${this.label}] no mints to watch, idle`);
      return;
    }
    await this._connect();
  }

  async stop() {
    this.shouldRun = false;
    await this._closeStream();
  }

  async rebuild(mints) {
    this._currentMints = Array.from(mints);
    await this._closeStream();
    await new Promise((r) => setTimeout(r, 500));
    if (this.shouldRun && this._currentMints.length > 0) {
      await this._connect();
    }
  }

  async _closeStream() {
    if (this.stream) {
      try { this.stream.end(); } catch (_) { /* ignore */ }
      this.stream = null;
    }
    if (this.client) {
      this.client = null;
    }
    this.connected = false;
  }

  async _connect() {
    if (this._currentMints.length === 0) return;
    try {
      this.client = new Client(
        this.endpoint,
        this.token,
        { 'grpc.max_receive_message_length': 64 * 1024 * 1024 },
      );
      this.stream = await this.client.subscribe();

      this.stream.on('data', (msg) => this._handleMessage(msg));
      this.stream.on('error', (err) => this._handleError(err));
      this.stream.on('end', () => this._handleEnd());
      this.stream.on('close', () => this._handleEnd());

      await this._sendSubscribeRequest();
      this.connected = true;
      this.reconnectAttempts = 0;
      monitor.inc(`TickStream.${this.label}.connectsTotal`, 1, 'TickStream');
      monitor.beat('TickStream', `${this.label}:connected:${this._currentMints.length}_mints`);
      console.log(
        `[TickStream:${this.label}] connected, watching ${this._currentMints.length} mints`,
      );
      if (this.onConnected) this.onConnected(this.label);
    } catch (err) {
      monitor.recordError('TickStream', err, { phase: 'connect', region: this.label });
      console.error(`[TickStream:${this.label}] connect failed: ${err.message}`);
      this._scheduleReconnect();
    }
  }

  async _sendSubscribeRequest() {
    const mints = this._currentMints;
    if (mints.length === 0) return;

    // v3.17.6 兼容修复：新版 SDK 要求 protobuf message 实例
    // 先建 filter，再建 request；如果 .create 可用就用，否则 fallback plain object
    const filterPlain = {
      vote: false,
      failed: false,
      accountInclude: mints,
      accountExclude: [],
      accountRequired: [PUMP_AMM_PROGRAM_ID],
    };
    const filter = SubscribeRequestFilterTransactions
      ? SubscribeRequestFilterTransactions.create(filterPlain)
      : filterPlain;

    const requestPlain = {
      transactions: { pumpAmmTrades: filter },
      slots: {},
      accounts: {},
      blocks: {},
      blocksMeta: {},
      entry: {},
      transactionsStatus: {},
      accountsDataSlice: [],
      commitment: CommitmentLevel.PROCESSED,
    };
    const request = SubscribeRequest
      ? SubscribeRequest.create(requestPlain)
      : requestPlain;

    return new Promise((resolve, reject) => {
      this.stream.write(request, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  _handleMessage(msg) {
    if (!msg.transaction) return;
    monitor.inc(`TickStream.${this.label}.txReceived`, 1, 'TickStream');
    monitor.beat('TickStream', `${this.label}:tx`);
    this.onTx(msg.transaction, this.label);
  }

  _handleError(err) {
    monitor.inc(`TickStream.${this.label}.streamErrors`, 1, 'TickStream');
    monitor.recordError('TickStream', err, { phase: 'stream', region: this.label });
    console.error(`[TickStream:${this.label}] stream error: ${err.message || err}`);
    this.connected = false;
    this._scheduleReconnect();
  }

  _handleEnd() {
    if (!this.shouldRun) return;
    monitor.inc(`TickStream.${this.label}.streamEnded`, 1, 'TickStream');
    console.warn(`[TickStream:${this.label}] stream ended`);
    this.connected = false;
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (!this.shouldRun || this._currentMints.length === 0) return;
    monitor.inc(`TickStream.${this.label}.reconnects`, 1, 'TickStream');
    const delay = Math.min(30_000, 1000 * Math.pow(2, this.reconnectAttempts));
    this.reconnectAttempts += 1;
    console.log(
      `[TickStream:${this.label}] reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`,
    );
    setTimeout(() => {
      if (!this.shouldRun) return;
      this._connect();
    }, delay);
  }
}

/** 提取 tx signature（base58）—— 用于多 region 去重。 */
function extractSignature(txMessage) {
  try {
    const sig = txMessage?.transaction?.signatures?.[0];
    if (!sig) return null;
    if (typeof sig === 'string') return sig;
    if (Buffer.isBuffer(sig)) return bs58.encode(sig);
    if (sig instanceof Uint8Array) return bs58.encode(Buffer.from(sig));
    return null;
  } catch (_) {
    return null;
  }
}

class TickStream extends EventEmitter {
  constructor() {
    super();
    this.watchedMints = new Set();
    this.shouldRun = false;
    // v3.17.7: 最新观察到的 slot（任何 region 都更新，dedup 去重不影响）
    //   用于 SignalEngine 判断"砸盘信号 vs 当前最新 slot"差距，过滤陈旧信号
    this._latestSlot = 0;

    this.regions = [];
    this.dedup = new SignatureDedup();
    this._rebuildTimer = null;
    this._rebuildInProgress = false;
    this._rebuildQueued = false;

    const endpoints = config.helius.laserstreamEndpoints || [];
    if (endpoints.length === 0) {
      throw new Error(
        '[TickStream] no LaserStream endpoints configured. ' +
          'Set HELIUS_LASERSTREAM_ENDPOINTS (comma-separated) or HELIUS_LASERSTREAM_ENDPOINT.',
      );
    }
    endpoints.forEach((ep, idx) => {
      const label = this._labelForEndpoint(ep, idx);
      this.regions.push(
        new RegionStream({
          endpoint: ep,
          token: config.helius.laserstreamToken,
          label,
          onTx: (txMessage, region) => this._handleRegionTx(txMessage, region),
          onConnected: (region) => this.emit('regionConnected', region),
        }),
      );
    });
    console.log(
      `[TickStream] initialized with ${this.regions.length} region(s): ` +
        this.regions.map((r) => r.label).join(', '),
    );
  }

  _labelForEndpoint(endpoint, idx) {
    const m = endpoint.match(/(?:^|[\.\/\:])(fra|ams|ewr|slc|tyo|sg|lax|lon|pitt)\b/i);
    if (m) return m[1].toUpperCase();
    try {
      const host = endpoint.replace(/^https?:\/\//, '').split(/[:/]/)[0];
      const first = host.split('.')[0];
      return (first || `R${idx}`).toUpperCase().slice(0, 6);
    } catch (_) {
      return `R${idx}`;
    }
  }

  async start(initialMints = []) {
    this.shouldRun = true;
    initialMints.forEach((m) => this.watchedMints.add(m));
    if (this.watchedMints.size === 0) {
      console.log('[TickStream] no tokens to watch yet, idle');
      return;
    }
    await Promise.all(this.regions.map((r) => r.start(this.watchedMints)));
  }

  async stop() {
    this.shouldRun = false;
    await Promise.all(this.regions.map((r) => r.stop()));
  }

  async updateSubscription(mints) {
    this.watchedMints = new Set(mints);
    if (this._rebuildTimer) clearTimeout(this._rebuildTimer);
    this._rebuildTimer = setTimeout(() => {
      this._rebuildTimer = null;
      this._performRebuild().catch((err) => {
        monitor.recordError('TickStream', err, { phase: 'rebuild' });
        console.error(`[TickStream] rebuild failed: ${err.message}`);
      });
    }, 2000);
  }

  async _performRebuild() {
    if (this._rebuildInProgress) {
      this._rebuildQueued = true;
      return;
    }
    this._rebuildInProgress = true;
    try {
      do {
        this._rebuildQueued = false;
        const targetMints = new Set(this.watchedMints);
        console.log(
          `[TickStream] subscription change → rebuilding all ${this.regions.length} region(s) ` +
            `(${targetMints.size} mints)`,
        );
        await Promise.all(this.regions.map((r) => r.rebuild(targetMints)));
      } while (this._rebuildQueued);
    } finally {
      this._rebuildInProgress = false;
    }
  }

  /** 任一 region 收到 tx 时调用。signature 去重后才 emit 给下游。 */
  _handleRegionTx(txMessage, region) {
    const sig = extractSignature(txMessage);
    const isFirst = this.dedup.shouldProcess(sig);

    // v3.17.7: 跟踪最新 slot —— 任何 region 推过来的都更新（包括 dedup_dup 那些）
    // 用于下游 SignalEngine 判断信号是否过期（slot gap 检查）
    const slotRaw = txMessage?.slot;
    if (slotRaw != null) {
      // yellowstone-grpc 把 slot 编码成 string 或 number，都转 Number
      const slot = typeof slotRaw === 'string' ? Number(slotRaw) : slotRaw;
      if (Number.isFinite(slot) && slot > this._latestSlot) {
        this._latestSlot = slot;
      }
    }

    if (!isFirst) {
      monitor.inc(`TickStream.${region}.dedup_dup`, 1, 'TickStream');
      monitor.inc('TickStream.dedupDups', 1, 'TickStream');
      return;
    }
    monitor.inc(`TickStream.${region}.dedup_first`, 1, 'TickStream');
    monitor.inc('TickStream.txReceived', 1, 'TickStream');
    monitor.beat('TickStream', `tx_first:${region}`);
    monitor.set('TickStream.dedupSize', this.dedup.size(), 'TickStream');
    monitor.set('TickStream.latestSlot', this._latestSlot, 'TickStream');
    this.emit('transaction', txMessage, { firstRegion: region });
  }

  /** v3.17.7: 暴露 latestSlot 给 SignalEngine 做过期判断 */
  get latestSlot() {
    return this._latestSlot;
  }
}

module.exports = TickStream;
