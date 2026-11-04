// 検証役（#59 PR-1）：連鎖の検査（docs/EVENT_LOG.md §5.1）を、改ざんと正規化の境界の入力で壊しにいく。
import { describe, expect, it } from "vitest";
import { EventLog, type Draft } from "../../src/events/append";
import { canonicalize, CanonicalizeError } from "../../src/events/canonical";
import { sealEvent, verifyChain } from "../../src/events/chain";
import { eventHash } from "../../src/events/hash";
import type { LogEvent } from "../../src/events/types";
import type { HolidayTable } from "../../src/holidays/table";
import { newAccount } from "../../src/ledger/ledger";
import { INITIAL_CASH } from "../../src/ledger/types";

const jst = (date: string, hh: number, mm = 0) => Date.parse(`${date}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+09:00`);
const SHA = "c".repeat(64);
const TABLE: HolidayTable = { firstYear: 2026, lastYear: 2027, sourceSha256: "0".repeat(64), contentSha256: SHA, dates: new Set() };

/** 登録 → 出典 → run → 確定 → 始値 → 約定 → 終値 → 評価 → 引け後処理 の、一意キーと refs を含む本物のログ */
async function realLog(): Promise<LogEvent[]> {
  const log = new EventLog({ holidayTables: new Map([[SHA, TABLE]]), accountOf: () => newAccount() });
  const add = async (d: Draft) => {
    const r = await log.append(d);
    if (!r.ok) throw new Error(`${d.type}: ${r.reason}`);
    return r.event.seq;
  };
  const sys = (type: Draft["type"], at: number, payload: Record<string, unknown>, refs: number[] = []): Draft => ({ type, recordedAt: at, actor: "system", refs, payload });
  await add({ type: "holidays.adopted", recordedAt: 0, actor: "operator:owner", refs: [], payload: { holidaysSha256: SHA } });
  await add({ type: "universe.set", recordedAt: 0, actor: "operator:owner", refs: [], payload: { symbols: ["AAA"] } });
  await add({ type: "agent.registered", recordedAt: jst("2026-11-09", 20), actor: "operator:owner", refs: [], payload: { agentId: "alpha", startDate: "2026-11-10", initialCash: INITIAL_CASH } });
  const src = await add(sys("source.captured", jst("2026-11-09", 21), { publishedAt: jst("2026-11-09", 19), fetchedAt: jst("2026-11-09", 21) }));
  const run = await add(sys("agent.run", jst("2026-11-09", 22), { agentId: "alpha", purpose: "order", inputSeqs: [src], ok: true }, [src]));
  const c = await log.commitSheet(jst("2026-11-10", 8), "alpha", { tradingDate: "2026-11-10", orders: [{ symbol: "AAA", side: "buy", qty: 100 }], runSeq: run, inputSeqs: [src] });
  if (!c.ok || c.event.type !== "order_sheet.committed") throw new Error("commit failed");
  const open = await add(sys("prices.open", jst("2026-11-10", 9), { date: "2026-11-10" }));
  await add(sys("fills.executed", jst("2026-11-10", 9, 1), { agentId: "alpha", tradingDate: "2026-11-10", sheetSeq: c.event.seq, openSeq: open }, [c.event.seq, open]));
  const close = await add(sys("prices.close", jst("2026-11-10", 15, 40), { date: "2026-11-10" }));
  await add(sys("valuation.recorded", jst("2026-11-10", 15, 41), { agentId: "alpha", date: "2026-11-10", closeSeq: close }, [close]));
  await add(sys("corporate_actions.applied", jst("2026-11-10", 15, 42), { agentId: "alpha", asOf: "2026-11-10", exDate: "2026-11-11", announcedSeqs: [] }));
  return log.events;
}

/** 凍結を外した深い写し */
const thaw = (events: readonly LogEvent[]) => JSON.parse(JSON.stringify(events)) as Record<string, unknown>[];

