/**
 * 最大剰余法。各値を切り捨て、合計が total になるまで端数の大きい順に1ずつ足す。
 * 端数が同じときは配列の前から配る。
 */
export function largestRemainder(raw: readonly number[], total: number): number[] {
  const ints = raw.map((r) => Math.floor(r));
  const order = raw.map((r, i) => ({ i, f: r - Math.floor(r) })).sort((a, b) => b.f - a.f || a.i - b.i);
  const rest = total - ints.reduce((a, c) => a + c, 0);
  for (let j = 0; j < rest; j++) ints[order[j]!.i]! += 1;
  return ints;
}
