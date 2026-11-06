// 板寄せの前の現金の確かめ（reserveBuys）と、板寄せの結果での約定（executeSheet の auctioned）。MARKET_DESIGN §3、#110 PR-2b
import { describe, expect, it } from "vitest";
import { cutoffOf, executeSheet, reserveBuys, type AuctionedFill } from "../../src/ledger/ledger";
import type { Order, OrderSheet } from "../../src/ledger/types";

const yen = (n: number) => n * 10;
const DATE = "2026-11-11";
const sheet = (orders: Order[]): OrderSheet => ({ agentId: "ai-1", tradingDate: DATE, committedAt: cutoffOf(DATE) - 60_000, orders });
/** NEO1・NEO2 は上場（値幅の上限 1200円・600円）、OLD1 は上場していない */
const upperOf = (s: string) => ({ NEO1: yen(1200), NEO2: yen(600) })[s];

describe("板寄せの前の現金の確かめ", () => {
  it("上場した銘柄の買いを、並びの順に、指値（成行は値幅の上限）× 株数で確かめ、100株単位まで減らす", () => {
    const orders: Order[] = [
      { symbol: "NEO1", side: "buy", qty: 300, limit: yen(1000) }, // 30万円を取る
      { symbol: "NEO2", side: "buy", qty: 1000 }, // 残り20万円を上限600円で：300株（18万円）
      { symbol: "NEO1", side: "buy", qty: 100 }, // 残り2万円を上限1200円で：0株
    ];
    expect(reserveBuys(yen(500_000), orders, upperOf)).toEqual([300, 300, 0]);
  });

  it("売りと上場していない銘柄はそのまま。売りの代金は当てにしない", () => {
    const orders: Order[] = [
      { symbol: "NEO1", side: "sell", qty: 500 },
      { symbol: "OLD1", side: "buy", qty: 10_000 },
      { symbol: "NEO1", side: "buy", qty: 100, limit: yen(1000) },
    ];
    expect(reserveBuys(yen(50_000), orders, upperOf)).toEqual([500, 10_000, 0]);
  });
});

describe("板寄せの結果での約定", () => {
  const account = { cash: yen(300_000), holdings: { NEO1: { qty: 200, cost: yen(180_000) } } };

  it("決まった株数をその日の価格で当てる。上場した銘柄の買いは、始値の買いより先", () => {
    const orders: Order[] = [
      { symbol: "OLD1", side: "buy", qty: 100 },
      { symbol: "NEO1", side: "buy", qty: 300, limit: yen(1000) },
      { symbol: "NEO1", side: "sell", qty: 200, limit: yen(900) },
    ];
    const auctioned = new Map<number, AuctionedFill>([
      [1, { price: yen(950), qty: 200, reason: "outmatched" }],
      [2, { price: yen(950), qty: 200 }],
    ]);
    const r = executeSheet(account, sheet(orders), { OLD1: yen(2000) }, auctioned);
    // 売り（+19万円）→ 上場した銘柄の買い（-19万円）→ 始値の買い（20万円、残り30万円で買える）
    expect(r.fills.map((f) => [f.symbol, f.side, f.qty, f.price, f.status, f.reason ?? null])).toEqual([
      ["NEO1", "sell", 200, yen(950), "filled", null],
      ["NEO1", "buy", 200, yen(950), "reduced", "outmatched"],
      ["OLD1", "buy", 100, yen(2000), "filled", null],
    ]);
    expect(r.account).toEqual({ cash: yen(100_000), holdings: { NEO1: { qty: 200, cost: yen(190_000) }, OLD1: { qty: 100, cost: yen(200_000) } } });
  });

  it("価格がつかない日は失効し、理由を残す。口座は変わらない", () => {
    const r = executeSheet(account, sheet([{ symbol: "NEO1", side: "buy", qty: 100 }]), {}, new Map([[0, { price: null, qty: 0, reason: "no_price" }]]));
    expect(r.fills).toEqual([{ symbol: "NEO1", side: "buy", requestedQty: 100, qty: 0, price: null, amount: 0, status: "expired", reason: "no_price" }]);
    expect(r.account).toEqual(account);
  });

  it("持っている株より多い売り・現金より多い買いの結果は、確かめの漏れなので例外", () => {
    expect(() => executeSheet(account, sheet([{ symbol: "NEO1", side: "sell", qty: 300 }]), {}, new Map([[0, { price: yen(1000), qty: 300 }]]))).toThrow("than held");
    expect(() => executeSheet(account, sheet([{ symbol: "NEO1", side: "buy", qty: 400 }]), {}, new Map([[0, { price: yen(1000), qty: 400 }]]))).toThrow("cash");
    expect(() => executeSheet(account, sheet([{ symbol: "NEO1", side: "buy", qty: 100 }]), {}, new Map([[0, { price: null, qty: 100 }]]))).toThrow("invalid auction result");
  });
});
