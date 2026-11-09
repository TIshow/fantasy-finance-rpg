// 企業行動の公表（corporate_action.announced）の一意キーと、記録できる時刻（docs/EVENT_LOG.md §3・§3.3。#67）。
// キーは announce:<銘柄>:<種類>:<権利落ち日>。権利落ち日の前営業日の引け後処理を済ませたAIがいれば、その公表は書けない。
import { describe, expect, it } from "vitest";
import { EventLog, type Draft } from "../../src/events/append";
import { bodyHash } from "../../src/events/hash";
import { Ledger, announcementValueProblem, replay, type ValueStore } from "../../src/events/replay";
import type { HolidayTable } from "../../src/holidays/index";
import { INITIAL_CASH } from "../../src/ledger/types";

const jst = (date: string, hh: number, mm = 0) => Date.parse(`${date}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+09:00`);
const SHA = "f".repeat(64);
const TABLE: HolidayTable = { firstYear: 2026, lastYear: 2027, sourceSha256: "0".repeat(64), contentSha256: SHA, dates: new Set() };
const CTX = { holidayTables: new Map([[SHA, TABLE]]) };
const [D, T, NEXT] = ["2026-11-10", "2026-11-11", "2026-11-12"];
const DIV = { kind: "dividend", perShare: 500 };

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

/** alpha が D の寄り付きで AAA を100株買い、D の評価まで済ませたログ（引け後処理はまだ） */
async function start() {
  const store = new MemoryStore();
  const ledger = new Ledger(store);
  const log = new EventLog({ ...CTX, accountOf: (id) => ledger.account(id) });
  const append = async (d: Draft) => {
    const r = await log.append(d);
    if (r.ok) await ledger.apply(r.event);
    return r;
  };
  const add = async (d: Draft) => {
    const r = await append(d);
    if (!r.ok) throw new Error(`${d.type}: ${r.reason}`);
    return r.event.seq;
  };
  const sys = (type: Draft["type"], recordedAt: number, payload: Record<string, unknown>, refs: number[] = []): Draft => ({ type, recordedAt, actor: "system", refs, payload });
  const op = (type: Draft["type"], recordedAt: number, payload: Record<string, unknown>): Draft => ({ type, recordedAt, actor: "operator:owner", refs: [], payload });
  const announce = async (at: number, exDate: string, value: { kind: string; [k: string]: unknown }, kind = value.kind, symbol = "AAA") => append(sys("corporate_action.announced", at, { symbol, kind, exDate, valuesHash: await store.put(value) }));
  const postClose = async (at: number, asOf: string, exDate: string, announcedSeqs: number[], closedSeq?: number) => {
    const ca = await ledger.computeCorporate("alpha", asOf, exDate, announcedSeqs);
    const extra = closedSeq === undefined ? {} : { closedSeq };
    return add(sys("corporate_actions.applied", at, { agentId: "alpha", asOf, exDate, announcedSeqs, ...extra, ...ca.payload }, closedSeq === undefined ? announcedSeqs : [...announcedSeqs, closedSeq]));
  };

  await add(op("holidays.adopted", 0, { holidaysSha256: SHA }));
  await add(op("universe.set", 0, { symbols: ["AAA"] }));
  await add(op("agent.registered", jst("2026-11-09", 20), { agentId: "alpha", startDate: D, initialCash: INITIAL_CASH }));
  const run = await add(sys("agent.run", jst("2026-11-09", 21), { agentId: "alpha", purpose: "order", inputSeqs: [], ok: true }));
  const c = await log.commitSheet(jst("2026-11-09", 22), "alpha", { tradingDate: D, orders: [{ symbol: "AAA", side: "buy", qty: 100 }], runSeq: run, inputSeqs: [] });
  if (!c.ok || c.rejected) throw new Error("commit failed");
  await ledger.apply(c.event);
  const open = await add(sys("prices.open", jst(D, 9), { date: D, valuesHash: await store.put({ AAA: 10_000 }) }));
  const f = await ledger.computeFills("alpha", c.event.seq, open);
  await add(sys("fills.executed", jst(D, 9, 1), { agentId: "alpha", tradingDate: D, sheetSeq: c.event.seq, openSeq: open, ...f.payload }, [c.event.seq, open]));
  const close = await add(sys("prices.close", jst(D, 15, 30), { date: D, valuesHash: await store.put({ AAA: 11_000 }) }));
  await add(sys("valuation.recorded", jst(D, 15, 40), { agentId: "alpha", date: D, closeSeq: close, ...ledger.computeValuation("alpha", D) }, [close]));
  return { store, ledger, log, append, add, op, announce, postClose };
}

