// 本番DBにマイグレーションを当てる（docs/MEETING_MVP_SPEC.md §13）。
// .env.prod の DIRECT_URL（Supabaseのセッションモード、5432番）だけを使う。ほかの接続先には当てない。
import { execFileSync } from "node:child_process";

try {
  process.loadEnvFile(".env.prod");
} catch {
  console.error(".env.prod がありません。docs/MEETING_MVP_SPEC.md §13 の手順2で作ってください。");
  process.exit(1);
}
const direct = process.env.DIRECT_URL;
if (!direct) {
  console.error(".env.prod に DIRECT_URL（セッションモード、5432番）がありません。マイグレーションは中止しました。");
  process.exit(1);
}
const url = new URL(direct);
if (url.port === "6543") {
  console.error("DIRECT_URL が6543番（トランザクションモード）です。マイグレーションには5432番を使ってください。");
  process.exit(1);
}
console.log(`接続先: ${url.host}${url.pathname}`);
execFileSync("npx", ["prisma", "migrate", "deploy"], { env: { ...process.env, DATABASE_URL: direct }, stdio: "inherit" });
