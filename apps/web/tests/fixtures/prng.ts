// 固定シードの擬似乱数（mulberry32）。ライブラリを足さない純関数で、同じシードなら同じ列になる。
// 暗号用ではない（ゴールデンログの架空データを作るためだけ）。

/** [0, 1) の一様な数を返す関数を作る。seed は 32bit の整数に丸める */
export function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** lo 以上 hi 以下の整数 */
export function randInt(rand: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rand() * (hi - lo + 1));
}

/** 配列から1つ選ぶ（空の配列は例外） */
export function pick<T>(rand: () => number, items: readonly T[]): T {
  if (items.length === 0) throw new Error("pick from an empty array");
  return items[Math.floor(rand() * items.length)]!;
}
