import { defineConfig } from "prisma/config";

// Prisma 7 は prisma.config.ts があると .env を自動では読まないので、Node 24 の loadEnvFile で読む。
try {
  process.loadEnvFile(".env");
} catch {
  // .env が無い環境では無視する
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  // CLIは常に DATABASE_URL を見る（テスト用DBへの上書きが効くように、ほかの変数は見ない）。
  // 本番のマイグレーションは scripts/db-deploy-prod.ts が、.env.prod の DIRECT_URL（5432番）を DATABASE_URL として渡す。
  datasource: { url: process.env.DATABASE_URL },
});
