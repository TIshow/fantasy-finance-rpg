// 指値の注文と、上場した銘柄の検査（docs/MARKET_DESIGN.md §2、#110 PR-2a）。
import { describe, expect, it } from "vitest";
import { cutoffOf, executeSheet, newAccount, validateSheet, type Listing } from "../../src/ledger/ledger";
import { INITIAL_CASH, type Order, type OrderSheet } from "../../src/ledger/types";

const yen = (n: number) => n * 10;
const DATE = "2026-11-11";
const sheet = (orders: Order[]): OrderSheet => ({ agentId: "ai-1", tradingDate: DATE, committedAt: cutoffOf(DATE) - 60_000, orders });
/** NEO1 は上場の価格1000円・発行済50万株。OLD1 は上場の記録がない銘柄 */
const listings = new Map<string, Listing>([["NEO1", { sharesOutstanding: 500_000, refPrice: yen(1000) }]]);
const check = (orders: Order[], account = newAccount()) =>
  validateSheet(sheet(orders), { universe: new Set(["NEO1", "OLD1"]), alreadyCommitted: false, account, holidays: new Set(), accountAsOf: "2026-11-10", listings });

describe("指値の確定の検査", () => {
  it("呼値（1円）に合い、基準の価格の値幅（800〜1200円）の内側の指値は確定できる", () => {
    expect(check([{ symbol: "NEO1", side: "buy", qty: 100, limit: yen(800) }, { symbol: "NEO1", side: "buy", qty: 100, limit: yen(1200) }])).toEqual({ ok: true });
    expect(check([{ symbol: "NEO1", side: "buy", qty: 100 }])).toEqual({ ok: true });
  });

  it("値幅の外・呼値に合わない・整数でない指値は invalid_price", () => {
    for (const limit of [yen(799), yen(1201), 10005, 0, -10, 1000.5, Number.NaN]) {
      expect(check([{ symbol: "NEO1", side: "buy", qty: 100, limit }]), String(limit)).toEqual({ ok: false, reason: "invalid_price" });
    }
    expect(check([{ symbol: "NEO1", side: "buy", qty: 100, limit: "1000" as unknown as number }])).toEqual({ ok: false, reason: "invalid_price" });
    // 成行は limit を書かない。null は成行と読まず断る
    expect(check([{ symbol: "NEO1", side: "buy", qty: 100, limit: null as unknown as number }])).toEqual({ ok: false, reason: "invalid_price" });
  });

  it("上場の記録がない銘柄には、指値を出せない（基準の価格がない）。成行はこれまでどおり", () => {
    expect(check([{ symbol: "OLD1", side: "buy", qty: 100, limit: yen(1000) }])).toEqual({ ok: false, reason: "invalid_price" });
    expect(check([{ symbol: "OLD1", side: "buy", qty: 100 }])).toEqual({ ok: true });
  });

  it("1件の株数は、発行済株式数まで（#110 の lead の決定）", () => {
    expect(check([{ symbol: "NEO1", side: "buy", qty: 500_000 }])).toEqual({ ok: true });
    expect(check([{ symbol: "NEO1", side: "buy", qty: 500_100 }])).toEqual({ ok: false, reason: "invalid_qty" });
    expect(check([{ symbol: "NEO1", side: "buy", qty: 9_000_000_000_000_000 }])).toEqual({ ok: false, reason: "invalid_qty" });
    // 売りも同じ。保有が上限を超えていても、1件は上限まで
    const big = { cash: INITIAL_CASH, holdings: { NEO1: { qty: 500_150, cost: 1 } } };
    expect(check([{ symbol: "NEO1", side: "sell", qty: 500_000 }], big)).toEqual({ ok: true });
    expect(check([{ symbol: "NEO1", side: "sell", qty: 500_150 }], big)).toEqual({ ok: false, reason: "invalid_qty" });
  });

  it("注文は並びの順に確かめ、最初に見つかった理由を返す", () => {
    const held = { cash: INITIAL_CASH, holdings: { NEO1: { qty: 100, cost: 1 } } };
    expect(check([{ symbol: "NEO1", side: "buy", qty: 100, limit: yen(5) }, { symbol: "NEO1", side: "sell", qty: 1000 }], held)).toEqual({ ok: false, reason: "invalid_price" });
  });
});

describe("指値の約定（取り込んだ始値で約定するあいだ）", () => {
  const account = { cash: INITIAL_CASH, holdings: { NEO1: { qty: 300, cost: yen(300_000) } } };
  const fill = (o: Order, open: number) => executeSheet(account, sheet([o]), { NEO1: open }).fills[0]!;

  it("買いは始値が指値以下、売りは始値が指値以上のときだけ約定する", () => {
    expect(fill({ symbol: "NEO1", side: "buy", qty: 100, limit: yen(1000) }, yen(1000))).toMatchObject({ qty: 100, status: "filled" });
    expect(fill({ symbol: "NEO1", side: "buy", qty: 100, limit: yen(1000) }, yen(1001))).toMatchObject({ qty: 0, status: "expired", reason: "limit_not_reached", amount: 0 });
    expect(fill({ symbol: "NEO1", side: "sell", qty: 100, limit: yen(1000) }, yen(1000))).toMatchObject({ qty: 100, status: "filled" });
    expect(fill({ symbol: "NEO1", side: "sell", qty: 100, limit: yen(1000) }, yen(999))).toMatchObject({ qty: 0, status: "expired", reason: "limit_not_reached" });
  });

  it("届かなかった指値は口座を変えない", () => {
    const r = executeSheet(account, sheet([{ symbol: "NEO1", side: "buy", qty: 100, limit: yen(900) }]), { NEO1: yen(1000) });
    expect(r.account).toEqual(account);
  });
});
