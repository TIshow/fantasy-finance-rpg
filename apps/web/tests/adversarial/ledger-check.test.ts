// 検証役（#85 の実装 #95 の確認）：台帳の「書く前に確かめる」口（Ledger.check）を壊しにいく。
// 成り立つはずのこと：(1) check は状態を変えず、何度呼んでもそのあとの apply に影響しない。(2) check と apply の答えは一致する（通るなら通る、断るなら同じ理由）。
// (3) 形の崩れた入力でも check は例外にせず理由を返す。(4) 止まった台帳では check も apply も断る。(5) 同時の apply で台帳がずれない。
import { describe, expect, it } from "vitest";
import { Ledger } from "../../src/events/replay";
import type { LogEvent } from "../../src/events/types";
import { buildGoldenLog } from "../fixtures/golden";

const SEED = 20261105;

async function golden() {
  const g = await buildGoldenLog(SEED);
  const upTo = async (n: number) => {
    const l = new Ledger(g.values);
    for (const e of g.events.slice(0, n)) await l.apply(e);
    return l;
  };
  const snapshot = (l: Ledger) =>
    JSON.stringify(
      g.scenario.agents.map((a) => {
        try {
          return l.account(a.id);
        } catch (err) {
          return String(err); // まだ登録していないAI、または止まった台帳
        }
      }),
    );
  return { g, upTo, snapshot };
}

describe("(1) check は状態を変えない", () => {
  it("壊したイベントを何度 check しても、そのあと正しいイベントを apply でき、最後の口座は check しない台帳と同じ", async () => {
    const { g, upTo, snapshot } = await golden();
    const l = await upTo(0);
    for (const e of g.events) {
      const p = e.payload as Record<string, unknown>;
      // 同じ seq に、壊したもの（台帳が確かめる項目を全部壊す）を3回 check してから、正しいものを当てる
      const broken = { type: e.type, payload: { ...p, accountHash: "f".repeat(64), total: -1, initialCash: -1, valuesHash: "0".repeat(64), fills: [], actions: [] } };
      const before = snapshot(l);
      for (let i = 0; i < 3; i++) await l.check(broken);
      expect(snapshot(l), `seq ${e.seq}`).toBe(before);
      expect(await l.check(e), `seq ${e.seq}`).toBeNull();
      await l.apply(e);
    }
    for (const a of g.scenario.agents) expect(l.account(a.id)).toEqual(g.ledger.account(a.id));
  });

  // 口座だけでなく、台帳の中の終値の履歴に漏れないこと。正しい形の別の終値を check で通しても、あとの評価・約定・分割の端数に出てこない
  it("別の値の終値を check で通しても、終値の履歴に残らず、あとの評価や約定の照合がすべて通る", async () => {
    const { g, upTo } = await golden();
    const store = g.values as unknown as { putValue(v: unknown): Promise<string>; get(h: string): { value: unknown } | undefined };
    const l = await upTo(0);
    let checked = 0;
    for (const e of g.events) {
      if (e.type === "prices.close") {
        const p = e.payload as Record<string, unknown>;
        const real = store.get(p.valuesHash as string)!.value as Record<string, number | null>;
        const other = Object.fromEntries(Object.entries(real).map(([s, v]) => [s, v === null ? null : v * 3 + 10]));
        const variant = { type: e.type, payload: { ...p, valuesHash: await store.putValue(other) } };
        expect(await l.check(variant), `seq ${e.seq}`).toBeNull();
        checked++;
      }
      await l.apply(e);
    }
    expect(checked).toBeGreaterThan(0);
    for (const a of g.scenario.agents) expect(l.account(a.id)).toEqual(g.ledger.account(a.id));
  });

  it("check は seq を進めない（check のあとに、同じ seq の別のイベントを apply できる）", async () => {
    const { g, upTo } = await golden();
    const n = g.events.findIndex((e) => e.type === "fills.executed");
    const l = await upTo(n);
    expect(await l.check(g.events[n]!)).toBeNull();
    expect(await l.check(g.events[n]!)).toBeNull();
    await l.apply(g.events[n]!);
    await expect(l.apply(g.events[n]!)).rejects.toThrow(/out of order/);
  });
});

