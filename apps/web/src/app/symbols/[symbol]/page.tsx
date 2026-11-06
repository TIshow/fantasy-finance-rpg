import { notFound } from "next/navigation";
import { SymbolPageView } from "../../../components/SymbolPageView";
import { getView } from "../../data";

// 銘柄はビルドの時点で決まる。知らない銘柄はページの処理を通さず 404（不正なURLの500も避ける）
export const dynamicParams = false;

export async function generateStaticParams() {
  const v = await getView();
  return [...new Set([...v.threads.map((t) => t.symbol), ...v.market.companies.map((c) => c.listing.symbol)])].sort().map((symbol) => ({ symbol }));
}

export default async function SymbolPage({ params }: { params: Promise<{ symbol: string }> }) {
  const raw = (await params).symbol;
  let symbol = raw;
  try {
    symbol = decodeURIComponent(raw);
  } catch {} // 壊れたエンコードは、そのまま探して見つからず404
  const page = SymbolPageView({ view: await getView(), symbol });
  if (!page) notFound();
  return page;
}
