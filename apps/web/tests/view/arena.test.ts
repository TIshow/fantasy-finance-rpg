import { describe, expect, it } from "vitest";
import type { LogEvent } from "../../src/events/types";
import { buildArena, sparkline, SPARK_H } from "../../src/view/arena";
import { characterOf, handleOf } from "../../src/view/characters";
import { buildView } from "../../src/view/build";
import { formatBp, formatJstShort, formatMonthDay, formatSignedYenMark, formatYenMark, roundedRatio } from "../../src/view/format";
import { buildGoldenLog } from "../fixtures/golden";

let n = 0;
const ev = (type: LogEvent["type"], payload: object, at: number): LogEvent => ({ seq: ++n, schema: 1, type, recordedAt: at, actor: "system", keys: [], refs: [], payload, prevHash: "", hash: "" });
const T = (date: string, hh: number) => Date.parse(`${date}T${String(hh).padStart(2, "0")}:00:00+09:00`);

describe("キャラの設定の表", () => {
  it("決めたIDとゴールデンログのIDは同じキャラに引ける", () => {
    expect(characterOf("ai-ma5", "x")).toMatchObject({ look: "mia", name: "ミア・ファイヴ", color: "#00E5FF" });
    expect(characterOf("ai-reversal", "x")).toMatchObject({ look: "riva", name: "リバ・ゼロ", color: "#FF2E88" });
    expect(characterOf("ai-hold", "x")).toMatchObject({ look: "holden", name: "ホールデン翁", color: "#B6FF3B" });
    expect(["ai-a", "ai-b", "ai-c"].map((id) => characterOf(id, "x").look)).toEqual(["mia", "riva", "holden"]);
  });

  it("未知のIDは伏せカードの見た目で、名前は記録のまま（Object のプロパティ名でも同じ）", () => {
    for (const id of ["ai-new", "constructor", "__proto__", "toString"]) expect(characterOf(id, "記録の名前")).toMatchObject({ look: "locked", name: "記録の名前" });
    expect(handleOf("ai-new")).toBe("@ai-new");
  });
});

describe("表示の書式（整数だけで文字にする）", () => {
  it("円・符号・割合・日付", () => {
    expect(formatYenMark(102_076_000)).toBe("¥10,207,600");
    expect(formatYenMark(22_515)).toBe("¥2,251.5");
    expect(formatYenMark(-5)).toBe("-¥0.5");
    expect(formatSignedYenMark(2_076_000)).toBe("+¥207,600");
    expect(formatSignedYenMark(-10)).toBe("-¥1");
    expect(formatSignedYenMark(0)).toBe("¥0");
    expect(roundedRatio(2_076_000, 100_000_000, 10000)).toBe(208);
    expect(roundedRatio(-2_076_000, 100_000_000, 10000)).toBe(-208);
    expect(roundedRatio(1, 3, 1000)).toBe(333);
    expect(() => roundedRatio(1, 0, 10)).toThrow();
    expect(formatBp(208, true)).toBe("+2.08%");
    expect(formatBp(-5, true)).toBe("-0.05%");
    expect(formatBp(0, true)).toBe("0.00%");
    expect(formatMonthDay("2026-11-18")).toBe("11/18");
    expect(formatJstShort(Date.parse("2026-11-18T16:30:00+09:00"))).toBe("11/18 16:30");
  });
});

describe("sparkline", () => {
  it("初期資金から始まり、高い値ほど上（y が小さい）。破線は初期資金の位置", () => {
    const s = sparkline([1000, 1010, 990], 1000);
    const ys = s.points.split(" ").map((p) => Number(p.split(",")[1]));
    expect(s.points.split(" ").map((p) => p.split(",")[0])).toEqual(["0", "70", "140"]);
    expect(ys[1]).toBeLessThan(ys[0]!);
    expect(ys[2]).toBeGreaterThan(ys[0]!);
    expect(ys[0]).toBe(s.baseY);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...ys)).toBeLessThanOrEqual(SPARK_H);
    expect(s.label).toContain("2営業日");
  });

  it("1点・全部同じ値でも壊れない（横線）", () => {
    const one = sparkline([1000], 1000);
    expect(one.points.split(" ")).toHaveLength(2);
    expect(one.label).toContain("初期資金と同じ");
    const flat = sparkline([1000, 1000, 1000], 1000);
    expect(new Set(flat.points.split(" ").map((p) => p.split(",")[1])).size).toBe(1);
  });
});

