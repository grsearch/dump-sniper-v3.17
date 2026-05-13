# v3.17.10 升级说明

> **必须立即升级** — v3.17.9 及之前在 LaserStream SDK 升级到 v5 时会"静默失败"
> (TCP 连接上,subscribe 不报错,但 0 tx 收到)。openclaw 实战遇到 230 秒无 tx,
> 通过升级 SDK 到 v5.0.8 + 加 `await client.connect()` 修复。

---

## 改了什么(2 个改动)

### 1. 🔥 关键修复:`@triton-one/yellowstone-grpc` v5 napi-rs 适配

**症状**:
```
[WARN] tickstream.no_traffic LaserStream 监控 84 个代币,但 60s+ 无 tx 收到 230s ago
```

84 个代币加进监控了,但 LaserStream **完全收不到任何数据**。

**根因**:
1. `@triton-one/yellowstone-grpc` v5.0.0(2026-01)从 `@grpc/grpc-js` 迁移到 **napi-rs**(Rust 实现)
2. 官方文档说 "no breaking changes",但实操中**必须先 `await client.connect()`** 才能 `await client.subscribe()`
3. 我之前代码直接调 `client.subscribe()`,在 v5 SDK 下 stream 没有真正绑定 gRPC 连接
4. 结果:`stream.write(request)` 不报错,Helius server 也认你订阅了,但**数据永远不到客户端**

**修复**(`src/core/TickStream.js`):
```javascript
// v3.17.10:v5+ SDK 要求显式 connect()
if (typeof this.client.connect === 'function') {
  await this.client.connect();
}
this.stream = await this.client.subscribe();
```

**兼容性**:
- ✅ v5 SDK:必须 connect(),`typeof connect === 'function'` 触发调用
- ✅ v4/v3 SDK:没 connect 方法,typeof 检查跳过,行为不变

**SDK 版本锁定**:`package.json` 从 `^1.3.0` → `^5.0.8`,避免新部署再踩坑。

### 2. Region Label 提取适配新 URL 格式

**症状**(openclaw 实战):
```
[TickStream] initialized with 3 region(s): LASERS, LASERS, LASERS  ❌
```

3 个 region 全显示 "LASERS",无法分辨日志里哪个 region 慢。

**根因**:
- 旧 URL:`https://laserstream-mainnet-fra.helius-rpc.com` → 老正则匹配 `-fra.` → "FRA" ✅
- 新 URL:`https://laserstream-fra.mainnet.helius-rpc.com` → 老正则没匹配 → 走 fallback `host.split('.')[0].slice(0,6)` → `laserstream-mainnet-fra` → **"LASERS"** ❌

**修复**:新的 `_labelForEndpoint`:
1. 拆 host 为 token(按 `. - _` 分割)
2. 遍历 token,匹配已知 region code 列表
3. 都不匹配才走 fallback,且跳过 `laserstream/mainnet/grpc/www` 这类通用前缀

支持的 URL 格式(已验证):
- `laserstream-mainnet-fra.helius-rpc.com` → FRA ✅
- `laserstream-fra.mainnet.helius-rpc.com` → FRA ✅
- `fra.laserstream.helius-rpc.com` → FRA ✅
- 自定义 endpoint → 取第一个非通用 token

---

## 部署步骤

```bash
cd /opt/dump-sniper
sudo systemctl stop dump-sniper

git pull origin main

# 必须删 node_modules 并重新 install,因为 yellowstone-grpc 从 1.x 升到 5.x
sudo rm -rf node_modules package-lock.json
sudo -u dump-sniper npm install --omit=dev

sudo systemctl start dump-sniper
```

**关键差异:`npm install` 必须删 lock 重装** — yellowstone-grpc 5.0.0+ 是 napi-rs 原生模块,
依赖平台特定的二进制文件,不能复用旧的 node_modules。

---

## 验证(部署后立即检查)

```bash
sudo journalctl -u dump-sniper -n 50 | grep -E "TickStream|laserstream"
```

期望看到(30 秒内):

```
[TickStream] initialized with 3 region(s): FRA, EWR, TYO   ← 不再是 LASERS, LASERS, LASERS
[TickStream:FRA] connected, watching 84 mints
[TickStream:EWR] connected, watching 84 mints
[TickStream:TYO] connected, watching 84 mints
```

然后 30 秒后跑:

```bash
npm run health
```

看 `TickStream.txReceived` 计数器,**必须每秒在涨**(健康情况下应该有几千笔/分钟)。

如果还是 0 tx 或者出现 `tickstream.no_traffic` 告警,有几种可能:
1. `HELIUS_LASERSTREAM_TOKEN` 错了(去 Helius dashboard 重新生成)
2. Helius 套餐到期 / 余额耗尽
3. 监控列表为空(检查 tokenRegistry)

---

## 关于 openclaw 这次修复的评价

✅ **思路完全正确**:他诊断的根因(SDK 版本不兼容 + 缺 connect)都对
✅ **修复有效**:30 秒收到 10272 笔交易,问题彻底解决
✅ **额外发现**:他自己修复了 region label 显示问题

⚠️ **我跟他的实现差别**:他直接改了运行版,我做了 **defensive 兼容**:
- 用 `typeof client.connect === 'function'` 判断,**v4/v3 SDK 也能跑**(不会因为没 connect 方法报错)
- Region label 提取用更稳健的 token 匹配,支持各种 URL 变体

这样未来 SDK 再升级或者换 endpoint 也不会突然崩。
