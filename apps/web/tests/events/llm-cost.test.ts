// LLM の費用の上限を、記録だけから確かめる検査（#179）。
// 使用済み ＝ 閉じたバッチの実際の費用 ＋ 閉じていないバッチの予約。暦日は依頼を決めた時刻（submittedAt。日本時間）。全提供元の合計。
import { describe, expect, it } from "vitest";
import type { LlmBatchTicket } from "../../src/contracts";
import { jstDayOf, LLM_DAILY_COST_LIMIT, llmCostProblems, llmCostUsed, llmTicketOf, llmTokenCost, openLlmBatches } from "../../src/events/llm-cost";
import type { LogEvent } from "../../src/events/types";
import { batchCostDeciyen } from "../../src/llm/cost";
import { geminiBatchCostDeciyen } from "../../src/llm/gemini-pricing";

type Rec = Pick<LogEvent, "seq" | "type" | "recordedAt" | "payload">;

const jst = (date: string, hh: number, mm = 0) => Date.parse(`${date}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+09:00`);

/** 記録を seq の順に並べる。sub は依頼、close は閉じた記録（依頼の seq を指す） */
function log(...items: (["sub", number, number, string?] | ["close", number, number, number])[]): Rec[] {
  return items.map((it, i) => {
    const seq = i + 1;
    if (it[0] === "sub") {
      const [, at, maxCost, agentId = `a${seq}`] = it;
      return { seq, type: "llm.batch.submitted", recordedAt: at, payload: { agentId, provider: "anthropic", modelId: "m", promptVersion: "v1", sentBodyHash: "b".repeat(64), batchId: `batch_${seq}`, customId: `c${seq}`, maxCost, tradingDate: "2026-11-10", submittedAt: at } };
    }
    const [, at, batchSeq, cost] = it;
    return { seq, type: "llm.batch.closed", recordedAt: at, payload: { batchSeq, agentId: "x", result: "collected", cost, inputTokens: 1, outputTokens: 1 } };
  });
}

const D = "2026-11-09";
const at = (hh: number, mm = 0) => jst(D, hh, mm);

describe("jstDayOf", () => {
  it("日本時間の0時で日付が変わる", () => {
    expect(jstDayOf(Date.parse("2026-11-09T14:59:59.999Z"))).toBe("2026-11-09");
    expect(jstDayOf(Date.parse("2026-11-09T15:00:00.000Z"))).toBe("2026-11-10");
  });
});

describe("llmCostUsed", () => {
  it("閉じていない依頼は予約、閉じた依頼は実際の費用で数える。全提供元の合計", () => {
    const events = log(["sub", at(16, 35), 150], ["sub", at(16, 36), 200], ["sub", at(16, 37), 100], ["close", jst("2026-11-10", 6, 50), 1, 40]);
    // 40（閉じた分の実費）＋ 200 ＋ 100（予約）
    expect(llmCostUsed(events, D)).toBe(340);
    expect(llmCostUsed(events, "2026-11-10")).toBe(0);
  });

  it("暦日は依頼した日。翌日に閉じても、依頼した日に付く。日本時間の0時の前後で分かれる", () => {
    const events = log(["sub", jst(D, 23, 59), 150], ["sub", jst("2026-11-10", 0, 0), 200], ["close", jst("2026-11-10", 6, 50), 1, 30]);
    expect(llmCostUsed(events, D)).toBe(30);
    expect(llmCostUsed(events, "2026-11-10")).toBe(200);
  });

  it("実費が予約を超えても切り捨てない。費用が分からず予約を使った記録は予約のまま", () => {
    expect(llmCostUsed(log(["sub", at(16, 35), 150], ["close", at(17), 1, 180]), D)).toBe(180);
    expect(llmCostUsed(log(["sub", at(16, 35), 150], ["close", at(17), 1, 150]), D)).toBe(150);
  });

  it("暦日は記録した時刻ではなく、依頼を決めた時刻（submittedAt）で決める", () => {
    const [sub] = log(["sub", jst(D, 23, 59), 150]);
    const events = [{ ...sub!, recordedAt: jst("2026-11-10", 0, 10) }];
    expect(llmCostUsed(events, D)).toBe(150);
    expect(llmCostUsed(events, "2026-11-10")).toBe(0);
  });

  it("記録がなければ 0", () => {
    expect(llmCostUsed([], D)).toBe(0);
  });
});

