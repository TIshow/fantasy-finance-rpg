// 架空の市場の毎日の取引（D-047）と、判断の受け付けの時間（#228 の lead の決定）を、追記の検査で確かめる。
// 取引日 D（11/10 以後）の注文票は、前の取引日の引け（16:30）のあとから D の締め（8:30）の前まで確定できる。
// 元の判断（agent.run）と LLM の依頼も、引けのあとに記録したものだけ。
import { describe, expect, it } from "vitest";
import { EventLog, type Draft } from "../../src/events/append";
import type { HolidayTable } from "../../src/holidays/index";
import { newAccount } from "../../src/ledger/ledger";
import { INITIAL_CASH, type Order } from "../../src/ledger/types";

const jst = (date: string, hh: number, mm = 0) => Date.parse(`${date}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+09:00`);
const SHA = "a".repeat(64);
const FIXED = "e".repeat(64);
const TABLE: HolidayTable = { firstYear: 2026, lastYear: 2027, sourceSha256: "0".repeat(64), contentSha256: SHA, dates: new Set(["2026-11-03", "2026-11-23"]) };
/** 11/14（土）を祝日に足した一覧（11/9 以後の祝日の直し） */
const TABLE_FIXED: HolidayTable = { ...TABLE, contentSha256: FIXED, dates: new Set(["2026-11-03", "2026-11-14", "2026-11-23"]) };
/** 11/3 を祝日から外した一覧（11/9 より前の祝日の直し） */
const TABLE_OLD_FIX: HolidayTable = { ...TABLE, contentSha256: "f".repeat(64), dates: new Set(["2026-11-23"]) };
const CTX = { holidayTables: new Map([TABLE, TABLE_FIXED, TABLE_OLD_FIX].map((t) => [t.contentSha256, t])), accountOf: () => newAccount() };
const buy: Order[] = [{ symbol: "AAA", side: "buy", qty: 100 }];
const [FRI, SAT, SUN] = ["2026-11-13", "2026-11-14", "2026-11-15"];
const BODY = "b".repeat(64);

/** regDay の夜に alpha を登録し、first（regDay の次の取引日）の注文票を確定したログ */
async function start(regDay = "2026-11-12", first = FRI) {
  const log = new EventLog(CTX);
  const add = async (d: Draft) => {
    const r = await log.append(d);
    if (!r.ok) throw new Error(`${d.type}: ${r.reason}`);
    return r.event.seq;
  };
  const reason = async (d: Draft) => {
    const r = await log.append(d);
    return r.ok ? "ok" : r.reason;
  };
  const sys = (type: Draft["type"], recordedAt: number, payload: Record<string, unknown>, refs: number[] = []): Draft => ({ type, recordedAt, actor: "system", refs, payload });
  const op = (type: Draft["type"], recordedAt: number, payload: Record<string, unknown>): Draft => ({ type, recordedAt, actor: "operator:owner", refs: [], payload });
  const run = (at: number, agentId = "alpha", extra: Record<string, unknown> = {}, refs: number[] = []) => add(sys("agent.run", at, { agentId, purpose: "order", inputSeqs: [], ok: true, ...extra }, refs));
  const commit = (at: number, tradingDate: string, runSeq: number, agentId = "alpha") => log.commitSheet(at, agentId, { tradingDate, orders: buy, runSeq, inputSeqs: [] });
  /** date の始値と約定 */
  const morning = async (date: string, sheet: number) => {
    const open = await add(sys("prices.open", jst(date, 9, 5), { date }));
    await add(sys("fills.executed", jst(date, 9, 6), { agentId: "alpha", tradingDate: date, sheetSeq: sheet, openSeq: open }, [sheet, open]));
  };
  /** date の終値・評価・引け後処理（権利落ち日は next）。at を渡すと、その時刻から書く（引け後処理が遅れた日） */
  const evening = async (date: string, next: string, at = jst(date, 15, 40)) => {
    const close = await add(sys("prices.close", at, { date }));
    await add(sys("valuation.recorded", at + 60_000, { agentId: "alpha", date, closeSeq: close }, [close]));
    await add(sys("corporate_actions.applied", at + 120_000, { agentId: "alpha", asOf: date, exDate: next, announcedSeqs: [] }));
  };
  await add(op("holidays.adopted", 0, { holidaysSha256: SHA }));
  await add(op("universe.set", 0, { symbols: ["AAA"] }));
  await add(op("agent.registered", jst(regDay, 20), { agentId: "alpha", startDate: first, initialCash: INITIAL_CASH }));
  const c = await commit(jst(regDay, 21), first, await run(jst(regDay, 20, 30)));
  if (!c.ok || c.rejected) throw new Error(`first commit failed: ${c.ok ? c.rejected : c.reason}`);
  return { log, add, reason, sys, op, run, commit, morning, evening, first: c.event.seq };
}

const committed = (r: { ok: boolean; rejected?: string; event?: { type: string } }) => (r.ok && !r.rejected ? r.event!.type : r.rejected);

