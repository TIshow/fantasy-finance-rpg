// AIページ（/agents/[id]）に出す形。buildView の出力と台帳の口座（取得原価）を整形するだけ。
// 数字は記録から：総資産・損益・順位は評価の記録、取得単価・含み損益は台帳の口座（評価の株数と口座の株数が合うときだけ。合わなければ null）。
import type { Account, Deciyen } from "../ledger/types";
import { dir, latestPost, MARK, type Direction } from "./arena";
import { characterOf, handleOf, type Character } from "./characters";
import { formatBp, formatJstShort, formatMonthDay, formatSignedYenMark, formatYenMark, roundedRatio } from "./format";
import { REASON, STATUS } from "./labels";
import type { View } from "./types";

export const CHART_W = 600;
export const CHART_H = 200;

export interface ChartLine { agentId: string; color: string; points: string; bold: boolean }
export interface HoldingCard {
  symbol: string;
  qty: number;
  valueText: string;
  weightText: string;
  closeText: string;
  /** 台帳の口座と株数が合わないとき null */
  unitCostText: string | null;
  unrealized: { direction: Direction; text: string } | null;
}
export interface HistoryRow {
  key: string;
  /** 約定日（"11/18"）と、注文票の確定の時刻 */
  dateText: string;
  committedText: string;
  /** "買 TSTA 300株 @¥2,251" を、売買の向き・銘柄（リンク）・残りに分けたもの。注文のない行は head だけ */
  head: string;
  symbol: string | null;
  tail: string;
  status: string;
  reason: string | null;
  runSeq: number | null;
}
export interface AgentPage {
  agentId: string;
  character: Character;
  loggedName: string;
  handle: string;
  rank: number | null;
  badges: string[];
  latestPost: ReturnType<typeof latestPost>;
  stats: { totalText: string; asOf: string; changeText: string; changeDirection: Direction; pnlText: string; pnlDirection: Direction; fills: number } | null;
  chart: { lines: ChartLine[]; baseY: number; from: string; to: string; label: string } | null;
  holdings: HoldingCard[];
  cash: { text: string; weightText: string } | null;
  history: HistoryRow[];
}

const SIDE = { buy: "買", sell: "売" } as const;
const pct = (permille: number) => `${Math.floor(permille / 10)}.${permille % 10}%`;
const sign = (d: Deciyen) => `${MARK[dir(d)]} ${formatSignedYenMark(d)}`;

/** 連続して首位（順位1）だった日数の最長 */
const longestStreak = (ranks: number[]) => ranks.reduce<[number, number]>(([best, run], r) => (r === 1 ? [Math.max(best, run + 1), run + 1] : [best, 0]), [0, 0])[0];

