// 架空の市場の毎日の取引（D-047）と、判断の受け付けの時間（#228 の lead の決定）を、追記の検査で確かめる。
// 取引日 D の注文票は、前の取引日の引け（16:30）のあとから D の締め（8:30）の前まで確定できる。元の判断（agent.run）も、引けのあとに記録したものだけ。
import { describe, expect, it } from "vitest";
import { EventLog, type Draft } from "../../src/events/append";
import type { HolidayTable } from "../../src/holidays/index";
import { newAccount } from "../../src/ledger/ledger";
import { INITIAL_CASH, type Order } from "../../src/ledger/types";

const jst = (date: string, hh: number, mm = 0) => Date.parse(`${date}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+09:00`);
const SHA = "a".repeat(64);
const TABLE: HolidayTable = { firstYear: 2026, lastYear: 2027, sourceSha256: "0".repeat(64), contentSha256: SHA, dates: new Set(["2026-11-23"]) };
const CTX = { holidayTables: new Map([[SHA, TABLE]]), accountOf: () => newAccount() };
const buy: Order[] = [{ symbol: "AAA", side: "buy", qty: 100 }];
const [FRI, SAT, SUN] = ["2026-11-13", "2026-11-14", "2026-11-15"];

/** 木曜（11/12）の夜に登録し、金曜（11/13）から売買するAI */
async function start() {
  const log = new EventLog(CTX);
  const add = async (d: Draft) => {
    const r = await log.append(d);
    if (!r.ok) throw new Error(`${d.type}: ${r.reason}`);
    return r.event.seq;
  };
  const sys = (type: Draft["type"], recordedAt: number, payload: Record<string, unknown>, refs: number[] = []): Draft => ({ type, recordedAt, actor: "system", refs, payload });
  const op = (type: Draft["type"], recordedAt: number, payload: Record<string, unknown>): Draft => ({ type, recordedAt, actor: "operator:owner", refs: [], payload });
  const run = (at: number) => add(sys("agent.run", at, { agentId: "alpha", purpose: "order", inputSeqs: [], ok: true }));
  const commit = (at: number, tradingDate: string, runSeq: number) => log.commitSheet(at, "alpha", { tradingDate, orders: buy, runSeq, inputSeqs: [] });
  /** date の始値と約定 */
  const morning = async (date: string, sheet: number) => {
    const open = await add(sys("prices.open", jst(date, 9, 5), { date }));
    await add(sys("fills.executed", jst(date, 9, 6), { agentId: "alpha", tradingDate: date, sheetSeq: sheet, openSeq: open }, [sheet, open]));
  };
  /** date の終値・評価・引け後処理（権利落ち日は next） */
  const evening = async (date: string, next: string) => {
    const close = await add(sys("prices.close", jst(date, 15, 40), { date }));
    await add(sys("valuation.recorded", jst(date, 15, 41), { agentId: "alpha", date, closeSeq: close }, [close]));
    await add(sys("corporate_actions.applied", jst(date, 15, 42), { agentId: "alpha", asOf: date, exDate: next, announcedSeqs: [] }));
  };
  await add(op("holidays.adopted", 0, { holidaysSha256: SHA }));
  await add(op("universe.set", 0, { symbols: ["AAA"] }));
  await add(op("agent.registered", jst("2026-11-12", 20), { agentId: "alpha", startDate: FRI, initialCash: INITIAL_CASH }));
  const first = await commit(jst("2026-11-12", 21), FRI, await run(jst("2026-11-12", 20, 30)));
  if (!first.ok || first.rejected) throw new Error("first commit failed");
  return { log, add, sys, run, commit, morning, evening, first: first.event.seq };
}

describe("毎日の取引と、判断の受け付けの時間", () => {
  it("前の取引日の 12:00 の確定は拒み、17:50 の確定は受け付ける。土曜・日曜の取引日も同じ流れで進み、照合を通る", async () => {
    const w = await start();
    await w.morning(FRI, w.first);
    // 金曜の締めと引けの間（12:00）の、土曜の注文票：受け付けの前
    const noonRun = await w.run(jst(FRI, 11, 59));
    const noon = await w.commit(jst(FRI, 12), SAT, noonRun);
    expect(noon.ok && noon.rejected).toBe("wrong_trading_date");
    await w.evening(FRI, SAT);
    // 引けの1ミリ秒前は拒む
    expect((await w.commit(jst(FRI, 16, 30) - 1, SAT, await w.run(jst(FRI, 16, 30) - 2))).rejected).toBe("wrong_trading_date");
    // 引けより前に記録した判断は、引けのあとの確定でも使えない
    const stale = await w.commit(jst(FRI, 17, 49), SAT, noonRun);
    expect(stale.ok && stale.rejected).toBe("invalid_sheet");
    // 17:50 の確定（土曜の取引日）は受け付ける
    const sat = await w.commit(jst(FRI, 17, 50), SAT, await w.run(jst(FRI, 17, 49)));
    expect(sat.ok && sat.event.type).toBe("order_sheet.committed");
    if (!sat.ok) throw new Error("commit failed");
    await w.morning(SAT, sat.event.seq);
    await w.evening(SAT, SUN);
    // 日曜の取引日も、土曜の夜に確定できる
    const sun = await w.commit(jst(SAT, 23, 51), SUN, await w.run(jst(SAT, 23, 50)));
    expect(sun.ok && sun.event.type).toBe("order_sheet.committed");
    if (!sun.ok) throw new Error("commit failed");
    await w.morning(SUN, sun.event.seq);
    await w.evening(SUN, "2026-11-16");

    const again = new EventLog(CTX);
    for (const e of w.log.events) expect(await again.admit(e)).toBeNull();
  });

  it("締め（8:30）の直前まで受け付け、締めのあとは拒む（遅れた実行が夜に動いても、締めの前なら間に合う）", async () => {
    const w = await start();
    await w.morning(FRI, w.first);
    await w.evening(FRI, SAT);
    const run = await w.run(jst(SAT, 4, 50));
    const late = await w.commit(jst(SAT, 8, 30) - 1, SAT, run);
    expect(late.ok && late.event.type).toBe("order_sheet.committed");
    expect((await w.commit(jst(SAT, 8, 30), SAT, run)).rejected).toBe("after_cutoff");
  });
});
