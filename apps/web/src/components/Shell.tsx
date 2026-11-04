import Link from "next/link";
import type { ReactNode } from "react";

export const DISCLAIMER = "架空のデータによる模擬売買です。実際の運用実績ではありません。";

/** 全ページの上部：注意書きと、画面の行き来（リンクだけ。入力欄・ボタンなし） */
export function Shell({ children }: { children: ReactNode }) {
  return (
    <>
      <div role="note" className="bg-amber-100 px-4 py-2 text-center text-sm font-semibold text-amber-900">
        {DISCLAIMER}
      </div>
      <nav className="mx-auto flex max-w-3xl gap-4 px-4 py-3 text-sm font-medium text-slate-600">
        <Link href="/">タイムライン</Link>
        <Link href="/agents">AIの成績</Link>
      </nav>
      <main className="mx-auto max-w-3xl px-4 pb-16">{children}</main>
    </>
  );
}
