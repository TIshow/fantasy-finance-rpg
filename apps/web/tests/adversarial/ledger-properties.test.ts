// 検証役（#59 PR-2）：台帳（src/ledger/）と再計算（src/events/replay.ts）の性質テスト。
// 固定シードの無作為な売買・分割・配当・臨時休場の列で、(a) 現金・保有が負にならない、(b) replay の再計算が記録と一致する、
// (c) 同じ入力で同じ結果、(d) 0.1円単位の丸めが1円もずれない、を確かめる。(d) は文書（PAPER_TRADING_RULES §4・§5）から
// BigInt で独立に書いた模型と比べる。失敗したときは、シード・日付・入力をメッセージに出す。
import { describe, expect, it } from "vitest";
import { EventLog, type Draft } from "../../src/events/append";
import { bodyHash } from "../../src/events/hash";
import { Ledger, replay, type ValueStore } from "../../src/events/replay";
import type { HolidayTable } from "../../src/holidays/table";
import { applyCorporateActions, type Dividend, type Split } from "../../src/ledger/corporate";
import { executeSheet, invariantViolations, newAccount, nextBusinessDay } from "../../src/ledger/ledger";
import { INITIAL_CASH, LOT, type Account, type Order } from "../../src/ledger/types";
import { mulberry32, pick, randInt } from "../fixtures/prng";

/** 固定シードの乱数（core の tests/fixtures/prng.ts の mulberry32） */
function rng(seed: number) {
  const next = mulberry32(seed);
  return { next, int: (lo: number, hi: number) => randInt(next, lo, hi), pick: <T>(xs: readonly T[]) => pick(next, xs) };
}
type Rng = ReturnType<typeof rng>;

// ---- 文書から書いた模型（BigInt、0.1円未満は四捨五入） ----
type Model = { cash: bigint; h: Map<string, { qty: bigint; cost: bigint }> };
const half = (n: bigint, d: bigint) => (2n * n + d) / (2n * d);
const modelOf = (a: Account): Model => ({ cash: BigInt(a.cash), h: new Map(Object.entries(a.holdings).map(([s, x]) => [s, { qty: BigInt(x.qty), cost: BigInt(x.cost) }])) });
const plain = (m: Model): Account => ({ cash: Number(m.cash), holdings: Object.fromEntries([...m.h].map(([s, x]) => [s, { qty: Number(x.qty), cost: Number(x.cost) }])) });

/** §4：売りを先、買いを後。売りは保有まで減らし、取得原価は株数の比で按分。買いは買える最大の100株単位まで減らす。始値がなければ失効 */
function modelExecute(m: Model, orders: readonly Order[], opens: Readonly<Record<string, number | null>>): void {
  for (const o of [...orders.filter((x) => x.side === "sell"), ...orders.filter((x) => x.side === "buy")]) {
    const p = opens[o.symbol];
    if (p === null || p === undefined) continue;
    const price = BigInt(p);
    const h = m.h.get(o.symbol) ?? { qty: 0n, cost: 0n };
    if (o.side === "sell") {
      const q = BigInt(o.qty) < h.qty ? BigInt(o.qty) : h.qty;
      if (q === 0n) continue;
      m.cash += price * q;
      if (q === h.qty) m.h.delete(o.symbol);
      else m.h.set(o.symbol, { qty: h.qty - q, cost: h.cost - half(h.cost * q, h.qty) });
    } else {
      const lots = m.cash / (price * BigInt(LOT));
      const q = BigInt(o.qty) < lots * BigInt(LOT) ? BigInt(o.qty) : lots * BigInt(LOT);
      if (q === 0n) continue;
      m.cash -= price * q;
      m.h.set(o.symbol, { qty: h.qty + q, cost: h.cost + price * q });
    }
  }
}

/** §5：配当を先（分割前の株数）、分割を後。端数は前営業日の終値で現金にし、取得原価を端数の比で減らす */
function modelCorporate(m: Model, divs: readonly Dividend[], splits: readonly Split[], closes: Readonly<Record<string, number>>): void {
  for (const d of divs) {
    const h = m.h.get(d.symbol);
    if (h) m.cash += h.qty * BigInt(d.perShare);
  }
  for (const s of splits) {
    const h = m.h.get(s.symbol);
    if (!h) continue;
    const [from, to] = [BigInt(s.from), BigInt(s.to)];
    const after = (h.qty * to) / from;
    const rem = h.qty * to - after * from;
    if (rem > 0n) {
      m.cash += half(BigInt(closes[s.symbol]!) * rem, to);
      h.cost -= after === 0n ? h.cost : half(h.cost * rem, h.qty * to);
    }
    if (after === 0n) m.h.delete(s.symbol);
    else h.qty = after;
  }
}

