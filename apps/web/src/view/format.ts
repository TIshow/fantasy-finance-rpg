// 表示用の文字列。0.1円単位の整数を、計算せずに文字にするだけ（浮動小数点を使わない）。
import type { Deciyen } from "../ledger/types";

const group = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** 0.1円単位の整数 → "12,345.6円"（小数が 0 なら "12,345円"） */
export function formatYen(d: Deciyen): string {
  if (!Number.isSafeInteger(d)) throw new Error(`not a deciyen: ${String(d)}`);
  const abs = Math.abs(d);
  const frac = abs % 10;
  return `${d < 0 ? "-" : ""}${group(Math.floor(abs / 10))}${frac === 0 ? "" : `.${frac}`}円`;
}

/** 前日比など、符号つき（0 は符号なし） */
export function formatSignedYen(d: Deciyen): string {
  return d > 0 ? `+${formatYen(d)}` : formatYen(d);
}

/** UNIXミリ秒 → 日本時間の "YYYY-MM-DD HH:MM:SS"（実行環境のロケール・タイムゾーンに依らない） */
export function formatJst(ms: number): string {
  return new Date(ms + 9 * 3_600_000).toISOString().slice(0, 19).replace("T", " ");
}

/** "¥12,345.6"（小数が 0 なら "¥12,345"）。負は "-¥..."。formatYen と同じ値の別の書き方 */
export function formatYenMark(d: Deciyen): string {
  return formatYen(d).replace(/^(-?)(.*)円$/, "$1¥$2");
}

/** 符号つき "+¥207,600" / "-¥1,000" / "¥0" */
export function formatSignedYenMark(d: Deciyen): string {
  return d > 0 ? `+${formatYenMark(d)}` : formatYenMark(d);
}

/** 整数どうしの割り算を四捨五入（半分は絶対値が大きい方）。num/den×scale。den は正 */
export function roundedRatio(num: number, den: number, scale: number): number {
  if (!(den > 0) || !Number.isSafeInteger(num) || !Number.isSafeInteger(den)) throw new Error("bad ratio");
  const q = Math.floor((Math.abs(num) * scale * 2 + den) / (den * 2));
  return num < 0 ? -q : q;
}

/** 1/10000 単位の整数 → "+2.08%"（符号つき）。0 は "0.00%" */
export function formatBp(bp: number, signed: boolean): string {
  const abs = Math.abs(bp);
  const t = `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}%`;
  return bp < 0 ? `-${t}` : signed && bp > 0 ? `+${t}` : t;
}

/** "2026-11-18" → "11/18" */
export function formatMonthDay(date: string): string {
  return `${date.slice(5, 7)}/${date.slice(8, 10)}`;
}

/** UNIXミリ秒 → 日本時間の "MM/DD HH:MM" */
export function formatJstShort(ms: number): string {
  return formatJst(ms).slice(5, 16).replace("-", "/");
}
