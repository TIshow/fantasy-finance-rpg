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
    expect(page.holdings).toEqual([{ symbol: "X1", qty: 100, valueText: "¥1,200", weightText: "80.0%", closeText: "¥12", stale: false, unitCostText: "¥10", unrealized: { direction: "up", text: "▲ +¥200" } }]);
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
    expect(page.chart).toMatchObject({ to: "11/10" });
    expect(page.chart!.lines.map((l) => l.name)).toEqual(["ホールデン翁", "ミア・ファイヴ"]);
  });
});

describe("buildAgentPage（時点・順序・停止の細かい場合）", () => {
  const base = (extra: LogEvent[], vals: [string, string, number, object[]?][]) => {
    n = 0;
    return buildView(
      [
        ev("agent.registered", { agentId: "ai-ma5", displayName: "あ", startDate: "2026-11-09", initialCash: 10_000 }, 0),
        ev("agent.registered", { agentId: "ai-hold", displayName: "い", startDate: "2026-11-09", initialCash: 10_000 }, 0),
        ...extra,
        ...vals.map(([id, date, total, positions]) => ev("valuation.recorded", { agentId: id, date: `2026-11-${date}`, cash: total, positions: positions ?? [], total }, T(`2026-11-${date}`, 16))),
      ],
      () => undefined,
    );
  };
  const held = acct({ X1: { qty: 100, cost: 10_000 } });

  it("最後の評価より後に約定があれば、株数が同じでも取得単価・含み損益を出さない", () => {
    const evs = [ev("fills.executed", { agentId: "ai-ma5", sheetSeq: 0, tradingDate: "2026-11-10", fills: [{ symbol: "X1", side: "sell", requestedQty: 100, qty: 100, price: 90, amount: 9000, status: "filled" }] }, T("2026-11-10", 9))];
    const v = base(evs, [["ai-ma5", "09", 12_000, [pos("X1", 100, 120)]], ["ai-hold", "09", 10_000]]);
    const h = buildAgentPage(v, held, "ai-ma5")!.holdings[0]!;
    expect([h.unitCostText, h.unrealized]).toEqual([null, null]);
    // 約定が評価より前なら出る
    n = 0;
    const v2 = base([], [["ai-ma5", "09", 12_000, [pos("X1", 100, 120)]]]);
    expect(buildAgentPage(v2, held, "ai-ma5")!.holdings[0]!.unitCostText).toBe("¥10");
  });

  it("評価が書きかけの日は、順位とバッジに数えない（先に評価されたAIが仮に1位になる）", () => {
    // 9日は ai-hold が上（ai-ma5 は2位）。10日は ai-hold がまだで、ai-ma5 だけ見ると仮に1位
    const v = base([], [["ai-ma5", "09", 10_000], ["ai-hold", "09", 11_000], ["ai-ma5", "10", 12_000]]);
    const p = buildAgentPage(v, new Map(), "ai-ma5")!;
    expect(p.rank).toBe(2); // 9日（そろった日）の順位。書きかけの10日の仮の1位ではない
    expect(p.rankAsOf).toBe("11/09");
    expect(p.badges).not.toContain("連続首位 2日");
    expect(buildArena(v).cards.find((c) => c.agentId === "ai-ma5")!.rank).toBe(2);
    // そろえば数える
    const done = base([], [["ai-ma5", "09", 11_000], ["ai-hold", "09", 10_000], ["ai-ma5", "10", 12_000], ["ai-hold", "10", 10_000]]);
    expect(buildAgentPage(done, new Map(), "ai-ma5")!.badges).toContain("連続首位 2日");
    // 開始が遅いAI（10日から）は、9日をそろった日として数えるのを止めない。10日はそろって ai-ma5 が2位
    const late = base([], [["ai-ma5", "09", 11_000], ["ai-ma5", "10", 10_000], ["ai-hold", "10", 11_000]]);
    expect(buildAgentPage(late, new Map(), "ai-ma5")!.rank).toBe(2);
    expect(buildAgentPage(late, new Map(), "ai-ma5")!.rankAsOf).toBe("11/10");
  });

  it("直近の終値で評価した保有には、その印がつく", () => {
    const evs: LogEvent[] = [];
    const v = base(evs, [["ai-ma5", "09", 12_000, [{ ...pos("X1", 100, 120) }]]]);
    expect(buildAgentPage(v, held, "ai-ma5")!.holdings[0]!.stale).toBe(false);
    const staleView = { ...v, timeline: v.timeline.map((t) => (t.kind === "valuation" ? { ...t, positions: t.positions.map((q) => ({ ...q, stale: true })) } : t)) };
    expect(buildAgentPage(staleView, held, "ai-ma5")!.holdings[0]!.stale).toBe(true);
  });

  it("拒否の行は『受付』で、約定日が不正でも壊れない。同じ日の約定は売り→買いの順", () => {
    const evs = [
      ev("order_sheet.rejected", { agentId: "ai-ma5", tradingDate: "invalid", reason: "invalid_sheet", runSeq: 5 }, T("2026-11-09", 20)),
      ev("fills.executed", { agentId: "ai-ma5", sheetSeq: 0, tradingDate: "2026-11-10", fills: [
        { symbol: "X1", side: "sell", requestedQty: 100, qty: 100, price: 90, amount: 9000, status: "filled" },
        { symbol: "X1", side: "buy", requestedQty: 100, qty: 100, price: 91, amount: 9100, status: "filled" },
      ] }, T("2026-11-10", 9)),
    ];
    const h = buildAgentPage(base(evs, [["ai-ma5", "10", 10_000]]), new Map(), "ai-ma5")!.history;
    expect(h.map((r) => [r.dateText, r.head, r.timeLabel, r.runSeq])).toEqual([["11/10", "売", "確定", null], ["11/10", "買", "確定", null], ["－", "注文票", "受付", 5]]);
  });

  it("売買しない日（#102：空の注文票と空の約定）は『売買なし』の1行になる。約定のある日と並ぶ", () => {
    n = 0;
    const evs = [
      ev("agent.registered", { agentId: "ai-ma5", displayName: "あ", startDate: "2026-11-09", initialCash: 10_000 }, 0), // seq 1
      ev("order_sheet.committed", { agentId: "ai-ma5", tradingDate: "2026-11-09", runSeq: 11, orders: [] }, T("2026-11-06", 21)), // seq 2
      ev("fills.executed", { agentId: "ai-ma5", sheetSeq: 2, openSeq: 0, tradingDate: "2026-11-09", fills: [] }, T("2026-11-09", 9)),
      ev("order_sheet.committed", { agentId: "ai-ma5", tradingDate: "2026-11-10", runSeq: 12, orders: [{ symbol: "X1", side: "buy", qty: 100 }] }, T("2026-11-09", 21)), // seq 4
      ev("fills.executed", { agentId: "ai-ma5", sheetSeq: 4, openSeq: 0, tradingDate: "2026-11-10", fills: [{ symbol: "X1", side: "buy", requestedQty: 100, qty: 100, price: 90, amount: 9000, status: "filled" }] }, T("2026-11-10", 9)),
    ];
    const view2 = buildView([...evs, ev("valuation.recorded", { agentId: "ai-ma5", date: "2026-11-10", cash: 10_000, positions: [], total: 10_000 }, T("2026-11-10", 16))], () => undefined);
    const p = buildAgentPage(view2, new Map(), "ai-ma5")!;
    expect(p.history.map((r) => [r.dateText, r.head, r.status, r.runSeq])).toEqual([["11/10", "買", "約定", 12], ["11/09", "注文なし", "売買なし", 11]]);
    expect(p.stats!.fills).toBe(1);
  });

  it("停止中のAIには、その旨が出る（全体の停止も。再開で消える）", () => {
    n = 2; // 登録の2件（seq 1・2）のあとに、停止（3）→再開（4）の順で置く
    const stop = ev("agent.suspended", { agentId: "*", scope: "orders", reason: "点検" }, T("2026-11-09", 10));
    const resume = ev("agent.resumed", { agentId: "*", scope: "orders", reason: "解除" }, T("2026-11-09", 11));
    expect(buildAgentPage(base([stop], [["ai-ma5", "09", 10_000]]), new Map(), "ai-ma5")!.suspended).toBe("停止中（注文）");
    expect(buildAgentPage(base([stop, resume], [["ai-ma5", "09", 10_000]]), new Map(), "ai-ma5")!.suspended).toBeNull();
  });

  it("停止の範囲は実行側と同じ決め方（IDごとの範囲の集合。どちらかが止めていれば停止）", () => {
    const sus = (agentId: string, scope: string, resumed = false) => ev(resumed ? "agent.resumed" : "agent.suspended", { agentId, scope, reason: "x" }, T("2026-11-09", 10));
    const of = (evs: LogEvent[]) => buildAgentPage(base(evs, [["ai-ma5", "09", 10_000]]), new Map(), "ai-ma5")!.suspended;
    expect(of([sus("ai-ma5", "both"), sus("*", "both", true)])).toBe("停止中（投稿と注文）"); // (a) 全体の再開は、AI個別の停止を解かない
    expect(of([sus("ai-ma5", "posts"), sus("ai-ma5", "orders")])).toBe("停止中（投稿と注文）"); // (b) 範囲は足し合わせる
    expect(of([sus("*", "orders"), sus("ai-ma5", "orders", true)])).toBe("停止中（注文）"); // (c) AI個別の再開は、全体の停止を解かない
    expect(of([sus("ai-ma5", "both"), sus("ai-ma5", "posts", true)])).toBe("停止中（注文）"); // 一部だけ再開
    expect(of([sus("ai-hold", "both")])).toBeNull(); // 別のAIの停止
  });

  it("開始が遅いAIに、実在しない線を引かない（初期資金の点は最初の評価の日の1つ前）", () => {
    const v = base([], [["ai-ma5", "09", 10_000], ["ai-ma5", "10", 11_000], ["ai-hold", "10", 9_000]]);
    const late = buildAgentPage(v, new Map(), "ai-ma5")!.chart!.lines.find((l) => l.agentId === "ai-hold")!;
    expect(late.points.split(" ")[0]!.split(",")[0]).toBe("300"); // 2日のうち2日目から始まる（x = 1日分 = 300）
    expect(late.points.split(" ")).toHaveLength(2);
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
