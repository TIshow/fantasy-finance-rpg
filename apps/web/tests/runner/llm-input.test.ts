// LLM の AI 投資家の入力を、記録から集める試験（#179）。予約より前の記録だけを使い、締めのあとの情報・取り下げた投稿を入れない。
import { describe, expect, it } from "vitest";
import type { LogEvent } from "../../src/events/types";
import { cutoffOf } from "../../src/ledger/ledger";
import { investorUserText } from "../../src/llm/investor-prompt";
import { investorInputOf } from "../../src/runner/llm-input";

const T = "2026-11-10";
const PREV = "2026-11-09";
let seq = 0;
const ev = (type: LogEvent["type"], payload: Record<string, unknown>, recordedAt = Date.parse("2026-11-09T07:00:00Z")): LogEvent => ({ seq: ++seq, type, recordedAt, payload }) as unknown as LogEvent;
const bodies = new Map([
  ["h1", "VRN1 は強い"],
  ["h2", "取り下げた投稿"],
  ["h3", "全体の話"],
  ["h4", "取引対象の外の板"],
]);

const events = [
  ev("agent.registered", { agentId: "ai-claude", startDate: PREV, initialCash: 100_000_000 }),
  ev("company.listed", { symbol: "VRN1", name: "ヴェルナ電機", sector: "電機", sharesOutstanding: 50_000_000, price: 12_000 }),
  ev("company.listed", { symbol: "ORS1", name: "オルセ精工", sector: "電機", sharesOutstanding: 20_000_000, price: 8_000 }),
  ev("company.listed", { symbol: "XXX1", name: "外", sector: "電機", sharesOutstanding: 1_000, price: 1_000 }),
  ev("universe.set", { symbols: ["VRN1", "ORS1"] }),
  ev("auction.cleared", { symbol: "VRN1", date: "2026-11-06", price: 12_100, volume: 1000 }),
  ev("auction.cleared", { symbol: "VRN1", date: PREV, price: null, volume: 0 }),
  ev("company.disclosed", { symbol: "VRN1", period: "2026Q3", revenue: 1e10, netIncome: 1e9, eps: 200, dividendPerShare: 60 }),
  ev("corporate_actions.applied", { agentId: "ai-claude", asOf: PREV }),
  ev("post.published", { agentId: "ai-gpt", board: "VRN1", bodyHash: "h1" }),
  ev("post.published", { agentId: "ai-gpt", board: "VRN1", bodyHash: "h2" }),
  ev("post.published", { agentId: "ai-gemini", board: "全体", bodyHash: "h3" }),
  ev("post.published", { agentId: "ai-gemini", board: "XXX1", bodyHash: "h4" }),
  ev("post.published", { agentId: "ai-gemini", board: "ORS1", bodyHash: "erased" }),
  ev("content.withdrawn", { targetSeq: 11, reason: "誤り", bodyErased: false }),
  // 締めのあとの発表（予約より前の記録には来ないが、来ても入れない）
  ev("company.disclosed", { symbol: "VRN1", period: "2026Q4", revenue: 1, netIncome: 1, eps: 1, dividendPerShare: 0 }, cutoffOf(T) + 1),
];
const ctx = { agentId: "ai-claude", tradingDate: T, account: { cash: 100_000_000, holdings: {} }, body: (h: string) => bodies.get(h) ?? null };

describe("investorInputOf", () => {
  const input = investorInputOf(events, ctx);

  it("取引対象のうち上場した銘柄だけを、銘柄コードの順に。値段は取引日より前、決算は締めより前", () => {
    expect(input.symbols.map((s) => s.symbol)).toEqual(["ORS1", "VRN1"]);
    const v = input.symbols[1]!;
    expect(v.auctions.map((a) => a.date)).toEqual(["2026-11-06", PREV]);
    // 基準の価格は、価格のついた直近の板寄せ
    expect(v.refPrice).toEqual({ seq: 6, price: 12_100 });
    expect(v.disclosures.map((q) => q.period)).toEqual(["2026Q3"]);
    expect(input.symbols[0]!.refPrice).toEqual({ seq: 3, price: 8_000 });
  });

  it("掲示板は、上場した取引対象の銘柄と「全体」だけ。取り下げた投稿・本文が引けない投稿は入れない", () => {
    expect(input.posts.map((p) => [p.seq, p.board, p.text])).toEqual([
      [10, "VRN1", "VRN1 は強い"],
      [12, "全体", "全体の話"],
    ]);
  });

  it("口座の根拠は最後の引け後の処理。入力の seq はすべて記録にあり、文の元になった記録だけ", () => {
    expect(input.accountSeq).toBe(9);
    const r = investorUserText(input);
    expect(r.inputSeqs).toEqual([2, 3, 6, 7, 8, 9, 10, 12]);
    expect(r.text).not.toContain("2026Q4");
    expect(r.text).not.toContain("取り下げた投稿");
  });

  it("予約より前の記録だけを渡せば、そのあとの記録は入らない（翌朝に作り直しても同じ文）", () => {
    const later = [...events, ev("post.published", { agentId: "ai-gpt", board: "VRN1", bodyHash: "h1" })];
    expect(investorUserText(investorInputOf(later.slice(0, events.length), ctx))).toEqual(investorUserText(input));
    expect(investorUserText(investorInputOf(later, ctx)).inputSeqs).toContain(later.at(-1)!.seq);
  });

  it("登録のないAIは RangeError", () => {
    expect(() => investorInputOf(events, { ...ctx, agentId: "ai-none" })).toThrow(RangeError);
  });
});
