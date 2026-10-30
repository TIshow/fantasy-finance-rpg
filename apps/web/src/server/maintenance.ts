// 運用の処理。試合データは会議の30日後に削除する（ARCHITECTURE §10）。
import { prisma } from "./db/client";

export interface PurgeResult {
  matches: { id: string; joinCode: string; createdAt: Date }[];
  deleted: number;
}

/**
 * 作成から olderThanDays 日を過ぎた試合を消す。チーム、口座、注文、約定、ログは外部キーでまとめて消える。
 * dryRun のときは対象を返すだけで、何も消さない。
 */
export async function purgeMatches(opts: { olderThanDays: number; dryRun: boolean }): Promise<PurgeResult> {
  if (!Number.isFinite(opts.olderThanDays) || opts.olderThanDays < 1) throw new Error("olderThanDays must be at least 1");
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string; join_code: string; created_at: Date }[]>`
      SELECT id, join_code, created_at FROM matches
      WHERE created_at < clock_timestamp() - make_interval(days => ${Math.floor(opts.olderThanDays)}::int)
      ORDER BY created_at`;
    const matches = rows.map((r) => ({ id: r.id, joinCode: r.join_code, createdAt: r.created_at }));
    if (opts.dryRun || matches.length === 0) return { matches, deleted: 0 };
    const { count } = await tx.match.deleteMany({ where: { id: { in: matches.map((m) => m.id) } } });
    return { matches, deleted: count };
  });
}

/** DBにつながるか（当日の朝の確認とリハーサル用） */
export async function checkDatabase(): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ ok: number }[]>`SELECT 1 AS ok`;
  return rows[0]?.ok === 1;
}
