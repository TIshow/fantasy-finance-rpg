// 毎日の実行のコマンド（#30）。DATABASE_URL の保管に対して動く。
//   daily run [--date YYYY-MM-DD] [--wait]   その日の分を、済んでいない段から進める（同じ日を何度回しても二重にならない。同時に2つは動かない）
//   daily verify                                         記録だけから台帳を作り直して照合する
//   daily migrate                                        表を作る（DATABASE_ADMIN_URL。表の持ち主の接続。アプリの接続では流さない）
// 環境変数：DATABASE_URL（アプリの役割 ffr_app の接続）、DATABASE_SCHEMA（任意）、ALLOW_OWNER_ROLE=1（手元の試験だけ。
// 追記だけの権限の確認を飛ばす。GitHub Actions では無視して失敗にする）。接続の文字列は出力しない。
// 終了コード：0 成功、1 失敗、2 使い方の誤り、3 判断が締めに間に合わなかった（その日の全員の判断がなくなった）
import { stderr, stdout } from "node:process";
import { parseArgs } from "node:util";
import { cutoffOf, isValidDate } from "../src/ledger/ledger";
import { scheduleOf } from "../src/runner/day";
import { pgDb, pgDbFromEnv } from "../src/store/pg-db";
import { migrate } from "../src/store/sql";
import { jstDate, missedCutoff, runDaily, verifyDatabase } from "./daily-lib";

const USAGE = "usage: daily run [--date YYYY-MM-DD] [--wait] | daily verify | daily migrate";

class UsageError extends Error {}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clock = { now: () => Date.now() };

async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: { date: { type: "string" }, wait: { type: "boolean" } } });
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  const { positionals, values } = parsed;
  const [command] = positionals;
  if (command === "migrate") {
    const url = process.env.DATABASE_ADMIN_URL;
    if (!url) throw new Error("DATABASE_ADMIN_URL is not set");
    const db = pgDb({ connectionString: url, schema: process.env.DATABASE_SCHEMA || undefined });
    try {
      await migrate(db);
      stdout.write('{"migrated":true}\n');
      return 0;
    } finally {
      await db.close();
    }
  }
  if (command !== "run" && command !== "verify") {
    stderr.write(`${USAGE}\n`);
    return 2;
  }
  if (command === "run" && values.date !== undefined && !isValidDate(values.date)) throw new UsageError("--date must be a valid YYYY-MM-DD");
  // 追記だけの権限の確認を飛ばすのは手元の試験だけ。Actions で誤って設定されても、効かせない
  const skipRoleCheck = process.env.ALLOW_OWNER_ROLE === "1";
  if (skipRoleCheck && process.env.GITHUB_ACTIONS) throw new Error("ALLOW_OWNER_ROLE is not allowed in GitHub Actions");
  if (skipRoleCheck) stderr.write("daily: warning: the append-only role check is skipped (ALLOW_OWNER_ROLE=1)\n");
  const db = pgDbFromEnv();
  try {
    if (command === "verify") {
      stdout.write(`${JSON.stringify(await verifyDatabase(db))}\n`);
      return 0;
    }
    const date = values.date ?? jstDate(clock.now());
    // --wait：決まった時刻（判断・締め・引け）まで実際に待つ。GitHub Actions では使わない（待つ時間にも実行時間がかかる）
    const waitUntil = values.wait ? async (at: number) => void (at > clock.now() && (await sleep(at - clock.now()))) : undefined;
    const results = await runDaily(date, { db, clock, waitUntil, requireAppendOnlyRole: !skipRoleCheck });
    stdout.write(`${JSON.stringify({ date, cutoff: cutoffOf(date), schedule: scheduleOf(date), results })}\n`);
    return missedCutoff(results) ? 3 : 0;
  } finally {
    await db.close();
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    // 例外の文だけを出す（接続文字列を含む値は出さない）
    stderr.write(`daily: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(err instanceof UsageError ? 2 : 1);
  },
);
