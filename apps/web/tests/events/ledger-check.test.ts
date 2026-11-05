// 台帳の「書く前に確かめる」口（Ledger.check。#85）。check は apply と同じ判定を、状態を変えずに行う。
// ゴールデンログの全件と、そこから1か所だけ壊したイベントで、check と apply の答えが一致することを確かめる。
import { describe, expect, it } from "vitest";
import { bodyHash } from "../../src/events/hash";
import { Ledger, type ValueStore } from "../../src/events/replay";
import type { LogEvent } from "../../src/events/types";
import { buildGoldenLog } from "../fixtures/golden";
import { mulberry32, randInt } from "../fixtures/prng";

/** 台帳が中身を確かめるイベントを、1か所だけ壊す（どれも apply が断るはずのもの） */
function corrupt(e: LogEvent): LogEvent | null {
  const p = e.payload as Record<string, unknown>;
  const bad = (patch: Record<string, unknown>) => ({ ...e, payload: { ...p, ...patch } });
  switch (e.type) {
    case "agent.registered":
      return bad({ initialCash: (p.initialCash as number) + 1 });
    case "prices.open":
    case "prices.close":
    case "corporate_action.announced":
      return bad({ valuesHash: "0".repeat(64) });
    case "fills.executed":
    case "corporate_actions.applied":
      return bad({ accountHash: "f".repeat(64) });
    case "valuation.recorded":
      return bad({ total: (p.total as number) + 1 });
    default:
      return null;
  }
}

async function ledgerUpTo(events: readonly LogEvent[], values: ConstructorParameters<typeof Ledger>[0], n: number) {
  const l = new Ledger(values);
  for (const e of events.slice(0, n)) await l.apply(e);
  return l;
}

describe("Ledger.check（#85）", () => {
  for (const seed of [20261104, 20261105]) {
    it(`ゴールデンログ（シード ${seed}）の全件で、check が通り、そのあと apply も通る`, async () => {
      const g = await buildGoldenLog(seed);
      const l = new Ledger(g.values);
      for (const e of g.events) {
        expect(await l.check(e), `seq ${e.seq} ${e.type}`).toBeNull();
        await l.apply(e);
      }
      for (const a of g.scenario.agents) expect(l.account(a.id)).toEqual(g.ledger.account(a.id));
    });

    it(`1か所壊したイベント（シード ${seed}）は、check が理由を返して断り、apply も断る。check は状態を変えない`, async () => {
      const g = await buildGoldenLog(seed);
      const targets = g.events.filter((e) => corrupt(e) !== null);
      const rand = mulberry32(seed);
      // 種類ごとに少なくとも1件、ほかは無作為に選ぶ
      const picked = new Map<string, LogEvent>();
      for (const e of targets) if (!picked.has(e.type)) picked.set(e.type, e);
      for (let i = 0; i < 12; i++) {
        const e = targets[randInt(rand, 0, targets.length - 1)]!;
        picked.set(`${e.type}:${e.seq}`, e);
      }
      // ゴールデンログに公表はない（公表の値の検査は announcement.test.ts）。ほかの6種類はすべて通る
      expect(new Set([...picked.values()].map((e) => e.type)).size).toBe(6);
      for (const e of picked.values()) {
        const bad = corrupt(e)!;
        const l = await ledgerUpTo(g.events, g.values, e.seq - 1);
        const why = await l.check(bad);
        expect(why, `seq ${e.seq} ${e.type}`).toEqual(expect.any(String));
        // 断ったあとも状態は変わらず、元のイベントは通って当てられる
        expect(await l.check(e)).toBeNull();
        await l.apply(e);
        // apply も同じものを断る（同じ判定なので、理由の文も同じ）
        const fresh = await ledgerUpTo(g.events, g.values, e.seq - 1);
        await expect(fresh.apply(bad)).rejects.toHaveProperty("message", why);
      }
    });
  }

  it("ログの外の値：形の違う始値・ハッシュの合わない値・種類の違う公表を、check も apply も同じ理由で断る（始値は約定を待たずに断る）", async () => {
    const g = await buildGoldenLog(20261104);
    // ゴールデンログの値に、壊した値を足した置き場
    const extra = new Map<string, { salt: Uint8Array; value: unknown }>();
    const values: ValueStore = { get: (h) => extra.get(h) ?? g.values.get(h) };
    const put = async (value: unknown, salt = new Uint8Array(16).fill(7)) => {
      const h = await bodyHash(salt, { value });
      extra.set(h, { salt: new Uint8Array(16).fill(7), value });
      return h;
    };
    const wrongSalt = await put({ TSTA: 100 }, new Uint8Array(16).fill(8));
    const i = g.events.findIndex((e) => e.type === "prices.open" && e.seq > 10);
    const open = g.events[i]!;
    const cases: [LogEvent["type"], Record<string, unknown>, string][] = [
      ["prices.open", { ...(open.payload as object), valuesHash: await put({ TSTA: -1 }) }, "values have the wrong shape for prices.open"],
      ["prices.open", { ...(open.payload as object), valuesHash: await put([1, 2]) }, "values have the wrong shape for prices.open"],
      ["prices.open", { ...(open.payload as object), valuesHash: wrongSalt }, "values do not match valuesHash"],
      ["corporate_action.announced", { symbol: "TSTA", kind: "split", exDate: "2026-11-16", valuesHash: await put({ kind: "dividend", perShare: 10 }) }, "announced kind split does not match the values (dividend)"],
      ["corporate_action.announced", { symbol: "TSTA", kind: "dividend", exDate: "2026-11-16", valuesHash: await put({ kind: "dividend", perShare: -1 }) }, "values have the wrong shape for corporate_action.announced"],
    ];
    for (const [type, payload, reason] of cases) {
      const l = await ledgerUpTo(g.events, values, i);
      const why = await l.check({ type, payload });
      expect(why, reason).toBe(`seq ${i + 1}: ${reason}`);
      await expect(l.apply({ ...open, type, payload })).rejects.toHaveProperty("message", why);
    }
    // 形どおりの公表は通る
    const l = await ledgerUpTo(g.events, values, i);
    expect(await l.check({ type: "corporate_action.announced", payload: { symbol: "TSTA", kind: "dividend", exDate: "2026-11-16", valuesHash: await put({ kind: "dividend", perShare: 10 }) } })).toBeNull();
  });

  it("同じ seq を同時に2回当てようとすると、2回目は止まる（呼び出し側は1件ずつ当てる）", async () => {
    const g = await buildGoldenLog(20261104);
    const i = g.events.findIndex((e) => e.type === "fills.executed");
    const l = await ledgerUpTo(g.events, g.values, i);
    const results = await Promise.allSettled([l.apply(g.events[i]!), l.apply(g.events[i]!)]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
  });

  it("止まった台帳では、check も理由を返す", async () => {
    const g = await buildGoldenLog(20261104);
    const i = g.events.findIndex((e) => e.type === "fills.executed");
    const l = await ledgerUpTo(g.events, g.values, i);
    await expect(l.apply(corrupt(g.events[i]!)!)).rejects.toThrow();
    expect(await l.check(g.events[i]!)).toBe(`ledger stopped at seq ${i + 1}`);
  });
});
