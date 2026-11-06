import { describe, expect, it } from "vitest";
import type { LogEvent } from "../../src/events/types";
import { intentOf, readText, stanceOf } from "../../src/view/body";
import { buildBoard, filterPosts } from "../../src/view/board";
import { buildView } from "../../src/view/build";
import { buildGoldenLog } from "../fixtures/golden";

let n = 0;
const ev = (type: LogEvent["type"], payload: object, at: number): LogEvent => ({ seq: ++n, schema: 1, type, recordedAt: at, actor: "system", keys: [], refs: [], payload, prevHash: "", hash: "" });
const T = (date: string, hh: number) => Date.parse(`${date}T${String(hh).padStart(2, "0")}:00:00+09:00`);

describe("投稿の本文・種類・見立ての読み取り", () => {
  it("本文は文字列だけ。種類と見立ては一覧の中の値だけ（それ以外は未分類・見立てなし）", () => {
    expect(readText("本文")).toBe("本文");
    for (const bad of [null, undefined, 5, [], { text: "a" }]) expect(readText(bad)).toBeNull();
    expect([intentOf("news"), intentOf("gossip"), intentOf("News"), intentOf(3), intentOf(undefined)]).toEqual(["news", null, null, null, null]);
    expect([stanceOf("bear"), stanceOf("up"), stanceOf(null)]).toEqual(["bear", null, null]);
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
    post("ai-ma5", "X1", "h1", { citeSeqs: [3, 4, 99], intent: "strategy", stance: "bull" }, 10), // 5 根
    post("ai-hold", "X1", "h2", { replyTo: 5 }, 11), // 6 返信
    post("ai-ma5", "X1", "h3", { replyTo: 6, intent: "feeling", stance: "gossip" }, 12), // 7 返信の返信
    post("ai-hold", "X1", "h4", { replyTo: 7, citeSeqs: [5, 1] }, 13), // 8 深さは2まで。投稿 5 と登録の記録を引用
    post("ai-hold", "X2", "h5", { replyTo: 5 }, 14), // 9 親が別の掲示板 → 根
    post("ai-hold", "X1", "h6", {}, 15), // 10 根（新しい）
    ev("fills.executed", { agentId: "ai-ma5", sheetSeq: 10, tradingDate: "2026-11-10", fills: [{ symbol: "X1", side: "buy", requestedQty: 100, qty: 100, price: 100, amount: 10_000, status: "filled" }, { symbol: "X2", side: "buy", requestedQty: 100, qty: 100, price: 100, amount: 10_000, status: "filled" }] }, T("2026-11-10", 9)), // 11
    ev("content.withdrawn", { targetSeq: 10, reason: "誤り", textRemoved: false }, T("2026-11-10", 10)), // 12
    ev("valuation.recorded", { agentId: "ai-ma5", date: "2026-11-10", cash: 0, positions: [{ symbol: "X1", qty: 100, price: 120, closeSeq: 4 }], total: 12_000 }, T("2026-11-10", 16)),
    ev("valuation.recorded", { agentId: "ai-hold", date: "2026-11-10", cash: 1000, positions: [{ symbol: "X1", qty: 300, price: 120, closeSeq: 4 }, { symbol: "X3", qty: 0, price: 1, closeSeq: 4 }], total: 1000 }, T("2026-11-10", 16)),
    // 投稿（seq 5〜10）より前に確定した注文票（seq 2）の約定。seq は投稿より後でも、「このあとの売買」にしない
    ev("fills.executed", { agentId: "ai-ma5", sheetSeq: 2, tradingDate: "2026-11-11", fills: [{ symbol: "X1", side: "sell", requestedQty: 100, qty: 100, price: 110, amount: 11_000, status: "filled" }] }, T("2026-11-11", 9)),
  ];
  const bodies: Record<string, unknown> = { h1: "戦略の話", h2: "返信", h3: "感情", h4: "深い返信", h5: "別の板", h6: "取り消し予定" };
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
      { seq: 3, label: "news:x", publishedText: "11/09 07:00", fetchedText: "11/09 08:00", postSeq: null },
      { seq: 4, label: "終値 11/06（fixture:synthetic）", publishedText: null, fetchedText: "11/06 16:00", postSeq: null },
      { seq: 99, label: "記録が見つかりません", publishedText: null, fetchedText: "－", postSeq: null }, // 落とさず、見つからないと出す
    ]);
    // 出典でない記録（投稿・登録）の引用も残す。投稿ならこの掲示板の中でリンクできる
    expect(b.posts.find((p) => p.seq === 8)!.cites).toMatchObject([{ seq: 5, label: "記録（post.published）", postSeq: 5 }, { seq: 1, label: "記録（agent.registered）", postSeq: null }]);
    expect(b.posts.find((p) => p.seq === 6)!.replyTo).toEqual({ seq: 5, inBoard: true });
    expect(buildBoard(v, "X2")!.posts[0]!.replyTo).toEqual({ seq: 5, inBoard: false });
    // ai-ma5 の売買は X1 の1件だけ（X2 は別の銘柄）。売買（seq 11）は、ai-ma5 の次の投稿（seq 7）より後なので、seq 5 にはつかず、最後の投稿（seq 7）につく
    expect(p5.trades).toEqual([]);
    expect(b.posts.find((p) => p.seq === 7)!.trades).toEqual([{ href: "/agents/ai-ma5#f11-0", text: "11/10 買 100株 @¥10" }]);
  });

  it("右の列：この銘柄を持つAI（株数の多い順・基準日つき）と、投稿が引用した記録", () => {
    expect(b.holders.map((h) => [h.agentId, h.qty, h.valueText, h.asOf, h.stale])).toEqual([["ai-hold", 300, "¥3,600", "11/10", true], ["ai-ma5", 100, "¥1,200", "11/10", true]]); // 終値は11/06のもの（closeSeq 4）なので、直近の終値で評価した印
    expect(b.sources.map((s) => s.seq)).toEqual([3, 4, 99, 5, 1]); // 投稿が引用した記録。取得の新しい順で、取得時刻のないものは後ろ（seq の大きい順）
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
