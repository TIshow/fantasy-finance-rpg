// 営業日、約定日の確認、株式分割・配当を、架空の祝日と銘柄で確かめる（docs/PAPER_TRADING_RULES.md §1・§3・§5）。
import { describe, expect, it } from "vitest";
import { applyCorporateActions, splitAdjustedPrice, type CorporateEvent } from "../../src/ledger/corporate";
import { executeSheet, invariantViolations, isBusinessDay, nextBusinessDay, previousBusinessDay, totalValue, tradingDateFor, validateSheet } from "../../src/ledger/ledger";
import { INITIAL_CASH, type Account, type OrderSheet } from "../../src/ledger/types";

const yen = (n: number) => Math.round(n * 10);
/** 日本時間の日時を UNIXミリ秒にする */
const jst = (date: string, hh: number, mm = 0) => Date.parse(`${date}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+09:00`);
const none = new Set<string>();
const holidays = new Set(["2026-11-23"]);
const holding = (symbol: string, qty: number, cost: number, cash = INITIAL_CASH): Account => ({ cash, holdings: { [symbol]: { qty, cost } } });

describe("営業日（§1）", () => {
  it("土日、12月31日〜1月3日、与えた祝日は休み", () => {
    expect(isBusinessDay("2026-11-06", none)).toBe(true); // 金
    expect(isBusinessDay("2026-11-07", none)).toBe(false); // 土
    expect(isBusinessDay("2026-11-08", none)).toBe(false); // 日
    expect(isBusinessDay("2026-12-31", none)).toBe(false);
    expect(isBusinessDay("2027-01-03", none)).toBe(false);
    expect(isBusinessDay("2027-01-04", none)).toBe(true);
    expect(isBusinessDay("2026-11-23", holidays)).toBe(false);
    expect(() => isBusinessDay("2026-13-01", none)).toThrow("invalid trading date");
  });

  it("翌営業日は、週末・年末年始・祝日を飛ばす", () => {
    expect(nextBusinessDay("2026-11-06", none)).toBe("2026-11-09");
    expect(nextBusinessDay("2026-12-30", none)).toBe("2027-01-04");
    expect(nextBusinessDay("2026-11-20", holidays)).toBe("2026-11-24");
    expect(previousBusinessDay("2027-01-04", none)).toBe("2026-12-30");
    expect(previousBusinessDay("2026-11-24", holidays)).toBe("2026-11-20");
  });

  it("確定時刻から約定日を決める：締め前ならその日、締め以後・休日なら次の営業日", () => {
    expect(tradingDateFor(jst("2026-11-09", 8, 29), none)).toBe("2026-11-09");
    expect(tradingDateFor(jst("2026-11-09", 8, 30), none)).toBe("2026-11-10");
    expect(tradingDateFor(jst("2026-11-06", 16), none)).toBe("2026-11-09"); // 金曜の引け後 → 月曜
    expect(tradingDateFor(jst("2026-11-07", 10), none)).toBe("2026-11-09"); // 土曜
    expect(tradingDateFor(jst("2026-11-20", 20), holidays)).toBe("2026-11-24");
    expect(tradingDateFor(jst("2026-11-23", 7), holidays)).toBe("2026-11-24"); // 祝日の朝
    expect(tradingDateFor(jst("2026-12-31", 7), none)).toBe("2027-01-04"); // 平日の大みそか
  });
});

