// 做市机器人：独立进程，用自己的钱包登录 mini-dex，围绕参考价买卖两侧各挂 3 档，定时刷新。
// 用法：npm run mm:bot
//   MM_BOT_KEY=0x...            机器人钱包私钥（不填 = 每次随机新钱包，只适合离线模式，会自动领 /dev/faucet）
//   SERVER_URL=http://localhost:8787
//   MM_BOT_SYMBOL=AVAXUSDT      参考价取 Binance 中间价；设为空串则不用 Binance
//   MM_BOT_FALLBACK_PRICE=20    Binance 和本所盘口都拿不到价格时的兜底参考价
//   MM_BOT_LEVELS=3  MM_BOT_HALF_SPREAD_BPS=10  MM_BOT_STEP_BPS=10  MM_BOT_QTY=1  MM_BOT_INTERVAL_MS=3000
//   MM_BOT_ONCE=1               只跑一轮就退出（挂单留在簿上），用于演示 / 截图
// Ctrl+C 退出时会撤掉机器人自己的全部挂单。
import "dotenv/config";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import type { Hex } from "viem";
import { fetchDepth, planQuotes, capByBalance, type Quote } from "../src/marketmaker.js";
import { buildLadder, externalBest, dropCrossing, pickMid } from "../src/mmbot.js";
import { parseFixed, formatFixed } from "../src/fixed.js";
import type { Order } from "../src/engine/orderbook.js";

const env = process.env;
const BASE = env.SERVER_URL ?? "http://localhost:8787";
const SYMBOL = env.MM_BOT_SYMBOL ?? "AVAXUSDT";
const LEVELS = Number(env.MM_BOT_LEVELS ?? 3);
const HALF_SPREAD_BPS = Number(env.MM_BOT_HALF_SPREAD_BPS ?? 10);
const STEP_BPS = Number(env.MM_BOT_STEP_BPS ?? 10);
const QTY = parseFixed(env.MM_BOT_QTY ?? "1");
const MIN_QTY = parseFixed(env.MM_BOT_MIN_QTY ?? "0.01");
const FALLBACK = parseFixed(env.MM_BOT_FALLBACK_PRICE ?? "20");
const INTERVAL_MS = Number(env.MM_BOT_INTERVAL_MS ?? 3000);
const ONCE = env.MM_BOT_ONCE === "1";
const account = privateKeyToAccount((env.MM_BOT_KEY as Hex | undefined) ?? generatePrivateKey());

let token = "";

async function api<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${res.status} ${JSON.stringify(body)}`);
  return body as T;
}

async function login(chainId: number) {
  const { nonce } = await api<{ nonce: string }>(`/auth/nonce?address=${account.address}`);
  const signature = await account.signTypedData({
    domain: { name: "MiniDex", version: "1", chainId },
    types: { Login: [{ name: "address", type: "address" }, { name: "nonce", type: "string" }, { name: "statement", type: "string" }] },
    primaryType: "Login",
    message: { address: account.address, nonce, statement: "Sign in to MiniDex" },
  });
  token = (await api<{ token: string }>("/auth/login", { method: "POST", body: JSON.stringify({ address: account.address, nonce, signature }) })).token;
}

type ApiOrder = { id: string; side: Order["side"]; type: Order["type"]; price: string; qty: string; remaining: string; ts: number };
type ApiBalances = Record<"USDC" | "WAVAX", { available: string; locked: string }>;

async function myOrders(): Promise<Order[]> {
  const rows = await api<ApiOrder[]>("/orders");
  return rows.map((o) => ({
    id: o.id, owner: account.address.toLowerCase(), side: o.side, type: o.type,
    price: parseFixed(o.price), qty: parseFixed(o.qty), remaining: parseFixed(o.remaining), ts: o.ts, seq: 0,
  }));
}

async function binanceMid(): Promise<bigint | null> {
  if (!SYMBOL) return null;
  try {
    const d = await fetchDepth(SYMBOL, 5);
    if (!d.bids[0] || !d.asks[0]) return null;
    return (parseFixed(d.bids[0][0]) + parseFixed(d.asks[0][0])) / 2n;
  } catch {
    return null;
  }
}

const fmtQuote = (q: Quote) => `${q.side === "buy" ? "买" : "卖"} ${formatFixed(q.qty)} @ ${formatFixed(q.price)}`;

async function tick() {
  const own = await myOrders();
  const book = await api<{ bids: [string, string][]; asks: [string, string][] }>("/orderbook?depth=50");
  const ext = externalBest(book, own);
  const { mid, source } = pickMid(await binanceMid(), ext, FALLBACK);

  const targets = dropCrossing(buildLadder(mid, { levels: LEVELS, halfSpreadBps: HALF_SPREAD_BPS, stepBps: STEP_BPS, qty: QTY }), ext);
  const plan = planQuotes(targets, own);
  for (const o of plan.cancel) await api(`/orders/${o.id}`, { method: "DELETE" }).catch((e) => console.warn(`撤单失败 ${o.id}: ${e.message}`));

  const b = await api<ApiBalances>("/balances");
  const toPlace = capByBalance(plan.place, { USDC: parseFixed(b.USDC.available), WAVAX: parseFixed(b.WAVAX.available) }, MIN_QTY);
  for (const q of toPlace) {
    try {
      await api("/orders", { method: "POST", body: JSON.stringify({ side: q.side, type: "limit", price: formatFixed(q.price), qty: formatFixed(q.qty) }) });
    } catch (e) {
      console.warn(`挂单失败 ${fmtQuote(q)}: ${(e as Error).message}`);
    }
  }

  const now = await myOrders();
  const bids = now.filter((o) => o.side === "buy").sort((x, y) => (x.price > y.price ? -1 : 1));
  const asks = now.filter((o) => o.side === "sell").sort((x, y) => (x.price < y.price ? -1 : 1));
  console.log(
    `[mm-bot] mid=${formatFixed(mid)} (${source}) 撤 ${plan.cancel.length} 挂 ${toPlace.length} | ` +
      `买 [${bids.map((o) => `${formatFixed(o.remaining)}@${formatFixed(o.price)}`).join(", ")}] ` +
      `卖 [${asks.map((o) => `${formatFixed(o.remaining)}@${formatFixed(o.price)}`).join(", ")}]`,
  );
}

async function cancelAll() {
  for (const o of await myOrders()) await api(`/orders/${o.id}`, { method: "DELETE" }).catch(() => {});
}

async function main() {
  const config = await api<{ chainId: number; mode: string }>("/config");
  await login(config.chainId);
  console.log(`[mm-bot] 账户 ${account.address}，server ${BASE}（${config.mode}），每边 ${LEVELS} 档，每档 ${formatFixed(QTY)} WAVAX`);

  const b = await api<ApiBalances>("/balances");
  if (config.mode === "offline" && parseFixed(b.USDC.available) === 0n && parseFixed(b.WAVAX.available) === 0n) {
    await api("/dev/faucet", { method: "POST" });
    console.log("[mm-bot] 离线模式：已从 /dev/faucet 领取测试余额");
  }

  await tick();
  if (ONCE) return;

  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try { await tick(); } catch (e) { console.warn(`[mm-bot] 本轮失败: ${(e as Error).message}`); } finally { busy = false; }
  }, INTERVAL_MS);

  process.on("SIGINT", async () => {
    clearInterval(timer);
    console.log("\n[mm-bot] 退出，撤掉自己的挂单…");
    await cancelAll().catch(() => {});
    process.exit(0);
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
