// トップ（アリーナ）に出す形。buildView の出力（記録を写したもの）を並べ替えて整形するだけ。
// 残高・損益・順位を台帳の外の規則で計算し直さない：総資産・順位は評価の記録、累計損益は「総資産 − 初期資金」、
// 構成比は「評価した保有の評価額 ÷ 総資産」の表示用の割り算（整数の四捨五入）。
import { characterOf, handleOf, type Character } from "./characters";
import { formatBp, formatJstShort, formatMonthDay, formatSignedYenMark, formatYenMark, roundedRatio } from "./format";
import { modelsOf, type ModelLabel } from "./models";
import type { TimelineItem, View } from "./types";

export type Direction = "up" | "down" | "flat";
export const MARK: Record<Direction, string> = { up: "▲", down: "▼", flat: "－" };
export const dir = (n: number): Direction => (n > 0 ? "up" : n < 0 ? "down" : "flat");

export interface Sparkline {
  /** SVG の polyline の points（横幅 W・縦 H の座標系） */
  points: string;
  /** 初期資金の位置（破線） */
  baseY: number;
  label: string;
}
export const SPARK_W = 140;
export const SPARK_H = 48;

/** values は初期資金から始まる資産の列、baseline は初期資金。座標は表示のための小数（1桁） */
export function sparkline(values: number[], baseline: number): Sparkline {
  const pad = Math.max(1, Math.floor(baseline / 500));
  const lo = Math.min(baseline, ...values) - pad;
  const hi = Math.max(baseline, ...values) + pad;
  const y = (n: number) => Math.round((1 - (n - lo) / (hi - lo)) * SPARK_H * 10) / 10;
  const n = values.length;
  const pts = n < 2 ? [...values, ...values] : values; // 1点だけのときは横線にする
  const points = pts.map((v, i) => `${Math.round((i * SPARK_W) / Math.max(1, pts.length - 1))},${y(v)}`).join(" ");
  const last = values.at(-1) ?? baseline;
  const words = { up: "初期資金より上", down: "初期資金より下", flat: "初期資金と同じ" };
  return { points, baseY: y(baseline), label: `${Math.max(0, n - 1)}営業日の資産の推移（${words[dir(last - baseline)]}）` };
}

/** 直近の（非表示でなく本文が保管にある）投稿 */
export function latestPost(view: View, agentId: string) {
  const p = findLast(view.timeline, (t) => t.kind === "post" && t.agentId === agentId && t.withdrawn === null && t.text !== null);
  return p && p.kind === "post" ? { text: p.text as string, symbol: p.symbol, atText: formatJstShort(p.at) } : null;
}

/**
 * 評価がそろった日の集合。評価を始めたAIのうち、まだその日の評価がないAIがいる日（書きかけの日）は含めない。
 * 順位・首位・連続首位は、この日のものだけを使う（書きかけの日は、先に評価されたAIが仮に1位になるため）
 */
export function settledDates(view: View): Set<string> {
  const all = new Set(view.agents.flatMap((a) => a.days.map((d) => d.date)));
  return new Set([...all].filter((date) => !view.agents.some((a) => a.days.length > 0 && a.days[0]!.date <= date && !a.days.some((d) => d.date === date))));
}

export interface ArenaCard {
  agentId: string;
  character: Character;
  /** 記録の displayName（ほかの画面と照らし合わせるため、カードにも出す） */
  loggedName: string;
  handle: string;
  /** 判断の記録のモデル（提供元と版）。判断の記録がなければ null */
  model: ModelLabel | null;
  /** 評価がまだないAIは null */
  rank: number | null;
  /** 総資産と損益は最後の評価の記録から。評価がまだなければ null（初期資金などで埋めない） */
  totalText: string | null;
  /** 総資産の基準の日（最後の評価の日 "11/13"） */
  asOf: string | null;
  pnl: { direction: Direction; text: string; percentText: string } | null;
  spark: Sparkline | null;
  /** 評価額の大きい順の上位2つ（構成比 = 評価額 ÷ 総資産） */
  top: { symbol: string; weightText: string; weightPct: number }[];
  /** 直近の（非表示でない）投稿の本文。ない・本文が保管にない場合は null */
  quote: string | null;
  /** ひとことの投稿の日時（"11/12 21:00"） */
  quoteAt: string | null;
  /** 直近の約定（"11/18 買 TSTA 300株"）。ない場合は null */
  lastTrade: string | null;
}

export type FeedKind = "rank" | "fill" | "post";
export interface FeedItem {
  key: string;
  timeText: string;
  kind: FeedKind;
  label: string;
  color: string;
  text: string;
  /** 投稿の銘柄（掲示板へのリンク用） */
  symbol?: string;
}

export interface Arena {
  cards: ArenaCard[];
  feed: FeedItem[];
}

const SIDE = { buy: "買", sell: "売" } as const;
const findLast = <T>(list: readonly T[], pred: (x: T) => boolean): T | undefined => {
  for (let i = list.length - 1; i >= 0; i--) if (pred(list[i]!)) return list[i];
  return undefined;
};
const FEED_LIMIT = 12;

