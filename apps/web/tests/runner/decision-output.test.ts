// 判断の出力が記録の形に直せないとき（#139、verifier の #142 の発見）：そのAIは失敗の判断の記録（ok: false、invalid_output）になり、
// ほかの参加者の判断は進む。メモリの保管でも Postgres の保管でも同じ結果になり、毎日の実行は止まらない。
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { productionSetup, runDaily, verifyDatabase } from "../../scripts/daily-lib";
import type { LogEvent } from "../../src/events/types";
import { holidayTable } from "../../src/holidays";
import { IngestedMarketData } from "../../src/ingest/market-data";
import { INITIAL_CASH } from "../../src/ledger/types";
import { type Decision, type RunnerAgent, type RunnerDeps, runDay } from "../../src/runner/day";
import { RunnerValues } from "../../src/runner/values";
import { COMPANIES } from "../../src/runner/world/companies";
import { listCompanies } from "../../src/runner/world/listing";
import { liquidityAgents, setUpParticipants } from "../../src/runner/world/participants";
import { InMemoryEventStore } from "../../src/store/memory-store";
import { readAllEvents } from "../../src/store/pg-store";
import { migrate, type SqlDb } from "../../src/store/sql";
import { FakeClock, jst } from "../contracts/fakes";
import { FIXTURE_HOLIDAYS } from "../fixtures/golden";
import { openPglite, resetSchema } from "../store/pglite";

const SEED = 20261106;
const DAY = "2026-11-09";
const BAD = "ai-bad";
const p = (e: LogEvent) => e.payload as Record<string, unknown>;

const fixed = (decision: Decision): RunnerAgent => ({
  id: BAD,
  model: { provider: "fixed", modelId: "fixed", settings: {} },
  prompt: { id: "fixed", version: "1", hash: "0".repeat(64) },
  decide: () => decision,
});

/** 記録の形に直せない出力（どれも、そのAIだけが失敗の判断の記録になる） */
const BAD_OUTPUTS: [string, Decision][] = [
  ["投稿の本文が NFC でない", { orders: [], post: { board: COMPANIES[0]!.symbol, text: "が" }, note: "" }],
  ["投稿の本文に U+0000", { orders: [], post: { board: COMPANIES[0]!.symbol, text: "a\u0000b" }, note: "" }],
  ["説明に U+0000", { orders: [], post: null, note: "a\u0000b" }],
  ["注文の株数が小数", { orders: [{ symbol: COMPANIES[0]!.symbol, side: "buy", qty: 150.5 }], post: null, note: "" }],
  // 形が違う出力（LLM は型を守らないことがある）
  ["投稿の本文が文字列でない", { orders: [], post: { board: COMPANIES[0]!.symbol, text: 123 }, note: "" } as unknown as Decision],
  ["投稿に掲示板がない", { orders: [], post: { text: "x" }, note: "" } as unknown as Decision],
  ["注文が配列でない", { orders: { symbol: COMPANIES[0]!.symbol }, post: null, note: "" } as unknown as Decision],
  ["説明が文字列でない", { orders: [], post: null, note: 1 } as unknown as Decision],
];

/** 6社の上場・売買役の登録・AI 1体（先に判断する）をメモリの保管に用意し、1日回す */
async function memoryDay(bad: RunnerAgent) {
  const clock = new FakeClock(jst("2026-11-06", 18));
  const holidayTables = new Map([[FIXTURE_HOLIDAYS.contentSha256, FIXTURE_HOLIDAYS]]);
  const values = new RunnerValues(() => new Uint8Array(16).fill(7));
  const store = new InMemoryEventStore(values, holidayTables, clock);
  await store.append({ type: "holidays.adopted", actor: "operator:owner", refs: [], payload: { holidaysSha256: FIXTURE_HOLIDAYS.contentSha256 } });
  await listCompanies(store, SEED);
  await setUpParticipants(store, DAY);
  await store.append({ type: "agent.registered", actor: "operator:owner", refs: [], payload: { agentId: BAD, displayName: BAD, startDate: DAY, initialCash: INITIAL_CASH } });
  const waitUntil = async (at: number) => {
    if (at > clock.now()) clock.set(at);
  };
  const deps: RunnerDeps = { store, market: new IngestedMarketData(clock), values, holidayTables, agents: [bad, ...(await liquidityAgents(SEED))], clock, waitUntil };
  await runDay(DAY, deps);
  const events = await store.read(0, 100_000);
  // 回し直しても何も書かない（失敗を記録済みなので、判断をやり直さない）
  await runDay(DAY, deps);
  expect(await store.read(0, 100_000)).toHaveLength(events.length);
  return events;
}

