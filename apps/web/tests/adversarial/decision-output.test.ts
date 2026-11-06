// 検証（verifier、#139）：AI の判断の出力が、記録の正規化（NFC・安全な整数・U+0000 を含まない）に合わないとき、
// 1つの AI のせいで、その日の全員の判断が止まらないか。runner（src/runner/day.ts）は、判断が例外を投げた AI を
// 失敗の判断の記録（ok: false）にして次の AI へ進む。出力が記録に書けない形のときも、失敗の判断の記録
// （errorCode: invalid_output）にして次へ進む（LLM の出力は、NFC でない文字や小数の株数を返しうる）。
// 以前は runDay ごと例外で止まっていた（verifier が #139 で報告し、#148 で直った）。
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { productionSetup, runDaily } from "../../scripts/daily-lib";
import type { LogEvent } from "../../src/events/types";
import { holidayTable } from "../../src/holidays";
import { IngestedMarketData } from "../../src/ingest/market-data";
import { INITIAL_CASH } from "../../src/ledger/types";
import { type Decision, type RunnerAgent, type RunnerDeps, runDay } from "../../src/runner/day";
import { RunnerValues } from "../../src/runner/values";
import { COMPANIES } from "../../src/runner/world/companies";
import { listCompanies } from "../../src/runner/world/listing";
import { liquidityAgents, setUpParticipants } from "../../src/runner/world/participants";
import { readAllEvents } from "../../src/store/pg-store";
import { InMemoryEventStore } from "../../src/store/memory-store";
import { migrate, type SqlDb } from "../../src/store/sql";
import { FakeClock, jst } from "../contracts/fakes";
import { FIXTURE_HOLIDAYS } from "../fixtures/golden";
import { openPglite, resetSchema } from "../store/pglite";

const SEED = 20261106;
const DAY = "2026-11-09";
const BAD = "ai-bad";
const p = (e: LogEvent) => e.payload as Record<string, unknown>;

/** 決まった判断を返す AI（LLM の代わり） */
const fixed = (decision: Decision): RunnerAgent => ({
  id: BAD,
  model: { provider: "fixed", modelId: "fixed", settings: {} },
  prompt: { id: "fixed", version: "1", hash: "0".repeat(64) },
  decide: () => decision,
});

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
  const outcome = await runDay(DAY, deps).then(
    () => "ok",
    (e: unknown) => `threw: ${String(e)}`,
  );
  return { outcome, events: await store.read(0, 100_000) };
}

/** 書けない出力の AI は、注文票も投稿も書かず、失敗の判断の記録（invalid_output）だけを残す */
const failedAsInvalid = (events: readonly LogEvent[]) =>
  events.some((e) => e.type === "agent.run" && p(e).agentId === BAD && p(e).ok === false && p(e).errorCode === "invalid_output") &&
  !events.some((e) => (e.type === "order_sheet.committed" || e.type === "post.published") && p(e).agentId === BAD);

/** その日、AI 以外の参加者（売買役7つ）がすべて注文票を確定したか */
const othersCommitted = (events: readonly LogEvent[]) => events.filter((e) => e.type === "order_sheet.committed" && p(e).agentId !== BAD && p(e).tradingDate === DAY).length;

describe("判断の出力が記録に書けない形でも、ほかの参加者の判断は進む（メモリの保管）", () => {
  // 直った（#148）：以前は decide の canonicalize(decision)（出力の正規化）が try の外にあり、runDay ごと例外になっていた
  it("投稿の本文が NFC でない（か + 結合用の濁点）", async () => {
    const r = await memoryDay(fixed({ orders: [], post: { board: COMPANIES[0]!.symbol, text: "が" }, note: "" }));
    expect(r.outcome).toBe("ok");
    expect(othersCommitted(r.events)).toBe(COMPANIES.length + 1);
    expect(failedAsInvalid(r.events)).toBe(true);
  });

  it("注文の株数が小数（150.5株）", async () => {
    const r = await memoryDay(fixed({ orders: [{ symbol: COMPANIES[0]!.symbol, side: "buy", qty: 150.5 }], post: null, note: "" }));
    expect(r.outcome).toBe("ok");
    expect(othersCommitted(r.events)).toBe(COMPANIES.length + 1);
    expect(failedAsInvalid(r.events)).toBe(true);
  });

  it("100株単位でない株数（150株）は、注文票の拒否として残り、ほかの参加者は進む（比較のため）", async () => {
    const r = await memoryDay(fixed({ orders: [{ symbol: COMPANIES[0]!.symbol, side: "buy", qty: 150 }], post: null, note: "" }));
    expect(r.outcome).toBe("ok");
    expect(r.events.some((e) => e.type === "order_sheet.rejected" && p(e).agentId === BAD)).toBe(true);
    expect(othersCommitted(r.events)).toBe(COMPANIES.length + 1);
  });
});

describe("投稿の本文に U+0000 があっても、ほかの参加者の判断は進む（メモリの保管と Postgres の保管）", () => {
  let pg: PGlite;
  let db: SqlDb;
  beforeAll(async () => {
    ({ pg, db } = await openPglite());
  }, 60_000);
  afterAll(() => db.close());

  const bad = fixed({ orders: [], post: { board: COMPANIES[0]!.symbol, text: "a\u0000b" }, note: "" });

  // 直った（#148）：#110 PR-2d で正規化（checkText）が U+0000 を断るようになり、メモリの保管でも runDay ごと止まっていた
  it("メモリの保管でも、その日の全員が注文票を確定する", async () => {
    const r = await memoryDay(bad);
    expect(r.outcome).toBe("ok");
    expect(othersCommitted(r.events)).toBe(COMPANIES.length + 1);
    expect(failedAsInvalid(r.events)).toBe(true);
  });

  // 直った（#148）：以前は Postgres の保管でも runDaily が例外で止まり、回し直しても同じ判断を作り直して、また止まっていた
  it("Postgres の保管でも、その日の全員が注文票を確定する（回し直しを2回まで許す）", async () => {
    await resetSchema(pg);
    await migrate(db);
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
    const o = { db, clock, waitUntil, holidayTable, prepare };
    const errors: string[] = [];
    for (let i = 0; i < 3; i++) {
      try {
        await runDaily(DAY, o);
        break;
      } catch (err) {
        errors.push(String(err)); // 回し直す
      }
    }
    const events = await readAllEvents(db);
    expect(events.filter((e) => e.type === "order_sheet.committed" && p(e).agentId !== BAD && p(e).tradingDate === DAY).length, errors.join(" / ")).toBe(3 + COMPANIES.length + 1);
    // 1回目で進む（回し直しは要らない）。書けない出力の AI は、失敗の判断の記録だけを残す
    expect(errors).toEqual([]);
    expect(failedAsInvalid(events)).toBe(true);
  }, 120_000);
});
