// docs/EVENT_LOG.md §7 の再計算と照合を、追記の処理とつないだ架空の2日間で確かめる。
import { describe, expect, it } from "vitest";
import { EventLog, type Draft } from "../../src/events/append";
import { sealEvent } from "../../src/events/chain";
import { bodyHash } from "../../src/events/hash";
import { Ledger, replay, type ValueStore } from "../../src/events/replay";
import type { LogEvent } from "../../src/events/types";
import { totalValue } from "../../src/ledger/ledger";
import { INITIAL_CASH, type Account } from "../../src/ledger/types";

const jst = (date: string, hh: number, mm = 0) => Date.parse(`${date}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+09:00`);
const yen = (n: number) => Math.round(n * 10);
const CTX = { universe: new Set(["AAA"]), holidays: new Set<string>(), holidaysSha256: "a".repeat(64) };
const AGENTS = ["alpha", "beta"];

/** ログの外の値の置き場（テストでは乱数を固定） */
class MemoryStore implements ValueStore {
  readonly map = new Map<string, { salt: Uint8Array; value: unknown }>();
  async put(value: unknown): Promise<string> {
    const salt = new Uint8Array(16).fill(this.map.size + 1);
    const hash = await bodyHash(salt, { value });
    this.map.set(hash, { salt, value });
    return hash;
  }
  get(hash: string) {
    return this.map.get(hash);
  }
}

/** 追記の処理と台帳をつなぐ。値はログの外に置いてからイベントを書き、追記に通ったイベントを台帳にも当てる */
async function start() {
  const store = new MemoryStore();
  const ledger = new Ledger(store);
  const log = new EventLog({ ...CTX, accountOf: (id) => ledger.account(id) });
  const add = async (d: Draft) => {
    const r = await log.append(d);
    if (!r.ok) throw new Error(r.reason);
    await ledger.apply(r.event);
    return r.event.seq;
  };
  const sys = (type: Draft["type"], recordedAt: number, payload: Record<string, unknown>, refs: number[] = []): Draft => ({ type, recordedAt, actor: "system", refs, payload });
  const prices = async (type: "prices.open" | "prices.close", at: number, date: string, values: Record<string, number | null>) => add(sys(type, at, { date, valuesHash: await store.put(values) }));
  const announce = async (at: number, exDate: string, value: unknown) => add(sys("corporate_action.announced", at, { symbol: "AAA", exDate, valuesHash: await store.put(value) }));

  // alpha・beta が 11/10 の寄り付きで AAA を100株ずつ買う注文票を確定する
  const sheets: Record<string, number> = {};
  for (const [i, id] of AGENTS.entries()) {
    await add({ type: "agent.registered", recordedAt: jst("2026-11-09", 20, i), actor: "operator:owner", refs: [], payload: { agentId: id, startDate: "2026-11-10", initialCash: INITIAL_CASH } });
  }
  const runs: number[] = [];
  for (const [i, id] of AGENTS.entries()) runs.push(await add(sys("agent.run", jst("2026-11-09", 22, i), { agentId: id, purpose: "order", inputSeqs: [], ok: true })));
  for (const [i, id] of AGENTS.entries()) {
    const c = await log.commitSheet(jst("2026-11-10", 8, i), id, { tradingDate: "2026-11-10", orders: [{ symbol: "AAA", side: "buy", qty: 100 }], runSeq: runs[i]!, inputSeqs: [] });
    if (!c.ok || c.rejected) throw new Error("commit failed");
    await ledger.apply(c.event);
    sheets[id] = c.event.seq;
  }
  const fills = async (at: number, id: string, openSeq?: number) => {
    const f = await ledger.computeFills(id, sheets[id]!, openSeq);
    const refs = openSeq === undefined ? [sheets[id]!] : [sheets[id]!, openSeq];
    return add(sys("fills.executed", at, { agentId: id, tradingDate: "2026-11-10", sheetSeq: sheets[id]!, ...(openSeq === undefined ? {} : { openSeq }), ...f.payload }, refs));
  };
  const valuation = (at: number, id: string, date: string, closeSeq: number) => add(sys("valuation.recorded", at, { agentId: id, date, closeSeq, ...ledger.computeValuation(id, date) }, [closeSeq]));
  const postClose = async (at: number, id: string, announcedSeqs: number[]) => {
    const ca = await ledger.computeCorporate(id, "2026-11-10", "2026-11-11", announcedSeqs);
    return add(sys("corporate_actions.applied", at, { agentId: id, asOf: "2026-11-10", exDate: "2026-11-11", announcedSeqs, ...ca.payload }, announcedSeqs));
  };
  return { store, ledger, log, add, sys, prices, announce, fills, valuation, postClose };
}

