// 検証役（大枠 #139：#113 PR-3b・#138 の確認）。架空の6社の市場を、メモリの保管と Postgres（PGlite）の保管で
// 同じように回し、保管の違いで記録や台帳が変わらないか、決算の発表が先読みに使われないかを確かめる。
// 成り立つはずのこと（#113 の lead コメント、MARKET_DESIGN §5、EVENT_LOG §3.2）：
// (1) 同じ時計・同じ salt の並びなら、メモリと PGlite で、記録（ハッシュまで）も、作り直した台帳も同じになる
// (2) どの注文票の入力の決算の発表も、その約定日の締めより前に記録したもの。マーケットメイカーは、締めより前に発表済みの
//     直近の四半期を入力から落とさない（後の発表を使わず、前の発表を抜かさない）
// (3) 上場の直後の発表のあとの決算の発表は、大引け（15:30）より後にしか記録できない（MARKET_DESIGN §5「決算は引け後 15:30」）
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EventStore } from "../../src/contracts";
import { verifyChain } from "../../src/events/chain";
import { replay } from "../../src/events/replay";
import type { LogEvent } from "../../src/events/types";
import { IngestedMarketData } from "../../src/ingest/market-data";
import { cutoffOf } from "../../src/ledger/ledger";
import { INITIAL_CASH } from "../../src/ledger/types";
import { type RunnerDeps, runDay } from "../../src/runner/day";
import { ruleAgents } from "../../src/runner/rule-agents";
import { RunnerValues } from "../../src/runner/values";
import { COMPANIES } from "../../src/runner/world/companies";
import { discloseDue } from "../../src/runner/world/disclosure";
import { listCompanies } from "../../src/runner/world/listing";
import { liquidityAgents, makerId, setUpParticipants } from "../../src/runner/world/participants";
import { InMemoryEventStore } from "../../src/store/memory-store";
import { PgEventStore, readAllEvents } from "../../src/store/pg-store";
import { PgValueStore, type ValuesPort } from "../../src/store/pg-values";
import { migrate, type SqlDb } from "../../src/store/sql";
import { FakeClock, jst } from "../contracts/fakes";
import { FIXTURE_HOLIDAYS } from "../fixtures/golden";
import { mulberry32 } from "../fixtures/prng";
import { openPglite, resetSchema } from "../store/pglite";

const SEED = 20261106;
/** 1四半期を3日にして、8営業日のうちに2回の発表を起こす */
const QUARTER = 3;
const DAYS = ["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-16", "2026-11-17", "2026-11-18"];
const AIS = ["ai-ma5", "ai-reversal", "ai-hold"];
const HOUR = 3_600_000;
const holidayTables = new Map([[FIXTURE_HOLIDAYS.contentSha256, FIXTURE_HOLIDAYS]]);
const p = (e: LogEvent) => e.payload as Record<string, unknown>;
const salts = () => {
  const rand = mulberry32(0x139);
  return () => Uint8Array.from({ length: 16 }, () => Math.floor(rand() * 256));
};

let pg: PGlite;
let db: SqlDb;
beforeAll(async () => {
  ({ pg, db } = await openPglite());
  await resetSchema(pg);
  await migrate(db);
}, 60_000);
afterAll(() => db.close());

/** 前営業日の夜に上場・最初の発表・登録をして、days を回す。毎日の引けのあとに決算の発表を呼ぶ */
async function run(open: (clock: FakeClock) => Promise<{ store: EventStore; values: ValuesPort }>) {
  const clock = new FakeClock(jst("2026-11-06", 18));
  const { store, values } = await open(clock);
  const agents = [...(await ruleAgents()), ...(await liquidityAgents(SEED))];
  const deps: RunnerDeps = { store, market: new IngestedMarketData(clock), values, holidayTables, agents, clock, waitUntil: async (at) => void (at > clock.now() && clock.set(at)), inputDays: 5 };
  await store.append({ type: "holidays.adopted", actor: "operator:owner", refs: [], payload: { holidaysSha256: FIXTURE_HOLIDAYS.contentSha256 } });
  await listCompanies(store, SEED);
  await discloseDue(store, SEED, clock, COMPANIES, QUARTER);
  await setUpParticipants(store, DAYS[0]!);
  for (const id of AIS) await store.append({ type: "agent.registered", actor: "operator:owner", refs: [], payload: { agentId: id, displayName: id, startDate: DAYS[0], initialCash: INITIAL_CASH } });
  for (const d of DAYS) {
    await runDay(d, deps);
    await discloseDue(store, SEED, clock, COMPANIES, QUARTER);
  }
  const events: LogEvent[] = [];
  for (let page = await store.read(); page.length > 0; page = await store.read(page.at(-1)!.seq)) events.push(...page);
  return { events, values, store, clock };
}