describe("企業行動の公表の一意キー（§3）", () => {
  it("同じ銘柄・種類・権利落ち日の2回目は拒まれ、配当は1回分だけ反映される。種類が違えば同じ日でも書ける", async () => {
    const w = await start();
    const first = await w.announce(jst(D, 15, 41), T, DIV);
    expect(first.ok && first.event.keys).toEqual([`announce:AAA:dividend:${T}`]);
    const again = await w.announce(jst(D, 15, 42), T, { kind: "dividend", perShare: 700 });
    expect(again.ok).toBe(false);
    const split = await w.announce(jst(D, 15, 43), T, { kind: "split", from: 1, to: 2 });
    expect(split.ok).toBe(true);
    const cash = w.ledger.account("alpha").cash;
    await w.postClose(jst(D, 15, 50), D, T, [first.ok ? first.event.seq : 0, split.ok ? split.event.seq : 0]);
    expect(w.ledger.account("alpha").cash - cash).toBe(100 * 500);
    expect(w.ledger.account("alpha").holdings.AAA?.qty).toBe(200);
    expect((await replay(w.log.events, w.store, CTX)).account("alpha")).toEqual(w.ledger.account("alpha"));
  });

  it("種類・銘柄・権利落ち日の形が違う、休場日、祝日の一覧の外の権利落ち日の公表は書けない", async () => {
    const w = await start();
    const reasonOf = async (r: ReturnType<typeof w.announce>) => {
      const x = await r;
      return x.ok ? "ok" : x.reason;
    };
    expect(await reasonOf(w.announce(jst(D, 15, 41), T, DIV, "bonus"))).toBe("invalid kind");
    expect(await reasonOf(w.announce(jst(D, 15, 41), T, DIV, ""))).toBe("invalid kind");
    expect(await reasonOf(w.announce(jst(D, 15, 41), T, DIV, "dividend", "aaa"))).toBe("invalid symbol");
    expect(await reasonOf(w.announce(jst(D, 15, 41), "2026-11-31", DIV))).toBe("invalid exDate");
    // 切り替えの日（D-047）より前の土曜は休み。切り替えより前で一覧の外の日は判定できない
    expect(await reasonOf(w.announce(jst(D, 15, 41), "2026-11-07", DIV))).toBe("exDate must be a business day");
    expect(await reasonOf(w.announce(jst(D, 15, 41), "2026-01-05", DIV))).toBe("exDate is outside the adopted holiday table");
    // 切り替えより後は毎日が取引日で、祝日の一覧を引かない（土曜や一覧の外の年でも書ける）
    expect(await reasonOf(w.announce(jst(D, 15, 41), "2026-11-14", DIV))).toBe("ok");
    expect(await reasonOf(w.announce(jst(D, 15, 41), "2028-03-30", DIV))).toBe("ok");
  });

  it("種類がログの外の値と違う公表は、台帳が当てるときに止まる（書く前の検査にも同じ関数を使える）", async () => {
    const w = await start();
    await expect(w.announce(jst(D, 15, 41), T, DIV, "split")).rejects.toThrow("does not match the values");
    expect(announcementValueProblem({ kind: "split" }, DIV)).toBe("announced kind split does not match the values (dividend)");
    expect(announcementValueProblem({ kind: "dividend" }, { kind: "dividend", perShare: -1 })).toBe("values have the wrong shape for corporate_action.announced");
    expect(announcementValueProblem({ kind: "dividend" }, DIV)).toBeNull();
  });
});

describe("公表を記録できる時刻（§3.3）", () => {
  it("権利落ち日の前営業日の引け後処理を済ませたAIがいれば、その公表は拒まれる。その次の日の公表は書ける", async () => {
    const w = await start();
    await w.postClose(jst(D, 15, 50), D, T, []);
    const late = await w.announce(jst(D, 16), T, DIV);
    expect(!late.ok && late.reason).toBe(`agent alpha already finished the post-close of ${D}`);
    expect((await w.announce(jst(D, 16, 1), NEXT, DIV)).ok).toBe(true);
  });

  it("権利落ち日以後に始めるAIは、まだ引け後処理をしていないので、その公表を拒ませない", async () => {
    const w = await start();
    // D の締めのあとに登録した beta（開始日 T、asOf は D）。alpha は D の引け後処理をまだしていない
    await w.add(w.op("agent.registered", jst(D, 15, 45), { agentId: "beta", startDate: T, initialCash: INITIAL_CASH }));
    expect((await w.announce(jst(D, 15, 46), T, DIV)).ok).toBe(true);
  });

  it("臨時休場の追加の処理を待つあいだでも、休場の日を権利落ち日にした公表は書けない", async () => {
    const w = await start();
    await w.postClose(jst(D, 15, 50), D, T, []);
    await w.add(w.op("market.closed", jst(D, 16), { date: T, reason: "test" }));
    const r = await w.announce(jst(D, 16, 1), T, DIV);
    expect(!r.ok && r.reason).toBe("exDate must be a business day");
  });

  it("臨時休場の追加の処理をまだ書けるあいだは、ずれた権利落ち日の公表を書けて、追加の処理で反映する。書いたあとは拒まれる", async () => {
    const w = await start();
    await w.postClose(jst(D, 15, 50), D, T, []);
    const closed = await w.add(w.op("market.closed", jst(D, 16), { date: T, reason: "test" }));
    const ann = await w.announce(jst(D, 16, 1), NEXT, DIV);
    if (!ann.ok) throw new Error(ann.reason);
    const cash = w.ledger.account("alpha").cash;
    await w.postClose(jst(D, 16, 2), D, NEXT, [ann.event.seq], closed);
    expect(w.ledger.account("alpha").cash - cash).toBe(100 * 500);
    expect((await w.announce(jst(D, 16, 3), NEXT, { kind: "split", from: 1, to: 2 })).ok).toBe(false);
  });
});