/**
 * 11/10：始値1,000円で100株ずつ買い、終値1,100円で評価。11/11 が権利落ち日の 3株→4株 の分割を反映する。
 * alpha が分割を反映したあとに、beta の 11/10 の評価を書く（AIごとの処理が入り交じっても止まらない）
 */
async function world() {
  const w = await start();
  const open = await w.prices("prices.open", jst("2026-11-10", 9), "2026-11-10", { AAA: yen(1_000) });
  for (const [i, id] of AGENTS.entries()) await w.fills(jst("2026-11-10", 9, 1 + i), id, open);
  const close = await w.prices("prices.close", jst("2026-11-10", 15, 40), "2026-11-10", { AAA: yen(1_100) });
  const ann = await w.announce(jst("2026-11-10", 15, 41), "2026-11-11", { kind: "split", from: 3, to: 4 });
  await w.valuation(jst("2026-11-10", 15, 42), "alpha", "2026-11-10", close);
  await w.postClose(jst("2026-11-10", 15, 43), "alpha", [ann]);
  await w.valuation(jst("2026-11-10", 15, 44), "beta", "2026-11-10", close);
  await w.postClose(jst("2026-11-10", 15, 45), "beta", [ann]);
  return w;
}

async function forge(events: readonly LogEvent[], draft: Omit<LogEvent, "seq" | "schema" | "prevHash" | "hash">) {
  return [...events, await sealEvent(events.at(-1)!, draft)];
}

describe("追記の処理とつないだ再計算（§7）", () => {
  it("約定・評価・分割の中身を台帳が作り、ログを先頭から再計算すると同じ口座になる", async () => {
    const { store, ledger, log, add, sys, prices } = await world();
    // 100株 × 4/3 = 133と1/3株。1/3株を、前営業日の終値1,100円を分割に合わせた825円で現金にする（825 ÷ 3 = 275円）
    const after: Account = ledger.account("alpha");
    expect(after.holdings.AAA?.qty).toBe(133);
    expect(after.cash).toBe(INITIAL_CASH - yen(100_000) + yen(275));
    const close2 = await prices("prices.close", jst("2026-11-11", 15, 40), "2026-11-11", { AAA: yen(830) });
    const v = ledger.computeValuation("alpha", "2026-11-11");
    expect(v.positions).toEqual([{ symbol: "AAA", qty: 133, price: yen(830), closeSeq: close2 }]);
    await add(sys("valuation.recorded", jst("2026-11-11", 15, 41), { agentId: "alpha", date: "2026-11-11", closeSeq: close2, ...v }, [close2]));
    const again = await replay(log.events, store, CTX);
    for (const id of AGENTS) expect(again.account(id)).toEqual(ledger.account(id));
  });

  it("配当は保有株数×1株配当を現金に加え、再計算でも同じになる", async () => {
    const w = await start();
    const open = await w.prices("prices.open", jst("2026-11-10", 9), "2026-11-10", { AAA: yen(1_000) });
    for (const [i, id] of AGENTS.entries()) await w.fills(jst("2026-11-10", 9, 1 + i), id, open);
    const close = await w.prices("prices.close", jst("2026-11-10", 15, 40), "2026-11-10", { AAA: yen(1_100) });
    const ann = await w.announce(jst("2026-11-10", 15, 41), "2026-11-11", { kind: "dividend", perShare: yen(12.5) });
    for (const [i, id] of AGENTS.entries()) {
      await w.valuation(jst("2026-11-10", 15, 42 + 2 * i), id, "2026-11-10", close);
      await w.postClose(jst("2026-11-10", 15, 43 + 2 * i), id, [ann]);
    }
    expect(w.ledger.account("beta").cash).toBe(INITIAL_CASH - yen(100_000) + yen(1_250));
    expect((await replay(w.log.events, w.store, CTX)).account("beta")).toEqual(w.ledger.account("beta"));
  });

  it("臨時休場の日の注文票は全件失効し、口座は変わらない", async () => {
    const w = await start();
    await w.add({ type: "market.closed", recordedAt: jst("2026-11-10", 8, 40), actor: "operator:owner", refs: [], payload: { date: "2026-11-10" } });
    const f = await w.ledger.computeFills("alpha", w.log.events.find((e) => e.type === "order_sheet.committed")!.seq, undefined);
    expect(f.payload.fills).toEqual([{ symbol: "AAA", side: "buy", requestedQty: 100, qty: 0, price: null, amount: 0, status: "expired", reason: "market_closed" }]);
    expect(f.account).toEqual(w.ledger.account("alpha"));
  });

  it("その日の終値がない銘柄は、分割がなければ直近の終値で評価し、その seq を残す", async () => {
    const w = await start();
    const open = await w.prices("prices.open", jst("2026-11-10", 9), "2026-11-10", { AAA: yen(1_000) });
    for (const [i, id] of AGENTS.entries()) await w.fills(jst("2026-11-10", 9, 1 + i), id, open);
    const close = await w.prices("prices.close", jst("2026-11-10", 15, 40), "2026-11-10", { AAA: yen(1_100) });
    await w.valuation(jst("2026-11-10", 15, 41), "alpha", "2026-11-10", close);
    await w.postClose(jst("2026-11-10", 15, 42), "alpha", []);
    await w.prices("prices.close", jst("2026-11-11", 15, 40), "2026-11-11", { AAA: null });
    expect(w.ledger.computeValuation("alpha", "2026-11-11").positions).toEqual([{ symbol: "AAA", qty: 100, price: yen(1_100), closeSeq: close }]);
  });
});

