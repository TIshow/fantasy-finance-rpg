// 市場のシミュレータ。kと上限の確認、無作為な戦略での不変条件の確認を行う。
// 使い方: npm run simulate -- [games=10000] [teams=6]
import { generateNpcSheet, hashValue, PAYOUT_PER_SHARE } from "../src/engine";
import { createRng } from "../src/engine/rng";
import { holdStrategy, playGame, randomStrategy } from "../src/sim/play";
import { evaluateRules } from "../src/sim/rules";
import { scenarioS01 as scenario } from "../src/scenarios/s01/scenario";
import sheetK2 from "../src/scenarios/s01/npc-sheet.k2.json";

const games = Number(process.argv[2] ?? 10_000);
const teams = Number(process.argv[3] ?? 6);
const seed = sheetK2.seed;
const guilds = scenario.guilds.map((g) => g.id);

console.log(`# シミュレーション（${scenario.id} v${scenario.version}）\n`);

console.log("## 参加者0人の価格（各ラウンド清算後）\n");
for (const k of [1, 2, 3, 4]) {
  const sheet = generateNpcSheet(scenario, { k, seed });
  const run = playGame({ scenario, sheet, teamIds: [], strategy: holdStrategy });
  console.log(`- k=${k}: ${run.prices.map((p) => guilds.map((g) => p[g]).join("/")).join(" → ")}`);
}

console.log(`\n## 設計ルール（${teams}商会、上限${scenario.orderCap}口、ドラゴン）\n`);
console.log("| k | 1商会が10口買ったときの差（R1） | 逆張りで残った割合（R2上昇 / R3暴落 / R5回復） | A | B |");
console.log("| ---: | ---: | --- | --- | --- |");
for (const k of [1, 2, 3, 4]) {
  const r = evaluateRules({ scenario, k, seed, teams, guildId: "dragon" });
  const beats = r.beats.map((b) => `R${b.round} ${b.opposed}（基準${b.base}）${b.retainedPct}%`).join(" / ");
  console.log(`| ${k} | +${r.ruleBDelta}G | ${beats} | ${r.ruleA ? "○" : "×"} | ${r.ruleB ? "○" : "×"} |`);
}

console.log(`\n## 無作為な戦略（k=${sheetK2.k}、${teams}商会、${games}試合）\n`);
const sheet = generateNpcSheet(scenario, { k: sheetK2.k, seed });
if (sheet.hash !== sheetK2.hash) throw new Error("committed NPC sheet differs from the generator output");
let violations = 0;
let minMmCash = Number.POSITIVE_INFINITY;
let maxAssets = 0;
let minAssets = Number.POSITIVE_INFINITY;
const start = Date.now();
for (let i = 0; i < games; i++) {
  const rng = createRng(1000 + i);
  const teamIds = Array.from({ length: teams }, (_, t) => `t${t + 1}`);
  const run = playGame({ scenario, sheet, teamIds, strategy: randomStrategy(rng, guilds, scenario.orderCap) });
  if (run.violations.length > 0) {
    violations += 1;
    if (violations <= 3) console.log(`- 違反（試合${i}）: ${run.violations.slice(0, 3).join("; ")}`);
  }
  minMmCash = Math.min(minMmCash, run.match.accounts.mm!.cash);
  for (const t of teamIds) {
    const cash = run.match.accounts[`team:${t}`]!.cash;
    maxAssets = Math.max(maxAssets, cash);
    minAssets = Math.min(minAssets, cash);
  }
}
console.log(`- 不変条件に違反した試合：${violations}`);
console.log(`- 決算後の市場係の現金（最小）：${minMmCash}G`);
console.log(`- 参加者の最終資産：${minAssets}G〜${maxAssets}G（成功証は1口${PAYOUT_PER_SHARE}G）`);
console.log(`- 所要時間：${((Date.now() - start) / 1000).toFixed(1)}秒`);
console.log(`- 注文表のハッシュ：${sheetK2.hash}、シナリオのハッシュ：${hashValue(scenario)}`);
if (violations > 0) process.exitCode = 1;
