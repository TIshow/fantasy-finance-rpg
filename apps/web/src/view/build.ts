// イベントの列と外の値（投稿の本文）から、画面に出す形を作る純関数。
// 台帳の記録（約定・評価）をそのまま写す。残高・損益・順位を台帳の外の規則で計算し直さない（順位は記録された評価額の並べ替えだけ）。
import { intentOf, readText, stanceOf } from "./body";
import type { LogEvent } from "../events/types";
import { INITIAL_CASH, type Deciyen, type Fill, type ParticipantKind } from "../ledger/types";
import { buildMarket } from "./market";
import { formatJst, formatMonthDay, formatSignedYen, formatYen } from "./format";
import type { AgentDay, AgentPerformance, Evidence, SymbolThread, TimelineItem, View } from "./types";

type P = Record<string, any>; // 連鎖の検査を通ったイベントの中身

/**
 * events は連鎖の検査（verifyChain・replay）を通したログ。body は post.published の bodyHash から本文を引く関数で、
 * 本文の保管（ハッシュが合うもの）だけを引くこと。引けなければ null として扱う。
 */
export function buildView(events: readonly LogEvent[], body: (hash: string) => unknown): View {
  const names = new Map<string, string>();
  const initial = new Map<string, Deciyen>();
  const kinds = new Map<string, ParticipantKind>();
  const timeline: TimelineItem[] = [];
  const evidence: Evidence[] = [];
  const last = new Map<string, Deciyen>();
  const days = new Map<string, AgentDay[]>();
  const lessThan = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0); // ロケールに依らない並べ替え
  // 非表示：対象の seq ごとに、seq が最大の content.withdrawn が有効（§3.4）
  const withdrawn = new Map<number, { seq: number; reason: string }>();
  for (const e of events) if (e.type === "content.withdrawn") withdrawn.set((e.payload as P).targetSeq, { seq: e.seq, reason: String((e.payload as P).reason ?? "") });
  const closeDate = new Map<number, string>();
  // 評価に使う価格の記録の日：終値、板寄せ、上場（価格のつかなかった日の評価は、前の日の価格を使う）
  for (const e of events) {
    if (e.type === "prices.close" || e.type === "auction.cleared") closeDate.set(e.seq, (e.payload as P).date);
    else if (e.type === "company.listed") closeDate.set(e.seq, formatJst(e.recordedAt).slice(0, 10));
  }
  const nameOf = (id: string) => names.get(id) ?? id;

  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    const p = e.payload as P;
    const base = (agentId: string) => ({ seq: e.seq, at: e.recordedAt, agentId, agentName: agentId === "*" ? "全体" : nameOf(agentId) });
    switch (e.type) {
      case "agent.registered":
        names.set(p.agentId, p.displayName);
        initial.set(p.agentId, p.initialCash ?? INITIAL_CASH);
        kinds.set(p.agentId, p.kind ?? "investor");
        break;
      case "post.published":
        {
          const w = withdrawn.get(e.seq) ?? null;
          timeline.push({ ...base(p.agentId), kind: "post", symbol: p.board, text: w ? null : readText(body(p.bodyHash)), intent: w ? null : intentOf(p.intent), stance: w ? null : stanceOf(p.stance), withdrawn: w, citeSeqs: p.citeSeqs ?? [], replyTo: p.replyTo ?? null, runSeq: p.runSeq });
        }
        break;
      case "order_sheet.committed":
        timeline.push({ ...base(p.agentId), kind: "order_sheet", tradingDate: p.tradingDate, runSeq: p.runSeq, orders: p.orders.map((o: P) => ({ symbol: o.symbol, side: o.side, qty: o.qty })) });
        break;
      case "order_sheet.rejected":
        timeline.push({ ...base(p.agentId), kind: "rejected", tradingDate: p.tradingDate, reason: p.reason, runSeq: typeof p.runSeq === "number" ? p.runSeq : null });
        break;
      case "fills.executed":
        for (const [fillIndex, f] of (p.fills as Fill[]).entries()) {
          const { symbol, side, requestedQty, qty, price, status, reason } = f;
          timeline.push({ ...base(p.agentId), kind: "fill", fillIndex, sheetSeq: p.sheetSeq, tradingDate: p.tradingDate, symbol, side, requestedQty, qty, price, priceText: price === null ? null : formatYen(price), status, ...(reason ? { reason } : {}) });
        }
        break;
      case "valuation.recorded": {
        const total: Deciyen = p.total;
        const change = total - (last.get(p.agentId) ?? initial.get(p.agentId) ?? INITIAL_CASH);
        last.set(p.agentId, total);
        const positions = (p.positions as P[]).map((x) => ({ symbol: x.symbol, qty: x.qty, price: x.price, priceText: formatYen(x.price), closeSeq: x.priceSeq ?? x.closeSeq, stale: (closeDate.get(x.priceSeq ?? x.closeSeq) ?? p.date) < p.date }));
        timeline.push({ ...base(p.agentId), kind: "valuation", date: p.date, cash: p.cash, positions, total, totalText: formatYen(total), change, changeText: formatSignedYen(change) });
        // rank は全AIの出そろった後に入れる
        (days.get(p.agentId) ?? days.set(p.agentId, []).get(p.agentId)!).push({ date: p.date, total, totalText: formatYen(total), change, changeText: formatSignedYen(change), stale: positions.some((x) => x.stale), rank: 0 });
        break;
      }
      case "source.captured":
        evidence.push({ seq: e.seq, kind: "source", label: typeof p.source === "string" ? p.source : "出典の記載なし", publishedAt: typeof p.publishedAt === "number" ? p.publishedAt : null, fetchedAt: typeof p.fetchedAt === "number" ? p.fetchedAt : null });
        break;
      case "prices.close":
        evidence.push({ seq: e.seq, kind: "close", label: `終値 ${formatMonthDay(String(p.date))}${typeof p.source === "string" ? `（${p.source}）` : ""}`, publishedAt: null, fetchedAt: typeof p.fetchedAt === "number" ? p.fetchedAt : null });
        break;
      case "agent.suspended":
      case "agent.resumed":
        timeline.push({ ...base(p.agentId), kind: "suspension", action: e.type === "agent.suspended" ? "suspended" : "resumed", scope: p.scope, reason: p.reason });
        break;
    }
  }

  // 投稿が引用した記録のうち、出典・終値でないもの（他の投稿・評価など）も落とさず、種類つきで残す
  const bySeq = new Map(events.map((e) => [e.seq, e]));
  const known = new Set(evidence.map((x) => x.seq));
  for (const it of timeline) {
    if (it.kind !== "post") continue;
    for (const s of it.citeSeqs) {
      if (known.has(s)) continue;
      known.add(s);
      const src = bySeq.get(s);
      evidence.push(src ? { seq: s, kind: src.type === "post.published" ? "post" : "other", label: `記録（${src.type}）`, publishedAt: null, fetchedAt: null } : { seq: s, kind: "other", label: "記録が見つかりません", publishedAt: null, fetchedAt: null });
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
  // 登録されたAIは、まだ評価がなくても載せる（最初の日の前でも参戦中として見える）
  const agents: AgentPerformance[] = [...new Set([...initial.keys(), ...days.keys()])].map((agentId) => ({
    agentId,
    agentName: nameOf(agentId),
    initialCash: initial.get(agentId) ?? INITIAL_CASH,
    days: (days.get(agentId) ?? []).sort((a, b) => lessThan(a.date, b.date)),
  }));
  return { timeline, evidence, market: buildMarket(events), participants: [...kinds].map(([agentId, kind]) => ({ agentId, kind })).sort((a, b) => lessThan(a.agentId, b.agentId)), threads: [...threadMap.values()].sort((a, b) => lessThan(a.symbol, b.symbol)), agents: agents.sort((a, b) => lessThan(a.agentId, b.agentId)) };
}
