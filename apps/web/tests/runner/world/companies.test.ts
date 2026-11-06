import { describe, expect, it } from "vitest";
import { COMPANIES, SECTORS, type SectorId, fairPrice, listingPrice, quarters } from "../../../src/runner/world/companies";
import { mulberry32, normal } from "../../../src/runner/world/random";

const SEEDS = [1, 2, 3, 20261106, 99];
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs: number[]) => Math.sqrt(mean(xs.map((x) => (x - mean(xs)) ** 2)));

/** 業種ごとに、全社・全シードの四半期の売上の伸び率と配当性向を集める */
function bySector(count: number) {
  const out = new Map<SectorId, { growth: number[]; payout: number[] }>();
  for (const seed of SEEDS) {
    for (const c of COMPANIES) {
      const qs = quarters(seed, c, count);
      const s = out.get(c.sector) ?? { growth: [], payout: [] };
      for (let i = 1; i < qs.length; i++) s.growth.push(qs[i]!.revenue / qs[i - 1]!.revenue - 1);
      for (let i = 2; i < qs.length; i += 2) {
        const eps = qs[i]!.eps + qs[i - 1]!.eps;
        if (eps > 0) s.payout.push(qs[i]!.dividendPerShare / eps);
      }
      out.set(c.sector, s);
    }
  }
  return out;
}

describe("架空の企業", () => {
  it("6社・3業種×2社。銘柄コードは英字3文字＋数字（実在のコードの形と、架空データの TST と重ならない）で重複しない", () => {
    expect(COMPANIES.length).toBe(6);
    for (const id of Object.keys(SECTORS)) expect(COMPANIES.filter((c) => c.sector === id).length).toBe(2);
    for (const c of COMPANIES) {
      expect(c.symbol).toMatch(/^[A-Z]{3}[0-9]$/);
      expect(c.symbol.startsWith("TST")).toBe(false);
      expect(c.sharesOutstanding % 100).toBe(0);
      expect(c.name.length).toBeGreaterThan(0);
      expect(c.description).toContain("架空");
    }
    expect(new Set(COMPANIES.map((c) => c.symbol)).size).toBe(6);
  });
});

describe("業績のモデル", () => {
  it("同じシードなら同じ業績、違うシードなら違う業績。四半期の数を増やしても前の四半期は変わらない", () => {
    for (const c of COMPANIES) {
      expect(quarters(7, c, 12)).toEqual(quarters(7, c, 12));
      expect(quarters(7, c, 12)).not.toEqual(quarters(8, c, 12));
      expect(quarters(7, c, 20).slice(0, 12)).toEqual(quarters(7, c, 12));
    }
    // 列は銘柄コードで決まる：会社ごとに違い、会社を足しても並べ替えても変わらない
    const [a, b] = COMPANIES;
    expect(quarters(7, { ...a!, symbol: "ZZZ9" }, 8)).not.toEqual(quarters(7, a!, 8));
    expect(quarters(7, { ...b!, baseRevenue: a!.baseRevenue, sharesOutstanding: a!.sharesOutstanding, sector: a!.sector }, 8)).not.toEqual(quarters(7, a!, 8));
    expect(quarters(7, { ...a! }, 8)).toEqual(quarters(7, a!, 8));
  });

  it("値は整数。1株あたり利益は純利益 ÷ 株数（0.1円単位）、配当は半期だけで負にならない", () => {
    for (const c of COMPANIES) {
      for (const q of quarters(5, c, 24)) {
        for (const v of [q.revenue, q.netIncome, q.eps, q.dividendPerShare]) expect(Number.isSafeInteger(v)).toBe(true);
        expect(q.eps).toBe(Math.round((q.netIncome * 10) / c.sharesOutstanding));
        expect(q.dividendPerShare).toBeGreaterThanOrEqual(0);
        if (q.index % 2 === 1 || q.index === 0) expect(q.dividendPerShare).toBe(0);
        if (q.index > 0 && q.index % 2 === 0) {
          const half = quarters(5, c, q.index + 1).at(-2)!.eps + q.eps;
          expect(q.dividendPerShare).toBe(Math.max(0, Math.round(half * SECTORS[c.sector].payout)));
        }
      }
    }
  });

  it("業種の性質が出る：ソフトウェアは伸びもぶれも大きく、電力・水道は小さい。配当性向は電力・水道が高い", () => {
    const s = bySector(40);
    const sw = s.get("software")!;
    const ut = s.get("utilities")!;
    const el = s.get("electronics")!;
    expect(mean(sw.growth)).toBeGreaterThan(mean(el.growth));
    expect(mean(el.growth)).toBeGreaterThan(mean(ut.growth));
    expect(sd(sw.growth)).toBeGreaterThan(sd(el.growth));
    expect(sd(el.growth)).toBeGreaterThan(sd(ut.growth));
    expect(mean(ut.payout)).toBeGreaterThan(mean(el.payout));
    expect(mean(el.payout)).toBeGreaterThan(mean(sw.payout));
    // 伸びの平均とぶれは、業種の設定に近い
    for (const [id, x] of s) {
      expect(Math.abs(mean(x.growth) - SECTORS[id].growth)).toBeLessThan(SECTORS[id].growthVol * 0.3);
      expect(Math.abs(sd(x.growth) - SECTORS[id].growthVol)).toBeLessThan(SECTORS[id].growthVol * 0.3);
    }
  });
});