const othersCommitted = (events: readonly LogEvent[]) => events.filter((e) => e.type === "order_sheet.committed" && p(e).agentId !== BAD && p(e).tradingDate === DAY).length;
const badRuns = (events: readonly LogEvent[]) => events.filter((e) => e.type === "agent.run" && p(e).agentId === BAD).map((e) => ({ ok: p(e).ok, errorCode: p(e).errorCode }));

describe("判断の出力が記録の形に直せないとき（メモリの保管）", () => {
  for (const [name, decision] of BAD_OUTPUTS) {
    it(`${name}：そのAIは失敗の判断の記録（invalid_output）になり、ほかの参加者は注文票を確定する`, async () => {
      const events = await memoryDay(fixed(decision));
      expect(badRuns(events)).toEqual([{ ok: false, errorCode: "invalid_output" }]);
      expect(events.some((e) => (e.type === "post.published" || e.type.startsWith("order_sheet")) && p(e).agentId === BAD)).toBe(false);
      expect(othersCommitted(events)).toBe(COMPANIES.length + 1);
    });
  }

  it("判断が例外を投げたAIは、これまでどおり provider_error", async () => {
    const events = await memoryDay({ ...fixed({ orders: [], post: null, note: "" }), decide: () => Promise.reject(new Error("boom")) });
    expect(badRuns(events)).toEqual([{ ok: false, errorCode: "provider_error" }]);
    expect(othersCommitted(events)).toBe(COMPANIES.length + 1);
  });
});

describe("判断の出力が記録の形に直せないとき（Postgres の保管、毎日の実行）", () => {
  let pg: PGlite;
  let db: SqlDb;
  beforeAll(async () => {
    ({ pg, db } = await openPglite());
  }, 60_000);
  afterAll(() => db.close());

  it("投稿の本文に U+0000 があっても、毎日の実行は止まらず、メモリの保管と同じ結果になり、照合が一致する", async () => {
    await resetSchema(pg);
    await migrate(db);
    const bad = fixed(BAD_OUTPUTS[1]![1]);
    const clock = new FakeClock(jst(DAY, 6, 50));
    const waitUntil = async (at: number) => {
      if (at > clock.now()) clock.set(at);
    };
    const prepare: Parameters<typeof runDaily>[1]["prepare"] = async (ctx) => {
      const agents = await productionSetup(ctx);
      if (!(await ctx.store.read(0, 1000)).some((e) => e.type === "agent.registered" && p(e).agentId === BAD)) {
        const r = await ctx.store.append({ type: "agent.registered", actor: "operator:owner", refs: [], payload: { agentId: BAD, displayName: BAD, startDate: DAY, initialCash: INITIAL_CASH } });
        if (!r.ok) throw new Error(r.reason);
      }
      return [bad, ...agents];
    };
    await runDaily(DAY, { db, clock, waitUntil, holidayTable, prepare });
    const events = await readAllEvents(db);
    // もう一度回しても、何も書かない
    await runDaily(DAY, { db, clock, waitUntil, holidayTable, prepare });
    expect(await readAllEvents(db)).toHaveLength(events.length);
    expect(badRuns(events)).toEqual([{ ok: false, errorCode: "invalid_output" }]);
    // AI投資家3体・マーケットメイカー6・ばらばらの参加者1
    expect(events.filter((e) => e.type === "order_sheet.committed" && p(e).agentId !== BAD && p(e).tradingDate === DAY)).toHaveLength(10);
    await verifyDatabase(db, holidayTable);
  }, 120_000);
});
