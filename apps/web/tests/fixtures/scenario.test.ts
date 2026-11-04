// 固定シードの擬似乱数と、架空のシナリオを確かめる。ハッシュの期待値は、実装とは別に shasum -a 256 で計算して固定した。
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/events/hash";
import { holidaysFor } from "../../src/holidays";
import { cutoffOf, isBusinessDay } from "../../src/ledger/calendar";
import { LOT } from "../../src/ledger/types";
import { describeMarketDataContract } from "../contracts/conformance";
import { MemoryMarketData } from "../contracts/fakes";
import { mulberry32, pick, randInt } from "./prng";
import { AGENTS, LATE_DAY, PRIOR_DAY, SYMBOLS, TRADING_DAYS, buildScenario } from "./scenario";

const SEED = 20261104;
/** buildScenario(seed) の JSON.stringify を shasum -a 256 で計算した値 */
const GOLDEN: Record<number, string> = {
  20261104: "1ebc46665c05c42275534bb8c4fb16fe062bfdb46cec795125079f920cc4f7ca",
  20261105: "ac7ce76ca3a9e32019ac518b78bb795b6196098af8d280ed726cdd579d03eea2",
};
const hashOf = (seed: number) => sha256Hex(new TextEncoder().encode(JSON.stringify(buildScenario(seed))));
const jst = (date: string, hh: number, mm = 0) => Date.parse(`${date}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+09:00`);

describe("擬似乱数（mulberry32）", () => {
  it("既知の値と一致する（Python で別に計算した 32bit の出力）", () => {
    for (const [seed, raw] of [[1, [2693262067, 11749833, 2265367787]], [42, [2581720956, 1925393290, 3661312704]]] as const) {
      const r = mulberry32(seed);
      expect(raw.map(() => r() * 4294967296)).toEqual(raw);
    }
  });

  it("同じシードなら同じ列、別のシードなら別の列。値は [0, 1)", () => {
    const seq = (seed: number) => Array.from({ length: 200 }, ((r) => () => r())(mulberry32(seed)));
    expect(seq(7)).toEqual(seq(7));
    expect(seq(7)).not.toEqual(seq(8));
    expect(seq(7).every((v) => v >= 0 && v < 1)).toBe(true);
  });

  it("randInt は両端を含む範囲に収まり、pick は空の配列を拒む", () => {
    const r = mulberry32(3);
    const seen = new Set(Array.from({ length: 500 }, () => randInt(r, 1, 3)));
    expect([...seen].sort()).toEqual([1, 2, 3]);
    expect(randInt(r, 5, 5)).toBe(5);
    expect(["a", "b"]).toContain(pick(r, ["a", "b"]));
    expect(() => pick(r, [])).toThrow();
  });
});

