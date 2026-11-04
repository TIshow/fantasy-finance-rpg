// 完了前の境界検査：変更したファイルが、役の担当パスの中にあるかを確かめる。
// 使い方は scripts/check-boundaries.sh を参照。標準入力に、変更したパスを NUL 区切りで渡す。
// 判定は、書き込み前のフック（guard.ts）と同じ関数 judgeRel と、同じ正本 .claude/roles/paths.json を使う。
// 終了コード：0=担当内 / 1=担当外あり / 2=使い方や設定の誤り（役の綴り違いは通さない）
import { readFileSync, realpathSync } from "node:fs";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";
import { isKnownRole, judgeRel } from "./guard.ts";

/** 担当外の変更を「パス：理由」の一覧で返す。空なら担当内 */
export function checkFiles(role: string, files: string[]): string[] {
  return files.filter((f) => f !== "").flatMap((f) => {
    const rel = posix.normalize(f); // docs/../x のような抜け道を畳む（git の出力には出ないが、念のため）
    const why = rel === ".." || rel.startsWith("../") || posix.isAbsolute(rel) ? "リポジトリの外のパス" : judgeRel(role, rel);
    return why === null ? [] : [`${f}：${why}`];
  });
}

const here = fileURLToPath(import.meta.url);
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(here)) {
  try {
    const role = process.argv[2];
    if (role === undefined || role === "") {
      console.error("使い方：scripts/check-boundaries.sh <役> [基準ブランチ]");
      process.exit(2);
    }
    if (!isKnownRole(role)) {
      console.error(`知らない役：${role}（.claude/roles/paths.json の roles か readOnly にある名前を使う）`);
      process.exit(2);
    }
    const input = readFileSync(0, "utf8");
    // git -z の出力は、どの要素も NUL で終わる。改行区切りなどを 1 つのパスと取り違えて通さない
    if (input !== "" && !input.endsWith("\0")) {
      console.error("入力は NUL 区切りで渡す（scripts/check-boundaries.sh 経由で使う）");
      process.exit(2);
    }
    const files = input.split("\0");
    const bad = checkFiles(role, files);
    if (bad.length > 0) {
      console.error(`境界の違反（${role}）：担当外のファイルを変更している。`);
      for (const b of bad) console.error(`  - ${b}`);
      process.exit(1);
    }
    console.log(`境界の検査：違反なし（${role}、${files.filter((f) => f !== "").length}ファイル）`);
  } catch (e) {
    console.error(`境界の検査を実行できない（${e instanceof Error ? e.message : String(e)}）`);
    process.exit(2);
  }
}