describe("毎日の取引と、判断の受け付けの時間", () => {
  it("前の取引日の 12:00 の確定は拒み、17:50 の確定は受け付ける。土曜・日曜の取引日も同じ流れで進み、照合を通る", async () => {
    const w = await start();
    await w.morning(FRI, w.first);
    // 金曜の締めと引けの間（12:00）の、土曜の注文票：受け付けの前
    const noonRun = await w.run(jst(FRI, 11, 59));
    expect(committed(await w.commit(jst(FRI, 12), SAT, noonRun))).toBe("wrong_trading_date");
    await w.evening(FRI, SAT);
    // 引けの1ミリ秒前は拒む
    expect(committed(await w.commit(jst(FRI, 16, 30) - 1, SAT, await w.run(jst(FRI, 16, 30) - 2)))).toBe("wrong_trading_date");
    // 引けより前に記録した判断は、引けのあとの確定でも使えない
    expect(committed(await w.commit(jst(FRI, 17, 49), SAT, noonRun))).toBe("invalid_sheet");
    // 17:50 の確定（土曜の取引日）は受け付ける
    const sat = await w.commit(jst(FRI, 17, 50), SAT, await w.run(jst(FRI, 17, 49)));
    expect(committed(sat)).toBe("order_sheet.committed");
    if (!sat.ok) throw new Error("commit failed");
    await w.morning(SAT, sat.event.seq);
    await w.evening(SAT, SUN);
    // 日曜の取引日も、土曜の夜に確定できる
    const sun = await w.commit(jst(SAT, 23, 51), SUN, await w.run(jst(SAT, 23, 50)));
    expect(committed(sun)).toBe("order_sheet.committed");
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
    expect(committed(await w.commit(jst(SAT, 8, 30) - 1, SAT, run))).toBe("order_sheet.committed");
    expect(committed(await w.commit(jst(SAT, 8, 30), SAT, run))).toBe("after_cutoff");
  });

  it("11/10 の注文票は、11/9 の 16:30 ちょうどから受け付ける（11/9 の注文票は、切り替えより前の決まりのまま）", async () => {
    // 11/8（日）の夜に登録すると、開始日は 11/9（月）。11/9 の注文票には受け付けの時間の決まりを当てない
    const w = await start("2026-11-08", "2026-11-09");
    await w.morning("2026-11-09", w.first);
    await w.evening("2026-11-09", "2026-11-10");
    expect(committed(await w.commit(jst("2026-11-09", 16, 30) - 1, "2026-11-10", await w.run(jst("2026-11-09", 16, 0))))).toBe("wrong_trading_date");
    expect(committed(await w.commit(jst("2026-11-09", 16, 30), "2026-11-10", await w.run(jst("2026-11-09", 16, 30))))).toBe("order_sheet.committed");
  });

  it("臨時休場をまたぐと、受け付けは前の開いている取引日の引けから（土曜を休場にすると、日曜の注文票は金曜の 16:30 から）", async () => {
    const w = await start();
    await w.morning(FRI, w.first);
    await w.add(w.op("market.closed", jst(FRI, 10), { date: SAT, reason: "test" }));
    expect(committed(await w.commit(jst(FRI, 12), SUN, await w.run(jst(FRI, 11, 59))))).toBe("wrong_trading_date");
    await w.evening(FRI, SUN);
    expect(committed(await w.commit(jst(FRI, 17, 50), SUN, await w.run(jst(FRI, 17, 49))))).toBe("order_sheet.committed");
  });

  it("その日に登録したAIの最初の注文票：日中に登録すると、引けのあとから確定できる", async () => {
    const w = await start();
    await w.morning(FRI, w.first);
    // 金曜の 12:00 に登録すると、開始日は土曜。土曜の受け付けは金曜の 16:30 から
    await w.add(w.op("agent.registered", jst(FRI, 12), { agentId: "beta", startDate: SAT, initialCash: INITIAL_CASH }));
    expect(committed(await w.commit(jst(FRI, 12, 30), SAT, await w.run(jst(FRI, 12, 29), "beta"), "beta"))).toBe("wrong_trading_date");
    // 夜に登録したAIも、その場で確定できる
    await w.add(w.op("agent.registered", jst(FRI, 18), { agentId: "gamma", startDate: SAT, initialCash: INITIAL_CASH }));
    expect(committed(await w.commit(jst(FRI, 18, 31), SAT, await w.run(jst(FRI, 18, 30), "beta"), "beta"))).toBe("order_sheet.committed");
    expect(committed(await w.commit(jst(FRI, 18, 33), SAT, await w.run(jst(FRI, 18, 32), "gamma"), "gamma"))).toBe("order_sheet.committed");
  });

  it("引け後処理が翌朝まで遅れても、締めの前なら確定できる（口座が整うまでは account_not_ready）", async () => {
    const w = await start();
    await w.morning(FRI, w.first);
    expect(committed(await w.commit(jst(FRI, 23, 50), SAT, await w.run(jst(FRI, 23, 49))))).toBe("account_not_ready");
    await w.evening(FRI, SAT, jst(SAT, 4, 0));
    expect(committed(await w.commit(jst(SAT, 8, 0), SAT, await w.run(jst(SAT, 7, 59))))).toBe("order_sheet.committed");
  });
});

