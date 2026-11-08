// LLM で考える AI 投資家3体（#179）。Claude・GPT・Gemini に、同じプロンプトと同じ入力の文を渡す。違うのはモデルだけ。
// 規則で動く3体（rule-agents.ts）は、比べる基準として残す。
// 設定は出力の上限（max_tokens）だけ。temperature などは送らず、各モデルの標準の設定で動かす（#179 の lead の決定10）。
import type { LlmBatchRequest, LlmMessage, LlmModel, LlmPrompt } from "../contracts";
import { ANTHROPIC_MAX_OUTPUT_TOKENS, ANTHROPIC_PROVIDER } from "../llm/anthropic-port";
import { batchReservationOf } from "../llm/batch-plan";
import { LLM_BATCH_MODEL_IDS, YEN_PER_USD } from "../llm/batch-port";
import { GEMINI_PROVIDER } from "../llm/gemini-batch";
import { GEMINI_MAX_OUTPUT_TOKENS } from "../llm/gemini-port";
import { INVESTOR_SYSTEM_PROMPT } from "../llm/investor-prompt";
import { OPENAI_MAX_OUTPUT_TOKENS, OPENAI_PROVIDER } from "../llm/openai-port";

export interface LlmInvestor {
  /** agentId（登録と同じ） */
  id: string;
  model: LlmModel;
}

const model = (provider: string, modelId: string, maxTokens: number): LlmModel => Object.freeze({ provider, modelId, settings: Object.freeze({ max_tokens: String(maxTokens) }) });

export const LLM_INVESTORS: readonly LlmInvestor[] = Object.freeze([
  { id: "ai-claude", model: model(ANTHROPIC_PROVIDER, LLM_BATCH_MODEL_IDS.anthropic, ANTHROPIC_MAX_OUTPUT_TOKENS) },
  { id: "ai-gpt", model: model(OPENAI_PROVIDER, LLM_BATCH_MODEL_IDS.openai, OPENAI_MAX_OUTPUT_TOKENS) },
  { id: "ai-gemini", model: model(GEMINI_PROVIDER, LLM_BATCH_MODEL_IDS.google, GEMINI_MAX_OUTPUT_TOKENS) },
]);

/** 送るメッセージ：指示の文（system）と入力の文（user）。3体で同じ */
export const investorMessages = (userText: string): LlmMessage[] => [
  { role: "system", content: INVESTOR_SYSTEM_PROMPT },
  { role: "user", content: userText },
];

/**
 * バッチに依頼する1件。予約（料金・トークン数の上限・maxCost）は batchReservationOf で submittedAt の時点の料金から決める。
 * yenPerUsd は1ドルあたりの円（owner の決定で160。2026-11-07）
 */
export function investorRequest(a: LlmInvestor, x: { prompt: LlmPrompt; tradingDate: string; submittedAt: number; inputSeqs: number[]; userText: string; yenPerUsd?: number }): LlmBatchRequest {
  const r = batchReservationOf(a.model, x.submittedAt, x.yenPerUsd ?? YEN_PER_USD);
  return {
    agentId: a.id,
    purpose: "order",
    model: a.model,
    prompt: x.prompt,
    inputSeqs: x.inputSeqs,
    messages: investorMessages(x.userText),
    maxCost: r.maxCost,
    tradingDate: x.tradingDate,
    submittedAt: x.submittedAt,
    reservePrice: r.reservePrice,
    maxInputTokens: r.maxInputTokens,
    maxOutputTokens: r.maxOutputTokens,
  };
}
