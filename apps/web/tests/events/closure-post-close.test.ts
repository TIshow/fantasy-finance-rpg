// 臨時休場のあとの追加の引け後処理（docs/EVENT_LOG.md §3.3。#71）。
// D の引け後処理のあとで D の翌営業日 T を臨時休場にすると、権利落ち日が T の翌営業日にずれた公表を、
// 追加の corporate_actions.applied（キー post_close:<id>:<D>:<休場のseq>）で1回だけ反映する。翌営業日の注文票と評価より前に書く。
import { describe, expect, it } from "vitest";
import { EventLog, type Draft } from "../../src/events/append";
import { bodyHash } from "../../src/events/hash";
import { Ledger, replay, type ValueStore } from "../../src/events/replay";
import type { HolidayTable } from "../../src/holidays/index";
import { INITIAL_CASH, type Order } from "../../src/ledger/types";

const jst = (date: string, hh: number, mm = 0) => Date.parse(`${date}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+09:00`);
const SHA = "d".repeat(64);
const TABLE: HolidayTable = { firstYear: 2026, lastYear: 2027, sourceSha256: "0".repeat(64), contentSha256: SHA, dates: new Set() };
const [D, T, NEXT] = ["2026-11-10", "2026-11-11", "2026-11-12"];
/** T を祝日にした一覧 */
const HOLIDAY_T = "e".repeat(64);
const CTX = { holidayTables: new Map([[SHA, TABLE], [HOLIDAY_T, { ...TABLE, contentSha256: HOLIDAY_T, dates: new Set([T]) }]]) };

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

/** alpha が D の寄り付きで AAA を100株買い、D の評価まで済ませたログ。引け後処理を書くかは呼び出し側が決める */
async function start(holidays = SHA) {
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
  const commit = async (at: number, tradingDate: string) => {
    const run = await add(sys("agent.run", at - 1000, { agentId: "alpha", purpose: "order", inputSeqs: [], ok: true }));
    const c = await log.commitSheet(at, "alpha", { tradingDate, orders: [{ symbol: "AAA", side: "buy", qty: 100 }], runSeq: run, inputSeqs: [] });
    if (c.ok) await ledger.apply(c.event);
    return c;
  };
  /** asOf の引け後処理（closedSeq があれば臨時休場の追加分） */
  const postClose = async (at: number, asOf: string, exDate: string, announcedSeqs: number[], closedSeq?: number) => {
    const ca = await ledger.computeCorporate("alpha", asOf, exDate, announcedSeqs);
    const extra = closedSeq === undefined ? {} : { closedSeq };
    return append(sys("corporate_actions.applied", at, { agentId: "alpha", asOf, exDate, announcedSeqs, ...extra, ...ca.payload }, closedSeq === undefined ? announcedSeqs : [...announcedSeqs, closedSeq]));
  };

  await add(op("holidays.adopted", 0, { holidaysSha256: holidays }));
  await add(op("universe.set", 0, { symbols: ["AAA"] }));
  await add(op("agent.registered", jst("2026-11-09", 20), { agentId: "alpha", startDate: D, initialCash: INITIAL_CASH }));
  const sheet = await commit(jst(D, 8), D);
  if (!sheet.ok) throw new Error("commit failed");
  const open = await add(sys("prices.open", jst(D, 9), { date: D, valuesHash: await store.put({ AAA: 10_000 }) }));
  const f = await ledger.computeFills("alpha", sheet.event.seq, open);
  await add(sys("fills.executed", jst(D, 9, 1), { agentId: "alpha", tradingDate: D, sheetSeq: sheet.event.seq, openSeq: open, ...f.payload }, [sheet.event.seq, open]));
  const close = await add(sys("prices.close", jst(D, 15, 30), { date: D, valuesHash: await store.put({ AAA: 11_000 }) }));
  await add(sys("valuation.recorded", jst(D, 15, 40), { agentId: "alpha", date: D, closeSeq: close, ...ledger.computeValuation("alpha", D) }, [close]));
  /** T の翌営業日（NEXT）が権利落ち日の配当（1株50円） */
  const announce = async (at: number) => add(sys("corporate_action.announced", at, { symbol: "AAA", kind: "dividend", exDate: NEXT, valuesHash: await store.put({ kind: "dividend", perShare: 500 }) }));
  const closeMarket = (at: number) => add(op("market.closed", at, { date: T, reason: "test" }));
  return { store, ledger, log, append, add, sys, commit, postClose, announce, closeMarket };
}

