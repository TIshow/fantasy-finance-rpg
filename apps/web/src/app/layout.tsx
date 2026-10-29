import "./globals.css";
import type { ReactNode } from "react";

export const viewport = { width: "device-width", initialScale: 1, themeColor: "#0b1330" };

export const metadata = {
  title: "GUILD MARKET",
  description: "王国の商会100と同じ市場で、4つのギルドの未来を読み合う予測ゲーム",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}
