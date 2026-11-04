// ゴールデンログを確かめる。ハッシュの期待値は、ログの正規化した JSON（キーの昇順）を、実装とは別に
// Python の json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=False) と sha256 で計算して固定した。
import { describe, expect, it } from "vitest";
import { canonicalize } from "../../src/events/canonical";
import { verifyChain } from "../../src/events/chain";
import { bodyHash, sha256Hex } from "../../src/events/hash";
import { replay, type ValueStore } from "../../src/events/replay";
import type { LogEvent } from "../../src/events/types";
import { cutoffOf, previousBusinessDay } from "../../src/ledger/calendar";
import { FIXTURE_HOLIDAYS, buildGoldenLog } from "./golden";

const SEED = 20261104;
/** buildGoldenLog(seed).events を正規化した JSON の sha256（Python で別に計算） */
const GOLDEN: Record<number, string> = {
  20261104: "c1454b19f4978b252032e5c4f5295828d0c462ee4f14e51ab30c13cfa456a37d",
  20261105: "a11afbad512b0268d4d2b5a9a50e1e9ef3b2f17123b995477469cec2d68df7df",
};
const logHash = (events: readonly LogEvent[]) => sha256Hex(new TextEncoder().encode(canonicalize(events)));
const H = FIXTURE_HOLIDAYS.dates;

