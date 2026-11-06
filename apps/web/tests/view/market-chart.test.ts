import { describe, expect, it } from "vitest";
import { formatYenMark } from "../../src/view/format";
import type { AuctionDay } from "../../src/view/market";
import { priceChart, PRICE_H, VOLUME_H } from "../../src/view/market-chart";

const day = (i: number, price: number | null, volume: number): AuctionDay => ({ seq: i, date: `2026-11-${String(9 + i).padStart(2, "0")}`, dateText: `11/${String(9 + i).padStart(2, "0")}`, price, priceText: price === null ? "値つかず" : formatYenMark(price), volume, volumeText: `${volume}株`, carriedText: null, carriedSeq: null });
const pts = (s: string) => s.split(" ").map((p) => p.split(",").map(Number) as [number, number]);

describe("priceChart", () => {
  it("記録がなければ null", () => {
    expect(priceChart([], 1000, formatYenMark)).toBeNull();
  });

  it("価格のついた日をつなぎ、値つかずの日で線を切る。値つかずの日の位置に印", () => {
    const c = priceChart([day(0, 12_000, 100), day(1, 12_500, 300), day(2, null, 0), day(3, null, 0), day(4, 11_000, 50)], 10_000, formatYenMark)!;
    expect(c.segments).toHaveLength(1);
    expect(pts(c.segments[0]!).map(([x]) => x)).toEqual([60, 180]); // 5日を等間隔（幅600÷5＝120）の中心
    expect(c.dots.map((d) => d.x)).toEqual([540]); // 1日だけの区間は点
    expect(c.gaps).toEqual([300, 420]);
    expect(c.label).toContain("5日のうち2日は値つかず");
  });

  it("高い価格ほど上（y が小さい）。すべての点が枠の中。破線は上場時の価格", () => {
    const c = priceChart([day(0, 12_000, 1), day(1, 8_000, 1)], 10_000, formatYenMark)!;
    const [[, y1], [, y2]] = pts(c.segments[0]!) as [[number, number], [number, number]];
    expect(y1).toBeLessThan(y2);
    expect(Math.min(y1, y2)).toBeGreaterThanOrEqual(0);
    expect(Math.max(y1, y2)).toBeLessThanOrEqual(PRICE_H);
    expect(c.listedY).toBeGreaterThan(y1);
    expect(c.listedY).toBeLessThan(y2);
    expect(c.range).toEqual({ highText: "¥1,200", lowText: "¥800" });
  });

  it("出来高の棒は最大が満タン、0の日は高さ0。価格が1日もつかなくても壊れない", () => {
    const c = priceChart([day(0, null, 0), day(1, null, 0)], 10_000, formatYenMark)!;
    expect(c.segments).toEqual([]);
    expect(c.dots).toEqual([]);
    expect(c.bars.map((b) => b.h)).toEqual([0, 0]);
    const d = priceChart([day(0, 10_000, 200), day(1, 10_000, 0), day(2, 10_000, 100)], 10_000, formatYenMark)!;
    expect(d.bars.map((b) => b.h)).toEqual([VOLUME_H, 0, VOLUME_H / 2]);
  });

  it("高値・安値は、ついた価格だけから（縦軸の範囲に含めた上場時の価格は入れない）。1日もつかなければ null", () => {
    const c = priceChart([day(0, 10_500, 1), day(1, 10_800, 1)], 10_000, formatYenMark)!;
    expect(c.range).toEqual({ highText: "¥1,080", lowText: "¥1,050" }); // 上場時の価格（¥1,000）は安値にならない
    expect(priceChart([day(0, null, 0)], 10_000, formatYenMark)!.range).toBeNull();
  });

  it("どんな場合でも座標はすべて有限で、枠の中（全部同じ価格・1日だけ・1日もつかない）", () => {
    const cases = [[day(0, 5_000, 10), day(1, 5_000, 10)], [day(0, 5_000, 10)], [day(0, null, 0)], [day(0, 1, 1), day(1, 9_999_999, 99_999_999)]];
    for (const days of cases) {
      const c = priceChart(days, 5_000, formatYenMark)!;
      const ys = [c.listedY, ...c.segments.flatMap((s) => pts(s).map(([, y]) => y)), ...c.dots.map((d) => d.y)];
      const xs = [...c.segments.flatMap((s) => pts(s).map(([x]) => x)), ...c.dots.map((d) => d.x), ...c.gaps, ...c.bars.map((b) => b.x)];
      for (const y of ys) expect(Number.isFinite(y) && y >= 0 && y <= PRICE_H).toBe(true);
      for (const x of xs) expect(Number.isFinite(x) && x >= 0 && x <= 600).toBe(true);
      for (const b of c.bars) expect(Number.isFinite(b.h) && b.h >= 0 && b.h <= VOLUME_H).toBe(true);
      expect(new Set(c.bars.map((b) => b.seq)).size).toBe(days.length); // 棒の識別は seq（同じ日付・同じ出来高でも重ならない）
    }
  });

  it("記録が年をまたぐときだけ、説明の日付に年をつける", () => {
    const d = (date: string, i: number) => ({ ...day(i, 1000, 1), date, dateText: date.slice(5).replace("-", "/") });
    expect(priceChart([d("2026-12-30", 0), d("2027-01-04", 1)], 1000, formatYenMark)!.label).toContain("2026/12/30〜2027/01/04");
    expect(priceChart([d("2026-11-10", 0), d("2026-11-11", 1)], 1000, formatYenMark)!.label).toContain("11/10〜11/11");
  });
});
