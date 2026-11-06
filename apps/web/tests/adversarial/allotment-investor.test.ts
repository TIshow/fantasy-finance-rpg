// 検証（verifier、#110 PR-2d）：AI投資家（kind が investor か、kind なし）への最初の配分（shares.allotted）を断ること、
// 記録の文字列（キー名を含む）の U+0000 を断ることを、実装とは別に確かめる。
// - 追記の処理（EventLog）・台帳（Ledger）・メモリの保管・Postgres の保管（PGlite）で、同じ入力に同じ結論を出すか
// - 保存済みの記録を書き換えて（連鎖のハッシュも作り直して）AI投資家への配分を紛れ込ませたとき、作り直し（replay）・
//   台帳だけ・保管を開くとき・記録からの照合（verifyDatabase）のどれもが断るか
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyDatabase } from "../../scripts/daily-lib";
import type { DraftInput } from "../../src/contracts";
import { sealEvent, verifyChain } from "../../src/events/chain";
import { Ledger, replay } from "../../src/events/replay";
import type { LogEvent } from "../../src/events/types";
import type { HolidayTable } from "../../src/holidays/table";
import { INITIAL_CASH } from "../../src/ledger/types";
import { RunnerValues } from "../../src/runner/values";
import { InMemoryEventStore } from "../../src/store/memory-store";
import { PgEventStore, readAllEvents } from "../../src/store/pg-store";
import { PgValueStore } from "../../src/store/pg-values";
import { migrate, type SqlDb } from "../../src/store/sql";
import { FakeClock, jst } from "../contracts/fakes";
import { openPglite, resetSchema } from "../store/pglite";

const H = "a".repeat(64);
const table: HolidayTable = { firstYear: 2026, lastYear: 2027, sourceSha256: "0".repeat(64), contentSha256: H, dates: new Set() };
const holidayTables = new Map([[H, table]]);
const T = "2026-11-10";
const MM_CASH = 50_000_000 * 10;
const NUL = String.fromCharCode(0);
const p = (e: LogEvent) => e.payload as Record<string, unknown>;

type Store = { append(d: DraftInput): Promise<{ ok: boolean; reason?: string }>; commitSheet: InMemoryEventStore["commitSheet"]; read(after?: number, limit?: number): Promise<readonly LogEvent[]> };
const op = (type: DraftInput["type"], payload: Record<string, unknown>): DraftInput => ({ type, actor: "operator:owner", refs: [], payload });
const sys = (type: DraftInput["type"], payload: Record<string, unknown>, refs: number[] = []): DraftInput => ({ type, actor: "system", refs, payload });

/** NEO1 を上場し、AI投資家 alpha（kind あり）・plain（kind なし）と、ばらばらに売買する参加者 nz を登録し、取引対象にする */
async function setup(store: Store, clock: FakeClock) {
  const must = async (d: DraftInput) => {
    const r = await store.append(d);
    if (!r.ok) throw new Error(`${d.type}: ${r.reason}`);
  };
  clock.set(0);
  await must(op("holidays.adopted", { holidaysSha256: H }));
  clock.set(jst("2026-11-09", 18));
  await must(sys("company.listed", { symbol: "NEO1", name: "ネオ電機", sector: "電機", sharesOutstanding: 500_000, price: 10_000 }));
  clock.set(jst("2026-11-09", 19));
  await must(op("agent.registered", { agentId: "alpha", startDate: T, kind: "investor", initialCash: INITIAL_CASH }));
  await must(op("agent.registered", { agentId: "plain", startDate: T, initialCash: INITIAL_CASH }));
  await must(op("agent.registered", { agentId: "nz", startDate: T, kind: "noise", initialCash: 30_000_000 * 10 }));
  await must(op("universe.set", { symbols: ["NEO1"] }));
  clock.set(jst("2026-11-09", 20));
}

const memory = async () => {
  const clock = new FakeClock(0);
  const store = new InMemoryEventStore(new RunnerValues(() => new Uint8Array(16).fill(1)), holidayTables, clock);
  await setup(store, clock);
  return { store, clock };
};

/** 書き換えた記録：i 番目の payload を patch で変え、それより後の連鎖のハッシュをすべて作り直す */
async function forge(events: readonly LogEvent[], i: number, payload: Record<string, unknown>): Promise<LogEvent[]> {
  const out: LogEvent[] = [];
  const used = new Set<string>();
  for (const [j, e] of events.entries()) {
    const next = j < i ? e : await sealEvent(out.at(-1) ?? null, { type: e.type, recordedAt: e.recordedAt, actor: e.actor, keys: e.keys, refs: e.refs, payload: j === i ? payload : e.payload }, used);
    out.push(next);
    for (const k of next.keys) used.add(k);
  }
  return out;
}

