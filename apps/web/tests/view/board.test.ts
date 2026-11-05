import { describe, expect, it } from "vitest";
import type { LogEvent } from "../../src/events/types";
import { readBody } from "../../src/view/body";
import { buildBoard, filterPosts } from "../../src/view/board";
import { buildView } from "../../src/view/build";
import { buildGoldenLog } from "../fixtures/golden";

let n = 0;
const ev = (type: LogEvent["type"], payload: object, at: number): LogEvent => ({ seq: ++n, schema: 1, type, recordedAt: at, actor: "system", keys: [], refs: [], payload, prevHash: "", hash: "" });
const T = (date: string, hh: number) => Date.parse(`${date}T${String(hh).padStart(2, "0")}:00:00+09:00`);

describe("readBody（投稿の本文の読み取り）", () => {
  it("文字列も { text, intent?, stance? } も読み、知らない値は捨てる", () => {
    expect(readBody("本文")).toEqual({ text: "本文", intent: null, stance: null });
    expect(readBody({ text: "a", intent: "news", stance: "bear" })).toEqual({ text: "a", intent: "news", stance: "bear" });
    expect(readBody({ text: "a", intent: "gossip", stance: 3 })).toEqual({ text: "a", intent: null, stance: null });
    expect(readBody({ intent: "news" })).toBeNull();
    for (const bad of [null, undefined, 5, [], { text: 1 }]) expect(readBody(bad)).toBeNull();
  });
});