/** 1件の1項目を書き換える改ざん（どの項目もハッシュの対象） */
const MUTATIONS: [string, (e: Record<string, unknown>) => void][] = [
  ["type", (e) => (e.type = e.type === "agent.run" ? "source.captured" : "agent.run")],
  ["recordedAt", (e) => (e.recordedAt = (e.recordedAt as number) + 1)],
  ["actor", (e) => (e.actor = e.actor === "system" ? "operator:owner" : "system")],
  ["keys", (e) => (e.keys = [...(e.keys as string[]), "x:extra"])],
  ["refs", (e) => (e.refs = (e.refs as number[]).length > 0 ? [] : (e.seq as number) > 1 ? [1] : e.refs)],
  ["payload", (e) => (e.payload = { ...(e.payload as object), tampered: 1 })],
  ["schema", (e) => (e.schema = 2)],
];

describe("改ざん（§5.1）", () => {
  it("どのイベントのどの項目を書き換えても、そのイベントで連鎖の検査が落ちる", async () => {
    const events = await realLog();
    expect(await verifyChain(events)).toEqual([]);
    for (let i = 0; i < events.length; i++) {
      for (const [field, mutate] of MUTATIONS) {
        const t = thaw(events);
        const before = JSON.stringify(t[i]);
        mutate(t[i]!);
        if (JSON.stringify(t[i]) === before) continue; // refs を足せない seq 1 など
        const problems = await verifyChain(t);
        expect(problems.some((p) => p.startsWith(`event #${i} `)), `#${i} ${field}: ${problems.join(" | ")}`).toBe(true);
      }
    }
  });

  it("書き換えたイベントだけハッシュを付け直しても、次のイベントの prevHash で落ちる（最後の1件を除く）", async () => {
    const events = await realLog();
    for (let i = 0; i < events.length - 1; i++) {
      const t = thaw(events);
      t[i]!.payload = { ...(t[i]!.payload as object), tampered: 1 };
      const { hash: _h, ...rest } = t[i]!;
      t[i]!.hash = await eventHash(rest as Omit<LogEvent, "hash">);
      expect(await verifyChain(t), `#${i}`).toContain(`event #${i + 1} (seq ${i + 2} (number)): prevHash does not match the previous event`);
    }
  });

  it("抜き取り・入れ替え・重複・挿入は、どの位置でも落ちる", async () => {
    const events = await realLog();
    const n = events.length;
    for (let i = 0; i < n; i++) {
      if (i < n - 1) expect((await verifyChain(events.filter((_, j) => j !== i))).length, `drop #${i}`).toBeGreaterThan(0);
      if (i < n - 1) {
        const s = [...events];
        [s[i], s[i + 1]] = [s[i + 1]!, s[i]!];
        expect((await verifyChain(s)).length, `swap #${i}`).toBeGreaterThan(0);
      }
      expect((await verifyChain([...events.slice(0, i + 1), events[i]!, ...events.slice(i + 1)])).length, `dup #${i}`).toBeGreaterThan(0);
    }
    expect((await verifyChain([events[0]!, events[0]!])).length).toBeGreaterThan(0);
  });

  it("限界（文書どおり）：末尾を切り落としたログは、連鎖の検査だけでは見つからない", async () => {
    // §5.1 の限界：seq と hash を外に出すまでは検出できない。検出するようになったら、この期待を変える
    const events = await realLog();
    expect(await verifyChain(events.slice(0, -3))).toEqual([]);
  });

  it("検査に壊れた値を渡しても例外にせず、問題として返す（循環・深い入れ子・getter・null・配列）", async () => {
    const events = await realLog();
    const deep: unknown[] = [];
    let cur = deep;
    for (let i = 0; i < 100_000; i++) {
      const next: unknown[] = [];
      cur.push(next);
      cur = next;
    }
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const getter = { ...events[0]! } as Record<string, unknown>;
    Object.defineProperty(getter, "payload", { get: () => ({}), enumerable: true });
    const bad: unknown[] = [null, [], 1, "x", { ...events[0], payload: cyclic }, { ...events[0], payload: deep }, { ...events[0], seq: deep }, getter];
    for (const [i, b] of bad.entries()) {
      const problems = await verifyChain([b]);
      expect(problems.length, String(i)).toBeGreaterThan(0);
    }
  });
});