describe("ゴールデンログ", async () => {
  const g = await buildGoldenLog(SEED);
  const p = (e: LogEvent) => e.payload as Record<string, unknown>;
  const bySeq = (s: number) => g.events[s - 1]!;
  const of = (type: LogEvent["type"]) => g.events.filter((e) => e.type === type);

  it("連鎖の検査（verifyChain）が通り、1件でも書き換えると問題を返す", async () => {
    expect(g.events.length).toBeGreaterThan(50);
    expect(await verifyChain(g.events)).toEqual([]);
    const tampered = g.events.map((e, i) => (i === 30 ? { ...e, recordedAt: e.recordedAt + 1 } : e));
    expect((await verifyChain(tampered)).length).toBeGreaterThan(0);
  });

  it("replay で先頭から再計算すると、追記の検査を通り、組み立てた台帳と同じ口座になる。外の値を差し替えると止まる", async () => {
    const again = await replay(g.events, g.values, { holidayTables: g.holidayTables });
    for (const a of g.scenario.agents) expect(again.account(a.id)).toEqual(g.ledger.account(a.id));
    const firstOpen = p(of("prices.open")[1]!).valuesHash as string;
    const swapped: ValueStore = { get: (h) => (h === firstOpen ? { ...g.values.get(h)!, value: { TSTA: 10, TSTB: 10, TSTC: 10 } } : g.values.get(h)) };
    await expect(replay(g.events, swapped, { holidayTables: g.holidayTables })).rejects.toThrow("values do not match");
    expect(g.values.get("0".repeat(64))).toBeUndefined();
  });

  it("同じシードなら同じログ（ハッシュで固定）、別のシードなら変わる", async () => {
    expect(await logHash(g.events)).toBe(GOLDEN[SEED]);
    expect(await logHash((await buildGoldenLog(SEED)).events)).toBe(GOLDEN[SEED]);
    const other = await buildGoldenLog(20261105);
    expect(await logHash(other.events)).toBe(GOLDEN[20261105]);
    expect(other.events.at(-1)!.hash).not.toBe(g.events.at(-1)!.hash);
  });

  it("投稿 → 注文票の確定 → 約定 → 評価 → 引け後処理が計画どおりの数だけあり、売買が実際に起きている", () => {
    const days = g.scenario.tradingDays.length;
    const agents = g.scenario.agents.length;
    expect(of("post.published").length).toBe(g.scenario.plans.filter((x) => x.post).length);
    expect(of("order_sheet.committed").length).toBe(g.scenario.plans.filter((x) => x.orders.length > 0).length);
    expect(of("order_sheet.rejected").length).toBe(0);
    expect(of("fills.executed").length).toBe(of("order_sheet.committed").length);
    expect(of("valuation.recorded").length).toBe(days * agents);
    expect(of("corporate_actions.applied").length).toBe(days * agents);
    expect([of("prices.open").length, of("prices.close").length]).toEqual([days + 1, days + 1]);
    const fills = of("fills.executed").flatMap((e) => p(e).fills as { side: string; status: string }[]);
    expect(fills.filter((f) => f.status === "filled" && f.side === "buy").length).toBeGreaterThan(0);
    expect(fills.filter((f) => f.status === "filled" && f.side === "sell").length).toBeGreaterThan(0);
    expect(g.scenario.agents.some((a) => Object.keys(g.ledger.account(a.id).holdings).length > 0)).toBe(true);
  });

  it("外の値（ValueStore）と本文・LLMの出力が、イベントのハッシュで引けて一致する", async () => {
    for (const e of [...of("prices.open"), ...of("prices.close")]) {
      const v = g.values.get(p(e).valuesHash as string)!;
      expect(await bodyHash(v.salt, { value: v.value })).toBe(p(e).valuesHash);
    }
    for (const [e, field] of [...of("post.published").map((x) => [x, "bodyHash"] as const), ...of("agent.run").map((x) => [x, "outputHash"] as const)]) {
      const b = g.bodies.get(p(e)[field] as string)!;
      expect(await bodyHash(b.salt, b.value)).toBe(p(e)[field]);
    }
    for (const e of of("post.published")) expect(g.bodies.get(p(e).bodyHash as string)!.value).toContain("（架空のデータ）");
  });

  it("価格の記録時刻は全銘柄の取得時刻の最大以上。判断の入力は、すべて前の営業日の終値で、締めより前", () => {
    for (const e of [...of("prices.open"), ...of("prices.close")]) {
      const kind = e.type === "prices.open" ? "open" : "close";
      const obs = g.scenario.observations.filter((o) => o.date === p(e).date && o.kind === kind);
      expect(obs.length).toBe(g.scenario.symbols.length);
      for (const o of obs) expect(o.fetchedAt).toBeLessThanOrEqual(e.recordedAt);
    }
    for (const e of of("order_sheet.committed")) {
      const day = p(e).tradingDate as string;
      expect(e.recordedAt).toBeLessThan(cutoffOf(day));
      const run = bySeq(p(e).runSeq as number);
      for (const s of [...(p(e).inputSeqs as number[]), ...(p(run).inputSeqs as number[])]) {
        expect(bySeq(s).type).toBe("prices.close");
        expect(p(bySeq(s)).date).toBe(previousBusinessDay(day, H)); // 2営業日前の終値でもない
      }
    }
    // 投稿の引用と、その元の agent.run の入力も、投稿の直前の営業日の終値（投稿より前に記録されたもの）
    for (const e of of("post.published")) {
      const run = bySeq(p(e).runSeq as number);
      const plan = g.scenario.plans.find((x) => x.agentId === p(e).agentId && x.decideAt <= run.recordedAt && run.recordedAt < cutoffOf(x.tradingDate))!;
      for (const s of [...(p(e).citeSeqs as number[]), ...(p(run).inputSeqs as number[])]) {
        expect(bySeq(s).type).toBe("prices.close");
        expect(p(bySeq(s)).date).toBe(plan.decidedOn);
        expect(bySeq(s).recordedAt).toBeLessThan(e.recordedAt);
      }
    }
  });

  it("遅延日の終値は翌日の未明に記録され、それを入力にした翌営業日の注文票は、その後かつ締めより前", () => {
    const late = of("prices.close").find((e) => p(e).date === g.scenario.lateDay)!;
    expect(new Date(late.recordedAt + 9 * 3_600_000).toISOString().slice(0, 10)).toBe("2026-11-12");
    const next = of("order_sheet.committed").filter((e) => (p(e).inputSeqs as number[]).includes(late.seq));
    expect(next.length).toBeGreaterThan(0);
    for (const e of next) {
      expect(e.recordedAt).toBeGreaterThan(late.recordedAt);
      expect(e.recordedAt).toBeLessThan(cutoffOf("2026-11-12"));
    }
  });
});
