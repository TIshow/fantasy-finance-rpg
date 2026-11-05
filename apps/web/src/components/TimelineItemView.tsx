import Link from "next/link";
import type { TimelineItem } from "../view/types";
import { formatJst } from "../view/format";

const SIDE = { buy: "買い", sell: "売り" } as const;
const STATUS = { filled: "約定", reduced: "一部のみ約定", expired: "失効" } as const;
const REASON: Record<string, string> = {
  insufficient_cash: "現金不足", insufficient_holdings: "保有不足", no_open_price: "始値なし", market_closed: "休場",
  invalid_sheet: "注文票の不備", after_cutoff: "締め切り後", wrong_trading_date: "約定日の誤り", account_not_ready: "口座の準備前",
  already_committed: "確定済み", invalid_order: "注文の不備", unknown_symbol: "対象外の銘柄", invalid_qty: "数量の不備", suspended: "停止中",
};
const SCOPE = { posts: "投稿", orders: "注文", both: "投稿と注文" } as const;

const Symbol = ({ symbol }: { symbol: string }) => (
  <Link href={`/symbols/${encodeURIComponent(symbol)}`} className="font-num font-semibold text-neon-cyan underline">
    {symbol}
  </Link>
);

function Body({ item }: { item: TimelineItem }) {
  switch (item.kind) {
    case "post":
      return (
        <>
          <span className="text-sub">投稿</span> <Symbol symbol={item.symbol} />
          {item.withdrawn ? (
            <p className="mt-1 italic text-sub">非表示（{item.withdrawn.reason || "理由の記載なし"}）</p>
          ) : (
            <p className="mt-1 whitespace-pre-wrap">{item.text ?? "（本文が保管にありません）"}</p>
          )}
          <p className="mt-1 text-xs text-sub">出典：記録 #{item.citeSeqs.join("・#") || "なし"}／判断の実行 #{item.runSeq}</p>
        </>
      );
    case "order_sheet":
      return (
        <>
          <span className="text-sub">注文票を確定（約定日 {item.tradingDate}）</span>
          <ul className="mt-1">
            {item.orders.map((o, i) => (
              <li key={i}>
                <Symbol symbol={o.symbol} /> {SIDE[o.side]} {o.qty}株
              </li>
            ))}
          </ul>
        </>
      );
    case "fill":
      return (
        <>
          <span className="text-sub">{STATUS[item.status]}</span> <Symbol symbol={item.symbol} /> {SIDE[item.side]} {item.qty}株
          {item.qty !== item.requestedQty && `（注文 ${item.requestedQty}株）`} {item.priceText ? `@ ${item.priceText}` : ""}
          {item.reason && <span className="text-sub">（{REASON[item.reason] ?? item.reason}）</span>}
        </>
      );
    case "valuation":
      return (
        <>
          <span className="text-sub">引け後の評価（{item.date}）</span> 評価額 <b>{item.totalText}</b>（前日比 {item.changeText}）
          {item.positions.some((x) => x.stale) && (
            <span className="text-amber-300">
              （直近の終値で評価：{item.positions.filter((x) => x.stale).map((x) => x.symbol).join("・")}）
            </span>
          )}
        </>
      );
    case "rejected":
      return <span className="text-neon-pink">注文票を拒否（約定日 {item.tradingDate}）：{REASON[item.reason] ?? item.reason}</span>;
    case "suspension":
      return (
        <span className="text-neon-pink">
          {item.action === "suspended" ? "停止" : "再開"}（{SCOPE[item.scope]}）：{item.reason}
        </span>
      );
  }
}

export function TimelineItemView({ item }: { item: TimelineItem }) {
  return (
    <li className="border border-line bg-panel p-3 text-sm">
      <p className="mb-1 text-xs text-sub">
        <time dateTime={new Date(item.at).toISOString()}>{formatJst(item.at)}</time> ・ <b className="text-ink">{item.agentName}</b> ・ 記録 #{item.seq}
      </p>
      <div><Body item={item} /></div>
    </li>
  );
}
