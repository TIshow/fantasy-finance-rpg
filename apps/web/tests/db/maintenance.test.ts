import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db/client";
import { checkDatabase, purgeMatches } from "@/server/maintenance";
import { forceAdvance, host, newMatch } from "./helpers";
import { putOrder, useInvestigation } from "@/server/service";
import { GET as health } from "@/app/api/health/route";

afterAll(async () => {
  await prisma.$disconnect();
});

describe("試合データの削除", () => {
  it("確認だけでは何も消さず、--yes 相当で古い試合とその関連データだけを消す", async () => {
    const old = await newMatch(1);
    await host(old.matchId, old.hostToken, "start");
    await forceAdvance(old.matchId);
    await putOrder(old.matchId, old.tokens[0], 1, "dragon", { side: "buy", qty: 1, baseRevision: 0 });
    await forceAdvance(old.matchId);
    for (let i = 0; i < 5; i++) await forceAdvance(old.matchId); // R3の受付（調査券の窓）
    await useInvestigation(old.matchId, old.tokens[0], "official");
    const oldAccounts = (await prisma.account.findMany({ where: { matchId: old.matchId }, select: { id: true } })).map((a) => a.id);
    const recent = await newMatch(1);
    await prisma.$executeRaw`UPDATE matches SET created_at = clock_timestamp() - interval '31 days' WHERE id = ${old.matchId}::uuid`;

    const dry = await purgeMatches({ olderThanDays: 30, dryRun: true });
    expect(dry.matches.map((m) => m.id)).toContain(old.matchId);
    expect(dry.matches.map((m) => m.id)).not.toContain(recent.matchId);
    expect(dry.deleted).toBe(0);
    expect(await prisma.match.count({ where: { id: old.matchId } })).toBe(1);

    const done = await purgeMatches({ olderThanDays: 30, dryRun: false });
    expect(done.deleted).toBeGreaterThanOrEqual(1);
    expect(await prisma.match.count({ where: { id: old.matchId } })).toBe(0);
    for (const count of [
      prisma.team.count({ where: { matchId: old.matchId } }),
      prisma.account.count({ where: { matchId: old.matchId } }),
      prisma.order.count({ where: { matchId: old.matchId } }),
      prisma.fill.count({ where: { matchId: old.matchId } }),
      prisma.roundClearing.count({ where: { matchId: old.matchId } }),
      prisma.matchEvent.count({ where: { matchId: old.matchId } }),
      prisma.investigation.count({ where: { matchId: old.matchId } }),
      prisma.position.count({ where: { accountId: { in: oldAccounts } } }),
    ]) {
      expect(await count).toBe(0);
    }
    expect(await prisma.match.count({ where: { id: recent.matchId } })).toBe(1);
  });

  it("作成から日数を過ぎていない試合は対象にしない", async () => {
    const m = await newMatch(1);
    await prisma.$executeRaw`UPDATE matches SET created_at = clock_timestamp() - interval '29 days 23 hours' WHERE id = ${m.matchId}::uuid`;
    expect((await purgeMatches({ olderThanDays: 30, dryRun: true })).matches.map((x) => x.id)).not.toContain(m.matchId);
    await prisma.$executeRaw`UPDATE matches SET created_at = clock_timestamp() - interval '30 days 1 minute' WHERE id = ${m.matchId}::uuid`;
    expect((await purgeMatches({ olderThanDays: 30, dryRun: true })).matches.map((x) => x.id)).toContain(m.matchId);
  });

  it("日数は1以上", async () => {
    await expect(purgeMatches({ olderThanDays: 0, dryRun: true })).rejects.toThrow();
  });

  it("DBにつながるかを返す。/api/health は真偽値だけを返す", async () => {
    expect(await checkDatabase()).toBe(true);
    const res = await health();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, db: true });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});
