// 契約（src/contracts）を満たすことの確認。実装を作る関数を受け取ってテストを組み立てるので、
// platform が自分の実装（DBの保管、実際のLLMの口など）に同じテストを当てられる：
//   describeEventStoreContract("PgEventStore", (env) => new PgEventStore(env.clock, env.holidayTables, …));
// 型だけの確認（@ts-expect-error）は実装によらないので contracts.test.ts に置く。
import { describe, expect, it, onTestFinished } from "vitest";
import type { Clock, DraftInput, EventStore, LlmPolicy, LlmPort, LlmRequest, MarketDataPort, PriceObservation } from "../../src/contracts";
import { verifyChain } from "../../src/events/chain";
import type { HolidayTable } from "../../src/holidays/table";
import { INITIAL_CASH } from "../../src/ledger/types";
import type { LlmBackend } from "./backend";
import { FakeClock, jst, jstDay } from "./fakes";

const H = "a".repeat(64);
export const holidayTable: HolidayTable = { firstYear: 2026, lastYear: 2027, sourceSha256: "0".repeat(64), contentSha256: H, dates: new Set() };

export type SettableClock = Clock & { set(t: number): void };

/** 保管を作る環境。clock は保管の時計の権威として渡す（テストが進める）。holidayTables は採用してよい祝日の一覧（版 → 一覧） */
export interface StoreEnv {
  clock: SettableClock;
  holidayTables: ReadonlyMap<string, HolidayTable>;
  /** テストの終わりに呼ぶ後始末を登録する（DB の接続を閉じる、テスト用の表を消す、など） */
  cleanup(fn: () => void | Promise<void>): void;
}

const op = (type: DraftInput["type"], payload: Record<string, unknown>): DraftInput => ({ type, actor: "operator:owner", refs: [], payload });
const sys = (type: DraftInput["type"], payload: Record<string, unknown>, refs: number[] = []): DraftInput => ({ type, actor: "system", refs, payload });

