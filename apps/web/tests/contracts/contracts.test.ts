// src/contracts の型の使い方の例と、メモリ上の偽物が契約を満たすことの確認。契約は型だけなので、
// 実装を持つ platform が同じ確認を自分の実装にも当てられるよう、偽物は fakes.ts に分けた。
import { describe, expect, it } from "vitest";
import type { Clock, DraftInput, EventReader, EventStore, LlmPort, LlmRequest, MarketDataPort, OrderlessEventStore, PriceObservation } from "../../src/contracts";
import { EventLog } from "../../src/events/append";
import { verifyChain } from "../../src/events/chain";
import type { HolidayTable } from "../../src/holidays/table";
import { newAccount } from "../../src/ledger/ledger";
import { INITIAL_CASH } from "../../src/ledger/types";
import { FakeClock, FakeLlm, MemoryEventStore, MemoryMarketData, jst, jstDay } from "./fakes";

const H = "a".repeat(64);
const table: HolidayTable = { firstYear: 2026, lastYear: 2027, sourceSha256: "0".repeat(64), contentSha256: H, dates: new Set() };
const op = (type: DraftInput["type"], payload: Record<string, unknown>): DraftInput => ({ type, actor: "operator:owner", refs: [], payload });
const sys = (type: DraftInput["type"], payload: Record<string, unknown>, refs: number[] = []): DraftInput => ({ type, actor: "system", refs, payload });

function newStore(start = 0) {
  const log = new EventLog({ holidayTables: new Map([[H, table]]), accountOf: () => newAccount() });
  const clock = new FakeClock(start);
  return { store: new MemoryEventStore(log, clock) as EventStore, clock };
}

/** 呼び出し側は契約だけを見る。この関数は EventStore の実装を知らない。11/9 22:00 に agent.run まで書き、その seq を返す */
async function seedAgent(store: EventStore, clock: FakeClock) {
  const steps: [number, DraftInput][] = [
    [0, op("holidays.adopted", { holidaysSha256: H })],
    [0, op("universe.set", { symbols: ["TSTA"] })],
    [jst("2026-11-09", 20), op("agent.registered", { agentId: "ai-a", startDate: "2026-11-10", initialCash: INITIAL_CASH })],
    [jst("2026-11-09", 21), sys("source.captured", { publishedAt: jst("2026-11-09", 15, 30), fetchedAt: jst("2026-11-09", 21) })],
  ];
  for (const [t, d] of steps) {
    clock.set(t);
    const r = await store.append(d);
    if (!r.ok) throw new Error(r.reason);
  }
  clock.set(jst("2026-11-09", 22));
  const run = await store.append(sys("agent.run", { agentId: "ai-a", purpose: "order", inputSeqs: [4], ok: true }, [4]));
  if (!run.ok) throw new Error(run.reason);
  return run.event.seq;
}

describe("Clock", () => {
  it("UNIXミリ秒の整数を返し、recordedAt にそのまま使える", () => {
    const clock: Clock = new FakeClock(jst("2026-11-10", 9));
    expect(Number.isSafeInteger(clock.now())).toBe(true);
    expect(jstDay(clock.now())).toBe("2026-11-10");
  });
});