describe("臨時休場のあとの追加の引け後処理（§3.3）", () => {
  it("D の引け後処理のあとに T を休場にすると、NEXT が権利落ち日の公表を追加の処理で1回だけ反映し、replay でも同じ口座になる", async () => {
    const w = await start();
    expect((await w.postClose(jst(D, 15, 41), D, T, [])).ok).toBe(true);
    const ann = await w.announce(jst(D, 16));
    const closed = await w.closeMarket(jst(D, 17));
    const cashBefore = w.ledger.account("alpha").cash;

    // 追加の処理より前には、NEXT の注文票も評価も書けない
    const early = await w.commit(jst(D, 20), NEXT);
    expect(early.ok && early.rejected).toBe("account_not_ready");
    // 読めない注文でも同じ（validateSheet の後の検査で拒む。照合でも、注文によらずに account_not_ready を出し直せる）
    const run = await w.add(w.sys("agent.run", jst(D, 20, 1), { agentId: "alpha", purpose: "order", inputSeqs: [], ok: true }));
    const unread = await w.log.commitSheet(jst(D, 20, 2), "alpha", { tradingDate: NEXT, orders: [{ symbol: "AAA", side: "buy", qty: 100, memo: 0.5 }] as unknown as Order[], runSeq: run, inputSeqs: [] });
    expect(unread.ok && [unread.rejected, (unread.event.payload as Record<string, unknown>).ordersUnreadable]).toEqual(["account_not_ready", true]);
    if (unread.ok) await w.ledger.apply(unread.event);

    const extra = await w.postClose(jst(D, 21), D, NEXT, [ann], closed);
    expect(extra.ok && extra.event.keys).toEqual([`post_close:alpha:${D}:${closed}`, `ca:alpha:${ann}`]);
    expect(w.ledger.account("alpha").cash - cashBefore).toBe(100 * 500);
    // 2回目は書けない（同じ休場・同じ公表）
    expect((await w.postClose(jst(D, 21, 1), D, NEXT, [ann], closed)).ok).toBe(false);

    const late = await w.commit(jst(D, 22), NEXT);
    expect(late.ok && late.event.type).toBe("order_sheet.committed");
    const again = await replay(w.log.events, w.store, CTX);
    expect(again.account("alpha")).toEqual(w.ledger.account("alpha"));
  });

  it("T の注文票が約定待ちのまま T の朝に休場：全件失効のあとに追加の処理、続けて NEXT も休場なら新しい休場の seq で書く", async () => {
    const w = await start();
    await w.postClose(jst(D, 15, 41), D, T, []);
    const ann = await w.announce(jst(D, 16));
    const sheetT = await w.commit(jst(D, 20), T);
    if (!sheetT.ok) throw new Error("commit failed");
    const closed = await w.closeMarket(jst(T, 7));
    // 約定待ちのあいだは、追加の処理を書けない
    expect((await w.postClose(jst(T, 7, 1), D, NEXT, [ann], closed)).ok).toBe(false);
    const f = await w.ledger.computeFills("alpha", sheetT.event.seq, undefined);
    await w.add(w.sys("fills.executed", jst(T, 7, 2), { agentId: "alpha", tradingDate: T, sheetSeq: sheetT.event.seq, ...f.payload }, [sheetT.event.seq]));
    expect((await w.postClose(jst(T, 7, 3), D, NEXT, [ann], closed)).ok).toBe(true);

    // NEXT も休場にすると、権利落ち日は 11/13 にずれる。新しい休場の seq でだけ書ける
    const closed2 = await w.add({ type: "market.closed", recordedAt: jst(T, 8), actor: "operator:owner", refs: [], payload: { date: NEXT, reason: "test" } });
    expect((await w.postClose(jst(T, 8, 1), D, "2026-11-13", [], closed)).ok).toBe(false);
    expect((await w.postClose(jst(T, 8, 2), D, "2026-11-13", [], closed2)).ok).toBe(true);
    const again = await replay(w.log.events, w.store, CTX);
    expect(again.account("alpha")).toEqual(w.ledger.account("alpha"));
  });

  it("もともと休みの日（祝日）を休場にしても、追加の処理は要らず、翌営業日の注文票を確定できる", async () => {
    // T を祝日にした一覧。D の翌営業日は NEXT で、NEXT が権利落ち日の公表は通常の引け後処理で反映済み
    const w = await start(HOLIDAY_T);
    const ann = await w.announce(jst(D, 15, 41));
    expect((await w.postClose(jst(D, 15, 42), D, NEXT, [ann])).ok).toBe(true);
    const closed = await w.closeMarket(jst(D, 17));
    expect((await w.postClose(jst(D, 18), D, NEXT, [], closed)).ok).toBe(false);
    const c = await w.commit(jst(D, 20), NEXT);
    expect(c.ok && c.event.type).toBe("order_sheet.committed");
  });

  it("反映する公表がなければ、追加の処理は書かなくても次へ進め、書くなら空で書ける", async () => {
    const w = await start();
    await w.postClose(jst(D, 15, 41), D, T, []);
    const closed = await w.closeMarket(jst(D, 17));
    expect((await w.postClose(jst(D, 18), D, NEXT, [], closed)).ok).toBe(true);
    const c = await w.commit(jst(D, 20), NEXT);
    expect(c.ok && c.event.type).toBe("order_sheet.committed");
  });

  it("休場がない日、休場の前に D の引け後処理が済んでいない日、別の休場の seq、次の注文票のあとには、追加の処理を書けない", async () => {
    const none = await start();
    await none.postClose(jst(D, 15, 41), D, T, []);
    const ann = await none.announce(jst(D, 16));
    const fakeClosed = ann; // 休場ではないイベント
    expect((await none.postClose(jst(D, 17), D, T, [], fakeClosed)).ok).toBe(false);

    // D の引け後処理の前に休場にしたら、通常の引け後処理が権利落ち日 NEXT の公表を渡す
    const early = await start();
    const ann2 = await early.announce(jst(D, 15, 45));
    const closed2 = await early.closeMarket(jst(D, 15, 46));
    expect((await early.postClose(jst(D, 15, 50), D, NEXT, [ann2], closed2)).ok).toBe(false);
    expect((await early.postClose(jst(D, 15, 51), D, NEXT, [ann2])).ok).toBe(true);

    // 次の注文票を確定したあとは、もう書けない（翌営業日の注文票より前に書く）
    const after = await start();
    await after.postClose(jst(D, 15, 41), D, T, []);
    const closed3 = await after.closeMarket(jst(D, 17));
    await after.commit(jst(D, 20), NEXT);
    expect((await after.postClose(jst(D, 21), D, NEXT, [], closed3)).ok).toBe(false);
  });
});
