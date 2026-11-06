// 通しの確認（#139）：本番と同じ入口（scripts/daily-lib.ts の productionSetup と runDaily。コマンド `daily run` が呼ぶもの）で、
// PGlite（試験用の Postgres）の上に20営業日を回す。毎日、記録だけから台帳を作り直して照合し（`daily verify` と同じ verifyDatabase）、
// 決算の発表の件数と時刻、架空の6社すべてに板寄せの値段がつく日があること、祝日と週末をとばすことを確かめる。
// 回し方は2つ：待つ形（`daily run --wait` と同じ。waitUntil が試験用の時計を進める）と、待たずに1日に数回回す形（GitHub Actions の形）。
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LogEvent } from "../../src/events/types";
import { holidayTable } from "../../src/holidays";
import { cutoffOf } from "../../src/ledger/ledger";
import type { StageResult } from "../../src/runner/day";
import { COMPANIES } from "../../src/runner/world/companies";
import { readAllEvents } from "../../src/store/pg-store";
import { migrate, type SqlDb } from "../../src/store/sql";
import { missedCutoff, productionSetup, runDaily, verifyDatabase } from "../../scripts/daily-lib";
import { FakeClock, jst } from "../contracts/fakes";
import { openPglite, resetSchema } from "./pglite";

let pg: PGlite;
let db: SqlDb;
beforeAll(async () => {
  ({ pg, db } = await openPglite());
}, 60_000);
afterAll(() => db.close());
const fresh = async () => {
  await resetSchema(pg);
  await migrate(db);
};

const p = (e: LogEvent) => e.payload as Record<string, unknown>;
/** 2026-11-02（月）から 2026-12-01（火）まで。11/3（文化の日）と 11/23（勤労感謝の日）と週末を除くと、ちょうど20営業日 */
const FIRST = "2026-11-02";
const DAY20 = "2026-12-01";
/** 20営業日の次の営業日 */
const DAY21 = "2026-12-02";
const HOLIDAYS = ["2026-11-03", "2026-11-23"];
const SYMBOLS = COMPANIES.map((c) => c.symbol);

function calendarDays(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}
const before = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
const isSkipped = (r: readonly StageResult[]) => r[0]?.stage === "day" && r[0].status === "skipped";

/** 初日の朝7時（締めの前）に始める時計と、時刻まで進める waitUntil。準備は本番と同じ productionSetup（祝日は同梱の一覧） */
function world() {
  const clock = new FakeClock(jst(FIRST, 7));
  const waitUntil = async (at: number) => void (at > clock.now() && clock.set(at));
  const opts = (d: SqlDb = db) => ({ db: d, clock, prepare: productionSetup, holidayTable });
  return { clock, waitUntil, opts };
}

/** 待つ形で、from から to までの毎日を回す。営業日ごとに、締めに間に合い、待ちの段が残らず、照合が一致することを確かめる */
async function runWaiting(w: ReturnType<typeof world>, from: string, to: string) {
  const business: string[] = [];
  const skipped: string[] = [];
  for (const date of calendarDays(from, to)) {
    const results = await runDaily(date, { ...w.opts(), waitUntil: w.waitUntil });
    if (isSkipped(results)) {
      skipped.push(date);
      continue;
    }
    business.push(date);
    expect(missedCutoff(results), `${date}: ${JSON.stringify(results)}`).toBe(false);
    expect(results.filter((r) => r.status === "waiting"), `${date}: ${JSON.stringify(results)}`).toEqual([]);
    await verifyDatabase(db, holidayTable);
  }
  return { business, skipped };
}

const disclosedOf = (events: readonly LogEvent[]) => events.filter((e) => e.type === "company.disclosed");
/** 発表の件数と時刻を比べる形（seq は回し方で変わるので入れない） */
const disclosureShape = (events: readonly LogEvent[]) => disclosedOf(events).map((e) => `${String(p(e).symbol)}:${String(p(e).period)}@${e.recordedAt}`);
/** 日付の分の、マーケットメイカーの判断の記録 */
const makerRuns = (events: readonly LogEvent[], date: string) =>
  events.filter((e) => e.type === "agent.run" && String(p(e).agentId).startsWith("mm-") && p(e).ok === true && events.some((s) => s.type === "order_sheet.committed" && p(s).runSeq === e.seq && p(s).tradingDate === date));

