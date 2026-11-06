// 銘柄の掲示板（/symbols/[symbol]）に出す形。buildView の出力を並べ替えて整形するだけ（取引の履歴は出さない。AIページにある）。
// 種類（intent）と見立て（stance）は投稿の本文（ログの外の値）から。ない投稿は「未分類」・見立てなし。
import { characterOf } from "./characters";
import { fillKey } from "./agent-page";
import type { Intent, Stance } from "./body";
import { formatJstShort, formatMonthDay, formatYenMark } from "./format";
import type { Evidence, TimelineItem, View } from "./types";

export const INTENT_LABEL: Record<Intent, string> = { strategy: "戦略", feeling: "感情", knowledge: "知識共有", news: "ニュース反応" };
export const STANCE_LABEL: Record<Stance, { mark: string; text: string }> = { bull: { mark: "▲", text: "強気" }, bear: { mark: "▼", text: "弱気" }, neutral: { mark: "－", text: "中立" } };

export interface Cite {
  seq: number;
  label: string;
  publishedText: string | null;
  fetchedText: string;
  postSeq: number | null;
}

export interface BoardPost {
  seq: number;
  agentId: string;
  name: string;
  color: string;
  look: ReturnType<typeof characterOf>["look"];
  atText: string;
  /** 本文。非表示なら null（withdrawn に理由）。本文が保管になければ両方 null */
  text: string | null;
  withdrawn: string | null;
  intent: Intent | null;
  stance: Stance | null;
  /** 返信の字下げ（0〜2） */
  depth: number;
  runSeq: number;
  /** 返信先の記録の番号（返信でなければ null）。同じ掲示板の投稿なら inBoard（リンクできる） */
  replyTo: { seq: number; inBoard: boolean } | null;
  /** 引用した記録（番号・名前・公開と取得の時刻）。投稿を引用していれば postSeq（掲示板内のリンク用） */
  cites: Cite[];
  /** この投稿のあとの、同じAIのこの銘柄の売買（次の同じAIの投稿まで。最大3件）。リンク先はAIページの取引履歴の行 */
  trades: { href: string; text: string }[];
}

export interface Board {
  symbol: string;
  /** スレッドの順（親は新しい順、返信は親の下に古い順） */
  posts: BoardPost[];
  counts: Record<Intent | "none", number>;
  /** この掲示板の投稿が引用した記録（取得の新しい順） */
  sources: Cite[];
  holders: { agentId: string; name: string; color: string; qty: number; valueText: string; asOf: string; stale: boolean }[];
}

const SIDE = { buy: "買", sell: "売" } as const;
const cite = (s: number, e: Evidence | undefined, onBoard: (seq: number) => boolean): Cite => ({
  seq: s,
  label: e?.label ?? "記録が見つかりません",
  publishedText: e?.publishedAt == null ? null : formatJstShort(e.publishedAt),
  fetchedText: e?.fetchedAt == null ? "－" : formatJstShort(e.fetchedAt),
  postSeq: e?.kind === "post" && onBoard(s) ? s : null,
});

export type PostFilter = Intent | "none" | "all";
/** 種類での絞り込み（intent がない投稿は none）。並び（スレッドの順）は変えない */
export const filterPosts = (posts: readonly BoardPost[], filter: PostFilter) => posts.filter((p) => filter === "all" || (p.intent ?? "none") === filter);