describe("EventStore", () => {
  it("追記は EventLog の検査を通り、通らないものは書かずに理由を返す", async () => {
    const { store, clock } = newStore(jst("2026-11-09", 20));
    const bad = await store.append(op("agent.registered", { agentId: "ai-a", startDate: "2026-11-10", initialCash: INITIAL_CASH }));
    expect(bad.ok).toBe(false); // 祝日の一覧がまだ採用されていない
    expect(await store.last()).toBeNull();
    await seedAgent(store, clock);
    expect((await store.last())?.type).toBe("agent.run");
  });

  it("recordedAt は保管が Clock から入れる。呼び出し側は決められない（H1）", async () => {
    const { store, clock } = newStore();
    await seedAgent(store, clock);
    expect((await store.last())?.recordedAt).toBe(jst("2026-11-09", 22));
    // 型：Draft に recordedAt は渡せない
    // @ts-expect-error recordedAt は DraftInput にない
    const forged: DraftInput = { ...sys("source.captured", {}), recordedAt: 1 };
    void forged;
    // 時計が締め（8:30）を過ぎていれば、確定は締め前に装えず、拒否が残る
    const run = (await store.last())!.seq;
    clock.set(jst("2026-11-10", 8, 31));
    const late = await store.commitSheet("ai-a", { tradingDate: "2026-11-10", orders: [], runSeq: run, inputSeqs: [4] });
    expect(late).toMatchObject({ ok: true, rejected: "after_cutoff" });
    const last = (await store.last())!;
    expect(last.type).toBe("order_sheet.rejected");
    expect(last.recordedAt).toBe(jst("2026-11-10", 8, 31));
  });

  it("時計が戻れば拒む（recordedAt は減らない）", async () => {
    const { store, clock } = newStore();
    await seedAgent(store, clock);
    clock.set(jst("2026-11-09", 21, 59));
    expect((await store.append(sys("source.captured", { publishedAt: jst("2026-11-09", 15, 30), fetchedAt: jst("2026-11-09", 21, 59) }))).ok).toBe(false);
  });

  it("read は afterSeq より後を seq の昇順で返し、連鎖は検査に通る。引数が外れたら RangeError", async () => {
    const { store, clock } = newStore();
    await seedAgent(store, clock);
    const all = await store.read();
    expect(all.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect((await store.read(2, 2)).map((e) => e.seq)).toEqual([3, 4]);
    expect(await store.read(5)).toEqual([]);
    expect(await verifyChain(all)).toEqual([]);
    for (const [a, l] of [[-1, 1], [1.5, 1], [0, 0], [0, 1.5]] as const) await expect(store.read(a, l)).rejects.toThrow(RangeError);
  });

  it("注文票は commitSheet からだけ書ける。未登録のAIは拒む", async () => {
    const { store, clock } = newStore();
    const run = await seedAgent(store, clock);
    const sheet = { tradingDate: "2026-11-10", orders: [], runSeq: run, inputSeqs: [4] };
    clock.set(jst("2026-11-10", 8));
    const viaAppend = await store.append({ type: "order_sheet.committed", actor: "agent:ai-a", refs: [run], payload: sheet });
    expect(viaAppend).toEqual({ ok: false, reason: "use commitSheet" });
    const r = await store.commitSheet("ai-a", sheet);
    expect(r.ok && r.event.type).toBe("order_sheet.committed");
    expect((await store.commitSheet("ai-zzz", sheet)).ok).toBe(false);
  });

  it("同時に呼んでも1件ずつ直列に書かれ、seq が抜けない", async () => {
    const { store, clock } = newStore();
    await seedAgent(store, clock);
    const src = sys("source.captured", { publishedAt: jst("2026-11-09", 15, 30), fetchedAt: jst("2026-11-09", 22) });
    const rs = await Promise.all([1, 2, 3].map(() => store.append(src)));
    expect(rs.every((r) => r.ok)).toBe(true);
    expect((await store.read()).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("更新・削除の口がない（型にも実体にも）", () => {
    const { store } = newStore();
    // @ts-expect-error 削除の口は契約にない
    void store.delete;
    // @ts-expect-error 更新の口は契約にない
    void store.update;
    expect(["delete", "update", "remove", "set", "truncate"].filter((k) => k in store)).toEqual([]);
  });

  it("読むだけの口は追記の口を持たない。注文を出せない保管は commitSheet を持たない", () => {
    const { store } = newStore();
    const reader: EventReader = store;
    // @ts-expect-error EventReader に append はない
    void reader.append;
    const orderless: OrderlessEventStore = store;
    // @ts-expect-error OrderlessEventStore に commitSheet はない（試運転で注文を出せない）
    void orderless.commitSheet;
    expect(typeof orderless.append).toBe("function");
  });
});

describe("MarketDataPort（先読みを型で防ぐ）", () => {
  const open = (date: string, price: number, publishedAt: number, symbol = "TSTA"): PriceObservation => ({ symbol, date, kind: "open", price, publishedAt, source: "fixture" });
  const close = (date: string, price: number, publishedAt: number, volume = 1000): PriceObservation => ({ symbol: "TSTA", date, kind: "close", price, volume, publishedAt, source: "fixture" });
  const clock = new FakeClock(jst("2026-11-13", 0));
  const port: MarketDataPort = new MemoryMarketData(
    [
      close("2026-11-10", 1_010_0, jst("2026-11-10", 15, 30)),
      open("2026-11-10", 1_000_0, jst("2026-11-10", 9)),
      open("2026-11-11", 1_020_0, jst("2026-11-11", 9)),
      close("2026-11-11", 1_030_0, jst("2026-11-11", 15, 30)),
      open("2026-11-11", 2_000_0, jst("2026-11-11", 9), "TSTB"),
    ],
    clock,
  );

  it("窓には at より前に公開された観測だけが見える。at ちょうどに公開されたものは含まない", async () => {
    for (const at of [jst("2026-11-10", 8), jst("2026-11-10", 9), jst("2026-11-10", 15, 29), jst("2026-11-10", 15, 30), jst("2026-11-11", 12), jst("2026-11-12", 0)]) {
      for (const o of await port.asOf(at).history("TSTA")) expect(o.publishedAt).toBeLessThan(at);
    }
    expect((await port.asOf(jst("2026-11-10", 9)).history("TSTA")).length).toBe(0);
    expect((await port.asOf(jst("2026-11-10", 9) + 1).history("TSTA")).map((o) => o.kind)).toEqual(["open"]);
  });

  it("at が現在時刻より後なら断る（未来や Infinity で全部を見られない）", () => {
    expect(() => port.asOf(clock.now() + 1)).toThrow(RangeError);
    expect(() => port.asOf(Infinity)).toThrow(RangeError);
    expect(() => port.asOf(NaN)).toThrow(RangeError);
    expect(port.asOf(clock.now()).at).toBe(clock.now());
  });

  it("11/11 の始値の時点では、11/11 の終値は見えない（答えを知らない）", async () => {
    const view = port.asOf(jst("2026-11-11", 9, 30));
    expect((await view.latest("TSTA", "open"))?.price).toBe(1_020_0);
    expect((await view.latest("TSTA", "close"))?.date).toBe("2026-11-10");
    expect(view.at).toBe(jst("2026-11-11", 9, 30));
  });

  it("出来高は終値の観測にだけあり、始値の観測には型の上でも載せられない", async () => {
    // @ts-expect-error 始値の観測に出来高は載せられない
    const bad: PriceObservation = { symbol: "TSTA", date: "2026-11-11", kind: "open", price: 1, volume: 1000, publishedAt: 1, source: "x" };
    void bad;
    const mid = await port.asOf(jst("2026-11-11", 12)).history("TSTA");
    expect(mid.filter((o) => o.kind === "open").every((o) => !("volume" in o))).toBe(true);
    expect(mid.filter((o) => o.date === "2026-11-11").map((o) => o.kind)).toEqual(["open"]);
  });

  it("履歴は日付の昇順で、limit は新しい方から数える。ほかの銘柄は混ざらない", async () => {
    const view = port.asOf(jst("2026-11-12", 0));
    expect((await view.history("TSTA")).map((o) => `${o.date}/${o.kind}`)).toEqual(["2026-11-10/open", "2026-11-10/close", "2026-11-11/open", "2026-11-11/close"]);
    expect((await view.history("TSTA", 1)).map((o) => `${o.date}/${o.kind}`)).toEqual(["2026-11-11/close"]);
    expect((await view.history("TSTB")).length).toBe(1);
    expect(await view.history("NOPE")).toEqual([]);
    expect(await view.latest("NOPE", "close")).toBeNull();
  });

  it("公開時刻が同じなら始値が先。改訂は、より後の公開時刻の新しい観測で表し、過去の窓には見えない", async () => {
    const t = jst("2026-11-10", 15, 30);
    const p = new MemoryMarketData([close("2026-11-10", 1_010_0, t), open("2026-11-10", 1_000_0, t), close("2026-11-10", 1_011_0, t + 3_600_000)], clock);
    expect((await p.asOf(t + 1).history("TSTA")).map((o) => o.kind)).toEqual(["open", "close"]);
    expect((await p.asOf(t + 1).latest("TSTA", "close"))?.price).toBe(1_010_0);
    expect((await p.asOf(t + 3_600_001).latest("TSTA", "close"))?.price).toBe(1_011_0);
  });

  it("窓には at・history・latest だけがある（日付や時刻を指定して未来を引く口はない）", () => {
    const view = port.asOf(0);
    // @ts-expect-error 未来を引く口は契約にない
    void view.future;
    expect(Object.keys(view).sort()).toEqual(["at", "history", "latest"]);
  });
});

describe("LlmPort", () => {
  const policy = { dailyCostLimit: 25, dryRun: false };
  const req = (maxCost: number): LlmRequest => ({
    agentId: "ai-a",
    purpose: "order",
    model: { provider: "fake", modelId: "fake-1", settings: { temperature: "0.2" } },
    prompt: { id: "order", version: "1", hash: "b".repeat(64) },
    inputSeqs: [4],
    messages: [{ role: "user", content: "x" }],
    maxCost,
  });

  it("出力・費用・応答したモデル・時刻を返し、その日の費用が積み上がる", async () => {
    const llm: LlmPort = new FakeLlm(policy, new FakeClock(jst("2026-11-09", 22)), ["a", "b"], 10);
    const r = await llm.complete(req(10));
    expect(r).toMatchObject({ ok: true, output: "a", usage: { cost: 10 }, respondedModel: "fake-1-fake" });
    expect(await llm.spent("2026-11-09")).toBe(10);
    expect(await llm.spent("2026-11-10")).toBe(0);
  });

  it("使用済み＋maxCost が上限ちょうどなら通り、1でも超えれば呼ばずに budget_exceeded。翌日は呼べる", async () => {
    const clock = new FakeClock(jst("2026-11-09", 22));
    const fake = new FakeLlm(policy, clock, ["a"], 10);
    expect((await fake.complete(req(10))).ok).toBe(true);
    expect((await fake.complete(req(15))).ok).toBe(true); // 10 + 15 = 25（ちょうど）。費用は costPerCall の10
    expect(await fake.spent("2026-11-09")).toBe(20);
    expect(await fake.complete(req(6))).toMatchObject({ ok: false, errorCode: "budget_exceeded", usage: { cost: 0 } }); // 20 + 6 > 25
    expect(fake.calls.length).toBe(2);
    clock.set(jst("2026-11-10", 0, 1));
    expect((await fake.complete(req(10))).ok).toBe(true);
  });

  it("費用は maxCost を超えない", async () => {
    const llm = new FakeLlm(policy, new FakeClock(jst("2026-11-09", 22)), ["a"], 10);
    expect(await llm.complete(req(4))).toMatchObject({ ok: true, usage: { cost: 4 } });
  });

  it("同時に呼ばれても上限を超えず、費用を少なく数えない", async () => {
    const llm = new FakeLlm(policy, new FakeClock(jst("2026-11-09", 22)), ["a"], 10);
    const rs = await Promise.all([1, 2, 3, 4].map(() => llm.complete(req(10))));
    expect(rs.map((r) => r.ok)).toEqual([true, true, false, false]);
    expect(await llm.spent("2026-11-09")).toBe(20);
  });

  it("試運転は policy で表し、そのとき runner が使う保管には commitSheet がない", () => {
    const llm: LlmPort = new FakeLlm({ dailyCostLimit: 0, dryRun: true }, new FakeClock(0), ["a"], 0);
    expect(llm.policy).toEqual({ dailyCostLimit: 0, dryRun: true });
    const { store } = newStore();
    const orderless = (s: EventStore): OrderlessEventStore => ({ read: (a, l) => s.read(a, l), last: () => s.last(), append: (d) => s.append(d) });
    const forRun: EventStore | OrderlessEventStore = llm.policy.dryRun ? orderless(store) : store;
    expect("commitSheet" in forRun).toBe(false);
    expect(typeof forRun.append).toBe("function");
  });
});
