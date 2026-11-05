// 通しの試験（#27 PR-2）：規則で動く仮のAI 3体で、架空データの10営業日を回す。外部通信・DB・LLM なし。
import { describe, expect, it } from "vitest";
import { verifyChain } from "../../src/events/chain";
import { replay } from "../../src/events/replay";
import type { LogEvent } from "../../src/events/types";
import { IngestedMarketData, type SourceQuote, staticSource } from "../../src/ingest/market-data";
import { INITIAL_CASH } from "../../src/ledger/types";
import { type RunnerDeps, runDay, scheduleOf } from "../../src/runner/day";
import { adjustCloses } from "../../src/runner/adjust";
import { ruleAgents } from "../../src/runner/rule-agents";
import { RunnerValues } from "../../src/runner/values";
import { InMemoryEventStore } from "../../src/store/memory-store";
import { FakeClock, jst } from "../contracts/fakes";
import { FIXTURE_HOLIDAYS } from "../fixtures/golden";
import { mulberry32, randInt } from "../fixtures/prng";

const SYMBOLS = ["TSTA", "TSTB", "TSTC"];
const PRIOR = "2026-11-06";
/** 10営業日（祝日なし）。11/18 は終値の取り込みが翌日の未明まで遅れる */
const DAYS = ["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20"];
const LATE = "2026-11-18";
const p = (e: LogEvent) => e.payload as Record<string, unknown>;

/** 架空の始値・終値と、それを取得する時刻。値動きは大きめ（規則が売買するように）。同じシードなら同じ */
function quotes(seed: number, lateFetchAt: number): { fetchedAt: number; quote: SourceQuote }[] {
  const rand = mulberry32(seed);
  const out: { fetchedAt: number; quote: SourceQuote }[] = [];
  const last: Record<string, number> = { TSTA: 1200, TSTB: 2500, TSTC: 800 };
  for (const date of [PRIOR, ...DAYS]) {
    for (const symbol of SYMBOLS) {
      if (symbol === "TSTC" && date === DAYS[6]) last[symbol] = Math.round(last[symbol]! / 2); // 1:2 の分割で値が半分になる（調整しない値）
      const open = Math.max(1, Math.round(last[symbol]! * (1 + (rand() - 0.5) * 0.06)));
      const close = Math.max(1, Math.round(open * (1 + (rand() - 0.5) * 0.08)));
      last[symbol] = close;
      const delay = () => randInt(rand, 5, 120) * 1000;
      const base = { symbol, date, source: "fixture:synthetic" };
      out.push({ fetchedAt: jst(date, 9) + delay(), quote: { ...base, kind: "open", price: open * 10, publishedAt: jst(date, 9) } });
      const closeFetch = date === LATE ? lateFetchAt : jst(date, 15, 30) + delay();
      out.push({ fetchedAt: closeFetch, quote: { ...base, kind: "close", price: close * 10, volume: randInt(rand, 100, 5000) * 100, publishedAt: jst(date, 15, 30) } });
    }
  }
  return out.sort((a, b) => a.fetchedAt - b.fetchedAt);
}

/** AIが受け取った入力（先読みの検査に使う） */
type Seen = { agentId: string; tradingDate: string; at: number; closes: { seq: number; date: string; prices: Readonly<Record<string, number | null>> }[]; splitSeqs: number[] };

/**
 * 保管・取り込み・runner を組み、前営業日から10営業日を回す。取り込みは取得の時刻に staticSource から行う。
 * salt の乱数は固定（データのシードだけでログが変わることを見るため）。
 * lateFetchAt：LATE の終値を取得する時刻。interrupt：毎日、判断の後・寄り付きの前で一度止めてから回し直す
 */
