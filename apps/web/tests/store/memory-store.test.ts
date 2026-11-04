import { describe, expect, it } from "vitest";
import type { DraftInput } from "../../src/contracts";
import type { ValueStore } from "../../src/events/replay";
import { InMemoryEventStore } from "../../src/store/memory-store";
import { describeEventStoreContract, holidayTable, seedAgent } from "../contracts/conformance";
import { FakeClock, jst } from "../contracts/fakes";
import { buildGoldenLog } from "../fixtures/golden";

const noValues: ValueStore = { get: () => undefined };
const tables = new Map([[holidayTable.contentSha256, holidayTable]]);

describeEventStoreContract("InMemoryEventStore", (env) => new InMemoryEventStore(noValues, env.holidayTables, env.clock));

describe("InMemoryEventStore の作り直しと台帳", async () => {
  const g = await buildGoldenLog(20261104);
  const lastAt = g.events.at(-1)!.recordedAt;

  it("ゴールデンログのイベントから、同じ最後のハッシュと口座に作り直せる", async () => {
    const store = await InMemoryEventStore.fromEvents(g.events, g.values, g.holidayTables, new FakeClock(lastAt));
    expect((await store.last())?.hash).toBe(g.events.at(-1)!.hash);
    for (const a of g.scenario.agents) expect(store.account(a.id)).toEqual(g.ledger.account(a.id));
  });

  it("作り直した保管は、ページ送りで全件を読めて、続けて追記できる", async () => {
    const clock = new FakeClock(lastAt);
    const store = await InMemoryEventStore.fromEvents(g.events, g.values, g.holidayTables, clock, 7);
    const all = [];
    for (let page = await store.read(); page.length > 0; page = await store.read(all.at(-1)!.seq)) all.push(...page);
    expect(all).toEqual(g.events);
    clock.set(lastAt + 1_000);
    const r = await store.append({ type: "source.captured", actor: "system", refs: [], payload: { publishedAt: lastAt, fetchedAt: lastAt + 1_000 } });
    expect(r.ok && r.event.seq).toBe(g.events.length + 1);
  });

  it("1件でも書き換えたログや、ログの外の値が合わないログからは作らない", async () => {
    const tampered = g.events.map((e, i) => (i === 10 ? { ...e, recordedAt: e.recordedAt + 1 } : e));
    await expect(InMemoryEventStore.fromEvents(tampered, g.values, g.holidayTables, new FakeClock(lastAt))).rejects.toThrow();
    await expect(InMemoryEventStore.fromEvents(g.events, noValues, g.holidayTables, new FakeClock(lastAt))).rejects.toThrow("values are not available");
  });

  it("同時に呼ばれた追記は1件ずつ直列になり、seq と recordedAt の順が崩れない", async () => {
    const clock = new FakeClock(0);
    const store = new InMemoryEventStore(noValues, tables, clock);
    await seedAgent(store, clock);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => store.append({ type: "source.captured", actor: "system", refs: [], payload: { publishedAt: jst("2026-11-09", 15, 30), fetchedAt: jst("2026-11-09", 21) } })),
    );
    expect(results.map((r) => r.ok && r.event.seq)).toEqual([6, 7, 8, 9, 10]);
  });

  it("台帳に当てられないイベント（ログの外の値がない終値）が書かれたら、その後の追記を断る", async () => {
    const clock = new FakeClock(0);
    const store = new InMemoryEventStore(noValues, tables, clock);
    await seedAgent(store, clock);
    clock.set(jst("2026-11-10", 16));
    const close: DraftInput = { type: "prices.close", actor: "system", refs: [], payload: { date: "2026-11-10", source: "fixture", fetchedAt: jst("2026-11-10", 16), valuesHash: "b".repeat(64) } };
    await expect(store.append(close)).rejects.toThrow("values are not available");
    await expect(store.append({ type: "universe.set", actor: "operator:owner", refs: [], payload: { symbols: ["TSTA"] } })).rejects.toThrow("store stopped");
    expect(() => store.account("ai-a")).toThrow("ledger stopped");
  });

  it("読み取りの上限が範囲外なら作れない", () => {
    expect(() => new InMemoryEventStore(noValues, tables, new FakeClock(0), 0)).toThrow(RangeError);
  });
});
