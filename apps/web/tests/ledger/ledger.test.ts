// 架空の銘柄と価格だけで、docs/PAPER_TRADING_RULES.md の規則を確かめる。
import { describe, expect, it } from "vitest";
import { cutoffOf, executeSheet, invariantViolations, newAccount, totalValue, validateSheet } from "../../src/ledger/ledger";
import { INITIAL_CASH, type Account, type Order, type OrderSheet } from "../../src/ledger/types";

const yen = (n: number) => Math.round(n * 10);
const universe = new Set(["AAA", "BBB", "CCC"]);
const DATE = "2026-11-11";
const beforeCutoff = cutoffOf(DATE) - 60_000;

const sheet = (orders: Order[], committedAt = beforeCutoff): OrderSheet => ({ agentId: "ai-1", tradingDate: DATE, committedAt, orders });
const holding = (symbol: string, qty: number, cost: number, cash = INITIAL_CASH): Account => ({ cash, holdings: { [symbol]: { qty, cost } } });
const check = (s: OrderSheet, account = newAccount(), alreadyCommitted = false) => validateSheet(s, { universe, alreadyCommitted, account, holidays: new Set(), accountAsOf: "2026-11-10" });

describe("注文の締め（§1）", () => {
  it("約定日の 8:30（日本時間）は、前日の 23:30 UTC", () => {
    expect(new Date(cutoffOf(DATE)).toISOString()).toBe("2026-11-10T23:30:00.000Z");
  });

  it("月や年をまたぐ締めも正しく、存在しない日付は例外にする", () => {
    expect(new Date(cutoffOf("2027-01-04")).toISOString()).toBe("2027-01-03T23:30:00.000Z");
    expect(new Date(cutoffOf("2026-12-01")).toISOString()).toBe("2026-11-30T23:30:00.000Z");
    expect(() => cutoffOf("2026-02-30")).toThrow("invalid trading date");
    expect(() => cutoffOf("2026/11/04")).toThrow("invalid trading date");
  });

  it("確定時刻が数値でない注文票は受け付けない", () => {
    expect(check(sheet([], Number.NaN))).toEqual({ ok: false, reason: "invalid_sheet" });
    expect(check({ ...sheet([]), committedAt: undefined } as unknown as OrderSheet)).toEqual({ ok: false, reason: "invalid_sheet" });
  });

  it("締めちょうど以降に確定した注文票は受け付けない", () => {
    const o: Order[] = [{ symbol: "AAA", side: "buy", qty: 100 }];
    expect(check(sheet(o, cutoffOf(DATE) - 1))).toEqual({ ok: true });
    expect(check(sheet(o, cutoffOf(DATE)))).toEqual({ ok: false, reason: "after_cutoff" });
  });
});

describe("注文票の確定（§3）", () => {
  it("1日に2回目の注文票は受け付けない", () => {
    expect(check(sheet([]), newAccount(), true)).toEqual({ ok: false, reason: "already_committed" });
  });

  it("空の注文票は確定できる", () => {
    expect(check(sheet([]))).toEqual({ ok: true });
  });

  it("取引対象外の銘柄、100株単位でない数量、0以下の数量は、注文票ごと拒否する", () => {
    const ok: Order = { symbol: "AAA", side: "buy", qty: 100 };
    expect(check(sheet([ok, { symbol: "ZZZ", side: "buy", qty: 100 }]))).toEqual({ ok: false, reason: "unknown_symbol" });
    expect(check(sheet([ok, { symbol: "BBB", side: "buy", qty: 150 }]))).toEqual({ ok: false, reason: "invalid_qty" });
    expect(check(sheet([{ symbol: "AAA", side: "buy", qty: 0 }]))).toEqual({ ok: false, reason: "invalid_qty" });
    expect(check(sheet([{ symbol: "AAA", side: "buy", qty: 100.5 }]))).toEqual({ ok: false, reason: "invalid_qty" });
  });

  it("売買の向きや銘柄の形が想定外なら、注文票ごと拒否する", () => {
    const bad = (o: unknown) => check(sheet([o as Order]));
    expect(bad({ symbol: "AAA", side: "BUY", qty: 100 })).toEqual({ ok: false, reason: "invalid_order" });
    expect(bad({ symbol: 123, side: "buy", qty: 100 })).toEqual({ ok: false, reason: "invalid_order" });
  });

  it("端数を含む全株の売りは認めるが、端数の一部だけの売りは認めない", () => {
    const acc = holding("AAA", 150, yen(150_000));
    expect(check(sheet([{ symbol: "AAA", side: "sell", qty: 150 }]), acc)).toEqual({ ok: true });
    expect(check(sheet([{ symbol: "AAA", side: "sell", qty: 100 }]), acc)).toEqual({ ok: true });
    expect(check(sheet([{ symbol: "AAA", side: "sell", qty: 50 }]), acc)).toEqual({ ok: false, reason: "invalid_qty" });
  });

  it("同じ銘柄の売りの合計が保有を超えると拒否する", () => {
    const acc = holding("AAA", 200, yen(200_000));
    const s = sheet([
      { symbol: "AAA", side: "sell", qty: 100 },
      { symbol: "AAA", side: "sell", qty: 200 },
    ]);
    expect(check(s, acc)).toEqual({ ok: false, reason: "insufficient_holdings" });
    expect(check(sheet([{ symbol: "BBB", side: "sell", qty: 100 }]), acc)).toEqual({ ok: false, reason: "insufficient_holdings" });
  });
});

