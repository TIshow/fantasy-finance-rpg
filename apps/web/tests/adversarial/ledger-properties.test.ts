// 検証役（#59 PR-2）：台帳（src/ledger/）と再計算（src/events/replay.ts）の性質テスト。
// 固定シードの無作為な売買・分割・配当・臨時休場の列で、(a) 現金・保有が負にならない、(b) replay の再計算が記録と一致する、
// (c) 同じ入力で同じ結果、(d) 0.1円単位の丸めが1円もずれない、を確かめる。(d) は文書（PAPER_TRADING_RULES §4・§5）から
// BigInt で独立に書いた模型と比べる。失敗したときは、シード・日付・入力をメッセージに出す。
import { describe, expect, it } from "vitest";
import { EventLog, type Draft } from "../../src/events/append";
import { bodyHash } from "../../src/events/hash";
import { Ledger, replay, type ValueStore } from "../../src/events/replay";
import type { HolidayTable } from "../../src/holidays/table";
import { applyCorporateActions, type CorporateEvent, type Dividend, type Split } from "../../src/ledger/corporate";
import { executeSheet, invariantViolations, newAccount, nextBusinessDay } from "../../src/ledger/ledger";
import { INITIAL_CASH, LOT, type Account, type Fill, type Order } from "../../src/ledger/types";
import { mulberry32, pick, randInt } from "../fixtures/prng";

/** 固定シードの乱数（core の tests/fixtures/prng.ts の mulberry32） */
function rng(seed: number) {
  const next = mulberry32(seed);
  return { next, int: (lo: number, hi: number) => randInt(next, lo, hi), pick: <T>(xs: readonly T[]) => pick(next, xs) };
}
type Rng = ReturnType<typeof rng>;

// ---- 文書から書いた模型（BigInt、0.1円未満は四捨五入） ----
// 文書が丸め方を決めているのは一部の売りの取得原価の按分だけ（§4）。分割の端数の現金と、端数の比で減らす取得原価（§5）は
// 文書に丸めの記載がなく、ここでは同じく四捨五入、端数の現金は「前営業日の終値 × 分割前の株数に直した端数」と仮定する
type Model = { cash: bigint; h: Map<string, { qty: bigint; cost: bigint }> };
const half = (n: bigint, d: bigint) => (2n * n + d) / (2n * d);
const modelOf = (a: Account): Model => ({ cash: BigInt(a.cash), h: new Map(Object.entries(a.holdings).map(([s, x]) => [s, { qty: BigInt(x.qty), cost: BigInt(x.cost) }])) });
const plain = (m: Model): Account => ({ cash: Number(m.cash), holdings: Object.fromEntries([...m.h].map(([s, x]) => [s, { qty: Number(x.qty), cost: Number(x.cost) }])) });

/** 経路ごとの回数。生成器を変えて経路を通らなくなったら、テストが落ちるようにする */
type Stats = Record<string, number>;
const bump = (st: Stats, k: string) => (st[k] = (st[k] ?? 0) + 1);

/**
 * §4：売りを先、買いを後（それぞれ注文票の並び順）。売りは保有まで減らし、取得原価は株数の比で按分。
 * 買いは買える最大の100株単位まで減らし、0株なら失効。始値がなければ失効。どれも理由を記録する。約定の記録を返す
 */
