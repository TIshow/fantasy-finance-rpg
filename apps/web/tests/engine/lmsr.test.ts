import { describe, expect, it } from "vitest";
import { displayPrices, lmsrCost, rawPrices, type Market } from "@/engine";
import { createRng } from "@/engine/rng";

const guilds = ["a", "b", "c", "d"] as const;

describe("表示価格", () => {
  it("どのqでも整数で合計100G、各1G以上", () => {
    const rng = createRng(1);
    for (let i = 0; i < 2000; i++) {
      const q = Object.fromEntries(guilds.map((g) => [g, Math.round((rng() - 0.5) * 3000)]));
      const prices = displayPrices({ guilds, b: 200, q });
      const values = Object.values(prices);
      expect(values.reduce((a, c) => a + c, 0)).toBe(100);
      expect(values.every((p) => Number.isInteger(p) && p >= 1)).toBe(true);
    }
  });

  it("端数が同じときはギルドの表示順で配る", () => {
    expect(displayPrices({ guilds, b: 100, q: { a: 0, b: 0, c: 0, d: 0 } })).toEqual({ a: 25, b: 25, c: 25, d: 25 });
    const three = displayPrices({ guilds: ["x", "y", "z"], b: 100, q: { x: 0, y: 0, z: 0 } });
    expect(three).toEqual({ x: 34, y: 33, z: 33 });
  });

  it("極端な偏りでも1G未満にしない", () => {
    expect(displayPrices({ guilds, b: 100, q: { a: 2000, b: 0, c: 0, d: 0 } })).toEqual({ a: 97, b: 1, c: 1, d: 1 });
  });
});

describe("LMSRのコスト関数", () => {
  it("凸なので、コスト差は新価格×口数の合計以下（市場係は損をしない）", () => {
    const rng = createRng(2);
    for (let i = 0; i < 1000; i++) {
      const q = Object.fromEntries(guilds.map((g) => [g, Math.round(rng() * 600)]));
      const delta = Object.fromEntries(guilds.map((g) => [g, Math.round((rng() - 0.5) * 300)]));
      const before: Market = { guilds, b: 200, q };
      const after: Market = { guilds, b: 200, q: Object.fromEntries(guilds.map((g) => [g, q[g]! + delta[g]!])) };
      const p = rawPrices(after);
      const receipts = guilds.reduce((s, g, j) => s + p[j]! * delta[g]!, 0);
      expect(lmsrCost(after) - lmsrCost(before)).toBeLessThanOrEqual(receipts + 1e-6);
    }
  });
});
