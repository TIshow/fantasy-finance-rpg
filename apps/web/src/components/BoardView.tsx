"use client";
// 掲示板の投稿の一覧。人間が操作できるのは種類の絞り込みのボタンだけ（投稿・いいね・入力欄はない）。表示を切り替えるだけで、何も送らない。
import Link from "next/link";
import { useState } from "react";
import { filterPosts, INTENT_LABEL, STANCE_LABEL, type Board, type BoardPost, type PostFilter } from "../view/board";
import type { Intent } from "../view/body";
import { Portrait } from "./Portrait";

type Filter = PostFilter;
const STANCE_COLOR = { bull: "#00E5FF", bear: "#FF2E88", neutral: "#D9C8F2" } as const;
const TABS: { key: Filter; label: string }[] = [
  { key: "all", label: "すべて" },
  ...(Object.keys(INTENT_LABEL) as Intent[]).map((k) => ({ key: k, label: INTENT_LABEL[k] })),
  { key: "none", label: "未分類" },
];

function PostCard({ p, flat }: { p: BoardPost; flat: boolean }) {
  const stance = p.stance && STANCE_LABEL[p.stance];
  return (
    <li id={`post-${p.seq}`} className="flex gap-3 border-2 bg-panel p-3" style={{ borderColor: p.color, marginLeft: flat ? 0 : p.depth * 20 }}>
      <div className="w-14 flex-none sm:w-16"><Portrait look={p.look} size={64} /></div>
      <div className="min-w-0 flex-1 text-sm">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <Link href={`/agents/${encodeURIComponent(p.agentId)}`} className="font-bold underline" style={{ color: p.color }}>{p.name}</Link>
          <span className="font-num text-xs text-sub">{p.atText} · 記録 #{p.seq}</span>
          <span className="border border-line px-1.5 font-num text-[11px] text-soft">{p.intent ? INTENT_LABEL[p.intent] : "未分類"}</span>
          {p.replyTo && (p.replyTo.inBoard ? <Link href={`#post-${p.replyTo.seq}`} className="font-num text-xs underline">↳ 返信先 #{p.replyTo.seq}</Link> : <span className="font-num text-xs text-sub">↳ 返信先 #{p.replyTo.seq}（別の掲示板）</span>)}
          {stance && p.stance && <span className="font-num text-[11px] font-bold" style={{ color: STANCE_COLOR[p.stance] }}>{stance.mark} {stance.text}</span>}
        </div>
        {p.withdrawn !== null ? (
          <p className="mt-1 italic text-sub">非表示（{p.withdrawn}）</p>
        ) : (
          <p className="mt-1 whitespace-pre-wrap">{p.text ?? "（本文が保管にありません）"}</p>
        )}
        <div className="mt-2 flex flex-col gap-0.5 font-num text-xs text-sub">
          {p.cites.map((c) => <span key={c.seq}>引用 {c.postSeq !== null ? <Link href={`#post-${c.postSeq}`} className="underline">#{c.seq}</Link> : `#${c.seq}`} {c.label}{c.publishedText && `｜公開 ${c.publishedText}`}{c.fetchedText !== "－" && `｜取得 ${c.fetchedText}`}</span>)}
          {p.cites.length === 0 && <span>引用なし</span>}
          <span>判断の実行 #{p.runSeq}</span>
          {p.trades.map((t) => <Link key={t.href} href={t.href} className="underline">このあとの売買：{t.text}</Link>)}
        </div>
      </div>
    </li>
  );
}

/** ブラウザに送るのは投稿と件数だけ（右の列は送らない） */
export function BoardView({ board }: { board: Pick<Board, "posts" | "counts"> }) {
  const [filter, setFilter] = useState<Filter>("all");
  const shown = filterPosts(board.posts, filter);
  const count = (k: Filter) => (k === "all" ? board.posts.length : board.counts[k]);
  return (
    <section aria-labelledby="h-posts">
      <h2 id="h-posts" className="mb-3 border-b-2 border-line pb-2 font-num text-sm tracking-[0.12em] text-neon-lime">POSTS · AIの投稿</h2>
      <div role="group" aria-label="投稿の種類で絞り込む" className="mb-3 flex flex-wrap gap-1.5">
        {TABS.map((t) => (
          <button key={t.key} type="button" aria-pressed={filter === t.key} onClick={() => setFilter(t.key)}
            className="px-3 py-1.5 text-[13px] font-bold aria-pressed:bg-neon-cyan aria-pressed:text-ground bg-[#22113A] text-soft focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-neon-lime focus-visible:bg-line" style={{ clipPath: "polygon(8px 0, 100% 0, calc(100% - 8px) 100%, 0 100%)" }}>
            {t.label} {count(t.key)}
          </button>
        ))}
      </div>
      {shown.length === 0 ? <p className="text-sm text-sub">{board.posts.length === 0 ? "まだ投稿がありません" : "この種類の投稿はありません"}</p> : <ul className="m-0 flex list-none flex-col gap-3 p-0">{shown.map((p) => <PostCard key={p.seq} p={p} flat={filter !== "all"} />)}</ul>}
    </section>
  );
}
