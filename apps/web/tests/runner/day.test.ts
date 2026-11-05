import { describe, expect, it } from "vitest";
import type { EventStore, PriceObservation } from "../../src/contracts";
import { verifyChain } from "../../src/events/chain";
import { replay } from "../../src/events/replay";
import type { LogEvent } from "../../src/events/types";
import { IngestedMarketData, type SourceQuote } from "../../src/ingest/market-data";
import { INITIAL_CASH } from "../../src/ledger/types";
import { type RunnerAgent, type RunnerDeps, type StageResult, runDay, scheduleOf } from "../../src/runner/day";
import { RunnerValues } from "../../src/runner/values";
import { InMemoryEventStore } from "../../src/store/memory-store";
import { FakeClock, jstDay } from "../contracts/fakes";
import { FIXTURE_HOLIDAYS } from "../fixtures/golden";
import { mulberry32 } from "../fixtures/prng";
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
    note: `${id}@${input.tradingDate}`,
  }),
});

/** 架空のシナリオで保管・市場データ・runner を組む。時計を進めるたびに、その時刻までに取得した観測を取り込む */
async function setup(agents: RunnerAgent[] = [scripted("ai-a"), scripted("ai-b")], wrap: (s: InMemoryEventStore) => EventStore = (s) => s) {
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
  const deps: RunnerDeps = { store: wrap(store), market, values, holidayTables, agents, clock, waitUntil };
  const op = (type: "holidays.adopted" | "universe.set" | "agent.registered" | "agent.suspended", payload: Record<string, unknown>) => store.append({ type, actor: "operator:owner", refs: [], payload });
  await op("holidays.adopted", { holidaysSha256: FIXTURE_HOLIDAYS.contentSha256 });
  await op("universe.set", { symbols: [...scenario.symbols] });
  await runDay(PRIOR_DAY, deps); // 前営業日の始値・終値だけ（AIはまだいない）
  await waitUntil(scheduleOf(PRIOR_DAY).closeAt + 3 * 3_600_000);
  for (const a of agents) await op("agent.registered", { agentId: a.id, displayName: a.id, startDate: TRADING_DAYS[0], initialCash: INITIAL_CASH });
  const all = () => store.read(0, 100_000);
  return { scenario, clock, store, values, holidayTables, deps, op, all, waitUntil };
}

