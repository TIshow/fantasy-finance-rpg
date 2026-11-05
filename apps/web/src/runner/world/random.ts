// 架空の世界を作るための、固定シードの擬似乱数（#113）。同じシードなら同じ列になる。暗号用ではない。
// 正規分布は一様乱数12個の和で近似する（足し算だけなので、どの環境でも同じ値になる。Math.log・Math.cos を使わない）

/** [0, 1) の一様な数を返す関数を作る（mulberry32）。seed は 32bit の整数に丸める */
export function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 平均0・標準偏差1に近い数（一様乱数12個の和から6を引く。範囲は -6〜6） */
export function normal(rand: () => number): number {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += rand();
  return sum - 6;
}

/** シードと名前（銘柄コードなど）から、別の列のシードを作る（名前で決まるので、会社を足しても並べ替えても他社の列は変わらない） */
export function subSeed(seed: number, name: string): number {
  let h = Math.imul(seed | 0, 0x9e3779b1) ^ 0x811c9dc5;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 0x01000193);
  return h | 0;
}
