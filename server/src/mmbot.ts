// 做市机器人的报价逻辑（纯函数，给 scripts/mm-bot.ts 用）。
// 和 marketmaker.ts（后端进程内镜像 Binance 盘口）不同：机器人是独立进程，像普通用户一样登录、走 HTTP 下单。
// 策略：围绕参考价 mid，买卖两侧各挂 N 档（默认 3），第 i 档离 mid 的距离 = halfSpread + i × step（单位 bps）。

import { parseFixed } from "./fixed.js";
import type { Order } from "./engine/orderbook.js";
import type { Quote } from "./marketmaker.js";

const BPS = 10_000n;
/** 价格最小变动单位 0.0001（和 marketmaker 的 4 位小数一致） */
export const TICK = 10n ** 4n;

export interface LadderOptions {
  levels: number;      // 每边档数
  halfSpreadBps: number; // 第 0 档离 mid 的距离
  stepBps: number;     // 相邻档位间距
  qty: bigint;         // 每档数量（8 位定点）
}

/** 生成梯子：买单价向下取整、卖单价向上取整到 TICK，保证买卖价不会跨过 mid；取整后重复的价位只留一个 */
export function buildLadder(mid: bigint, o: LadderOptions): Quote[] {
  if (mid <= 0n) return [];
  const bids: Quote[] = [];
  const asks: Quote[] = [];
  for (let i = 0; i < o.levels; i++) {
    const bps = BigInt(Math.round(o.halfSpreadBps + i * o.stepBps));
    const bid = floorTick((mid * (BPS - bps)) / BPS);
    const ask = ceilTick((mid * (BPS + bps) + BPS - 1n) / BPS);
    if (bid > 0n && !bids.some((q) => q.price === bid)) bids.push({ side: "buy", price: bid, qty: o.qty });
    if (!asks.some((q) => q.price === ask)) asks.push({ side: "sell", price: ask, qty: o.qty });
  }
  return [...bids, ...asks];
}

/** 订单簿里"别人"的最优买卖价：聚合档位扣掉机器人自己在该价位的剩余量后还有量才算 */
export function externalBest(
  book: { bids: [string, string][]; asks: [string, string][] },
  own: Pick<Order, "side" | "price" | "remaining">[],
): { bid: bigint | null; ask: bigint | null } {
  const ownAt = (side: Order["side"], price: bigint) =>
    own.filter((o) => o.side === side && o.price === price).reduce((s, o) => s + o.remaining, 0n);
  const first = (rows: [string, string][], side: Order["side"]) => {
    for (const [p, q] of rows) {
      const price = parseFixed(p);
      if (parseFixed(q) > ownAt(side, price)) return price;
    }
    return null;
  };
  return { bid: first(book.bids, "buy"), ask: first(book.asks, "sell") };
}

/** 丢掉会吃到别人挂单的档位：机器人只挂单（maker），不主动吃单 */
export function dropCrossing(quotes: Quote[], ext: { bid: bigint | null; ask: bigint | null }): Quote[] {
  return quotes.filter((q) =>
    q.side === "buy" ? ext.ask === null || q.price < ext.ask : ext.bid === null || q.price > ext.bid,
  );
}

/** 参考价：优先外部价（Binance），其次本所别人的买一卖一中间价，最后用配置的兜底价 */
export function pickMid(external: bigint | null, ext: { bid: bigint | null; ask: bigint | null }, fallback: bigint): { mid: bigint; source: string } {
  if (external && external > 0n) return { mid: external, source: "binance" };
  if (ext.bid !== null && ext.ask !== null) return { mid: (ext.bid + ext.ask) / 2n, source: "book" };
  return { mid: fallback, source: "fallback" };
}

function floorTick(v: bigint): bigint {
  return (v / TICK) * TICK;
}
function ceilTick(v: bigint): bigint {
  return ((v + TICK - 1n) / TICK) * TICK;
}