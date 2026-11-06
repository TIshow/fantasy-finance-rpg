// 長い通しの試験（#139、lead の 13:18 UTC の決定）の共通部分：架空の市場を60営業日（決算が3回来る長さ）回し、決めた10通りの
// 乱数の種のそれぞれで、各社が8割以上の日（48日以上）に板寄せの値段がつき、6社そろって値段がつく日が半分以上（30日以上）あり、
// 値段のつかない日が続くのは3日までであることを確かめる。種ごとに別のファイル（seed-<n>.test.ts）にして、Vitest が並べて回せるようにする。
// 種ごとの通しはメモリの保管で、runDay（毎日の流れ）を直接回す（速さのため）。準備は本番と同じ手順（上場 → 上場の前の四半期の
// 発表 → 売買役と規則のAI 3体の登録）で、祝日は同梱の一覧。本番の入口（PGlite）の通しは tests/store/twenty-days.test.ts
import { expect, it } from "vitest";
import type { LogEvent } from "../../../../src/events/types";
import { holidayTable, holidaysFor } from "../../../../src/holidays";
import { IngestedMarketData } from "../../../../src/ingest/market-data";
import { invariantViolations, isBusinessDay } from "../../../../src/ledger/ledger";
import { INITIAL_CASH } from "../../../../src/ledger/types";
import { type RunnerDeps, runDay } from "../../../../src/runner/day";
import { ruleAgents } from "../../../../src/runner/rule-agents";
import { RunnerValues } from "../../../../src/runner/values";
import { COMPANIES } from "../../../../src/runner/world/companies";
import { discloseDue } from "../../../../src/runner/world/disclosure";
import { listCompanies } from "../../../../src/runner/world/listing";
import { NOISE_ID, liquidityAgents, makerId, setUpParticipants } from "../../../../src/runner/world/participants";
import { InMemoryEventStore } from "../../../../src/store/memory-store";
import { FakeClock, jst } from "../../../contracts/fakes";

/** 決めた10通りの種。最初は本番の種（scripts/daily-lib.ts の WORLD_SEED）。ファイル seed-<番号>.test.ts が、この並びの番号の種を回す */
export const SEEDS = [20261106, 1, 2, 3, 4, 5, 6, 7, 8, 9];
const DAYS = 60;
const FIRST = "2026-11-02";
const SYMBOLS = COMPANIES.map((c) => c.symbol);
const p = (e: LogEvent) => e.payload as Record<string, unknown>;

/** FIRST から、祝日と週末をとばした n 営業日 */
function businessDays(n: number): string[] {
  const H = holidaysFor(FIRST, "2027-12-31", holidayTable);
  const out: string[] = [];
  for (let t = Date.parse(`${FIRST}T00:00:00Z`); out.length < n; t += 86_400_000) {
    const d = new Date(t).toISOString().slice(0, 10);
    if (isBusinessDay(d, H)) out.push(d);
  }
  return out;
}

export interface MarketStats {
  /** 社ごとの、値段がついた日数 */
  pricedDays: Record<string, number>;
  /** 6社そろって値段がついた日数 */
  allSixDays: number;
  /** 社ごとの、値段のつかない日が続いた最大の日数 */
  longestGap: Record<string, number>;
  disclosures: number;
}

