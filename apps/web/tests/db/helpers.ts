import { prisma } from "@/server/db/client";
import { advance, createMatch, joinMatch } from "@/server/service";

export async function newMatch(teams: number, opts: { mode?: "auto" | "manual" } = {}) {
  const created = await createMatch({ scenarioId: "s01-meeting-5r", k: 2, mode: opts.mode });
  const tokens: string[] = [];
  const teamIds: string[] = [];
  for (let i = 0; i < teams; i++) {
    const j = await joinMatch(created.joinCode, `商会${i + 1}`);
    tokens.push(j.token);
    teamIds.push(j.teamId);
  }
  return { ...created, tokens, teamIds };
}

/** 締切（phase_ends_at）を、DBの時計から offsetMs だけずらした時刻にする。 */
export async function setDeadline(matchId: string, offsetMs: number) {
  await prisma.$executeRaw`UPDATE matches SET phase_ends_at = clock_timestamp() + make_interval(secs => ${offsetMs / 1000}::float8) WHERE id = ${matchId}::uuid`;
}

/** 今のフェーズを期限切れにして1段進める。 */
export async function forceAdvance(matchId: string) {
  const m = await prisma.match.findUniqueOrThrow({ where: { id: matchId } });
  const grace = (m.timing as { graceMs: number }).graceMs;
  await setDeadline(matchId, -(grace + 100));
  return advance(matchId, { kind: "tick" });
}

export async function host(matchId: string, hostToken: string, action: Parameters<typeof advance>[1] extends infer A ? (A extends { kind: "host"; action: infer X } ? X : never) : never) {
  return advance(matchId, { kind: "host", action, token: hostToken });
}

/** 台帳の不変条件をDBで確かめる。 */
export async function ledger(matchId: string) {
  const accounts = await prisma.account.findMany({ where: { matchId }, include: { positions: true } });
  const totalCash = accounts.reduce((s, a) => s + a.cash, 0);
  const byGuild: Record<string, number> = {};
  for (const a of accounts) for (const p of a.positions) byGuild[p.guildId] = (byGuild[p.guildId] ?? 0) + p.qty;
  const negative = accounts.filter((a) => a.kind !== "mm" && (a.cash < 0 || a.positions.some((p) => p.qty < 0)));
  return { totalCash, byGuild, negative: negative.length };
}