describe("登録の kind の書き方の揺れ", () => {
  const bad: [string, unknown][] = [
    ["大文字", "Investor"],
    ["全部大文字", "INVESTOR"],
    ["空白つき", "investor "],
    ["空文字", ""],
    ["null", null],
    ["数", 0],
    ["配列", ["noise"]],
    ["オブジェクト", { kind: "noise" }],
    ["ハイフン", "market-maker"],
    ["NUL つき", `noise${NUL}`],
    ["全角", "ｎｏｉｓｅ"],
  ];
  it.each(bad)("kind が %s なら、登録を断る（例外にならない）", async (_, kind) => {
    const { store } = await memory();
    const r = await store.append(op("agent.registered", { agentId: "x", startDate: T, kind, initialCash: MM_CASH }));
    expect(r.ok).toBe(false);
  });

  it("kind を継承で持たせた（プロトタイプにある）登録は、正規化できずに断る", async () => {
    const { store } = await memory();
    const payload = Object.assign(Object.create({ kind: "noise" }) as Record<string, unknown>, { agentId: "x", startDate: T, initialCash: MM_CASH });
    const r = await store.append(op("agent.registered", payload));
    expect(r.ok).toBe(false);
  });

  it("キー「__proto__」に kind を入れた登録（JSON から読んだ形）は、通っても AI投資家として扱い、配分を断る", async () => {
    const { store } = await memory();
    const payload = JSON.parse(`{"agentId":"x","startDate":"${T}","initialCash":${INITIAL_CASH},"__proto__":{"kind":"noise"}}`) as Record<string, unknown>;
    const reg = await store.append(op("agent.registered", payload));
    if (!reg.ok) return; // 断るなら、それでよい
    const r = await store.append(sys("shares.allotted", { agentId: "x", symbol: "NEO1", qty: 100 }));
    expect(r).toMatchObject({ ok: false });
    expect(store.account("x").holdings).toEqual({});
  });

  it("AI投資家の種類で、AI投資家の現金と違う最初の現金は断る（kind を書いても書かなくても）", async () => {
    const { store } = await memory();
    for (const kind of ["investor", undefined]) {
      const r = await store.append(op("agent.registered", { agentId: `x${kind ?? ""}`, startDate: T, ...(kind ? { kind } : {}), initialCash: MM_CASH }));
      expect(r.ok, String(kind)).toBe(false);
    }
  });
});

describe("AI投資家への配分（メモリの保管）", () => {
  it("kind ありも kind なしも断り、ok: false で返す（例外にならず、保管は止まらない）。ほかの種類には配れる", async () => {
    const { store } = await memory();
    for (const agentId of ["alpha", "plain"]) {
      for (const qty of [100, 1, 500_000]) {
        const r = await store.append(sys("shares.allotted", { agentId, symbol: "NEO1", qty }));
        expect(r.ok, `${agentId} ${qty}`).toBe(false);
        expect(r.ok ? "" : r.reason).toMatch(/shares cannot be allotted to an investor/);
      }
      expect(store.account(agentId).holdings).toEqual({});
    }
    expect((await store.append(sys("shares.allotted", { agentId: "nz", symbol: "NEO1", qty: 100 }))).ok).toBe(true);
    expect(store.account("nz").holdings.NEO1?.qty).toBe(100);
  });

  it("株数が0・負・小数・文字列・null・大きすぎる配分は、ばらばらに売買する参加者にも断る", async () => {
    const { store } = await memory();
    for (const qty of [0, -100, 1.5, "100", null, 2 ** 53, Number.MAX_SAFE_INTEGER]) {
      const r = await store.append(sys("shares.allotted", { agentId: "nz", symbol: "NEO1", qty }));
      expect(r.ok, String(qty)).toBe(false);
    }
    expect(store.account("nz").holdings).toEqual({});
  });

  it("登録より前の配分は断り、配分のあとに同じ ID を AI投資家として登録し直すこともできない", async () => {
    const { store, clock } = await memory();
    expect((await store.append(sys("shares.allotted", { agentId: "later", symbol: "NEO1", qty: 100 }))).ok).toBe(false);
    expect((await store.append(sys("shares.allotted", { agentId: "nz", symbol: "NEO1", qty: 100 }))).ok).toBe(true);
    clock.set(jst("2026-11-09", 21));
    const again = await store.append(op("agent.registered", { agentId: "nz", startDate: T, initialCash: INITIAL_CASH }));
    expect(again.ok).toBe(false);
    // 全体を表す ID（*）にも配れない
    expect((await store.append(sys("shares.allotted", { agentId: "*", symbol: "NEO1", qty: 100 }))).ok).toBe(false);
  });
});

