// 試合の操作。すべてDBのトランザクションの中で、エンジンの純関数を呼んで結果を書く（ARCHITECTURE §9）。
import {
  acceptsOrders,
  clearCurrentRound,
  createMatch as createEngineMatch,
  displayPrices,
  fixedSheetPolicy,
  hashValue,
  lmsrCost,
  phaseAfter,
  settleMatch,
  teamAccountId,
  validateOrder,
  type InvestigationSourceId,
  type Progress,
  type Side,
  type Timing,
  type Trigger,
} from "@/engine";
import { Prisma } from "./db/generated/client";
import { prisma, type Tx } from "./db/client";
import { AppError, badRequest, conflict, notFound, unauthorized } from "./errors";
import { dbNow, loadEngineState, lockMatch, logEvent, saveAccounts, toProgress, type MatchRow } from "./repo";
import { getScenarioBundle } from "./scenarios";
import { hashToken, newJoinCode, newToken } from "./tokens";

const TX = { timeout: 15_000, maxWait: 10_000 } as const;

/** テストで「処理の途中で落ちる」を再現するための差し込み口。本番では使わない。 */
export const testHooks: { afterClearingWrites?: () => void } = {};

// ---------------------------------------------------------------- 作成と参加

export async function createMatch(opts: {
  scenarioId: string;
  k: number;
  mode?: "auto" | "manual";
  capacity?: number;
  timing?: Partial<Timing>;
}): Promise<{ matchId: string; joinCode: string; hostToken: string }> {
  const { scenario, sheet } = getScenarioBundle(opts.scenarioId, opts.k);
  const engine = createEngineMatch(scenario, sheet, []);
  const hostToken = newToken();
  const timing: Timing = { ...scenario.timing, ...opts.timing };
  for (let attempt = 0; attempt < 5; attempt++) {
    const joinCode = newJoinCode();
    try {
      const matchId = await prisma.$transaction(async (tx) => {
        const match = await tx.match.create({
          data: {
            joinCode,
            scenarioId: scenario.id,
            scenarioHash: hashValue(scenario),
            sheetHash: sheet.hash,
            algorithmVersion: sheet.algorithmVersion,
            kScale: sheet.k,
            phase: "LOBBY",
            mode: opts.mode ?? "auto",
            totalRounds: scenario.rounds.length,
            timing: timing as unknown as Prisma.InputJsonValue,
            q: engine.market.q,
            capacity: opts.capacity ?? 12,
            hostTokenHash: hashToken(hostToken),
          },
        });
        for (const a of Object.values(engine.accounts)) {
          await tx.account.create({
            data: {
              matchId: match.id,
              key: a.id,
              kind: a.kind,
              cash: a.cash,
              positions: {
                create: Object.entries(a.positions).map(([guildId, p]) => ({ guildId, qty: p.qty, costBasis: p.costBasis })),
              },
            },
          });
        }
        await logEvent(tx, match.id, "create", "host", { scenarioId: scenario.id, k: sheet.k, mmCash: Math.ceil(lmsrCost(engine.market)) });
        return match.id;
      }, TX);
      return { matchId, joinCode, hostToken };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") continue; // 参加コードの重複
      throw e;
    }
  }
  throw new Error("could not allocate a join code");
}

export async function findMatchByCode(code: string): Promise<{ matchId: string; phase: string } | null> {
  const m = await prisma.match.findUnique({ where: { joinCode: code }, select: { id: true, phase: true } });
  return m ? { matchId: m.id, phase: m.phase } : null;
}

