import { ALGORITHM_VERSION, MAX_RESERVE_UNIT } from "./constants";
import { hashValue } from "./hash";
import { displayPrices } from "./lmsr";
import { createRng, shuffle } from "./rng";
import type { NpcArchetype, Scenario } from "./scenario";
import type { GuildId, GuildMap, RoundOrder, Side } from "./types";

export interface NpcDefinition {
  key: string;
  name: string;
  archetype: NpcArchetype;
  cash: number;
  positions: GuildMap<number>;
}

export interface NpcOrder {
  npcKey: string;
  guildId: GuildId;
  side: Side;
  qty: number;
}

/** 開発時に生成し、レビュー後に固定する注文表（D-026） */
export interface NpcSheet {
  scenarioId: string;
  scenarioVersion: number;
  algorithmVersion: string;
  k: number;
  b: number;
  seed: number;
  q0: GuildMap<number>;
  npcs: NpcDefinition[];
  /** rounds[i] = 第i+1ラウンドの注文 */
  rounds: NpcOrder[][];
  hash: string;
}

/** NPCの方針。差し替え可能にしておき、最初は固定の注文表を読むだけにする。 */
export interface NpcPolicy {
  ordersForRound(round: number): RoundOrder[];
}

export const npcAccountId = (key: string) => `npc:${key}`;

export function fixedSheetPolicy(sheet: NpcSheet): NpcPolicy {
  return {
    ordersForRound(round) {
      return (sheet.rounds[round - 1] ?? []).map((o) => ({
        accountId: npcAccountId(o.npcKey),
        kind: "npc",
        guildId: o.guildId,
        side: o.side,
        qty: o.qty,
        // NPCの現金は最悪価格でも払える額にしてあるので、予約は上限価格で取る
        reserveCash: o.side === "buy" ? o.qty * MAX_RESERVE_UNIT : 0,
      }));
    },
  };
}

const NAME_PLACES = ["王都", "北門", "城下町", "港町", "東門", "西門", "南門", "山麓", "湖畔", "星見"];
const NAME_KINDS = ["商会", "組合", "商店", "交易所", "問屋", "商人団", "両替商", "運送組合", "商館", "倉庫"];

/** 方向に乗る側の性格と重み。逆張りは反対側に回る。 */
const ALIGNED_WEIGHT: Record<NpcArchetype, number> = { trend: 1.2, news: 1.4, short: 1, long: 0.4, contrarian: 0 };
const COUNTER_RATIO = 0.15;

function allocate(volume: number, participants: number, rng: () => number): number[] {
  // 各自1口以上。残りを乱数の重みで最大剰余法により配る
  const base = Array.from({ length: participants }, () => 1);
  const rest = volume - participants;
  const weights = base.map(() => rng() + 0.5);
  const total = weights.reduce((a, c) => a + c, 0);
  const raw = weights.map((w) => (rest * w) / total);
  const ints = raw.map(Math.floor);
  const order = raw.map((r, i) => ({ i, f: r - Math.floor(r) })).sort((a, b) => b.f - a.f || a.i - b.i);
  const leftover = rest - ints.reduce((a, c) => a + c, 0);
  for (let j = 0; j < leftover; j++) ints[order[j]!.i]! += 1;
  return base.map((v, i) => v + ints[i]!);
}

function pick<T>(pool: readonly T[], volume: number, avgSize: number, rng: () => number): T[] {
  const n = Math.max(1, Math.min(pool.length, volume, Math.ceil(volume / avgSize)));
  return shuffle(pool, rng).slice(0, n);
}

/** 目標の表示価格を、整数のqで再現する。丸めで外れたら近くのqを探す。 */
function targetQ(guilds: readonly GuildId[], prices: GuildMap<number>, b: number): GuildMap<number> {
  const q: GuildMap<number> = Object.fromEntries(guilds.map((g) => [g, Math.round(b * Math.log(prices[g]!))]));
  const matches = (cand: GuildMap<number>) => guilds.every((g) => displayPrices({ guilds, b, q: cand })[g] === prices[g]);
  if (matches(q)) return q;
  for (let radius = 1; radius <= 6; radius++) {
    for (const g of guilds) {
      for (const d of [-radius, radius]) {
        const cand = { ...q, [g]: q[g]! + d };
        if (matches(cand)) return cand;
      }
    }
  }
  throw new Error(`target prices are not reachable: ${JSON.stringify(prices)}`);
}

/**
 * 性格ごとの規則とシードから、100商会×全ラウンドの注文表を作る（開発時だけ使う）。
 * 各ラウンドのギルド別の純注文量は、参加者0人で目標の価格になるように決める。
 * k倍の市場（b = 100k）では、注文量も同じ倍率になる。
 */
