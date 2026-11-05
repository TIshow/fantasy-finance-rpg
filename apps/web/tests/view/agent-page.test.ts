import { describe, expect, it } from "vitest";
import type { LogEvent } from "../../src/events/types";
import type { Account } from "../../src/ledger/types";
import { buildAgentPage } from "../../src/view/agent-page";
import { buildArena } from "../../src/view/arena";
import { buildView } from "../../src/view/build";
import { formatYenMark } from "../../src/view/format";
import { buildGoldenLog } from "../fixtures/golden";

let n = 0;
const ev = (type: LogEvent["type"], payload: object, at: number): LogEvent => ({ seq: ++n, schema: 1, type, recordedAt: at, actor: "system", keys: [], refs: [], payload, prevHash: "", hash: "" });
const T = (date: string, hh: number) => Date.parse(`${date}T${String(hh).padStart(2, "0")}:00:00+09:00`);
const pos = (symbol: string, qty: number, price: number) => ({ symbol, qty, price, closeSeq: 0 });
const acct = (holdings: Account["holdings"]): ReadonlyMap<string, Account> => new Map([["ai-ma5", { cash: 0, holdings }]]);

n = 0;
const events = [
  ev("agent.registered", { agentId: "ai-ma5", displayName: "あ", startDate: "2026-11-09", initialCash: 10_000 }, 0),
  ev("agent.registered", { agentId: "ai-hold", displayName: "い", startDate: "2026-11-09", initialCash: 10_000 }, 0),
  ev("order_sheet.committed", { agentId: "ai-ma5", tradingDate: "2026-11-09", runSeq: 77, orders: [{ symbol: "X1", side: "buy", qty: 100 }] }, T("2026-11-08", 21)),
  ev("fills.executed", { agentId: "ai-ma5", sheetSeq: 3, tradingDate: "2026-11-09", fills: [{ symbol: "X1", side: "buy", requestedQty: 200, qty: 100, price: 100, amount: 10_000, status: "reduced", reason: "insufficient_cash" }] }, T("2026-11-09", 9)),
  ev("order_sheet.committed", { agentId: "ai-ma5", tradingDate: "2026-11-10", runSeq: 88, orders: [] }, T("2026-11-09", 21)),
  ev("order_sheet.rejected", { agentId: "ai-hold", tradingDate: "2026-11-10", reason: "suspended" }, T("2026-11-09", 22)),
  ...["09", "10"].flatMap((d) => [
    ev("valuation.recorded", { agentId: "ai-ma5", date: `2026-11-${d}`, cash: d === "09" ? 2000 : 3000, positions: [pos("X1", 100, 120)], total: d === "09" ? 14_000 : 15_000 }, T(`2026-11-${d}`, 16)),
    ev("valuation.recorded", { agentId: "ai-hold", date: `2026-11-${d}`, cash: 10_000, positions: [], total: d === "09" ? 11_000 : 10_000 }, T(`2026-11-${d}`, 16)),
  ]),
];
const view = buildView(events, () => undefined);