describe("LLM の依頼と、判断の受け付けの時間", () => {
  const submitted = (at: number, tradingDate: string, extra: Record<string, unknown> = {}): Draft => ({
    type: "llm.batch.submitted",
    recordedAt: at,
    actor: "system",
    refs: [],
    payload: {
      agentId: "alpha",
      provider: "anthropic",
      modelId: "claude-sonnet-5-5",
      promptVersion: "v1",
      sentBodyHash: BODY,
      customId: `alpha-${tradingDate.replaceAll("-", "")}-${BODY.slice(0, 16)}`,
      maxCost: 150,
      tradingDate,
      submittedAt: at,
      yenPerUsd: 160,
      inputCentsPer10MTok: 1000,
      outputCentsPer10MTok: 5000,
      maxInputTokens: 50_000,
      maxOutputTokens: 8_000,
      bodyMaxOutputTokens: 8_000,
      ...extra,
    },
  });

  it("前の取引日の引けより前の依頼は書けない。16:35 の依頼は書け、夜に受け取って確定できる（翌朝の受け取りでもよい）", async () => {
    const w = await start();
    await w.morning(FRI, w.first);
    expect(await w.reason(submitted(jst(FRI, 9, 0), SAT))).toBe("submittedAt must be after the close of the previous trading day");
    expect(await w.reason(submitted(jst(FRI, 16, 30) - 1, SAT))).toBe("submittedAt must be after the close of the previous trading day");
    await w.evening(FRI, SAT);
    const s = await w.add(submitted(jst(FRI, 16, 35), SAT));
    await w.add({ type: "llm.batch.sent", recordedAt: jst(FRI, 16, 36), actor: "system", refs: [s], payload: { batchSeq: s, agentId: "alpha", provider: "anthropic", batchId: "msgbatch_01" } });
    const c = await w.add({ type: "llm.batch.closed", recordedAt: jst(FRI, 17, 50), actor: "system", refs: [s], payload: { batchSeq: s, agentId: "alpha", result: "collected", cost: 44, inputTokens: 20_000, outputTokens: 1_500, inputCentsPer10MTok: 1000, outputCentsPer10MTok: 5000 } });
    const r = await w.run(jst(FRI, 17, 51), "alpha", { batchSeq: c, sentBodyHash: BODY }, [c]);
    expect(committed(await w.commit(jst(FRI, 17, 52), SAT, r))).toBe("order_sheet.committed");

    const again = new EventLog(CTX);
    for (const e of w.log.events) expect(await again.admit(e)).toBeNull();
  });

  it("11/9 の取引日の依頼には、受け付けの時間の決まりを当てない（11/6 の日中の依頼も、前の作りのまま書ける）", async () => {
    const log = new EventLog(CTX);
    await log.append({ type: "holidays.adopted", recordedAt: 0, actor: "operator:owner", refs: [], payload: { holidaysSha256: SHA } });
    await log.append({ type: "agent.registered", recordedAt: jst("2026-11-06", 9), actor: "operator:owner", refs: [], payload: { agentId: "alpha", startDate: "2026-11-09", initialCash: INITIAL_CASH } });
    const r = await log.append(submitted(jst("2026-11-06", 10), "2026-11-09"));
    expect(r.ok ? "ok" : r.reason).toBe("ok");
  });
});

describe("祝日の一覧の採用（11/9 以後の日付）", () => {
  it("ログが使った日付でも、11/9 以後の祝日の直しは採用できる。11/9 より前の、使った日付の直しは採用できない", async () => {
    const w = await start("2026-11-02", "2026-11-04"); // 11/3 は祝日なので、開始日は 11/4
    await w.morning("2026-11-04", w.first);
    await w.evening("2026-11-04", "2026-11-05");
    const adopt = (sha: string) => w.reason(w.op("holidays.adopted", jst("2026-11-04", 16), { holidaysSha256: sha }));
    expect(await adopt("f".repeat(64))).toBe("holiday table changes 2026-11-03, which the log already used");
    expect(await adopt(FIXED)).toBe("ok");
  });

  it("11/14 まで使ったログでも、11/14 を祝日に足した一覧を採用でき、11/14 は取引日のまま", async () => {
    const w = await start();
    await w.morning(FRI, w.first);
    await w.evening(FRI, SAT);
    expect(await w.reason(w.op("holidays.adopted", jst(FRI, 16), { holidaysSha256: FIXED }))).toBe("ok");
    expect(await w.reason(w.sys("prices.open", jst(SAT, 9), { date: SAT }))).toBe("ok");
  });
});
