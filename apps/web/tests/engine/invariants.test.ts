import { describe, expect, it } from "vitest";
import { generateNpcSheet } from "@/engine";
import { createRng } from "@/engine/rng";
import { playGame, randomStrategy } from "@/sim/play";
import { evaluateRules } from "@/sim/rules";
import { guilds, scenario, sheet, teams } from "./fixtures";

describe("無作為な戦略でも不変条件を保つ", () => {
  // 1万試合は `npm run simulate` で確かめる。テストでは数を絞る
  it("k=2、6商会で300試合", () => {
    for (let i = 0; i < 300; i++) {
      const run = playGame({
        scenario,
        sheet,
        teamIds: teams(6),
        strategy: randomStrategy(createRng(1000 + i), guilds, scenario.orderCap),
      });
      expect(run.violations, `game ${i}`).toEqual([]);
      expect(run.match.accounts.mm!.cash).toBeGreaterThanOrEqual(0);
    }
  });

  it("k=1、12商会（会議の定員）でも保つ", () => {
    const k1 = generateNpcSheet(scenario, { k: 1, seed: sheet.seed });
    for (let i = 0; i < 100; i++) {
      const run = playGame({
        scenario,
        sheet: k1,
        teamIds: teams(12),
        strategy: randomStrategy(createRng(5000 + i), guilds, scenario.orderCap),
      });
      expect(run.violations, `game ${i}`).toEqual([]);
    }
  });
});

describe("設計ルール（MARKET_SPEC §5）", () => {
  it("会議の初期値 k=2、6商会、上限10口でルールAとBを満たす", () => {
    const r = evaluateRules({ scenario, k: 2, seed: sheet.seed, teams: 6, guildId: "dragon" });
    expect(r.beats.map((b) => b.round)).toEqual([2, 3, 5]);
    expect(r.ruleA).toBe(true);
    expect(r.ruleB).toBe(true);
  });

  it("どのkでも参加者0人の価格は同じ", () => {
    for (const k of [1, 2, 3]) {
      const s = generateNpcSheet(scenario, { k, seed: sheet.seed });
      const run = playGame({ scenario, sheet: s, teamIds: [], strategy: () => ({ orders: [] }) });
      expect(run.prices.slice(1)).toEqual(scenario.targetPrices);
    }
  });
});