async function run(seed: number, opts: { lateFetchAt?: number; interrupt?: boolean } = {}) {
  const clock = new FakeClock(0);
  const holidayTables = new Map([[FIXTURE_HOLIDAYS.contentSha256, FIXTURE_HOLIDAYS]]);
  const rand = mulberry32(0x5a17);
  const values = new RunnerValues(() => Uint8Array.from({ length: 16 }, () => Math.floor(rand() * 256)));
  const store = new InMemoryEventStore(values, holidayTables, clock);
  const market = new IngestedMarketData(clock);
  const pending = quotes(seed, opts.lateFetchAt ?? jst("2026-11-19", 3));
  const waitUntil = async (at: number) => {
    while (pending.length > 0 && pending[0]!.fetchedAt <= at) {
      const t = pending[0]!.fetchedAt;
      const batch = pending.splice(0, pending.findIndex((x) => x.fetchedAt !== t) === -1 ? pending.length : pending.findIndex((x) => x.fetchedAt !== t));
      clock.set(Math.max(clock.now(), t));
      expect((await market.ingest(staticSource(batch.map((x) => x.quote)))).rejected).toEqual([]);
    }
    if (at > clock.now()) clock.set(at);
  };
  const seen: Seen[] = [];
  const agents = (await ruleAgents()).map((a) => ({
    ...a,
    decide: (input: Parameters<typeof a.decide>[0]) => {
      seen.push({ agentId: a.id, tradingDate: input.tradingDate, at: input.at, closes: input.closes.map((c) => ({ seq: c.seq, date: c.date, prices: c.prices })), splitSeqs: input.splits.map((x) => x.seq) });
      return a.decide(input);
    },
  }));
  const deps: RunnerDeps = { store, market, values, holidayTables, agents, clock, waitUntil, inputDays: 5 };
  const op = (type: "holidays.adopted" | "universe.set" | "agent.registered", payload: Record<string, unknown>) => store.append({ type, actor: "operator:owner", refs: [], payload });
  await op("holidays.adopted", { holidaysSha256: FIXTURE_HOLIDAYS.contentSha256 });
  await op("universe.set", { symbols: SYMBOLS });
  await runDay(PRIOR, deps);
  await waitUntil(scheduleOf(PRIOR).closeAt + 3 * 3_600_000);
  for (const a of agents) await op("agent.registered", { agentId: a.id, displayName: a.id, startDate: DAYS[0], initialCash: INITIAL_CASH });
  // 企業行動の公表：TSTB の配当（1株 5円）と TSTC の 1:2 の分割。引け後の処理で反映する
  for (const [symbol, kind, exDate, value] of [["TSTB", "dividend", DAYS[4], { perShare: 50 }], ["TSTC", "split", DAYS[6], { from: 1, to: 2 }]] as const) {
    const valuesHash = await values.putValue({ kind, ...value });
    expect(await store.append({ type: "corporate_action.announced", actor: "system", refs: [], payload: { symbol, kind, exDate, source: "fixture:synthetic", valuesHash } })).toMatchObject({ ok: true });
  }
  for (const d of DAYS) {
    if (opts.interrupt) {
      const stop = async (at: number) => (at === scheduleOf(d).openAt ? Promise.reject(new Error("stop")) : waitUntil(at));
      await expect(runDay(d, { ...deps, waitUntil: stop })).rejects.toThrow("stop");
    }
    await runDay(d, deps);
  }
  return { store, values, holidayTables, deps, seen, events: await store.read(0, 100_000) };
}

