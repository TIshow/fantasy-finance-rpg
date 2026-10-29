import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/client";

/**
 * Prisma 7 は driver adapter（node-postgres）が必須。接続URLはここで渡す（prisma.config.ts はCLI用）。
 * サーバーレスでは接続数を小さく保つ（kabu-leagueで本番の接続枯渇を経験済み）。
 */
function createPrismaClient() {
  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL,
    max: Number(process.env.DATABASE_POOL_MAX ?? 3),
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
  });
  return new PrismaClient({ adapter, log: ["error"] });
}

const globalForPrisma = globalThis as unknown as { prisma?: ReturnType<typeof createPrismaClient> };

export const prisma = globalForPrisma.prisma ?? createPrismaClient();
globalForPrisma.prisma = prisma;

export type Db = typeof prisma;
export type Tx = Parameters<Parameters<Db["$transaction"]>[0]>[0];
