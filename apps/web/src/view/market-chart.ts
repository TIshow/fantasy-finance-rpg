// 値段の推移と出来高のグラフの座標（手書きのSVG用）。横は板寄せの日を等間隔に並べる。
// 価格がつかなかった日（値つかず）は線をつながず、その日の位置に印を出す。座標は表示のための小数（1桁）。
import type { Deciyen } from "../ledger/types";
import type { AuctionDay } from "./market";

export const CHART_W = 600;
export const PRICE_H = 160;
export const VOLUME_H = 50;

export interface PriceChart {
  /** 価格のついた日が続く区間ごとの polyline の points（値つかずの日で区切る） */
  segments: string[];
  /** 1日だけの区間は線にならないので、点で描く */
  dots: { x: number; y: number }[];
  /** 値つかずの日の x */
  gaps: number[];
  /** 出来高の棒（x は中心、h は高さ。出来高0の日は h=0） */
  bars: { seq: number; x: number; h: number; label: string }[];
  barWidth: number;
  /** 上場時の価格の y（破線）。縦軸の範囲は上場時の価格を含むので、いつも枠の中 */
  listedY: number;
  /** 価格のついた日の高値・安値の表示。1日も価格がつかなければ null（縦軸の範囲ではなく、ついた価格だけ） */
  range: { highText: string; lowText: string } | null;
  label: string;
}

export function priceChart(days: readonly AuctionDay[], listedPrice: Deciyen, text: (price: Deciyen) => string): PriceChart | null {
  if (days.length === 0) return null;
  const prices = days.flatMap((d) => (d.price === null ? [] : [d.price]));
  const lo = Math.min(listedPrice, ...prices);
  const hi = Math.max(listedPrice, ...prices);
  const span = Math.max(1, hi - lo);
  const pad = Math.max(1, Math.floor(span / 10));
  const top = hi + pad;
  const bottom = lo - pad;
  const y = (v: Deciyen) => Math.round((1 - (v - bottom) / (top - bottom)) * PRICE_H * 10) / 10;
  const step = CHART_W / days.length;
  const x = (i: number) => Math.round((i + 0.5) * step * 10) / 10;

  const segments: string[] = [];
  const dots: { x: number; y: number }[] = [];
  const gaps: number[] = [];
  let run: string[] = [];
  const flush = () => {
    if (run.length >= 2) segments.push(run.join(" "));
    else if (run.length === 1) {
      const [px, py] = run[0]!.split(",").map(Number);
      dots.push({ x: px!, y: py! });
    }
    run = [];
  };
  days.forEach((d, i) => {
    if (d.price === null) {
      flush();
      gaps.push(x(i));
    } else run.push(`${x(i)},${y(d.price)}`);
  });
  flush();

  const maxVolume = Math.max(1, ...days.map((d) => d.volume));
  const bars = days.map((d, i) => ({ seq: d.seq, x: x(i), h: Math.round((d.volume / maxVolume) * VOLUME_H * 10) / 10, label: `${d.dateText} ${d.volumeText}` }));
  const noPrice = gaps.length;
  // 記録が年をまたぐときだけ、説明の日付に年をつける
  const first = days[0]!;
  const last = days.at(-1)!;
  const crossYear = first.date.slice(0, 4) !== last.date.slice(0, 4);
  const [from, to] = crossYear ? [first.date.replaceAll("-", "/"), last.date.replaceAll("-", "/")] : [first.dateText, last.dateText];
  return {
    segments, dots, gaps, bars,
    barWidth: Math.max(2, Math.round(step * 0.6 * 10) / 10),
    listedY: y(listedPrice),
    range: prices.length === 0 ? null : { highText: text(Math.max(...prices)), lowText: text(Math.min(...prices)) },
    label: `${from}〜${to} の値段の推移と出来高（${days.length}日のうち${noPrice}日は値つかず）`,
  };
}
