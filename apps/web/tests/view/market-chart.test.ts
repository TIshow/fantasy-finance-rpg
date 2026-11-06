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
    expect([c.highText, c.lowText]).toEqual(["¥1,200", "¥800"]);
  });

  it("出来高の棒は最大が満タン、0の日は高さ0。価格が1日もつかなくても壊れない", () => {
    const c = priceChart([day(0, null, 0), day(1, null, 0)], 10_000, formatYenMark)!;
    expect(c.segments).toEqual([]);
    expect(c.dots).toEqual([]);
    expect(c.bars.map((b) => b.h)).toEqual([0, 0]);
    const d = priceChart([day(0, 10_000, 200), day(1, 10_000, 0), day(2, 10_000, 100)], 10_000, formatYenMark)!;
    expect(d.bars.map((b) => b.h)).toEqual([VOLUME_H, 0, VOLUME_H / 2]);
  });
});
