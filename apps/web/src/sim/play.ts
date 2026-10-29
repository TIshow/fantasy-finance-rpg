// エンジンを使って試合を最後まで回す補助。テストとシミュレータで共有する（本番の進行には使わない）。
import {
  checkInvariants,
  clearCurrentRound,
  createMatch,
  currentPrices,
  fixedSheetPolicy,
  investigate,
  placeOrder,
  playerAccount,
  settleMatch,
  type GuildMap,
  type InvestigationSourceId,
  type MatchState,
  type NpcPolicy,
  type NpcSheet,
  type OrderIntent,
  type Scenario,
} from "@/engine";

export interface DecideContext {
  round: number;
  teamId: string;
  prices: GuildMap<number>;
  match: MatchState;
}

export type Strategy = (ctx: DecideContext) => { orders: OrderIntent[]; investigate?: InvestigationSourceId };

export interface GameRun {
  match: MatchState;
  /** 各ラウンド清算後の表示価格。[0]は開始時 */
  prices: GuildMap<number>[];
  violations: string[];
  rejections: number;
}

export function playGame(args: {
  scenario: Scenario;
  sheet: NpcSheet;
  teamIds: string[];
  strategy: Strategy;
  policy?: NpcPolicy;
}): GameRun {
  const { scenario, sheet, teamIds, strategy } = args;
  const policy = args.policy ?? fixedSheetPolicy(sheet);
  let match = createMatch(scenario, sheet, teamIds);
  const prices = [currentPrices(match)];
  const violations: string[] = [];
  let rejections = 0;
  for (let round = 1; round <= match.totalRounds; round++) {
    for (const teamId of teamIds) {
      const decision = strategy({ round, teamId, prices: currentPrices(match), match });
      for (const intent of decision.orders) {
        const r = placeOrder(match, scenario, teamId, intent);
        if (r.ok) match = r.match;
        else rejections += 1;
      }
      if (decision.investigate) {
        const r = investigate(match, scenario, teamId, decision.investigate);
        if (r.ok) match = r.match;
      }
    }
    violations.push(...checkInvariants(match).map((e) => `R${round} before clearing: ${e}`));
    match = clearCurrentRound(match, policy).match;
    prices.push(currentPrices(match));
    violations.push(...checkInvariants(match).map((e) => `R${round} after clearing: ${e}`));
  }
  match = settleMatch(match, scenario);
  violations.push(...checkInvariants(match).map((e) => `after settlement: ${e}`));
  return { match, prices, violations, rejections };
}

export const holdStrategy: Strategy = () => ({ orders: [] });

/** シード付きの無作為な戦略。上限ぎりぎりや残高ぎりぎりの注文も混ぜる。 */
export function randomStrategy(rng: () => number, guilds: readonly string[], orderCap: number): Strategy {
  const sources: InvestigationSourceId[] = ["newspaper", "official", "ai"];
  return ({ teamId, match }) => {
    const account = playerAccount(match, teamId)!;
    const orders: OrderIntent[] = [];
    for (const g of guilds) {
      const roll = rng();
      if (roll < 0.45) continue;
      const held = account.positions[g]?.qty ?? 0;
      const sell = held > 0 && rng() < 0.4;
      const qty = rng() < 0.3 ? orderCap : 1 + Math.floor(rng() * orderCap);
      orders.push({ guildId: g, side: sell ? "sell" : "buy", qty: sell ? Math.min(held, qty) : qty });
    }
    return { orders, investigate: rng() < 0.3 ? sources[Math.floor(rng() * sources.length)] : undefined };
  };
}

/**
 * 山場への逆張り。全商会が beatRound で上限いっぱいに逆らう。
 * 上昇に逆らう（売る）ために、setupRound で同じ口数を買っておく。
 */
export function opposeBeat(args: {
  scenario: Scenario;
  sheet: NpcSheet;
  teams: number;
  guildId: string;
  beatRound: number;
  direction: "rise" | "fall";
  qty: number;
}): { before: number; after: number; baseBefore: number; baseAfter: number } {
  const { scenario, sheet, teams, guildId, beatRound, direction, qty } = args;
  const teamIds = Array.from({ length: teams }, (_, i) => `t${i + 1}`);
  const setupRound = 1;
  const strategy: Strategy = ({ round }) => {
    if (direction === "rise" && round === setupRound) return { orders: [{ guildId, side: "buy", qty }] };
    if (round === beatRound) return { orders: [{ guildId, side: direction === "rise" ? "sell" : "buy", qty }] };
    return { orders: [] };
  };
  const run = playGame({ scenario, sheet, teamIds, strategy });
  const base = playGame({ scenario, sheet, teamIds: [], strategy: holdStrategy });
  return {
    before: run.prices[beatRound - 1]![guildId]!,
    after: run.prices[beatRound]![guildId]!,
    baseBefore: base.prices[beatRound - 1]![guildId]!,
    baseAfter: base.prices[beatRound]![guildId]!,
  };
}