describe("約定日の確認（§3）", () => {
  // 切り替えの日（D-047）より前の日付で、東証の営業日の決まりのまま確かめる。10/12（月）はスポーツの日
  const october = new Set(["2026-10-12"]);
  const sheet = (tradingDate: string, committedAt: number): OrderSheet => ({ agentId: "ai-1", tradingDate, committedAt, orders: [] });
  const check = (s: OrderSheet, accountAsOf = "2026-10-09") =>
    validateSheet(s, { universe: new Set(["AAA"]), alreadyCommitted: false, account: holding("AAA", 100, 0), holidays: october, accountAsOf });

  it("翌営業日でない約定日（先の日付、祝日）は拒否する", () => {
    expect(check(sheet("2026-10-13", jst("2026-10-09", 20)))).toEqual({ ok: true });
    expect(check(sheet("2026-10-14", jst("2026-10-09", 20)))).toEqual({ ok: false, reason: "wrong_trading_date" });
    expect(check(sheet("2026-10-12", jst("2026-10-09", 20)))).toEqual({ ok: false, reason: "wrong_trading_date" });
  });

  it("形式が不正な約定日は、例外ではなく invalid_sheet で拒否する", () => {
    for (const d of ["2026-13-01", "2026/11/24", "", 20261124]) {
      expect(check({ ...sheet("2026-10-13", jst("2026-10-09", 20)), tradingDate: d } as unknown as OrderSheet)).toEqual({ ok: false, reason: "invalid_sheet" });
    }
  });

  it("前営業日の引け後処理が済んでいない口座では確定できない（前営業日の日中の確定を含む）。切り替えより前は受け付けの時間の決まりを当てない", () => {
    // 金曜（10/9）の10:00に、火曜（10/13）の注文票。口座は木曜（10/8）の引け後のまま
    expect(check(sheet("2026-10-13", jst("2026-10-09", 10)), "2026-10-08")).toEqual({ ok: false, reason: "account_not_ready" });
    expect(check(sheet("2026-10-13", jst("2026-10-09", 10)), "2026-10-09")).toEqual({ ok: true });
    expect(check(sheet("2026-10-13", jst("2026-10-09", 20)), "2026-10-09")).toEqual({ ok: true });
  });

  it("切り替えの日より後の取引日は、前の取引日の引け（16:30）より前の確定を拒否する（#228）。11/9 の取引日には当てない", () => {
    const at = (s: OrderSheet, accountAsOf: string) => validateSheet(s, { universe: new Set(["AAA"]), alreadyCommitted: false, account: holding("AAA", 100, 0), holidays: new Set(), accountAsOf });
    expect(at(sheet("2026-11-10", jst("2026-11-09", 10)), "2026-11-09")).toEqual({ ok: false, reason: "wrong_trading_date" });
    expect(at(sheet("2026-11-10", jst("2026-11-09", 16, 30) - 1), "2026-11-09")).toEqual({ ok: false, reason: "wrong_trading_date" });
    expect(at(sheet("2026-11-10", jst("2026-11-09", 16, 30)), "2026-11-09")).toEqual({ ok: true });
    // 口座が整っていなくても、受け付けの前なら理由は wrong_trading_date
    expect(at(sheet("2026-11-15", jst("2026-11-14", 12)), "2026-11-13")).toEqual({ ok: false, reason: "wrong_trading_date" });
    expect(at(sheet("2026-11-09", jst("2026-11-06", 10)), "2026-11-06")).toEqual({ ok: true });
  });
});