describe("約定（§4）", () => {
  it("始値で約定し、現金と保有と取得原価が動く", () => {
    const { account, fills } = executeSheet(newAccount(), sheet([{ symbol: "AAA", side: "buy", qty: 300 }]), { AAA: yen(1234.5) });
    expect(fills).toEqual([{ symbol: "AAA", side: "buy", requestedQty: 300, qty: 300, price: yen(1234.5), amount: yen(370_350), status: "filled" }]);
    expect(account.cash).toBe(INITIAL_CASH - yen(370_350));
    expect(account.holdings.AAA).toEqual({ qty: 300, cost: yen(370_350) });
  });

  it("売りを先、買いを後に処理し、売りで得た現金を同じ日の買いに使える", () => {
    const acc = holding("AAA", 100, yen(1_000_000), yen(500_000));
    const s = sheet([
      { symbol: "BBB", side: "buy", qty: 100 },
      { symbol: "AAA", side: "sell", qty: 100 },
    ]);
    const { account, fills } = executeSheet(acc, s, { AAA: yen(10_000), BBB: yen(15_000) });
    expect(fills.map((f) => [f.symbol, f.side, f.status])).toEqual([
      ["AAA", "sell", "filled"],
      ["BBB", "buy", "filled"],
    ]);
    expect(account.cash).toBe(yen(500_000 + 1_000_000 - 1_500_000));
    expect(account.holdings).toEqual({ BBB: { qty: 100, cost: yen(1_500_000) } });
  });

  it("現金が足りない買いは、買える最大の100株単位まで減らし、0株なら失効する", () => {
    const acc: Account = { cash: yen(250_000), holdings: {} };
    const s = sheet([
      { symbol: "AAA", side: "buy", qty: 500 },
      { symbol: "BBB", side: "buy", qty: 100 },
    ]);
    const { account, fills } = executeSheet(acc, s, { AAA: yen(1_000), BBB: yen(600) });
    expect(fills[0]).toMatchObject({ qty: 200, status: "reduced", reason: "insufficient_cash" });
    expect(fills[1]).toMatchObject({ qty: 0, amount: 0, status: "expired", reason: "insufficient_cash" });
    expect(account.cash).toBe(yen(50_000));
  });

  it("始値がない銘柄は約定させず失効し、ほかの注文は約定する", () => {
    const { account, fills } = executeSheet(
      newAccount(),
      sheet([
        { symbol: "AAA", side: "buy", qty: 100 },
        { symbol: "BBB", side: "buy", qty: 100 },
      ]),
      { AAA: null, BBB: yen(500) },
    );
    expect(fills[0]).toMatchObject({ qty: 0, status: "expired", reason: "no_open_price" });
    expect(fills[1]).toMatchObject({ qty: 100, status: "filled" });
    expect(account.holdings.AAA).toBeUndefined();
  });

  it("一部の売りでは、取得原価を株数の比で減らす", () => {
    const acc = holding("AAA", 300, yen(300_000));
    const { account } = executeSheet(acc, sheet([{ symbol: "AAA", side: "sell", qty: 100 }]), { AAA: yen(1_500) });
    expect(account.holdings.AAA).toEqual({ qty: 200, cost: yen(200_000) });
    expect(account.cash).toBe(INITIAL_CASH + yen(150_000));
  });

  it("一部の売りで割り切れない取得原価は、0.1円未満を四捨五入する", () => {
    const acc = holding("AAA", 300, 1_000); // 300株で原価100.0円
    const { account } = executeSheet(acc, sheet([{ symbol: "AAA", side: "sell", qty: 100 }]), { AAA: yen(1) });
    expect(account.holdings.AAA).toEqual({ qty: 200, cost: 1_000 - 333 });
  });

  it("端数を含む全株の売りは、保有と取得原価をすべて外す", () => {
    const acc = holding("AAA", 150, yen(150_000));
    const { account, fills } = executeSheet(acc, sheet([{ symbol: "AAA", side: "sell", qty: 150 }]), { AAA: yen(1_200) });
    expect(fills[0]).toMatchObject({ qty: 150, amount: yen(180_000), status: "filled" });
    expect(account.holdings).toEqual({});
    expect(account.cash).toBe(INITIAL_CASH + yen(180_000));
  });

  it("同じ銘柄を売りと買いの両方に出すと、売ってから買う", () => {
    const acc = holding("AAA", 100, yen(100_000));
    const s = sheet([
      { symbol: "AAA", side: "buy", qty: 200 },
      { symbol: "AAA", side: "sell", qty: 100 },
    ]);
    const { account } = executeSheet(acc, s, { AAA: yen(1_500) });
    expect(account.holdings.AAA).toEqual({ qty: 200, cost: yen(300_000) });
  });

  it("始値のデータに銘柄がないときと、検証していない注文は、例外にする", () => {
    expect(() => executeSheet(newAccount(), sheet([{ symbol: "AAA", side: "buy", qty: 100 }]), {})).toThrow("missing open data for AAA");
    expect(() => executeSheet(newAccount(), sheet([{ symbol: "AAA", side: "buy", qty: 150 }]), { AAA: yen(100) })).toThrow("unvalidated order");
  });

  it("元の口座は書き換えない", () => {
    const acc = holding("AAA", 100, yen(100_000));
    const before = structuredClone(acc);
    executeSheet(acc, sheet([{ symbol: "AAA", side: "sell", qty: 100 }]), { AAA: yen(2_000) });
    expect(acc).toEqual(before);
  });
});

