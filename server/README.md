# mini-dex server

教学用链下撮合后端：撮合引擎 + 内存账本 + EIP-712 登录 + Vault 事件监听。**不落库，重启即丢。**

```
src/engine/orderbook.ts   撮合引擎（价格-时间优先，成交价 = maker 价，拒绝自成交）
src/engine/orderbook.test.ts
src/fixed.ts              8 位小数定点数 <-> 十进制字符串
src/ledger.ts             内存账本 available / locked
src/auth.ts               EIP-712 登录 -> JWT
src/chain.ts              监听 Vault Deposit；签 Withdraw 授权
src/marketmaker.ts        做市：把 Binance 盘口镜像到本所订单簿（+test）
src/routes.ts             HTTP API（下单冻结 / 成交划转 / 撤单解冻）
src/ws.ts                 WebSocket 广播
src/index.ts              入口
src/mmbot.ts              做市机器人的报价逻辑：围绕参考价买卖各 N 档（+test）
scripts/smoke.ts          冒烟脚本
scripts/mm-bot.ts         独立做市机器人进程（npm run mm:bot）
```

## 快速开始

```bash
npm install
cp .env.example .env
npm run dev          # http://localhost:8787
npm test             # 撮合引擎 / 账本 / 定点数 单元测试
npm run typecheck
```

## 三种运行模式（只改 `.env`）

### 1. 离线模式（不需要链，先把引擎和 API 跑通）
`VAULT_ADDRESS=` 留空即可。不监听链上事件，多开放一个 `POST /dev/faucet`（需 Bearer），
每调一次给当前用户发 10000 USDC + 100 WAVAX。`/withdraw` 在这个模式下返回 400。

```bash
npm run dev
npm run smoke        # 另开一个终端
```
smoke 脚本会：生成两个随机钱包 -> nonce -> 签 EIP-712 -> login -> 领水 -> seller 挂 sell limit -> buyer 打 buy market
-> 打印 fills / balances / orderbook，并校验余额对得上。

### 2. anvil 模式（课前排练，chainId 31337）
```bash
anvil                                            # 终端 1
cd ../contracts && forge script script/Deploy.s.sol --broadcast --rpc-url http://127.0.0.1:8545   # 终端 2
```
把 Deploy 输出的地址填进 `.env`：`VAULT_ADDRESS` / `USDC_ADDRESS` / `WAVAX_ADDRESS`，
`CHAIN_ID=31337`，`RPC_URL=http://127.0.0.1:8545`，然后 `npm run dev`。
`BACKEND_SIGNER_PRIVATE_KEY` 默认是 anvil 账户 #1（公开测试私钥），Deploy 脚本要把 Vault.signer 设成对应地址。

### 3. Fuji 模式（chainId 43113）
同上，`CHAIN_ID=43113`，`RPC_URL=https://api.avax-test.network/ext/bc/C/rpc`，地址换成 Fuji 上部署的。
**换一把新的 `BACKEND_SIGNER_PRIVATE_KEY`**，别用 anvil 的公开私钥。

## 做市（可选）：订单簿用 Binance 数据跑起来

`.env` 里 `MARKET_MAKER=1`。后端每 `MM_INTERVAL_MS`（默认 2s）拉一次 Binance `MM_SYMBOL`（默认 AVAXUSDT）的深度，
取每边前 `MM_LEVELS` 档、数量 × `MM_SCALE`，和做市账户现有挂单做**增量**对比：

- 价格不在目标里的撤单；
- 同价但剩余量偏差超过 20%（被用户吃掉一部分）的撤掉重挂；
- 目标里缺的补挂；挂单前按做市账户可用余额裁剪。

做市账户 `MM_ADDRESS` 是账本里的普通地址，启动时按 `MM_SEED_USDC` / `MM_SEED_WAVAX` 虚拟注资（设 0 则只用它真实 deposit 的钱）。
`GET /config` 会多返回 `marketMaker: {address, symbol, source}`，前端据此在订单簿右上角显示"流动性镜像 Binance"。
下单 / 撤单核心已抽成 `routes.ts` 里的 `placeOrder` / `cancelOrder`，HTTP 接口和做市模块共用同一套冻结 / 撮合 / 结算逻辑。

## 做市机器人（独立进程）：买卖两侧各挂 3 档

`scripts/mm-bot.ts` 是一个像真实做市商那样的外部程序：用自己的钱包走 EIP-712 登录，通过 HTTP API 下单 / 撤单。

```bash
npm run dev                         # 终端 1：后端
npm run mm:bot                      # 终端 2：机器人（Ctrl+C 退出时撤掉自己的挂单）
MM_BOT_ONCE=1 npm run mm:bot        # 只挂一轮就退出，挂单留在簿上
```

- 参考价 mid：Binance `MM_BOT_SYMBOL` 买一卖一中间价 → 拿不到时用本所别人的买一卖一中间价 → 再拿不到用 `MM_BOT_FALLBACK_PRICE`。
- 第 i 档（i = 0,1,2）价格 = mid × (1 ∓ (`MM_BOT_HALF_SPREAD_BPS` + i × `MM_BOT_STEP_BPS`) / 10000)，买价向下、卖价向上取整到 0.0001。
- 只挂单不吃单：会和别人挂单交叉的档位直接跳过；每轮用 `planQuotes` 增量撤挂，先撤后挂，不会撞上自己的单（撮合引擎拒绝自成交）。
- 钱包：`MM_BOT_KEY`；不填则随机生成，离线模式下自动领 `/dev/faucet`。链上模式需要先给这个地址 deposit。
- 报价逻辑在 `src/mmbot.ts`（纯函数，`src/mmbot.test.ts` 覆盖）。

## 自成交（self-trade）
新订单如果会和**同一地址自己的挂单**成交，撮合引擎整单拒绝（`SelfTradeError`，HTTP 返回 400），订单簿和余额都不变；
检查在撮合之前做，所以不会出现"先吃了别人一部分、再碰到自己"的半成交。

## 接口速查
见课程设计文档 §3.4。金额全部是十进制字符串（"100.5"），内部 bigint × 1e8。

- `GET /auth/nonce?address=` → `POST /auth/login {address, nonce, signature}` → `{token}`
- `GET /me` `GET /balances` `GET /orders` `POST /orders` `DELETE /orders/:id` `POST /withdraw`（Bearer）
- `GET /orderbook?depth=10` `GET /trades?limit=50` `GET /config`
- `ws://localhost:8787/ws`：连上就收到 `orderbook` 快照；发 `{"type":"auth","token"}` 后才会收到自己的 `balance`。

## 课上要讲的点
- 成交价 = maker 价（挂单价），taker 出价只是上限/下限。
- 下单先冻结、成交再划转、撤单解冻——账本永远守恒。
- 地址一律小写（Primit 踩过的坑）。
- signer 私钥 = 金库钥匙：提现不受链上余额约束，生产要 HSM/多签 + 限额。
