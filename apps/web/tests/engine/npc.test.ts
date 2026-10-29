import { describe, expect, it } from "vitest";
import { generateNpcSheet, verifySheetHash } from "@/engine";
import { scenario, sheet } from "./fixtures";

describe("NPCの注文表（D-026）", () => {
  it("保存済みの注文表は、同じシードの生成結果と一致し、ハッシュも正しい", () => {
    expect(generateNpcSheet(scenario, { k: sheet.k, seed: sheet.seed })).toEqual(sheet);
    expect(verifySheetHash(sheet)).toBe(true);
    expect(verifySheetHash({ ...sheet, seed: sheet.seed + 1 })).toBe(false);
  });

  it("100商会。1ラウンドに1商会1ギルド1注文", () => {
    expect(sheet.npcs).toHaveLength(100);
    expect(new Set(sheet.npcs.map((n) => n.key)).size).toBe(100);
    for (const orders of sheet.rounds) {
      const slots = orders.map((o) => `${o.npcKey}:${o.guildId}`);
      expect(new Set(slots).size).toBe(slots.length);
      expect(orders.every((o) => Number.isInteger(o.qty) && o.qty >= 1)).toBe(true);
    }
  });

  it("初期保有の合計は開始時のq。売りは自分の保有を超えない", () => {
    for (const g of scenario.guilds.map((x) => x.id)) {
      expect(sheet.npcs.reduce((s, n) => s + (n.positions[g] ?? 0), 0)).toBe(sheet.q0[g]);
    }
    for (const n of sheet.npcs) {
      const held = { ...n.positions };
      for (const orders of sheet.rounds) {
        for (const o of orders.filter((x) => x.npcKey === n.key)) {
          held[o.guildId] = (held[o.guildId] ?? 0) + (o.side === "buy" ? o.qty : -o.qty);
          expect(held[o.guildId]).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it("暴落ラウンドでは、ドラゴンを売る商会が買う商会より多い", () => {
    const r3 = sheet.rounds[2]!.filter((o) => o.guildId === "dragon");
    const sellers = r3.filter((o) => o.side === "sell").length;
    const buyers = r3.filter((o) => o.side === "buy").length;
    expect(sellers).toBeGreaterThan(buyers);
  });
});
