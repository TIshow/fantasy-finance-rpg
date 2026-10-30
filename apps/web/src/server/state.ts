// 画面に返す状態。公開情報と本人だけの情報を分け、他の商会の予約や保有は誰にも返さない（ARCHITECTURE §10）。
import { displayPrices, teamAccountId, type Forecast, type GuildFlowStats, type GuildMap } from "@/engine";
import { Prisma } from "./db/generated/client";
import { prisma, type Tx } from "./db/client";
import { notFound, unauthorized } from "./errors";
import { dbNow, isRoundCleared, readMatch, toProgress } from "./repo";
import { getScenarioBundle } from "./scenarios";
import { hashToken, tokenMatches } from "./tokens";

export interface PublicState {
  matchId: string;
  joinCode: string;
  version: number;
  serverNow: number;
  phase: string;
  round: number;
  totalRounds: number;
  mode: string;
  phaseEndsAt: number | null;
  pausedFrom: string | null;
  pausedRemainingMs: number | null;
  graceMs: number;
  /** 各フェーズの長さ（残り時間のバーに使う） */
  durations: { NEWS: number; ORDER_OPEN: number; PUBLISHED: number };
  revealAt: number | null;
  teamCount: number;
  capacity: number;
  scenario: {
    title: string;
    guilds: { id: string; name: string; seal: string; project: string; color: string }[];
    orderCap: number;
    winner: string | null;
    rounds: { index: number; act: string; title: string }[];
  };
  /** 現在のラウンドの本文（ニュース以降） */
  news: { act: string; title: string; text: string; details: { label: string; text: string }[]; investigationWindow: number | null } | null;
  /** 現在の表示価格（公開時刻前は、まだ前回の価格） */
  prices: GuildMap<number>;
  /** 清算済みで公開待ちのときの公開時刻。新価格は公開時刻まで返さない */
  pendingReveal: { revealAt: number } | null;
  lastClearing: { round: number; pricesBefore: GuildMap<number>; prices: GuildMap<number>; stats: GuildMap<GuildFlowStats>; npcCount: number } | null;
  priceHistory: GuildMap<number>[];
  /** 決算後だけ：ラウンドごとの約定の純量（NPCと参加者を分ける。リプレイ用） */
  flowHistory: { round: number; npcNet: GuildMap<number>; playerNet: GuildMap<number> }[] | null;
  ranking: { nickname: string; assets: number; rank: number }[] | null;
}

export interface OwnState {
  teamId: string;
  nickname: string;
  cash: number;
  reserved: number;
  positions: GuildMap<{ qty: number; costBasis: number }>;
  orders: { guildId: string; side: string; qty: number; reserveCash: number; revision: number; status: string }[];
  /** 自分の約定。最後に清算したラウンドの分 */
  lastFills: { round: number; guildId: string; side: string; requested: number; filled: number; price: number; cashDelta: number; reason: string }[];
  allFills: { round: number; guildId: string; side: string; filled: number; price: number }[] | null;
  investigation: { round: number; source: string; name: string; result: string } | null;
  forecasts: { round: number; forecast: Forecast }[];
  assets: number;
}

/**
 * 公開状態と本人の状態を返す。読み取りは1つのスナップショット（REPEATABLE READ）で行う。
 * 別々に読むと、途中で清算が入ったときに清算前の試合と清算後の約定・現金が混ざり、公開時刻より前に結果が見えてしまう。
 */
export async function getState(matchId: string, token?: string): Promise<{ public: PublicState; own: OwnState | null }> {
  if (token) await touchTeam(matchId, token);
  return prisma.$transaction((tx) => readState(tx, matchId, token), {
    isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
  });
}