export async function joinMatch(code: string, nickname: string): Promise<{ matchId: string; teamId: string; token: string }> {
  const token = newToken();
  return prisma.$transaction(async (tx) => {
    const found = await tx.match.findUnique({ where: { joinCode: code }, select: { id: true } });
    if (!found) throw notFound("match_not_found");
    const m = (await lockMatch(tx, found.id, "update"))!;
    if (m.phase !== "LOBBY") throw conflict("match_started");
    const count = await tx.team.count({ where: { matchId: m.id } });
    if (count >= m.capacity) throw conflict("match_full");
    const { scenario } = getScenarioBundle(m.scenario_id, m.k_scale);
    let team;
    try {
      team = await tx.team.create({ data: { matchId: m.id, nickname, tokenHash: hashToken(token) } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") throw conflict("nickname_taken");
      throw e;
    }
    await tx.account.create({
      data: {
        matchId: m.id,
        key: teamAccountId(team.id),
        kind: "player",
        teamId: team.id,
        cash: scenario.initialCash,
        positions: { create: scenario.guilds.map((g) => ({ guildId: g.id, qty: 0, costBasis: 0 })) },
      },
    });
    await tx.match.update({ where: { id: m.id }, data: { version: { increment: 1 } } });
    await logEvent(tx, m.id, "join", `team:${team.id}`, {});
    return { matchId: m.id, teamId: team.id, token };
  }, TX);
}

async function teamByToken(tx: Tx, matchId: string, token: string | undefined) {
  if (!token) throw unauthorized();
  const team = await tx.team.findUnique({ where: { tokenHash: hashToken(token) }, include: { account: true } });
  if (!team || team.matchId !== matchId || !team.account) throw unauthorized();
  return { team, account: team.account };
}

export function verifyHostToken(m: { host_token_hash: string }, token: string | undefined) {
  if (!token || hashToken(token) !== m.host_token_hash) throw unauthorized();
}

// ---------------------------------------------------------------- 注文

export interface OrderInput {
  side: Side;
  qty: number;
  baseRevision: number;
}

export interface OrderView {
  guildId: string;
  side: Side;
  qty: number;
  reserveCash: number;
  revision: number;
  status: "active" | "cancelled";
}

function assertOrderWindow(m: MatchRow, round: number, now: number) {
  const { scenario } = getScenarioBundle(m.scenario_id, m.k_scale);
  const timing = m.timing;
  if (m.round !== round || !acceptsOrders(toProgress(m), now, timing)) throw conflict("order_window_closed");
  return scenario;
}

/**
 * 予約の作成・変更（枠単位で冪等）。
 * baseRevision が今の版と同じなら更新する。1つ前で内容が同じなら、再送とみなして今の結果を返す。
 */
export async function putOrder(matchId: string, token: string | undefined, round: number, guildId: string, input: OrderInput): Promise<OrderView> {
  return prisma.$transaction(async (tx) => {
    const m = await lockMatch(tx, matchId, "share");
    if (!m) throw notFound();
    const now = await dbNow(tx);
    const scenario = assertOrderWindow(m, round, now);
    const { account } = await teamByToken(tx, matchId, token);
    await tx.$queryRaw`SELECT id FROM accounts WHERE id = ${account.id}::uuid FOR UPDATE`;

    const slot = { matchId, round, accountId: account.id, guildId };
    const existing = await tx.order.findUnique({ where: { matchId_round_accountId_guildId: slot } });
    const current = existing?.revision ?? 0;
    if (input.baseRevision !== current) {
      const isRetry =
        existing && input.baseRevision === current - 1 && existing.status === "active" && existing.side === input.side && existing.qty === input.qty;
      if (isRetry) return view(existing);
      throw conflict("stale_revision", { revision: current });
    }

    // 検証に要るのは自分の口座と自分の予約だけ（全口座は読まない）
    const positions = await tx.position.findMany({ where: { accountId: account.id } });
    const own = await tx.order.findMany({ where: { matchId, round, accountId: account.id, status: "active" } });
    const guilds = scenario.guilds.map((g) => g.id);
    const v = validateOrder({
      account: {
        id: account.key,
        kind: "player",
        cash: account.cash,
        positions: Object.fromEntries(positions.map((p) => [p.guildId, { qty: p.qty, costBasis: p.costBasis }])),
      },
      openOrders: own.map((o) => ({ accountId: account.key, kind: "player", guildId: o.guildId, side: o.side as Side, qty: o.qty, reserveCash: o.reserveCash })),
      intent: { guildId, side: input.side, qty: input.qty },
      prices: displayPrices({ guilds, b: getScenarioBundle(m.scenario_id, m.k_scale).sheet.b, q: m.q }),
      guilds,
      orderCap: scenario.orderCap,
    });
    if (!v.ok) throw new AppError(v.reason, 422);
    const data = { side: input.side, qty: input.qty, reserveCash: v.order.reserveCash, revision: current + 1, status: "active" };
    const saved = await tx.order.upsert({ where: { matchId_round_accountId_guildId: slot }, create: { ...slot, ...data }, update: data });
    await logEvent(tx, matchId, "order", account.key, { round, guildId, side: input.side, qty: input.qty, revision: saved.revision });
    return view(saved);
  }, TX);
}

export async function cancelOrder(matchId: string, token: string | undefined, round: number, guildId: string, baseRevision: number): Promise<OrderView> {
  return prisma.$transaction(async (tx) => {
    const m = await lockMatch(tx, matchId, "share");
    if (!m) throw notFound();
    assertOrderWindow(m, round, await dbNow(tx));
    const { account } = await teamByToken(tx, matchId, token);
    await tx.$queryRaw`SELECT id FROM accounts WHERE id = ${account.id}::uuid FOR UPDATE`;
    const slot = { matchId, round, accountId: account.id, guildId };
    const existing = await tx.order.findUnique({ where: { matchId_round_accountId_guildId: slot } });
    if (!existing) throw notFound("order_not_found");
    if (existing.status === "cancelled" && baseRevision === existing.revision - 1) return view(existing);
    if (baseRevision !== existing.revision) throw conflict("stale_revision", { revision: existing.revision });
    const saved = await tx.order.update({
      where: { matchId_round_accountId_guildId: slot },
      data: { status: "cancelled", revision: existing.revision + 1 },
    });
    await logEvent(tx, matchId, "cancel", account.key, { round, guildId, revision: saved.revision });
    return view(saved);
  }, TX);
}

function view(o: { guildId: string; side: string; qty: number; reserveCash: number; revision: number; status: string }): OrderView {
  return {
    guildId: o.guildId,
    side: o.side as Side,
    qty: o.qty,
    reserveCash: o.reserveCash,
    revision: o.revision,
    status: o.status as "active" | "cancelled",
  };
}

// ---------------------------------------------------------------- 調査券

export async function useInvestigation(matchId: string, token: string | undefined, source: InvestigationSourceId) {
  return prisma.$transaction(async (tx) => {
    const m = await lockMatch(tx, matchId, "share");
    if (!m) throw notFound();
    const scenario = assertOrderWindow(m, m.round, await dbNow(tx));
    const window = scenario.rounds[m.round - 1]?.investigationWindow;
    if (!window) throw conflict("no_investigation_window");
    const found = scenario.investigations[window].find((s) => s.id === source);
    if (!found) throw badRequest("unknown_source");
    const { team } = await teamByToken(tx, matchId, token);
    const inserted = await tx.$executeRaw`
      INSERT INTO investigations (match_id, team_id, round, source) VALUES (${matchId}::uuid, ${team.id}::uuid, ${m.round}, ${source})
      ON CONFLICT DO NOTHING`;
    if (inserted === 0) throw conflict("investigation_used");
    await logEvent(tx, matchId, "investigate", `team:${team.id}`, { round: m.round, source });
    return { round: m.round, source: found };
  }, TX);
}

// ---------------------------------------------------------------- 進行（締切処理と運営操作）

export type HostAction = "start" | "pause" | "resume" | "extend" | "close-now" | "next" | "abort";

const TRIGGER_OF: Record<HostAction, Trigger["type"]> = {
  start: "start",
  pause: "pause",
  resume: "resume",
  extend: "extend",
  "close-now": "closeNow",
  next: "next",
  abort: "abort",
};

export interface AdvanceResult {
  changed: boolean;
  phase: string;
  round: number;
  version: number;
}

/**
 * advanceIfDue と運営操作の共通処理。試合の行を FOR UPDATE でロックし、
 * 状態機械の遷移と、それに伴う清算・決算を同じトランザクションで行う。誰が何回呼んでも1回分しか反映されない。
 */
export async function advance(matchId: string, action: { kind: "tick" } | { kind: "host"; action: HostAction; token: string | undefined; ms?: number }): Promise<AdvanceResult> {
  return prisma.$transaction(async (tx) => {
    const m = await lockMatch(tx, matchId, "update");
    if (!m) throw notFound();
    if (action.kind === "host") verifyHostToken(m, action.token);
    const now = await dbNow(tx);
    const progress = toProgress(m);
    const trigger: Trigger =
      action.kind === "tick"
        ? { type: "tick", now }
        : action.action === "extend"
          ? { type: "extend", now, ms: action.ms ?? 0 }
          : ({ type: TRIGGER_OF[action.action], now } as Trigger);
    const t = phaseAfter(progress, trigger, m.timing);
    if (!t.ok) throw conflict("invalid_transition", { phase: m.phase });
    if (!t.changed) return { changed: false, phase: m.phase, round: m.round, version: m.version };

    let revealAt: Date | null | undefined;
    let settledAt: Date | undefined;
    for (const effect of t.effects) {
      if (effect === "clearRound") {
        await clearRoundInTx(tx, m);
        revealAt = new Date(now + m.timing.revealDelayMs);
      } else {
        await settleInTx(tx, m);
        settledAt = new Date(now);
      }
    }
    const next = t.progress;
    const updated = await tx.match.update({
      where: { id: m.id },
      data: {
        ...progressColumns(next),
        ...(revealAt !== undefined ? { revealAt } : {}),
        ...(settledAt ? { settledAt } : {}),
        version: { increment: 1 },
      },
    });
    await logEvent(tx, m.id, trigger.type, action.kind === "tick" ? "tick" : "host", {
      from: m.phase,
      to: next.phase,
      round: next.round,
    });
    return { changed: true, phase: updated.phase, round: updated.round, version: updated.version };
  }, TX);
}

function progressColumns(p: Progress) {
  return {
    phase: p.phase,
    round: p.round,
    mode: p.mode,
    phaseEndsAt: p.phaseEndsAt === null ? null : new Date(p.phaseEndsAt),
    pausedFrom: p.paused?.from ?? null,
    pausedRemainingMs: p.paused?.remainingMs ?? null,
  };
}

async function clearRoundInTx(tx: Tx, m: MatchRow) {
  const { sheet } = getScenarioBundle(m.scenario_id, m.k_scale);
  const { state, idByKey } = await loadEngineState(tx, m);
  const { match: next, record } = clearCurrentRound(state, fixedSheetPolicy(sheet));
  const r = record.result;
  await saveAccounts(tx, state.accounts, next.accounts, idByKey);
  await tx.fill.createMany({
    data: r.fills.map((f) => ({ matchId: m.id, round: m.round, accountKey: f.accountId, ...pickFill(f) })),
  });
  testHooks.afterClearingWrites?.();
  await tx.roundClearing.create({
    data: {
      matchId: m.id,
      round: m.round,
      algorithmVersion: r.algorithmVersion,
      pricesBefore: r.pricesBefore,
      prices: r.prices,
      qAfter: r.qAfter,
      stats: r.stats as unknown as Prisma.InputJsonValue,
      forecasts: record.forecasts as unknown as Prisma.InputJsonValue,
      inputHash: r.inputHash,
      outputHash: r.outputHash,
    },
  });
  await tx.match.update({ where: { id: m.id }, data: { q: r.qAfter } });
}

function pickFill(f: { kind: string; guildId: string; side: string; requested: number; filled: number; price: number; cashDelta: number; reason: string }) {
  return { kind: f.kind, guildId: f.guildId, side: f.side, requested: f.requested, filled: f.filled, price: f.price, cashDelta: f.cashDelta, reason: f.reason };
}

async function settleInTx(tx: Tx, m: MatchRow) {
  if (m.settled_at) return;
  const { scenario } = getScenarioBundle(m.scenario_id, m.k_scale);
  const { state, idByKey } = await loadEngineState(tx, m);
  const settled = settleMatch(state, scenario);
  await saveAccounts(tx, state.accounts, settled.accounts, idByKey);
  await logEvent(tx, m.id, "settle", "system", { winner: scenario.winner, payouts: settled.payouts });
}

