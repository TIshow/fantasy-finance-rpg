// 検証役（#66 の修正 #73 の確認）：拒否した注文票の記録（docs/EVENT_LOG.md §3.2「受け取った注文の並びを残す」・§7 の照合）を壊しにいく。
// 成り立つはずのこと：(a) 正規化できる注文は、拒否の理由が何であっても orders として残る。(b) ordersUnreadable は正規化できないときだけ。
// (c) ordersUnreadable の記録でも、理由はその時点の状態から照合され、偽の理由は落ちる。欠陥の再現は it.fails にして、直ったら it に戻す。
import { describe, expect, it } from "vitest";
import { EventLog, type Draft } from "../../src/events/append";
import { CanonicalizeError, canonicalize } from "../../src/events/canonical";
import { sealEvent } from "../../src/events/chain";
import type { EventType, LogEvent } from "../../src/events/types";
import type { HolidayTable } from "../../src/holidays/table";
import { newAccount } from "../../src/ledger/ledger";
import { INITIAL_CASH, type Order } from "../../src/ledger/types";
import { mulberry32, pick, randInt } from "../fixtures/prng";

const jst = (date: string, hh: number, mm = 0) => Date.parse(`${date}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+09:00`);
const SHA = "d".repeat(64);
const TABLE: HolidayTable = { firstYear: 2026, lastYear: 2027, sourceSha256: "0".repeat(64), contentSha256: SHA, dates: new Set() };
const CTX = { holidayTables: new Map([[SHA, TABLE]]), accountOf: () => newAccount() };
const buy: Order[] = [{ symbol: "AAA", side: "buy", qty: 100 }];

const sys = (type: EventType, recordedAt: number, payload: Record<string, unknown>, refs: number[] = []): Draft => ({ type, recordedAt, actor: "system", refs, payload });
const op = (type: EventType, recordedAt: number, payload: Record<string, unknown>): Draft => ({ type, recordedAt, actor: "operator:owner", refs: [], payload });

async function ok(log: EventLog, d: Draft): Promise<number> {
  const r = await log.append(d);
  if (!r.ok) throw new Error(`${d.type}: ${r.reason}`);
  return r.event.seq;
}

/** 11/9（月）夜に alpha を登録し、出典1件・締めの後の出典1件・注文の agent.run を書いたログ */
async function setup() {
  const log = new EventLog(CTX);
  await ok(log, op("holidays.adopted", 0, { holidaysSha256: SHA }));
  await ok(log, op("universe.set", 0, { symbols: ["AAA"] }));
  await ok(log, op("agent.registered", jst("2026-11-09", 20), { agentId: "alpha", startDate: "2026-11-10", initialCash: INITIAL_CASH }));
  const src = await ok(log, sys("source.captured", jst("2026-11-09", 21), { publishedAt: jst("2026-11-09", 19), fetchedAt: jst("2026-11-09", 21) }));
  const run = await ok(log, sys("agent.run", jst("2026-11-09", 22), { agentId: "alpha", purpose: "order", inputSeqs: [src], ok: true }, [src]));
  const post = await ok(log, sys("agent.run", jst("2026-11-09", 22, 1), { agentId: "alpha", purpose: "post", inputSeqs: [src], ok: true }, [src]));
  return { log, src, run, post };
}

async function admitAll(events: readonly LogEvent[]): Promise<string | null> {
  const log = new EventLog(CTX);
  for (const e of events) {
    const p = await log.admit(e);
    if (p) return p;
  }
  return null;
}

/** 連鎖だけ正しく作り直し、末尾に拒否の記録を1件足したログ（DBに書ける者の改ざん） */
async function withRejected(events: readonly LogEvent[], at: number, payload: Record<string, unknown>, refs: number[] = []): Promise<LogEvent[]> {
  const drafts = [
    ...events.map((e) => ({ type: e.type, recordedAt: e.recordedAt, actor: e.actor, refs: [...e.refs], keys: [...e.keys], payload: e.payload as Record<string, unknown> })),
    { type: "order_sheet.rejected" as const, recordedAt: at, actor: "system" as const, refs, keys: [], payload },
  ];
  const out: LogEvent[] = [];
  for (const d of drafts) out.push(await sealEvent(out.at(-1) ?? null, d));
  return out;
}

const normalizable = (v: unknown) => {
  try {
    canonicalize(v);
    return true;
  } catch (e) {
    if (e instanceof CanonicalizeError) return false;
    throw e;
  }
};