async function readState(tx: Tx, matchId: string, token: string | undefined): Promise<{ public: PublicState; own: OwnState | null }> {
  const m = await readMatch(tx, matchId);
  if (!m) throw notFound();
  const now = await dbNow(tx);
  const { scenario, sheet } = getScenarioBundle(m.scenario_id, m.k_scale);
  const guilds = scenario.guilds.map((g) => g.id);
  const current = displayPrices({ guilds, b: sheet.b, q: m.q });
  const clearings = await tx.roundClearing.findMany({ where: { matchId }, orderBy: { round: "asc" } });
  const last = clearings.at(-1) ?? null;
  const revealAt = m.reveal_at?.getTime() ?? null;
  const progress = toProgress(m);
  const finished = m.phase === "RESULT";
  // 公開時刻の前は、試合の段階によらず（中止や一時停止をしても）最後の清算の結果を隠す
  const hidden = last !== null && last.round === m.round && revealAt !== null && now < revealAt;

  const teams = await tx.team.findMany({
    where: { matchId },
    select: { id: true, nickname: true, account: { select: { cash: true, positions: { select: { guildId: true, qty: true } } } } },
  });
  const shownPrices = hidden ? (last!.pricesBefore as GuildMap<number>) : current;
  const cleared = isRoundCleared(m);
  // 途中順位は、一度でも公開したあとは常に見せる（公開時刻の前は、清算後の保有が漏れないよう隠す）
  const showRanking = !hidden && clearings.length > 0;
  const assetsOf = (t: (typeof teams)[number]) =>
    (t.account?.cash ?? 0) + (finished ? 0 : (t.account?.positions ?? []).reduce((s, p) => s + p.qty * (shownPrices[p.guildId] ?? 0), 0));
  const rows = teams.map((t) => ({ nickname: t.nickname, assets: assetsOf(t) })).sort((a, b) => b.assets - a.assets);
  const ranking = showRanking ? rows.map((r) => ({ ...r, rank: rows.findIndex((x) => x.assets === r.assets) + 1 })) : null;

  const round = scenario.rounds[m.round - 1];
  const history = [scenario.initialPrices, ...clearings.map((c) => c.prices as GuildMap<number>)];
  const pub: PublicState = {
    matchId,
    joinCode: m.join_code,
    version: m.version,
    serverNow: now,
    phase: m.phase,
    round: m.round,
    totalRounds: m.total_rounds,
    mode: m.mode,
    phaseEndsAt: progress.phaseEndsAt,
    pausedFrom: m.paused_from,
    pausedRemainingMs: m.paused_remaining_ms,
    graceMs: m.timing.graceMs,
    durations: { NEWS: m.timing.newsMs, ORDER_OPEN: m.timing.orderMs, PUBLISHED: m.timing.publishMs },
    revealAt,
    teamCount: teams.length,
    capacity: m.capacity,
    scenario: {
      title: scenario.title,
      guilds: scenario.guilds,
      orderCap: scenario.orderCap,
      winner: finished ? scenario.winner : null,
      rounds: scenario.rounds.map((r) => ({ index: r.index, act: r.act, title: r.title })),
    },
    news:
      round && m.phase !== "LOBBY"
        ? { act: round.act, title: round.title, text: round.news, details: round.details ?? [], investigationWindow: round.investigationWindow ?? null }
        : null,
    prices: shownPrices,
    pendingReveal: hidden ? { revealAt: revealAt! } : null,
    lastClearing:
      last && !hidden
        ? {
            round: last.round,
            pricesBefore: last.pricesBefore as GuildMap<number>,
            prices: last.prices as GuildMap<number>,
            stats: last.stats as unknown as GuildMap<GuildFlowStats>,
            npcCount: sheet.npcs.length,
          }
        : null,
    priceHistory: hidden ? history.slice(0, -1) : history,
    flowHistory: finished
      ? clearings.map((c) => {
          const st = c.stats as unknown as GuildMap<GuildFlowStats>;
          return {
            round: c.round,
            npcNet: Object.fromEntries(guilds.map((g) => [g, st[g]!.npcNet])),
            playerNet: Object.fromEntries(guilds.map((g) => [g, st[g]!.playerNet])),
          };
        })
      : null,
    ranking,
  };

  if (!token) return { public: pub, own: null };
  const team = await tx.team.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { account: { include: { positions: true } } },
  });
  if (!team || team.matchId !== matchId || !team.account) return { public: pub, own: null };
  const account = team.account;
  const orders = await tx.order.findMany({ where: { matchId, accountId: account.id, round: m.round }, orderBy: { guildId: "asc" } });
  const key = teamAccountId(team.id);
  const fills = await tx.fill.findMany({ where: { matchId, accountKey: key }, orderBy: [{ round: "asc" }, { guildId: "asc" }] });
  const lastRound = hidden ? (last?.round ?? 0) - 1 : (last?.round ?? 0);
  const inv = await tx.investigation.findUnique({ where: { matchId_teamId: { matchId, teamId: team.id } } });
  const invSource = inv
    ? scenario.investigations[scenario.rounds[inv.round - 1]!.investigationWindow!].find((s) => s.id === inv.source) ?? null
    : null;
  const positions = Object.fromEntries(account.positions.map((p) => [p.guildId, { qty: p.qty, costBasis: p.costBasis }]));
  const active = orders.filter((o) => o.status === "active");
  const forecasts = clearings
    .filter((c) => !hidden || c.round !== last?.round)
    .map((c) => ({ round: c.round, forecast: (c.forecasts as unknown as Record<string, Forecast>)[team.id]! }))
    .filter((f) => f.forecast);
  const own: OwnState = {
    teamId: team.id,
    nickname: team.nickname,
    // 公開時刻前は、清算前の現金と保有を見せる（新価格と一緒に一斉に変わるように）
    cash: hidden ? account.cash - fills.filter((f) => f.round === last!.round).reduce((s, f) => s + f.cashDelta, 0) : account.cash,
    reserved: cleared ? 0 : active.reduce((s, o) => s + o.reserveCash, 0),
    positions: hidden ? rollback(positions, fills.filter((f) => f.round === last!.round)) : positions,
    orders: orders.map((o) => ({ guildId: o.guildId, side: o.side, qty: o.qty, reserveCash: o.reserveCash, revision: o.revision, status: o.status })),
    lastFills: fills.filter((f) => f.round === lastRound).map((f) => ({ round: f.round, guildId: f.guildId, side: f.side, requested: f.requested, filled: f.filled, price: f.price, cashDelta: f.cashDelta, reason: f.reason })),
    allFills: finished ? fills.map((f) => ({ round: f.round, guildId: f.guildId, side: f.side, filled: f.filled, price: f.price })) : null,
    investigation: inv && invSource ? { round: inv.round, source: inv.source, name: invSource.name, result: invSource.result } : null,
    forecasts,
    assets: 0,
  };
  own.assets = own.cash + (finished ? 0 : Object.entries(own.positions).reduce((s, [g, p]) => s + p.qty * (shownPrices[g] ?? 0), 0));
  return { public: pub, own };
}