describe("株式分割（§5）", () => {
  const split = (from: number, to: number) => ({ splits: [{ symbol: "AAA", exDate: "2026-11-10", from, to }], dividends: [] });

  it("1株→2株：株数は2倍、取得原価の総額と時価は変わらない", () => {
    const acc = holding("AAA", 150, yen(450_000));
    const { account, events } = applyCorporateActions(acc, "2026-11-10", split(1, 2), {});
    expect(account.holdings.AAA).toEqual({ qty: 300, cost: yen(450_000) });
    expect(account.cash).toBe(INITIAL_CASH);
    expect(events).toEqual([{ kind: "split", symbol: "AAA", from: 1, to: 2, qtyBefore: 150, qtyAfter: 300, cashInLieu: 0, costOut: 0, close: null }]);
    // 分割前の終値3,000円 × 150株 = 分割後の始値1,500円 × 300株
    expect(totalValue(account, { AAA: yen(1_500) })).toBe(totalValue(acc, { AAA: yen(3_000) }));
  });

  it("分割前の口座のまま、前営業日の夜に分割前の株数で全株売りを確定することはできない", () => {
    const s: OrderSheet = { agentId: "ai-1", tradingDate: "2026-11-10", committedAt: jst("2026-11-09", 20), orders: [{ symbol: "AAA", side: "sell", qty: 150 }] };
    expect(validateSheet(s, { universe: new Set(["AAA"]), alreadyCommitted: false, account: holding("AAA", 150, 0), holidays: none, accountAsOf: "2026-11-06" })).toEqual({
      ok: false,
      reason: "account_not_ready",
    });
  });

  it("分割後の株数に合わせた前営業日の終値で評価すると、分割の前後で総資産は変わらない", () => {
    const acc = holding("AAA", 150, yen(450_000));
    const after = applyCorporateActions(acc, "2026-11-10", split(1, 2), {}).account;
    expect(splitAdjustedPrice(yen(3_000), { from: 1, to: 2 })).toBe(yen(1_500));
    expect(totalValue(after, { AAA: splitAdjustedPrice(yen(3_000), { from: 1, to: 2 }) })).toBe(totalValue(acc, { AAA: yen(3_000) }));
  });

  it("前営業日の引け後に反映するので、AIは分割後の株数で全株を売れる", () => {
    const acc = applyCorporateActions(holding("AAA", 150, yen(450_000)), "2026-11-10", split(1, 2), {}).account;
    const s: OrderSheet = { agentId: "ai-1", tradingDate: "2026-11-10", committedAt: jst("2026-11-10", 8), orders: [{ symbol: "AAA", side: "sell", qty: 300 }] };
    expect(validateSheet(s, { universe: new Set(["AAA"]), alreadyCommitted: false, account: acc, holidays: none, accountAsOf: "2026-11-09" })).toEqual({ ok: true });
    const { account, fills } = executeSheet(acc, s, { AAA: yen(1_500) });
    expect(fills[0]).toMatchObject({ qty: 300, status: "filled" });
    expect(account.holdings).toEqual({});
  });

  it("2株→3株で1株未満が出たら、前営業日の終値で現金にし、取得原価を比で減らす", () => {
    const acc = holding("AAA", 225, yen(675_000));
    const { account, events } = applyCorporateActions(acc, "2026-11-10", split(2, 3), { AAA: yen(1_500) });
    // 225 × 1.5 = 337.5株 → 337株と0.5株。0.5株 × 分割後の価格1,000円 = 500円
    const costOut = Math.round(yen(675_000) / 675);
    expect(events[0]).toEqual({ kind: "split", symbol: "AAA", from: 2, to: 3, qtyBefore: 225, qtyAfter: 337, cashInLieu: yen(500), costOut, close: yen(1_500) });
    expect(account.cash).toBe(INITIAL_CASH + yen(500));
    expect(account.holdings.AAA).toEqual({ qty: 337, cost: yen(675_000) - costOut });
  });

  it("10株→1株の併合：端数は現金にし、0株になれば保有を消す", () => {
    const r1 = applyCorporateActions(holding("AAA", 105, yen(105_000)), "2026-11-10", split(10, 1), { AAA: yen(800) });
    expect(r1.account.holdings.AAA?.qty).toBe(10);
    expect(r1.events[0]).toMatchObject({ qtyAfter: 10, cashInLieu: yen(4_000) }); // 5株 × 800円
    const r2 = applyCorporateActions(holding("AAA", 5, yen(5_000)), "2026-11-10", split(10, 1), { AAA: yen(800) });
    expect(r2.account.holdings).toEqual({});
    expect(r2.events[0]).toMatchObject({ qtyAfter: 0, costOut: yen(5_000), close: yen(800) });
    expect(r2.account.cash).toBe(INITIAL_CASH + yen(4_000));
    expect(invariantViolations(r2.account)).toEqual([]);
  });

  it("端数を現金にするのに終値がない、比率が不正、同じ日に同じ銘柄の分割が2つ、は例外にする", () => {
    const acc = holding("AAA", 225, yen(675_000));
    expect(() => applyCorporateActions(acc, "2026-11-10", split(2, 3), {})).toThrow("missing close for AAA");
    expect(() => applyCorporateActions(acc, "2026-11-10", split(2, 3), { AAA: null as unknown as number })).toThrow("missing close for AAA");
    for (const close of [-yen(1_500), 0, Number.NaN, 1.5]) {
      expect(() => applyCorporateActions(acc, "2026-11-10", split(2, 3), { AAA: close })).toThrow("invalid close for AAA");
    }
    const proto = { cash: INITIAL_CASH, holdings: { toString: { qty: 225, cost: yen(675_000) } } };
    expect(() => applyCorporateActions(proto, "2026-11-10", { splits: [{ symbol: "toString", exDate: "2026-11-10", from: 2, to: 3 }], dividends: [] }, {})).toThrow("missing close for toString");
    expect(() => applyCorporateActions(acc, "2026-11-10", split(0, 3), {})).toThrow("invalid split");
    expect(() => applyCorporateActions(acc, "2026-11-10", split(1, 1_000_000), {})).toThrow("invalid split");
    const twice = { splits: [...split(1, 2).splits, ...split(1, 2).splits], dividends: [] };
    expect(() => applyCorporateActions(acc, "2026-11-10", twice, {})).toThrow("duplicate split");
  });
});