describe("(a) 正規化できる注文は、理由が何であっても orders として残る", () => {
  it("理由ごとの入口で、受け取った注文の並びがそのまま残り、照合を通る", async () => {
    type Case = [string, (x: Awaited<ReturnType<typeof setup>>) => Promise<{ at: number; sheet: Parameters<EventLog["commitSheet"]>[2] }>];
    const s = (orders: unknown, runSeq: unknown, inputSeqs: unknown, tradingDate: unknown = "2026-11-10") => ({ tradingDate, orders, runSeq, inputSeqs }) as Parameters<EventLog["commitSheet"]>[2];
    const at = jst("2026-11-10", 7);
    const cases: Case[] = [
      ["invalid_order", async ({ run, src }) => ({ at, sheet: s("x", run, [src]) })],
      ["invalid_order", async ({ run, src }) => ({ at, sheet: s([null], run, [src]) })],
      ["invalid_order", async ({ src }) => ({ at, sheet: s([[1]], "z", [src]) })], // 注文の形が run の形より先
      ["invalid_order", async ({ run }) => ({ at, sheet: s({ a: 1 }, run, [999]) })],
      ["invalid_order", async ({ run, src }) => ({ at, sheet: s([{ symbol: 1, side: "buy", qty: 100 }], run, [src]) })],
      ["invalid_sheet", async ({ src }) => ({ at, sheet: s(buy, -1, [src]) })],
      ["invalid_sheet", async ({ src }) => ({ at, sheet: s(buy, 2 ** 53, [src]) })],
      ["invalid_sheet", async ({ run }) => ({ at, sheet: s(buy, run, [run + 50]) })],
      ["invalid_sheet", async ({ src, post }) => ({ at, sheet: s(buy, post, [src]) })], // 投稿の run
      ["invalid_sheet", async ({ src }) => ({ at, sheet: s(buy, src, [src]) })], // run でないイベント
      ["invalid_sheet", async ({ run, src }) => ({ at, sheet: s(buy, run, [src], "2026-02-30") })],
      ["invalid_sheet", async ({ run, src }) => ({ at, sheet: s(buy, run, [src], 20261110) })],
      ["after_cutoff", async ({ run, src }) => ({ at: jst("2026-11-10", 8, 30), sheet: s(buy, run, [src]) })],
      ["wrong_trading_date", async ({ run, src }) => ({ at, sheet: s(buy, run, [src], "2026-11-12") })],
      ["unknown_symbol", async ({ run, src }) => ({ at, sheet: s([{ symbol: "ZZZ", side: "buy", qty: 100 }], run, [src]) })],
      ["invalid_qty", async ({ run, src }) => ({ at, sheet: s([{ symbol: "AAA", side: "buy", qty: 150 }], run, [src]) })],
      ["invalid_qty", async ({ run, src }) => ({ at, sheet: s([{ symbol: "AAA", side: "buy", qty: -100 }], run, [src]) })],
      ["insufficient_holdings", async ({ run, src }) => ({ at, sheet: s([{ symbol: "AAA", side: "sell", qty: 100 }], run, [src]) })],
      [
        "already_committed",
        async ({ log, run, src }) => {
          await log.commitSheet(at, "alpha", s(buy, run, [src]));
          return { at: at + 1, sheet: s(buy, run, [src]) };
        },
      ],
      [
        "account_not_ready",
        async ({ log, run, src }) => {
          await log.commitSheet(at, "alpha", s(buy, run, [src]));
          return { at: jst("2026-11-10", 9), sheet: s(buy, run, [src], "2026-11-11") }; // 11/10 の引け後処理の前に 11/11 の注文票
        },
      ],
      [
        "suspended",
        async ({ log }) => {
          await ok(log, op("agent.suspended", jst("2026-11-10", 6), { agentId: "alpha", scope: "orders", reason: "x" }));
          return { at, sheet: s(buy, "bad", "bad", "nope") }; // 停止は run・入力・日付の形より先（注文の形が違うときは下のテスト）
        },
      ],
      [
        "suspended",
        async ({ log, run }) => {
          await ok(log, op("agent.suspended", jst("2026-11-10", 6), { agentId: "*", scope: "both", reason: "x" }));
          return { at: jst("2026-11-10", 9), sheet: s(buy, run, [run + 99]) };
        },
      ],
    ];
    for (const [i, [want, make]] of cases.entries()) {
      const x = await setup();
      const { at: t, sheet } = await make(x);
      const r = await x.log.commitSheet(t, "alpha", sheet);
      const where = `case ${i} (${want})`;
      expect(r.ok && r.rejected, where).toBe(want);
      if (!r.ok) continue;
      expect(r.event.type, where).toBe("order_sheet.rejected");
      expect(r.event.payload, where).toMatchObject({ reason: want, orders: sheet.orders });
      expect(r.event.payload, where).not.toHaveProperty("ordersUnreadable");
      expect(await admitAll(x.log.events), where).toBeNull();
    }
  });

  it("無作為な注文票（シード固定）でも、正規化できる注文は残り、できない注文だけが ordersUnreadable になり、どちらも照合を通る", async () => {
    const seed = 0x66_73;
    const rand = mulberry32(seed);
    const values: unknown[] = [100, 150, 0, -100, 0.5, NaN, 2 ** 53, -0, "AAA", "ZZZ", "é", "\uD800", null, true, [], {}, "buy", "sell"];
    const keys = ["symbol", "side", "qty", "limit", "note", "__proto__"];
    const order = () => {
      if (rand() < 0.1) return pick(rand, values);
      const o: Record<string, unknown> = { symbol: pick(rand, ["AAA", "AAA", "AAA", "ZZZ", 1]), side: pick(rand, ["buy", "buy", "buy", "sell", "hold"]), qty: pick(rand, [100, 200, 100, 150, 0.5, -100, 2 ** 53]) };
      if (rand() < 0.3) Object.defineProperty(o, pick(rand, keys), { value: pick(rand, values), enumerable: true, writable: true, configurable: true });
      return o;
    };
    const seen = { kept: 0, unreadable: 0, committed: 0 };
    for (let i = 0; i < 150; i++) {
      const { log, src, run, post } = await setup();
      if (rand() < 0.15) await ok(log, op("agent.suspended", jst("2026-11-10", 6), { agentId: "alpha", scope: "orders", reason: "x" }));
      const orders = rand() < 0.1 ? pick(rand, values) : Array.from({ length: randInt(rand, 1, 2) }, order);
      const sheet = {
        tradingDate: pick(rand, ["2026-11-10", "2026-11-10", "2026-11-10", "2026-11-11", "nope"]),
        orders,
        runSeq: pick(rand, [run, run, run, run, post, 0, 999, "1"]),
        inputSeqs: pick(rand, [[src], [src], [src], [999], "x"]),
      } as Parameters<EventLog["commitSheet"]>[2];
      const at = pick(rand, [jst("2026-11-10", 7), jst("2026-11-10", 7), jst("2026-11-10", 9)]);
      const r = await log.commitSheet(at, "alpha", sheet);
      const where = `seed ${seed} i ${i}: ${JSON.stringify({ at, sheet })}`;
      expect(r.ok, where).toBe(true);
      if (!r.ok) continue;
      const p = r.event.payload as Record<string, unknown>;
      if (r.event.type === "order_sheet.rejected") {
        // 残すのは正規化した値（-0 は 0。§5.1）なので、正規化した形で比べる
        seen[normalizable(orders) ? "kept" : "unreadable"]++;
        if (normalizable(orders)) expect([p.orders === undefined ? null : canonicalize(p.orders), p.ordersUnreadable], where).toEqual([canonicalize(orders), undefined]);
        else expect([p.orders, p.ordersUnreadable], where).toEqual([undefined, true]);
      } else seen.committed++;
      expect(await admitAll(log.events), where).toBeNull();
    }
    // どの枝も通ったこと（乱数の偏りで検査が空にならないように）
    expect(Object.values(seen).every((n) => n > 0), JSON.stringify(seen)).toBe(true);
  });
});