describe("buildBoard（手で組んだ小さなログ）", () => {
  n = 0;
  const post = (agentId: string, board: string, hash: string, extra: object, hh: number) => ev("post.published", { agentId, board, bodyHash: hash, citeSeqs: [], runSeq: 9, ...extra }, T("2026-11-09", hh));
  const events = [
    ev("agent.registered", { agentId: "ai-ma5", displayName: "あ", startDate: "2026-11-09", initialCash: 1000 }, 0), // 1
    ev("agent.registered", { agentId: "ai-hold", displayName: "い", startDate: "2026-11-09", initialCash: 1000 }, 0), // 2
    ev("source.captured", { source: "news:x", publishedAt: T("2026-11-09", 7), fetchedAt: T("2026-11-09", 8), contentHash: "c" }, T("2026-11-09", 8)), // 3
    ev("prices.close", { date: "2026-11-06", source: "fixture:synthetic", fetchedAt: T("2026-11-06", 16), valuesHash: "v" }, T("2026-11-06", 16)), // 4
    post("ai-ma5", "X1", "h1", { citeSeqs: [3, 4, 99] }, 10), // 5 根
    post("ai-hold", "X1", "h2", { replyTo: 5 }, 11), // 6 返信
    post("ai-ma5", "X1", "h3", { replyTo: 6 }, 12), // 7 返信の返信
    post("ai-hold", "X1", "h4", { replyTo: 7 }, 13), // 8 深さは2まで
    post("ai-hold", "X2", "h5", { replyTo: 5 }, 14), // 9 親が別の掲示板 → 根
    post("ai-hold", "X1", "h6", {}, 15), // 10 根（新しい）
    ev("fills.executed", { agentId: "ai-ma5", sheetSeq: 0, tradingDate: "2026-11-10", fills: [{ symbol: "X1", side: "buy", requestedQty: 100, qty: 100, price: 100, amount: 10_000, status: "filled" }, { symbol: "X2", side: "buy", requestedQty: 100, qty: 100, price: 100, amount: 10_000, status: "filled" }] }, T("2026-11-10", 9)), // 11
    ev("content.withdrawn", { targetSeq: 10, reason: "誤り", textRemoved: false }, T("2026-11-10", 10)), // 12
    ev("valuation.recorded", { agentId: "ai-ma5", date: "2026-11-10", cash: 0, positions: [{ symbol: "X1", qty: 100, price: 120, closeSeq: 4 }], total: 12_000 }, T("2026-11-10", 16)),
    ev("valuation.recorded", { agentId: "ai-hold", date: "2026-11-10", cash: 1000, positions: [{ symbol: "X1", qty: 300, price: 120, closeSeq: 4 }, { symbol: "X3", qty: 0, price: 1, closeSeq: 4 }], total: 1000 }, T("2026-11-10", 16)),
  ];
  const bodies: Record<string, unknown> = { h1: { text: "戦略の話", intent: "strategy", stance: "bull" }, h2: "返信", h3: { text: "感情", intent: "feeling" }, h4: "深い返信", h5: "別の板", h6: "取り消し予定" };
  const v = buildView(events, (h) => bodies[h]);
  const b = buildBoard(v, "X1")!;

  it("知らない銘柄は null。投稿はスレッドの順（親は新しい順、返信は親の下）で、返信は深さ2までに収まる", () => {
    expect(buildBoard(v, "NOPE")).toBeNull();
    expect(b.posts.map((p) => [p.seq, p.depth])).toEqual([[10, 0], [5, 0], [6, 1], [7, 2], [8, 2]]);
    expect(buildBoard(v, "X2")!.posts.map((p) => [p.seq, p.depth])).toEqual([[9, 0]]); // 親が別の掲示板なら根
  });

  it("種類と見立ては本文から。ない投稿は未分類・見立てなし。非表示は同じ位置に理由", () => {
    const by = Object.fromEntries(b.posts.map((p) => [p.seq, p]));
    expect(by[5]).toMatchObject({ intent: "strategy", stance: "bull", text: "戦略の話", withdrawn: null });
    expect(by[6]).toMatchObject({ intent: null, stance: null, text: "返信" });
    expect(by[7]).toMatchObject({ intent: "feeling", stance: null });
    expect(by[10]).toMatchObject({ text: null, withdrawn: "誤り", intent: null });
    expect(b.counts).toEqual({ strategy: 1, feeling: 1, knowledge: 0, news: 0, none: 3 });
  });

  it("絞り込みは種類で（並びは変えない）。未分類は none", () => {
    expect(filterPosts(b.posts, "all")).toHaveLength(5);
    expect(filterPosts(b.posts, "strategy").map((p) => p.seq)).toEqual([5]);
    expect(filterPosts(b.posts, "none").map((p) => p.seq)).toEqual([10, 6, 8]);
    expect(filterPosts(b.posts, "news")).toEqual([]);
  });

  it("引用は記録にある出典だけ（公開・取得の時刻つき）。この投稿のあとの同じAIのこの銘柄の売買へのリンク", () => {
    const p5 = b.posts.find((p) => p.seq === 5)!;
    expect(p5.cites).toEqual([
      { seq: 3, label: "news:x", publishedText: "11/09 07:00", fetchedText: "11/09 08:00" },
      { seq: 4, label: "終値 11/06（fixture:synthetic）", publishedText: null, fetchedText: "11/06 16:00" },
    ]);
    // ai-ma5 の売買は X1 の1件だけ（X2 は別の銘柄）。売買（seq 11）は、ai-ma5 の次の投稿（seq 7）より後なので、seq 5 にはつかず、最後の投稿（seq 7）につく
    expect(p5.trades).toEqual([]);
    expect(b.posts.find((p) => p.seq === 7)!.trades).toEqual([{ href: "/agents/ai-ma5#f11-0", text: "11/10 買 100株 @¥10" }]);
  });

  it("右の列：この銘柄を持つAI（株数の多い順）と、読んだ情報（新しい順）", () => {
    expect(b.holders.map((h) => [h.agentId, h.qty, h.valueText])).toEqual([["ai-hold", 300, "¥3,600"], ["ai-ma5", 100, "¥1,200"]]);
    expect(b.sources.map((s) => s.seq)).toEqual([3, 4]); // 取得の新しい順（3 は 11/09、4 は 11/06）
  });

  it("返信の輪になっていても、すべての投稿が1回ずつ出る", () => {
    n = 0;
    const loop = buildView([ev("agent.registered", { agentId: "a", displayName: "a", startDate: "2026-11-09" }, 0), post("a", "X1", "h1", { replyTo: 3 }, 10), post("a", "X1", "h2", { replyTo: 2 }, 11)], (h) => bodies[h]);
    expect(buildBoard(loop, "X1")!.posts.map((p) => p.seq).sort()).toEqual([2, 3]);
  });
});

describe("buildBoard（ゴールデンログ）", async () => {
  const g = await buildGoldenLog(20261104);
  const v = buildView(g.events, (h) => g.bodies.get(h)?.value);

  it("銘柄ごとの投稿数が記録と一致し、引用は終値の記録。種類は未分類", () => {
    for (const sym of g.scenario.symbols) {
      const b = buildBoard(v, sym)!;
      const recorded = g.events.filter((e) => e.type === "post.published" && (e.payload as { board: string }).board === sym);
      expect(b.posts).toHaveLength(recorded.length);
      for (const p of b.posts) {
        expect(p.text).toContain("（架空のデータ）");
        expect(p.intent).toBeNull();
        expect(p.cites.length).toBeGreaterThan(0);
        expect(p.cites.every((c) => c.label.startsWith("終値"))).toBe(true);
      }
      expect(b.counts.none).toBe(recorded.length);
    }
  });
});
