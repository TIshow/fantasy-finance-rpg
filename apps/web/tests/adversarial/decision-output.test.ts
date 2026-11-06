// 検証（verifier、#139）：AI の判断の出力が、記録の正規化（NFC・安全な整数・U+0000 を含まない）に合わないとき、
// 1つの AI のせいで、その日の全員の判断が止まらないか。runner（src/runner/day.ts）は、判断が例外を投げた AI を
// 失敗の判断の記録（ok: false）にして次の AI へ進む。出力が記録に書けない形のときも、同じく次へ進むべき
// （LLM の出力は、NFC でない文字や小数の株数を返しうる。#29 で LLM を入れる前に直す）。
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

/** その日、AI 以外の参加者（売買役7つ）がすべて注文票を確定したか */
const othersCommitted = (events: readonly LogEvent[]) => events.filter((e) => e.type === "order_sheet.committed" && p(e).agentId !== BAD && p(e).tradingDate === DAY).length;

describe("判断の出力が記録に書けない形でも、ほかの参加者の判断は進む（メモリの保管）", () => {
  // 欠陥（宛先 platform）：src/runner/day.ts の decide で、canonicalize(decision)（出力の正規化）が try の外にあり、
  // 正規化できない出力だと runDay ごと例外になる。回し直しても同じ判断を作り直すので、その日は締めまで誰も判断できない
  it.fails("投稿の本文が NFC でない（か + 結合用の濁点）", async () => {
    const r = await memoryDay(fixed({ orders: [], post: { board: COMPANIES[0]!.symbol, text: "が" }, note: "" }));
    expect(r.outcome).toBe("ok");
    expect(othersCommitted(r.events)).toBe(COMPANIES.length + 1);
  });

  it.fails("注文の株数が小数（150.5株）", async () => {
    const r = await memoryDay(fixed({ orders: [{ symbol: COMPANIES[0]!.symbol, side: "buy", qty: 150.5 }], post: null, note: "" }));
    expect(r.outcome).toBe("ok");
    expect(othersCommitted(r.events)).toBe(COMPANIES.length + 1);
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

  // 欠陥（宛先 platform）：#110 PR-2d で、正規化（checkText）が U+0000 を断るようになった。そのため、メモリの保管でも、
  // 上の NFC の場合と同じく、decide の canonicalize(decision) が try の外で例外になり、runDay ごと止まる
  it.fails("メモリの保管でも、その日の全員が注文票を確定する", async () => {
    const r = await memoryDay(bad);
    expect(r.outcome).toBe("ok");
    expect(othersCommitted(r.events)).toBe(COMPANIES.length + 1);
  });

  // 欠陥（宛先 platform）：Postgres の保管でも同じく runDaily が例外で止まる（#110 PR-2d の前は、PgValueStore.putBody が
  // 断っていた）。回し直しても同じ判断を作り直して、また止まる。その日は締めまで、後に並ぶ全員の判断がなくなる
  it.fails("Postgres の保管でも、その日の全員が注文票を確定する（回し直しを2回まで許す）", async () => {
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
  }, 120_000);
});
