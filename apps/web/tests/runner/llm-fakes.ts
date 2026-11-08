// 毎日の実行の LLM の段の試験に使う、偽の提供元（#179）。本物の API は呼ばない。
// 口そのもの（BatchPort）は本物を使い、提供元ごとの違い（BatchDriver）だけを偽にする（本文・ハッシュ・customId・予約の確かめは本物のまま）。
import type { Clock, LlmFindResult, LlmPolicy, LlmSendResult } from "../../src/contracts";
import { ANTHROPIC_MAX_OUTPUT_TOKENS, anthropicReservePrice } from "../../src/llm/anthropic-port";
import { BatchPort, type BatchDriver, type BatchOutcome, YEN_PER_USD } from "../../src/llm/batch-port";
import { GEMINI_PROVIDER } from "../../src/llm/gemini-batch";
import { GEMINI_MAX_OUTPUT_TOKENS, geminiReservePrice } from "../../src/llm/gemini-port";
import { OPENAI_INPUT_COST_FACTOR, OPENAI_MAX_OUTPUT_TOKENS, openaiReservePrice } from "../../src/llm/openai-port";
import { LLM_INVESTORS } from "../../src/runner/llm-agents";
import type { LlmDeps } from "../../src/runner/llm-stage";

export interface FakeProvider {
  /** 送った本文 */
  sent: string[];
  cancels: string[];
  finds: number;
  send: () => LlmSendResult;
  find: () => LlmFindResult;
  /** 受け取りの様子（バッチのID ごと）。既定は pending */
  outcome: (batchId: string) => BatchOutcome | "pending";
}

const SPEC = {
  anthropic: { maxOutputTokens: ANTHROPIC_MAX_OUTPUT_TOKENS, inputCostFactor: 1, priceAt: (m: string) => anthropicReservePrice(m) },
  openai: { maxOutputTokens: OPENAI_MAX_OUTPUT_TOKENS, inputCostFactor: OPENAI_INPUT_COST_FACTOR, priceAt: (m: string) => openaiReservePrice(m) },
  [GEMINI_PROVIDER]: { maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS, inputCostFactor: 1, priceAt: geminiReservePrice },
} as const;

/** 答えの出力（usage は小さめ。費用は予約よりずっと小さい） */
export const answer = (output: string, extra: Partial<Extract<BatchOutcome, { kind: "succeeded" }>> = {}): BatchOutcome => ({
  kind: "succeeded",
  output,
  respondedModel: "fake-model-version",
  usage: { inputTokens: 5000, outputTokens: 800, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
  truncated: false,
  ...extra,
});

/** 3社の偽の提供元と、毎日の実行に渡す設定 */
export function fakeLlm(clock: Clock, policy: LlmPolicy = { dailyCostLimit: 1000, dryRun: false }) {
  let n = 0;
  const providers: Record<string, FakeProvider> = {};
  const ports = new Map<string, BatchPort>();
  for (const provider of Object.keys(SPEC) as (keyof typeof SPEC)[]) {
    const f: FakeProvider = { sent: [], cancels: [], finds: 0, send: () => ({ ok: true, batchId: `${provider}-batch-${++n}` }), find: () => ({ status: "not_found" }), outcome: () => "pending" };
    providers[provider] = f;
  }
  const driverOf = (provider: keyof typeof SPEC): BatchDriver => {
    const f = providers[provider]!;
    return {
      provider,
      settingKeys: ["max_tokens"],
      ...SPEC[provider],
      body: (r, itemId) => JSON.stringify({ id: itemId, model: r.model.modelId, max_tokens: r.model.settings.max_tokens, messages: r.messages }),
      send: async (body) => (f.sent.push(body), f.send()),
      find: async () => ((f.finds += 1), f.find()),
      outcome: async (t) => f.outcome(t.batchId),
      cancel: async (id) => (f.cancels.push(id), true),
    };
  };
  const deps: LlmDeps = {
    investors: LLM_INVESTORS,
    policy,
    yenPerUsd: YEN_PER_USD,
    portOf(provider, c) {
      if (!(provider in SPEC)) throw new RangeError(`unknown provider ${provider}`);
      const make = () => new BatchPort(driverOf(provider as keyof typeof SPEC), { policy, clock: c ?? clock });
      if (c) return make();
      if (!ports.has(provider)) ports.set(provider, make());
      return ports.get(provider)!;
    },
  };
  return { deps, providers };
}
