// AIページ（/agents/[id]）に出す形。buildView の出力と台帳の口座（取得原価）を整形するだけ。
// 数字は記録から：総資産・損益・順位は評価の記録、取得単価・含み損益は台帳の口座（評価の株数と口座の株数が合うときだけ。合わなければ null）。
import type { Account, Deciyen } from "../ledger/types";
import { dir, latestPost, MARK, settledDates, type Direction } from "./arena";
import { characterOf, handleOf, type Character } from "./characters";
import { formatBp, formatJst, formatJstShort, formatMonthDay, formatSignedYenMark, formatYenMark, roundedRatio } from "./format";
import { INTENT_LABEL, REASON, STANCE_LABEL, STATUS } from "./labels";
import { labelModel, modelsOf, runModelOf, type ModelLabel } from "./models";
import type { RunModel, View } from "./types";

export const CHART_W = 600;
export const CHART_H = 200;

export interface ChartLine { agentId: string; name: string; color: string; points: string; bold: boolean }
export interface HoldingCard {
  symbol: string;
  qty: number;
  valueText: string;
  weightText: string;
  closeText: string;
  /** 評価日より前の終値で評価した（PAPER_TRADING_RULES §6） */
  stale: boolean;
  /** 台帳の口座と株数が合わないとき null */
  unitCostText: string | null;
  unrealized: { direction: Direction; text: string } | null;
}
export interface HistoryRow {
  key: string;
  /** 約定日（"11/18"）と、注文票の確定の時刻 */
  dateText: string;
  /** 時刻の意味：注文票の確定、拒否の受付 */
  timeLabel: string;
  committedText: string;
  /** "買 TSTA 300株 @¥2,251" を、売買の向き・銘柄（リンク）・残りに分けたもの。注文のない行は head だけ */
  head: string;
  symbol: string | null;
  tail: string;
  status: string;
  reason: string | null;
  runSeq: number | null;
}
/** その日の判断の1行。投稿、確定した注文票、拒否された注文票のどれか。LLM の出力の形が決まったら、ここに項目を足す */
export interface DecisionItem {
  key: string;
  timeText: string;
  kind: "post" | "orders" | "rejected" | "failed";
  label: string;
  /** 投稿の本文、注文の要約（"買 TSTA 300株"）、拒否の理由 */
  text: string;
  /** 本文が出せない（非表示・保管にない）ときの説明。出せるときは null */
  note: string | null;
  /** 投稿の掲示板（銘柄または「全体」）。投稿でなければ null */
  symbol: string | null;
  /** 投稿の種類と見立て（"戦略"・"▲ 強気"） */
  tags: string[];
  runSeq: number | null;
  /** この判断をしたときのモデル（判断の記録の runSeq から）。記録がなければ null */
  model: ModelLabel | null;
  /** 試運転（注文を出さない実行）の判断か。判断の記録の dryRun が true のときだけ true */
  dryRun: boolean;
}
export interface DecisionDay {
  /** "2026-11-18"（日本時間。見出しの key） */
  date: string;
  /** "11/18"。表示する日が年をまたぐときは "2025/12/30" */
  dateText: string;
  items: DecisionItem[];
}
export interface AgentPage {
  agentId: string;
  character: Character;
  /** 判断の記録のモデル。記録がなければ null */
  model: ModelLabel | null;
  loggedName: string;
  handle: string;
  rank: number | null;
  /** 順位の基準の日（評価がそろった最後の日。"11/09"） */
  rankAsOf: string | null;
  /** 停止中の表示（"停止中（投稿と注文）"）。停止されていなければ null */
  suspended: string | null;
  badges: string[];
  latestPost: ReturnType<typeof latestPost>;
  stats: { totalText: string; asOf: string; changeText: string; changeDirection: Direction; pnlText: string; pnlDirection: Direction; fills: number } | null;
  chart: { lines: ChartLine[]; baseY: number; to: string; label: string } | null;
  holdings: HoldingCard[];
  cash: { text: string; weightText: string } | null;
  history: HistoryRow[];
  /** 新しい日から、最大 DECISION_DAYS 日分 */
  decisions: DecisionDay[];
}

export const DECISION_DAYS = 10;

const SIDE = { buy: "買", sell: "売" } as const;
const pct = (permille: number) => `${Math.floor(permille / 10)}.${permille % 10}%`;
const sign = (d: Deciyen) => `${MARK[dir(d)]} ${formatSignedYenMark(d)}`;

/** 連続して首位（順位1）だった日数の最長 */
const longestStreak = (ranks: number[]) => ranks.reduce<[number, number]>(([best, run], r) => (r === 1 ? [Math.max(best, run + 1), run + 1] : [best, 0]), [0, 0])[0];

