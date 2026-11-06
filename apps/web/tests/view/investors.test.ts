import { describe, expect, it } from "vitest";
import type { LogEvent } from "../../src/events/types";
import type { FillReason, RejectReason } from "../../src/ledger/types";
import { buildAgentPage } from "../../src/view/agent-page";
import { buildArena } from "../../src/view/arena";
import { buildBoard } from "../../src/view/board";
import { buildView } from "../../src/view/build";
import { REASON } from "../../src/view/labels";

let n = 0;
const ev = (type: LogEvent["type"], payload: object, at: number): LogEvent => ({ seq: ++n, schema: 1, type, recordedAt: at, actor: "system", keys: [], refs: [], payload, prevHash: "", hash: "" });
const T = (date: string, hh: number) => Date.parse(`${date}T${String(hh).padStart(2, "0")}:00:00+09:00`);

describe("約定・拒否の理由の表示", () => {
  it("新しい4つの理由は、ふつうの言葉で表示する", () => {
    expect([REASON.no_price, REASON.outmatched, REASON.limit_not_reached, REASON.invalid_price]).toEqual(["その日は値段がつかなかった", "ほかの注文が優先された", "指値に届かなかった", "指値が呼値・値幅に合わなかった"]);
  });

  it("理由の型にあるすべてが、空でない表示を持つ（足したのに表示を付け忘れない）", () => {
    const all: (FillReason | RejectReason)[] = ["insufficient_cash", "insufficient_holdings", "no_open_price", "market_closed", "limit_not_reached", "no_price", "outmatched", "invalid_sheet", "after_cutoff", "wrong_trading_date", "account_not_ready", "already_committed", "invalid_order", "unknown_symbol", "invalid_qty", "invalid_price", "suspended"];
    expect(Object.keys(REASON).sort()).toEqual([...all].sort());
    for (const r of all) expect(REASON[r].length).toBeGreaterThan(0);
  });
});

describe("順位とカードはAI投資家だけ", () => {
  n = 0;
  const reg = (id: string, kind?: string) => ev("agent.registered", { agentId: id, displayName: id, startDate: "2026-11-09", initialCash: 1000, ...(kind ? { kind } : {}) }, 0);
  const val = (id: string, total: number) => ev("valuation.recorded", { agentId: id, date: "2026-11-10", cash: total, positions: [{ symbol: "NEO1", qty: 100, price: 10, priceSeq: 1 }], total }, T("2026-11-10", 16));
  const fill = (id: string) => ev("fills.executed", { agentId: id, sheetSeq: 0, tradingDate: "2026-11-10", fills: [{ symbol: "NEO1", side: "buy", requestedQty: 100, qty: 100, price: 100, amount: 10_000, status: "filled" }] }, T("2026-11-10", 9));
  const events = [
    reg("ai-a"), reg("ai-b", "investor"), reg("mm-1", "market_maker"), reg("noise-1", "noise"),
    fill("mm-1"), fill("ai-a"),
    val("mm-1", 9_000), // マーケットメイカーが一番多くても、順位に入らない
    val("noise-1", 5_000), val("ai-a", 1_200), val("ai-b", 1_100),
  ];
  const view = buildView(events, () => undefined);

  it("agents（順位・カード・AIのページ）は AI投資家だけ。種類のない登録も AI投資家", () => {
    expect(view.agents.map((a) => a.agentId)).toEqual(["ai-a", "ai-b"]);
    expect(view.agents.map((a) => a.days[0]!.rank)).toEqual([1, 2]); // 順位は AI投資家の中だけで決まる
  });

  it("トップのカード・フィードにはマーケットメイカー・ばらばらの参加者が出ない。売買の記録（タイムライン）には出る", () => {
    const arena = buildArena(view);
    expect(arena.cards.map((c) => c.agentId)).toEqual(["ai-a", "ai-b"]);
    expect(arena.feed.some((f) => f.text.includes("mm-1") || f.text.includes("noise-1"))).toBe(false);
    expect(arena.feed.find((f) => f.kind === "rank")!.text).toContain("が首位"); // 首位はAI投資家から
    expect(view.timeline.some((t) => t.kind === "fill" && t.agentId === "mm-1")).toBe(true);
    expect(view.timeline.some((t) => t.kind === "valuation" && t.agentId === "noise-1")).toBe(true);
  });

  it("AIのページは AI投資家だけ（マーケットメイカーは null）。銘柄の『持つAI』にも出ない", () => {
    expect(buildAgentPage(view, new Map(), "ai-a")).not.toBeNull();
    expect(buildAgentPage(view, new Map(), "mm-1")).toBeNull();
    expect(buildAgentPage(view, new Map(), "noise-1")).toBeNull();
    const v = buildView([...events, ev("company.listed", { symbol: "NEO1", name: "あ", sector: "電機", sharesOutstanding: 1, price: 10 }, 0)], () => undefined);
    expect(buildBoard(v, "NEO1")!.holders.map((h) => h.agentId)).toEqual(["ai-a", "ai-b"]);
  });
});
