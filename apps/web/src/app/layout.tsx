import type { ReactNode } from "react";

export const metadata = {
  title: "GUILD MARKET",
  description: "王国の商会100と同じ市場で、4つのギルドの未来を読み合う予測ゲーム",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