function modelExecute(m: Model, orders: readonly Order[], opens: Readonly<Record<string, number | null>>, st: Stats = {}): Fill[] {
  const fills: Fill[] = [];
  const sellIdx = orders.findIndex((x) => x.side === "sell");
  if (sellIdx >= 0 && orders.slice(0, sellIdx).some((x) => x.side === "buy")) bump(st, "buy listed before a sell");
  for (const o of [...orders.filter((x) => x.side === "sell"), ...orders.filter((x) => x.side === "buy")]) {
    const base = { symbol: o.symbol, side: o.side, requestedQty: o.qty };
    const p = opens[o.symbol];
    const record = (q: bigint, reason?: Fill["reason"]) => {
      const qty = Number(q);
      const status = qty === 0 ? "expired" : qty < o.qty ? "reduced" : "filled";
      const f: Fill = { ...base, qty, price: p ?? null, amount: qty * (p ?? 0), status, ...(status === "filled" ? {} : { reason }) };
      bump(st, `${status}:${f.reason ?? ""}`);
      fills.push(f);
    };
    if (p === null || p === undefined) {
      record(0n, "no_open_price");
      continue;
    }
    const price = BigInt(p);
    const h = m.h.get(o.symbol) ?? { qty: 0n, cost: 0n };
    if (o.side === "sell") {
      const q = BigInt(o.qty) < h.qty ? BigInt(o.qty) : h.qty;
      record(q, "insufficient_holdings");
      if (q === 0n) continue;
      m.cash += price * q;
      if (q === h.qty) m.h.delete(o.symbol);
      else m.h.set(o.symbol, { qty: h.qty - q, cost: h.cost - half(h.cost * q, h.qty) });
    } else {
      const lots = m.cash / (price * BigInt(LOT));
      const q = BigInt(o.qty) < lots * BigInt(LOT) ? BigInt(o.qty) : lots * BigInt(LOT);
      record(q, "insufficient_cash");
      if (q === 0n) continue;
      m.cash -= price * q;
      m.h.set(o.symbol, { qty: h.qty + q, cost: h.cost + price * q });
    }
  }
  return fills;
}

/** 臨時休場の日の注文票：全件失効、理由 market_closed（EVENT_LOG §3.3） */
const closedFills = (orders: readonly Order[]): Fill[] =>
  [...orders.filter((x) => x.side === "sell"), ...orders.filter((x) => x.side === "buy")].map((o) => ({ symbol: o.symbol, side: o.side, requestedQty: o.qty, qty: 0, price: null, amount: 0, status: "expired", reason: "market_closed" }));

/** §5：配当を先（分割前の株数）、分割を後。端数は前営業日の終値で現金にし、取得原価を端数の比で減らす。反映した内容を返す */
function modelCorporate(m: Model, divs: readonly Dividend[], splits: readonly Split[], closes: Readonly<Record<string, number>>, st: Stats = {}): CorporateEvent[] {
  const events: CorporateEvent[] = [];
  const paid = new Set<string>();
  for (const d of divs) {
    const h = m.h.get(d.symbol);
    if (!h) continue;
    if (paid.has(d.symbol)) bump(st, "second dividend on a symbol");
    paid.add(d.symbol);
    m.cash += h.qty * BigInt(d.perShare);
    events.push({ kind: "dividend", symbol: d.symbol, perShare: d.perShare, qty: Number(h.qty), amount: Number(h.qty * BigInt(d.perShare)) });
  }
  for (const s of splits) {
    const h = m.h.get(s.symbol);
    if (!h) continue;
    const [from, to] = [BigInt(s.from), BigInt(s.to)];
    const before = h.qty;
    const after = (h.qty * to) / from;
    const rem = h.qty * to - after * from;
    let [cil, costOut] = [0n, 0n];
    if (rem > 0n) {
      cil = half(BigInt(closes[s.symbol]!) * rem, to);
      costOut = after === 0n ? h.cost : half(h.cost * rem, h.qty * to);
      m.cash += cil;
      h.cost -= costOut;
      bump(st, after === 0n ? "split to zero" : "split with cash in lieu");
    }
    if (after === 0n) m.h.delete(s.symbol);
    else h.qty = after;
    events.push({ kind: "split", symbol: s.symbol, from: s.from, to: s.to, qtyBefore: Number(before), qtyAfter: Number(after), cashInLieu: Number(cil), costOut: Number(costOut), close: rem > 0n ? closes[s.symbol]! : null });
  }
  return events;
}

const SYMBOLS = ["AAA", "BBB", "CCC"];
const RATIOS: [number, number][] = [[1, 2], [1, 3], [3, 4], [2, 3], [10, 1], [1, 5], [7, 3], [1000, 1]];

