import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

try {
  process.loadEnvFile(".env");
} catch {
  // .env が無い環境ではエンジンのテストだけを動かす
}

const alias = { "@": fileURLToPath(new URL("./src", import.meta.url)) };

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      { resolve: { alias }, test: { name: "engine", include: ["tests/engine/**/*.test.ts"] } },
      {
        resolve: { alias },
        test: {
          name: "db",
          include: ["tests/db/**/*.test.ts"],
          // テスト用のDBを使う。中身は globalSetup が毎回作り直す
          env: { DATABASE_URL: process.env.TEST_DATABASE_URL ?? "", DATABASE_POOL_MAX: "12" },
          globalSetup: ["tests/db/global-setup.ts"],
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