describe("正規化の境界（§5.1）", () => {
  const rejects = (v: unknown) => expect(() => canonicalize(v)).toThrow(CanonicalizeError);

  it("NFC でない文字列・キー、対になっていないサロゲートは、直さずに拒む", () => {
    for (const s of ["e\u0301", "\u212B", "\u1100\u1161", "\uD800", "\uDFFF", "a\uDC00\uD800b"]) {
      rejects(s);
      rejects({ [s]: 1 });
      rejects([s]);
    }
    expect(canonicalize("\u00e9\u{1F600}")).toBe(JSON.stringify("\u00e9\u{1F600}"));
  });

  it("キーは UTF-16 の符号単位の順（RFC 8785）。コードポイント順ではない", () => {
    expect(canonicalize({ "\uFFFD": 1, "\u{1F600}": 2, "\u00f6": 3, "1": 4, "\r": 5 })).toBe(`{"\\r":5,"1":4,"\u00f6":3,"\u{1F600}":2,"\uFFFD":1}`);
  });

  it("数は安全な整数だけ。-0 は 0 と同じハッシュになり、封じたイベントにも 0 で残る", async () => {
    for (const n of [0.1, 1e-7, 5e-324, 2 ** 53, -(2 ** 53), 1e21, NaN, Infinity, -Infinity]) rejects(n);
    rejects(10n);
    expect(canonicalize([Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, 1.0, -0])).toBe(`[${Number.MAX_SAFE_INTEGER},${Number.MIN_SAFE_INTEGER},1,0]`);
    const draft = { type: "source.captured" as const, recordedAt: -0, actor: "system" as const, keys: [], refs: [], payload: { x: -0 } };
    const e = await sealEvent(null, draft);
    expect(Object.is(e.recordedAt, 0) && Object.is((e.payload as { x: number }).x, 0)).toBe(true);
    expect(await verifyChain([e])).toEqual([]);
  });

  it("入れ子は外側を0段として64段まで。65段は拒み、10万段でもスタックを溢れさせない", () => {
    const nest = (n: number) => {
      let v: unknown = 0;
      for (let i = 0; i < n; i++) v = [v];
      return v;
    };
    expect(() => canonicalize(nest(64))).not.toThrow();
    rejects(nest(65));
    rejects(nest(100_000));
  });

  it("__proto__・constructor という名前の自前のキーは、ただのキーとして封じ、検査を通る", async () => {
    const payload = JSON.parse('{"__proto__":{"agentId":"alpha"},"constructor":1,"publishedAt":0,"fetchedAt":0}') as Record<string, unknown>;
    expect(Object.getPrototypeOf(payload)).toBe(Object.prototype);
    const e = await sealEvent(null, { type: "source.captured", recordedAt: 0, actor: "system", keys: [], refs: [], payload });
    expect(Object.keys(e.payload as object)).toContain("__proto__");
    expect(({} as Record<string, unknown>).agentId).toBeUndefined();
    expect(await verifyChain([e])).toEqual([]);
    expect(await verifyChain(JSON.parse(JSON.stringify([e])))).toEqual([]);
  });

  it("プロトタイプを差し替えた中身・穴・getter・undefined・関数・Date・Map は拒み、追記の処理も理由を返して何も書かない", async () => {
    const withProto = Object.create({ agentId: "alpha" }) as Record<string, unknown>;
    const getter = Object.defineProperty({}, "x", { get: () => 1, enumerable: true });
    for (const v of [withProto, new Array<number>(2), getter, { x: undefined }, [undefined], { f: () => 1 }, new Date(0), new Map(), Symbol("s")]) rejects({ v });
    const log = new EventLog({ holidayTables: new Map([[SHA, TABLE]]), accountOf: () => newAccount() });
    for (const v of [withProto, getter, { x: 0.5 }, { s: "e\u0301" }]) {
      const r = await log.append({ type: "source.captured", recordedAt: 0, actor: "system", refs: [], payload: { publishedAt: 0, fetchedAt: 0, v } });
      expect(r.ok).toBe(false);
    }
    expect(log.events).toEqual([]);
  });
});
