import { describe, expect, it } from "vitest";
import { adjustCloses } from "../../src/runner/adjust";

const closes = [
  { seq: 1, date: "2026-11-09", prices: { TSTA: 1000, TSTB: 501, TSTC: null } },
  { seq: 2, date: "2026-11-10", prices: { TSTA: 1010, TSTB: 503, TSTC: 300 } },
  { seq: 3, date: "2026-11-11", prices: { TSTA: 505, TSTB: 170, TSTC: 301 } },
];

describe("adjustCloses（分割で調整した終値の列）", () => {
  it("権利落ち日より前の値だけを from/to 倍にし（0.1円未満は四捨五入）、ほかの銘柄と値がない日はそのまま", () => {
    const out = adjustCloses(closes, [{ seq: 9, symbol: "TSTA", exDate: "2026-11-11", from: 1, to: 2 }]);
    expect(out.map((c) => c.prices.TSTA)).toEqual([500, 505, 505]);
    expect(out.map((c) => c.prices.TSTB)).toEqual([501, 503, 170]);
    expect(out[0]!.prices.TSTC).toBeNull();
    expect(out.map((c) => [c.seq, c.date])).toEqual(closes.map((c) => [c.seq, c.date]));
  });

  it("複数の分割は権利落ち日・seq の順に1つずつ当てる。並べる順を変えても同じ列になり、元の列は変えない", () => {
    const a = { seq: 8, symbol: "TSTB", exDate: "2026-11-10", from: 1, to: 3 };
    const b = { seq: 9, symbol: "TSTB", exDate: "2026-11-11", from: 1, to: 3 };
    const out = adjustCloses(closes, [b, a]);
    expect(out.map((c) => c.prices.TSTB)).toEqual([Math.round(Math.round(501 / 3) / 3), Math.round(503 / 3), 170]);
    expect(adjustCloses(closes, [a, b])).toEqual(out);
    expect(closes[0]!.prices.TSTB).toBe(501);
  });

  it("権利落ち日が列より後の分割、併合（from > to）も同じ式で扱う", () => {
    expect(adjustCloses(closes, [{ seq: 9, symbol: "TSTA", exDate: "2026-11-12", from: 1, to: 2 }]).map((c) => c.prices.TSTA)).toEqual([500, 505, 253]);
    expect(adjustCloses(closes, [{ seq: 9, symbol: "TSTC", exDate: "2026-11-11", from: 2, to: 1 }]).map((c) => c.prices.TSTC)).toEqual([null, 600, 301]);
  });
});