/** 正しい記録（nz に配分）を作り、nz の登録を AI投資家（kind なし・kind あり）に書き換えて連鎖を作り直す */
async function forgedLogs() {
  const { store } = await memory();
  const r = await store.append(sys("shares.allotted", { agentId: "nz", symbol: "NEO1", qty: 100 }));
  if (!r.ok) throw new Error(r.reason);
  const events = await store.read(0, 1000);
  const i = events.findIndex((e) => e.type === "agent.registered" && p(e).agentId === "nz");
  const base = { agentId: "nz", startDate: T, initialCash: INITIAL_CASH };
  return {
    events,
    forged: { "kind なし": await forge(events, i, base), "kind が investor": await forge(events, i, { ...base, kind: "investor" }) },
    negative: await forge(events, events.length - 1, { agentId: "nz", symbol: "NEO1", qty: -100 }),
  };
}

describe("書き換えた記録に、AI投資家への配分を紛れ込ませる", async () => {
  const { events, forged, negative } = await forgedLogs();

  it("元の記録は、作り直しが通る（比べるため）", async () => {
    await expect(replay(events, { get: () => undefined }, { holidayTables })).resolves.toBeDefined();
  });

  for (const [name, log] of Object.entries(forged)) {
    it(`${name}：連鎖は正しいが、作り直し・台帳だけ・保管を開くときのどれもが断る`, async () => {
      expect(await verifyChain(log)).toEqual([]);
      await expect(replay(log, { get: () => undefined }, { holidayTables })).rejects.toThrow(/shares cannot be allotted to an investor/);
      // 追記の検査を通さず、台帳だけに順に当てても断る（code-reviewer の低の指摘：kind を書かない登録を、作り直しの台帳で直接確かめる）
      const ledger = new Ledger({ get: () => undefined });
      const apply = async () => {
        for (const e of log) await ledger.apply(e);
      };
      await expect(apply()).rejects.toThrow(/shares cannot be allotted to an investor/);
      await expect(InMemoryEventStore.fromEvents(log, new RunnerValues(), holidayTables, new FakeClock(jst("2026-11-09", 23)))).rejects.toThrow(/shares cannot be allotted to an investor/);
    });
  }

  it("株数が負の配分に書き換えた記録も、作り直しで断る", async () => {
    expect(await verifyChain(negative)).toEqual([]);
    await expect(replay(negative, { get: () => undefined }, { holidayTables })).rejects.toThrow(/qty must be a positive integer/);
  });
});