describe("架空のシナリオ", () => {
  it("同じシードなら同じ結果（ハッシュで固定）。別のシードなら変わる", async () => {
    expect(await hashOf(SEED)).toBe(GOLDEN[SEED]);
    expect(await hashOf(SEED)).toBe(GOLDEN[SEED]);
    expect(await hashOf(20261105)).toBe(GOLDEN[20261105]);
    expect(await hashOf(SEED)).not.toBe(await hashOf(20261105));
    expect(buildScenario(SEED)).toEqual(buildScenario(SEED));
    expect(buildScenario(SEED).observations).not.toEqual(buildScenario(20261105).observations);
    expect(buildScenario(SEED).plans).not.toEqual(buildScenario(20261105).plans);
  });

  it("実在しない銘柄・AI。前営業日と5営業日は、すべて祝日でない営業日", () => {
    const s = buildScenario(SEED);
    expect(s.symbols).toEqual(["TSTA", "TSTB", "TSTC"]);
    expect(s.agents.map((a) => a.id)).toEqual(["ai-a", "ai-b", "ai-c"]);
    expect(TRADING_DAYS.length).toBe(5);
    const holidays = holidaysFor(PRIOR_DAY, TRADING_DAYS[4]);
    for (const d of [PRIOR_DAY, ...TRADING_DAYS]) expect(isBusinessDay(d, holidays)).toBe(true);
  });

  it("日・銘柄・種類ごとに観測が1つ。価格は0.1円単位の正の整数で、出来高は終値だけにあり売買単位の倍数", () => {
    const s = buildScenario(SEED);
    expect(s.observations.length).toBe(6 * SYMBOLS.length * 2);
    expect(new Set(s.observations.map((o) => `${o.date}/${o.symbol}/${o.kind}`)).size).toBe(s.observations.length);
    for (const o of s.observations) {
      expect(Number.isSafeInteger(o.price) && o.price! > 0 && o.price! % 10 === 0).toBe(true);
      if (o.kind === "close") expect(o.volume! > 0 && o.volume! % LOT === 0).toBe(true);
      else expect("volume" in o).toBe(false);
    }
  });

  it("観測の時刻は整合する：公開 <= 取得。取り込みが遅れるのは1日だけで、その日の終値は翌日の未明に取得", () => {
    const s = buildScenario(SEED);
    for (const o of s.observations) {
      expect(o.fetchedAt).toBeGreaterThanOrEqual(o.publishedAt);
      expect(o.publishedAt).toBe(o.kind === "open" ? jst(o.date, 9) : jst(o.date, 15, 30));
    }
    const late = s.observations.filter((o) => o.fetchedAt - o.publishedAt > 120_000);
    expect(late.length).toBe(SYMBOLS.length);
    for (const o of late) expect([o.date, o.kind, o.fetchedAt]).toEqual([LATE_DAY, "close", jst("2026-11-12", 3)]);
  });

  it("MarketDataPort で引くと先読みにならない：遅れて取り込んだ終値は、取り込む時刻ちょうどにはまだ見えない", async () => {
    const s = buildScenario(SEED);
    const port = new MemoryMarketData(s.observations, { now: () => jst("2026-11-14", 0) });
    for (const sym of SYMBOLS) {
      expect((await port.asOf(jst("2026-11-11", 21)).latest(sym, "close"))?.date).toBe("2026-11-10"); // 公開済みだが未取得
      expect((await port.asOf(jst("2026-11-12", 3)).latest(sym, "close"))?.date).toBe("2026-11-10"); // 取得がちょうど at
      expect((await port.asOf(jst("2026-11-12", 3) + 1).latest(sym, "close"))?.date).toBe(LATE_DAY);
    }
  });

  it("各約定日の締めの時点で、全銘柄の終値が判断した日（前営業日）までそろっている", async () => {
    const s = buildScenario(SEED);
    const port = new MemoryMarketData(s.observations, { now: () => jst("2026-11-14", 0) });
    for (const [i, day] of TRADING_DAYS.entries()) {
      const view = port.asOf(cutoffOf(day));
      for (const sym of SYMBOLS) {
        expect((await view.latest(sym, "close"))?.date).toBe([PRIOR_DAY, ...TRADING_DAYS][i]);
        expect((await view.latest(sym, "open"))?.date).toBe([PRIOR_DAY, ...TRADING_DAYS][i]); // 約定日の始値は見えない
      }
    }
  });

  it("判断の時刻は、判断した日の全銘柄の終値を取り込んだ後、かつ約定日の締めより前（遅延日も）", () => {
    for (const seed of [SEED, 1, 2, 3]) {
      const s = buildScenario(seed);
      for (const p of s.plans) {
        const closes = s.observations.filter((o) => o.date === p.decidedOn && o.kind === "close");
        for (const o of closes) expect(o.fetchedAt).toBeLessThan(p.decideAt);
        expect(p.decideAt).toBeLessThan(cutoffOf(p.tradingDate));
        if (p.post) expect(p.post.text).toContain(p.decidedOn);
      }
      expect(s.plans.filter((p) => p.decidedOn === LATE_DAY).every((p) => p.decideAt === jst("2026-11-12", 3, 30))).toBe(true);
    }
  });

  it("注文と投稿の計画：3体×5日。売りは保有の範囲、数量は売買単位の倍数、判断は前の営業日、本文は正規化済み", () => {
    for (const seed of [SEED, 1, 2, 3, 4, 5, 6, 7, 8, 9]) {
      const s = buildScenario(seed);
      expect(s.plans.length).toBe(AGENTS.length * TRADING_DAYS.length);
      const held = new Map<string, number>();
      for (const p of s.plans) {
        expect(p.decidedOn).toBe([PRIOR_DAY, ...TRADING_DAYS][TRADING_DAYS.indexOf(p.tradingDate as (typeof TRADING_DAYS)[number])]);
        expect(p.orders.length).toBeLessThanOrEqual(1);
        for (const o of p.orders) {
          expect(SYMBOLS as readonly string[]).toContain(o.symbol);
          expect(o.qty > 0 && o.qty % LOT === 0).toBe(true);
          const key = `${p.agentId}/${o.symbol}`;
          const after = (held.get(key) ?? 0) + (o.side === "buy" ? o.qty : -o.qty);
          expect(after).toBeGreaterThanOrEqual(0);
          held.set(key, after);
        }
        if (p.post) expect(p.post.text).toBe(p.post.text.normalize("NFC"));
      }
      expect(s.plans.some((p) => p.orders.length > 0)).toBe(true);
    }
  });
});

// シナリオの観測を引く実装（MemoryMarketData）が MarketDataPort の契約を満たすこと（契約テストは自前の固定の観測で行うので、
// tests/contracts と同じ検査の重複になる）。シナリオの観測そのものの性質は、上の「先読みにならない」「締めの時点」のテストで確かめる
describeMarketDataContract("MemoryMarketData（シナリオの検証用）", (obs, clock) => new MemoryMarketData(obs, clock));
