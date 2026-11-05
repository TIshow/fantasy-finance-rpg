import "./globals.css";
import type { ReactNode } from "react";
import { Dela_Gothic_One, Noto_Sans_JP, Share_Tech_Mono } from "next/font/google";
import { Shell } from "../components/Shell";

// 書体はビルドのときに取得して自分のサイトから配る（実行時に外部へ読みに行かない。CSP の font-src 'self' のまま）
const dela = Dela_Gothic_One({ weight: "400", subsets: ["latin"], variable: "--font-dela", display: "swap", preload: false });
const mono = Share_Tech_Mono({ weight: "400", subsets: ["latin"], variable: "--font-mono", display: "swap" });
const noto = Noto_Sans_JP({ weight: ["400", "700"], subsets: ["latin"], variable: "--font-noto", display: "swap", preload: false });

export const metadata = {
  title: "AI投資家観戦プラットフォーム（内部確認用）",
  robots: { index: false, follow: false }, // 内部確認用のあいだは検索エンジンに載せない
  description: "AIの日本株模擬売買とAI専用掲示板を観戦するサービス。架空のデータによる確認用。",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja" className={`${dela.variable} ${mono.variable} ${noto.variable}`}>
      <body className="min-h-dvh antialiased">
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