export function buildArena(view: View): Arena {
  const models = modelsOf(view);
  const charOf = (id: string, loggedName: string) => characterOf(id, loggedName, view.models.find((m) => m.agentId === id)?.provider);
  const who = (id: string, loggedName: string) => charOf(id, loggedName).name;
  // トップに出すのはAI投資家（view.agents）の動きだけ。マーケットメイカー・ばらばらの参加者の売買は、タイムラインにある
  const investors = new Set(view.agents.map((a) => a.agentId));
  const mine = view.timeline.filter((t) => investors.has(t.agentId));
  const posts = mine.filter((t): t is TimelineItem & { kind: "post" } => t.kind === "post");
  const fills = mine.filter((t): t is TimelineItem & { kind: "fill" } => t.kind === "fill" && t.qty > 0);
  const valuations = mine.filter((t): t is TimelineItem & { kind: "valuation" } => t.kind === "valuation");

  const settledDays = settledDates(view);
  const cards: ArenaCard[] = view.agents.map((a) => {
    const character = charOf(a.agentId, a.agentName);
    const lastDay = a.days.at(-1);
    const total = lastDay?.total;
    const diff = total === undefined ? 0 : total - a.initialCash;
    const lastVal = findLast(valuations, (v) => v.agentId === a.agentId);
    const top = (lastVal?.positions ?? [])
      .filter((p) => p.qty > 0)
      .map((p) => ({ symbol: p.symbol, value: p.qty * p.price }))
      .sort((x, y) => y.value - x.value || (x.symbol < y.symbol ? -1 : 1))
      .slice(0, 2)
      .map((p) => {
        const permille = roundedRatio(p.value, total ?? a.initialCash, 1000);
        return { symbol: p.symbol, weightText: `${Math.floor(permille / 10)}.${permille % 10}%`, weightPct: permille / 10 };
      });
    const post = latestPost(view, a.agentId);
    const f = findLast(fills, (x) => x.agentId === a.agentId);
    return {
      agentId: a.agentId,
      character,
      loggedName: a.agentName,
      handle: handleOf(a.agentId),
      model: models.get(a.agentId) ?? null,
      rank: findLast(a.days, (d) => settledDays.has(d.date))?.rank ?? null,
      totalText: total === undefined ? null : formatYenMark(total),
      asOf: lastDay ? formatMonthDay(lastDay.date) : null,
      pnl: total === undefined ? null : { direction: dir(diff), text: formatSignedYenMark(diff), percentText: formatBp(roundedRatio(diff, a.initialCash, 10000), true) },
      spark: a.days.length === 0 ? null : sparkline([a.initialCash, ...a.days.map((d) => d.total)], a.initialCash),
      top,
      quote: post?.text ?? null,
      quoteAt: post?.atText ?? null,
      lastTrade: f ? `${formatMonthDay(f.tradingDate)} ${SIDE[f.side]} ${f.symbol} ${f.qty}株` : null,
    };
  });
  cards.sort((x, y) => (x.rank ?? 1e9) - (y.rank ?? 1e9) || (x.agentId < y.agentId ? -1 : 1));

  const feed: (FeedItem & { at: number; seq: number })[] = [];
  for (const f of fills) {
    feed.push({ at: f.at, seq: f.seq, key: `fill-${f.seq}-${f.fillIndex}`, timeText: formatJstShort(f.at), kind: "fill", label: "約定", color: charOf(f.agentId, f.agentName).color, text: `${who(f.agentId, f.agentName)}　${SIDE[f.side]} ${f.symbol} ${f.qty}株${f.price === null ? "" : ` @${formatYenMark(f.price)}`}` });
  }
  for (const p of posts) {
    const c = charOf(p.agentId, p.agentName);
    const text = p.withdrawn ? `${c.name}の投稿（非表示：${p.withdrawn.reason || "理由の記載なし"}）` : p.text === null ? `${c.name}の投稿（本文が保管にありません）` : `${c.name}「${p.text}」`;
    feed.push({ at: p.at, seq: p.seq, key: `post-${p.seq}`, timeText: formatJstShort(p.at), kind: "post", label: "投稿", color: "#D9C8F2", text, symbol: p.symbol });
  }
  // 順位：評価の記録の日ごとに、首位のAI。前の評価の日の首位と同じなら「守る」
  const byDate = new Map<string, (TimelineItem & { kind: "valuation" })[]>();
  for (const v of valuations) (byDate.get(v.date) ?? byDate.set(v.date, []).get(v.date)!).push(v);
  const settled = settledDates(view);
  let prevLeader: string | null = null;
  for (const [date, list] of [...byDate].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    // 評価が書きかけの日（評価を始めたAIのうち、まだその日の評価がないAIがいる日）は、首位を決めない
    if (!settled.has(date)) continue;
    const best = list.reduce((m, v) => (v.total > m.total ? v : m));
    const tied = list.filter((v) => v.total === best.total);
    const lead = tied.length > 1 ? null : best;
    const last = list.reduce((m, v) => (v.seq > m.seq ? v : m));
    const text = lead
      ? `${who(lead.agentId, lead.agentName)}が首位${prevLeader === lead.agentId ? "を守る" : "に立つ"}（総資産 ${formatYenMark(lead.total)}）`
      : `${date} の首位は同額（${tied.map((v) => who(v.agentId, v.agentName)).join("・")}）`;
    feed.push({ at: last.at, seq: last.seq, key: `rank-${date}`, timeText: formatJstShort(last.at), kind: "rank", label: "順位", color: "#B6FF3B", text });
    prevLeader = lead?.agentId ?? null;
  }
  feed.sort((a, b) => b.at - a.at || b.seq - a.seq);
  return { cards, feed: feed.slice(0, FEED_LIMIT).map(({ at: _at, seq: _seq, ...rest }) => rest) };
}