describe("buildAgentPage（手で組んだ小さなログ）", () => {
  const page = buildAgentPage(view, acct({ X1: { qty: 100, cost: 10_000 } }), "ai-ma5")!;

  it("知らないAIは null。評価のないAIは成績・推移なし", () => {
    expect(buildAgentPage(view, acct({}), "nobody")).toBeNull();
    const v = buildView(events.slice(0, 2), () => undefined);
    expect(buildAgentPage(v, new Map(), "ai-ma5")).toMatchObject({ stats: null, chart: null, holdings: [], cash: null, rank: null });
  });

  it("成績は記録から：総資産・前日比・累計損益（▲▼つき）・約定の回数", () => {
    expect(page.stats).toMatchObject({ totalText: "¥1,500", asOf: "11/10", changeText: "▲ +¥100", pnlText: "▲ +¥500（+50.00%）", changeDirection: "up", pnlDirection: "up", fills: 1 });
    expect(page.rank).toBe(1);
    expect(buildAgentPage(view, new Map(), "ai-hold")!.stats).toMatchObject({ changeText: "▼ -¥100", pnlText: "－ ¥0（0.00%）", pnlDirection: "flat" });
  });

  it("バッジは記録から出せるものだけ（連続首位・全日プラス）", () => {
    expect(page.badges).toEqual(["連続首位 2日", "全日プラス 2日"]);
    expect(buildAgentPage(view, new Map(), "ai-hold")!.badges).toEqual([]);
  });

  it("持ち株は評価の記録と台帳の口座から。株数が合わないときは取得単価・含み損益を出さない", () => {
    expect(page.holdings).toEqual([{ symbol: "X1", qty: 100, valueText: "¥1,200", weightText: "80.0%", closeText: "¥12", unitCostText: "¥10", unrealized: { direction: "up", text: "▲ +¥200" } }]);
    expect(page.cash).toEqual({ text: "¥300", weightText: "20.0%" });
    const off = buildAgentPage(view, acct({ X1: { qty: 200, cost: 20_000 } }), "ai-ma5")!.holdings[0]!;
    expect([off.unitCostText, off.unrealized]).toEqual([null, null]);
    expect(buildAgentPage(view, new Map(), "ai-ma5")!.holdings[0]!.unitCostText).toBeNull();
  });

  it("取引履歴は新しい約定日から。確定の時刻と判断の実行の番号は元の注文票から", () => {
    expect(page.history.map((h) => [h.dateText, h.head, h.symbol, h.tail, h.status, h.reason, h.runSeq])).toEqual([
      ["11/10", "注文なし", null, "", "売買なし", null, 88],
      ["11/09", "買", "X1", " 100株 @¥10（注文 200株）", "一部のみ約定", "現金不足", 77],
    ]);
    expect(page.history[1]!.committedText).toBe("11/08 21:00");
    expect(buildAgentPage(view, new Map(), "ai-hold")!.history).toMatchObject([{ head: "注文票", status: "拒否", reason: "停止中" }]);
  });

  it("推移は全AIを重ね、このAIを最後に太く描く。全部の点が枠の中", () => {
    expect(page.chart!.lines.map((l) => [l.agentId, l.bold])).toEqual([["ai-hold", false], ["ai-ma5", true]]);
    for (const l of page.chart!.lines) for (const pt of l.points.split(" ")) { const [x, y] = pt.split(",").map(Number); expect(x).toBeGreaterThanOrEqual(0), expect(x).toBeLessThanOrEqual(600), expect(y).toBeGreaterThanOrEqual(0), expect(y).toBeLessThanOrEqual(200); }
    expect(page.chart).toMatchObject({ from: "11/09", to: "11/10" });
  });
});

describe("buildAgentPage（ゴールデンログ）", async () => {
  const g = await buildGoldenLog(20261104);
  const v = buildView(g.events, (h) => g.bodies.get(h)?.value);
  const accounts = new Map(g.scenario.agents.map((a) => [a.id, g.ledger.account(a.id)] as const));
  const fills = g.events.filter((e) => e.type === "fills.executed").flatMap((e) => (e.payload as { agentId: string; fills: { qty: number }[] }).fills.map((f) => ({ agentId: (e.payload as { agentId: string }).agentId, ...f })));

  it("AIごとに、総資産は最後の評価の記録、約定の回数は記録の約定、取得単価は台帳の口座と一致", () => {
    for (const a of g.scenario.agents) {
      const p = buildAgentPage(v, accounts, a.id)!;
      const last = g.events.filter((e) => e.type === "valuation.recorded" && (e.payload as { agentId: string }).agentId === a.id).at(-1)!.payload as { total: number };
      expect(p.stats!.totalText).toBe(formatYenMark(last.total));
      expect(p.stats!.fills).toBe(fills.filter((f) => f.agentId === a.id && f.qty > 0).length);
      for (const h of p.holdings) {
        const acc = accounts.get(a.id)!.holdings[h.symbol]!;
        expect(h.unitCostText).toBe(formatYenMark(Math.round(acc.cost / acc.qty)));
      }
      expect(p.history.length).toBeGreaterThan(0);
    }
  });

  it("構成比（持ち株＋現金）は100%前後。トップのカードの順位と同じ", () => {
    const arena = buildArena(v);
    for (const a of g.scenario.agents) {
      const p = buildAgentPage(v, accounts, a.id)!;
      const sum = [...p.holdings.map((h) => h.weightText), p.cash!.weightText].reduce((s, t) => s + Number(t.replace("%", "")), 0);
      expect(Math.abs(sum - 100)).toBeLessThan(0.5);
      expect(p.rank).toBe(arena.cards.find((c) => c.agentId === a.id)!.rank);
    }
  });
});