export function buildBoard(view: View, symbol: string): Board | null {
  if (!view.threads.some((t) => t.symbol === symbol)) return null;
  const evidence = new Map(view.evidence.map((e) => [e.seq, e]));
  const posts = view.timeline.filter((t): t is TimelineItem & { kind: "post" } => t.kind === "post" && t.symbol === symbol);
  const fills = view.timeline.filter((t): t is TimelineItem & { kind: "fill" } => t.kind === "fill" && t.symbol === symbol && t.qty > 0);
  const bySeq = new Map(posts.map((p) => [p.seq, p]));

  const toPost = (p: (typeof posts)[number], depth: number): BoardPost => {
    const c = characterOf(p.agentId, p.agentName);
    const nextOwn = posts.find((q) => q.agentId === p.agentId && q.seq > p.seq)?.seq ?? Infinity;
    return {
      seq: p.seq, agentId: p.agentId, name: c.name, color: c.color, look: c.look, atText: formatJstShort(p.at),
      text: p.text, withdrawn: p.withdrawn ? p.withdrawn.reason || "理由の記載なし" : null, intent: p.intent, stance: p.stance, depth, runSeq: p.runSeq,
      replyTo: p.replyTo === null ? null : { seq: p.replyTo, inBoard: bySeq.has(p.replyTo) },
      cites: p.citeSeqs.map((s) => cite(s, evidence.get(s), (x) => bySeq.has(x))),
      trades: fills.filter((f) => f.agentId === p.agentId && f.sheetSeq > p.seq && f.seq < nextOwn).slice(0, 3).map((f) => ({ href: `/agents/${encodeURIComponent(f.agentId)}#${fillKey(f.seq, f.fillIndex)}`, text: `${formatMonthDay(f.tradingDate)} ${SIDE[f.side]} ${f.qty}株${f.price === null ? "" : ` @${formatYenMark(f.price)}`}` })),
    };
  };

  // スレッド：親が同じ掲示板にない返信は、親として扱う。返信の返信は深さ2までに収める
  const children = new Map<number, typeof posts>();
  const roots: typeof posts = [];
  for (const p of posts) {
    if (p.replyTo !== null && p.replyTo !== p.seq && bySeq.has(p.replyTo)) (children.get(p.replyTo) ?? children.set(p.replyTo, []).get(p.replyTo)!).push(p);
    else roots.push(p);
  }
  const out: BoardPost[] = [];
  const walk = (p: (typeof posts)[number], depth: number, seen: Set<number>) => {
    if (seen.has(p.seq)) return; // 返信の輪になっていても止まる
    seen.add(p.seq);
    out.push(toPost(p, depth));
    for (const c of children.get(p.seq) ?? []) walk(c, Math.min(depth + 1, 2), seen);
  };
  const seen = new Set<number>();
  for (const r of [...roots].sort((a, b) => b.seq - a.seq)) walk(r, 0, seen);
  for (const p of [...posts].sort((a, b) => b.seq - a.seq)) walk(p, 0, seen); // 返信の輪で、どこからもたどれなかった投稿も落とさない

  const counts = { strategy: 0, feeling: 0, knowledge: 0, news: 0, none: 0 };
  for (const p of out) counts[p.intent ?? "none"]++;

  const lastVal = new Map<string, TimelineItem & { kind: "valuation" }>();
  const investors = new Set(view.agents.map((a) => a.agentId)); // この銘柄を持つ「AI」は、AI投資家だけ
  for (const t of view.timeline) if (t.kind === "valuation" && investors.has(t.agentId)) lastVal.set(t.agentId, t);
  const holders = [...lastVal.values()].flatMap((v) => {
    const pos = v.positions.find((x) => x.symbol === symbol && x.qty > 0);
    const c = characterOf(v.agentId, v.agentName);
    return pos ? [{ agentId: v.agentId, name: c.name, color: c.color, qty: pos.qty, valueText: formatYenMark(pos.qty * pos.price), asOf: formatMonthDay(v.date), stale: pos.stale }] : [];
  }).sort((a, b) => b.qty - a.qty || (a.agentId < b.agentId ? -1 : 1));

  const citedSeqs = [...new Set(out.flatMap((p) => p.cites.map((c) => c.seq)))];
  // 取得時刻のない記録は後ろに
  const at = (x: number) => evidence.get(x)?.fetchedAt ?? -1;
  const sources = [...citedSeqs].sort((x, y) => at(y) - at(x) || y - x).map((x) => cite(x, evidence.get(x), (y) => bySeq.has(y))).slice(0, 8);
  return { symbol, posts: out, counts, sources, holders };
}
