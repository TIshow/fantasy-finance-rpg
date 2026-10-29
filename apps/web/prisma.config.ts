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
  datasource: { url: process.env.DATABASE_URL },
});
