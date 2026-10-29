import { defineConfig } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3210);

/** E2E：本番ビルドを起動し、ローカルのDB（.env の DATABASE_URL）で通しの試合を行う。 */
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 240_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: `http://localhost:${PORT}`, trace: "retain-on-failure" },
  webServer: {
    command: `npx next build && npx next start -p ${PORT}`,
    url: `http://localhost:${PORT}`,
    timeout: 240_000,
    reuseExistingServer: false,
  },
});