/** 種 seed の世界を days 営業日回し、値段のつき方と、最後の売買役の口座をまとめる */
async function run(seed: number, days: readonly string[]) {
  const clock = new FakeClock(jst("2026-10-30", 18));
  const holidayTables = new Map([[holidayTable.contentSha256, holidayTable]]);
  const values = new RunnerValues(() => new Uint8Array(16).fill(1));
  const store = new InMemoryEventStore(values, holidayTables, clock);
  const op = async (type: "holidays.adopted" | "agent.registered", payload: Record<string, unknown>) => {
    const r = await store.append({ type, actor: "operator:owner", refs: [], payload });
    if (!r.ok) throw new Error(r.reason);
  };
  await op("holidays.adopted", { holidaysSha256: holidayTable.contentSha256 });
  await listCompanies(store, seed);
  await discloseDue(store, seed, clock);
  await setUpParticipants(store, days[0]!);
  const investors = await ruleAgents();
  for (const a of investors) await op("agent.registered", { agentId: a.id, displayName: a.id, startDate: days[0], initialCash: INITIAL_CASH });
  const waitUntil = async (at: number) => {
    if (at > clock.now()) clock.set(at);
  };
  const deps: RunnerDeps = { store, market: new IngestedMarketData(clock), values, holidayTables, agents: [...investors, ...(await liquidityAgents(seed))], clock, waitUntil, seed };
  for (const d of days) await runDay(d, deps);
  // 1回の読みには上限があるので、空になるまで続けて読む
  const events: LogEvent[] = [];
  for (let page = await store.read(); page.length > 0; page = await store.read(events.at(-1)!.seq)) events.push(...page);
  const priced = new Map<string, Set<string>>(SYMBOLS.map((s) => [s, new Set()]));
  for (const e of events) if (e.type === "auction.cleared" && p(e).price !== null) priced.get(p(e).symbol as string)!.add(p(e).date as string);
  const longestGap: Record<string, number> = {};
  for (const s of SYMBOLS) {
    let gap = 0;
    longestGap[s] = 0;
    for (const d of days) {
      gap = priced.get(s)!.has(d) ? 0 : gap + 1;
      longestGap[s] = Math.max(longestGap[s]!, gap);
    }
  }
  const stats: MarketStats = {
    pricedDays: Object.fromEntries(SYMBOLS.map((s) => [s, priced.get(s)!.size])),
    allSixDays: days.filter((d) => SYMBOLS.every((s) => priced.get(s)!.has(d))).length,
    longestGap,
    disclosures: events.filter((e) => e.type === "company.disclosed").length,
  };
  const ids = [...new Set(events.filter((e) => e.type === "agent.registered").map((e) => p(e).agentId as string))];
  const accounts = Object.fromEntries(await Promise.all(ids.map(async (id) => [id, await store.account(id)] as const)));
  return { stats, accounts };
}

/** SEEDS[index] の種で60営業日を回し、目標を確かめる（seed-<index>.test.ts から呼ぶ） */
export function longRun(index: number) {
  const seed = SEEDS[index]!;
  it(`種 ${seed}：各社が48日以上・6社そろって30日以上、値段がつき、値段のつかない日が続くのは3日まで。売買役の株と現金は尽きない`, async () => {
    const { stats: s, accounts } = await run(seed, businessDays(DAYS));
    // 種ごとの結果を出す（目標までの余裕を、試験が落ちる前に見られるように）
    console.log(`seed ${seed}: ${JSON.stringify(s)}`);
    // 決算は上場の前の四半期と、20・40・60日目の引けのあと（6社 × 4回）
    expect(s.disclosures).toBe(SYMBOLS.length * 4);
    for (const sym of SYMBOLS) {
      expect(s.pricedDays[sym], `${sym}: ${JSON.stringify(s)}`).toBeGreaterThanOrEqual(48);
      expect(s.longestGap[sym], `${sym}: ${JSON.stringify(s)}`).toBeLessThanOrEqual(3);
    }
    expect(s.allSixDays, JSON.stringify(s)).toBeGreaterThanOrEqual(30);
    // 最後の日に、どの口座も台帳の不変条件を守り、売買役（マーケットメイカーとばらばらの参加者）の株と現金は0になっていない
    for (const [id, a] of Object.entries(accounts)) {
      expect(a, id).not.toBeNull();
      expect(invariantViolations(a!), id).toEqual([]);
    }
    for (const sym of SYMBOLS) {
      const mm = accounts[makerId(sym)]!;
      expect(mm.cash, makerId(sym)).toBeGreaterThan(0);
      expect(mm.holdings[sym]?.qty ?? 0, makerId(sym)).toBeGreaterThan(0);
      expect(accounts[NOISE_ID]!.holdings[sym]?.qty ?? 0, `${NOISE_ID} ${sym}`).toBeGreaterThan(0);
    }
    expect(accounts[NOISE_ID]!.cash).toBeGreaterThan(0);
  }, 300_000);
}