/** 11/9 22:00 に agent.run まで書き、その seq を返す。呼び出し側は契約だけを見る */
export async function seedAgent(store: EventStore, clock: SettableClock) {
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

export function describeEventStoreContract(name: string, make: (env: StoreEnv) => EventStore | Promise<EventStore>) {
  describe(`EventStore の契約：${name}`, () => {
    const setup = async (start = 0) => {
      const clock = new FakeClock(start);
      const cleanups: (() => void | Promise<void>)[] = [];
      onTestFinished(async () => {
        for (const f of cleanups.reverse()) await f();
      });
      return { clock, store: await make({ clock, holidayTables: new Map([[H, holidayTable]]), cleanup: (fn) => void cleanups.push(fn) }) };
    };

    it("追記は EventLog の検査を通り、通らないものは書かずに理由を返す", async () => {
      const { store, clock } = await setup(jst("2026-11-09", 20));
      const bad = await store.append(op("agent.registered", { agentId: "ai-a", startDate: "2026-11-10", initialCash: INITIAL_CASH }));
      expect(bad.ok).toBe(false); // 祝日の一覧がまだ採用されていない
      expect(await store.last()).toBeNull();
      await seedAgent(store, clock);
      expect((await store.last())?.type).toBe("agent.run");
    });

    it("recordedAt は保管が Clock から入れ、締めを過ぎた確定を締め前に装えない", async () => {
      const { store, clock } = await setup();
      const run = await seedAgent(store, clock);
      expect((await store.last())?.recordedAt).toBe(jst("2026-11-09", 22));
      clock.set(jst("2026-11-10", 8, 31));
      const late = await store.commitSheet("ai-a", { tradingDate: "2026-11-10", orders: [], runSeq: run, inputSeqs: [4] });
      expect(late).toMatchObject({ ok: true, rejected: "after_cutoff" });
      const last = (await store.last())!;
      expect(last.type).toBe("order_sheet.rejected");
      expect(last.recordedAt).toBe(jst("2026-11-10", 8, 31));
    });

    it("時計が戻れば拒む（recordedAt は減らない）", async () => {
      const { store, clock } = await setup();
      await seedAgent(store, clock);
      clock.set(jst("2026-11-09", 21, 59));
      expect((await store.append(sys("source.captured", { publishedAt: jst("2026-11-09", 15, 30), fetchedAt: jst("2026-11-09", 21, 59) }))).ok).toBe(false);
    });

    it("read は afterSeq より後を seq の昇順で返し、連鎖は検査に通る。引数が外れたら RangeError", async () => {
      const { store, clock } = await setup();
      await seedAgent(store, clock);
      const all = await store.read();
      expect(all.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
      expect((await store.read(2, 2)).map((e) => e.seq)).toEqual([3, 4]);
      expect(await store.read(5)).toEqual([]);
      expect(await verifyChain(all)).toEqual([]);
      for (const [a, l] of [[-1, 1], [1.5, 1], [0, 0], [0, 1.5], [NaN, 1], [0, NaN]] as const) await expect(store.read(a, l)).rejects.toThrow(RangeError);
    });

    it("limit を指定して afterSeq を進めれば、全件を順に読める", async () => {
      const { store, clock } = await setup();
      await seedAgent(store, clock);
      const seqs: number[] = [];
      for (let after = 0; ; ) {
        const page = await store.read(after, 2);
        if (page.length === 0) break;
        expect(page.length).toBeLessThanOrEqual(2);
        seqs.push(...page.map((e) => e.seq));
        after = page.at(-1)!.seq;
      }
      expect(seqs).toEqual([1, 2, 3, 4, 5]);
    });

    it("注文票は commitSheet からだけ書ける。未登録のAIは拒む", async () => {
      const { store, clock } = await setup();
      const run = await seedAgent(store, clock);
      const sheet = { tradingDate: "2026-11-10", orders: [], runSeq: run, inputSeqs: [4] };
      clock.set(jst("2026-11-10", 8));
      // 型では DraftInput に注文票の type を渡せない。実行時に渡されても保管が拒む
      const viaAppend = await store.append({ type: "order_sheet.committed", actor: "agent:ai-a", refs: [run], payload: sheet } as unknown as DraftInput);
      expect(viaAppend).toEqual({ ok: false, reason: "use commitSheet" });
      const r = await store.commitSheet("ai-a", sheet);
      expect(r.ok && r.event.type).toBe("order_sheet.committed");
      expect((await store.commitSheet("ai-zzz", sheet)).ok).toBe(false);
    });

    it("同時に呼んでも1件ずつ直列に書かれ、seq が抜けない", async () => {
      const { store, clock } = await setup();
      await seedAgent(store, clock);
      const src = sys("source.captured", { publishedAt: jst("2026-11-09", 15, 30), fetchedAt: jst("2026-11-09", 22) });
      const rs = await Promise.all([1, 2, 3].map(() => store.append(src)));
      expect(rs.every((r) => r.ok)).toBe(true);
      expect((await store.read()).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    });

    it("返したイベントを書き換えても、保管に影響しない（last も read も）", async () => {
      const { store, clock } = await setup();
      await seedAgent(store, clock);
      const before = JSON.stringify(await store.read());
      const tamper = (e: Awaited<ReturnType<EventStore["last"]>> & object) => {
        for (const f of [() => ((e as { type: string }).type = "post.published"), () => ((e.payload as { agentId: string }).agentId = "zzz"), () => e.refs.push(99), () => e.keys.push("zzz")]) {
          try {
            f();
          } catch {
            // 凍結されていれば例外になる。複製なら例外にならない。どちらでもよい
          }
        }
      };
      tamper((await store.last())!);
      for (const e of await store.read()) tamper(e);
      expect(JSON.stringify(await store.read())).toBe(before);
    });

    it("更新・削除の口がない（実体にも）", async () => {
      const { store } = await setup();
      expect(["delete", "update", "remove", "set", "truncate"].filter((k) => k in store)).toEqual([]);
    });
  });
}

const open = (date: string, price: number, publishedAt: number, symbol = "TSTA"): PriceObservation => ({ symbol, date, kind: "open", price, publishedAt, fetchedAt: publishedAt + FETCH_DELAY, source: "fixture" });
const close = (date: string, price: number, publishedAt: number, volume = 1000): PriceObservation => ({ symbol: "TSTA", date, kind: "close", price, volume, publishedAt, fetchedAt: publishedAt + FETCH_DELAY, source: "fixture" });

/** 固定データは、公開の1分後に取得したものとして作る（fetchedAt は公開時刻以後の、その時点に整合する値） */
const FETCH_DELAY = 60_000;

export function describeMarketDataContract(name: string, make: (observations: readonly PriceObservation[], clock: Clock) => MarketDataPort) {
  describe(`MarketDataPort の契約：${name}`, () => {
    const clock = new FakeClock(jst("2026-11-13", 0));
    const port = make(
      [
        close("2026-11-10", 1_010_0, jst("2026-11-10", 15, 30)),
        open("2026-11-10", 1_000_0, jst("2026-11-10", 9)),
        open("2026-11-11", 1_020_0, jst("2026-11-11", 9)),
        close("2026-11-11", 1_030_0, jst("2026-11-11", 15, 30)),
        open("2026-11-11", 2_000_0, jst("2026-11-11", 9), "TSTB"),
      ],
      clock,
    );

    it("窓には、公開も取得も at より前の観測だけが見える。ちょうど at のものは含まない", async () => {
      for (const at of [jst("2026-11-10", 8), jst("2026-11-10", 9), jst("2026-11-10", 15, 29), jst("2026-11-10", 15, 30), jst("2026-11-11", 12), jst("2026-11-12", 0)]) {
        for (const o of await port.asOf(at).history("TSTA")) {
          expect(o.publishedAt).toBeLessThan(at);
          expect(o.fetchedAt).toBeLessThan(at);
        }
      }
      const published = jst("2026-11-10", 9);
      expect((await port.asOf(published).history("TSTA")).length).toBe(0);
      expect((await port.asOf(published + FETCH_DELAY).history("TSTA")).length).toBe(0); // 公開済みでも、取得がちょうど at なら見えない
      expect((await port.asOf(published + FETCH_DELAY + 1).history("TSTA")).map((o) => o.kind)).toEqual(["open"]);
    });

    it("公開されていても取得していなければ見えない。後から同じ at で呼んでも結果は変わらない（取り込みの遅れ）", async () => {
      const t = jst("2026-11-10", 15, 30);
      const late = { ...close("2026-11-10", 1_010_0, t), fetchedAt: jst("2026-11-10", 21) }; // 15:30 公開、21:00 取得
      const p = make([late], clock);
      expect(await p.asOf(jst("2026-11-10", 16)).history("TSTA")).toEqual([]);
      expect(await p.asOf(jst("2026-11-10", 21)).history("TSTA")).toEqual([]); // 取得がちょうど at
      expect((await p.asOf(jst("2026-11-10", 21) + 1).latest("TSTA", "close"))?.price).toBe(1_010_0);
      expect(await p.asOf(jst("2026-11-10", 16)).latest("TSTA", "close")).toBeNull(); // 取り込んだ後に呼び直しても同じ
    });

    it("後からまとめて取り込んだ（バックフィル）観測は、取り込んだ時刻より前の窓には見えない", async () => {
      const backfilled = [open("2026-11-10", 1_000_0, jst("2026-11-10", 9)), close("2026-11-10", 1_010_0, jst("2026-11-10", 15, 30))].map((o) => ({ ...o, fetchedAt: jst("2026-11-12", 3) }));
      const p = make(backfilled, clock);
      expect(await p.asOf(jst("2026-11-11", 9)).history("TSTA")).toEqual([]);
      expect((await p.asOf(jst("2026-11-12", 4)).history("TSTA")).length).toBe(2);
    });

    it("取得時刻が公開時刻より前の観測、取得時刻が数でない観測は返さない", async () => {
      const t = jst("2026-11-10", 9);
      const beforePublish = { ...open("2026-11-10", 1_000_0, t), fetchedAt: t - 1 };
      const nanFetched = { ...close("2026-11-10", 1_010_0, jst("2026-11-10", 15, 30)), fetchedAt: NaN };
      const p = make([beforePublish, nanFetched, open("2026-11-11", 1_020_0, jst("2026-11-11", 9))], clock);
      expect((await p.asOf(jst("2026-11-12", 0)).history("TSTA")).map((o) => o.date)).toEqual(["2026-11-11"]);
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

    it("始値の観測に出来高は載らない", async () => {
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

    it("公開時刻が同じなら始値が先。改訂は、より後の公開・取得時刻の新しい観測で表し、過去の窓には見えない", async () => {
      const t = jst("2026-11-10", 15, 30);
      const p = make([close("2026-11-10", 1_010_0, t), open("2026-11-10", 1_000_0, t), close("2026-11-10", 1_011_0, t + 3_600_000)], clock);
      const afterFetch = t + FETCH_DELAY + 1;
      expect((await p.asOf(afterFetch).history("TSTA")).map((o) => o.kind)).toEqual(["open", "close"]);
      expect((await p.asOf(afterFetch).latest("TSTA", "close"))?.price).toBe(1_010_0);
      expect((await p.asOf(t + 3_600_000 + FETCH_DELAY + 1).latest("TSTA", "close"))?.price).toBe(1_011_0);
    });

    it("公開時刻が分からない観測は返さない", async () => {
      const unknown = { ...close("2026-11-10", 1_010_0, NaN) };
      const p = make([unknown, open("2026-11-10", 1_000_0, jst("2026-11-10", 9))], clock);
      expect((await p.asOf(jst("2026-11-12", 0)).history("TSTA")).map((o) => o.kind)).toEqual(["open"]);
    });

    it("窓には at・history・latest だけがある（日付や時刻を指定して未来を引く口はない）", () => {
      expect(Object.keys(port.asOf(0)).sort()).toEqual(["at", "history", "latest"]);
    });
  });
}

/** 解決を外から操作できる Promise */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** 提供元の呼び出しに入った回数を数え、k 回目に入るまで待てる（setTimeout の待ちに頼らない） */
function entrances() {
  let n = 0;
  const waiters: [number, () => void][] = [];
  return {
    enter() {
      n++;
      for (const [k, f] of waiters) if (n >= k) f();
    },
    get count() {
      return n;
    },
    until(k: number) {
      return n >= k ? Promise.resolve() : new Promise<void>((r) => waiters.push([k, r]));
    },
  };
}

/** 余分な呼び出しがあれば入ってくるのを待つ（入らないことを確かめる前に、非同期の処理を流す） */
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

const request = (maxCost: number): LlmRequest => ({
  agentId: "ai-a",
  purpose: "order",
  model: { provider: "fake", modelId: "fake-1", settings: { temperature: "0.2" } },
  prompt: { id: "order", version: "1", hash: "b".repeat(64) },
  inputSeqs: [4],
  messages: [{ role: "user", content: "x" }],
  maxCost,
});
const MODEL_VERSION = "fake-1-2026-11-01";
const ok = (cost: number, output = "a"): ReturnType<LlmBackend> => Promise.resolve({ ok: true, output, cost, respondedModel: MODEL_VERSION });

export function describeLlmContract(name: string, make: (policy: LlmPolicy, clock: Clock, backend: LlmBackend) => LlmPort) {
  describe(`LlmPort の契約：${name}`, () => {
    const policy = { dailyCostLimit: 25, dryRun: false };
    const t0 = jst("2026-11-09", 22);

    it("出力・費用・応答したモデル・時刻を返し、その日の費用が積み上がる。送る内容は加工しない", async () => {
      const seen: LlmRequest[] = [];
      const llm = make(policy, new FakeClock(t0), (r) => (seen.push(structuredClone(r)), ok(10)));
      const req = request(10);
      expect(await llm.complete(req)).toMatchObject({ ok: true, output: "a", usage: { cost: 10 }, respondedModel: MODEL_VERSION, startedAt: t0 });
      expect(seen).toEqual([req]);
      expect(await llm.spent("2026-11-09")).toBe(10);
      expect(await llm.spent("2026-11-10")).toBe(0);
    });

    it("使用済み＋maxCost が上限ちょうどなら通り、1でも超えれば呼ばずに budget_exceeded。翌日は呼べる", async () => {
      const clock = new FakeClock(t0);
      let calls = 0;
      const llm = make(policy, clock, () => (calls++, ok(10)));
      expect((await llm.complete(request(10))).ok).toBe(true);
      expect((await llm.complete(request(15))).ok).toBe(true); // 10 + 15 = 25（ちょうど）
      expect(await llm.spent("2026-11-09")).toBe(20);
      expect(await llm.complete(request(6))).toMatchObject({ ok: false, errorCode: "budget_exceeded", usage: { cost: 0 } }); // 20 + 6 > 25
      expect(calls).toBe(2);
      clock.set(jst("2026-11-10", 0, 1));
      expect((await llm.complete(request(10))).ok).toBe(true);
    });

    it("maxCost が 1 以上の安全な整数でなければ、呼ばずに RangeError", async () => {
      let calls = 0;
      const llm = make(policy, new FakeClock(t0), () => (calls++, ok(1)));
      for (const bad of [NaN, -1, 0, 1.5, Infinity, 2 ** 53]) await expect(llm.complete(request(bad))).rejects.toThrow(RangeError);
      expect(calls).toBe(0);
      expect(await llm.spent("2026-11-09")).toBe(0);
      expect((await llm.complete(request(1))).ok).toBe(true); // 1 は通る
    });

    it("dailyCostLimit が 0 以上の安全な整数でなければ作れない。0 は許し、何も呼ばない（停止）", async () => {
      for (const bad of [NaN, -1, 1.5, Infinity, 2 ** 53]) expect(() => make({ dailyCostLimit: bad, dryRun: false }, new FakeClock(t0), () => ok(1))).toThrow(RangeError);
      let calls = 0;
      const stopped = make({ dailyCostLimit: 0, dryRun: false }, new FakeClock(t0), () => (calls++, ok(1)));
      expect(await stopped.complete(request(1))).toMatchObject({ ok: false, errorCode: "budget_exceeded" });
      expect(calls).toBe(0);
    });

    it("policy は複製して持つ。作ったあとに書き換えても上限は変わらない", async () => {
      const p = { dailyCostLimit: 25, dryRun: false };
      const llm = make(p, new FakeClock(t0), () => ok(1));
      p.dailyCostLimit = NaN;
      p.dryRun = true;
      expect(llm.policy).toEqual({ dailyCostLimit: 25, dryRun: false });
      expect(await llm.complete(request(26))).toMatchObject({ ok: false, errorCode: "budget_exceeded" });
      expect((await llm.complete(request(25))).ok).toBe(true);
    });

    it("実費が maxCost を超えたら、切り捨てずそのまま記録する", async () => {
      const llm = make(policy, new FakeClock(t0), () => ok(14));
      expect(await llm.complete(request(10))).toMatchObject({ ok: true, usage: { cost: 14 } });
      expect(await llm.spent("2026-11-09")).toBe(14);
    });

    it("失敗でも課金された費用は記録し、課金されたか分からない失敗（timeout）は予約した maxCost を残す", async () => {
      let n = 0;
      const llm = make(policy, new FakeClock(t0), () => Promise.resolve(n++ === 0 ? { ok: false, errorCode: "provider_error", cost: 3 } : { ok: false, errorCode: "timeout", cost: "unknown" }));
      expect(await llm.complete(request(10))).toMatchObject({ ok: false, errorCode: "provider_error", usage: { cost: 3 } });
      expect(await llm.spent("2026-11-09")).toBe(3);
      expect(await llm.complete(request(10))).toMatchObject({ ok: false, errorCode: "timeout", usage: { cost: 10 } });
      expect(await llm.spent("2026-11-09")).toBe(13);
    });

    it("提供元の費用が比較できない値（NaN・負・小数）なら maxCost を費用とし、上限を効かなくしない", async () => {
      const costs = [NaN, -5, 1.5];
      let n = 0;
      const llm = make({ dailyCostLimit: 25, dryRun: false }, new FakeClock(t0), () => ok(costs[n++ % costs.length]!));
      expect(await llm.complete(request(10))).toMatchObject({ ok: true, usage: { cost: 10 } });
      expect(await llm.complete(request(10))).toMatchObject({ ok: true, usage: { cost: 10 } });
      expect(await llm.spent("2026-11-09")).toBe(20);
      expect(await llm.complete(request(10))).toMatchObject({ ok: false, errorCode: "budget_exceeded" }); // 20 + 10 > 25
    });

    it("予約：呼び出し中の spent は予約を含み、精算で実費に置き換わる", async () => {
      const gates = [deferred<number>(), deferred<number>()];
      const entered = entrances();
      let n = 0;
      const llm = make(policy, new FakeClock(t0), async () => {
        const gate = gates[n++]!;
        entered.enter();
        return { ok: true, output: "a", cost: await gate.promise, respondedModel: MODEL_VERSION };
      });
      const first = llm.complete(request(10));
      const second = llm.complete(request(10));
      await entered.until(2);
      expect(await llm.spent("2026-11-09")).toBe(20); // (a) 予約を含む
      gates[0]!.resolve(7);
      expect(await first).toMatchObject({ ok: true, usage: { cost: 7 } });
      expect(await llm.spent("2026-11-09")).toBe(17); // (c) 7 + まだ予約中の10
      gates[1]!.resolve(5);
      expect(await second).toMatchObject({ ok: true, usage: { cost: 5 } });
      expect(await llm.spent("2026-11-09")).toBe(12); // (c) 実費の合計
    });

    it("同時に呼んでも上限を超えない：枠が2件分のところに5件を同時に呼ぶと、提供元に届くのはちょうど2件", async () => {
      const gate = deferred<void>();
      const entered = entrances();
      const llm = make(policy, new FakeClock(t0), async () => {
        entered.enter();
        await gate.promise;
        return { ok: true, output: "a", cost: 7, respondedModel: MODEL_VERSION };
      });
      const results = [1, 2, 3, 4, 5].map(() => llm.complete(request(10)));
      await entered.until(2);
      await settle(); // 余分な呼び出しがあれば、ここまでに入ってくる
      expect(entered.count).toBe(2);
      expect(await llm.spent("2026-11-09")).toBe(20); // 呼び出し中でも dailyCostLimit（25）以下
      gate.resolve();
      const rs = await Promise.all(results);
      expect(rs.filter((r) => r.ok).length).toBe(2);
      expect(rs.filter((r) => !r.ok && r.errorCode === "budget_exceeded").length).toBe(3);
      expect(entered.count).toBe(2);
      expect(await llm.spent("2026-11-09")).toBe(14);
      expect((await llm.complete(request(10))).ok).toBe(true); // 精算で枠が戻った（14 + 10 <= 25）
    });

    it("費用の暦日は startedAt（日本時間）で決まる。日をまたいで終わっても、始めた日に付く", async () => {
      const clock = new FakeClock(jst("2026-11-09", 23, 59));
      const llm = make(policy, clock, () => (clock.set(jst("2026-11-10", 0, 1)), ok(10)));
      const r = await llm.complete(request(10));
      expect(r).toMatchObject({ ok: true, startedAt: jst("2026-11-09", 23, 59), finishedAt: jst("2026-11-10", 0, 1) });
      expect(jstDay(r.startedAt)).toBe("2026-11-09");
      expect(await llm.spent("2026-11-09")).toBe(10);
      expect(await llm.spent("2026-11-10")).toBe(0);
    });

    it("policy を公開する（試運転と費用の上限）", () => {
      const p = { dailyCostLimit: 0, dryRun: true };
      expect(make(p, new FakeClock(0), () => ok(1)).policy).toEqual(p);
    });
  });
}