/**
 * 保有から売り（100株単位か、端数を含む全株）と買いを、無作為な並びで。overSell なら、保有を超える売り（重複を含む）も混ぜる。
 * overSell でなければ validateSheet の規則に合う注文票
 */
function randomOrders(r: Rng, a: Account, overSell = false): Order[] {
  const orders: Order[] = [];
  for (const [symbol, h] of Object.entries(a.holdings)) {
    if (r.next() < 0.4) orders.push({ symbol, side: "sell", qty: r.next() < 0.5 || h.qty < LOT ? h.qty : LOT * r.int(1, Math.floor(h.qty / LOT)) });
    // 端数のある保有の全株売りは、確定時の株数と同じでなければ例外（validateSheet を通らない注文票）なので、100株単位の保有だけ
    if (overSell && h.qty % LOT === 0 && r.next() < 0.15) orders.push({ symbol, side: "sell", qty: LOT * (Math.floor(h.qty / LOT) + r.int(1, 3)) });
  }
  for (let i = r.int(0, 2); i > 0; i--) orders.push({ symbol: r.pick(SYMBOLS), side: "buy", qty: LOT * r.int(1, 60) });
  // 並びを混ぜる（Fisher–Yates）。買いが売りより前に書かれた注文票で「売りを先」を試す
  for (let i = orders.length - 1; i > 0; i--) {
    const j = r.int(0, i);
    [orders[i], orders[j]] = [orders[j]!, orders[i]!];
  }
  return orders;
}
const randomPrice = (r: Rng, base: number) => Math.max(10, Math.round(base * (0.9 + r.next() * 0.2)));
const sheetOf = (orders: Order[]) => ({ agentId: "x", tradingDate: "2026-11-10", committedAt: 0, orders });

describe("台帳の関数と模型（純関数、200シード×60手）", () => {
  it("約定と分割・配当のたびに、不変条件を守り、口座も記録も模型と0.1円も違わない", () => {
    const st: Stats = {};
    for (let seed = 1; seed <= 200; seed++) {
      const r = rng(seed);
      let acc = newAccount();
      const m = modelOf(acc);
      const base: Record<string, number> = Object.fromEntries(SYMBOLS.map((s) => [s, r.int(100, 80_000)]));
      for (let step = 0; step < 60; step++) {
        const before = acc;
        let input: unknown;
        let records: [unknown, unknown];
        if (r.next() < 0.75) {
          const orders = randomOrders(r, acc, true);
          const opens = Object.fromEntries(SYMBOLS.map((s) => [s, r.next() < 0.1 ? null : (base[s] = randomPrice(r, base[s]!))]));
          input = { orders, opens };
          const out = executeSheet(acc, sheetOf(orders), opens);
          acc = out.account;
          records = [out.fills, modelExecute(m, orders, opens, st)];
        } else {
          const divs: Dividend[] = SYMBOLS.flatMap((symbol) => Array.from({ length: r.next() < 0.3 ? r.int(1, 2) : 0 }, () => ({ symbol, exDate: "2026-11-11", perShare: r.int(0, 2_000) })));
          const splits: Split[] = SYMBOLS.filter(() => r.next() < 0.3).map((symbol) => {
            const [from, to] = r.pick(RATIOS);
            return { symbol, exDate: "2026-11-11", from, to };
          });
          const closes = { ...base };
          input = { divs, splits, closes };
          const out = applyCorporateActions(acc, "2026-11-11", { splits, dividends: divs }, closes);
          acc = out.account;
          records = [out.events, modelCorporate(m, divs, splits, closes, st)];
          for (const s of splits) base[s.symbol] = Math.min(1_000_000, Math.max(10, Math.round((base[s.symbol]! * s.from) / s.to)));
        }
        const at = `seed ${seed} step ${step} input ${JSON.stringify(input)} before ${JSON.stringify(before)}`;
        expect(invariantViolations(acc), at).toEqual([]);
        expect(acc, at).toEqual(plain(m));
        expect(records[0], at).toEqual(records[1]);
      }
    }
    for (const k of ["filled:", "reduced:insufficient_cash", "reduced:insufficient_holdings", "expired:insufficient_cash", "expired:insufficient_holdings", "expired:no_open_price", "buy listed before a sell", "second dividend on a symbol", "split to zero", "split with cash in lieu"]) {
      expect(st[k] ?? 0, `path ${k} ${JSON.stringify(st)}`).toBeGreaterThan(0);
    }
  });

  // 欠陥（低）：按分の Math.round((cost * qty) / held) は浮動小数の割り算で、商が大きいと四捨五入の境目で0.1円ずれる
  // （ledger.ts fillOne、corporate.ts の costOut も同じ形）。届くのは取得原価が約3億円・保有が数百万株の奇数のような規模で、
  // 初期資金1,000万円からは現実的でない。直し方の方針：整数だけで (2*cost*qty + held) / (2*held) を計算する（BigInt か、安全な範囲の確認）
  const big: Account = { cash: 0, holdings: { AAA: { qty: 3_000_001, cost: 3_001_501_001 } } };
  const bigSell: Order[] = [{ symbol: "AAA", side: "sell", qty: 3_000_000 }];
  it("（前提）大きな額の一部の売りは例外にならず、ずれは取得原価の0.1円以内にとどまる", () => {
    const { account: after } = executeSheet(big, sheetOf(bigSell), { AAA: 10 });
    const m = modelOf(big);
    modelExecute(m, bigSell, { AAA: 10 });
    expect(after.cash).toBe(Number(m.cash));
    expect(Math.abs(after.holdings.AAA!.cost - Number(m.h.get("AAA")!.cost))).toBeLessThanOrEqual(1);
  });
  it.fails("一部の売りの取得原価の按分は、大きな額でも整数の四捨五入と一致する", () => {
    const { account: after } = executeSheet(big, sheetOf(bigSell), { AAA: 10 });
    const m = modelOf(big);
    modelExecute(m, bigSell, { AAA: 10 });
    expect(after).toEqual(plain(m));
  });
});

