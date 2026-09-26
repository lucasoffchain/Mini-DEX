// 做市机器人报价逻辑单测：3 档梯子、只挂不吃、参考价回退，以及和撮合引擎联动后簿上确实两侧各 3 档。
import { describe, expect, it } from "vitest";
import { buildLadder, dropCrossing, externalBest, pickMid } from "./mmbot.js";
import { planQuotes } from "./marketmaker.js";
import { OrderBook } from "./engine/orderbook.js";
import { parseFixed as P } from "./fixed.js";

const opts = { levels: 3, halfSpreadBps: 10, stepBps: 10, qty: P("1") };

describe("buildLadder", () => {
  it("买卖两侧各 3 档，价格按 bps 递进，买单向下取整、卖单向上取整", () => {
    const q = buildLadder(P("20"), opts);
    expect(q.map((x) => [x.side, x.price])).toEqual([
      ["buy", P("19.98")],  // -10 bps
      ["buy", P("19.96")],  // -20 bps
      ["buy", P("19.94")],  // -30 bps
      ["sell", P("20.02")], // +10 bps
      ["sell", P("20.04")],
      ["sell", P("20.06")],
    ]);
    expect(q.every((x) => x.qty === P("1"))).toBe(true);
  });

  it("取整到 0.0001：最高买价 < mid < 最低卖价", () => {
    const mid = P("7.12345678");
    const q = buildLadder(mid, opts);
    const bids = q.filter((x) => x.side === "buy").map((x) => x.price);
    const asks = q.filter((x) => x.side === "sell").map((x) => x.price);
    expect(bids).toHaveLength(3);
    expect(asks).toHaveLength(3);
    expect(bids.every((p) => p % 10n ** 4n === 0n && p < mid)).toBe(true);
    expect(asks.every((p) => p % 10n ** 4n === 0n && p > mid)).toBe(true);
  });

  it("价格太小时取整后重复的档位合并，mid<=0 不报价", () => {
    expect(buildLadder(P("0.001"), opts).filter((x) => x.side === "sell")).toHaveLength(1);
    expect(buildLadder(0n, opts)).toEqual([]);
  });
});

describe("externalBest / dropCrossing", () => {
  it("扣掉自己的量后才是别人的最优价", () => {
    const book = { bids: [["19.99", "1"], ["19.9", "2"]] as [string, string][], asks: [["20.01", "3"], ["20.5", "1"]] as [string, string][] };
    const own = [
      { side: "buy" as const, price: P("19.99"), remaining: P("1") },  // 买一全是自己的
      { side: "sell" as const, price: P("20.01"), remaining: P("1") }, // 卖一还有别人 2
    ];
    expect(externalBest(book, own)).toEqual({ bid: P("19.9"), ask: P("20.01") });
  });

  it("会吃到别人挂单的档位被丢掉（只做 maker）", () => {
    const q = buildLadder(P("20"), opts);
    // 别人在 19.97 挂了卖单：19.98 的买单会吃到它 → 丢
    expect(dropCrossing(q, { bid: null, ask: P("19.97") }).map((x) => x.price)).toEqual([
      P("19.96"), P("19.94"), P("20.02"), P("20.04"), P("20.06"),
    ]);
    // 别人在 20.04 挂了买单：20.02、20.04 的卖单会吃到它 → 丢
    expect(dropCrossing(q, { bid: P("20.04"), ask: null }).map((x) => x.price)).toEqual([
      P("19.98"), P("19.96"), P("19.94"), P("20.06"),
    ]);
    expect(dropCrossing(q, { bid: P("19.99"), ask: P("20.01") })).toEqual(q);
  });
});

describe("pickMid", () => {
  it("Binance > 本所中间价 > 兜底价", () => {
    expect(pickMid(P("7"), { bid: P("1"), ask: P("3") }, P("20"))).toEqual({ mid: P("7"), source: "binance" });
    expect(pickMid(null, { bid: P("1"), ask: P("3") }, P("20"))).toEqual({ mid: P("2"), source: "book" });
    expect(pickMid(null, { bid: P("1"), ask: null }, P("20"))).toEqual({ mid: P("20"), source: "fallback" });
  });
});

describe("机器人 + 撮合引擎", () => {
  it("挂完后簿上两侧各 3 档；mid 移动后增量重挂，不会自成交", () => {
    const ob = new OrderBook();
    let n = 0;
    const apply = (mid: bigint) => {
      const plan = planQuotes(buildLadder(mid, opts), ob.ordersOf("bot"));
      for (const o of plan.cancel) ob.cancel(o.id, "bot");
      for (const q of plan.place) ob.submit({ id: `b${++n}`, owner: "bot", side: q.side, type: "limit", price: q.price, qty: q.qty });
      return plan;
    };

    apply(P("20"));
    const s = ob.snapshot(10);
    expect(s.bids.map(([p]) => p)).toEqual([P("19.98"), P("19.96"), P("19.94")]);
    expect(s.asks.map(([p]) => p)).toEqual([P("20.02"), P("20.04"), P("20.06")]);

    // mid 跳到 21：新买单价高于旧卖单，必须先撤旧单再挂，否则会撞上自己的卖单被拒
    const plan = apply(P("21"));
    expect(plan.cancel).toHaveLength(6);
    const s2 = ob.snapshot(10);
    expect(s2.bids.map(([p]) => p)).toEqual([P("20.979"), P("20.958"), P("20.937")]);
    expect(s2.asks.map(([p]) => p)).toEqual([P("21.021"), P("21.042"), P("21.063")]);
  });
});
