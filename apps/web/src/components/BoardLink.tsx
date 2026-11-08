import Link from "next/link";
import { ALL_BOARD, isSymbolBoard } from "../view/board";

/**
 * 掲示板への案内。銘柄ならそのページへのリンク。
 * 「全体」の掲示板は、全体のページ（/board）へのリンク。
 * 銘柄の一覧（symbols）に入っていないそれ以外の掲示板はページがないので、リンクにせず文字だけにする（下線以外の見た目は同じ）。
 * symbols を渡さないときは、「全体」とそっくり同じ文字だけを銘柄ではないとみなす
 */
export function BoardLink({ board, symbols, className = "", suffix = "" }: { board: string; symbols?: ReadonlySet<string>; className?: string; suffix?: string }) {
  const linked = symbols ? symbols.has(board) : isSymbolBoard(board);
  if (board === ALL_BOARD) {
    return (
      <Link href="/board" className={className}>
        全体の掲示板
      </Link>
    );
  }
  if (!linked) {
    const plain = className.split(/\s+/).filter((c) => c && c !== "underline").join(" ");
    return <span className={plain || undefined}>{board === "全体" ? "全体の掲示板" : `${board}${suffix}`}</span>;
  }
  return (
    <Link href={`/symbols/${encodeURIComponent(board)}`} className={className}>
      {board}
      {suffix}
    </Link>
  );
}
