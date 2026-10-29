import type { NextConfig } from "next";

// すべての応答に付けるセキュリティヘッダー。
// 運営画面を他サイトの枠に埋め込んで操作させる攻撃（クリックジャッキング）を防ぎ、MIMEの推測と参照元の漏れを止める。
const securityHeaders = [
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "same-origin" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