const SYMBOLS = ["AAA", "BBB", "CCC"];
const RATIOS: [number, number][] = [[1, 2], [1, 3], [3, 4], [2, 3], [10, 1], [1, 5], [7, 3]];

/** 保有から売り（100株単位か、端数を含む全株）、残りは買い。validateSheet の株数の規則に合う注文票 */
function randomOrders(r: Rng, a: Account): Order[] {
  const orders: Order[] = [];
  for (const [symbol, h] of Object.entries(a.holdings)) {
    if (r.next() < 0.4) orders.push({ symbol, side: "sell", qty: r.next() < 0.5 || h.qty < LOT ? h.qty : LOT * r.int(1, Math.floor(h.qty / LOT)) });
  }
  for (let i = r.int(0, 2); i > 0; i--) orders.push({ symbol: r.pick(SYMBOLS), side: "buy", qty: LOT * r.int(1, 60) });
  return orders;
}
const randomPrice = (r: Rng, base: number) => Math.max(10, Math.round(base * (0.9 + r.next() * 0.2)));

describe("台帳の関数と模型（純関数、200シード×60手）", () => {
  it("約定と分割・配当のたびに、不変条件を守り、模型と0.1円も違わず、記録の差が口座の差に等しい", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const r = rng(seed);
      let acc = newAccount();
      const m = modelOf(acc);
      const base: Record<string, number> = Object.fromEntries(SYMBOLS.map((s) => [s, r.int(100, 80_000)]));
      for (let step = 0; step < 60; step++) {
        const before = acc;
        let input: unknown;
        let delta: number;
        if (r.next() < 0.75) {
          const orders = randomOrders(r, acc);
          const opens = Object.fromEntries(SYMBOLS.map((s) => [s, r.next() < 0.1 ? null : (base[s] = randomPrice(r, base[s]!))]));
          input = { orders, opens };
          const out = executeSheet(acc, { agentId: "x", tradingDate: "2026-11-10", committedAt: 0, orders }, opens);
          acc = out.account;
          modelExecute(m, orders, opens);
          delta = out.fills.reduce((t, f) => t + (f.side === "sell" ? f.amount : -f.amount), 0);
        } else {
          const divs: Dividend[] = SYMBOLS.filter(() => r.next() < 0.3).map((symbol) => ({ symbol, exDate: "2026-11-11", perShare: r.int(0, 2_000) }));
          const splits: Split[] = SYMBOLS.filter(() => r.next() < 0.3).map((symbol) => {
            const [from, to] = r.pick(RATIOS);
            return { symbol, exDate: "2026-11-11", from, to };
          });
          const closes = { ...base };
          input = { divs, splits, closes };
          const out = applyCorporateActions(acc, "2026-11-11", { splits, dividends: divs }, closes);
          acc = out.account;
          modelCorporate(m, divs, splits, closes);
          for (const s of splits) base[s.symbol] = Math.max(10, Math.round((base[s.symbol]! * s.from) / s.to));
          delta = out.events.reduce((t, e) => t + (e.kind === "dividend" ? e.amount : e.cashInLieu), 0);
        }
        const at = `seed ${seed} step ${step} input ${JSON.stringify(input)} before ${JSON.stringify(before)}`;
        expect(invariantViolations(acc), at).toEqual([]);
        expect(acc, at).toEqual(plain(m));
        expect(acc.cash - before.cash, at).toBe(delta);
      }
    }
  });

  // 欠陥（低）：按分の Math.round((cost * qty) / held) は浮動小数の割り算で、商が大きいと四捨五入の境目で0.1円ずれる
  // （ledger.ts fillOne、corporate.ts の costOut も同じ形）。届くのは取得原価が約3億円・保有が数百万株の奇数のような規模で、
  // 初期資金1,000万円からは現実的でない。直し方の方針：整数だけで (2*cost*qty + held) / (2*held) を計算する（BigInt か、安全な範囲の確認）
  it.fails("一部の売りの取得原価の按分は、大きな額でも整数の四捨五入と一致する", () => {
    const account: Account = { cash: 0, holdings: { AAA: { qty: 3_000_001, cost: 3_001_501_001 } } };
    const { account: after } = executeSheet(account, { agentId: "x", tradingDate: "2026-11-10", committedAt: 0, orders: [{ symbol: "AAA", side: "sell", qty: 3_000_000 }] }, { AAA: 10 });
    const m = modelOf(account);
    modelExecute(m, [{ symbol: "AAA", side: "sell", qty: 3_000_000 }], { AAA: 10 });
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
async function simulate(seed: number, days = 18) {
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
  // 臨時休場にする日を先に決める（その日を権利落ち日にする公表は出さない。権利落ち日が休場になった扱いは §6.2 の訂正で、別のPR）
  const dates: string[] = [];
  for (let d = "2026-11-09"; dates.length < days; d = nextBusinessDay(d, H())) dates.push(d);
  const closedPlan = new Set(dates.slice(2, -2).filter(() => r.next() < 0.12));
  const base: Record<string, number> = Object.fromEntries(SYMBOLS.map((s) => [s, r.int(100, 80_000)]));
  const pending = new Map<string, { seq: number; orders: Order[]; date: string }>();
  let lastClose: Record<string, number> = { ...base };

  for (let D = "2026-11-09", n = 0; n < days; n++) {
    // 前の晩に確定した注文票を、始値で約定させる（臨時休場なら全件失効）
    if (closedPlan.has(D)) await add(op("market.closed", jst(D, 7), { date: D, reason: "test" }));
    const open = closedPlan.has(D) ? undefined : Object.fromEntries(SYMBOLS.map((s) => [s, r.next() < 0.08 ? null : (base[s] = randomPrice(r, base[s]!))]));
    const openSeq = open ? await add(sys("prices.open", jst(D, 9), { date: D, valuesHash: await store.put(open) })) : undefined;
    for (const [i, id] of AGENTS.entries()) {
      const p = pending.get(id);
      if (!p) continue;
      const f = await ledger.computeFills(id, p.seq, openSeq);
      await add(sys("fills.executed", jst(D, 9, 1 + i), { agentId: id, tradingDate: D, sheetSeq: p.seq, ...(openSeq ? { openSeq } : {}), ...f.payload }, openSeq ? [p.seq, openSeq] : [p.seq]));
      if (open) modelExecute(models.get(id)!, p.orders, open);
      check(id, `${D} fills ${JSON.stringify({ orders: p.orders, open })}`);
      pending.delete(id);
    }
    if (!closedPlan.has(D)) {
      lastClose = Object.fromEntries(SYMBOLS.map((s) => [s, (base[s] = randomPrice(r, base[s]!))]));
      const closeSeq = await add(sys("prices.close", jst(D, 15, 30), { date: D, valuesHash: await store.put(lastClose) }));
      // 翌営業日が権利落ち日の配当・分割を公表し、評価のあとに反映する
      const ex = nextBusinessDay(D, H());
      const divs: Dividend[] = [];
      const splits: Split[] = [];
      const ann: number[] = [];
      if (!closedPlan.has(ex)) {
        for (const symbol of SYMBOLS) {
          for (let k = r.next() < 0.2 ? r.int(1, 2) : 0; k > 0; k--) {
            const perShare = r.int(0, 1_500);
            divs.push({ symbol, exDate: ex, perShare });
            ann.push(await add(sys("corporate_action.announced", jst(D, 15, 31) + ann.length * 1000, { symbol, exDate: ex, valuesHash: await store.put({ kind: "dividend", perShare }) })));
          }
          if (r.next() < 0.15) {
            const [from, to] = r.pick(RATIOS);
            splits.push({ symbol, exDate: ex, from, to });
            ann.push(await add(sys("corporate_action.announced", jst(D, 15, 31) + ann.length * 1000, { symbol, exDate: ex, valuesHash: await store.put({ kind: "split", from, to }) })));
          }
        }
      }
      for (const [i, id] of AGENTS.entries()) {
        await add(sys("valuation.recorded", jst(D, 15, 40 + 2 * i), { agentId: id, date: D, closeSeq, ...ledger.computeValuation(id, D) }, [closeSeq]));
        const ca = await ledger.computeCorporate(id, D, ex, ann);
        await add(sys("corporate_actions.applied", jst(D, 15, 41 + 2 * i), { agentId: id, asOf: D, exDate: ex, announcedSeqs: ann, ...ca.payload }, ann));
        modelCorporate(models.get(id)!, divs, splits, lastClose);
        check(id, `${D} corporate ${JSON.stringify({ divs, splits, lastClose })}`);
      }
      for (const s of splits) base[s.symbol] = Math.max(10, Math.round((base[s.symbol]! * s.from) / s.to));
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
  return { log, store, ledger, models, closedPlan };
}

describe("追記・台帳・replay をつないだ無作為な日々（20シード×18営業日、祝日と臨時休場を含む）", () => {
  it("どの時点でも模型と一致し、保存したログを replay すると同じ口座になり、同じシードは同じログになる", async () => {
    let closures = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const a = await simulate(seed);
      closures += a.closedPlan.size;
      const replayed = await replay(a.log.events, a.store, CTX);
      for (const id of AGENTS) expect(replayed.account(id), `seed ${seed} ${id}`).toEqual(a.ledger.account(id));
      const b = await simulate(seed);
      expect(b.log.events.at(-1)!.hash, `seed ${seed}`).toBe(a.log.events.at(-1)!.hash);
    }
    expect(closures).toBeGreaterThan(0); // 臨時休場の日を少なくとも1回は通っている
  }, 120_000);
});