describe("(c) 読めない注文の拒否でも、偽の理由は照合で落ちる", () => {
  it("理由が一覧にない、状態と合わない、印の値が true でない記録は落ちる", async () => {
    const { log, src, run } = await setup();
    const at = jst("2026-11-10", 7);
    const base = { agentId: "alpha", tradingDate: "2026-11-10", runSeq: run, inputSeqs: [src], ordersUnreadable: true };
    // まず、通るはずのもの
    for (const reason of ["invalid_order", "unknown_symbol", "invalid_qty", "insufficient_holdings"]) {
      expect(await admitAll(await withRejected(log.events, at, { ...base, reason }, [run, src])), reason).toBeNull();
    }
    const bad: [string, Record<string, unknown>, number[], number][] = [
      ["偽の suspended", { ...base, reason: "suspended" }, [run, src], at],
      ["foo", { ...base, reason: "foo" }, [run, src], at],
      ["null", { ...base, reason: null }, [run, src], at],
      ["数", { ...base, reason: 1 }, [run, src], at],
      ["配列", { ...base, reason: ["invalid_qty"] }, [run, src], at],
      ["toString", { ...base, reason: "toString" }, [run, src], at],
      ["__proto__", { ...base, reason: "__proto__" }, [run, src], at],
      ["締めの前の after_cutoff", { ...base, reason: "after_cutoff" }, [run, src], at],
      ["正しい日の wrong_trading_date", { ...base, reason: "wrong_trading_date" }, [run, src], at],
      ["形の正しい seq の invalid_sheet", { ...base, reason: "invalid_sheet" }, [run, src], at],
      ["確定していない日の already_committed", { ...base, reason: "already_committed" }, [run, src], at],
      ["約定待ちのない account_not_ready", { ...base, reason: "account_not_ready" }, [run, src], at],
      ["印が文字列", { ...base, ordersUnreadable: "true", reason: "invalid_qty" }, [run, src], at],
      ["印が1", { ...base, ordersUnreadable: 1, reason: "invalid_qty" }, [run, src], at],
      ["印が false で注文なし", { ...base, ordersUnreadable: false, reason: "invalid_qty" }, [run, src], at],
      ["印が false で注文あり", { ...base, ordersUnreadable: false, orders: [{ symbol: "AAA", side: "buy", qty: 150 }], reason: "invalid_qty" }, [run, src], at],
    ];
    for (const [name, p, refs, t] of bad) expect(await admitAll(await withRejected(log.events, t, p, refs)), name).toMatch(/order_sheet\.rejected/);
  });

  it("注文を残し run と入力を外した記録で、理由を偽ると落ちる（出し直すと invalid_sheet）", async () => {
    const { log } = await setup();
    const at = jst("2026-11-10", 7);
    const p = { agentId: "alpha", tradingDate: "2026-11-10", orders: [{ symbol: "AAA", side: "buy", qty: 150 }] };
    expect(await admitAll(await withRejected(log.events, at, { ...p, reason: "invalid_sheet" }))).toBeNull();
    for (const reason of ["invalid_qty", "suspended", "invalid_order"]) expect(await admitAll(await withRejected(log.events, at, { ...p, reason })), reason).toMatch(/order_sheet\.rejected/);
  });

  it("約定待ちで翌日の注文票の読めない拒否は、account_not_ready なら通り、注文の中身の理由なら落ちる", async () => {
    const { log, src, run } = await setup();
    await log.commitSheet(jst("2026-11-10", 7), "alpha", { tradingDate: "2026-11-10", orders: buy, runSeq: run, inputSeqs: [src] });
    const at = jst("2026-11-10", 9);
    const base = { agentId: "alpha", tradingDate: "2026-11-11", runSeq: run, inputSeqs: [src], ordersUnreadable: true };
    expect(await admitAll(await withRejected(log.events, at, { ...base, reason: "account_not_ready" }, [run, src]))).toBeNull();
    expect(await admitAll(await withRejected(log.events, at, { ...base, reason: "invalid_qty" }, [run, src]))).toMatch(/order_sheet\.rejected/);
  });

  it("停止中の読めない拒否：停止中なら suspended のほかの理由は落ちる", async () => {
    const { log, src, run } = await setup();
    await ok(log, op("agent.suspended", jst("2026-11-10", 6), { agentId: "alpha", scope: "orders", reason: "x" }));
    const at = jst("2026-11-10", 7);
    const base = { agentId: "alpha", tradingDate: "2026-11-10", runSeq: run, inputSeqs: [src], ordersUnreadable: true };
    expect(await admitAll(await withRejected(log.events, at, { ...base, reason: "suspended" }, [run, src]))).toBeNull();
    for (const reason of ["invalid_qty", "unknown_symbol", "insufficient_holdings", "invalid_sheet", "account_not_ready"]) {
      expect(await admitAll(await withRejected(log.events, at, { ...base, reason }, [run, src])), reason).toMatch(/order_sheet\.rejected/);
    }
  });

  // #78 で見つけ、core が 55b159d で直した欠陥（文書との食い違い）：§3.2 は「停止中なら suspended」、§4 は停止中の注文票に「理由 suspended を残す」と書く。
  // 直す前は rejectionOf（append.ts）が注文の形の検査を停止の検査より先に見て、停止中のAIでも注文の形が違えば invalid_order になった。
  // 照合の側も、読めない拒否の invalid_order を状態によらず通していた
  it("停止中のAIが形の違う注文を出しても、理由は suspended（AIごとの停止・全体の停止）で、照合を通る", async () => {
    for (const agentId of ["alpha", "*"]) {
      for (const orders of ["x", [null], [[1]], { a: 1 }, [{ symbol: "AAA", side: "buy", qty: 0.5 }]]) {
        const { log, src, run } = await setup();
        await ok(log, op("agent.suspended", jst("2026-11-10", 6), { agentId, scope: "both", reason: "x" }));
        const r = await log.commitSheet(jst("2026-11-10", 7), "alpha", { tradingDate: "2026-11-10", orders: orders as unknown as Order[], runSeq: run, inputSeqs: [src] });
        const where = `${agentId} ${JSON.stringify(orders)}`;
        expect(r.ok && r.rejected, where).toBe("suspended");
        expect(await admitAll(log.events), where).toBeNull();
      }
    }
  });

  it("投稿だけの停止中・停止を解いた後は、形の違う注文は invalid_order で、読めない拒否の偽の suspended は落ちる", async () => {
    const states: [string, (log: EventLog) => Promise<unknown>][] = [
      ["posts だけ", (log) => ok(log, op("agent.suspended", jst("2026-11-10", 6), { agentId: "alpha", scope: "posts", reason: "x" }))],
      [
        "停止を解いた後",
        async (log) => {
          await ok(log, op("agent.suspended", jst("2026-11-10", 6), { agentId: "alpha", scope: "orders", reason: "x" }));
          await ok(log, op("agent.resumed", jst("2026-11-10", 6, 1), { agentId: "alpha", scope: "orders", reason: "x" }));
        },
      ],
    ];
    for (const [name, prepare] of states) {
      for (const orders of ["x", [null], [{ symbol: "AAA", side: "buy", qty: 0.5 }]]) {
        const { log, src, run } = await setup();
        await prepare(log);
        const at = jst("2026-11-10", 7);
        const r = await log.commitSheet(at, "alpha", { tradingDate: "2026-11-10", orders: orders as unknown as Order[], runSeq: run, inputSeqs: [src] });
        const where = `${name} ${JSON.stringify(orders)}`;
        expect(r.ok && r.rejected, where).toBe(Array.isArray(orders) && orders[0] !== null ? "invalid_qty" : "invalid_order");
        expect(await admitAll(log.events), where).toBeNull();
        const fake = { agentId: "alpha", tradingDate: "2026-11-10", runSeq: run, inputSeqs: [src], ordersUnreadable: true, reason: "suspended" };
        expect(await admitAll(await withRejected(log.events, at + 1, fake, [run, src])), where).toMatch(/order_sheet\.rejected/);
      }
    }
  });

  it("停止中のAIの、理由 invalid_order の拒否の記録は照合で落ちる", async () => {
    const { log, src, run } = await setup();
    await ok(log, op("agent.suspended", jst("2026-11-10", 6), { agentId: "alpha", scope: "orders", reason: "x" }));
    const at = jst("2026-11-10", 7);
    const base = { agentId: "alpha", tradingDate: "2026-11-10", runSeq: run, inputSeqs: [src], reason: "invalid_order" };
    expect(await admitAll(await withRejected(log.events, at, { ...base, ordersUnreadable: true }, [run, src]))).toMatch(/order_sheet\.rejected/);
  });

  it("登録されていないAIの拒否の記録は、読める注文でも読めない注文でも照合で落ち、例外にならない", async () => {
    const { log, src, run } = await setup();
    const at = jst("2026-11-10", 7);
    const base = { agentId: "ghost", tradingDate: "2026-11-10", runSeq: run, inputSeqs: [src] };
    const payloads: [string, Record<string, unknown>][] = [
      ["読める invalid_qty", { ...base, reason: "invalid_qty", orders: buy }],
      ["読めない invalid_qty", { ...base, reason: "invalid_qty", ordersUnreadable: true }],
      ["読めない account_not_ready", { ...base, reason: "account_not_ready", ordersUnreadable: true }],
      ["読めない invalid_order", { ...base, reason: "invalid_order", ordersUnreadable: true }],
    ];
    for (const [name, p] of payloads) {
      const events = await withRejected(log.events, at, p, [run, src]);
      await expect(admitAll(events), name).resolves.toMatch(/order_sheet\.rejected/);
    }
  });
});