describe("配当（§5）", () => {
  it("権利落ち日の配当を、保有株数×1株配当で現金に加える。ほかの日・持っていない銘柄は対象外", () => {
    const acc = holding("AAA", 300, yen(300_000));
    const dividends = [
      { symbol: "AAA", exDate: "2026-11-10", perShare: yen(12.5) },
      { symbol: "AAA", exDate: "2026-12-10", perShare: yen(99) },
      { symbol: "BBB", exDate: "2026-11-10", perShare: yen(50) },
    ];
    const { account, events } = applyCorporateActions(acc, "2026-11-10", { splits: [], dividends }, {});
    expect(account.cash).toBe(INITIAL_CASH + yen(3_750));
    expect(account.holdings.AAA).toEqual({ qty: 300, cost: yen(300_000) });
    expect(events).toEqual([{ kind: "dividend", symbol: "AAA", perShare: yen(12.5), qty: 300, amount: yen(3_750) }]);
  });

  it("同じ日の配当が複数行（普通配当と記念配当）なら合算し、負や小数の配当は例外にする", () => {
    const acc = holding("AAA", 100, yen(100_000));
    const dividends = [
      { symbol: "AAA", exDate: "2026-11-10", perShare: yen(30) },
      { symbol: "AAA", exDate: "2026-11-10", perShare: yen(5) },
    ];
    expect(applyCorporateActions(acc, "2026-11-10", { splits: [], dividends }, {}).account.cash).toBe(INITIAL_CASH + yen(3_500));
    for (const perShare of [-1, 1.5]) {
      expect(() => applyCorporateActions(acc, "2026-11-10", { splits: [], dividends: [{ symbol: "AAA", exDate: "2026-11-10", perShare }] }, {})).toThrow("invalid dividend");
    }
  });

  it("同じ日に分割と配当があれば、配当は分割前の株数で計算する", () => {
    const acc = holding("AAA", 100, yen(100_000));
    const actions = { splits: [{ symbol: "AAA", exDate: "2026-11-10", from: 1, to: 2 }], dividends: [{ symbol: "AAA", exDate: "2026-11-10", perShare: yen(20) }] };
    const { account } = applyCorporateActions(acc, "2026-11-10", actions, {});
    expect(account.cash).toBe(INITIAL_CASH + yen(2_000));
    expect(account.holdings.AAA?.qty).toBe(200);
  });

  it("元の口座は書き換えない", () => {
    const acc = holding("AAA", 100, yen(100_000));
    const before = structuredClone(acc);
    applyCorporateActions(acc, "2026-11-10", { splits: [{ symbol: "AAA", exDate: "2026-11-10", from: 1, to: 3 }], dividends: [{ symbol: "AAA", exDate: "2026-11-10", perShare: yen(5) }] }, {});
    expect(acc).toEqual(before);
  });
});

describe("反映した内容だけで口座をたどり直せる（docs/EVENT_LOG.md §3.3）", () => {
  // 反映前の口座に、イベントの並びだけを当てる（終値や公表の内容は使わない）。記録した数どうしが食い違わないことも確かめる
  function replay(before: Account, events: CorporateEvent[]): Account {
    let cash = before.cash;
    const holdings = Object.fromEntries(Object.entries(before.holdings).map(([k, h]) => [k, { ...h }]));
    for (const e of events) {
      if (e.kind === "dividend") {
        expect(e.amount).toBe(e.perShare * e.qty);
        cash += e.amount;
        continue;
      }
      const h = holdings[e.symbol]!;
      expect(h.qty).toBe(e.qtyBefore);
      expect(e.qtyAfter).toBe(Math.floor((e.qtyBefore * e.to) / e.from));
      const rem = e.qtyBefore * e.to - e.qtyAfter * e.from;
      expect(e.close === null).toBe(rem === 0);
      expect(e.cashInLieu).toBe(e.close === null ? 0 : Math.round((e.close * rem) / e.to));
      expect(e.costOut).toBe(rem === 0 ? 0 : e.qtyAfter === 0 ? h.cost : Math.round((h.cost * rem) / (e.qtyBefore * e.to)));
      cash += e.cashInLieu;
      h.cost -= e.costOut;
      if (e.qtyAfter === 0) delete holdings[e.symbol];
      else h.qty = e.qtyAfter;
    }
    return { cash, holdings };
  }

  it("配当と分割・併合が同じ日にある口座で、反映の結果と一致する", () => {
    const before: Account = {
      cash: INITIAL_CASH,
      holdings: { AAA: { qty: 225, cost: yen(675_000) }, BBB: { qty: 5, cost: yen(5_000) }, CCC: { qty: 100, cost: yen(100_000) } },
    };
    const actions = {
      splits: [
        { symbol: "AAA", exDate: "2026-11-10", from: 2, to: 3 },
        { symbol: "BBB", exDate: "2026-11-10", from: 10, to: 1 },
        { symbol: "CCC", exDate: "2026-11-10", from: 1, to: 2 },
      ],
      dividends: [
        { symbol: "AAA", exDate: "2026-11-10", perShare: yen(12.5) },
        { symbol: "AAA", exDate: "2026-11-10", perShare: yen(3) },
        { symbol: "ZZZ", exDate: "2026-11-10", perShare: yen(9) }, // 持っていない銘柄は記録しない
      ],
    };
    actions.splits.push({ symbol: "YYY", exDate: "2026-11-10", from: 1, to: 2 });
    const { account, events } = applyCorporateActions(before, "2026-11-10", actions, { AAA: yen(1_500), BBB: yen(800) });
    expect(events.map((e) => `${e.kind}:${e.symbol}`)).toEqual(["dividend:AAA", "dividend:AAA", "split:AAA", "split:BBB", "split:CCC"]);
    expect(replay(before, events)).toEqual(account);
  });
});