export function buildAgentPage(view: View, accounts: ReadonlyMap<string, Account>, agentId: string): AgentPage | null {
  const a = view.agents.find((x) => x.agentId === agentId);
  if (!a) return null;
  const character = characterOf(agentId, a.agentName);
  const last = a.days.at(-1);
  const mine = view.timeline.filter((t) => t.agentId === agentId);
  const filled = mine.filter((t) => t.kind === "fill" && t.qty > 0).length;

  const streak = longestStreak(a.days.map((d) => d.rank));
  const badges = [...(streak >= 2 ? [`連続首位 ${streak}日`] : []), ...(a.days.length >= 2 && a.days.every((d) => d.change > 0) ? [`全日プラス ${a.days.length}日`] : [])];

  // 総資産の推移：全AIを重ね、このAIを太く最後に描く。x は初期資金の点（0）と、評価の日の並び
  const dates = [...new Set(view.agents.flatMap((x) => x.days.map((d) => d.date)))].sort();
  const all = view.agents.flatMap((x) => [x.initialCash, ...x.days.map((d) => d.total)]);
  const pad = Math.max(1, Math.floor(a.initialCash / 500));
  const lo = Math.min(...all) - pad;
  const hi = Math.max(...all) + pad;
  const xy = (i: number, v: number) => `${Math.round((i * CHART_W) / Math.max(1, dates.length))},${Math.round((1 - (v - lo) / (hi - lo)) * CHART_H * 10) / 10}`;
  const line = (x: (typeof view.agents)[number]): ChartLine => ({
    agentId: x.agentId,
    color: characterOf(x.agentId, x.agentName).color,
    bold: x.agentId === agentId,
    points: [`0,${xy(0, x.initialCash).split(",")[1]}`, ...x.days.map((d) => xy(dates.indexOf(d.date) + 1, d.total))].join(" "),
  });
  const chart = last
    ? { lines: [...view.agents.filter((x) => x.agentId !== agentId && x.days.length > 0).map(line), line(a)], baseY: Number(xy(0, a.initialCash).split(",")[1]), from: formatMonthDay(dates[0]!), to: formatMonthDay(dates.at(-1)!), label: `${a.days.length}営業日の総資産の推移（全${view.agents.length}体を重ねて表示）` }
    : null;

  // 持ち株：最後の評価の保有。取得原価は台帳の口座から
  const val = [...mine].reverse().find((t) => t.kind === "valuation");
  const account = accounts.get(agentId);
  const total = val && val.kind === "valuation" ? val.total : null;
  const holdings: HoldingCard[] =
    val && val.kind === "valuation" && total
      ? val.positions.filter((p) => p.qty > 0).map((p) => {
          const value = p.qty * p.price;
          const h = account?.holdings[p.symbol];
          const known = h !== undefined && h.qty === p.qty;
          return {
            symbol: p.symbol,
            qty: p.qty,
            valueText: formatYenMark(value),
            weightText: pct(roundedRatio(value, total, 1000)),
            closeText: formatYenMark(p.price),
            unitCostText: known ? formatYenMark(Math.round(h.cost / h.qty)) : null,
            unrealized: known ? { direction: dir(value - h.cost), text: sign(value - h.cost) } : null,
          };
        })
      : [];
  const cash = val && val.kind === "valuation" && total ? { text: formatYenMark(val.cash), weightText: pct(roundedRatio(val.cash, total, 1000)) } : null;

  // 取引履歴（新しい約定日から）。注文票の確定の時刻と根拠の agent.run は、約定の元の注文票から
  const sheets = new Map(view.timeline.flatMap((t) => (t.kind === "order_sheet" ? [[t.seq, t] as const] : [])));
  const history: HistoryRow[] = [];
  for (const t of mine) {
    if (t.kind === "fill") {
      const s = sheets.get(t.sheetSeq);
      const tail = ` ${t.qty}株${t.price === null ? "" : ` @${formatYenMark(t.price)}`}${t.qty !== t.requestedQty ? `（注文 ${t.requestedQty}株）` : ""}`;
      history.push({ key: `f${t.seq}-${t.fillIndex}`, dateText: formatMonthDay(t.tradingDate), committedText: s ? formatJstShort(s.at) : "－", head: SIDE[t.side], symbol: t.symbol, tail, status: STATUS[t.status], reason: t.reason ? (REASON[t.reason] ?? t.reason) : null, runSeq: s?.runSeq ?? null });
    } else if (t.kind === "order_sheet" && t.orders.length === 0) {
      history.push({ key: `s${t.seq}`, dateText: formatMonthDay(t.tradingDate), committedText: formatJstShort(t.at), head: "注文なし", symbol: null, tail: "", status: "売買なし", reason: null, runSeq: t.runSeq });
    } else if (t.kind === "rejected") {
      history.push({ key: `r${t.seq}`, dateText: formatMonthDay(t.tradingDate), committedText: formatJstShort(t.at), head: "注文票", symbol: null, tail: "", status: "拒否", reason: REASON[t.reason] ?? t.reason, runSeq: null });
    }
  }
  history.reverse();

  return {
    agentId, character, loggedName: a.agentName, handle: handleOf(agentId), rank: last?.rank ?? null, badges, latestPost: latestPost(view, agentId), chart, holdings, cash, history,
    stats: last ? { totalText: formatYenMark(last.total), asOf: formatMonthDay(last.date), changeText: sign(last.change), changeDirection: dir(last.change), pnlText: `${sign(last.total - a.initialCash)}（${formatBp(roundedRatio(last.total - a.initialCash, a.initialCash, 10000), true)}）`, pnlDirection: dir(last.total - a.initialCash), fills: filled } : null,
  };
}
