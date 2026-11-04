import { describe, expect, it } from "vitest";
import type { LogEvent } from "../../src/events/types";
import { buildView } from "../../src/view/build";
import { formatSignedYen, formatYen } from "../../src/view/format";
import { buildGoldenLog } from "../fixtures/golden";

let n = 0;
const ev = (type: LogEvent["type"], payload: object, at: number): LogEvent => ({ seq: ++n, schema: 1, type, recordedAt: at, actor: "system", keys: [], refs: [], payload, prevHash: "", hash: "" });
const reg = (id: string, name: string) => ev("agent.registered", { agentId: id, displayName: name, startDate: "2026-11-09", initialCash: 1000 }, 0);

describe("formatYen", () => {
  it("0.1円単位の整数を桁区切りの文字にする（小数が0なら省く、負・符号つきも）", () => {
    expect(formatYen(0)).toBe("0円");
    expect(formatYen(12005)).toBe("1,200.5円");
    expect(formatYen(100_000_000)).toBe("10,000,000円");
    expect(formatYen(-5)).toBe("-0.5円");
    expect(formatSignedYen(15)).toBe("+1.5円");
    expect(formatSignedYen(-15)).toBe("-1.5円");
    expect(formatSignedYen(0)).toBe("0円");
    expect(() => formatYen(0.5)).toThrow();
  });
});

describe("buildView（手で組んだ小さなログ）", () => {
  n = 0;
  const events = [
    reg("a", "あ"),
    reg("b", "い"),
    ev("post.published", { agentId: "a", board: "X1", bodyHash: "h1", citeSeqs: [1], runSeq: 1 }, 100),
    ev("post.published", { agentId: "b", board: "X1", bodyHash: "missing", citeSeqs: [], runSeq: 1, replyTo: 3 }, 110),
    ev("post.published", { agentId: "a", board: "X2", bodyHash: "h1", citeSeqs: [], runSeq: 1 }, 115),
    ev("order_sheet.committed", { agentId: "a", tradingDate: "2026-11-09", orders: [{ symbol: "X1", side: "buy", qty: 100 }, { symbol: "X2", side: "buy", qty: 100 }] }, 120),
    ev("order_sheet.rejected", { agentId: "b", tradingDate: "2026-11-09", reason: "suspended" }, 130),
    ev("fills.executed", { agentId: "a", fills: [{ symbol: "X1", side: "buy", requestedQty: 100, qty: 100, price: 12005, amount: 1, status: "filled" }, { symbol: "X2", side: "buy", requestedQty: 100, qty: 0, price: null, amount: 0, status: "expired", reason: "no_open_price" }] }, 140),
    ev("agent.suspended", { agentId: "*", scope: "both", reason: "点検" }, 150),
    ev("content.withdrawn", { targetSeq: 5, reason: "誤り", textRemoved: false }, 155),
    ev("prices.close", { date: "2026-11-09", valuesHash: "x" }, 156),
    ev("prices.close", { date: "2026-11-10", valuesHash: "x" }, 157),
    ev("valuation.recorded", { agentId: "a", date: "2026-11-09", cash: 300, positions: [{ symbol: "X1", qty: 100, price: 12, closeSeq: 11 }], total: 1500 }, 160),
    ev("valuation.recorded", { agentId: "b", date: "2026-11-09", cash: 1500, positions: [], total: 1500 }, 170),
    ev("valuation.recorded", { agentId: "a", date: "2026-11-10", cash: 300, positions: [{ symbol: "X1", qty: 100, price: 12, closeSeq: 11 }], total: 1400 }, 180),
    ev("valuation.recorded", { agentId: "b", date: "2026-11-10", cash: 1450, positions: [], total: 1450 }, 190),
    ev("valuation.recorded", { agentId: "c", date: "2026-11-10", cash: 0, positions: [], total: 1400 }, 195),
  ];
  const v = buildView([...events].reverse(), (h) => (h === "h1" ? "本文1" : undefined)); // 入力の順序に依らず seq 順
  const kinds = v.timeline.map((t) => t.kind);

  it("タイムラインは seq 順で、種類ごとの項目になる（注文票の中の注文・約定は1行ずつ）", () => {
    expect(kinds).toEqual(["post", "post", "post", "order_sheet", "rejected", "fill", "fill", "suspension", "valuation", "valuation", "valuation", "valuation", "valuation"]);
    expect(v.timeline.map((t) => t.at)).toEqual([...v.timeline.map((t) => t.at)].sort((a, b) => a - b));
    expect(v.timeline[0]).toMatchObject({ agentName: "あ", symbol: "X1", text: "本文1", withdrawn: null, citeSeqs: [1], replyTo: null, runSeq: 1 });
    expect(v.timeline[1]).toMatchObject({ text: null, withdrawn: null, replyTo: 3 });
    // 非表示の投稿は本文が保管に残っていても出さず、同じ位置に理由を残す
    expect(v.timeline[2]).toMatchObject({ seq: 5, text: null, withdrawn: { reason: "誤り" } });
    expect(v.timeline[3]).toMatchObject({ orders: [{ symbol: "X1", side: "buy", qty: 100 }, { symbol: "X2", side: "buy", qty: 100 }] });
    expect(v.timeline[4]).toMatchObject({ agentName: "い", reason: "suspended" });
    expect(v.timeline[5]).toMatchObject({ fillIndex: 0, symbol: "X1", price: 12005, priceText: "1,200.5円", status: "filled" });
    expect(v.timeline[6]).toMatchObject({ fillIndex: 1, symbol: "X2", price: null, priceText: null, status: "expired", reason: "no_open_price" });
    expect(v.timeline[7]).toMatchObject({ agentId: "*", agentName: "全体", action: "suspended", scope: "both", reason: "点検" });
  });

  it("評価は前日比（最初の日は初期資金との差）を持つ", () => {
    const vals = v.timeline.filter((t) => t.kind === "valuation");
    expect(vals.map((t) => [t.agentId, t.date, t.totalText, t.changeText])).toEqual([
      ["a", "2026-11-09", "150円", "+50円"],
      ["b", "2026-11-09", "150円", "+50円"],
      ["a", "2026-11-10", "140円", "-10円"],
      ["b", "2026-11-10", "145円", "-5円"],
      ["c", "2026-11-10", "140円", "-9,999,860円"], // 未登録のAIは名前がIDのまま、基準は台帳の初期資金
    ]);
    // 評価に使った保有。終値の日付が評価日より前なら stale（closeSeq 11 は 11-09 の終値）
    expect(vals.map((t) => t.positions.map((x) => [x.priceText, x.stale]))).toEqual([[["1.2円", false]], [], [["1.2円", true]], [], []]);
  });

  it("銘柄スレッドは投稿と約定だけを銘柄ごとに時刻順で持つ", () => {
    expect(v.threads.map((t) => [t.symbol, t.items.map((i) => i.kind)])).toEqual([["X1", ["post", "post", "fill"]], ["X2", ["post", "fill"]]]);
  });

  it("AIの成績は日ごとの評価額と順位（同額は同順位）", () => {
    expect(v.agents.map((a) => [a.agentId, a.agentName, a.days.map((d) => [d.date, d.total, d.rank])])).toEqual([
      ["a", "あ", [["2026-11-09", 1500, 1], ["2026-11-10", 1400, 2]]],
      ["b", "い", [["2026-11-09", 1500, 1], ["2026-11-10", 1450, 1]]],
      ["c", "c", [["2026-11-10", 1400, 2]]],
    ]);
  });
});

