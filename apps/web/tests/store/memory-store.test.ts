import { describe, expect, it } from "vitest";
import type { DraftInput } from "../../src/contracts";
import type { ValueStore } from "../../src/events/replay";
import type { LogEvent } from "../../src/events/types";
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

  it("同時に呼ばれた追記は1件ずつ直列になり、recordedAt は直列の中で時計から取るので seq の順に増える", async () => {
    const clock = new FakeClock(0);
    const store = new InMemoryEventStore(noValues, tables, clock);
    await seedAgent(store, clock);
    let t = jst("2026-11-09", 22);
    const ticking = { now: () => (t += 1_000) }; // 呼ばれるたびに進む時計
    const s2 = await InMemoryEventStore.fromEvents(await store.read(), noValues, tables, ticking);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => s2.append({ type: "source.captured", actor: "system", refs: [], payload: { publishedAt: jst("2026-11-09", 15, 30), fetchedAt: jst("2026-11-09", 21) } })),
    );
    const events = results.map((r) => (r.ok ? r.event : null));
    expect(events.map((e) => e?.seq)).toEqual([6, 7, 8, 9, 10]);
    const times = events.map((e) => e!.recordedAt);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(new Set(times).size).toBe(5);
  });

  it("台帳が断るイベント（ログの外の値がない終値）は書かずに断り、保管はそのまま使える", async () => {
    const clock = new FakeClock(0);
    const store = new InMemoryEventStore(noValues, tables, clock);
    await seedAgent(store, clock);
    clock.set(jst("2026-11-10", 16));
    const close: DraftInput = { type: "prices.close", actor: "system", refs: [], payload: { date: "2026-11-10", source: "fixture", fetchedAt: jst("2026-11-10", 16), valuesHash: "b".repeat(64) } };
    expect(await store.append(close)).toEqual({ ok: false, reason: "values are not available" });
    expect((await store.last())?.seq).toBe(5);
    const next = await store.append({ type: "source.captured", actor: "system", refs: [], payload: { publishedAt: jst("2026-11-10", 15, 30), fetchedAt: jst("2026-11-10", 16) } });
    expect(next.ok && next.event.seq).toBe(6);
    expect(store.account("ai-a").cash).toBeGreaterThan(0);
  });

  it("再計算と違う約定、値がない始値は書かずに断り、正しいものは書ける", async () => {
    const at = (type: LogEvent["type"]) => g.events.findIndex((e) => e.type === type && (type !== "prices.open" || e.seq > 4));
    const draftOf = (e: LogEvent): DraftInput => ({ type: e.type as DraftInput["type"], actor: e.actor, refs: [...e.refs], payload: { ...(e.payload as Record<string, unknown>) } });

    const f = at("fills.executed");
    const fe = g.events[f]!;
    const s1 = await InMemoryEventStore.fromEvents(g.events.slice(0, f), g.values, g.holidayTables, new FakeClock(fe.recordedAt));
    const wrong = draftOf(fe);
    wrong.payload.accountHash = "c".repeat(64);
    expect(await s1.append(wrong)).toEqual({ ok: false, reason: "fills do not match the ledger" });
    expect((await s1.append(draftOf(fe))).ok && (await s1.last())?.hash).toBe(fe.hash);

    const o = at("prices.open");
    const oe = g.events[o]!;
    const hidden: ValueStore = { get: (h) => (h === (oe.payload as Record<string, unknown>).valuesHash ? undefined : g.values.get(h)) };
    const s2 = await InMemoryEventStore.fromEvents(g.events.slice(0, o), hidden, g.holidayTables, new FakeClock(oe.recordedAt));
    expect(await s2.append(draftOf(oe))).toEqual({ ok: false, reason: "values are not available" });
    expect((await s2.last())?.seq).toBe(o);
  });

  it("時計が最後のイベントより前なら作り直さない", async () => {
    await expect(InMemoryEventStore.fromEvents(g.events, g.values, g.holidayTables, new FakeClock(lastAt - 1))).rejects.toThrow(RangeError);
  });

  it("読み取りの上限が範囲外なら作れない", () => {
    expect(() => new InMemoryEventStore(noValues, tables, new FakeClock(0), 0)).toThrow(RangeError);
  });
});
