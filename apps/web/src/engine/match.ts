import { clearRound } from "./clearing";
import { MM_ACCOUNT_ID, PRICE_TOTAL } from "./constants";
import { deriveForecast, type Forecast } from "./forecast";
import { hashValue } from "./hash";
import { applyFills, settle, type Accounts } from "./ledger";
import { displayPrices, lmsrCost } from "./lmsr";
import { npcAccountId, type NpcPolicy, type NpcSheet } from "./npc";
import { validateOrder, type OrderRejection } from "./orders";
import type { InvestigationSource, InvestigationSourceId, Scenario } from "./scenario";
import type { Account, ClearingResult, GuildId, GuildMap, Market, OrderIntent, RoundOrder } from "./types";

export const teamAccountId = (teamId: string) => `team:${teamId}`;

export interface RoundRecord {
  round: number;
  result: ClearingResult;
  forecasts: Record<string, Forecast>;
}

/**
 * 1試合の状態。DBに保存する値と同じ形にしてあり、サーバーと一人版が同じ関数で進める。
 * 進行（フェーズと時刻）は phase.ts が扱い、ここは市場と台帳だけを扱う。
 */
export interface MatchState {
  scenarioId: string;
  scenarioHash: string;
  sheetHash: string;
  k: number;
  market: Market;
  accounts: Accounts;
  teamIds: string[];
  /** 進行中のラウンド（1から）。決算後は totalRounds + 1 */
  round: number;
  totalRounds: number;
  /** 進行中のラウンドの、プレイヤーの予約 */
  orders: RoundOrder[];
  history: RoundRecord[];
  investigations: Record<string, { round: number; source: InvestigationSourceId }>;
  initialTotalCash: number;
  settled: boolean;
  payouts: Record<string, number> | null;
}

function emptyPositions(guilds: readonly GuildId[]) {
  return Object.fromEntries(guilds.map((g) => [g, { qty: 0, costBasis: 0 }]));
}

export function createMatch(scenario: Scenario, sheet: NpcSheet, teamIds: readonly string[]): MatchState {
  if (sheet.scenarioId !== scenario.id || sheet.scenarioVersion !== scenario.version) {
    throw new Error("NPC sheet does not belong to this scenario version");
  }
  if (new Set(teamIds).size !== teamIds.length) throw new Error("team ids must be unique");
  const guilds = scenario.guilds.map((g) => g.id);
  const market: Market = { guilds, b: sheet.b, q: { ...sheet.q0 } };
  const accounts: Accounts = {};
  for (const id of teamIds) {
    const accountId = teamAccountId(id);
    accounts[accountId] = { id: accountId, kind: "player", cash: scenario.initialCash, positions: emptyPositions(guilds) };
  }
  for (const npc of sheet.npcs) {
    const id = npcAccountId(npc.key);
    accounts[id] = {
      id,
      kind: "npc",
      cash: npc.cash,
      positions: Object.fromEntries(guilds.map((g) => [g, { qty: npc.positions[g] ?? 0, costBasis: 0 }])),
    };
  }
  // 市場係の開始資金 C(q0)。発行済みの成功証（NPCの初期保有）は市場係の売り持ちになる
  accounts[MM_ACCOUNT_ID] = {
    id: MM_ACCOUNT_ID,
    kind: "mm",
    cash: Math.ceil(lmsrCost(market)),
    positions: Object.fromEntries(guilds.map((g) => [g, { qty: -(sheet.q0[g] ?? 0), costBasis: 0 }])),
  };
  return {
    scenarioId: scenario.id,
    scenarioHash: hashValue(scenario),
    sheetHash: sheet.hash,
    k: sheet.k,
    market,
    accounts,
    teamIds: [...teamIds],
    round: 1,
    totalRounds: scenario.rounds.length,
    orders: [],
    history: [],
    investigations: {},
    initialTotalCash: Object.values(accounts).reduce((a, x) => a + x.cash, 0),
    settled: false,
    payouts: null,
  };
}

export function currentPrices(match: MatchState): GuildMap<number> {
  return displayPrices(match.market);
}

export type PlaceOrderResult = { ok: true; match: MatchState; order: RoundOrder } | { ok: false; reason: OrderRejection | "settled" | "unknown_team" };

/** 予約（同じギルドの枠は置き換え）。受付中かどうかは phase.ts の acceptsOrders で先に確かめる。 */
export function placeOrder(match: MatchState, scenario: Scenario, teamId: string, intent: OrderIntent): PlaceOrderResult {
  if (match.settled) return { ok: false, reason: "settled" };
  const account = match.accounts[teamAccountId(teamId)];
  if (!account) return { ok: false, reason: "unknown_team" };
  const v = validateOrder({
    account,
    openOrders: match.orders,
    intent,
    prices: currentPrices(match),
    guilds: match.market.guilds,
    orderCap: scenario.orderCap,
  });
  if (!v.ok) return v;
  const orders = match.orders.filter((o) => !(o.accountId === account.id && o.guildId === intent.guildId));
  return { ok: true, match: { ...match, orders: [...orders, v.order] }, order: v.order };
}

