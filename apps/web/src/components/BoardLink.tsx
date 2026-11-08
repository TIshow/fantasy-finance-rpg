import Link from "next/link";
import { isSymbolBoard } from "../view/board";

/** 掲示板への案内。銘柄ならそのページへのリンク。「全体」はページがないので、リンクにしない文字だけ */
export function BoardLink({ board, className, suffix = "" }: { board: string; className?: string; suffix?: string }) {
  if (!isSymbolBoard(board)) return <span className="font-num">全体の掲示板</span>;
  return (
    <Link href={`/symbols/${encodeURIComponent(board)}`} className={className}>
      {board}
      {suffix}
    </Link>
  );
}