describe("llmCostProblems", () => {
  it("上限は1日1,000（100円）。ちょうどは守られている", () => {
    expect(LLM_DAILY_COST_LIMIT).toBe(1000);
    expect(llmCostProblems(log(["sub", at(16, 35), 400], ["sub", at(16, 36), 600]))).toEqual([]);
  });

  it("依頼の時点で、それまでの使用済み＋予約が上限を1でも超えたら、その依頼を挙げる", () => {
    const events = log(["sub", at(16, 35), 400], ["sub", at(16, 36), 601]);
    expect(llmCostProblems(events)).toEqual([
      { day: D, kind: "reservation", seq: 2, used: 1001, limit: 1000 },
      { day: D, kind: "total", seq: 2, used: 1001, limit: 1000 },
    ]);
  });

  it("先に閉じて実費が予約より少なければ、その分の枠があく（閉じる前の依頼は予約で数える）", () => {
    // 600 を予約 → 実費 100 で閉じる → 900 の予約：100 ＋ 900 ＝ 1000 で守られている
    expect(llmCostProblems(log(["sub", at(16, 35), 600], ["close", at(16, 40), 1, 100], ["sub", at(16, 45), 900]))).toEqual([]);
    // 閉じる前に 900 を予約すると、その時点では 600 ＋ 900 ＝ 1500。いまの合計は 1000 で守られている
    expect(llmCostProblems(log(["sub", at(16, 35), 600], ["sub", at(16, 45), 900], ["close", at(16, 50), 1, 100]))).toEqual([{ day: D, kind: "reservation", seq: 2, used: 1500, limit: 1000 }]);
  });

  it("予約の時点で守られていても、実費が予約を超えてその日の合計が上限を超えたら挙げる", () => {
    const events = log(["sub", at(16, 35), 500], ["sub", at(16, 36), 500], ["close", jst("2026-11-10", 6, 50), 1, 501]);
    expect(llmCostProblems(events)).toEqual([{ day: D, kind: "total", seq: 2, used: 1001, limit: 1000 }]);
  });

  it("日ごとに別に数える。上限は引数で変えられる（0 なら依頼1件で超える）", () => {
    const events = log(["sub", at(16, 35), 700], ["sub", jst("2026-11-10", 16, 35), 700]);
    expect(llmCostProblems(events)).toEqual([]);
    expect(llmCostProblems(events, 0).map((p) => `${p.day}:${p.kind}:${p.seq}`)).toEqual(["2026-11-09:reservation:1", "2026-11-10:reservation:2", "2026-11-09:total:1", "2026-11-10:total:2"]);
  });
});

describe("openLlmBatches と llmTicketOf", () => {
  it("閉じていない依頼を記録の順で返し、記録から受け取りの控えを作り直す", () => {
    const events = log(["sub", at(16, 35), 150, "alpha"], ["sub", at(16, 36), 200, "beta"], ["close", jst("2026-11-10", 6, 50), 1, 40]);
    const open = openLlmBatches(events);
    expect(open.map((e) => e.seq)).toEqual([2]);
    const ticket: LlmBatchTicket | null = llmTicketOf(open[0]!);
    expect(ticket).toEqual({ agentId: "beta", provider: "anthropic", modelId: "m", batchId: "batch_2", customId: "c2", maxCost: 200, tradingDate: "2026-11-10", submittedAt: at(16, 36) });
  });

  it("batchId が null の依頼は控えを作れない（null）。依頼でない記録は RangeError", () => {
    const [sub, close] = log(["sub", at(16, 35), 150], ["close", at(16, 36), 1, 150]);
    expect(llmTicketOf({ ...sub!, payload: { ...(sub!.payload as object), batchId: null } })).toBeNull();
    expect(() => llmTicketOf(close!)).toThrow(RangeError);
  });
});

describe("llmTokenCost", () => {
  it("src/llm の換算（Anthropic・OpenAI の batchCostDeciyen、Gemini の geminiBatchCostDeciyen）と同じ値になる", () => {
    // 疑似乱数（線形合同法）で、トークン数と料金を決まった並びで作る
    let x = 12345;
    const next = (n: number) => {
      x = (x * 1103515245 + 12345) % 2147483648;
      return x % n;
    };
    for (let i = 0; i < 500; i++) {
      const t = { inputTokens: next(400_000), outputTokens: next(70_000), cacheCreationInputTokens: next(3) === 0 ? next(50_000) : 0, cacheReadInputTokens: next(3) === 0 ? next(50_000) : 0 };
      const cents = { inputCentsPerMTok: next(1_000), outputCentsPerMTok: next(5_000) };
      const yen = 100 + next(100);
      expect(llmTokenCost(t, { yenPerUsd: yen, inputCentsPer10MTok: cents.inputCentsPerMTok * 10, outputCentsPer10MTok: cents.outputCentsPerMTok * 10 })).toBe(batchCostDeciyen(t, cents, yen));
      const plain = { ...t, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
      // Gemini 3.8 Flash の 2026 年の単価（1,000万トークンあたり 375・1875 セント）
      expect(llmTokenCost(plain, { yenPerUsd: yen, inputCentsPer10MTok: 375, outputCentsPer10MTok: 1875 })).toBe(geminiBatchCostDeciyen(plain, "gemini-3.8-flash", Date.parse("2026-11-09T07:35:00Z"), yen));
    }
  });

  it("手で計算した値：入力2万・出力1,500、1ドル・5ドル／100万トークン、160円 → 4.4円（44）。端数は切り上げ。キャッシュの欄は省ける", () => {
    const price = { yenPerUsd: 160, inputCentsPer10MTok: 1000, outputCentsPer10MTok: 5000 };
    expect(llmTokenCost({ inputTokens: 20_000, outputTokens: 1_500 }, price)).toBe(44);
    expect(llmTokenCost({ inputTokens: 1, outputTokens: 0 }, price)).toBe(1);
    expect(llmTokenCost({ inputTokens: 0, outputTokens: 0 }, price)).toBe(0);
    // 書き込みは入力の2倍：1万トークン × 2 × 1ドル/100万 × 160円 ＝ 3.2円
    expect(llmTokenCost({ inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 10_000 }, price)).toBe(32);
    expect(llmTokenCost({ inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0 }, { ...price, inputCentsPer10MTok: 10 ** 9 })).toBeNull();
  });
});
