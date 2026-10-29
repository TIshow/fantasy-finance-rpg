// MARKET_SPEC.md §5 の設計ルールA・Bの判定。テストとシミュレータで共有する。
import { generateNpcSheet, type NpcSheet, type Scenario } from "@/engine";
import { holdStrategy, opposeBeat, playGame } from "./play";

export interface Beat {
  round: number;
  direction: "rise" | "fall";
}

/** 参加者0人の価格で、上下に4G以上動くラウンドを山場とみなす */
export function findBeats(scenario: Scenario, sheet: NpcSheet, guildId: string): Beat[] {
  const base = playGame({ scenario, sheet, teamIds: [], strategy: holdStrategy }).prices;
  const beats: Beat[] = [];
  for (let r = 1; r < base.length; r++) {
    const d = base[r]![guildId]! - base[r - 1]![guildId]!;
    if (Math.abs(d) >= 4) beats.push({ round: r, direction: d > 0 ? "rise" : "fall" });
  }
  return beats;
}

export interface RuleReport {
  k: number;
  teams: number;
  qty: number;
  beats: { round: number; direction: "rise" | "fall"; base: string; opposed: string; retainedPct: number }[];
  ruleA: boolean;
  /** 1商会が上限いっぱいに買ったときの第1ラウンドの価格差 */
  ruleBDelta: number;
  ruleB: boolean;
}

/**
 * ルールA：全商会が上限いっぱいで山場に逆らっても、山場の値動きの半分以上が残る。
 *   残った割合 =（逆張り後の価格 − 基準の山場前の価格）÷（基準の値動き）
 * ルールB：1商会が上限いっぱいで買うと、表示価格が1G以上動く。
 */
export function evaluateRules(args: {
  scenario: Scenario;
  k: number;
  seed: number;
  teams: number;
  guildId: string;
  qty?: number;
}): RuleReport {
  const { scenario, k, seed, teams, guildId } = args;
  const qty = args.qty ?? scenario.orderCap;
  const sheet = generateNpcSheet(scenario, { k, seed });
  const beats = findBeats(scenario, sheet, guildId).map((beat) => {
    const r = opposeBeat({ scenario, sheet, teams, guildId, beatRound: beat.round, direction: beat.direction, qty });
    const retainedPct = Math.round((100 * (r.after - r.baseBefore)) / (r.baseAfter - r.baseBefore));
    return {
      round: beat.round,
      direction: beat.direction,
      base: `${r.baseBefore}→${r.baseAfter}`,
      opposed: `${r.before}→${r.after}`,
      retainedPct,
    };
  });
  const base = playGame({ scenario, sheet, teamIds: [], strategy: holdStrategy }).prices[1]![guildId]!;
  const one = playGame({
    scenario,
    sheet,
    teamIds: ["solo"],
    strategy: ({ round }) => ({ orders: round === 1 ? [{ guildId, side: "buy", qty }] : [] }),
  }).prices[1]![guildId]!;
  return {
    k,
    teams,
    qty,
    beats,
    ruleA: beats.every((b) => b.retainedPct >= 50),
    ruleBDelta: one - base,
    ruleB: one - base >= 1,
  };
}