/**
 * 停止中の表示。実行側（src/runner/day.ts の suspended）と同じ決め方：IDごと（AIと "*"）に、停止した範囲の集合を
 * 記録の順に足し引きし（both は両方）、どちらかが止めていればその範囲を停止とする。範囲は投稿・注文の順に並べる
 */
export function suspensionOf(view: View, agentId: string): string | null {
  const on = new Map<string, Set<string>>();
  for (const t of view.timeline) {
    if (t.kind !== "suspension" || (t.agentId !== agentId && t.agentId !== "*")) continue;
    const set = on.get(t.agentId) ?? new Set<string>();
    for (const x of t.scope === "both" ? ["posts", "orders"] : [t.scope]) (t.action === "suspended" ? set.add(x) : set.delete(x));
    on.set(t.agentId, set);
  }
  const names = (["posts", "orders"] as const).filter((x) => [agentId, "*"].some((id) => on.get(id)?.has(x))).map((x) => (x === "posts" ? "投稿" : "注文"));
  return names.length === 0 ? null : `停止中（${names.join("と")}）`;
}

/** 取引履歴の行の id（掲示板からのリンク先） */
export const fillKey = (seq: number, fillIndex: number) => `f${seq}-${fillIndex}`;

/**
 * その日の判断：投稿と注文票を、記録された日（日本時間）ごとにまとめる。
 * 記録にある項目（投稿の本文・種類・見立て、注文票の中身、拒否の理由）だけを出す。LLM が書く「判断の理由」は、出力の形が決まってから足す
 */
/** 判断に失敗した理由（エラーコード）の、見る人向けの説明。知らないコードは記録のまま添える */
export const RUN_FAILURE: Record<string, string> = {
  budget_exceeded: "この日はLLMの費用の上限を超えるため、依頼を送らず、判断をしませんでした",
  timeout: "LLMの返事が時間内に届かず、判断が出ませんでした",
  rate_limited: "LLMの提供元の利用制限にあたり、判断が出ませんでした",
  provider_error: "LLMの提供元でエラーが起き、判断が出ませんでした",
  invalid_output: "LLMの出力が記録の形に合わず、判断として使いませんでした",
};
export const failureText = (code: string | null) => (code !== null && Object.hasOwn(RUN_FAILURE, code) ? RUN_FAILURE[code]! : `判断が出ませんでした（エラーコード：${code ?? "記載なし"}）`);

/**
 * runs には、このAIの判断の記録（成功・失敗とも）を渡す。失敗した判断は「判断に失敗」の行として出し、
 * dryRun が true の判断（投稿・注文票も）には試運転の印を付ける
 */
export function decisionsOf(mine: View["timeline"], modelOf: (runSeq: number | null) => ModelLabel | null = () => null, runs: readonly RunModel[] = []): DecisionDay[] {
  const dry = (runSeq: number | null) => runSeq !== null && runs.some((r) => r.seq === runSeq && r.dryRun);
  const byDay = new Map<string, (DecisionItem & { at: number; seq: number })[]>();
  const add = (at: number, item: DecisionItem & { at: number; seq: number }) => (byDay.get(formatJst(at).slice(0, 10)) ?? byDay.set(formatJst(at).slice(0, 10), []).get(formatJst(at).slice(0, 10))!).push(item);
  for (const t of mine) {
    const time = formatJstShort(t.at).slice(-5);
    if (t.kind === "post") {
      const tags = [...(t.intent ? [INTENT_LABEL[t.intent]] : []), ...(t.stance ? [`${STANCE_LABEL[t.stance].mark} ${STANCE_LABEL[t.stance].text}`] : [])];
      const note = t.withdrawn ? `非表示（${t.withdrawn.reason || "理由の記載なし"}）` : t.text === null ? "本文が保管にありません" : null;
      add(t.at, { at: t.at, seq: t.seq, key: `p${t.seq}`, timeText: time, kind: "post", label: "投稿", text: t.text ?? "", note, symbol: t.symbol, tags, runSeq: t.runSeq, model: modelOf(t.runSeq), dryRun: dry(t.runSeq) });
    } else if (t.kind === "order_sheet") {
      const text = t.orders.length === 0 ? "注文なし" : t.orders.map((o) => `${SIDE[o.side]} ${o.symbol} ${o.qty}株`).join("、");
      add(t.at, { at: t.at, seq: t.seq, key: `s${t.seq}`, timeText: time, kind: "orders", label: `注文票（約定日 ${formatMonthDay(t.tradingDate)}）`, text, note: null, symbol: null, tags: [], runSeq: t.runSeq, model: modelOf(t.runSeq), dryRun: dry(t.runSeq) });
    } else if (t.kind === "rejected") {
      add(t.at, { at: t.at, seq: t.seq, key: `r${t.seq}`, timeText: time, kind: "rejected", label: "注文票を拒否", text: REASON[t.reason] ?? t.reason, note: null, symbol: null, tags: [], runSeq: t.runSeq, model: modelOf(t.runSeq), dryRun: dry(t.runSeq) });
    }
  }
  for (const r of runs) {
    if (r.ok) continue;
    add(r.at, { at: r.at, seq: r.seq, key: `x${r.seq}`, timeText: formatJstShort(r.at).slice(-5), kind: "failed", label: "判断に失敗", text: failureText(r.errorCode), note: null, symbol: null, tags: [], runSeq: r.seq, model: labelModel(r.provider, r.modelId), dryRun: r.dryRun });
  }
  const days = [...byDay].sort((x, y) => (x[0] < y[0] ? 1 : -1)).slice(0, DECISION_DAYS);
  const crossesYear = new Set(days.map(([day]) => day.slice(0, 4))).size > 1;
  return days.map(([day, items]) => ({ date: day, dateText: crossesYear ? `${day.slice(0, 4)}/${formatMonthDay(day)}` : formatMonthDay(day), items: items.sort((p, q) => p.at - q.at || p.seq - q.seq).map(({ at: _a, seq: _s, ...rest }) => rest) }));
}

