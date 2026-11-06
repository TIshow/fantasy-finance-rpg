// 締めのあとの実行（#139）：朝に注文票を確定したAIは「締めに間に合わなかった」と数えず、判断の記録がないAIだけを数える。
import { describe, expect, it } from "vitest";
import { missedCutoff } from "../../scripts/daily-lib";
import { IngestedMarketData } from "../../src/ingest/market-data";
import { INITIAL_CASH } from "../../src/ledger/types";
import { type RunnerAgent, type RunnerDeps, runDay } from "../../src/runner/day";
import { RunnerValues } from "../../src/runner/values";
import { listCompanies } from "../../src/runner/world/listing";
import { setUpParticipants } from "../../src/runner/world/participants";
import { InMemoryEventStore } from "../../src/store/memory-store";
import { FakeClock, jst } from "../contracts/fakes";
import { FIXTURE_HOLIDAYS } from "../fixtures/golden";

const DAY = "2026-11-09";
const agent = (id: string): RunnerAgent => ({
  id,
  model: { provider: "fixed", modelId: "fixed", settings: {} },
  prompt: { id: "fixed", version: "1", hash: "0".repeat(64) },
  decide: () => ({ orders: [], post: null, note: "" }),
});

describe("締めのあとの実行", () => {
  it("A は朝に注文票を確定済み、B は判断の記録なし：詳細は B だけになり、記録は増えず、締めに間に合わなかったと見分けられる", async () => {
    const clock = new FakeClock(jst("2026-11-06", 18));
    const holidayTables = new Map([[FIXTURE_HOLIDAYS.contentSha256, FIXTURE_HOLIDAYS]]);
    const values = new RunnerValues(() => new Uint8Array(16).fill(7));
    const store = new InMemoryEventStore(values, holidayTables, clock);
    await store.append({ type: "holidays.adopted", actor: "operator:owner", refs: [], payload: { holidaysSha256: FIXTURE_HOLIDAYS.contentSha256 } });
    await listCompanies(store, 20261106);
    await setUpParticipants(store, DAY);
    for (const id of ["ai-a", "ai-b"]) await store.append({ type: "agent.registered", actor: "operator:owner", refs: [], payload: { agentId: id, displayName: id, startDate: DAY, initialCash: INITIAL_CASH } });
    const waitUntil = async (at: number) => {
      if (at > clock.now()) clock.set(at);
    };
    const deps = (agents: RunnerAgent[]): RunnerDeps => ({ store, market: new IngestedMarketData(clock), values, holidayTables, agents, clock, waitUntil });
    // 朝の実行は A だけが判断する（B は動かない）。1日の最後まで進める
    await runDay(DAY, deps([agent("ai-a")]));
    const before = await store.read(0, 100_000);
    expect(before.some((e) => e.type === "order_sheet.committed" && (e.payload as { agentId: string }).agentId === "ai-a")).toBe(true);
    // 締めのあとの実行：A と B の両方を渡す
    const results = await runDay(DAY, deps([agent("ai-a"), agent("ai-b")]));
    expect(results.find((r) => r.stage === "decide")).toEqual({ stage: "decide", status: "skipped", detail: "after the cutoff: ai-b" });
    expect(await store.read(0, 100_000)).toHaveLength(before.length);
    expect(missedCutoff(results)).toBe(true);
  });
});