/** 公開時刻前に見せる保有（最後のラウンドの約定を戻す）。取得原価は表示に使わないのでそのまま。 */
function rollback(positions: GuildMap<{ qty: number; costBasis: number }>, fills: { guildId: string; side: string; filled: number }[]) {
  const out = structuredClone(positions);
  for (const f of fills) {
    const p = (out[f.guildId] ??= { qty: 0, costBasis: 0 });
    p.qty -= f.side === "buy" ? f.filled : -f.filled;
  }
  return out;
}

/** 最後に状態を取得した時刻を記録する（運営画面の接続状況）。書き込みは1チームにつき5秒に1回まで。 */
async function touchTeam(matchId: string, token: string): Promise<void> {
  await prisma.$executeRaw`UPDATE teams SET last_seen_at = clock_timestamp()
    WHERE token_hash = ${hashToken(token)} AND match_id = ${matchId}::uuid
      AND (last_seen_at IS NULL OR last_seen_at < clock_timestamp() - interval '5 seconds')`;
}

export interface HostStatus {
  teams: { nickname: string; secondsSinceSeen: number | null; ordersThisRound: number }[];
}

/** 運営画面だけに返す接続状況と、各商会の今のラウンドの予約数（内容は返さない）。 */
export async function getHostStatus(matchId: string, hostToken: string | undefined): Promise<HostStatus> {
  return prisma.$transaction(async (tx) => {
    const m = await readMatch(tx, matchId);
    if (!m) throw notFound();
    if (!tokenMatches(hostToken, m.host_token_hash)) throw unauthorized();
    const now = await dbNow(tx);
    const teams = await tx.team.findMany({ where: { matchId }, orderBy: { joinedAt: "asc" }, include: { account: { select: { id: true } } } });
    const counts = await tx.order.groupBy({ by: ["accountId"], where: { matchId, round: m.round, status: "active" }, _count: true });
    const byAccount = new Map(counts.map((c) => [c.accountId, c._count]));
    return {
      teams: teams.map((t) => ({
        nickname: t.nickname,
        secondsSinceSeen: t.lastSeenAt ? Math.max(0, Math.round((now - t.lastSeenAt.getTime()) / 1000)) : null,
        ordersThisRound: t.account ? (byAccount.get(t.account.id) ?? 0) : 0,
      })),
    };
  });
}
