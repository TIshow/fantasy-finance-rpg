// 毎日の実行（scripts/daily-lib.ts）の試験：PGlite の保管に対して、同じ日を何度回しても二重にならないこと、
// 途中で落ちて回し直しても進むこと、記録だけから台帳を作り直せること、本番の準備が二重に書かないことを確かめる。
import { execFileSync } from "node:child_process";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { holidayTable } from "../../src/holidays";
import { IngestedMarketData, type SourceQuote, staticSource } from "../../src/ingest/market-data";
import { INITIAL_CASH } from "../../src/ledger/types";
import { scheduleOf } from "../../src/runner/day";
import { ruleAgents } from "../../src/runner/rule-agents";
import { readAllEvents } from "../../src/store/pg-store";
import type { SqlDb } from "../../src/store/sql";
import { type PrepareContext, firstOpenDay, jstDate, missedCutoff, productionSetup, runDaily, verifyDatabase } from "../../scripts/daily-lib";
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
/** 指定した種類のイベントを DB に足す1回目だけ失敗する DB（書き込みの途中で落ちた場合） */
function crashingOn(type: string): SqlDb {
  let armed = true;
  return { ...db, transaction: (fn) => db.transaction((tx) => fn({ ...tx, query: (t, p) => (armed && t.startsWith("INSERT INTO events") && p?.[2] === type ? ((armed = false), Promise.reject(new Error("crash"))) : tx.query(t, p)) })) };
}
const opts = (w: ReturnType<typeof world>) => ({ db, clock: w.clock, market: w.market, waitUntil: w.waitUntil, prepare: w.prepare, holidayTable: FIXTURE_HOLIDAYS });

