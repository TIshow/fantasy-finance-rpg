// 3社のバッチの予約の見積もりと、その日の合計の確かめ（#179 の lead の決定2：3体の予約の合計は1日80円以下）。
import { describe, expect, it } from "vitest";
import { LLM_BATCH_MODEL_IDS } from "../../src/llm/batch-port";
import { BATCH_DAILY_RESERVE_TARGET, batchReservationOf, checkDailyBatchReservations } from "../../src/llm/batch-plan";
import { GEMINI_PRICE_SWITCH_AT } from "../../src/llm/gemini-pricing";

const NOW = Date.parse("2026-11-09T07:35:00Z");
const Y2027 = Date.parse("2027-01-05T07:35:00Z");
const MODELS = [
  { provider: "anthropic", modelId: LLM_BATCH_MODEL_IDS.anthropic },
  { provider: "openai", modelId: LLM_BATCH_MODEL_IDS.openai },
  { provider: "google", modelId: LLM_BATCH_MODEL_IDS.google },
];

describe("予約の見積もり（入力の上限×入力の単価＋出力の上限×出力の単価）", () => {
  it("今の料金表：Claude 6.4円・GPT 16円・Gemini 3.6円", () => {
    // Claude：20,000×1ドル＋4,000×5ドル ＝ 0.04ドル。GPT：20,000×1ドル＋16,000×5ドル ＝ 0.1ドル。Gemini：20,000×0.375ドル＋8,000×1.875ドル ＝ 0.0225ドル（どれも100万トークンあたり）
    expect(MODELS.map((m) => batchReservationOf(m, NOW).maxCost)).toEqual([64, 160, 36]);
    expect(batchReservationOf(MODELS[1]!, NOW)).toEqual({ reservePrice: { yenPerUsd: 160, inputCentsPer10MTok: 1000, outputCentsPer10MTok: 5000 }, maxInputTokens: 20_000, maxOutputTokens: 16_000, maxBodyBytes: 6666, maxCost: 160 });
    expect(MODELS.map((m) => batchReservationOf(m, NOW).maxBodyBytes)).toEqual([20_000, 6666, 20_000]);
  });

  it("3体の合計は、今は26円、Gemini の値上げ（2027-01-01）のあとは29.6円で、どちらも80円以下", () => {
    expect(checkDailyBatchReservations(MODELS, NOW)).toBe(260);
    expect(batchReservationOf(MODELS[2]!, Y2027).maxCost).toBe(72);
    expect(checkDailyBatchReservations(MODELS, Y2027)).toBe(296);
    // 値上げの48時間前からは、値上げのあとの料金で予約する
    expect(checkDailyBatchReservations(MODELS, GEMINI_PRICE_SWITCH_AT - 3_600_000)).toBe(296);
    expect(BATCH_DAILY_RESERVE_TARGET).toBe(800);
  });

  it("目標を超える設定・知らない提供元・料金表にないモデルは断る", () => {
    expect(() => checkDailyBatchReservations(MODELS, NOW, 259)).toThrow(RangeError);
    expect(checkDailyBatchReservations(MODELS, NOW, 260)).toBe(260);
    // 同じ AI を何体も並べると目標を超える（GPT 6体で96円）
    expect(() => checkDailyBatchReservations(Array(6).fill(MODELS[1]), NOW)).toThrow(RangeError);
    expect(() => batchReservationOf({ provider: "other", modelId: "m" }, NOW)).toThrow(RangeError);
    expect(() => batchReservationOf({ provider: "toString", modelId: "m" }, NOW)).toThrow(RangeError);
    expect(() => batchReservationOf({ provider: "openai", modelId: "gpt-unknown" }, NOW)).toThrow(RangeError);
  });
});