export function generateNpcSheet(scenario: Scenario, opts: { k: number; seed: number }): NpcSheet {
  const { k, seed } = opts;
  if (!Number.isInteger(k) || k < 1) throw new Error("k must be a positive integer");
  const b = 100 * k;
  const guilds = scenario.guilds.map((g) => g.id);
  const rng = createRng(seed);

  const npcs: { key: string; name: string; archetype: NpcArchetype }[] = [];
  let n = 0;
  for (const [archetype, count] of Object.entries(scenario.npcArchetypes) as [NpcArchetype, number][]) {
    for (let i = 0; i < count; i++, n++) {
      const name = `${NAME_PLACES[n % NAME_PLACES.length]}${NAME_KINDS[Math.floor(n / NAME_PLACES.length) % NAME_KINDS.length]}`;
      npcs.push({ key: `n${String(n + 1).padStart(3, "0")}`, name, archetype });
    }
  }

  const path = [scenario.initialPrices, ...scenario.targetPrices].map((p) => targetQ(guilds, p, b));
  const rounds: NpcOrder[][] = [];
  for (let t = 1; t < path.length; t++) {
    const orders: NpcOrder[] = [];
    for (const g of guilds) {
      const delta = path[t]![g]! - path[t - 1]![g]!;
      const aligned: Side = delta >= 0 ? "buy" : "sell";
      const counter: Side = aligned === "buy" ? "sell" : "buy";
      const size = Math.abs(delta);
      const counterVolume = Math.round(size * COUNTER_RATIO);
      const alignedVolume = size + counterVolume;
      const strong = size >= 20 * k;
      const alignedPool = npcs.filter((x) => ALIGNED_WEIGHT[x.archetype] > 0 && (strong || x.archetype !== "long"));
      if (alignedVolume > 0) {
        const chosen = pick(alignedPool, alignedVolume, 3 * k, rng);
        allocate(alignedVolume, chosen.length, rng).forEach((qty, i) =>
          orders.push({ npcKey: chosen[i]!.key, guildId: g, side: aligned, qty }),
        );
      }
      if (counterVolume > 0) {
        const pool = npcs.filter((x) => x.archetype === "contrarian");
        const chosen = pick(pool, counterVolume, 2 * k, rng);
        allocate(counterVolume, chosen.length, rng).forEach((qty, i) =>
          orders.push({ npcKey: chosen[i]!.key, guildId: g, side: counter, qty }),
        );
      }
    }
    rounds.push(orders);
  }

  // 売りに必要な初期保有。開始時のq0をNPCに配る。q0は価格を変えない定数ずらしで最小にする
  const need: Record<string, GuildMap<number>> = {};
  const buyVolume: Record<string, number> = {};
  for (const x of npcs) {
    need[x.key] = Object.fromEntries(guilds.map((g) => [g, 0]));
    buyVolume[x.key] = 0;
  }
  const running: Record<string, GuildMap<number>> = structuredClone(need);
  for (const orders of rounds) {
    for (const o of orders) {
      const r = running[o.npcKey]!;
      r[o.guildId]! += o.side === "buy" ? o.qty : -o.qty;
      need[o.npcKey]![o.guildId] = Math.max(need[o.npcKey]![o.guildId]!, -r[o.guildId]!);
      if (o.side === "buy") buyVolume[o.npcKey]! += o.qty;
    }
  }
  const required = Object.fromEntries(guilds.map((g) => [g, npcs.reduce((a, x) => a + need[x.key]![g]!, 0)]));
  const shift = Math.min(...guilds.map((g) => path[0]![g]! - required[g]!));
  const q0 = Object.fromEntries(guilds.map((g) => [g, path[0]![g]! - shift]));

  const holders = npcs.filter((x) => x.archetype === "long");
  const positions: Record<string, GuildMap<number>> = structuredClone(need);
  for (const g of guilds) {
    const spare = q0[g]! - required[g]!;
    holders.forEach((h, i) => {
      positions[h.key]![g]! += Math.floor(spare / holders.length) + (i < spare % holders.length ? 1 : 0);
    });
  }

  const body = {
    scenarioId: scenario.id,
    scenarioVersion: scenario.version,
    algorithmVersion: ALGORITHM_VERSION,
    k,
    b,
    seed,
    q0,
    npcs: npcs.map((x) => ({
      ...x,
      cash: buyVolume[x.key]! * MAX_RESERVE_UNIT,
      positions: positions[x.key]!,
    })),
    rounds,
  };
  return { ...body, hash: hashValue(body) };
}

export function verifySheetHash(sheet: NpcSheet): boolean {
  const { hash, ...body } = sheet;
  return hashValue(body) === hash;
}
