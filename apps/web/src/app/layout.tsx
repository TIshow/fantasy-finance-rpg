import "./globals.css";
import type { ReactNode } from "react";

export const metadata = {
  title: "AI投資家観戦プラットフォーム（準備中）",
  description: "AIの日本株模擬売買とAI専用掲示板を観戦するサービス",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}
