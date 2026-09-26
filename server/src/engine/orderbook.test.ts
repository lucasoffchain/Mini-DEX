// 撮合引擎单元测试（vitest）。每个 case 对应一条撮合规则，先看测试再看实现更好懂。
import { describe, it, expect } from "vitest";
import { OrderBook, SelfTradeError, type Side, type OrderType } from "./orderbook.js";
import { parseFixed as F } from "../fixed.js";

let n = 0;
function order(owner: string, side: Side, type: OrderType, price: string, qty: string) {
  return { id: `o${++n}`, owner, side, type, price: type === "market" ? 0n : F(price), qty: F(qty) };
}
const limit = (owner: string, side: Side, price: string, qty: string) => order(owner, side, "limit", price, qty);
const market = (owner: string, side: Side, qty: string) => order(owner, side, "market", "0", qty);

describe("OrderBook", () => {
  it("空簿：limit 单直接挂上", () => {
    const ob = new OrderBook();
    const r = ob.submit(limit("alice", "sell", "100", "1"));
    expect(r.fills).toHaveLength(0);
    expect(r.resting?.remaining).toBe(F("1"));
    expect(ob.bestAsk()).toBe(F("100"));
    expect(ob.bestBid()).toBeNull();
  });

  it("价格交叉：按 maker 价成交", () => {
    const ob = new OrderBook();
    ob.submit(limit("alice", "sell", "100", "1"));
    const r = ob.submit(limit("bob", "buy", "105", "1")); // bob 愿出 105，但按 alice 的 100 成交
    expect(r.fills).toHaveLength(1);
    expect(r.fills[0]!.price).toBe(F("100"));
    expect(r.fills[0]!.qty).toBe(F("1"));
    expect(r.fills[0]!.maker).toBe("alice");
    expect(r.fills[0]!.taker).toBe("bob");
    expect(r.resting).toBeNull();
    expect(ob.bestAsk()).toBeNull();
  });

  it("部分成交：剩余部分挂单", () => {
    const ob = new OrderBook();
    ob.submit(limit("alice", "sell", "100", "1"));
    const r = ob.submit(limit("bob", "buy", "100", "3"));
    expect(r.fills).toHaveLength(1);
    expect(r.fills[0]!.qty).toBe(F("1"));
    expect(r.resting?.remaining).toBe(F("2"));
    expect(ob.bestBid()).toBe(F("100"));
    expect(ob.snapshot(5).bids).toEqual([[F("100"), F("2")]]);
  });

  it("价格优先：更优价格先成交", () => {
    const ob = new OrderBook();
    ob.submit(limit("a", "sell", "102", "1"));
    ob.submit(limit("b", "sell", "100", "1")); // 更便宜，后挂但先成交
    const r = ob.submit(market("t", "buy", "1"));
    expect(r.fills).toHaveLength(1);
    expect(r.fills[0]!.maker).toBe("b");
    expect(r.fills[0]!.price).toBe(F("100"));
  });

  it("时间优先：同价 FIFO", () => {
    const ob = new OrderBook();
    const first = ob.submit(limit("a", "sell", "100", "1")).resting!;
    ob.submit(limit("b", "sell", "100", "1"));
    const r = ob.submit(market("t", "buy", "1"));
    expect(r.fills[0]!.makerOrderId).toBe(first.id);
    expect(r.fills[0]!.maker).toBe("a");
  });

  it("时间优先：同价多单按提交顺序依次成交，部分成交的单保持队首", () => {
    const ob = new OrderBook();
    const a = ob.submit(limit("a", "buy", "100", "1")).resting!;
    const b = ob.submit(limit("b", "buy", "100", "2")).resting!;
    const c = ob.submit(limit("c", "buy", "100", "1")).resting!;

    // 1.5：a 全部成交，b 成交 0.5 后仍排在 c 前面
    const r1 = ob.submit(limit("t", "sell", "100", "1.5"));
    expect(r1.fills.map((f) => [f.makerOrderId, f.qty])).toEqual([
      [a.id, F("1")],
      [b.id, F("0.5")],
    ]);
    expect(ob.get(a.id)).toBeUndefined();
    expect(ob.get(b.id)?.remaining).toBe(F("1.5"));

    // 后来的同价单排到队尾
    const d = ob.submit(limit("d", "buy", "100", "1")).resting!;
    const r2 = ob.submit(market("t", "sell", "3"));
    expect(r2.fills.map((f) => [f.makerOrderId, f.qty])).toEqual([
      [b.id, F("1.5")],
      [c.id, F("1")],
      [d.id, F("0.5")],
    ]);
  });

  it("时间优先：撤掉队首后，下一个最早的单接上", () => {
    const ob = new OrderBook();
    const a = ob.submit(limit("a", "sell", "100", "1")).resting!;
    const b = ob.submit(limit("b", "sell", "100", "1")).resting!;
    ob.submit(limit("c", "sell", "100", "1"));
    ob.cancel(a.id, "a");
    const r = ob.submit(market("t", "buy", "1"));
    expect(r.fills).toHaveLength(1);
    expect(r.fills[0]!.makerOrderId).toBe(b.id);
  });

  it("拒绝自成交：limit 单会吃到自己的挂单时整单拒绝，簿不变", () => {
    const ob = new OrderBook();
    const own = ob.submit(limit("alice", "sell", "100", "1")).resting!;
    const before = ob.snapshot(5);
    expect(() => ob.submit(limit("alice", "buy", "100", "1"))).toThrow(SelfTradeError);
    expect(ob.snapshot(5)).toEqual(before);
    expect(ob.get(own.id)?.remaining).toBe(F("1"));
    expect(ob.bestBid()).toBeNull(); // 被拒的买单也没有挂上去
  });

  it("拒绝自成交：先吃别人再碰到自己也要整单拒绝，不能产生部分成交", () => {
    const ob = new OrderBook();
    const other = ob.submit(limit("bob", "sell", "100", "1")).resting!;
    ob.submit(limit("alice", "sell", "101", "1"));
    expect(() => ob.submit(market("alice", "buy", "2"))).toThrow(SelfTradeError);
    expect(ob.get(other.id)?.remaining).toBe(F("1")); // bob 的单没被吃
    expect(ob.snapshot(5).asks).toEqual([
      [F("100"), F("1")],
      [F("101"), F("1")],
    ]);
  });

  it("自成交检查只看会真正成交的部分：够不着自己的单就正常成交", () => {
    const ob = new OrderBook();
    ob.submit(limit("bob", "sell", "100", "1"));
    ob.submit(limit("alice", "sell", "101", "1"));
    // 数量只够吃掉 bob
    const r1 = ob.submit(market("alice", "buy", "1"));
    expect(r1.fills.map((f) => f.maker)).toEqual(["bob"]);
    // 价格够不着 101：吃不到自己，剩余挂成买单
    ob.submit(limit("bob", "sell", "100", "1"));
    const r2 = ob.submit(limit("alice", "buy", "100", "2"));
    expect(r2.fills.map((f) => f.maker)).toEqual(["bob"]);
    expect(r2.resting?.remaining).toBe(F("1"));
  });

  it("market 买单：吃穿多个档位", () => {
    const ob = new OrderBook();
    ob.submit(limit("a", "sell", "100", "1"));
    ob.submit(limit("b", "sell", "101", "1"));
    ob.submit(limit("c", "sell", "102", "5"));
    const r = ob.submit(market("t", "buy", "2.5"));
    expect(r.fills.map((f) => [f.price, f.qty])).toEqual([
      [F("100"), F("1")],
      [F("101"), F("1")],
      [F("102"), F("0.5")],
    ]);
    expect(r.resting).toBeNull();
    expect(ob.snapshot(5).asks).toEqual([[F("102"), F("4.5")]]);
  });

  it("market 单遇到空簿：不成交也不挂单", () => {
    const ob = new OrderBook();
    const r = ob.submit(market("t", "buy", "1"));
    expect(r.fills).toHaveLength(0);
    expect(r.resting).toBeNull();
    expect(ob.snapshot(5)).toEqual({ bids: [], asks: [] });
  });

  it("market 单流动性不足：吃完就停", () => {
    const ob = new OrderBook();
    ob.submit(limit("a", "sell", "100", "1"));
    const r = ob.submit(market("t", "buy", "5"));
    expect(r.fills).toHaveLength(1);
    expect(r.fills[0]!.qty).toBe(F("1"));
    expect(r.resting).toBeNull();
    expect(ob.bestAsk()).toBeNull();
  });

  it("撤单：从簿和快照里移除", () => {
    const ob = new OrderBook();
    const o = ob.submit(limit("a", "sell", "100", "1")).resting!;
    expect(ob.cancel(o.id, "someone-else")).toBeNull(); // 不能撤别人的
    const cancelled = ob.cancel(o.id, "a");
    expect(cancelled?.id).toBe(o.id);
    expect(ob.cancel(o.id, "a")).toBeNull();             // 重复撤返回 null
    expect(ob.bestAsk()).toBeNull();
    expect(ob.snapshot(5).asks).toEqual([]);
    expect(ob.ordersOf("a")).toEqual([]);
  });

  it("快照：同价订单数量合并，且按深度截断", () => {
    const ob = new OrderBook();
    ob.submit(limit("a", "buy", "99", "1"));
    ob.submit(limit("b", "buy", "99", "2"));
    ob.submit(limit("c", "buy", "98", "1"));
    ob.submit(limit("d", "buy", "97", "1"));
    const s = ob.snapshot(2);
    expect(s.bids).toEqual([
      [F("99"), F("3")],
      [F("98"), F("1")],
    ]);
    expect(ob.bestBid()).toBe(F("99"));
  });

  it("limit 单吃穿多档后剩余挂单", () => {
    const ob = new OrderBook();
    ob.submit(limit("a", "sell", "100", "1"));
    ob.submit(limit("b", "sell", "101", "1"));
    ob.submit(limit("c", "sell", "110", "1")); // 超出 105，不该被吃
    const r = ob.submit(limit("t", "buy", "105", "3"));
    expect(r.fills.map((f) => f.price)).toEqual([F("100"), F("101")]);
    expect(r.resting?.remaining).toBe(F("1"));
    expect(ob.bestBid()).toBe(F("105"));
    expect(ob.bestAsk()).toBe(F("110"));
  });

  it("ordersOf：只返回该用户还在簿上的单", () => {
    const ob = new OrderBook();
    ob.submit(limit("a", "buy", "90", "1"));
    ob.submit(limit("a", "sell", "110", "1"));
    ob.submit(limit("b", "sell", "120", "1"));
    expect(ob.ordersOf("a").map((o) => o.price).sort((a, b) => (a < b ? -1 : 1))).toEqual([F("90"), F("110")]);
    expect(ob.ordersOf("b")).toHaveLength(1);
  });
});
