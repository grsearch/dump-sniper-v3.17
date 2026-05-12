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

    // v3.17 止盈策略改造：
    //   1) 主止盈 TAKE_PROFIT_PCT 从 +8% 拉到 +50%（捕捉真正的大反弹），保留双确认
    //   2) 新增移动止盈 TRAILING_*：当 highWaterMark 涨过 +trailingActivatePct（默认 +5%）后
    //      armed，价格相对 highWaterMark 回撤 trailingDrawdownPct（默认 2%）立即卖
    //   3) 紧急止损保留 -15%
    //   4) MAX_HOLD_MS 从 15s 拉到 30min（1800000ms），给反弹更长时间
    takeProfitPct: parseFloat(process.env.TAKE_PROFIT_PCT || '50.0'),
    tpConfirmCount: parseInt(process.env.TP_CONFIRM_COUNT || '2', 10),
    tpConfirmMinGapMs: parseInt(process.env.TP_CONFIRM_MIN_GAP_MS || '300', 10),

    // 移动止盈
    //   trailingActivatePct: highWaterMark 要涨过 entryPrice × (1 + 此值/100) 才 arm
    //   trailingDrawdownPct: armed 后，价格从 highWaterMark 回撤此 % 立即 SELL
    //   trailingMinHwmAgeMs: highWaterMark 必须稳定至少此毫秒数（防单 tick 污染创虚假高点）
    //   设 trailingActivatePct=0 或 trailingDrawdownPct=0 可禁用移动止盈
    trailingActivatePct: parseFloat(process.env.TRAILING_ACTIVATE_PCT || '5.0'),
    trailingDrawdownPct: parseFloat(process.env.TRAILING_DRAWDOWN_PCT || '2.0'),
    trailingMinHwmAgeMs: parseInt(process.env.TRAILING_MIN_HWM_AGE_MS || '100', 10),

    // 紧急止损（防止灾难性下跌，比如 -97% 那种）
    // 设置为 0 可禁用紧急止损（恢复"硬扛"行为）
    emergencyStopLossPct: parseFloat(process.env.EMERGENCY_STOP_LOSS_PCT || '-15.0'),

    // 持仓上限时间（v3.17 默认改 30min = 1800000ms）
    maxHoldMs: parseInt(process.env.MAX_HOLD_MS || '1800000', 10),

    // 滑点
    buySlippageBps: parseInt(process.env.BUY_SLIPPAGE_BPS || '1500', 10),  // 15%
    sellSlippageBps: parseInt(process.env.SELL_SLIPPAGE_BPS || '2000', 10), // 20%

    // 风控（v3.17 默认 maxConcurrent 5）
    cooldownMsPerToken: parseInt(process.env.COOLDOWN_MS_PER_TOKEN || '60000', 10),
    maxConcurrentPositions: parseInt(process.env.MAX_CONCURRENT_POSITIONS || '5', 10),
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