describe("(3) 形の崩れた入力", () => {
  it("中身が null・配列・文字列・数・getter が例外を投げるオブジェクトでも、check は例外にせず理由を返し、台帳は止まらない", async () => {
    const { g, upTo } = await golden();
    const n = g.events.findIndex((e) => e.type === "corporate_actions.applied");
    const l = await upTo(n);
    const trap = new Proxy({}, { get: () => { throw new Error("trap"); } });
    const payloads: unknown[] = [null, [], "x", 1, undefined, trap, { agentId: "nobody", accountHash: "x" }, { agentId: "__proto__" }];
    const types: LogEvent["type"][] = ["agent.registered", "prices.open", "prices.close", "corporate_action.announced", "fills.executed", "corporate_actions.applied", "valuation.recorded"];
    for (const type of types) {
      for (const [i, payload] of payloads.entries()) {
        const why = await l.check({ type, payload });
        expect(typeof why, `${type} ${i}`).toBe("string");
      }
    }
    // 断ったあとも台帳は止まっていない
    expect(await l.check(g.events[n]!)).toBeNull();
    await l.apply(g.events[n]!);
  });

  it("台帳が確かめない種類（注文票・投稿など）は、中身によらず check が通る（追記の検査に任せる）", async () => {
    const { upTo } = await golden();
    const l = await upTo(5);
    for (const type of ["order_sheet.committed", "post.published", "agent.suspended"] as const) expect(await l.check({ type, payload: null }), type).toBeNull();
  });
});

describe("(4) 止まった台帳", () => {
  it("apply が断ったら台帳は止まり、そのあとは正しいイベントでも check が理由を返し、apply も断る", async () => {
    const { g, upTo } = await golden();
    const n = g.events.findIndex((e) => e.type === "valuation.recorded");
    const l = await upTo(n);
    const e = g.events[n]!;
    const bad = { ...e, payload: { ...(e.payload as Record<string, unknown>), total: -1 } } as LogEvent;
    const why = await l.check(bad);
    expect(why).not.toBeNull();
    await expect(l.apply(bad)).rejects.toThrow(why!);
    expect(await l.check(e)).toBe(`ledger stopped at seq ${e.seq}`);
    await expect(l.apply(e)).rejects.toThrow(`ledger stopped at seq ${e.seq}`);
  });
});

describe("(5) 同時の apply", () => {
  it("同じ seq を同時に2回当てると、2回目は断り、台帳は止まる（口座も読めなくなり、ずれた状態で進まない）", async () => {
    const { g, upTo, snapshot } = await golden();
    const n = g.events.findIndex((e) => e.type === "fills.executed");
    const l = await upTo(n);
    const results = await Promise.allSettled([l.apply(g.events[n]!), l.apply(g.events[n]!)]);
    // どちらが先に評価を終えるかは決まらない。1回は当たり、もう1回は断る
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(String(results.find((r): r is PromiseRejectedResult => r.status === "rejected")!.reason)).toMatch(/applied concurrently/);
    expect(await l.check(g.events[n + 1]!)).toBe(`ledger stopped at seq ${n + 1}`);
    await expect(l.apply(g.events[n + 1]!)).rejects.toThrow(/ledger stopped/);
    expect(snapshot(l)).toMatch(/ledger stopped/);
  });

  it("次の seq を先回りして当てようとすると、順序の違いで断り、台帳は止まらない", async () => {
    const { g, upTo } = await golden();
    const n = g.events.findIndex((e) => e.type === "prices.close");
    const l = await upTo(n);
    const results = await Promise.allSettled([l.apply(g.events[n]!), l.apply(g.events[n + 1]!)]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
    expect(String((results[1] as PromiseRejectedResult).reason)).toMatch(/out of order/);
    expect(await l.check(g.events[n + 1]!)).toBeNull();
    await l.apply(g.events[n + 1]!);
  });

  // 片方が評価で失敗すると台帳は止まる。もう片方（正しいもの）が評価を終えて当たっても、止まったまま進まないこと
  it("同じ seq の壊したものと正しいものを同時に当てると、台帳は止まり、そのあとは check も apply も断る", async () => {
    const { g, upTo } = await golden();
    const n = g.events.findIndex((e) => e.type === "fills.executed");
    const e = g.events[n]!;
    const bad = { ...e, payload: { ...(e.payload as Record<string, unknown>), accountHash: "f".repeat(64) } } as LogEvent;
    for (const order of [[bad, e], [e, bad]]) {
      const l = await upTo(n);
      const results = await Promise.allSettled(order.map((x) => l.apply(x)));
      expect(results.some((r) => r.status === "rejected")).toBe(true);
      expect(await l.check(g.events[n + 1]!)).toMatch(/ledger stopped/);
      await expect(l.apply(g.events[n + 1]!)).rejects.toThrow(/ledger stopped/);
    }
  });

  it("apply の途中の check は、まだ当てていない seq を見る（同じ直列の区間で使う前提。答えが古くなることの確認）", async () => {
    const { g, upTo } = await golden();
    const n = g.events.findIndex((e) => e.type === "fills.executed");
    const l = await upTo(n);
    const applying = l.apply(g.events[n]!);
    // apply の完了を待たずに、同じイベントを check すると、まだ seq n を当てる前とみなして通す
    expect(await l.check(g.events[n]!)).toBeNull();
    await applying;
    expect(await l.check(g.events[n]!)).not.toBeNull(); // 当てたあとは、次の seq（n+1）として見るので合わない
  });
});