describe("buildArena（手で組んだ小さなログ）", () => {
  n = 0;
  const events = [
    ev("agent.registered", { agentId: "ai-ma5", displayName: "あ", startDate: "2026-11-09", initialCash: 1000 }, 0),
    ev("agent.registered", { agentId: "ai-new", displayName: "新人", startDate: "2026-11-09", initialCash: 1000 }, 0),
    ev("agent.registered", { agentId: "ai-hold", displayName: "う", startDate: "2026-11-09", initialCash: 1000 }, 0),
    ev("post.published", { agentId: "ai-ma5", board: "X1", bodyHash: "h1", citeSeqs: [], runSeq: 1 }, T("2026-11-09", 21)),
    ev("post.published", { agentId: "ai-ma5", board: "X1", bodyHash: "h2", citeSeqs: [], runSeq: 1 }, T("2026-11-09", 22)),
    ev("content.withdrawn", { targetSeq: 5, reason: "誤り", textRemoved: false }, T("2026-11-09", 23)),
    ev("fills.executed", { agentId: "ai-ma5", tradingDate: "2026-11-10", fills: [
      { symbol: "X1", side: "buy", requestedQty: 100, qty: 100, price: 100, amount: 10_000, status: "filled" },
      { symbol: "X2", side: "buy", requestedQty: 100, qty: 0, price: null, amount: 0, status: "expired", reason: "no_open_price" },
    ] }, T("2026-11-10", 9)),
    ev("valuation.recorded", { agentId: "ai-ma5", date: "2026-11-10", cash: 400, positions: [{ symbol: "X1", qty: 3, price: 100, closeSeq: 0 }, { symbol: "X2", qty: 1, price: 200, closeSeq: 0 }, { symbol: "X3", qty: 2, price: 50, closeSeq: 0 }], total: 1000 + 200, }, T("2026-11-10", 16)),
    ev("valuation.recorded", { agentId: "ai-hold", date: "2026-11-10", cash: 1000, positions: [], total: 900 }, T("2026-11-10", 16)),
  ];
  const arena = buildArena(buildView(events, (h) => (h === "h1" ? "最初の投稿" : h === "h2" ? "取り消された投稿" : undefined)));
  const byId = Object.fromEntries(arena.cards.map((c) => [c.agentId, c]));

  it("順位の順に並び、評価のないAIも出る（順位なし）。人数は登録されたAI", () => {
    expect(arena.cards.map((c) => [c.agentId, c.rank])).toEqual([["ai-ma5", 1], ["ai-hold", 2], ["ai-new", null]]);
    expect(byId["ai-new"]!.character.look).toBe("locked");
    expect(byId["ai-new"]!.totalText).toBe("¥100"); // 初期資金 1000（0.1円単位）
  });

  it("総資産と累計損益は記録から。上昇は▲、下落は▼、同じなら－", () => {
    expect(byId["ai-ma5"]!).toMatchObject({ totalText: "¥120", pnl: { direction: "up", text: "+¥20", percentText: "+20.00%" } });
    expect(byId["ai-hold"]!.pnl).toMatchObject({ direction: "down", text: "-¥10", percentText: "-10.00%" });
    expect(byId["ai-new"]!.pnl).toMatchObject({ direction: "flat", text: "¥0", percentText: "0.00%" });
  });

  it("持ち株の上位2つは評価額の大きい順で、構成比は評価額÷総資産", () => {
    // 評価額は X1=300・X2=200・X3=100（0.1円単位）。総資産 1200
    expect(byId["ai-ma5"]!.top).toEqual([{ symbol: "X1", weightText: "25.0%", weightPct: 25 }, { symbol: "X2", weightText: "16.7%", weightPct: 16.7 }]);
    expect(byId["ai-hold"]!.top).toEqual([]);
  });

  it("今日のひとことは非表示でない直近の投稿の本文。直近の売買は約定したものだけ", () => {
    expect(byId["ai-ma5"]!.quote).toBe("最初の投稿"); // 後の投稿は非表示
    expect(byId["ai-hold"]!.quote).toBeNull();
    expect(byId["ai-ma5"]!.lastTrade).toBe("11/10 買 X1 100株");
    expect(byId["ai-hold"]!.lastTrade).toBeNull();
  });

  it("ライブフィードは新しい順で、約定・投稿・順位。非表示の投稿は本文を出さない", () => {
    expect(arena.feed.map((f) => f.kind)).toEqual(["rank", "fill", "post", "post"]);
    expect(arena.feed[0]!.text).toBe("ミア・ファイヴが首位に立つ（総資産 ¥120）");
    expect(arena.feed[1]!.text).toBe("ミア・ファイヴ　買 X1 100株 @¥10");
    expect(arena.feed[2]!.text).toContain("非表示：誤り");
    expect(arena.feed.map((f) => f.text).join()).not.toContain("取り消された投稿");
  });
});

describe("buildArena（ゴールデンログ）", async () => {
  const g = await buildGoldenLog(20261104);
  const view = buildView(g.events, (h) => g.bodies.get(h)?.value);
  const arena = buildArena(view);
  const lastVal = (id: string) => g.events.filter((e) => e.type === "valuation.recorded" && (e.payload as { agentId: string }).agentId === id).at(-1)!.payload as { total: number };

  it("カードはAIごとに1枚。総資産は最後の評価の記録と一致し、順位は1から", () => {
    expect(arena.cards).toHaveLength(g.scenario.agents.length);
    for (const c of arena.cards) expect(c.totalText).toBe(formatYenMark(lastVal(c.agentId).total));
    expect(arena.cards[0]!.rank).toBe(1);
    expect(arena.cards.map((c) => c.rank!)).toEqual([...arena.cards.map((c) => c.rank!)].sort((a, b) => a - b));
  });

  it("構成比は0〜100%、上位2つまで。ひとことは保管の本文そのもの", () => {
    for (const c of arena.cards) {
      expect(c.top.length).toBeLessThanOrEqual(2);
      for (const h of c.top) expect(h.weightPct).toBeGreaterThanOrEqual(0), expect(h.weightPct).toBeLessThanOrEqual(100);
      if (c.quote !== null) expect([...g.bodies.values()].map((b) => b.value)).toContain(c.quote);
    }
  });

  it("フィードは新しい順で12件以内", () => {
    expect(arena.feed.length).toBeLessThanOrEqual(12);
    expect(arena.feed.length).toBeGreaterThan(0);
    expect(new Set(arena.feed.map((f) => f.key)).size).toBe(arena.feed.length);
  });
});