/** 指定した種類のイベントの n 回目の追記だけ失敗する DB（書き込みの途中で落ちた場合） */
function crashingOn(type: string, n: number): SqlDb {
  let seen = 0;
  return { ...db, transaction: (fn) => db.transaction((tx) => fn({ ...tx, query: (t, q) => (t.startsWith("INSERT INTO events") && q?.[2] === type && ++seen === n ? Promise.reject(new Error("crash")) : tx.query(t, q)) })) };
}

describe("本番の入口で20営業日を回す（PGlite）", () => {
  let waitingShape: string[] = [];

  it("待つ形：祝日と週末をとばして20営業日を回し、毎日の照合が一致し、決算の発表は時期どおりで、各社が16日以上・6社そろって10日以上、板寄せの値段がつく", async () => {
    await fresh();
    const w = world();
    const { business, skipped } = await runWaiting(w, FIRST, DAY20);
    expect(business).toHaveLength(20);
    for (const h of HOLIDAYS) expect(skipped).toContain(h);
    expect(skipped.every((d) => HOLIDAYS.includes(d) || [0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay()))).toBe(true);

    const events = await readAllEvents(db);
    const of = (t: string) => events.filter((e) => e.type === t);
    // 祝日（11/3・11/23）の日付では、何も記録しない
    for (const h of HOLIDAYS) expect(events.filter((e) => p(e).date === h || p(e).tradingDate === h || p(e).asOf === h)).toEqual([]);

    // 決算の発表：上場の直後（初日の締めより前）に 2026-Q3 を6社、20日目の引け（15:30）のあと・次の営業日の締めより前に 2026-Q4 を6社
    const disclosed = disclosedOf(events);
    expect(disclosed).toHaveLength(12);
    for (const e of disclosed) expect(SYMBOLS).toContain(p(e).symbol);
    const q3 = disclosed.filter((e) => p(e).period === "2026-Q3");
    const q4 = disclosed.filter((e) => p(e).period === "2026-Q4");
    expect(q3.map((e) => p(e).symbol).sort()).toEqual([...SYMBOLS].sort());
    expect(q4.map((e) => p(e).symbol).sort()).toEqual([...SYMBOLS].sort());
    for (const e of q3) expect(e.recordedAt).toBeLessThan(cutoffOf(FIRST));
    for (const e of q4) {
      expect(e.recordedAt).toBeGreaterThanOrEqual(jst(DAY20, 15, 30));
      expect(e.recordedAt).toBeLessThan(cutoffOf(DAY21));
    }

    // 板寄せの値段（lead の目標、#139）：各社が8割以上の日（16日以上）に値段がつき、6社そろって値段がつく日が半分以上（10日以上）
    const priced = of("auction.cleared").filter((e) => p(e).price !== null);
    const pricedDays = Object.fromEntries(SYMBOLS.map((s) => [s, priced.filter((e) => p(e).symbol === s).length]));
    const byDay = new Map<string, Set<string>>();
    for (const e of priced) byDay.set(p(e).date as string, (byDay.get(p(e).date as string) ?? new Set()).add(p(e).symbol as string));
    const allSixDays = [...byDay.values()].filter((s) => s.size === SYMBOLS.length).length;
    // 日数を試験の出力に残す（lead の指示、#139）。売買役の数字を変えたときに、目標までの余裕を、試験が落ちる前に見られるように
    console.log(`priced days per company ${JSON.stringify(pricedDays)}, all six priced on ${allSixDays} of 20 days`);
    for (const s of SYMBOLS) expect(pricedDays[s], `${s}: ${JSON.stringify(pricedDays)}`).toBeGreaterThanOrEqual(16);
    expect(allSixDays, JSON.stringify(pricedDays)).toBeGreaterThanOrEqual(10);

    // 毎営業日、AI投資家3体の評価が残る
    expect(of("valuation.recorded").filter((e) => String(p(e).agentId).startsWith("ai-")).length).toBe(3 * 20);

    // 20日目をもう一度回しても、何も書かない（発表も12件のまま）
    await runDaily(DAY20, { ...w.opts(), waitUntil: w.waitUntil });
    expect(await readAllEvents(db)).toHaveLength(events.length);

    // 次の営業日：マーケットメイカーの判断の入力に Q4 が入る。20日目の判断の入力には入らない
    await runWaiting(w, DAY21, DAY21);
    const all = await readAllEvents(db);
    expect(disclosedOf(all)).toHaveLength(12);
    const q4Seqs = q4.map((e) => e.seq);
    const day20 = makerRuns(all, DAY20);
    const day21 = makerRuns(all, DAY21);
    expect(day20).toHaveLength(6);
    expect(day21).toHaveLength(6);
    for (const r of day20) expect((p(r).inputSeqs as number[]).filter((s) => q4Seqs.includes(s))).toEqual([]);
    for (const r of day21) expect(p(r).inputSeqs as number[]).toEqual(expect.arrayContaining(q4Seqs));
    waitingShape = disclosureShape(events);
  }, 600_000);

  it("待たずに1日に数回（7:00・9:30・16:30）回す形（GitHub Actions の形）でも、照合が一致し、発表の件数と時刻は待つ形と同じ", async () => {
    expect(waitingShape).toHaveLength(12);
    await fresh();
    const w = world();
    for (const date of calendarDays(FIRST, DAY20)) {
      for (const [h, m] of [[7, 0], [9, 30], [16, 30]] as const) {
        w.clock.set(Math.max(w.clock.now(), jst(date, h, m)));
        const results = await runDaily(date, w.opts());
        expect(missedCutoff(results), `${date} ${h}:${m}: ${JSON.stringify(results)}`).toBe(false);
        if (isSkipped(results)) break;
      }
      await verifyDatabase(db, holidayTable);
    }
    const events = await readAllEvents(db);
    expect(events.filter((e) => e.type === "valuation.recorded" && String(p(e).agentId).startsWith("ai-")).length).toBe(3 * 20);
    expect(disclosureShape(events)).toEqual(waitingShape);
  }, 600_000);

  it("20日目の朝の実行のあと寄り付きの実行が抜けても、次の朝に板寄せを補い、判断の前に Q4 を発表して、判断の入力に入れる", async () => {
    await fresh();
    const w = world();
    await runWaiting(w, FIRST, before(DAY20));
    // 20日目：朝7時の実行（判断まで）だけ。寄り付きと引けの実行がない
    w.clock.set(jst(DAY20, 7));
    await runDaily(DAY20, w.opts());
    expect(disclosedOf(await readAllEvents(db))).toHaveLength(6);
    // 次の営業日の朝7時：20日目の板寄せと引け後を補い、発表し、判断する
    w.clock.set(jst(DAY21, 7));
    const results = await runDaily(DAY21, w.opts());
    const stages = results.map((r) => r.stage);
    expect(stages.indexOf("disclose")).toBeGreaterThan(-1);
    expect(stages.indexOf("disclose")).toBeLessThan(stages.indexOf("decide"));
    expect(results.find((r) => r.stage === "decide")?.status).toBe("written");
    const events = await readAllEvents(db);
    const q4 = disclosedOf(events).filter((e) => p(e).period === "2026-Q4");
    expect(q4).toHaveLength(6);
    for (const e of q4) expect(e.recordedAt).toBeLessThan(cutoffOf(DAY21));
    const runs = makerRuns(events, DAY21);
    expect(runs).toHaveLength(6);
    for (const r of runs) expect(p(r).inputSeqs as number[]).toEqual(expect.arrayContaining(q4.map((e) => e.seq)));
    await verifyDatabase(db, holidayTable);
  }, 600_000);

  it("20日目の発表の途中（3件目の追記）で落ちても、回し直すと12件になり、照合が一致する", async () => {
    await fresh();
    const w = world();
    await runWaiting(w, FIRST, before(DAY20));
    await expect(runDaily(DAY20, { ...w.opts(crashingOn("company.disclosed", 3)), waitUntil: w.waitUntil })).rejects.toThrow("crash");
    expect(disclosedOf(await readAllEvents(db))).toHaveLength(8);
    await runDaily(DAY20, { ...w.opts(), waitUntil: w.waitUntil });
    expect(disclosedOf(await readAllEvents(db))).toHaveLength(12);
    await verifyDatabase(db, holidayTable);
  }, 600_000);
});