describe("照合で止まるもの", () => {
  it("記録した約定・評価の中身を書き換えると、作り直したイベントが記録と合わず止まる", async () => {
    const { store, log } = await world();
    for (const type of ["fills.executed", "valuation.recorded"]) {
      const events = log.events.map((e) => (e.type === type ? ({ ...e, payload: { ...(e.payload as object), total: 1, accountHash: "f".repeat(64) } } as LogEvent) : e));
      await expect(replay(events, store, CTX)).rejects.toThrow("does not match the recorded event");
    }
  });

  it("連鎖を作り直しても、2回目の約定やAIの登録し直しは追記の検査で止まる", async () => {
    const { store, log } = await world();
    const fill = log.events.find((e) => e.type === "fills.executed")!;
    const reg = log.events.find((e) => e.type === "agent.registered")!;
    const at = log.events.at(-1)!.recordedAt + 1;
    for (const e of [fill, reg]) {
      const forged = await forge(log.events, { type: e.type, recordedAt: at, actor: e.actor, keys: e.keys, refs: e.refs, payload: e.payload });
      await expect(replay(forged, store, CTX)).rejects.toThrow(`seq ${forged.length} (${e.type})`);
    }
  });

  it("作り直した連鎖でも、偽の拒否、形の崩れた注文票、口座のハッシュの食い違いは止まる", async () => {
    const { store, log } = await world();
    const at = log.events.at(-1)!.recordedAt + 1;
    const base = { recordedAt: at, keys: [], refs: [] };
    // 停止していないAIを、停止中として拒否した記録
    const fakeReject = await forge(log.events, { ...base, type: "order_sheet.rejected", actor: "system", payload: { agentId: "alpha", tradingDate: "2026-11-11", reason: "suspended" } });
    await expect(replay(fakeReject, store, CTX)).rejects.toThrow("rejection reason suspended does not match invalid_sheet");
    const run = log.events.find((e) => e.type === "agent.run")!.seq;
    const nullOrder = await forge(log.events, { ...base, type: "order_sheet.committed", actor: "agent:alpha", keys: ["sheet:alpha:2026-11-11"], refs: [run], payload: { agentId: "alpha", tradingDate: "2026-11-11", orders: [null], runSeq: run, inputSeqs: [], holidaysSha256: CTX.holidaysSha256 } });
    await expect(replay(nullOrder, store, CTX)).rejects.toThrow("(order_sheet.committed): invalid_order");
    // 中身と口座のハッシュの両方を偽って連鎖を作り直しても、台帳の再計算と合わない
    const i = log.events.findIndex((e) => e.type === "fills.executed");
    const head = log.events.slice(0, i);
    const f = log.events[i]!;
    const tampered = await forge(head, { type: f.type, recordedAt: f.recordedAt, actor: f.actor, keys: f.keys, refs: f.refs, payload: { ...(f.payload as object), accountHash: "f".repeat(64) } });
    await expect(replay(tampered, store, CTX)).rejects.toThrow("(fills.executed): recorded");
  });

  it("祝日の一覧が記録と違えば、営業日の判定をやり直さずに止まる", async () => {
    const { store, log } = await world();
    await expect(replay(log.events, store, { ...CTX, holidaysSha256: "b".repeat(64) })).rejects.toThrow("differs from the current one");
  });

  it("ログの外の値が書き換わっていたり、無かったり、形が違えば止まる", async () => {
    const { store, log } = await world();
    const [hash, v] = [...store.map.entries()][0]!;
    store.map.set(hash, { ...v, value: { AAA: yen(1) } });
    await expect(replay(log.events, store, CTX)).rejects.toThrow("values do not match valuesHash");
    store.map.delete(hash);
    await expect(replay(log.events, store, CTX)).rejects.toThrow("values are not available");
    const salt = new Uint8Array(16);
    const bad = await bodyHash(salt, { value: { AAA: "1000" } });
    store.map.set(bad, { salt, value: { AAA: "1000" } });
    const ledger = new Ledger(store);
    const e = (seq: number, type: LogEvent["type"], payload: Record<string, unknown>): LogEvent => ({ seq, type, payload, schema: 1, recordedAt: seq, actor: "system", keys: [], refs: [], prevHash: "", hash: "" });
    await ledger.apply(e(1, "agent.registered", { agentId: "alpha", initialCash: INITIAL_CASH }));
    await expect(ledger.apply(e(2, "prices.close", { date: "2026-11-10", valuesHash: bad }))).rejects.toThrow("wrong shape");
    // 一度失敗した台帳は、それ以降を受け付けない
    await expect(ledger.apply(e(3, "prices.close", { date: "2026-11-11", valuesHash: bad }))).rejects.toThrow("ledger stopped at seq 2");
    expect(() => ledger.account("alpha")).toThrow("ledger stopped at seq 2");
  });

  it("権利落ち日の公表を引け後処理に渡さなければ、追記で拒む", async () => {
    const w = await start();
    const open = await w.prices("prices.open", jst("2026-11-10", 9), "2026-11-10", { AAA: yen(1_000) });
    await w.fills(jst("2026-11-10", 9, 1), "alpha", open);
    const close = await w.prices("prices.close", jst("2026-11-10", 15, 40), "2026-11-10", { AAA: yen(1_100) });
    await w.announce(jst("2026-11-10", 15, 41), "2026-11-11", { kind: "dividend", perShare: yen(10) });
    await w.valuation(jst("2026-11-10", 15, 42), "alpha", "2026-11-10", close);
    await expect(w.postClose(jst("2026-11-10", 15, 43), "alpha", [])).rejects.toThrow("announcedSeqs must include every announcement with exDate 2026-11-11");
  });

  it("直近の終値が、このAIが反映した分割より前の日のものなら、分割後の株数を評価せずに止める", async () => {
    const { ledger, prices } = await world();
    await prices("prices.close", jst("2026-11-11", 15, 40), "2026-11-11", { AAA: null });
    expect(() => ledger.computeValuation("alpha", "2026-11-11")).toThrow("latest close of AAA is before its split on 2026-11-11");
  });

  it("翌日の終値が先に記録されていても、評価にはその日までの終値を使う", async () => {
    const store = new MemoryStore();
    const ledger = new Ledger(store);
    const event = async (seq: number, type: LogEvent["type"], payload: Record<string, unknown>) => ledger.apply({ seq, type, payload, schema: 1, recordedAt: seq, actor: "system", keys: [], refs: [], prevHash: "", hash: "" });
    await event(1, "agent.registered", { agentId: "alpha", initialCash: INITIAL_CASH });
    await event(2, "prices.close", { date: "2026-11-10", valuesHash: await store.put({ AAA: yen(500) }) });
    await event(3, "prices.close", { date: "2026-11-11", valuesHash: await store.put({ AAA: yen(700) }) });
    expect(ledger.computeValuation("alpha", "2026-11-10")).toEqual({ cash: INITIAL_CASH, positions: [], total: INITIAL_CASH });
  });
});

describe("時価評価の終値（§6）", () => {
  it("null・負・小数の終値や、Object.prototype と同名の銘柄を0として足さない", () => {
    const acc: Account = { cash: 0, holdings: { AAA: { qty: 100, cost: 0 } } };
    expect(() => totalValue(acc, { AAA: null as unknown as number })).toThrow("missing close for AAA");
    for (const c of [-1, 0, 1.5, Number.NaN]) expect(() => totalValue(acc, { AAA: c })).toThrow("invalid close for AAA");
    expect(() => totalValue({ cash: 0, holdings: { toString: { qty: 1, cost: 0 } } }, {})).toThrow("missing close for toString");
  });
});
