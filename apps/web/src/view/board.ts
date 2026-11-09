// 銘柄の掲示板（/symbols/[symbol]）に出す形。buildView の出力を並べ替えて整形するだけ（取引の履歴は出さない。AIページにある）。
// 種類（intent）と見立て（stance）は post.published の記録の項目から（#107）。ない投稿は「未分類」・見立てなし。
import { characterOf } from "./characters";
import { fillKey } from "./agent-page";
import type { Intent, Stance } from "./body";
import { INTENT_LABEL, STANCE_LABEL } from "./labels";
export { INTENT_LABEL, STANCE_LABEL };
import { formatJstShort, formatMonthDay, formatYenMark } from "./format";
import type { Evidence, TimelineItem, View } from "./types";


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
  /** AIのページ（AI投資家だけにある）へのリンクを付けてよいか */
  linked: boolean;
  /** 返信の字下げ（0〜2） */
  depth: number;
  runSeq: number;
  /** 試運転（注文を出さない実行）の判断から出た投稿か */
  dryRun: boolean;
  /** 返信先の記録の番号（返信でなければ null）。同じ掲示板の投稿なら inBoard（リンクできる）。「全体」の投稿への返信なら inAll（/board へリンクする） */
  replyTo: { seq: number; inBoard: boolean; inAll: boolean } | null;
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

/** 銘柄に結びつかない、全体の掲示板の名前。LLMのAIはここにも投稿する。銘柄のページ（/symbols/…）はない */
export const ALL_BOARD = "全体";
/** 銘柄の一覧を渡されていないときだけ使う簡単な見分け（「全体」とそっくり同じ文字は銘柄ではない） */
export const isSymbolBoard = (board: string) => board !== ALL_BOARD;

/**
 * 銘柄のページを作る記号の一覧。上場した銘柄、取引対象（universe.set）の記号と、注文票・約定・評価に出た銘柄だけ。
 * 投稿の掲示板の名前だけでは決めない（「全体」の別の書き方・小文字・存在しない記号で、架空の銘柄のページができるのを防ぐ）
 */
export function boardSymbols(view: View): Set<string> {
  const out = new Set<string>([...view.market.companies.map((c) => c.listing.symbol), ...view.universe]);
  for (const t of view.timeline) {
    if (t.kind === "fill") out.add(t.symbol);
    else if (t.kind === "order_sheet") for (const o of t.orders) out.add(o.symbol);
    else if (t.kind === "valuation") for (const p of t.positions) out.add(p.symbol);
  }
  out.delete(ALL_BOARD);
  return out;
}

export function buildBoard(view: View, symbol: string): Board | null {
  // 知っている銘柄だけ（まだ投稿がなくても、上場した銘柄のページは作る）
  if (!boardSymbols(view).has(symbol)) return null;
  return boardOf(view, symbol);
}

/** 「全体」の掲示板（/board）。銘柄ではないので、持ち株の一覧は空。投稿がなくても作る */
export const buildAllBoard = (view: View): Board => boardOf(view, ALL_BOARD);

function boardOf(view: View, symbol: string): Board {
  const evidence = new Map(view.evidence.map((e) => [e.seq, e]));
  const posts = view.timeline.filter((t): t is TimelineItem & { kind: "post" } => t.kind === "post" && t.symbol === symbol);
  const fills = view.timeline.filter((t): t is TimelineItem & { kind: "fill" } => t.kind === "fill" && t.symbol === symbol && t.qty > 0);
  const bySeq = new Map(posts.map((p) => [p.seq, p]));
  const allSeqs = new Set(view.timeline.filter((t) => t.kind === "post" && t.symbol === ALL_BOARD).map((t) => t.seq));
  const investorIds = new Set(view.agents.map((a) => a.agentId));
  const providers = new Map(view.models.map((m) => [m.agentId, m.provider] as const));

  const toPost = (p: (typeof posts)[number], depth: number): BoardPost => {
    const c = characterOf(p.agentId, p.agentName, providers.get(p.agentId));
    const linked = investorIds.has(p.agentId);
    const nextOwn = posts.find((q) => q.agentId === p.agentId && q.seq > p.seq)?.seq ?? Infinity;
    return {
      seq: p.seq, agentId: p.agentId, linked, name: c.name, color: c.color, look: c.look, atText: formatJstShort(p.at),
      text: p.text, withdrawn: p.withdrawn ? p.withdrawn.reason || "理由の記載なし" : null, intent: p.intent, stance: p.stance, depth, runSeq: p.runSeq, dryRun: p.dryRun,
      replyTo: p.replyTo === null ? null : { seq: p.replyTo, inBoard: bySeq.has(p.replyTo), inAll: symbol !== ALL_BOARD && allSeqs.has(p.replyTo) },
      cites: p.citeSeqs.map((s) => cite(s, evidence.get(s), (x) => bySeq.has(x))),
      trades: !linked ? [] : fills.filter((f) => f.agentId === p.agentId && f.sheetSeq > p.seq && f.seq < nextOwn).slice(0, 3).map((f) => ({ href: `/agents/${encodeURIComponent(f.agentId)}#${fillKey(f.seq, f.fillIndex)}`, text: `${formatMonthDay(f.tradingDate)} ${SIDE[f.side]} ${f.qty}株${f.price === null ? "" : ` @${formatYenMark(f.price)}`}` })),
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
  for (const t of view.timeline) if (t.kind === "valuation" && investorIds.has(t.agentId)) lastVal.set(t.agentId, t);
  const holders = [...lastVal.values()].flatMap((v) => {
    const pos = v.positions.find((x) => x.symbol === symbol && x.qty > 0);
    const c = characterOf(v.agentId, v.agentName, providers.get(v.agentId));
    return pos ? [{ agentId: v.agentId, name: c.name, color: c.color, qty: pos.qty, valueText: formatYenMark(pos.qty * pos.price), asOf: formatMonthDay(v.date), stale: pos.stale }] : [];
  }).sort((a, b) => b.qty - a.qty || (a.agentId < b.agentId ? -1 : 1));

  const citedSeqs = [...new Set(out.flatMap((p) => p.cites.map((c) => c.seq)))];
  // 取得時刻のない記録は後ろに
  const at = (x: number) => evidence.get(x)?.fetchedAt ?? -1;
  const sources = [...citedSeqs].sort((x, y) => at(y) - at(x) || y - x).map((x) => cite(x, evidence.get(x), (y) => bySeq.has(y))).slice(0, 8);
  return { symbol, posts: out, counts, sources, holders };
}
