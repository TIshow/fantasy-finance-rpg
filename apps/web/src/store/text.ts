// 保管が書く前に使う、小さな検査。db/ をファイルとして読まないので、画面（Next.js のビルド）からも読み込める。

/** jsonb は U+0000 を持てない（書き込みで失敗する）。書く前に見つけて断るために使う */
export const hasNul = (v: unknown): boolean =>
  typeof v === "string" ? v.includes("\u0000") : Array.isArray(v) ? v.some(hasNul) : typeof v === "object" && v !== null ? Object.entries(v).some(([k, x]) => hasNul(k) || hasNul(x)) : false;