describe("最初の価格と目安の価格", () => {
  it("上場の価格は、上場の前の四半期の1株あたり利益 × 4 × 業種の株価収益率を、1円の刻みに丸めたもの", () => {
    for (const c of COMPANIES) {
      const [q0] = quarters(11, c, 1);
      const price = listingPrice(11, c);
      expect(price % 10).toBe(0);
      expect(price).toBeGreaterThan(0);
      if (q0!.eps * 4 >= Math.round((q0!.revenue * 4 * 0.01 * 10) / c.sharesOutstanding)) expect(price).toBe(Math.round((SECTORS[c.sector].per * q0!.eps * 4) / 10) * 10);
      expect(listingPrice(11, c)).toBe(price);
    }
  });

  it("赤字でも価格は正（売上の1%を利益とみなす）。利益が増えれば目安の価格は上がる", () => {
    const c = COMPANIES[0]!;
    const q = { index: 0, revenue: 60_000_000_000, netIncome: -1_000_000_000, eps: -200, dividendPerShare: 0 };
    expect(fairPrice(c, [q])).toBe(Math.round((15 * Math.round((60_000_000_000 * 4 * 0.01 * 10) / c.sharesOutstanding)) / 10) * 10);
    const good = { ...q, netIncome: 3_600_000_000, eps: 720 };
    const better = { ...good, netIncome: 4_000_000_000, eps: 800 };
    expect(fairPrice(c, [better])).toBeGreaterThan(fairPrice(c, [good]));
    expect(() => fairPrice(c, [])).toThrow();
    // 4四半期に足りなければ年に引き延ばす（3四半期なら 4/3 倍）。どんなに小さくても1円
    const three = [good, good, good].map((x, index) => ({ ...x, index }));
    expect(fairPrice(c, three)).toBe(Math.round((15 * 720 * 3 * (4 / 3)) / 10) * 10);
    expect(fairPrice(c, [{ ...q, revenue: 1, netIncome: 0, eps: 0 }])).toBe(10);
  });
});

describe("乱数", () => {
  it("同じシードなら同じ列。正規分布の近似は平均0・標準偏差1に近い", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const xs = Array.from({ length: 5000 }, () => normal(a));
    expect(Array.from({ length: 5000 }, () => normal(b))).toEqual(xs);
    expect(Math.abs(mean(xs))).toBeLessThan(0.05);
    expect(Math.abs(sd(xs) - 1)).toBeLessThan(0.05);
  });
});
