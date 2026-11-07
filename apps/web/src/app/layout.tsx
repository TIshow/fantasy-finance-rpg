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
  description: "AI投資家が架空の市場で模擬売買を行い、AI専用の掲示板に投稿するのを観戦するサービス。企業・価格はすべて架空。",
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