describe("Postgres の保管（PGlite）でも同じ結論になる", () => {
  let pg: PGlite;
  let db: SqlDb;
  beforeAll(async () => {
    ({ pg, db } = await openPglite());
  }, 60_000);
  afterAll(() => db.close());

  const freshStore = async () => {
    await resetSchema(pg);
    await migrate(db);
    const clock = new FakeClock(0);
    const values = await PgValueStore.open(db);
    const store = await PgEventStore.open(db, { values, holidayTables, clock });
    return { store, clock };
  };
  const rows = async () => ((await db.query("SELECT count(*)::int AS n FROM events")).rows[0] as { n: number }).n;
  /** 検査を通さずに、持ち主の接続で行を足す（書き換えた記録が DB に入った場合） */
  const insertRaw = async (events: readonly LogEvent[]) => {
    for (const e of events) {
      await db.query("INSERT INTO events (seq, schema_ver, type, recorded_at, actor, keys, refs, payload, prev_hash, hash) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10)", [
        e.seq,
        e.schema,
        e.type,
        e.recordedAt,
        e.actor,
        JSON.stringify(e.keys),
        JSON.stringify(e.refs),
        JSON.stringify(e.payload),
        e.prevHash,
        e.hash,
      ]);
    }
  };

  it("AI投資家への配分を断り、行を書かない。ばらばらに売買する参加者には配れる", async () => {
    const { store, clock } = await freshStore();
    await setup(store as unknown as Store, clock);
    const before = await rows();
    for (const agentId of ["alpha", "plain"]) {
      const r = await store.append(sys("shares.allotted", { agentId, symbol: "NEO1", qty: 100 }));
      expect(r.ok, agentId).toBe(false);
      expect(r.ok ? "" : r.reason).toMatch(/shares cannot be allotted to an investor/);
    }
    expect(await rows()).toBe(before);
    expect((await store.append(sys("shares.allotted", { agentId: "nz", symbol: "NEO1", qty: 100 }))).ok).toBe(true);
    expect(await rows()).toBe(before + 1);
  }, 60_000);

  it("書き換えた記録（kind なしの登録への配分）が DB にあれば、保管を開くときも、記録からの照合も断る", async () => {
    const { forged } = await forgedLogs();
    for (const log of Object.values(forged)) {
      await resetSchema(pg);
      await migrate(db);
      await insertRaw(log);
      expect((await readAllEvents(db)).length).toBe(log.length);
      const values = await PgValueStore.open(db);
      await expect(PgEventStore.open(db, { values, holidayTables, clock: new FakeClock(jst("2026-11-09", 23)) })).rejects.toThrow(/shares cannot be allotted to an investor/);
      await expect(verifyDatabase(db, table)).rejects.toThrow(/shares cannot be allotted to an investor/);
    }
  }, 60_000);

  describe("U+0000 の置き場所を変えても、メモリと Postgres の保管が同じく断り、どちらも例外にならない", () => {
    const drafts: [string, Record<string, unknown>][] = [
      ["値", { agentId: "*", scope: "orders", reason: `点検${NUL}` }],
      ["キー名", { agentId: "*", scope: "orders", reason: "点検", [`memo${NUL}`]: 1 }],
      ["入れ子の深いキー名", { agentId: "*", scope: "orders", reason: "点検", memo: { a: { b: { [`${NUL}`]: "x" } } } }],
      ["配列の中", { agentId: "*", scope: "orders", reason: "点検", memo: ["a", ["b", `c${NUL}`]] }],
      ["NFC でない文字と一緒", { agentId: "*", scope: "orders", reason: `が${NUL}` }],
      ["対になっていないサロゲートと一緒", { agentId: "*", scope: "orders", reason: `\ud800${NUL}` }],
      ["agentId", { agentId: `a${NUL}`, scope: "orders", reason: "点検" }],
      ["U+0000 だけ", { agentId: "*", scope: "orders", reason: NUL }],
    ];
    for (const [where, payload] of drafts) {
      it(where, async () => {
        const mem = await memory();
        const m = await mem.store.append(op("agent.suspended", payload));
        const { store, clock } = await freshStore();
        await setup(store as unknown as Store, clock);
        const before = await rows();
        const g = await store.append(op("agent.suspended", payload));
        expect(m.ok, `memory: ${m.ok ? "" : m.reason}`).toBe(false);
        expect(g.ok, `postgres: ${g.ok ? "" : g.reason}`).toBe(false);
        expect(await rows()).toBe(before);
      }, 60_000);
    }

    it("比べるため：U+0001 や「\\u0000」という6文字は、どちらの保管も通す", async () => {
      for (const reason of [String.fromCharCode(1), "\\u0000"]) {
        const mem = await memory();
        expect((await mem.store.append(op("agent.suspended", { agentId: "*", scope: "orders", reason }))).ok).toBe(true);
        const { store, clock } = await freshStore();
        await setup(store as unknown as Store, clock);
        expect((await store.append(op("agent.suspended", { agentId: "*", scope: "orders", reason }))).ok).toBe(true);
        await verifyDatabase(db, table);
      }
    }, 60_000);
  });

  // 欠陥（宛先 platform）：注文票の中身に U+0000 があると、メモリの保管は「注文票の拒否」（order_sheet.rejected、
  // 中身は ordersUnreadable）を記録に残すのに、PgEventStore.commitSheet は書く前の hasNul で ok: false を返し、何も残さない。
  // #110 PR-2d で正規化が U+0000 を断るようになったので、PgEventStore の hasNul の先回りは要らず、メモリの保管に任せれば同じになる。
  // AI の出力から来る値なので、受け取った注文票の拒否を記録に残す規則（EVENT_LOG §3.2）に沿うのはメモリの保管の側
  it.fails("注文票の銘柄に U+0000 があるとき、Postgres の保管もメモリの保管と同じく拒否の記録を残す", async () => {
    const sheetOf = async (s: Store, clock: FakeClock) => {
      await setup(s, clock);
      const run = await s.append(sys("agent.run", { agentId: "nz", purpose: "order", inputSeqs: [], ok: true }));
      if (!run.ok) throw new Error(run.reason);
      const runSeq = (await s.read(0, 1000)).at(-1)!.seq;
      return s.commitSheet("nz", { tradingDate: T, orders: [{ symbol: `NEO1${NUL}`, side: "buy", qty: 100 }], runSeq, inputSeqs: [] });
    };
    const memClock = new FakeClock(0);
    const m = await sheetOf(new InMemoryEventStore(new RunnerValues(), holidayTables, memClock), memClock);
    expect(m.ok && m.event.type).toBe("order_sheet.rejected");
    const { store, clock } = await freshStore();
    const g = await sheetOf(store as unknown as Store, clock);
    expect(g.ok && g.event.type, g.ok ? "" : g.reason).toBe("order_sheet.rejected");
  }, 60_000);
});
