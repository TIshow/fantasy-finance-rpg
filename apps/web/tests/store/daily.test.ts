// 毎日の実行（scripts/daily-lib.ts）の試験：PGlite の保管に対して、同じ日を何度回しても二重にならないこと、
// 途中で落ちて回し直しても進むこと、記録だけから台帳を作り直せること、本番の準備が二重に書かないことを確かめる。
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { holidayTable } from "../../src/holidays";
import { IngestedMarketData, type SourceQuote, staticSource } from "../../src/ingest/market-data";
import { INITIAL_CASH } from "../../src/ledger/types";
import { scheduleOf } from "../../src/runner/day";
import { ruleAgents } from "../../src/runner/rule-agents";
import { readAllEvents } from "../../src/store/pg-store";
import type { SqlDb } from "../../src/store/sql";
import { type PrepareContext, firstOpenDay, productionSetup, runDaily, verifyDatabase } from "../../scripts/daily-lib";
import { FakeClock, jst } from "../contracts/fakes";
import { FIXTURE_HOLIDAYS } from "../fixtures/golden";
import { mulberry32 } from "../fixtures/prng";
import { migrate } from "../../src/store/sql";
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
const count = async () => (await db.query("SELECT count(*)::int AS n FROM events")).rows[0] as { n: number };

/** 架空の世界（外部の市場データの銘柄3つ）。実時刻に近い順で取り込む */
const SYMBOLS = ["TSTA", "TSTB", "TSTC"];
/** PRE：AIが始まる前の営業日（始値・終値だけ）。DAYS：AIが売買する日 */
const PRE = "2026-11-05";
const DAYS = ["2026-11-06", "2026-11-09", "2026-11-10"];
function world() {
  const rand = mulberry32(7);
  const quotes: { fetchedAt: number; quote: SourceQuote }[] = [];
  for (const date of [PRE, ...DAYS]) {
    for (const symbol of SYMBOLS) {
      const base = { symbol, date, source: "fixture:synthetic" };
      const open = Math.round(1000 + rand() * 100) * 10;
      quotes.push({ fetchedAt: jst(date, 9) + 5_000, quote: { ...base, kind: "open", price: open, publishedAt: jst(date, 9) } });
      quotes.push({ fetchedAt: jst(date, 15, 30) + 5_000, quote: { ...base, kind: "close", price: open + Math.round((rand() - 0.5) * 100) * 10, volume: 1000, publishedAt: jst(date, 15, 30) } });
    }
  }
  quotes.sort((a, b) => a.fetchedAt - b.fetchedAt);
  const clock = new FakeClock(jst(DAYS[0]!, 7));
  const market = new IngestedMarketData(clock);
  const waitUntil = async (at: number) => {
    while (quotes.length > 0 && quotes[0]!.fetchedAt <= at) {
      const t = quotes[0]!.fetchedAt;
      const n = quotes.findIndex((x) => x.fetchedAt !== t);
      const batch = quotes.splice(0, n === -1 ? quotes.length : n);
      clock.set(Math.max(clock.now(), t));
      await market.ingest(staticSource(batch.map((x) => x.quote)));
    }
    if (at > clock.now()) clock.set(at);
  };
  /** 準備：祝日の採用・取引対象・AI投資家の登録。済んでいれば書かない */
  const prepare = async ({ store }: PrepareContext) => {
    const have = new Set((await store.read(0, 1000)).map((e) => e.type));
    const op = async (type: "holidays.adopted" | "universe.set" | "agent.registered", payload: Record<string, unknown>) => {
      const r = await store.append({ type, actor: "operator:owner", refs: [], payload });
      if (!r.ok) throw new Error(r.reason);
    };
    const agents = await ruleAgents();
    if (!have.has("holidays.adopted")) await op("holidays.adopted", { holidaysSha256: FIXTURE_HOLIDAYS.contentSha256 });
    if (!have.has("universe.set")) await op("universe.set", { symbols: SYMBOLS });
    if (!have.has("agent.registered")) for (const a of agents) await op("agent.registered", { agentId: a.id, displayName: a.id, startDate: DAYS[0], initialCash: INITIAL_CASH });
    return agents;
  };
  return { clock, market, waitUntil, prepare };
}
const opts = (w: ReturnType<typeof world>) => ({ db, clock: w.clock, market: w.market, waitUntil: w.waitUntil, prepare: w.prepare, holidayTable: FIXTURE_HOLIDAYS });

