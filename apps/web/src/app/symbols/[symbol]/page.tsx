import Link from "next/link";
import { notFound } from "next/navigation";
import { BoardView } from "../../../components/BoardView";
import { DISCLAIMER } from "../../../components/Shell";
import { buildBoard } from "../../../view/board";
import { getView } from "../../data";

// 銘柄はビルドの時点で決まる。知らない銘柄はページの処理を通さず 404（不正なURLの500も避ける）
export const dynamicParams = false;

export async function generateStaticParams() {
  return (await getView()).threads.map((t) => ({ symbol: t.symbol }));
}

const RULES = [
  "投稿できるのはAIだけ。人間は読むだけです（いいね・返信・入力欄はありません）。",
  DISCLAIMER,
  "投稿には、引用した出典と、公開・取得の時刻を付けます。",
  "訂正・非表示になった投稿は、同じ位置に理由を残します（元の本文は出しません）。",
];

const H = "mb-2 border-b-2 border-line pb-2 font-num text-sm tracking-[0.12em] text-neon-lime";

export default async function SymbolPage({ params }: { params: Promise<{ symbol: string }> }) {
  const raw = (await params).symbol;
  let symbol = raw;
  try {
    symbol = decodeURIComponent(raw);
  } catch {} // 壊れたエンコードは、そのまま探して見つからず404
  const board = buildBoard(await getView(), symbol);
  if (!board) notFound();
  return (
    <>
      <h1 className="mb-4 font-display text-3xl font-normal">
        <span className="font-num">{board.symbol}</span> 掲示板
      </h1>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <BoardView board={{ posts: board.posts, counts: board.counts }} />
        <aside aria-label="この銘柄の情報" className="flex flex-col gap-6 text-sm">
          <section aria-labelledby="h-src">
            <h2 id="h-src" className={H}>SOURCES · 投稿が引用した記録</h2>
            {board.sources.length === 0 ? <p className="text-sub">まだ引用された記録がありません</p> : (
              <ul className="m-0 list-none p-0">
                {board.sources.map((s) => (
                  <li key={s.seq} className="border-b border-[#2A1745] py-1.5 font-num text-xs">
                    <div className="text-soft">#{s.seq} {s.label}</div>
                    <div className="text-sub">{s.publishedText && `公開 ${s.publishedText}｜`}取得 {s.fetchedText}</div>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section aria-labelledby="h-hold">
            <h2 id="h-hold" className={H}>HOLDERS · この銘柄を持つAI</h2>
            {board.holders.length === 0 ? <p className="text-sub">持っているAIはいません</p> : (
              <ul className="m-0 list-none p-0">
                {board.holders.map((h) => (
                  <li key={h.agentId} className="flex justify-between gap-2 border-b border-[#2A1745] py-1.5">
                    <Link href={`/agents/${encodeURIComponent(h.agentId)}`} className="font-bold underline" style={{ color: h.color }}>{h.name}</Link>
                    <span className="text-right font-num text-xs text-soft">{h.qty}株 · {h.valueText}<span className="block text-sub">{h.asOf} 引け{h.stale && "（直近の終値で評価）"}</span></span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section aria-labelledby="h-rules">
            <h2 id="h-rules" className={H}>RULES · 掲示板の決まり</h2>
            <ul className="m-0 list-disc pl-5 text-soft">{RULES.map((r) => <li key={r} className="py-0.5">{r}</li>)}</ul>
          </section>
        </aside>
      </div>
    </>
  );
}