describe("時点の整合と不変条件", () => {
  it("確定の判定は価格を受け取らない。約定する銘柄・売買・数量の上限は、始値によらず注文票で決まっている", () => {
    expect(validateSheet.length).toBe(2);
    const s = sheet([
      { symbol: "AAA", side: "buy", qty: 100 },
      { symbol: "BBB", side: "buy", qty: 200 },
    ]);
    for (const p of [1, 100, 5_000, 40_000]) {
      const { fills } = executeSheet(newAccount(), s, { AAA: yen(p), BBB: yen(p) });
      for (const [i, f] of fills.entries()) {
        expect(f.symbol).toBe(s.orders[i]!.symbol);
        expect(f.side).toBe("buy");
        expect(f.qty).toBeLessThanOrEqual(s.orders[i]!.qty);
      }
    }
  });

  it("同じ価格での往復の売買では、資産は増えも減りもしない（手数料0円）", () => {
    const bought = executeSheet(newAccount(), sheet([{ symbol: "AAA", side: "buy", qty: 700 }]), { AAA: yen(3_210.7) }).account;
    const sold = executeSheet(bought, sheet([{ symbol: "AAA", side: "sell", qty: 700 }]), { AAA: yen(3_210.7) }).account;
    expect(sold).toEqual(newAccount());
  });

  it("同じ入力なら同じ結果になる", () => {
    const s = sheet([
      { symbol: "AAA", side: "buy", qty: 300 },
      { symbol: "CCC", side: "buy", qty: 100 },
    ]);
    const opens = { AAA: yen(2_500), CCC: null };
    expect(executeSheet(newAccount(), s, opens)).toEqual(executeSheet(newAccount(), s, opens));
  });

  it("無作為な注文を続けても、現金・保有・取得原価は負にならない", () => {
    let seed = 42;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const symbols = [...universe];
    let acc = newAccount();
    for (let day = 0; day < 500; day++) {
      const orders: Order[] = Array.from({ length: 3 }, () => {
        const symbol = symbols[Math.floor(rand() * symbols.length)]!;
        const side: Order["side"] = rand() < 0.5 ? "buy" : "sell";
        const held = acc.holdings[symbol]?.qty ?? 0;
        const sellQty = rand() < 0.3 ? held : 100 * Math.floor(rand() * (held / 100 + 1));
        return { symbol, side, qty: side === "sell" ? sellQty : 100 * (1 + Math.floor(rand() * 50)) };
      }).filter((o) => o.qty > 0);
      const s = sheet(orders);
      if (!check(s, acc).ok) continue;
      const opens = Object.fromEntries(symbols.map((x) => [x, rand() < 0.05 ? null : yen(100 + Math.floor(rand() * 9_000))]));
      acc = executeSheet(acc, s, opens).account;
      expect(invariantViolations(acc)).toEqual([]);
    }
  });
});

describe("評価（§6）", () => {
  it("総資産は現金と終値による時価の合計。終値がない保有銘柄があれば例外にする", () => {
    const acc = holding("AAA", 200, yen(200_000), yen(1_000));
    expect(totalValue(acc, { AAA: yen(1_100.5) })).toBe(yen(1_000 + 220_100));
    expect(() => totalValue(acc, {})).toThrow("missing close for AAA");
  });
});
