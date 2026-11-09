// OpenAI の Batch API の料金（#179）。換算は cost.ts の batchCostDeciyen を使い、ここには値だけを置く。
// cost.ts は Anthropic と Google の分と共有なので変えない（#179 の orchestrator の指示）。
import type { BatchPrice, TokenUsage } from "./cost";

/**
 * 入力がこのトークン数を超える依頼は、依頼全体が長い文脈の料金になる（入力2倍・出力1.5倍）。
 * 資料は「272K」と書く。1K＝1,024 と読むと 278,528 だが、低いほうの 272,000 で切る（高めに数える側）。
 */
export const OPENAI_LONG_CONTEXT_INPUT_TOKENS = 272_000;

export interface OpenAIBatchPriceTiers {
  /** 入力が OPENAI_LONG_CONTEXT_INPUT_TOKENS 以下 */
  short: Readonly<BatchPrice>;
  /** 入力が OPENAI_LONG_CONTEXT_INPUT_TOKENS を超える */
  long: Readonly<BatchPrice>;
}

/**
 * Batch API の料金（標準の半額）。100万トークンあたりのセント。
 * 出典：https://developers.openai.com/api/docs/pricing （Batch の表）と
 * https://developers.openai.com/api/docs/models/gpt-6.1-sol （どちらも 2026-11-07 確認）。
 * gpt-6.1-sol のバッチ：短い文脈は入力1ドル・出力5ドル、長い文脈は入力2ドル・出力7.5ドル（100万トークンあたり）。
 * 推論のトークン（reasoning tokens）は出力に含まれ、出力の単価で課金される。
 * キャッシュの単価（読み出しは入力の0.05倍、書き込みは1.25倍。12時間の書き込みは2.5倍）は、
 * openai-batch.ts の toTokenUsage で cost.ts の欄に高めに割り当てる。
 * 料金が変わったら、ここを PR で直す。ここにないモデルは費用を出せない（呼び出し側が maxCost を費用とする）。
 */
export const OPENAI_BATCH_PRICES: Readonly<Record<string, Readonly<OpenAIBatchPriceTiers>>> = Object.freeze({
  "gpt-6.1-sol": Object.freeze({
    short: Object.freeze({ inputCentsPerMTok: 100, outputCentsPerMTok: 500 }),
    long: Object.freeze({ inputCentsPerMTok: 200, outputCentsPerMTok: 750 }),
  }),
});

/** モデルとトークン数から、その依頼に当たる料金を選ぶ。ここにないモデルは undefined */
export function openaiBatchPrice(modelId: string, usage: Pick<TokenUsage, "inputTokens">): Readonly<BatchPrice> | undefined {
  if (!Object.hasOwn(OPENAI_BATCH_PRICES, modelId)) return undefined;
  const tiers = OPENAI_BATCH_PRICES[modelId]!;
  return usage.inputTokens > OPENAI_LONG_CONTEXT_INPUT_TOKENS ? tiers.long : tiers.short;
}

// 予約の料金は openai-port.ts の openaiReservePrice（入力は 20,000 トークンまでなので、いつも短い文脈の料金）
