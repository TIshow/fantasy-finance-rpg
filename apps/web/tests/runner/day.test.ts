import { describe, expect, it } from "vitest";
import type { PriceObservation } from "../../src/contracts";
import { verifyChain } from "../../src/events/chain";
import { replay } from "../../src/events/replay";
import type { LogEvent } from "../../src/events/types";
import { IngestedMarketData, type SourceQuote } from "../../src/ingest/market-data";
import { INITIAL_CASH } from "../../src/ledger/types";
import { type RunnerAgent, type StageResult, runDay, scheduleOf } from "../../src/runner/day";
import { RunnerValues } from "../../src/runner/values";
import { InMemoryEventStore } from "../../src/store/memory-store";
import { FakeClock } from "../contracts/fakes";
import { mulberry32 } from "../fixtures/prng";
import { FIXTURE_HOLIDAYS } from "../fixtures/golden";
import { LATE_DAY, PRIOR_DAY, TRADING_DAYS, buildScenario } from "../fixtures/scenario";

const toQuote = ({ fetchedAt: _, ...o }: PriceObservation): SourceQuote => o;
const p = (e: LogEvent) => e.payload as Record<string, unknown>;

/** 初日に TSTA を100株買い、毎日1件投稿する、決まった判断のAI（規則のAIは PR-2） */
const scripted = (id: string): RunnerAgent => ({
  id,
  model: { provider: "rule", modelId: "scripted", settings: {} },
  prompt: { id: "scripted", version: "1", hash: "0".repeat(64) },
  decide: (input) => ({
    orders: input.tradingDate === TRADING_DAYS[0] ? [{ symbol: "TSTA", side: "buy", qty: 100 }] : [],
    post: { board: "TSTA", text: `${id} sees ${input.closes.length} closes` },
    output: `${id}@${input.tradingDate}`,
  }),
});

/** 架空のシナリオで保管・市場データ・runner を組む。時計を進めるたびに、その時刻までに取得した観測を取り込む */
async function setup() {
  const scenario = buildScenario(7);
  const clock = new FakeClock(0);
  const holidayTables = new Map([[FIXTURE_HOLIDAYS.contentSha256, FIXTURE_HOLIDAYS]]);
  const rand = mulberry32(99);
  const values = new RunnerValues(() => Uint8Array.from({ length: 16 }, () => Math.floor(rand() * 256)));
  const store = new InMemoryEventStore(values, holidayTables, clock);
  const market = new IngestedMarketData(clock);
  const pending = [...scenario.observations].sort((a, b) => a.fetchedAt - b.fetchedAt);
  const waitUntil = async (at: number) => {
    while (pending.length > 0 && pending[0]!.fetchedAt <= at) {
      const o = pending.shift()!;
      if (o.fetchedAt > clock.now()) clock.set(o.fetchedAt);
      market.capture([toQuote(o)]);
    }
    if (at > clock.now()) clock.set(at);
  };
  const agents = [scripted("ai-a"), scripted("ai-b")];
  const deps = { store, market, values, holidayTables, agents, clock, waitUntil };
  const op = (type: "holidays.adopted" | "universe.set" | "agent.registered", payload: Record<string, unknown>) => store.append({ type, actor: "operator:owner", refs: [], payload });
  await op("holidays.adopted", { holidaysSha256: FIXTURE_HOLIDAYS.contentSha256 });
  await op("universe.set", { symbols: [...scenario.symbols] });
  await runDay(PRIOR_DAY, deps); // 前営業日の始値・終値だけ（AIはまだいない）
  await waitUntil(scheduleOf(PRIOR_DAY).closeAt + 3 * 3_600_000);
  for (const a of agents) await op("agent.registered", { agentId: a.id, displayName: a.id, startDate: TRADING_DAYS[0], initialCash: INITIAL_CASH });
  return { scenario, clock, store, values, holidayTables, deps };
}

describe("runDay（1日の流れ）", async () => {
  const s = await setup();
  const results: StageResult[][] = [];
  for (const d of TRADING_DAYS) results.push(await runDay(d, s.deps));
  const events = await s.store.read(0, 10_000);
  const of = (type: LogEvent["type"]) => events.filter((e) => e.type === type);

  it("投稿→注文票の確定→約定→評価→引け後の処理が記録され、連鎖が通り、replay の台帳が保管と一致する", async () => {
    expect(await verifyChain(events)).toEqual([]);
    expect(of("order_sheet.committed").length).toBe(2);
    expect(of("fills.executed").map((e) => p(e).tradingDate)).toEqual([TRADING_DAYS[0], TRADING_DAYS[0]]);
    expect(of("post.published").length).toBe(2 * TRADING_DAYS.length);
    expect(of("valuation.recorded").length).toBe(2 * TRADING_DAYS.length);
    expect(of("corporate_actions.applied").length).toBe(2 * TRADING_DAYS.length);
    expect(of("source.captured").length).toBe(of("prices.open").length + of("prices.close").length);
    const ledger = await replay(events, s.values, { holidayTables: s.holidayTables });
    for (const id of ["ai-a", "ai-b"]) {
      expect(ledger.account(id)).toEqual(s.store.account(id));
      expect(ledger.account(id).holdings.TSTA?.qty).toBe(100);
    }
  });

  it("終値の取り込みが翌日まで遅れた日は、その日は待ち、翌日の朝に追いついて評価する", () => {
    const late = TRADING_DAYS.indexOf(LATE_DAY);
    expect(results[late]!.at(-1)).toMatchObject({ stage: "prices.close", status: "waiting" });
    expect(results[late + 1]![0]).toMatchObject({ stage: "after_close", status: "written" });
    const valuation = of("valuation.recorded").filter((e) => p(e).date === LATE_DAY);
    const nextDecision = of("agent.run").find((e) => e.seq > valuation[0]!.seq);
    expect(valuation.length).toBe(2);
    expect(nextDecision && (p(nextDecision).inputSeqs as number[])).toContain(of("prices.close").find((e) => p(e).date === LATE_DAY)!.seq);
  });

  it("判断の入力は、判断より前に記録した、約定日より前の日の終値だけ", () => {
    for (const run of of("agent.run")) {
      const sheetOrPost = events.find((e) => (e.type === "order_sheet.committed" || e.type === "post.published") && p(e).runSeq === run.seq);
      const tradingDate = sheetOrPost && p(sheetOrPost).tradingDate;
      for (const seq of p(run).inputSeqs as number[]) {
        const input = events[seq - 1]!;
        expect(input.type).toBe("prices.close");
        expect(input.recordedAt).toBeLessThanOrEqual(run.recordedAt);
        if (typeof tradingDate === "string") expect((p(input).date as string) < tradingDate).toBe(true);
      }
    }
  });

  it("同じ日をもう一度回しても、イベントは増えない", async () => {
    const before = (await s.store.last())!.seq;
    for (const d of TRADING_DAYS) {
      const again = await runDay(d, s.deps);
      expect(again.every((r) => r.status === "done" || r.status === "skipped")).toBe(true);
    }
    expect((await s.store.last())!.seq).toBe(before);
  });

  it("営業日でない日は何もしない", async () => {
    expect(await runDay("2026-11-14", s.deps)).toEqual([{ stage: "day", status: "skipped", detail: "not a business day" }]);
  });
});