// ---- 追記の処理・台帳・replay をつないだ無作為な日々 ----
const jst = (date: string, hh: number, mm = 0) => Date.parse(`${date}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+09:00`);
const SHA = "d".repeat(64);
/** 11/23 は祝日の一覧の休場日 */
const TABLE: HolidayTable = { firstYear: 2026, lastYear: 2027, sourceSha256: "0".repeat(64), contentSha256: SHA, dates: new Set(["2026-11-23"]) };
const CTX = { holidayTables: new Map([[SHA, TABLE]]) };
const AGENTS = ["alpha", "beta"];

class Store implements ValueStore {
  readonly map = new Map<string, { salt: Uint8Array; value: unknown }>();
  async put(value: unknown) {
    const salt = new Uint8Array(16).fill(this.map.size % 256).map((x, i) => x ^ i);
    const hash = await bodyHash(salt, { value });
    this.map.set(hash, { salt, value });
    return hash;
  }
  get(hash: string) {
    return this.map.get(hash);
  }
}

/** seed の日々を最後まで書き、ログ・値・台帳・模型を返す。途中で模型や不変条件と合わなければ、その場で落とす */
async function simulate(seed: number, st: Stats, days = 18) {
  const r = rng(seed);
  const store = new Store();
  const ledger = new Ledger(store);
  const log = new EventLog({ ...CTX, accountOf: (id) => ledger.account(id) });
  const add = async (d: Draft) => {
    const res = await log.append(d);
    if (!res.ok) throw new Error(`seed ${seed}: ${d.type} ${JSON.stringify(d.payload)}: ${res.reason}`);
    await ledger.apply(res.event);
    return res.event.seq;
  };
  const sys = (type: Draft["type"], at: number, payload: Record<string, unknown>, refs: number[] = []): Draft => ({ type, recordedAt: at, actor: "system", refs, payload });
  const op = (type: Draft["type"], at: number, payload: Record<string, unknown>): Draft => ({ type, recordedAt: at, actor: "operator:owner", refs: [], payload });
  const models = new Map(AGENTS.map((id) => [id, modelOf(newAccount())]));
  const check = (id: string, at: string) => {
    const a = ledger.account(id);
    expect(invariantViolations(a), `seed ${seed} ${at} ${id}`).toEqual([]);
    expect(a, `seed ${seed} ${at} ${id}`).toEqual(plain(models.get(id)!));
  };

  await add(op("holidays.adopted", 0, { holidaysSha256: SHA }));
  await add(op("universe.set", 0, { symbols: SYMBOLS }));
  for (const [i, id] of AGENTS.entries()) await add(op("agent.registered", jst("2026-11-06", 20, i), { agentId: id, startDate: "2026-11-09", initialCash: INITIAL_CASH }));
  const H = () => log.holidays();
  // 臨時休場にする日を先に決める（その日を権利落ち日にする公表は出さない。権利落ち日が休場になった扱いは §6.2 の訂正で、別のPR）。
  // 休場の翌営業日を権利落ち日にする公表は出し、休場のあとの追加の引け後処理（§3.3、closedSeq。#71）で反映する
  const dates: string[] = [];
  for (let d = "2026-11-09"; dates.length < days; d = nextBusinessDay(d, H())) dates.push(d);
  const closedPlan = new Set(dates.slice(2, -2).filter(() => r.next() < 0.12));
  const base: Record<string, number> = Object.fromEntries(SYMBOLS.map((s) => [s, r.int(100, 80_000)]));
  const pending = new Map<string, { seq: number; orders: Order[]; date: string }>();
  let lastClose: Record<string, number> = { ...base };
  let lastCloseSeq = 0;
  /** 休場 T の翌営業日に権利落ち日がずれる公表。T の前営業日 D の引け後処理のあと、T に追加の処理で反映する */
  let moved = null as { T: string; D: string; exDate: string; divs: Dividend[]; splits: Split[]; ann: number[] } | null;
  const announce = async (at: number, exDate: string, divs: Dividend[], splits: Split[], ann: number[], pDiv: number, pSplit: number) => {
    for (const symbol of SYMBOLS) {
      for (let k = r.next() < pDiv ? r.int(1, 2) : 0; k > 0; k--) {
        const perShare = r.int(0, 1_500);
        divs.push({ symbol, exDate, perShare });
        ann.push(await add(sys("corporate_action.announced", at + ann.length * 1000, { symbol, exDate, valuesHash: await store.put({ kind: "dividend", perShare }) })));
      }
      if (r.next() < pSplit && !splits.some((x) => x.symbol === symbol)) {
        const [from, to] = r.pick(RATIOS);
        splits.push({ symbol, exDate, from, to });
        ann.push(await add(sys("corporate_action.announced", at + ann.length * 1000, { symbol, exDate, valuesHash: await store.put({ kind: "split", from, to }) })));
      }
    }
  };

  for (let D = "2026-11-09", n = 0; n < days; n++) {
    // 前の晩に確定した注文票を、始値で約定させる（臨時休場なら全件失効）
    const closedSeq = closedPlan.has(D) ? await add(op("market.closed", jst(D, 7), { date: D, reason: "test" })) : undefined;
    // 休場のあとにも、ずれた権利落ち日の公表が出ることがある（追加の処理の前なら、それも渡す）
    if (moved?.T === D && r.next() < 0.4) await announce(jst(D, 8), moved.exDate, moved.divs, moved.splits, moved.ann, 0.15, 0.15);
    const open = closedPlan.has(D) ? undefined : Object.fromEntries(SYMBOLS.map((s) => [s, r.next() < 0.08 ? null : (base[s] = randomPrice(r, base[s]!))]));
    const openSeq = open ? await add(sys("prices.open", jst(D, 9), { date: D, valuesHash: await store.put(open) })) : undefined;
    for (const [i, id] of AGENTS.entries()) {
      const p = pending.get(id);
      if (!p) continue;
      const f = await ledger.computeFills(id, p.seq, openSeq);
      await add(sys("fills.executed", jst(D, 9, 1 + i), { agentId: id, tradingDate: D, sheetSeq: p.seq, ...(openSeq ? { openSeq } : {}), ...f.payload }, openSeq ? [p.seq, openSeq] : [p.seq]));
      const at = `${D} fills ${JSON.stringify({ orders: p.orders, open })}`;
      if (!open) bump(st, "sheet closed by market.closed");
      expect(f.payload.fills, `seed ${seed} ${at} ${id}`).toEqual(open ? modelExecute(models.get(id)!, p.orders, open, st) : closedFills(p.orders));
      check(id, at);
      pending.delete(id);
    }
    if (moved?.T === D) {
      const mv = moved;
      moved = null;
      for (const [i, id] of AGENTS.entries()) {
        // 反映する公表があるうちは、翌営業日の注文票は account_not_ready で拒まれる（公表がなければ追加の処理は書かなくてよい）
        if (mv.ann.length > 0 && r.next() < 0.5) {
          const run = await add(sys("agent.run", jst(D, 10, 4 * i), { agentId: id, purpose: "order", inputSeqs: [], ok: true }));
          const c = await log.commitSheet(jst(D, 10, 4 * i + 1), id, { tradingDate: mv.exDate, orders: [], runSeq: run, inputSeqs: [] });
          expect(c.ok && c.rejected, `seed ${seed} ${D} ${id} sheet before the catch-up`).toBe("account_not_ready");
          if (c.ok) await ledger.apply(c.event);
          bump(st, "sheet blocked until the catch-up");
        }
        if (mv.ann.length === 0 && r.next() < 0.5) continue;
        const ca = await ledger.computeCorporate(id, mv.D, mv.exDate, mv.ann);
        const draft = sys("corporate_actions.applied", jst(D, 10, 4 * i + 2), { agentId: id, asOf: mv.D, exDate: mv.exDate, announcedSeqs: mv.ann, closedSeq, ...ca.payload }, [...mv.ann, closedSeq!]);
        await add(draft);
        const at = `${D} catch-up ${JSON.stringify({ divs: mv.divs, splits: mv.splits, lastClose })}`;
        const mm = models.get(id)!;
        const expected = modelCorporate(mm, mv.divs, mv.splits, lastClose, st).map((e) => (e.kind === "split" && e.close !== null ? { ...e, closeSeq: lastCloseSeq } : e));
        expect(ca.payload.actions, `seed ${seed} ${at} ${id}`).toEqual(expected);
        check(id, at);
        bump(st, expected.length > 0 ? "catch-up with actions" : "catch-up without actions");
        if (expected.some((e) => e.kind === "split" && e.close !== null)) bump(st, "catch-up split with cash in lieu");
        // 同じ休場の追加の処理は1回だけ
        expect((await log.append({ ...draft, recordedAt: draft.recordedAt + 1 })).ok, `seed ${seed} ${at} ${id} twice`).toBe(false);
      }
      for (const s of mv.splits) base[s.symbol] = Math.min(1_000_000, Math.max(10, Math.round((base[s.symbol]! * s.from) / s.to)));
    }
    if (!closedPlan.has(D)) {
      lastClose = Object.fromEntries(SYMBOLS.map((s) => [s, (base[s] = randomPrice(r, base[s]!))]));
      const closeSeq = await add(sys("prices.close", jst(D, 15, 30), { date: D, valuesHash: await store.put(lastClose) }));
      lastCloseSeq = closeSeq;
      // 翌営業日が権利落ち日の配当・分割を公表し、評価のあとに反映する
      const ex = nextBusinessDay(D, H());
      const divs: Dividend[] = [];
      const splits: Split[] = [];
      const ann: number[] = [];
      if (!closedPlan.has(ex)) await announce(jst(D, 15, 31), ex, divs, splits, ann, 0.2, 0.15);
      else {
        // 翌営業日 T を休場にする予定：T の次の日（それも休場でなければ）を権利落ち日にする公表を、休場より前に出す
        const after = dates[dates.indexOf(ex) + 1];
        if (after && !closedPlan.has(after)) {
          moved = { T: ex, D, exDate: after, divs: [], splits: [], ann: [] };
          await announce(jst(D, 15, 35), after, moved.divs, moved.splits, moved.ann, 0.35, 0.3);
        }
      }
      for (const [i, id] of AGENTS.entries()) {
        const v = ledger.computeValuation(id, D);
        const mm = models.get(id)!;
        expect(v.total, `seed ${seed} ${D} valuation ${id}`).toBe(Number([...mm.h].reduce((t, [sym, x]) => t + BigInt(lastClose[sym]!) * x.qty, mm.cash)));
        await add(sys("valuation.recorded", jst(D, 15, 40 + 2 * i), { agentId: id, date: D, closeSeq, ...v }, [closeSeq]));
        const ca = await ledger.computeCorporate(id, D, ex, ann);
        await add(sys("corporate_actions.applied", jst(D, 15, 41 + 2 * i), { agentId: id, asOf: D, exDate: ex, announcedSeqs: ann, ...ca.payload }, ann));
        const at = `${D} corporate ${JSON.stringify({ divs, splits, lastClose })}`;
        // 記録の分割には、端数の換金に使った終値の seq が付く
        const expected = modelCorporate(mm, divs, splits, lastClose, st).map((e) => (e.kind === "split" && e.close !== null ? { ...e, closeSeq } : e));
        expect(ca.payload.actions, `seed ${seed} ${at} ${id}`).toEqual(expected);
        check(id, at);
      }
      for (const s of splits) base[s.symbol] = Math.min(1_000_000, Math.max(10, Math.round((base[s.symbol]! * s.from) / s.to)));
    }
    // 夜：翌営業日の注文票（確定しない日もある）
    for (const [i, id] of AGENTS.entries()) {
      if (r.next() < 0.2) continue;
      const run = await add(sys("agent.run", jst(D, 20, 2 * i), { agentId: id, purpose: "order", inputSeqs: [], ok: true }));
      const orders = randomOrders(r, ledger.account(id));
      const c = await log.commitSheet(jst(D, 20, 2 * i + 1), id, { tradingDate: nextBusinessDay(D, H()), orders, runSeq: run, inputSeqs: [] });
      if (!c.ok || c.rejected) throw new Error(`seed ${seed} ${D} ${id}: sheet rejected ${c.ok ? c.rejected : c.reason} ${JSON.stringify(orders)}`);
      await ledger.apply(c.event);
      pending.set(id, { seq: c.event.seq, orders, date: D });
    }
    D = nextBusinessDay(D, H());
  }
  return { log, store, ledger };
}

describe("追記・台帳・replay をつないだ無作為な日々（20シード×18営業日、祝日と臨時休場を含む）", () => {
  it("どの時点でも口座・約定・分割配当・評価が模型と一致し、保存したログを replay すると同じ口座になり、同じシードは同じログになる", async () => {
    const st: Stats = {};
    for (let seed = 1; seed <= 20; seed++) {
      const a = await simulate(seed, st);
      const replayed = await replay(a.log.events, a.store, CTX);
      for (const id of AGENTS) expect(replayed.account(id), `seed ${seed} ${id}`).toEqual(a.ledger.account(id));
      const b = await simulate(seed, {});
      expect(b.log.events.at(-1)!.hash, `seed ${seed}`).toBe(a.log.events.at(-1)!.hash);
    }
    for (const k of ["filled:", "reduced:insufficient_cash", "expired:no_open_price", "sheet closed by market.closed", "buy listed before a sell", "split with cash in lieu", "catch-up with actions", "catch-up without actions", "catch-up split with cash in lieu", "sheet blocked until the catch-up"]) {
      expect(st[k] ?? 0, `path ${k} ${JSON.stringify(st)}`).toBeGreaterThan(0);
    }
  }, 120_000);
});
