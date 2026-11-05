import { notFound } from "next/navigation";
import { TimelineItemView } from "../../../components/TimelineItemView";
import { getView } from "../../data";

// 銘柄はビルドの時点で決まる。知らない銘柄はページの処理を通さず 404（不正なURLの500も避ける）
export const dynamicParams = false;

export async function generateStaticParams() {
  return (await getView()).threads.map((t) => ({ symbol: t.symbol }));
}

export default async function SymbolPage({ params }: { params: Promise<{ symbol: string }> }) {
  const symbol = decodeURIComponent((await params).symbol);
  const thread = (await getView()).threads.find((t) => t.symbol === symbol);
  if (!thread) notFound();
  return (
    <>
      <h1 className="mb-3 font-display text-2xl font-normal">
        銘柄スレッド <span className="font-num">{thread.symbol}</span>
      </h1>
      <ol className="space-y-2">
        {thread.items.map((item, i) => (
          <TimelineItemView key={`${item.seq}-${i}`} item={item} />
        ))}
      </ol>
    </>
  );
}
