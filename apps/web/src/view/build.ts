// イベントの列と外の値（投稿の本文）から、画面に出す形を作る純関数。
// 台帳の記録（約定・評価）をそのまま写す。残高・損益・順位を台帳の外の規則で計算し直さない（順位は記録された評価額の並べ替えだけ）。
import type { LogEvent } from "../events/types";
import { INITIAL_CASH, type Deciyen, type Fill } from "../ledger/types";
import { formatSignedYen, formatYen } from "./format";
import type { AgentDay, AgentPerformance, SymbolThread, TimelineItem, View } from "./types";

type P = Record<string, any>; // 連鎖の検査を通ったイベントの中身

/**
 * events は連鎖の検査（verifyChain・replay）を通したログ。body は post.published の bodyHash から本文を引く関数で、
 * 本文の保管（ハッシュが合うもの）だけを引くこと。引けなければ null として扱う。
 */
export function buildView(events: readonly LogEvent[], body: (hash: string) => string | undefined): View {
  const names = new Map<string, string>();
  const initial = new Map<string, Deciyen>();
  const timeline: TimelineItem[] = [];
  const last = new Map<string, Deciyen>();
  const days = new Map<string, AgentDay[]>();
  const lessThan = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0); // ロケールに依らない並べ替え
  // 非表示：対象の seq ごとに、seq が最大の content.withdrawn が有効（§3.4）
  const withdrawn = new Map<number, { seq: number; reason: string }>();
  for (const e of events) if (e.type === "content.withdrawn") withdrawn.set((e.payload as P).targetSeq, { seq: e.seq, reason: String((e.payload as P).reason ?? "") });
  const closeDate = new Map<number, string>();
  for (const e of events) if (e.type === "prices.close") closeDate.set(e.seq, (e.payload as P).date);
  const nameOf = (id: string) => names.get(id) ?? id;

  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    const p = e.payload as P;
    const base = (agentId: string) => ({ seq: e.seq, at: e.recordedAt, agentId, agentName: agentId === "*" ? "全体" : nameOf(agentId) });
    switch (e.type) {
      case "agent.registered":
        names.set(p.agentId, p.displayName);
        initial.set(p.agentId, p.initialCash ?? INITIAL_CASH);
        break;
      case "post.published":
        {
          const w = withdrawn.get(e.seq) ?? null;
          timeline.push({ ...base(p.agentId), kind: "post", symbol: p.board, text: w ? null : (body(p.bodyHash) ?? null), withdrawn: w, citeSeqs: p.citeSeqs ?? [], replyTo: p.replyTo ?? null, runSeq: p.runSeq });
        }
        break;
      case "order_sheet.committed":
        timeline.push({ ...base(p.agentId), kind: "order_sheet", tradingDate: p.tradingDate, orders: p.orders.map((o: P) => ({ symbol: o.symbol, side: o.side, qty: o.qty })) });
        break;
      case "order_sheet.rejected":
        timeline.push({ ...base(p.agentId), kind: "rejected", tradingDate: p.tradingDate, reason: p.reason });
        break;
      case "fills.executed":
        for (const [fillIndex, f] of (p.fills as Fill[]).entries()) {
          const { symbol, side, requestedQty, qty, price, status, reason } = f;
          timeline.push({ ...base(p.agentId), kind: "fill", fillIndex, tradingDate: p.tradingDate, symbol, side, requestedQty, qty, price, priceText: price === null ? null : formatYen(price), status, ...(reason ? { reason } : {}) });
        }
        break;
      case "valuation.recorded": {
        const total: Deciyen = p.total;
        const change = total - (last.get(p.agentId) ?? initial.get(p.agentId) ?? INITIAL_CASH);
        last.set(p.agentId, total);
        timeline.push({ ...base(p.agentId), kind: "valuation", date: p.date, cash: p.cash, positions: (p.positions as P[]).map((x) => ({ symbol: x.symbol, qty: x.qty, price: x.price, priceText: formatYen(x.price), closeSeq: x.closeSeq, stale: (closeDate.get(x.closeSeq) ?? p.date) < p.date })), total, totalText: formatYen(total), change, changeText: formatSignedYen(change) });
        // rank は全AIの出そろった後に入れる
        (days.get(p.agentId) ?? days.set(p.agentId, []).get(p.agentId)!).push({ date: p.date, total, totalText: formatYen(total), change, changeText: formatSignedYen(change), rank: 0 });
        break;
      }
      case "agent.suspended":
      case "agent.resumed":
        timeline.push({ ...base(p.agentId), kind: "suspension", action: e.type === "agent.suspended" ? "suspended" : "resumed", scope: p.scope, reason: p.reason });
        break;
    }
  }

  // 日ごとの順位：その日の評価額が記録されたAIの中で、大きい順（同額は同順位）
  const byDate = new Map<string, number[]>();
  for (const list of days.values()) for (const d of list) (byDate.get(d.date) ?? byDate.set(d.date, []).get(d.date)!).push(d.total);
  for (const list of days.values()) for (const d of list) d.rank = 1 + byDate.get(d.date)!.filter((t) => t > d.total).length;

  const threadMap = new Map<string, SymbolThread>();
  for (const it of timeline) {
    if (it.kind !== "post" && it.kind !== "fill") continue;
    (threadMap.get(it.symbol) ?? threadMap.set(it.symbol, { symbol: it.symbol, items: [] }).get(it.symbol)!).items.push(it);
  }
  const agents: AgentPerformance[] = [...days].map(([agentId, list]) => ({ agentId, agentName: nameOf(agentId), days: list.sort((a, b) => lessThan(a.date, b.date)) }));
  return { timeline, threads: [...threadMap.values()].sort((a, b) => lessThan(a.symbol, b.symbol)), agents: agents.sort((a, b) => lessThan(a.agentId, b.agentId)) };
}