describe("規則のAI 3体で10営業日を通す", async () => {
  const r = await run(20261104);
  const of = (type: LogEvent["type"]) => r.events.filter((e) => e.type === type);
  const ids = ["ai-ma5", "ai-reversal", "ai-hold"];

  it("(a) 連鎖の検査が通る。全員が毎日評価され、売買が実際に起きている", async () => {
    expect(await verifyChain(r.events)).toEqual([]);
    expect(of("valuation.recorded").length).toBe(DAYS.length * 3);
    expect(of("order_sheet.rejected")).toEqual([]);
    const traded = (id: string) => of("fills.executed").filter((e) => p(e).agentId === id && (p(e).fills as { qty: number }[]).some((f) => f.qty > 0)).length;
    for (const id of ids) expect(traded(id), id).toBeGreaterThan(0);
    expect(of("fills.executed").some((e) => (p(e).fills as { side: string; qty: number }[]).some((f) => f.side === "sell" && f.qty > 0))).toBe(true);
    for (const run of of("agent.run")) expect((p(run).model as { provider: string }).provider).toBe("rule");
    // 公表は、権利落ち日の前営業日の引け後の処理で、全員に1回ずつ渡る
    for (const a of of("corporate_action.announced")) {
      const got = of("corporate_actions.applied").filter((e) => (p(e).announcedSeqs as number[]).includes(a.seq));
      expect(got.map((e) => p(e).agentId).sort()).toEqual([...ids].sort());
      expect(new Set(got.map((e) => p(e).exDate))).toEqual(new Set([p(a).exDate]));
    }
    // 持ち続けるAIは、配当を受け取り、分割で株数が2倍になる
    const actions = of("corporate_actions.applied").filter((e) => p(e).agentId === "ai-hold").flatMap((e) => p(e).actions as { kind: string; symbol: string }[]);
    expect(actions.map((x) => `${x.kind}:${x.symbol}`)).toEqual(["dividend:TSTB", "split:TSTC"]);
    expect(r.store.account("ai-hold").holdings.TSTC?.qty).toBe(200);
    // 分割の前後で TSTC の評価額が飛ばない（株数は倍・値は半分）。1日の値動きは10%に収まる
    const tstc = (d: string) => {
      const v = p(of("valuation.recorded").find((e) => p(e).agentId === "ai-hold" && p(e).date === d)!);
      const x = (v.positions as { symbol: string; qty: number; price: number }[]).find((y) => y.symbol === "TSTC")!;
      return x.qty * x.price;
    };
    expect(Math.abs(tstc(DAYS[6]!) - tstc(DAYS[5]!))).toBeLessThan(tstc(DAYS[5]!) * 0.15);
  });

  it("分割の後の判断には、調整した終値の列を渡し、分割の公表と、それを反映した引け後の処理を入力に残す", () => {
    const split = of("corporate_action.announced").find((e) => p(e).kind === "split")!;
    const after = r.seen.filter((x) => x.tradingDate >= DAYS[6]! && x.closes.some((c) => c.date < DAYS[6]!));
    expect(after.length).toBeGreaterThan(0);
    for (const x of after) {
      expect(x.splitSeqs).toEqual([split.seq]);
      const run = of("agent.run").find((e) => p(e).agentId === x.agentId && p(e).startedAt === x.at)!;
      const inputs = p(run).inputSeqs as number[];
      expect(inputs).toContain(split.seq);
      const applied = of("corporate_actions.applied").find((e) => p(e).agentId === x.agentId && p(e).exDate === DAYS[6])!;
      expect(inputs).toContain(applied.seq);
      // 列が分割の日の前後で続いている（1日の値動きは10%に収まる。調整しなければ半分になる）
      const xs = x.closes.map((c) => c.prices.TSTC as number);
      for (let i = 1; i < xs.length; i++) expect(Math.abs(xs[i]! - xs[i - 1]!)).toBeLessThan(xs[i - 1]! * 0.15);
    }
    // AIが受け取った列は、run の入力の seq（終値と分割の公表）とログの外の値だけから作り直せる
    for (const x of r.seen) {
      const run = of("agent.run").find((e) => p(e).agentId === x.agentId && p(e).startedAt === x.at)!;
      const inputs = (p(run).inputSeqs as number[]).map((s) => r.events[s - 1]!);
      const value = (e: LogEvent) => r.values.get(p(e).valuesHash as string)!.value as Record<string, number>;
      const raw = inputs.filter((e) => e.type === "prices.close").map((e) => ({ seq: e.seq, date: p(e).date as string, prices: value(e) }));
      const splits = inputs.filter((e) => e.type === "corporate_action.announced").map((e) => ({ seq: e.seq, symbol: p(e).symbol as string, exDate: p(e).exDate as string, from: value(e).from!, to: value(e).to! }));
      expect(adjustCloses(raw, splits)).toEqual(x.closes);
    }
    // 分割より前の判断には、分割を渡さない
    expect(r.seen.filter((x) => x.tradingDate < DAYS[6]!).every((x) => x.splitSeqs.length === 0)).toBe(true);
  });

  it("(b) replay で先頭から作り直した台帳が、記録（保管の口座）と一致する", async () => {
    const ledger = await replay(r.events, r.values, { holidayTables: r.holidayTables });
    for (const id of ids) expect(ledger.account(id)).toEqual(r.store.account(id));
  });

  it("(c) 同じ入力（シード）なら同じログになり、別のデータなら変わる（salt は固定）", async () => {
    expect((await run(20261104)).events.at(-1)!.hash).toBe(r.events.at(-1)!.hash);
    expect((await run(20261105)).events.at(-1)!.hash).not.toBe(r.events.at(-1)!.hash);
  });

  it("(d) 同じ日を2回回しても、ログは変わらない（済んだ後にも、判断の後・寄り付きの前に止めて回し直しても）", async () => {
    for (const d of [PRIOR, ...DAYS]) await runDay(d, r.deps);
    expect(await r.store.read(0, 100_000)).toEqual(r.events);
    const interrupted = await run(20261104, { interrupt: true });
    expect(interrupted.events).toEqual(r.events);
    expect(interrupted.seen.length).toBe(r.seen.length); // 回し直しで判断をやり直していない
  });

  it("(e) 先読みがない：判断の入力は、すべて判断より前に取り込み・記録した、約定日より前の日のもの", () => {
    for (const run of of("agent.run")) {
      const startedAt = p(run).startedAt as number;
      for (const seq of p(run).inputSeqs as number[]) {
        const input = r.events[seq - 1]!;
        expect(input.seq).toBeLessThan(run.seq);
        expect(input.recordedAt).toBeLessThanOrEqual(startedAt);
        if (input.type === "prices.close") {
          expect(p(input).fetchedAt as number).toBeLessThan(startedAt);
          // 取得の時刻より後に、その日の終値の公開がないこと（公開は 15:30。取引日の朝の判断から見て前の日）
          expect(jst(p(input).date as string, 15, 30)).toBeLessThan(startedAt);
        }
      }
    }
    // AIが受け取った終値は、すべて約定日より前の日のもので、その判断の run の入力に載っている
    expect(r.seen.length).toBeGreaterThan(0);
    for (const x of r.seen) {
      const run = of("agent.run").find((e) => p(e).agentId === x.agentId && p(e).startedAt === x.at)!;
      for (const c of x.closes) {
        expect(c.date < x.tradingDate).toBe(true);
        expect(p(run).inputSeqs as number[]).toContain(c.seq);
      }
    }
    // 判断に使った終値の、記録した出典（source.captured）の公開・取得の時刻は、判断より前
    for (const run of of("agent.run")) {
      for (const seq of p(run).inputSeqs as number[]) {
        const input = r.events[seq - 1]!;
        if (input.type !== "prices.close") continue;
        const src = of("source.captured").filter((e) => p(e).contentHash === p(input).valuesHash);
        expect(src.length).toBe(1);
        expect(p(src[0]!).publishedAt as number).toBeLessThan(p(run).startedAt as number);
        expect(p(src[0]!).fetchedAt as number).toBeLessThan(p(run).startedAt as number);
      }
    }
    // 遅れた日の終値は、取り込んだ後の判断（翌日の朝）から入力に入る
    const late = of("prices.close").find((e) => p(e).date === LATE)!;
    expect(late.recordedAt).toBeGreaterThanOrEqual(jst("2026-11-19", 3));
    expect(of("agent.run").filter((e) => (p(e).inputSeqs as number[]).includes(late.seq)).length).toBeGreaterThan(0);
    expect(of("agent.run").filter((e) => (p(e).inputSeqs as number[]).includes(late.seq)).every((e) => e.seq > late.seq && e.recordedAt >= late.recordedAt)).toBe(true);
  });

  it("前の日の終値が朝の判断より後に届いた日は、判断を待ち（その日は注文しない）、その後に追いつく", async () => {
    const next = "2026-11-19";
    const late = await run(20261104, { lateFetchAt: jst(next, 8) }); // 判断（7:00）の後、締め（8:30）の前に届く
    const ev = late.events;
    const lateClose = ev.find((e) => e.type === "prices.close" && p(e).date === LATE)!;
    expect(lateClose.recordedAt).toBeGreaterThanOrEqual(jst(next, 8));
    expect(late.seen.filter((x) => x.tradingDate === next)).toEqual([]);
    expect(ev.filter((e) => e.type === "order_sheet.committed" && p(e).tradingDate === next)).toEqual([]);
    expect(ev.filter((e) => e.type === "valuation.recorded").length).toBe(DAYS.length * 3);
    expect(await verifyChain(ev)).toEqual([]);
    const ledger = await replay(ev, late.values, { holidayTables: late.holidayTables });
    for (const id of ids) expect(ledger.account(id)).toEqual(late.store.account(id));
  });
});
