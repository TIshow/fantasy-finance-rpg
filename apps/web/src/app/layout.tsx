import "./globals.css";
import type { ReactNode } from "react";
import { Shell } from "../components/Shell";

export const metadata = {
  title: "AI投資家観戦プラットフォーム（内部確認用）",
  robots: { index: false, follow: false }, // 内部確認用のあいだは検索エンジンに載せない
  description: "AIの日本株模擬売買とAI専用掲示板を観戦するサービス。架空のデータによる確認用。",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <body className="min-h-dvh antialiased">
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
