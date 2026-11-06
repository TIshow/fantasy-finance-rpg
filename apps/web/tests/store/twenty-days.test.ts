// 通しの確認（#139）：本番と同じ入口（scripts/daily-lib.ts の productionSetup と runDaily。コマンド `daily run` が呼ぶもの）で、
// PGlite（試験用の Postgres）の上に20営業日を回す。毎日、記録だけから台帳を作り直して照合し（`daily verify` と同じ verifyDatabase）、
// 決算の発表があること、架空の6社すべてに板寄せの値段がつく日があること、祝日と週末をとばすことを確かめる。
// 時計は試験用の時計で、waitUntil がその時刻まで進める（`daily run --wait` と同じ形）。
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LogEvent } from "../../src/events/types";
import { holidayTable } from "../../src/holidays";
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
  await resetSchema(pg);
  await migrate(db);
}, 60_000);
afterAll(() => db.close());

const p = (e: LogEvent) => e.payload as Record<string, unknown>;
/** 2026-11-02（月）から 2026-12-01（火）まで。11/3（文化の日）と 11/23（勤労感謝の日）と週末を除くと、ちょうど20営業日 */
const FIRST = "2026-11-02";
const LAST = "2026-12-01";
const HOLIDAYS = ["2026-11-03", "2026-11-23"];

function calendarDays(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

describe("本番の入口で20営業日を回す（PGlite）", () => {
  it("祝日と週末をとばして20営業日を回し終え、毎日の照合が一致し、決算の発表があり、6社すべてに値段がつく日がある", async () => {
    const started = Date.now();
    // 初日の朝7時（締めの前）に始める。準備は本番と同じ productionSetup（祝日は同梱の一覧）
    const clock = new FakeClock(jst(FIRST, 7));
    const waitUntil = async (at: number) => void (at > clock.now() && clock.set(at));
    const businessDays: string[] = [];
    const skipped: string[] = [];
    let lastCount = 0;
    for (const date of calendarDays(FIRST, LAST)) {
      const results = await runDaily(date, { db, clock, waitUntil, prepare: productionSetup, holidayTable });
      if (results.length === 1 && results[0]!.stage === "day" && results[0]!.status === "skipped") {
        skipped.push(date);
        continue;
      }
      businessDays.push(date);
      // 判断が締めに間に合わない日がなく（コマンドなら終了コード3）、待ちのまま残る段もない
      expect(missedCutoff(results), `${date}: ${JSON.stringify(results)}`).toBe(false);
      expect(results.filter((r) => r.status === "waiting"), `${date}: ${JSON.stringify(results)}`).toEqual([]);
      // 毎日のあとに、記録だけから作り直して照合する（食い違えば例外）
      const report = await verifyDatabase(db, holidayTable);
      expect(report.events).toBeGreaterThan(lastCount);
      lastCount = report.events;
    }

    expect(businessDays).toHaveLength(20);
    for (const h of HOLIDAYS) expect(skipped).toContain(h);
    expect(skipped.every((d) => HOLIDAYS.includes(d) || [0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay()))).toBe(true);

    const events = await readAllEvents(db);
    const of = (t: string) => events.filter((e) => e.type === t);
    // 祝日の日付には何も記録しない
    for (const h of HOLIDAYS) expect(events.filter((e) => p(e).date === h || p(e).tradingDate === h)).toEqual([]);

    // 決算の発表：上場の直後の1回（6社）と、板寄せが20日たまった最後の日の引けのあとの1回（6社）
    const disclosed = of("company.disclosed");
    expect(disclosed.length).toBeGreaterThanOrEqual(1);
    expect(new Set(disclosed.map((e) => p(e).symbol))).toEqual(new Set(COMPANIES.map((c) => c.symbol)));

    // 板寄せの値段：6社それぞれに値段のついた日があり、6社そろって値段のついた日もある
    const priced = of("auction.cleared").filter((e) => p(e).price !== null);
    const symbols = COMPANIES.map((c) => c.symbol);
    for (const s of symbols) expect(priced.some((e) => p(e).symbol === s), s).toBe(true);
    const byDay = new Map<string, Set<string>>();
    for (const e of priced) byDay.set(p(e).date as string, (byDay.get(p(e).date as string) ?? new Set()).add(p(e).symbol as string));
    const allSix = [...byDay].filter(([, s]) => s.size === symbols.length).map(([d]) => d);
    expect(allSix.length).toBeGreaterThanOrEqual(1);

    // 毎営業日、AI投資家3体の評価が残る
    expect(of("valuation.recorded").filter((e) => String(p(e).agentId).startsWith("ai-")).length).toBe(3 * 20);

    // 結果の要約（issue への報告に使う）
    console.log(
      JSON.stringify({
        businessDays: businessDays.length,
        skipped,
        events: events.length,
        disclosures: disclosed.length,
        disclosedPeriods: [...new Set(disclosed.map((e) => p(e).period))],
        pricedDays: byDay.size,
        pricedDaysAllSix: allSix.length,
        pricedPerSymbol: Object.fromEntries(symbols.map((s) => [s, priced.filter((e) => p(e).symbol === s).length])),
        fills: of("fills.executed").length,
        seconds: Math.round((Date.now() - started) / 1000),
      }),
    );
  }, 600_000);
});
