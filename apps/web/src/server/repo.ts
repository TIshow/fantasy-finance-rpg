// DBの行とエンジンの状態の変換。読み書きは呼び出し側のトランザクションの中で行う。
import {
  hashValue,
  type Accounts,
  type ActivePhase,
  type GuildMap,
  type MatchState,
  type Phase,
  type Progress,
  type ProgressMode,
  type RoundOrder,
  type Timing,
} from "@/engine";
import { Prisma } from "./db/generated/client";
import type { Tx } from "./db/client";
import { getScenarioBundle } from "./scenarios";

export interface MatchRow {
  id: string;
  join_code: string;
  scenario_id: string;
  scenario_hash: string;
  sheet_hash: string;
  algorithm_version: string;
  k_scale: number;
  phase: Phase;
  mode: ProgressMode;
  round: number;
  total_rounds: number;
  phase_ends_at: Date | null;
  paused_from: ActivePhase | null;
  paused_remaining_ms: number | null;
  reveal_at: Date | null;
  timing: Timing;
  q: GuildMap<number>;
  capacity: number;
  version: number;
  host_token_hash: string;
  settled_at: Date | null;
}

const COLUMNS = Prisma.raw(
  `id, join_code, scenario_id, scenario_hash, sheet_hash, algorithm_version, k_scale, phase, mode, round, total_rounds,
   phase_ends_at, paused_from, paused_remaining_ms, reveal_at, timing, q, capacity, version, host_token_hash, settled_at`,
);

/** 試合の行をロックして読む。注文は FOR SHARE、締切処理と運営操作は FOR UPDATE（ARCHITECTURE §9）。 */
export async function lockMatch(tx: Tx, matchId: string, mode: "share" | "update"): Promise<MatchRow | null> {
  const lock = mode === "share" ? Prisma.sql`FOR SHARE` : Prisma.sql`FOR UPDATE`;
  const rows = await tx.$queryRaw<MatchRow[]>`SELECT ${COLUMNS} FROM matches WHERE id = ${matchId}::uuid ${lock}`;
  return rows[0] ?? null;
}

export async function readMatch(tx: Tx, matchId: string): Promise<MatchRow | null> {
  const rows = await tx.$queryRaw<MatchRow[]>`SELECT ${COLUMNS} FROM matches WHERE id = ${matchId}::uuid`;
  return rows[0] ?? null;
}

/** 締切の判定はDBの時計で行う。ブラウザの時計は使わない。 */
export async function dbNow(tx: Tx): Promise<number> {
  const rows = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
  return rows[0]!.now.getTime();
}

export function toProgress(m: MatchRow): Progress {
  return {
    phase: m.phase,
    round: m.round,
    totalRounds: m.total_rounds,
    mode: m.mode,
    phaseEndsAt: m.phase_ends_at ? m.phase_ends_at.getTime() : null,
    paused: m.paused_from ? { from: m.paused_from, remainingMs: m.paused_remaining_ms ?? 0 } : null,
  };
}

export async function loadAccounts(tx: Tx, matchId: string): Promise<{ accounts: Accounts; idByKey: Map<string, string> }> {
  const rows = await tx.account.findMany({ where: { matchId }, include: { positions: true } });
  const accounts: Accounts = {};
  const idByKey = new Map<string, string>();
  for (const r of rows) {
    idByKey.set(r.key, r.id);
    accounts[r.key] = {
      id: r.key,
      kind: r.kind as "player" | "npc" | "mm",
      cash: r.cash,
      positions: Object.fromEntries(r.positions.map((p) => [p.guildId, { qty: p.qty, costBasis: p.costBasis }])),
    };
  }
  return { accounts, idByKey };
}

/** 進行中のラウンドの、有効なプレイヤー予約 */
export async function loadActiveOrders(tx: Tx, matchId: string, round: number): Promise<RoundOrder[]> {
  const rows = await tx.order.findMany({
    where: { matchId, round, status: "active" },
    include: { account: { select: { key: true } } },
  });
  return rows.map((o) => ({
    accountId: o.account.key,
    kind: "player",
    guildId: o.guildId,
    side: o.side as "buy" | "sell",
    qty: o.qty,
    reserveCash: o.reserveCash,
  }));
}

/** DBの内容からエンジンの試合状態を組み立てる。清算済みのラウンドは round を1つ進めて表す。 */
export async function loadEngineState(tx: Tx, m: MatchRow): Promise<{ state: MatchState; idByKey: Map<string, string> }> {
  const { scenario, sheet } = getScenarioBundle(m.scenario_id, m.k_scale);
  if (sheet.hash !== m.sheet_hash || hashValue(scenario) !== m.scenario_hash) {
    throw new Error("scenario or NPC sheet changed after the match was created");
  }
  const { accounts, idByKey } = await loadAccounts(tx, m.id);
  const teams = await tx.team.findMany({ where: { matchId: m.id }, select: { id: true }, orderBy: { joinedAt: "asc" } });
  const cleared = m.phase === "PUBLISHED" || m.phase === "RESULT" || (m.phase === "PAUSED" && m.paused_from === "PUBLISHED");
  const orders = cleared ? [] : await loadActiveOrders(tx, m.id, m.round);
  const state: MatchState = {
    scenarioId: m.scenario_id,
    scenarioHash: m.scenario_hash,
    sheetHash: m.sheet_hash,
    k: m.k_scale,
    market: { guilds: scenario.guilds.map((g) => g.id), b: sheet.b, q: m.q },
    accounts,
    teamIds: teams.map((t) => t.id),
    round: cleared ? m.round + 1 : Math.max(1, m.round),
    totalRounds: m.total_rounds,
    orders,
    history: [],
    investigations: {},
    initialTotalCash: Object.values(accounts).reduce((a, x) => a + x.cash, 0),
    settled: m.settled_at !== null,
    payouts: null,
  };
  return { state, idByKey };
}

/** 口座の現金と保有を、変わったものだけまとめて書き戻す。 */
export async function saveAccounts(tx: Tx, before: Accounts, after: Accounts, idByKey: Map<string, string>): Promise<void> {
  const cash: Prisma.Sql[] = [];
  const positions: Prisma.Sql[] = [];
  for (const [key, a] of Object.entries(after)) {
    const id = idByKey.get(key);
    if (!id) throw new Error(`account not in DB: ${key}`);
    const b = before[key];
    if (!b || b.cash !== a.cash) cash.push(Prisma.sql`(${id}::uuid, ${a.cash}::int)`);
    for (const [g, p] of Object.entries(a.positions)) {
      const old = b?.positions[g];
      if (!old || old.qty !== p.qty || old.costBasis !== p.costBasis) {
        positions.push(Prisma.sql`(${id}::uuid, ${g}, ${p.qty}::int, ${p.costBasis}::int)`);
      }
    }
  }
  if (cash.length > 0) {
    await tx.$executeRaw`UPDATE accounts SET cash = v.cash FROM (VALUES ${Prisma.join(cash)}) AS v(id, cash) WHERE accounts.id = v.id`;
  }
  if (positions.length > 0) {
    await tx.$executeRaw`INSERT INTO positions (account_id, guild_id, qty, cost_basis) VALUES ${Prisma.join(positions)}
      ON CONFLICT (account_id, guild_id) DO UPDATE SET qty = EXCLUDED.qty, cost_basis = EXCLUDED.cost_basis`;
  }
}

export async function logEvent(tx: Tx, matchId: string, type: string, actor: string, payload: Record<string, unknown>) {
  await tx.matchEvent.create({ data: { matchId, type, actor, payload: payload as Prisma.InputJsonValue } });
}
