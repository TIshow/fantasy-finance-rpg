// 毎日の流れを、Postgres のイベントの保管（PgEventStore）と値の保管（PgValueStore）で回す（#30 の前の準備）。PGlite（Docker なし）。
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PriceObservation } from "../../src/contracts";
import type { LogEvent } from "../../src/events/types";
import { IngestedMarketData, type SourceQuote } from "../../src/ingest/market-data";
import { INITIAL_CASH } from "../../src/ledger/types";
import { type RunnerDeps, runDay, scheduleOf } from "../../src/runner/day";
import { ruleAgents } from "../../src/runner/rule-agents";
import { PgEventStore } from "../../src/store/pg-store";
import { PgValueStore } from "../../src/store/pg-values";
import { migrate, type SqlDb } from "../../src/store/sql";
import { FakeClock } from "../contracts/fakes";
import { FIXTURE_HOLIDAYS } from "../fixtures/golden";
import { mulberry32 } from "../fixtures/prng";
import { PRIOR_DAY, TRADING_DAYS, buildScenario } from "../fixtures/scenario";
import { openPglite, resetSchema } from "../store/pglite";

const toQuote = ({ fetchedAt: _, ...o }: PriceObservation): SourceQuote => o;
const p = (e: LogEvent) => e.payload as Record<string, unknown>;
const holidayTables = new Map([[FIXTURE_HOLIDAYS.contentSha256, FIXTURE_HOLIDAYS]]);

let pg: PGlite;
let db: SqlDb;
beforeAll(async () => {
  ({ pg, db } = await openPglite());
  await resetSchema(pg);
  await migrate(db);
}, 60_000);
afterAll(() => db.close());

describe("runDay を Postgres の保管で回す", () => {
  it("値の口に PgValueStore を渡せて、5営業日を回せる。最後の日に判断を記録したあと落ちても、開き直した保管から続きを補える", async () => {
    const scenario = buildScenario(7);
    const clock = new FakeClock(0);
    const rand = mulberry32(5);
    const values = await PgValueStore.open(db, () => Uint8Array.from({ length: 16 }, () => Math.floor(rand() * 256)));
    const store = await PgEventStore.open(db, { values, holidayTables, clock });
    const market = new IngestedMarketData(clock);
    const pending = [...scenario.observations].sort((a, b) => a.fetchedAt - b.fetchedAt);
    const waitUntil = async (at: number) => {
      while (pending.length > 0 && pending[0]!.fetchedAt <= at) {
        const o = pending.shift()!;
        if (o.fetchedAt > clock.now()) clock.set(o.fetchedAt);
        market.capture([toQuote(o)]);
      }
      if (at > clock.now()) clock.set(at);
    };
    const agents = await ruleAgents();
    const deps: RunnerDeps = { store, market, values, holidayTables, agents, clock, waitUntil };
    const op = (type: "holidays.adopted" | "universe.set" | "agent.registered", payload: Record<string, unknown>) => store.append({ type, actor: "operator:owner", refs: [], payload });
    await op("holidays.adopted", { holidaysSha256: FIXTURE_HOLIDAYS.contentSha256 });
    await op("universe.set", { symbols: [...scenario.symbols] });
    await runDay(PRIOR_DAY, deps);
    await waitUntil(scheduleOf(PRIOR_DAY).closeAt + 3 * 3_600_000);
    for (const a of agents) await op("agent.registered", { agentId: a.id, displayName: a.id, startDate: TRADING_DAYS[0], initialCash: INITIAL_CASH });
    for (const d of TRADING_DAYS.slice(0, -1)) await runDay(d, deps);
    // 最後の日は、最初のAIの注文票の確定で落ちる（agent.run と投稿は書いたあと）
    const last = TRADING_DAYS.at(-1)!;
    const crashing: RunnerDeps = { ...deps, store: { read: (a, l) => store.read(a, l), last: () => store.last(), append: (d) => store.append(d), commitSheet: (id, sheet) => (id === agents[0]!.id ? Promise.reject(new Error("crashed")) : store.commitSheet(id, sheet)) } };
    await expect(runDay(last, crashing)).rejects.toThrow("crashed");
    const before = await store.read(0, 100_000);
    const firstRuns = (xs: readonly LogEvent[]) => xs.filter((e) => e.type === "agent.run" && p(e).agentId === agents[0]!.id).map((e) => e.seq);
    const runsBefore = firstRuns(before);

    // 落ちたあとの新しい処理：DB から開き直し、同じ日を回し直す
    const reopenedValues = await PgValueStore.open(db);
    const reopened = await PgEventStore.open(db, { values: reopenedValues, holidayTables, clock });
    await runDay(last, { ...deps, store: reopened, values: reopenedValues });
    const events = await reopened.read(0, 100_000);
    expect(events.slice(0, before.length)).toEqual(before);
    // 落ちたAIの判断はやり直さず、記録した run から注文票を確定する（ほかのAIは、落ちたあとに判断する）
    expect(firstRuns(events)).toEqual(runsBefore);
    const firstSheet = events.find((e) => e.type === "order_sheet.committed" && p(e).agentId === agents[0]!.id && p(e).tradingDate === last)!;
    expect(runsBefore).toContain(p(firstSheet).runSeq);
    expect(events.filter((e) => e.type === "order_sheet.committed" && p(e).tradingDate === last).map((e) => p(e).agentId)).toEqual(agents.map((a) => a.id));
    expect(events.filter((e) => e.type === "valuation.recorded").length).toBe(agents.length * TRADING_DAYS.length);

    // 開き直した値の口から、判断の出力・投稿の本文・終値の値が、もとと同じに引ける
    for (const e of before.filter((x) => x.type === "agent.run" && p(x).ok === true)) expect(reopenedValues.body(p(e).outputHash as string)?.value).toBe(values.body(p(e).outputHash as string)!.value);
    for (const e of before.filter((x) => x.type === "post.published")) expect(reopenedValues.body(p(e).bodyHash as string)?.value).toBe(values.body(p(e).bodyHash as string)!.value);
    for (const e of before.filter((x) => x.type === "prices.close")) expect(reopenedValues.get(p(e).valuesHash as string)?.value).toEqual(values.get(p(e).valuesHash as string)!.value);
    // もう一度回しても何も書かない
    await runDay(last, { ...deps, store: reopened, values: reopenedValues });
    expect((await reopened.last())?.seq).toBe(events.at(-1)!.seq);
  }, 60_000);
});
