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
