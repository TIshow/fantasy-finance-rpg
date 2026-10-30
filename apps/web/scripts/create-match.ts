// 試合を作る（管理画面は作らない。ARCHITECTURE §9）。
// 使い方: npm run match:create -- [--fast | --e2e] [--manual] [--base http://localhost:3000] [--json]
//   --fast   ニュース3秒・受付10秒・公開5秒の短縮版（内部テスト用）
//   --e2e    ニュース2秒・受付8秒・公開4秒（E2Eテスト用）
//   --json   結果をJSONで出す（運営用のトークンを含むので、ログに残さないこと）
import { createMatch } from "../src/server/service";
import { prisma } from "../src/server/db/client";

const args = process.argv.slice(2);
const baseAt = args.indexOf("--base");
const base = baseAt >= 0 && args[baseAt + 1] ? args[baseAt + 1]! : "http://localhost:3000";
const timing = args.includes("--e2e")
  ? { newsMs: 2_000, orderMs: 8_000, publishMs: 4_000, revealDelayMs: 1_500 }
  : args.includes("--fast")
    ? { newsMs: 3_000, orderMs: 10_000, publishMs: 5_000 }
    : undefined;
const { matchId, joinCode, hostToken } = await createMatch({
  scenarioId: "s01-meeting-5r",
  k: 2,
  mode: args.includes("--manual") ? "manual" : "auto",
  timing,
});
const urls = {
  participant: `${base}/m/${joinCode}`,
  screen: `${base}/screen/${matchId}`,
  // 運営用のトークンはURLの # 以降に置く（サーバーのログや参照元に残らない）
  host: `${base}/host/${matchId}#${hostToken}`,
};
if (args.includes("--json")) {
  console.log(JSON.stringify({ matchId, joinCode, ...urls }));
} else {
  console.log(`参加コード: ${joinCode}`);
  console.log(`参加者: ${urls.participant}`);
  console.log(`会場画面: ${urls.screen}`);
  console.log(`運営: ${urls.host}`);
}
await prisma.$disconnect();
