// docs/EVENT_LOG.md §7 の再計算と照合を、追記の処理とつないだ架空の2日間で確かめる。
import { describe, expect, it } from "vitest";
import { EventLog, type Draft } from "../../src/events/append";
import { bodyHash } from "../../src/events/hash";
import { Ledger, replay, type ValueStore } from "../../src/events/replay";
import type { LogEvent } from "../../src/events/types";
import { totalValue } from "../../src/ledger/ledger";
import { INITIAL_CASH, type Account } from "../../src/ledger/types";

const jst = (date: string, hh: number, mm = 0) => Date.parse(`${date}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+09:00`);
const yen = (n: number) => Math.round(n * 10);

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

/** 追記の処理と台帳をつなぐ。追記に通ったイベントを台帳にも当て、追記の検査には台帳の口座を渡す */
async function world() {
  const store = new MemoryStore();
  const ledger = new Ledger(store);
  const log = new EventLog({ universe: new Set(["AAA"]), holidays: new Set(), holidaysSha256: "a".repeat(64), accountOf: (id) => ledger.account(id) });
  const add = async (d: Draft) => {
    const r = await log.append(d);
    if (!r.ok) throw new Error(r.reason);
    await ledger.apply(r.event);
    return r.event.seq;
  };
  const sys = (type: Draft["type"], recordedAt: number, payload: Record<string, unknown>, refs: number[] = []): Draft => ({ type, recordedAt, actor: "system", refs, payload });
  const prices = async (type: "prices.open" | "prices.close", at: number, date: string, values: Record<string, number | null>) => add(sys(type, at, { date, valuesHash: await store.put(values) }));

  await add({ type: "agent.registered", recordedAt: jst("2026-11-09", 20), actor: "operator:owner", refs: [], payload: { agentId: "alpha", startDate: "2026-11-10", initialCash: INITIAL_CASH } });
  const run = await add(sys("agent.run", jst("2026-11-09", 22), { agentId: "alpha", purpose: "order", inputSeqs: [], ok: true }));
  const c = await log.commitSheet(jst("2026-11-10", 8), "alpha", { tradingDate: "2026-11-10", orders: [{ symbol: "AAA", side: "buy", qty: 100 }], runSeq: run, inputSeqs: [] });
  if (!c.ok || c.rejected) throw new Error("commit failed");
  await ledger.apply(c.event);
  const sheetSeq = c.event.seq;

  // 11/10：始値1,000円で100株買い、終値1,100円で評価。11/11 が権利落ち日の 3株→4株 の分割を反映する
  const open = await prices("prices.open", jst("2026-11-10", 9), "2026-11-10", { AAA: yen(1_000) });
  const f = await ledger.computeFills("alpha", sheetSeq, open);
  await add(sys("fills.executed", jst("2026-11-10", 9, 1), { agentId: "alpha", tradingDate: "2026-11-10", sheetSeq, openSeq: open, ...f.payload }, [sheetSeq, open]));
  const close = await prices("prices.close", jst("2026-11-10", 15, 40), "2026-11-10", { AAA: yen(1_100) });
  await add(sys("valuation.recorded", jst("2026-11-10", 15, 41), { agentId: "alpha", date: "2026-11-10", closeSeq: close, ...ledger.computeValuation("alpha", "2026-11-10") }, [close]));
  const ann = await add(sys("corporate_action.announced", jst("2026-11-10", 15, 42), { symbol: "AAA", exDate: "2026-11-11", valuesHash: await store.put({ kind: "split", from: 3, to: 4 }) }));
  const ca = await ledger.computeCorporate("alpha", "2026-11-10", "2026-11-11", [ann]);
  await add(sys("corporate_actions.applied", jst("2026-11-10", 15, 43), { agentId: "alpha", asOf: "2026-11-10", exDate: "2026-11-11", announcedSeqs: [ann], ...ca.payload }, [ann]));
  return { store, ledger, log, add, sys, prices };
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
    const again = await replay(log.events, store);
    expect(again.account("alpha")).toEqual(ledger.account("alpha"));
  });

  it("記録した約定の中身を書き換えると、再計算で食い違いとして止まる", async () => {
    const { store, log } = await world();
    const events = log.events.map((e) => (e.type === "fills.executed" ? ({ ...e, payload: { ...(e.payload as object), accountHash: "f".repeat(64) } } as LogEvent) : e));
    await expect(replay(events, store)).rejects.toThrow("fills.executed): recorded");
  });

  it("ログの外の値が書き換わっていたり、無かったりすれば止まる", async () => {
    const { store, log } = await world();
    const [hash, v] = [...store.map.entries()][0]!;
    store.map.set(hash, { ...v, value: { AAA: yen(1) } });
    await expect(replay(log.events, store)).rejects.toThrow("values do not match valuesHash");
    store.map.delete(hash);
    await expect(replay(log.events, store)).rejects.toThrow("values are not available");
  });

  it("直近の終値が分割より前の日のものなら、分割後の株数を評価せずに止める", async () => {
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