describe("buildView（ゴールデンログ）", async () => {
  const g = await buildGoldenLog(20261104);
  const v = buildView(g.events, (h) => g.bodies.get(h)?.value);
  const of = (t: LogEvent["type"]) => g.events.filter((e) => e.type === t);
  const count = (k: string) => v.timeline.filter((t) => t.kind === k).length;
  const fills = of("fills.executed").flatMap((e) => (e.payload as { agentId: string; fills: unknown[] }).fills);

  it("件数が記録と一致し、時刻順に並ぶ", () => {
    expect([count("post"), count("order_sheet"), count("fill"), count("valuation"), count("rejected"), count("suspension")]).toEqual([of("post.published").length, of("order_sheet.committed").length, fills.length, of("valuation.recorded").length, 0, 0]);
    expect(v.timeline.length).toBe(of("post.published").length + of("order_sheet.committed").length + fills.length + of("valuation.recorded").length);
    const at = v.timeline.map((t) => t.at);
    expect(at).toEqual([...at].sort((a, b) => a - b));
  });

  it("投稿の本文は保管の本文と同じで、評価額・約定価格は記録の値と一致する", () => {
    for (const t of v.timeline) {
      if (t.kind === "post") expect(t.text).toContain("（架空のデータ）");
      if (t.kind === "valuation") {
        const e = g.events[t.seq - 1]!;
        expect(t.total).toBe((e.payload as { total: number }).total);
        expect(t.totalText).toBe(formatYen(t.total));
      }
    }
    const buys = v.timeline.flatMap((t) => (t.kind === "fill" && t.status === "filled" && t.side === "buy" ? [t] : []));
    expect(buys.length).toBeGreaterThan(0);
    for (const f of buys) expect(f.price).toBeGreaterThan(0);
  });

  it("約定の各行が、元の fills.executed の fills[i] と項目ごとに一致する", () => {
    for (const t of v.timeline) {
      if (t.kind !== "fill") continue;
      const p = g.events[t.seq - 1]!.payload as { agentId: string; tradingDate: string; fills: Record<string, unknown>[] };
      const f = p.fills[t.fillIndex]!;
      expect([t.agentId, t.tradingDate, t.symbol, t.side, t.requestedQty, t.qty, t.price, t.status]).toEqual([p.agentId, p.tradingDate, f.symbol, f.side, f.requestedQty, f.qty, f.price, f.status]);
    }
  });

  it("最後の日の評価額が台帳の口座の評価と同じ。順位は1から始まり、日ごとにAI数以下", () => {
    const days = g.scenario.tradingDays;
    expect(v.agents.map((a) => a.days.map((d) => d.date))).toEqual(g.scenario.agents.map(() => [...days]));
    for (const date of days) {
      const ranks = v.agents.map((a) => a.days.find((d) => d.date === date)!.rank);
      expect(Math.min(...ranks)).toBe(1);
      expect(Math.max(...ranks)).toBeLessThanOrEqual(g.scenario.agents.length);
    }
    // 変化の累計 = 最終日の評価額 - 初期資金
    for (const a of v.agents) expect(a.days.reduce((s, d) => s + d.change, 0)).toBe(a.days.at(-1)!.total - 100_000_000);
  });

  it("銘柄スレッドは、投稿と約定の件数に一致し、銘柄は架空の3つ", () => {
    expect(v.threads.map((t) => t.symbol)).toEqual([...g.scenario.symbols].sort());
    expect(v.threads.reduce((s, t) => s + t.items.length, 0)).toBe(count("post") + count("fill"));
  });
});