describe("runDaily", () => {
  it("同じ日をもう一度回しても、何も書かない。回すたびに DB から作り直す", async () => {
    await fresh();
    const w = world();
    for (const d of DAYS) await runDaily(d, opts(w));
    const after = await count();
    expect(after.n).toBeGreaterThan(30);
    for (const d of DAYS) await runDaily(d, opts(w));
    expect(await count()).toEqual(after);
    const report = await verifyDatabase(db, FIXTURE_HOLIDAYS);
    expect(report.events).toBe(after.n);
    expect(report.agents.sort()).toEqual(["ai-hold", "ai-ma5", "ai-reversal"]);
    const types = (await readAllEvents(db)).map((e) => e.type);
    expect(types.filter((t) => t === "valuation.recorded").length).toBe(3 * DAYS.length);
    expect(types).toContain("fills.executed");
  });

  it("途中（寄り付きの前）で落ちても、回し直すと続きから進み、止まらずに回した場合と同じ並びの記録になる", async () => {
    await fresh();
    const a = world();
    for (const d of DAYS) await runDaily(d, opts(a));
    // 乱数（値のハッシュの salt）が毎回違うので、ハッシュではなく、記録の種類の並びを比べる
    const shape = async () => (await readAllEvents(db)).map((e) => e.type);
    const expected = await shape();

    await fresh();
    const b = world();
    for (const d of DAYS) {
      // 寄り付きの時刻で落とす（判断までは書き終えている）
      const stop = (at: number) => (at === scheduleOf(d).openAt ? Promise.reject(new Error("crash")) : b.waitUntil(at));
      await expect(runDaily(d, { ...opts(b), waitUntil: stop })).rejects.toThrow("crash");
      await runDaily(d, opts(b));
    }
    expect(await shape()).toEqual(expected);
    await verifyDatabase(db, FIXTURE_HOLIDAYS);
  });

  it("DB の行が書き換えられていれば、記録だけからの照合が止まる", async () => {
    await fresh();
    const w = world();
    for (const d of DAYS) await runDaily(d, opts(w));
    await pg.exec("ALTER TABLE events DISABLE TRIGGER USER");
    await pg.exec("UPDATE events SET recorded_at = recorded_at + 1 WHERE seq = 5");
    await expect(verifyDatabase(db, FIXTURE_HOLIDAYS)).rejects.toThrow();
  });
});

describe("本番の準備（productionSetup）", () => {
  it("祝日の採用・上場・取引対象・参加者の登録と最初の配分を書き、もう一度呼んでも何も書かない", async () => {
    await fresh();
    // 月曜の朝7時（締めの前）。祝日は同梱の一覧
    const clock = new FakeClock(jst("2026-11-09", 7));
    const run = (c: FakeClock) => runDaily("2026-11-09", { db, clock: c, prepare: productionSetup, holidayTable });
    await run(clock);
    const events = await readAllEvents(db);
    const of = (t: string) => events.filter((e) => e.type === t);
    expect(of("holidays.adopted")).toHaveLength(1);
    expect(of("company.listed")).toHaveLength(6);
    expect(of("universe.set")).toHaveLength(1);
    // AI投資家3 + マーケットメイカー6 + ばらばらの参加者1
    expect(of("agent.registered")).toHaveLength(10);
    expect(of("shares.allotted").length).toBeGreaterThan(0);
    const n = events.length;
    await run(clock);
    expect((await readAllEvents(db)).length).toBe(n);
  });

  it("新しい参加者の開始日は、いまから締めがまだ来ていない最初の営業日（締めを過ぎていれば次の営業日、休日はとばす）", () => {
    expect(firstOpenDay(jst("2026-11-09", 7), holidayTable)).toBe("2026-11-09");
    expect(firstOpenDay(jst("2026-11-09", 9), holidayTable)).toBe("2026-11-10");
    expect(firstOpenDay(jst("2026-11-06", 20), holidayTable)).toBe("2026-11-09"); // 金曜の夜 → 月曜
    expect(firstOpenDay(jst("2026-11-02", 7), holidayTable)).toBe("2026-11-02");
    expect(firstOpenDay(jst("2026-11-02", 20), holidayTable)).toBe("2026-11-04"); // 11/3 は文化の日
  });
});
