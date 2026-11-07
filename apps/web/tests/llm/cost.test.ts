import { describe, expect, it } from "vitest";
import { anthropicBatchPrice, batchCostDeciyen } from "../../src/llm/cost";

const sonnet = anthropicBatchPrice("claude-sonnet-5-5")!;
const usage = (inputTokens: number, outputTokens: number, cacheCreationInputTokens = 0, cacheReadInputTokens = 0) => ({ inputTokens, outputTokens, cacheCreationInputTokens, cacheReadInputTokens });

describe("トークン数から費用（0.1円単位）への換算", () => {
  it("Sonnet 5.5 のバッチ：入力2万・出力1,500トークンは、1ドル160円なら 44（4.4円）", () => {
    // 2万 × 1ドル/100万 ＋ 1,500 × 5ドル/100万 ＝ 0.0275ドル → 4.4円
    expect(batchCostDeciyen(usage(20000, 1500), sonnet, 160)).toBe(44);
    expect(batchCostDeciyen(usage(20000, 1500), sonnet, 150)).toBe(42); // 4.125円 → 切り上げて 4.2円
  });

  it("端数は切り上げる。0 トークンは 0", () => {
    expect(batchCostDeciyen(usage(1, 0), sonnet, 160)).toBe(1);
    expect(batchCostDeciyen(usage(0, 0), sonnet, 160)).toBe(0);
  });

  it("キャッシュは高めに数える（書き込みは入力の2倍、読み出しは入力と同じ）", () => {
    expect(batchCostDeciyen(usage(0, 0, 1_000_000, 0), sonnet, 100)).toBe(2000); // 2ドル × 100円 ＝ 200円
    expect(batchCostDeciyen(usage(0, 0, 0, 1_000_000), sonnet, 100)).toBe(1000);
  });

  it("大きなトークン数でも誤差なく計算する", () => {
    expect(batchCostDeciyen(usage(1_000_000_000, 1_000_000_000), sonnet, 160)).toBe(9_600_000); // 6,000ドル × 160円
  });

  it("トークン数・1ドルあたりの円が決まりに合わなければ RangeError", () => {
    for (const bad of [-1, 1.5, NaN, Infinity]) expect(() => batchCostDeciyen(usage(bad, 0), sonnet, 160)).toThrow(RangeError);
    for (const bad of [0, -1, 150.5, NaN]) expect(() => batchCostDeciyen(usage(1, 0), sonnet, bad)).toThrow(RangeError);
  });

  it("料金表にないモデルは undefined（プロトタイプの名前も拾わない）", () => {
    expect(anthropicBatchPrice("claude-opus-5-5")).toBeUndefined();
    expect(anthropicBatchPrice("toString")).toBeUndefined();
  });
});