describe("メモリと PGlite の保管で、架空の市場を8営業日回す", () => {
  let mem: Awaited<ReturnType<typeof run>>;
  let pgw: Awaited<ReturnType<typeof run>>;
  let ids: string[] = [];
  beforeAll(async () => {
    mem = await run(async (clock) => {
      const values = new RunnerValues(salts());
      return { values, store: new InMemoryEventStore(values, holidayTables, clock) };
    });
    pgw = await run(async (clock) => {
      const values = await PgValueStore.open(db, salts());
      return { values, store: await PgEventStore.open(db, { values, holidayTables, clock }) };
    });
    ids = mem.events.filter((e) => e.type === "agent.registered").map((e) => p(e).agentId as string);
  }, 300_000);

  it("記録はハッシュまで同じで、DB に残った行も同じ。作り直した台帳の口座も同じ", async () => {
    expect(mem.events.filter((e) => e.type === "company.disclosed").length).toBe(18);
    expect(pgw.events).toEqual(mem.events);
    expect(await readAllEvents(db)).toEqual(mem.events);
    expect(await verifyChain(pgw.events)).toEqual([]);
    const fromMem = await replay(mem.events, mem.values, { holidayTables });
    const fromDb = await replay(await readAllEvents(db), await PgValueStore.open(db), { holidayTables });
    for (const id of ids) {
      expect(fromDb.account(id)).toEqual(fromMem.account(id));
      expect(fromDb.account(id)).toEqual((mem.store as InMemoryEventStore).account(id));
    }
  });

  it("どの注文票の入力の決算の発表も、約定日の締めより前の記録。マーケットメイカーは、それまでの直近の発表を落とさない", () => {
    const events = mem.events;
    const disclosed = events.filter((e) => e.type === "company.disclosed");
    for (const sheet of events.filter((e) => e.type === "order_sheet.committed")) {
      const date = p(sheet).tradingDate as string;
      const inputs = (p(sheet).inputSeqs as number[]).map((s) => events[s - 1]!);
      for (const e of inputs.filter((x) => x.type === "company.disclosed")) expect(e.recordedAt, `sheet ${sheet.seq} uses disclosure ${e.seq}`).toBeLessThan(cutoffOf(date));
      const maker = COMPANIES.find((c) => makerId(c.symbol) === p(sheet).agentId);
      if (!maker) continue;
      const expected = disclosed.filter((e) => p(e).symbol === maker.symbol && e.recordedAt < cutoffOf(date)).slice(-4).map((e) => e.seq);
      const run = events[(p(sheet).runSeq as number) - 1]!;
      const own = (p(run).inputSeqs as number[]).filter((s) => events[s - 1]!.type === "company.disclosed" && p(events[s - 1]!).symbol === maker.symbol);
      expect(own.sort((a, b) => a - b), `sheet ${sheet.seq} on ${date}`).toEqual(expected);
    }
  });

  it("上場の直後の発表のほかは、板寄せの日の15:30より後、次の営業日の締めより前に記録する", () => {
    const later = mem.events.filter((e) => e.type === "company.disclosed").slice(COMPANIES.length);
    expect(later.length).toBe(12);
    for (const e of later) {
      const i = DAYS.findIndex((d) => e.recordedAt >= cutoffOf(d) + 7 * HOUR && (DAYS[DAYS.indexOf(d) + 1] === undefined || e.recordedAt < cutoffOf(DAYS[DAYS.indexOf(d) + 1]!)));
      expect(i, `disclosure ${e.seq}`).toBeGreaterThanOrEqual(0);
      expect((i + 1) % QUARTER).toBe(0);
    }
  });
});

// 欠陥（宛先：core、src/events/append.ts の company.disclosed）：決算の発表の記録の時刻を確かめていない。
// runner は時計で 15:30 より後に書くが、検査は通すので、取引時間の途中（10:00）に書いた発表も保管・照合の両方が受け入れる。
// MARKET_DESIGN §5 は「決算は引け後 15:30」。上場の直後の最初の発表をどう扱うか（上場の時刻に合わせるか）は lead が決める
it.fails("上場の直後の発表のあと、次の四半期の発表を取引日の 10:00 に書こうとすると断る", async () => {
  const clock = new FakeClock(jst("2026-11-06", 18));
  const values = new RunnerValues(salts());
  const store = new InMemoryEventStore(values, holidayTables, clock);
  await store.append({ type: "holidays.adopted", actor: "operator:owner", refs: [], payload: { holidaysSha256: FIXTURE_HOLIDAYS.contentSha256 } });
  await listCompanies(store, SEED);
  expect((await discloseDue(store, SEED, clock, COMPANIES, QUARTER)).length).toBe(COMPANIES.length);
  clock.set(jst("2026-11-10", 10));
  const listing = (await store.read(0, 1000)).find((e) => e.type === "company.listed" && p(e).symbol === COMPANIES[0]!.symbol)!;
  const r = await store.append({ type: "company.disclosed", actor: "system", refs: [listing.seq], payload: { symbol: COMPANIES[0]!.symbol, period: "2026-Q4", revenue: 1, netIncome: 1, eps: 10, dividendPerShare: 0 } });
  expect(r.ok).toBe(false);
});
