// NPCの注文表を生成して保存する（開発時だけ使う。D-026）。
// 使い方: npm run npc:generate -- [k] [seed]
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { generateNpcSheet } from "../src/engine/npc";
import { scenarioS01 } from "../src/scenarios/s01/scenario";

const k = Number(process.argv[2] ?? 2);
const seed = Number(process.argv[3] ?? 20261029);
const sheet = generateNpcSheet(scenarioS01, { k, seed });
const out = fileURLToPath(new URL(`../src/scenarios/s01/npc-sheet.k${k}.json`, import.meta.url));
writeFileSync(out, `${JSON.stringify(sheet, null, 2)}\n`);
console.log(`wrote ${out} (hash ${sheet.hash}, ${sheet.rounds.flat().length} orders)`);