export function cancelOrder(match: MatchState, teamId: string, guildId: GuildId): MatchState {
  const id = teamAccountId(teamId);
  return { ...match, orders: match.orders.filter((o) => !(o.accountId === id && o.guildId === guildId)) };
}

/** 締切の清算。プレイヤーの予約とNPCの注文を同じ計算に通し、台帳と予測を更新する。 */
export function clearCurrentRound(match: MatchState, policy: NpcPolicy): { match: MatchState; record: RoundRecord } {
  if (match.settled || match.round > match.totalRounds) throw new Error("no round to clear");
  const result = clearRound({ market: match.market, orders: [...match.orders, ...policy.ordersForRound(match.round)] });
  const accounts = applyFills(match.accounts, result.fills);
  const forecasts = Object.fromEntries(
    match.teamIds.map((t) => [t, deriveForecast(accounts[teamAccountId(t)]!, match.market.guilds)]),
  );
  const record: RoundRecord = { round: match.round, result, forecasts };
  return {
    match: {
      ...match,
      market: { ...match.market, q: result.qAfter },
      accounts,
      round: match.round + 1,
      orders: [],
      history: [...match.history, record],
    },
    record,
  };
}

export type InvestigateResult = { ok: true; match: MatchState; source: InvestigationSource } | { ok: false; reason: "no_window" | "already_used" | "unknown_source" | "unknown_team" };

/** 調査券はゲーム中1回だけ。窓のあるラウンドの注文受付中に使う（D-020）。 */
export function investigate(match: MatchState, scenario: Scenario, teamId: string, sourceId: InvestigationSourceId): InvestigateResult {
  if (!match.teamIds.includes(teamId)) return { ok: false, reason: "unknown_team" };
  if (match.investigations[teamId]) return { ok: false, reason: "already_used" };
  const window = scenario.rounds[match.round - 1]?.investigationWindow;
  if (!window) return { ok: false, reason: "no_window" };
  const source = scenario.investigations[window].find((s) => s.id === sourceId);
  if (!source) return { ok: false, reason: "unknown_source" };
  return {
    ok: true,
    match: { ...match, investigations: { ...match.investigations, [teamId]: { round: match.round, source: sourceId } } },
    source,
  };
}

export function settleMatch(match: MatchState, scenario: Scenario): MatchState {
  if (match.settled) return match;
  if (match.round <= match.totalRounds) throw new Error("all rounds must be cleared before settlement");
  const { accounts, payouts } = settle(match.accounts, scenario.winner);
  return { ...match, accounts, settled: true, payouts };
}

/** 最終資産の順位（同額は同順位）。 */
export function ranking(match: MatchState): { teamId: string; assets: number; rank: number }[] {
  const prices = currentPrices(match);
  const rows = match.teamIds.map((t) => {
    const a = match.accounts[teamAccountId(t)]!;
    const held = match.settled ? 0 : Object.entries(a.positions).reduce((s, [g, p]) => s + p.qty * prices[g]!, 0);
    return { teamId: t, assets: a.cash + held };
  });
  rows.sort((x, y) => y.assets - x.assets || (x.teamId < y.teamId ? -1 : 1));
  return rows.map((r) => ({ ...r, rank: rows.findIndex((x) => x.assets === r.assets) + 1 }));
}

/** MARKET_SPEC.md §7 の不変条件のうち、状態から確かめられるもの。違反の説明を返す。 */
export function checkInvariants(match: MatchState): string[] {
  const errors: string[] = [];
  const accounts = Object.values(match.accounts);
  const totalCash = accounts.reduce((a, x) => a + x.cash, 0);
  if (totalCash !== match.initialTotalCash) errors.push(`total cash changed: ${totalCash} != ${match.initialTotalCash}`);
  for (const a of accounts) {
    if (a.kind !== "mm" && a.cash < 0) errors.push(`negative cash: ${a.id}`);
    if (a.kind === "mm" && match.settled && a.cash < 0) errors.push(`market maker cash is negative after settlement: ${a.cash}`);
    for (const [g, p] of Object.entries(a.positions)) {
      if (a.kind !== "mm" && p.qty < 0) errors.push(`negative holdings: ${a.id} ${g}`);
    }
  }
  const reserved: Record<string, number> = {};
  for (const o of match.orders) reserved[o.accountId] = (reserved[o.accountId] ?? 0) + o.reserveCash;
  for (const [id, r] of Object.entries(reserved)) {
    if ((match.accounts[id]?.cash ?? 0) < r) errors.push(`reserve exceeds cash: ${id}`);
  }
  for (const g of match.market.guilds) {
    const sum = accounts.reduce((s, a) => s + (a.positions[g]?.qty ?? 0), 0);
    if (sum !== 0) errors.push(`holdings do not net to zero: ${g} ${sum}`);
  }
  const prices = currentPrices(match);
  const priceSum = Object.values(prices).reduce((a, c) => a + c, 0);
  if (priceSum !== PRICE_TOTAL) errors.push(`price sum is ${priceSum}`);
  if (Object.values(prices).some((p) => !Number.isInteger(p) || p < 1)) errors.push("price below 1G or not an integer");
  return errors;
}

export function playerAccount(match: MatchState, teamId: string): Account | undefined {
  return match.accounts[teamAccountId(teamId)];
}

