// 毎日の実行が LLM の AI 投資家を使う設定（環境変数）と、登録・失敗の印の試験（#179）。本物の API は呼ばない（口は作るだけ）。
import { describe, expect, it } from "vitest";
import { LLM_DAILY_COST_LIMIT } from "../../src/events/llm-cost";
import { RunnerValues } from "../../src/runner/values";
import { InMemoryEventStore } from "../../src/store/memory-store";
import { llmDepsFromEnv, llmFailed, missedCutoff, productionSetup } from "../../scripts/daily-lib";
import { FakeClock, jst } from "../contracts/fakes";
import { FIXTURE_HOLIDAYS } from "../fixtures/golden";

const clock = new FakeClock(jst("2026-11-06", 18));

describe("llmDepsFromEnv", () => {
  it("LLM_ENABLED が true のときだけ使う", () => {
    expect(llmDepsFromEnv({}, clock)).toBeUndefined();
    expect(llmDepsFromEnv({ LLM_ENABLED: "1" }, clock)).toBeUndefined();
    expect(llmDepsFromEnv({ LLM_ENABLED: "true" }, clock)?.investors.map((a) => a.id)).toEqual(["ai-claude", "ai-gpt", "ai-gemini"]);
  });

  it("試運転は、LLM_DRY_RUN が false のときだけ切る（書き忘れたら投稿だけ）。上限は記録の上限、円は160", () => {
    expect(llmDepsFromEnv({ LLM_ENABLED: "true" }, clock)?.policy).toEqual({ dailyCostLimit: LLM_DAILY_COST_LIMIT, dryRun: true });
    expect(llmDepsFromEnv({ LLM_ENABLED: "true", LLM_DRY_RUN: "no" }, clock)?.policy.dryRun).toBe(true);
    expect(llmDepsFromEnv({ LLM_ENABLED: "true", LLM_DRY_RUN: "false" }, clock)?.policy.dryRun).toBe(false);
    expect(llmDepsFromEnv({ LLM_ENABLED: "true" }, clock)?.yenPerUsd).toBe(160);
  });

  it("API キーがなければ、その提供元の口を作るときに断る（キーの値は文に出さない）。知らない提供元も断る", () => {
    const keys = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY"];
    const saved = keys.map((k) => process.env[k]);
    for (const k of keys) delete process.env[k];
    try {
      const deps = llmDepsFromEnv({ LLM_ENABLED: "true" }, clock)!;
      for (const p of ["anthropic", "openai", "google"]) expect(() => deps.portOf(p)).toThrow(/API_KEY/);
      expect(() => deps.portOf("other")).toThrow(RangeError);
      process.env.ANTHROPIC_API_KEY = "sk-ant-test-not-a-real-key";
      expect(deps.portOf("anthropic")).toBe(deps.portOf("anthropic"));
      expect(deps.portOf("anthropic").policy.dryRun).toBe(true);
    } finally {
      keys.forEach((k, i) => (saved[i] === undefined ? delete process.env[k] : (process.env[k] = saved[i])));
    }
  });
});

describe("登録と失敗の印", () => {
  it("LLM の AI 投資家を、規則の AI と同じ形で登録する。runner に返す参加者には入れない", async () => {
    const holidayTables = new Map([[FIXTURE_HOLIDAYS.contentSha256, FIXTURE_HOLIDAYS]]);
    const store = new InMemoryEventStore(new RunnerValues(), holidayTables, clock);
    const deps = llmDepsFromEnv({ LLM_ENABLED: "true" }, clock)!;
    const agents = await productionSetup({ store, clock, seed: 1, holidayTable: FIXTURE_HOLIDAYS, llmInvestors: deps.investors });
    const registered = (await store.read(0, 10_000)).filter((e) => e.type === "agent.registered").map((e) => (e.payload as { agentId: string }).agentId);
    expect(registered).toEqual(expect.arrayContaining(["ai-ma5", "ai-claude", "ai-gpt", "ai-gemini"]));
    expect(agents.map((a) => a.id)).not.toContain("ai-claude");
  });

  it("LLM の段の例外（detail が error: で始まる）は失敗の印。締めに間に合わなかった印とは別", () => {
    expect(llmFailed([{ stage: "llm.submit", status: "skipped", detail: "error: OPENAI_API_KEY is not set" }])).toBe(true);
    expect(llmFailed([{ stage: "llm.submit", status: "skipped", detail: "not the evening before 2026-11-10" }])).toBe(false);
    expect(missedCutoff([{ stage: "llm.submit", status: "skipped", detail: "error: x" }])).toBe(false);
  });
});
