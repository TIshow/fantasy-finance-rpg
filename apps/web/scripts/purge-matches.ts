// 古い試合データを消す（ARCHITECTURE §10。提案会議の試合は会議の30日後）。
// 使い方: npm run purge -- [--days 30] [--yes]
//   --yes を付けないと、対象の一覧を出すだけで何も消さない。本番は npm run purge:prod（.env.prod を読む）
import { prisma } from "../src/server/db/client";
import { purgeMatches } from "../src/server/maintenance";

/** 引数は --days <日数> と --yes だけ。書き間違い（--days=7 など）は既定値に落とさず止める */
function parseArgs(argv: string[]): { days: number; dryRun: boolean } {
  let days = 30;
  let dryRun = true;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--yes") dryRun = false;
    else if (a === "--days" && /^\d+$/.test(argv[i + 1] ?? "")) days = Number(argv[++i]);
    else throw new Error(`使えない引数です: ${a}（使えるのは --days <日数> と --yes）`);
  }
  return { days, dryRun };
}

const { days, dryRun } = parseArgs(process.argv.slice(2));
const host = new URL(process.env.DATABASE_URL ?? "postgresql://unknown").host;
const result = await purgeMatches({ olderThanDays: days, dryRun });
console.log(`接続先: ${host}`);
console.log(`作成から${days}日を過ぎた試合: ${result.matches.length}件`);
for (const m of result.matches) console.log(`- ${m.createdAt.toISOString()} 参加コード ${m.joinCode}`);
console.log(dryRun ? "確認だけです。消してよい試合だけが並んでいることを確かめてから、--yes を付けてください。" : `${result.deleted}件を削除しました。`);
await prisma.$disconnect();
