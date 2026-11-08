// LLM の AI 投資家の入力を、記録から集める試験（#179）。予約より前の記録だけを使い、締めのあとの情報・取り下げた投稿を入れない。
import { describe, expect, it } from "vitest";
import type { LogEvent } from "../../src/events/types";
import { cutoffOf } from "../../src/ledger/ledger";
import { investorUserText } from "../../src/llm/investor-prompt";
import { investorInputOf } from "../../src/runner/llm-input";

const T = "2026-11-10";
const PREV = "2026-11-09";
let seq = 0;
const ev = (type: LogEvent["type"], payload: Record<string, unknown>, recordedAt = Date.parse("2026-11-09T07:00:00Z"), refs: number[] = []): LogEvent => ({ seq: ++seq, type, recordedAt, refs, payload }) as unknown as LogEvent;
const bodies = new Map([
  ["h1", "VRN1 は強い"],
  ["h2", "取り下げた投稿"],
  ["h3", "全体の話"],
  ["h4", "取引対象の外の板"],
  ["h5", "訂正した本文"],
  ["h6", "2回目の訂正の本文"],
]);

const events = [
  ev("agent.registered", { agentId: "ai-claude", startDate: PREV, initialCash: 100_000_000 }),
  ev("company.listed", { symbol: "VRN1", name: "ヴェルナ電機", sector: "電機", sharesOutstanding: 50_000_000, price: 12_000 }, Date.parse("2026-11-01T07:00:00Z")),
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
const SUBMITTED = Date.parse("2026-11-09T07:35:00Z");
const ctx = { agentId: "ai-claude", tradingDate: T, prev: PREV, submittedAt: SUBMITTED, account: { cash: 100_000_000, holdings: {} }, body: (h: string) => bodies.get(h) ?? null };

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
    expect(input.accountSeqs).toEqual([1, 9]);
    expect(r.inputSeqs).toEqual([1, 2, 3, 6, 7, 8, 9, 10, 12]);
    expect(r.text).not.toContain("2026Q4");
    expect(r.text).not.toContain("取り下げた投稿");
  });

  it("予約より前の記録だけを渡せば、そのあとの記録は入らない（翌朝に作り直しても同じ文）", () => {
    const later = [...events, ev("post.published", { agentId: "ai-gpt", board: "VRN1", bodyHash: "h1" })];
    expect(investorUserText(investorInputOf(later.slice(0, events.length), ctx))).toEqual(investorUserText(input));
    expect(investorUserText(investorInputOf(later, ctx)).inputSeqs).toContain(later.at(-1)!.seq);
    // 予約の時刻よりあとに記録したものは、渡されても入れない
    const late = [...events, ev("post.published", { agentId: "ai-gpt", board: "VRN1", bodyHash: "h1" }, SUBMITTED + 1)];
    expect(investorUserText(investorInputOf(late, ctx))).toEqual(investorUserText(input));
  });

  it("登録のないAIは RangeError", () => {
    expect(() => investorInputOf(events, { ...ctx, agentId: "ai-none" })).toThrow(RangeError);
  });

  it("投稿の訂正：seq が最大の訂正の本文を使い、訂正の seq を持たせる。消した本文の訂正なら入れない", () => {
    const more = [...events, ev("correction.issued", { targetSeq: 10, kind: "post", newBodyHash: "h5" }), ev("correction.issued", { refSeq: 10, kind: "post", newBodyHash: "h6" }), ev("correction.issued", { targetSeq: 12, kind: "post", newBodyHash: "erased" }), ev("correction.issued", { targetSeq: 6, kind: "data", newBodyHash: "h5" })];
    const fixed = investorInputOf(more, ctx);
    expect(fixed.posts).toEqual([{ seq: 10, agentId: "ai-gpt", board: "VRN1", at: expect.any(Number), text: "2回目の訂正の本文", correctionSeq: more.at(-3)!.seq }]);
    expect(investorUserText(fixed).inputSeqs).toContain(more.at(-3)!.seq);
  });

  it("前の営業日の板寄せがない銘柄・引け後の処理がない・根拠のあとの約定は、RangeError（依頼を作らない）", () => {
    // VRN1 の PREV の板寄せ（seq 7）を外す
    expect(() => investorInputOf(events.filter((e) => e.seq !== 7), ctx)).toThrow(/auction of VRN1/);
    // PREV が臨時休場なら板寄せはなくてよい
    expect(() => investorInputOf([...events.filter((e) => e.seq !== 7), ev("market.closed", { date: PREV })], ctx)).not.toThrow();
    expect(() => investorInputOf(events.filter((e) => e.type !== "corporate_actions.applied"), ctx)).toThrow(/post-close/);
    expect(() => investorInputOf(events, { ...ctx, prev: "2026-11-10", tradingDate: "2026-11-11" })).toThrow(/post-close|auction/);
    expect(() => investorInputOf([...events, ev("fills.executed", { agentId: "ai-claude", tradingDate: T })], ctx)).toThrow(/fills after/);
    // 開始日が取引日なら、引け後の処理はまだなくてよい（口座の根拠は登録）
    const fresh = investorInputOf(events.filter((e) => e.type !== "corporate_actions.applied"), { ...ctx, tradingDate: PREV, prev: "2026-11-06" });
    expect(fresh.accountSeq).toBe(1);
  });

  it("根拠のあとの台帳の調整は、口座の元の seq に入れる", () => {
    const adj = [...events, ev("ledger.adjusted", { agentId: "ai-claude", correctionSeq: 1 })];
    expect(investorInputOf(adj, ctx).accountSeqs).toEqual([1, 9, adj.at(-1)!.seq]);
  });

  it("投稿を指しているのに形が読めない訂正（種類の綴りが違う・種類がない・別のキー）があれば、その投稿を外し、外した数と訂正の seq を残す", () => {
    const at = Date.parse("2026-11-09T07:00:00Z");
    const cases = [
      ev("correction.issued", { targetSeq: 10, kind: "投稿", newBodyHash: "h5" }),
      ev("correction.issued", { targetSeq: 10, newBodyHash: "h5" }),
      ev("correction.issued", { postSeq: 10, kind: "post", text: "h5" }, at, [10]),
      ev("correction.issued", { targetSeq: 10, kind: "post" }),
    ];
    for (const bad of cases) {
      const input = investorInputOf([...events, bad], ctx);
      expect(input.posts.map((x) => x.seq)).toEqual([12]);
      expect(input.withheld).toEqual([{ postSeq: 10, correctionSeq: bad.seq }]);
      const r = investorUserText(input);
      expect(r.omitted.withheld).toBe(1);
      expect(r.text).toContain("訂正の形が読めないため外した投稿：1件");
      expect(r.text).not.toContain("VRN1 は強い");
      expect(r.inputSeqs).toContain(bad.seq);
      expect(r.inputSeqs).not.toContain(10);
    }
    // 投稿を指していない訂正（入力データの訂正）では、投稿は外さない
    expect(investorInputOf([...events, ev("correction.issued", { targetSeq: 6, kind: "data", newValueHash: "x" }, at, [6])], ctx).withheld).toBeUndefined();
  });
});
