import { execFileSync } from "node:child_process";
import pg from "pg";

/** テスト用DBのスキーマを空にして、マイグレーションを当て直す。 */
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is not set (copy .env.example to .env and run `npm run db:up`)");
  if (!/_test(\?|$)/.test(url)) throw new Error("TEST_DATABASE_URL must point to a *_test database");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
  await client.end();
  execFileSync("npx", ["prisma", "migrate", "deploy"], { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });
}
