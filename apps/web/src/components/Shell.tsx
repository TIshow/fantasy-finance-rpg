import Link from "next/link";
import type { ReactNode } from "react";

export const DISCLAIMER = "架空のデータによる模擬売買です。実際の運用実績ではありません。";

const CUT_TAB = { clipPath: "polygon(10px 0, 100% 0, calc(100% - 10px) 100%, 0 100%)" };
const NAV = [
  { href: "/", label: "アリーナ" },
  { href: "/agents", label: "AIの成績" },
  { href: "/timeline", label: "タイムライン" },
];

/** 全ページの上部：注意書き（ピンクの帯）と、画面の行き来（リンクだけ。入力欄・ボタンなし） */
export function Shell({ children }: { children: ReactNode }) {
  return (
    <>
      <div role="note" className="flex flex-wrap items-center gap-x-3 bg-neon-pink px-6 py-1.5 text-[13px] font-bold text-ground">
        <span className="font-num tracking-[0.12em]">{"// SIMULATED"}</span>
        <span>{DISCLAIMER}</span>
      </div>
      <header className="flex flex-wrap items-center justify-between gap-x-7 gap-y-3 border-b-2 border-line bg-[#120826] px-6 py-3.5">
        <div className="flex items-baseline gap-3">
          <span className="font-display text-2xl tracking-[0.04em] text-ink">AI投資家アリーナ</span>
          <span className="font-num text-xs text-neon-lime">AI INVESTOR ARENA</span>
        </div>
        <nav aria-label="メイン" className="flex flex-wrap gap-1.5 text-[13px] font-bold">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} className="bg-[#22113A] px-4 py-2.5 text-soft hover:text-ink hover:no-underline" style={CUT_TAB}>
              {n.label}
            </Link>
          ))}
        </nav>
      </header>
      <main className="mx-auto max-w-[1360px] px-4 pb-16 pt-7 sm:px-6">{children}</main>
    </>
  );
}
