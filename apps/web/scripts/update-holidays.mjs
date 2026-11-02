// 内閣府の祝日CSVから src/holidays/holidays.json を作る。
//   node scripts/update-holidays.mjs            取得して書き込む
//   node scripts/update-holidays.mjs --check    取得して、書き込まずに差があれば終了コード1
//   node scripts/update-holidays.mjs --file F   取得せず、手元のCSV（Shift_JIS）Fを使う
//   node scripts/update-holidays.mjs --allow-past-changes   過去の年の祝日が変わっても書き込む
// 終了コード：0 変更なし／書き込み済み、1 --check で差あり、2 取得・解釈・引数の失敗、3 過去の年が変わった
import { createHash } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { decodeShiftJis, parseHolidayCsv } from "../src/holidays/parse.ts";

const SOURCE = "https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv";
const FIRST_YEAR = 2020;
const OUT = new URL("../src/holidays/holidays.json", import.meta.url);

const fail = (message, code = 2) => {
  console.error(message);
  process.exit(code);
};

const args = process.argv.slice(2);
const check = args.includes("--check");
const allowPast = args.includes("--allow-past-changes");
const fileIdx = args.indexOf("--file");
const file = fileIdx >= 0 ? args[fileIdx + 1] : undefined;
if (fileIdx >= 0 && (!file || file.startsWith("--"))) fail("--file needs a path");

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

let holidays;
try {
  holidays = parseHolidayCsv(decodeShiftJis(bytes), FIRST_YEAR);
} catch (e) {
  fail(`failed to parse the CSV: ${e.message}`);
}

const years = new Map();
for (const h of holidays) {
  const y = h.date.slice(0, 4);
  years.set(y, [...(years.get(y) ?? []), [h.date, h.name]]);
}
const lastYear = Number([...years.keys()].at(-1));

// 1行に1つの祝日。差分を見やすくするため整形を固定する
const body = [...years]
  .map(([y, rows]) => `    "${y}": [\n${rows.map((r) => `      ${JSON.stringify(r)}`).join(",\n")}\n    ]`)
  .join(",\n");
const json = `{\n  "source": ${JSON.stringify(SOURCE)},\n  "sourceSha256": "${createHash("sha256").update(bytes).digest("hex")}",\n  "firstYear": ${FIRST_YEAR},\n  "lastYear": ${lastYear},\n  "years": {\n${body}\n  }\n}\n`;

let current = "";
try {
  current = readFileSync(OUT, "utf8");
} catch {}
if (current === json) {
  console.log("holidays.json is up to date");
  process.exit(0);
}

// 取得元が過去の年を直した（祝日が増減・移動した）ときは、台帳が使った版が変わるので、黙って上書きしない
const old = current ? JSON.parse(current) : undefined;
const changedYears = Object.entries(old?.years ?? {})
  .filter(([y, rows]) => Number(y) < old.lastYear && JSON.stringify(rows) !== JSON.stringify(years.get(y)))
  .map(([y]) => y);
const onlyHash = old && JSON.stringify(old.years) === JSON.stringify(Object.fromEntries(years));
if (onlyHash) console.log("only sourceSha256 differs (the holidays are the same)");
if (changedYears.length > 0) console.error(`past years changed: ${changedYears.join(", ")}`);

if (check) {
  console.error("holidays.json differs from the source; run `npm run holidays:update`");
  process.exit(1);
}
if (changedYears.length > 0 && !allowPast) fail("refusing to overwrite past years; review the diff and rerun with --allow-past-changes", 3);
// 途中で止まっても holidays.json が壊れないよう、一時ファイルに書いてから置き換える
const tmp = new URL("../src/holidays/holidays.json.tmp", import.meta.url);
writeFileSync(tmp, json);
renameSync(tmp, OUT);
console.log(`wrote holidays.json (${FIRST_YEAR}-${lastYear}, ${holidays.length} holidays)`);
