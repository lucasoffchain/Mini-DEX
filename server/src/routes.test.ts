// 下单链路的账本联动测试：被撮合引擎拒绝的订单不能吃掉用户的冻结余额。
import { describe, it, expect } from "vitest";
import { createRoutes } from "./routes.js";
import { OrderBook, SelfTradeError } from "./engine/orderbook.js";
import { Ledger } from "./ledger.js";
import { parseFixed as F } from "./fixed.js";
import type { Chain } from "./chain.js";

function setup() {
  const ledger = new Ledger();
  const book = new OrderBook();
  const r = createRoutes({
    ledger,
    book,
    chain: { offline: true } as unknown as Chain,
    ws: { broadcast() {}, sendBalance() {} },
    bearer: async (_c, next) => next(),
    config: { chainId: 43113, wsUrl: "", vault: "", usdc: "", wavax: "" },
  });
  return { ledger, book, r };
}

describe("placeOrder", () => {
  it("自成交被拒：抛错并解冻，余额与下单前一致", () => {
    const { ledger, book, r } = setup();
    ledger.credit("alice", "USDC", F("1000"));
    ledger.credit("alice", "WAVAX", F("10"));
    r.placeOrder("alice", { side: "sell", type: "limit", price: F("20"), qty: F("1") });

    expect(() => r.placeOrder("alice", { side: "buy", type: "limit", price: F("20"), qty: F("1") })).toThrow(SelfTradeError);
    expect(() => r.placeOrder("alice", { side: "buy", type: "market", price: 0n, qty: F("1") })).toThrow(SelfTradeError);

    const b = ledger.get("alice");
    expect(b.USDC).toEqual({ available: F("1000"), locked: 0n });
    expect(b.WAVAX).toEqual({ available: F("9"), locked: F("1") }); // 只有原来那张卖单的冻结
    expect(book.ordersOf("alice")).toHaveLength(1);
  });

  it("不同地址正常成交并结算", () => {
    const { ledger, r } = setup();
    ledger.credit("alice", "WAVAX", F("10"));
    ledger.credit("bob", "USDC", F("1000"));
    r.placeOrder("alice", { side: "sell", type: "limit", price: F("20"), qty: F("1") });
    const { fills } = r.placeOrder("bob", { side: "buy", type: "limit", price: F("20"), qty: F("1") });

    expect(fills).toHaveLength(1);
    expect(ledger.get("alice").USDC.available).toBe(F("20"));
    expect(ledger.get("bob").WAVAX.available).toBe(F("1"));
    expect(ledger.get("bob").USDC).toEqual({ available: F("980"), locked: 0n });
  });
});