describe("runDay（1日の流れ）", async () => {
  const s = await setup();
  const results: StageResult[][] = [];
  for (const d of TRADING_DAYS) results.push(await runDay(d, s.deps));
  const events = await s.all();
  const of = (type: LogEvent["type"]) => events.filter((e) => e.type === type);

  it("投稿→注文票の確定→約定→評価→引け後の処理が記録され、連鎖が通り、replay の台帳が保管と一致する", async () => {
    expect(await verifyChain(events)).toEqual([]);
    expect(of("order_sheet.committed").length).toBe(2);
    expect(of("fills.executed").map((e) => p(e).tradingDate)).toEqual([TRADING_DAYS[0], TRADING_DAYS[0]]);
    expect(of("post.published").length).toBe(2 * TRADING_DAYS.length);
    expect(of("valuation.recorded").length).toBe(2 * TRADING_DAYS.length);
    expect(of("corporate_actions.applied").length).toBe(2 * TRADING_DAYS.length);
    expect(of("source.captured").map((e) => p(e).source)).toEqual(Array(of("prices.open").length + of("prices.close").length).fill("fixture:synthetic"));
    const ledger = await replay(events, s.values, { holidayTables: s.holidayTables });
    for (const id of ["ai-a", "ai-b"]) {
      expect(ledger.account(id)).toEqual(s.store.account(id));
      expect(ledger.account(id).holdings.TSTA?.qty).toBe(100);
    }
  });

  it("終値の取り込みが翌日まで遅れた日は、その日は待ち、翌日の朝に追いついて評価する", () => {
    const late = TRADING_DAYS.indexOf(LATE_DAY);
    expect(results[late]!.at(-1)).toMatchObject({ stage: "prices.close", status: "waiting" });
    expect(results[late + 1]![1]).toMatchObject({ stage: "after_close", status: "written" });
    const lateClose = of("prices.close").find((e) => p(e).date === LATE_DAY)!;
    const nextDecision = of("agent.run").find((e) => e.seq > lateClose.seq)!;
    expect(of("valuation.recorded").filter((e) => p(e).date === LATE_DAY).length).toBe(2);
    expect(p(nextDecision).inputSeqs as number[]).toContain(lateClose.seq);
  });

  it("どの判断も、入力は判断より前に記録した、判断の日より前の終値と、そのAIの引け後の処理だけ", () => {
    for (const run of of("agent.run")) {
      for (const seq of p(run).inputSeqs as number[]) {
        const input = events[seq - 1]!;
        expect(input.seq).toBeLessThan(run.seq);
        if (input.type === "prices.close") expect((p(input).date as string) < jstDay(run.recordedAt)).toBe(true);
        else {
          expect(["corporate_actions.applied", "agent.registered"]).toContain(input.type);
          expect(p(input).agentId).toBe(p(run).agentId);
        }
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

describe("runDay の回し直しと失敗", () => {
  it("翌日のデータを取り込んだ後に前の日を回しても、その日の始値・終値を記録して先に進める", async () => {
    const s = await setup();
    await s.waitUntil(scheduleOf(TRADING_DAYS[1]).closeAt);
    const r = await runDay(TRADING_DAYS[0], s.deps);
    // 前の日は済んでいるので追いつく段はない。判断は締めの後で飛ばし、始値と引け後を記録する
    expect(r.map((x) => [x.stage, x.status])).toEqual([["decide", "skipped"], ["open", "done"], ["open", "done"], ["after_close", "written"]]);
    const dates = (await s.all()).filter((e) => e.type === "prices.open" || e.type === "prices.close").map((e) => p(e).date);
    expect(dates.filter((d) => d === TRADING_DAYS[0]).length).toBe(2);
    expect((await runDay(TRADING_DAYS[1], s.deps)).some((x) => x.status === "written")).toBe(true);
  });

  it("投稿を止めたAIは投稿せず、注文を止めたAIの注文票は拒否（suspended）として残る。ほかのAIは進む", async () => {
    const s = await setup();
    await s.op("agent.suspended", { agentId: "ai-a", scope: "posts", reason: "test" });
    await s.op("agent.suspended", { agentId: "ai-b", scope: "orders", reason: "test" });
    await runDay(TRADING_DAYS[0], s.deps);
    const events = await s.all();
    expect(events.filter((e) => e.type === "post.published").map((e) => p(e).agentId)).toEqual(["ai-b"]);
    expect(events.filter((e) => e.type === "order_sheet.rejected").map((e) => [p(e).agentId, p(e).reason])).toEqual([["ai-b", "suspended"]]);
    expect(events.filter((e) => e.type === "fills.executed").map((e) => p(e).agentId)).toEqual(["ai-a"]);
    expect(events.filter((e) => e.type === "valuation.recorded").length).toBe(2);
  });

  it("判断が例外を投げたAIは失敗の run を残し、ほかのAIと約定・評価は進む。回し直しても判断をやり直さない", async () => {
    let calls = 0;
    const broken: RunnerAgent = { ...scripted("ai-x"), decide: () => (calls++, Promise.reject(new Error("secret provider message"))) };
    const s = await setup([broken, scripted("ai-b")]);
    await runDay(TRADING_DAYS[0], s.deps);
    await runDay(TRADING_DAYS[0], s.deps);
    const events = await s.all();
    const runs = events.filter((e) => e.type === "agent.run" && p(e).agentId === "ai-x");
    expect(runs.map((e) => [p(e).ok, p(e).errorCode])).toEqual([[false, "provider_error"]]);
    expect(JSON.stringify(runs)).not.toContain("secret");
    expect(calls).toBe(1);
    expect(events.filter((e) => e.type === "fills.executed").map((e) => p(e).agentId)).toEqual(["ai-b"]);
  });

  it("終値の後、source.captured の前で落ちても、回し直せば出典の記録を補う", async () => {
    let fail = false;
    const s = await setup([scripted("ai-a")], (store) => ({
      read: (a, l) => store.read(a, l),
      last: () => store.last(),
      commitSheet: (id, sheet) => store.commitSheet(id, sheet),
      append: (d) => (d.type === "source.captured" && fail ? ((fail = false), Promise.reject(new Error("crash"))) : store.append(d)),
    }));
    fail = true; // 準備（前営業日の取り込み）の後から落とす
    await expect(runDay(TRADING_DAYS[0], s.deps)).rejects.toThrow("crash");
    await runDay(TRADING_DAYS[0], s.deps);
    const events = await s.all();
    const prices = events.filter((e) => e.type === "prices.open" || e.type === "prices.close");
    for (const e of prices) expect(events.filter((x) => x.type === "source.captured" && p(x).contentHash === p(e).valuesHash).length).toBe(1);
  });

  it("権利落ち日が翌営業日の公表（配当・分割）を、引け後の処理で反映する。replay の台帳も同じになる", async () => {
    const s = await setup();
    const announce = async (kind: "dividend" | "split", exDate: string, value: Record<string, unknown>) => {
      const valuesHash = await s.values.putValue({ kind, ...value });
      const r = await s.store.append({ type: "corporate_action.announced", actor: "system", refs: [], payload: { symbol: "TSTA", kind, exDate, source: "fixture", valuesHash } });
      expect(r).toMatchObject({ ok: true });
      return r.ok ? r.event.seq : 0;
    };
    const dividend = await announce("dividend", TRADING_DAYS[1], { perShare: 100 }); // 1株 10円
    const split = await announce("split", TRADING_DAYS[2], { from: 1, to: 2 });
    await runDay(TRADING_DAYS[0], s.deps); // 初日に TSTA を100株買う
    const cashAfterBuy = (await s.all()).filter((e) => e.type === "valuation.recorded" && p(e).agentId === "ai-a").at(-1)!;
    expect(s.store.account("ai-a").cash).toBe((p(cashAfterBuy).cash as number) + 100 * 100);
    await runDay(TRADING_DAYS[1], s.deps);
    expect(s.store.account("ai-a").holdings.TSTA?.qty).toBe(200);
    const events = await s.all();
    const applied = events.filter((e) => e.type === "corporate_actions.applied" && p(e).agentId === "ai-a").map((e) => [p(e).asOf, p(e).announcedSeqs]);
    expect(applied).toEqual([[TRADING_DAYS[0], [dividend]], [TRADING_DAYS[1], [split]]]);
    const ledger = await replay(events, s.values, { holidayTables: s.holidayTables });
    for (const id of ["ai-a", "ai-b"]) expect(ledger.account(id)).toEqual(s.store.account(id));
    const last = (await s.store.last())!.seq;
    await runDay(TRADING_DAYS[1], s.deps);
    expect((await s.store.last())!.seq).toBe(last);
  });

  it("注文の run を書いた後で落ちても、回し直せば同じ run から注文票を確定する（判断はやり直さない）", async () => {
    let fail = true;
    let calls = 0;
    const counted: RunnerAgent = { ...scripted("ai-a"), decide: (i) => (calls++, scripted("ai-a").decide(i)) };
    const s = await setup([counted], (store) => ({
      read: (a, l) => store.read(a, l),
      last: () => store.last(),
      append: (d) => store.append(d),
      commitSheet: (id, sheet) => (fail ? ((fail = false), Promise.reject(new Error("crash"))) : store.commitSheet(id, sheet)),
    }));
    const t = TRADING_DAYS[0];
    await expect(runDay(t, s.deps)).rejects.toThrow("crash");
    await runDay(t, s.deps);
    const events = await s.all();
    const runs = events.filter((e) => e.type === "agent.run" && p(e).purpose === "order");
    expect(runs.length).toBe(1);
    expect(events.filter((e) => e.type === "order_sheet.committed").map((e) => p(e).runSeq)).toEqual([runs[0]!.seq]);
    expect(calls).toBe(1);
    expect(events.filter((e) => e.type === "fills.executed").length).toBe(1);
  });
});
