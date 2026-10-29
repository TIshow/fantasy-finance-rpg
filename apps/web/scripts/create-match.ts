// 試合を作る（管理画面は作らない。ARCHITECTURE §9）。
// 使い方: npm run match:create -- [--fast] [--manual] [--base http://localhost:3000]
//   --fast   ニュース3秒・受付10秒・公開5秒の短縮版（内部テスト用）
import { createMatch } from "../src/server/service";
import { prisma } from "../src/server/db/client";

const args = process.argv.slice(2);
const baseAt = args.indexOf("--base");
const base = baseAt >= 0 && args[baseAt + 1] ? args[baseAt + 1]! : "http://localhost:3000";
const fast = args.includes("--fast");
const { matchId, joinCode, hostToken } = await createMatch({
  scenarioId: "s01-meeting-5r",
  k: 2,
  mode: args.includes("--manual") ? "manual" : "auto",
  timing: fast ? { newsMs: 3_000, orderMs: 10_000, publishMs: 5_000 } : undefined,
});
console.log(`参加コード: ${joinCode}`);
console.log(`参加者: ${base}/m/${joinCode}`);
console.log(`会場画面: ${base}/screen/${matchId}`);
// 運営用のトークンはURLの # 以降に置く（サーバーのログや参照元に残らない）
console.log(`運営: ${base}/host/${matchId}#${hostToken}`);
await prisma.$disconnect();