describe("runDaily", () => {
  it("同じ日をもう一度回しても、何も書かない。回すたびに DB から作り直す", async () => {
    await fresh();
    const w = world();
    for (const d of DAYS) await runDaily(d, opts(w));
    const day = await count();
    expect(day.n).toBeGreaterThan(30);
    // 最後の日の引けのあとに回し直すと、次の取引日（11/11）の判断だけを書く（#228）。それより前の日の分は何も書かない
    for (const d of DAYS) await runDaily(d, opts(w));
    const night = (await readAllEvents(db)).slice(day.n);
    expect(night.filter((e) => e.type === "order_sheet.committed").map((e) => (e.payload as { tradingDate: string }).tradingDate)).toEqual(["2026-11-11", "2026-11-11", "2026-11-11"]);
    expect(night.every((e) => ["agent.run", "post.published", "order_sheet.committed"].includes(e.type))).toBe(true);
    const after = await count();
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

  it("注文票を確定する直前（判断の記録は書いたあと）に落ちても、回し直すと続きから進み、同じ並びの記録になる", async () => {
    await fresh();
    const a = world();
    for (const d of DAYS) await runDaily(d, opts(a));
    const shape = async () => (await readAllEvents(db)).map((e) => e.type);
    const expected = await shape();

    await fresh();
    const b = world();
    await runDaily(DAYS[0]!, opts(b));
    await expect(runDaily(DAYS[1]!, { ...opts(b), db: crashingOn("order_sheet.committed") })).rejects.toThrow("crash");
    for (const d of DAYS.slice(1)) await runDaily(d, opts(b));
    expect(await shape()).toEqual(expected);
    await verifyDatabase(db, FIXTURE_HOLIDAYS);
  });

  it("実行の全体で鍵を持ち、取れなければ書かずに例外にする。終わったら（失敗でも）手放す", async () => {
    await fresh();
    const w = world();
    const calls: string[] = [];
    const lockedBy = (free: boolean): SqlDb => ({ ...db, lock: async (key) => (calls.push(`lock ${key}`), free ? async () => void calls.push("unlock") : null) });
    await expect(runDaily(DAYS[0]!, { ...opts(w), db: lockedBy(false) })).rejects.toThrow("another daily run is in progress");
    expect(await count()).toEqual({ n: 0 });
    await runDaily(DAYS[0]!, { ...opts(w), db: lockedBy(true) });
    expect(calls).toEqual(["lock 25000002", "lock 25000002", "unlock"]);
    await expect(runDaily("2026-02-31", opts(w))).rejects.toThrow(RangeError);
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

  it("登録のあと、配分の前に落ちても、回し直すと続きから進み、二重に配らない", async () => {
    const run = (d: SqlDb, c: FakeClock) => runDaily("2026-11-09", { db: d, clock: c, prepare: productionSetup, holidayTable });
    const counts = async () => {
      const m = new Map<string, number>();
      for (const e of await readAllEvents(db)) m.set(e.type, (m.get(e.type) ?? 0) + 1);
      return [...m].sort();
    };
    await fresh();
    await run(db, new FakeClock(jst("2026-11-09", 7)));
    const expected = await counts();

    await fresh();
    const clock = new FakeClock(jst("2026-11-09", 7));
    await expect(run(crashingOn("shares.allotted"), clock)).rejects.toThrow("crash");
    await run(db, clock);
    expect(await counts()).toEqual(expected);
    await verifyDatabase(db, holidayTable);
  });

  it("日本時間の日付は、UTC では前の日になる朝7時でも合う", () => {
    expect(jstDate(jst("2026-11-09", 7))).toBe("2026-11-09");
    expect(jstDate(jst("2026-11-09", 0))).toBe("2026-11-09");
    expect(jstDate(jst("2026-11-09", 23, 59))).toBe("2026-11-09");
    expect(firstOpenDay(jst("2026-11-09", 8, 29), holidayTable)).toBe("2026-11-09");
    expect(firstOpenDay(jst("2026-11-09", 8, 30), holidayTable)).toBe("2026-11-10"); // 締めちょうどは間に合わない
  });

  it("判断が締めに間に合わなかった実行は、失敗として見分けられる", () => {
    const ok = [{ stage: "decide", status: "written" }, { stage: "day", status: "skipped", detail: "not a business day" }] as const;
    expect(missedCutoff(ok)).toBe(false);
    expect(missedCutoff([{ stage: "decide", status: "skipped", detail: "after the cutoff: ai-ma5,noise" }])).toBe(true);
    expect(missedCutoff([{ stage: "decide", status: "skipped", detail: "after the open" }])).toBe(false);
  });

  it("新しい参加者の開始日は、いまから締めがまだ来ていない最初の営業日（締めを過ぎていれば次の営業日、休日はとばす）", () => {
    expect(firstOpenDay(jst("2026-11-09", 7), holidayTable)).toBe("2026-11-09");
    expect(firstOpenDay(jst("2026-11-09", 9), holidayTable)).toBe("2026-11-10");
    expect(firstOpenDay(jst("2026-11-06", 20), holidayTable)).toBe("2026-11-09"); // 金曜の夜 → 月曜
    expect(firstOpenDay(jst("2026-11-02", 7), holidayTable)).toBe("2026-11-02");
    expect(firstOpenDay(jst("2026-11-02", 20), holidayTable)).toBe("2026-11-04"); // 11/3 は文化の日
  });
});

describe("コマンド（scripts/daily.ts）の入口", () => {
  const run = (args: string[], env: Record<string, string> = {}) => {
    try {
      const out = execFileSync("node", ["--experimental-transform-types", "--disable-warning=ExperimentalWarning", "--import", "./scripts/ts-loader.mjs", "scripts/daily.ts", ...args], { env: { PATH: process.env.PATH ?? "", ...env } as unknown as NodeJS.ProcessEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      return { code: 0, out, err: "" };
    } catch (e) {
      const x = e as { status: number; stdout: string; stderr: string };
      return { code: x.status, out: x.stdout, err: x.stderr };
    }
  };

  it("使い方の誤りは終了コード2、接続の情報がなければ1。接続の文字列は出力しない", () => {
    expect(run([]).code).toBe(2);
    expect(run(["run", "--date", "2026-02-31"], { DATABASE_URL: "postgres://u:secret@127.0.0.1:1/x" })).toMatchObject({ code: 2, err: expect.stringContaining("--date") });
    expect(run(["run", "--nope"]).code).toBe(2);
    expect(run(["run", "--seed", "1"]).code).toBe(2); // 乱数の種は変えられない
    expect(run(["verify"])).toMatchObject({ code: 1, err: "daily: DATABASE_URL is not set\n" });
    const bad = run(["verify"], { DATABASE_URL: "postgres://u:secret@127.0.0.1:1/x" });
    expect(bad.code).toBe(1);
    expect(bad.err + bad.out).not.toContain("secret");
  }, 30_000);

  it("ALLOW_OWNER_ROLE は GitHub Actions では効かず、失敗にする", () => {
    expect(run(["verify"], { ALLOW_OWNER_ROLE: "1", GITHUB_ACTIONS: "true", DATABASE_URL: "postgres://u:p@127.0.0.1:1/x" })).toMatchObject({ code: 1, err: expect.stringContaining("not allowed in GitHub Actions") });
  }, 30_000);
});
