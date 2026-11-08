// LLM の AI 投資家のプロンプトと入力の文の試験（#179）。本物の API は呼ばない（prepare は本文を作るだけで、何も送らない）。
import { describe, expect, it } from "vitest";
import { anthropicBatchPort } from "../../src/llm/anthropic-port";
import { BATCH_MAX_INPUT_TOKENS } from "../../src/llm/batch-port";
import { geminiBatchPort } from "../../src/llm/gemini-port";
import { INVESTOR_PROMPT_VERSION, INVESTOR_SYSTEM_PROMPT, type InvestorInput, USER_TEXT_MAX_BYTES, investorPrompt, investorUserText, jsonBytes } from "../../src/llm/investor-prompt";
import { openaiBatchPort } from "../../src/llm/openai-port";
import { LLM_INVESTORS, investorRequest } from "../../src/runner/llm-agents";

const AT = Date.parse("2026-11-09T07:35:00Z");
const DAY = 86_400_000;
const SYMBOLS = ["LPO1", "MRH1", "ORS1", "QON1", "SLN1", "VRN1"];

/** 本番に近い大きさの入力：6銘柄×20日の値段、4四半期の決算、400字の投稿 n 件 */
function sample(posts: number, days = 20): InvestorInput {
  let seq = 1;
  return {
    agentId: "ai-claude",
    tradingDate: "2026-11-10",
    account: { cash: 87_654_321, holdings: { VRN1: { qty: 300, cost: 3_600_000 }, MRH1: { qty: 0, cost: 0 } } },
    accountSeq: 999,
    symbols: SYMBOLS.map((symbol, i) => ({
      symbol,
      name: `架空${i}社`,
      sector: "電機",
      sharesOutstanding: 50_000_000,
      listing: { seq: seq++, price: 12_000 },
      refPrice: { seq: seq + days - 1, price: 12_340 },
      auctions: Array.from({ length: days }, (_, d) => ({ seq: seq++, date: new Date(AT - (days - d) * DAY).toISOString().slice(0, 10), price: d === 3 ? null : 12_000 + d * 10, volume: 123_400 })),
      disclosures: Array.from({ length: 4 }, (_, q) => ({ seq: seq++, period: `2026Q${q + 1}`, revenue: 15_000_000_000, netIncome: 900_000_000, eps: 185, dividendPerShare: 54 })),
    })),
    posts: Array.from({ length: posts }, (_, k) => ({ seq: 5000 + k, agentId: k % 2 ? "ai-gpt" : "ai-gemini", board: k % 3 ? "VRN1" : "全体", at: AT - (posts - k) * 3_600_000, text: "あ".repeat(400) })),
  };
}

const clock = { now: () => AT };
const policy = { dailyCostLimit: 1000, dryRun: false };
const PORTS = { anthropic: anthropicBatchPort({ policy, clock, client: {} as never }), openai: openaiBatchPort({ policy, clock, client: {} as never }), google: geminiBatchPort({ policy, clock, client: {} as never }) };

describe("プロンプト", () => {
  it("版とハッシュが決まっている（指示の文を変えればハッシュが変わる）", async () => {
    const p = await investorPrompt();
    expect(p).toEqual({ id: "llm-investor", version: INVESTOR_PROMPT_VERSION, hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect((await investorPrompt()).hash).toBe(p.hash);
    expect(INVESTOR_SYSTEM_PROMPT).toContain("400文字まで");
    expect(INVESTOR_SYSTEM_PROMPT).toContain("10件まで");
  });
});

describe("入力の文", () => {
  it("口座・値段の推移（数字だけの表）・決算・掲示板を、同じ値なら同じ文にする", () => {
    const r = investorUserText(sample(2));
    expect(r.text).toContain("現金：8765432.1円");
    expect(r.text).toContain("保有：VRN1 300株（取得原価の合計 360000円）");
    expect(r.text).not.toContain("MRH1 0株");
    expect(r.text).toContain("## VRN1 架空5社（電機）発行済 50000000株 上場時 1200 基準 1234 値幅 988〜1480");
    expect(r.text).toMatch(/\n10\/\d\d,,123400\n/); // 値段がつかなかった日は空
    expect(r.text).toContain("2026Q1,15000,900,18.5,5.4");
    expect(r.text).toContain("掲示板（古い順）\n[");
    expect(r.omitted).toEqual({ posts: 0, auctionDays: 0 });
    expect(r.inputSeqs).toContain(999);
    expect(r.inputSeqs).toContain(5001);
    expect(investorUserText(sample(2))).toEqual(r);
  });

  it("本番に近い大きさ：値段20日分は削らずに収まり、400字の投稿は古いものから削る。削った数を文に書き、入力の seq から外す", () => {
    const r = investorUserText(sample(40));
    expect(r.omitted.auctionDays).toBe(0);
    expect(r.omitted.posts).toBeGreaterThan(0);
    const kept = 40 - r.omitted.posts;
    // 指示の文と値段・決算のあとに、400字の投稿が10件以上は入る（2万バイトで日本語は約6,500字）
    expect(kept).toBeGreaterThanOrEqual(10);
    expect(r.text).toContain(`長さの上限のため省略：古い投稿${r.omitted.posts}件`);
    expect(r.inputSeqs).not.toContain(5000);
    expect(r.inputSeqs).toContain(5039);
    expect(jsonBytes(r.text)).toBeLessThanOrEqual(USER_TEXT_MAX_BYTES);
  });

  it("投稿をすべて削っても収まらなければ、古い値段の日を削る。1日分でも収まらなければ RangeError", () => {
    const r = investorUserText(sample(3), 3000);
    expect(r.omitted.posts).toBe(3);
    expect(r.omitted.auctionDays).toBeGreaterThan(0);
    expect(r.text).toContain(`古い投稿3件、古い値段${r.omitted.auctionDays}日分`);
    expect(() => investorUserText(sample(3), 500)).toThrow(RangeError);
  });

  it("入力の文が上限ちょうどでも、3社とも送る本文は2万バイト以下（決まった部分の見込みで足りる）", async () => {
    // 1文字が JSON で6バイトになる制御文字と、3バイトの日本語を混ぜて、上限ちょうどの文を作る
    const unit = "あ\u0001";
    const text = unit.repeat(Math.floor(USER_TEXT_MAX_BYTES / jsonBytes(unit)));
    const filled = text + "a".repeat(USER_TEXT_MAX_BYTES - jsonBytes(text));
    expect(jsonBytes(filled)).toBe(USER_TEXT_MAX_BYTES);
    const prompt = await investorPrompt();
    for (const a of LLM_INVESTORS) {
      const port = PORTS[a.model.provider as keyof typeof PORTS];
      const p = await port.prepare(investorRequest(a, { prompt, tradingDate: "2026-11-10", submittedAt: AT, inputSeqs: [1], userText: filled }));
      expect(new TextEncoder().encode(p.body).length).toBeLessThanOrEqual(BATCH_MAX_INPUT_TOKENS);
    }
  });
});
