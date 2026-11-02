// 内閣府の祝日CSVから src/holidays/holidays.json を作る。
//   node scripts/update-holidays.mjs            取得して書き込む
//   node scripts/update-holidays.mjs --check    取得して、書き込まずに差があれば終了コード1（今年までの祝日が変わっていれば3）
//   node scripts/update-holidays.mjs --file F --check   取得せず、手元のCSV（Shift_JIS）Fと比べる（--file は --check 専用）
//   node scripts/update-holidays.mjs --allow-past-changes   今年までの祝日が変わっても書き込む
// 終了コード：0 変更なし／書き込み済み、1 --check で差あり、2 取得・解釈・引数・読み書きの失敗、3 今年までの祝日が変わった
import { createHash } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { canonicalYears, changedPastYears, decodeShiftJis, groupByYear, parseHolidayCsv } from "../src/holidays/parse.ts";

const SOURCE = "https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv";
const FIRST_YEAR = 2020;
const OUT = new URL("../src/holidays/holidays.json", import.meta.url);
const sha256 = (x) => createHash("sha256").update(x).digest("hex");

const fail = (message, code = 2) => {
  console.error(message);
  process.exit(code);
};

const args = process.argv.slice(2);
const KNOWN = new Set(["--check", "--allow-past-changes", "--file"]);
const fileIdx = args.indexOf("--file");
const file = fileIdx >= 0 ? args[fileIdx + 1] : undefined;
if (fileIdx >= 0 && (!file || file.startsWith("--"))) fail("--file needs a path");
const unknown = args.filter((a, i) => !KNOWN.has(a) && (fileIdx < 0 || i !== fileIdx + 1));
if (unknown.length > 0) fail(`unknown arguments: ${unknown.join(" ")}`);
const check = args.includes("--check");
const allowPast = args.includes("--allow-past-changes");
// 手元のファイルから作った一覧を、公式の取得元のものとして書き込まない
if (file && !check) fail("--file can only be used with --check");

let bytes;
try {
  if (file) {
    bytes = new Uint8Array(readFileSync(file));
  } else {
    const res = await fetch(SOURCE, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) fail(`failed to fetch ${SOURCE}: ${res.status}`);
    bytes = new Uint8Array(await res.arrayBuffer());
  }
} catch (e) {
  fail(`failed to read the CSV: ${e.message}`);
}

let years;
try {
  years = groupByYear(parseHolidayCsv(decodeShiftJis(bytes), FIRST_YEAR));
} catch (e) {
  fail(`failed to parse the CSV: ${e.message}`);
}
const keys = Object.keys(years).sort();
const lastYear = Number(keys.at(-1));
const count = keys.reduce((n, y) => n + years[y].length, 0);

// 1行に1つの祝日。差分を見やすくするため整形を固定する
const body = keys.map((y) => `    "${y}": [\n${years[y].map((r) => `      ${JSON.stringify(r)}`).join(",\n")}\n    ]`).join(",\n");
const json = `{\n  "source": ${JSON.stringify(SOURCE)},\n  "sourceSha256": "${sha256(bytes)}",\n  "contentSha256": "${sha256(canonicalYears(years))}",\n  "firstYear": ${FIRST_YEAR},\n  "lastYear": ${lastYear},\n  "years": {\n${body}\n  }\n}\n`;

let current = "";
try {
  current = readFileSync(OUT, "utf8");
} catch (e) {
  if (e.code !== "ENOENT") fail(`failed to read holidays.json: ${e.message}`);
}
if (current === json) {
  console.log("holidays.json is up to date");
  process.exit(0);
}

let old;
try {
  old = current ? JSON.parse(current) : undefined;
} catch (e) {
  fail(`holidays.json is broken: ${e.message}`);
}
if (old && (typeof old.years !== "object" || old.years === null || Array.isArray(old.years))) fail("holidays.json is broken: years is missing");
// 取得元が今年までの祝日を直したときは、台帳が使った版が変わるので、黙って上書きしない
const thisYear = new Date(Date.now() + 9 * 3_600_000).getUTCFullYear();
const changedYears = changedPastYears(old?.years ?? {}, years, thisYear);
if (old && canonicalYears(old.years) === canonicalYears(years)) console.log("only sourceSha256 differs (the holidays are the same)");
if (changedYears.length > 0) console.error(`holidays through ${thisYear} changed: ${changedYears.join(", ")}`);

if (check) {
  console.error("holidays.json differs from the source; run `npm run holidays:update`");
  process.exit(changedYears.length > 0 ? 3 : 1);
}
if (changedYears.length > 0 && !allowPast) fail("refusing to overwrite past years; review the diff and rerun with --allow-past-changes", 3);
// 途中で止まっても holidays.json が壊れないよう、一時ファイルに書いてから置き換える
try {
  const tmp = new URL("../src/holidays/holidays.json.tmp", import.meta.url);
  writeFileSync(tmp, json);
  renameSync(tmp, OUT);
} catch (e) {
  fail(`failed to write holidays.json: ${e.message}`);
}
console.log(`wrote holidays.json (${FIRST_YEAR}-${lastYear}, ${count} holidays)`);