export function buildAgentPage(view: View, accounts: ReadonlyMap<string, Account>, agentId: string): AgentPage | null {
  const a = view.agents.find((x) => x.agentId === agentId);
  if (!a) return null;
  const provider = (id: string) => view.models.find((m) => m.agentId === id)?.provider;
  const character = characterOf(agentId, a.agentName, provider(agentId));
  const last = a.days.at(-1);
  const mine = view.timeline.filter((t) => t.agentId === agentId);
  const filled = mine.filter((t) => t.kind === "fill" && t.qty > 0).length;

  const settled = settledDates(view);
  const settledDays = a.days.filter((d) => settled.has(d.date));
  const streak = longestStreak(settledDays.map((d) => d.rank));
  const badges = [...(streak >= 2 ? [`連続首位 ${streak}日`] : []), ...(a.days.length >= 2 && a.days.every((d) => d.change > 0) ? [`全日プラス ${a.days.length}日`] : [])];

  // 総資産の推移：全AIを重ね、このAIを太く最後に描く。x は初期資金の点（0）と、評価の日の並び
  const dates = [...new Set(view.agents.flatMap((x) => x.days.map((d) => d.date)))].sort();
  const all = view.agents.flatMap((x) => [x.initialCash, ...x.days.map((d) => d.total)]);
  const pad = Math.max(1, Math.floor(a.initialCash / 500));
  const lo = Math.min(...all) - pad;
  const hi = Math.max(...all) + pad;
  const x = (i: number) => Math.round((i * CHART_W) / Math.max(1, dates.length));
  const y = (v: number) => Math.round((1 - (v - lo) / (hi - lo)) * CHART_H * 10) / 10;
  // 初期資金の点は、そのAIの最初の評価の日の1つ前の位置に置く（開始が遅いAIに、実在しない線を引かない）
  const line = (o: (typeof view.agents)[number]): ChartLine => ({
    agentId: o.agentId,
    name: characterOf(o.agentId, o.agentName, provider(o.agentId)).name,
    color: characterOf(o.agentId, o.agentName, provider(o.agentId)).color,
    bold: o.agentId === agentId,
    points: [`${x(dates.indexOf(o.days[0]!.date))},${y(o.initialCash)}`, ...o.days.map((d) => `${x(dates.indexOf(d.date) + 1)},${y(d.total)}`)].join(" "),
  });
  const drawn = view.agents.filter((o) => o.agentId !== agentId && o.days.length > 0).map(line);
  const chart = last ? { lines: [...drawn, line(a)], baseY: y(a.initialCash), to: formatMonthDay(dates.at(-1)!), label: `${a.days.length}営業日の総資産の推移（${drawn.length + 1}体を重ねて表示）` } : null;

  // 持ち株：最後の評価の保有。取得原価は台帳の口座から
  const val = [...mine].reverse().find((t) => t.kind === "valuation");
  const account = accounts.get(agentId);
  const total = val && val.kind === "valuation" ? val.total : null;
  // 口座は「ログの最後」の状態。最後の評価より後にこのAIの約定があると、取得原価がずれるので出さない
  const tradedAfter = val !== undefined && mine.some((t) => t.kind === "fill" && t.qty > 0 && t.seq > val.seq);
  const holdings: HoldingCard[] =
    val && val.kind === "valuation" && total
      ? val.positions.filter((p) => p.qty > 0).map((p) => {
          const value = p.qty * p.price;
          const h = account?.holdings[p.symbol];
          const known = !tradedAfter && h !== undefined && h.qty === p.qty;
          return {
            symbol: p.symbol,
            qty: p.qty,
            valueText: formatYenMark(value),
            weightText: pct(roundedRatio(value, total, 1000)),
            closeText: formatYenMark(p.price),
            stale: p.stale,
            unitCostText: known ? formatYenMark(roundedRatio(h.cost, h.qty, 1)) : null,
            unrealized: known ? { direction: dir(value - h.cost), text: sign(value - h.cost) } : null,
          };
        })
      : [];
  const cash = val && val.kind === "valuation" && total ? { text: formatYenMark(val.cash), weightText: pct(roundedRatio(val.cash, total, 1000)) } : null;

  // 取引履歴（新しい約定日から）。注文票の確定の時刻と根拠の agent.run は、約定の元の注文票から
  const sheets = new Map(view.timeline.flatMap((t) => (t.kind === "order_sheet" ? [[t.seq, t] as const] : [])));
  const rows: { seq: number; idx: number; date: string; row: HistoryRow }[] = [];
  const valid = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d);
  const md = (d: string) => (valid(d) ? formatMonthDay(d) : "－");
  for (const t of mine) {
    if (t.kind === "fill") {
      const s = sheets.get(t.sheetSeq);
      const tail = ` ${t.qty}株${t.price === null ? "" : ` @${formatYenMark(t.price)}`}${t.qty !== t.requestedQty ? `（注文 ${t.requestedQty}株）` : ""}`;
      rows.push({ seq: t.seq, idx: t.fillIndex, date: t.tradingDate, row: { key: fillKey(t.seq, t.fillIndex), dateText: md(t.tradingDate), timeLabel: "確定", committedText: s ? formatJstShort(s.at) : "－", head: SIDE[t.side], symbol: t.symbol, tail, status: STATUS[t.status], reason: t.reason ? (REASON[t.reason] ?? t.reason) : null, runSeq: s?.runSeq ?? null } });
    } else if (t.kind === "order_sheet" && t.orders.length === 0) {
      rows.push({ seq: t.seq, idx: 0, date: t.tradingDate, row: { key: `s${t.seq}`, dateText: md(t.tradingDate), timeLabel: "確定", committedText: formatJstShort(t.at), head: "注文なし", symbol: null, tail: "", status: "売買なし", reason: null, runSeq: t.runSeq } });
    } else if (t.kind === "rejected") {
      rows.push({ seq: t.seq, idx: 0, date: t.tradingDate, row: { key: `r${t.seq}`, dateText: md(t.tradingDate), timeLabel: "受付", committedText: formatJstShort(t.at), head: "注文票", symbol: null, tail: "", status: "拒否", reason: REASON[t.reason] ?? t.reason, runSeq: t.runSeq } });
    }
  }
  // 約定日の新しい順。同じ日の中は、記録の順（売りが先、買いが後）
  const key = (d: string) => (valid(d) ? d : ""); // 日付が不正な拒否は一番後ろ
  const history = rows.sort((p, q) => (key(p.date) < key(q.date) ? 1 : key(p.date) > key(q.date) ? -1 : p.seq - q.seq || p.idx - q.idx)).map((r) => r.row);

  const suspended = suspensionOf(view, agentId);
  const decisions = decisionsOf(mine, (n) => runModelOf(view, n, agentId), view.runs.filter((r) => r.agentId === agentId));

  return {
    agentId, character, model: modelsOf(view).get(agentId) ?? null, loggedName: a.agentName, handle: handleOf(agentId), rank: settledDays.at(-1)?.rank ?? null, rankAsOf: settledDays.at(-1) ? formatMonthDay(settledDays.at(-1)!.date) : null, suspended, badges, latestPost: latestPost(view, agentId), chart, holdings, cash, history, decisions,
    stats: last ? { totalText: formatYenMark(last.total), asOf: formatMonthDay(last.date), changeText: sign(last.change), changeDirection: dir(last.change), pnlText: `${sign(last.total - a.initialCash)}（${formatBp(roundedRatio(last.total - a.initialCash, a.initialCash, 10000), true)}）`, pnlDirection: dir(last.total - a.initialCash), fills: filled } : null,
  };
}
