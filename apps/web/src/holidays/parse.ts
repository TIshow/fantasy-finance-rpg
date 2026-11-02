// 内閣府「国民の祝日」CSV（syukujitsu.csv）の解釈。ファイルや通信には触れない純関数。
export interface Holiday {
  /** YYYY-MM-DD */
  date: string;
  name: string;
}

const HEADER = "国民の祝日・休日月日,国民の祝日・休日名称";
/** 日付と名称のちょうど2列。名称に , や " を含む行は形式が変わったとみなして拒否する */
const ROW = /^(\d{4})\/(\d{1,2})\/(\d{1,2}),([^,"]+)$/;
/** 1年の祝日の数の下限。日本は2016年以降は16日以上あり、これを下回るのはデータが欠けたとき */
const MIN_PER_YEAR = 14;
/** 2020年以降、毎年必ずある固定日の祝日（元日、建国記念の日、天皇誕生日、昭和の日、憲法記念日〜こどもの日、文化の日、勤労感謝の日）。末尾の行が欠けたデータを見つける */
const FIXED_FROM = 2020;
const FIXED_DAYS = ["01-01", "02-11", "02-23", "04-29", "05-03", "05-04", "05-05", "11-03", "11-23"];

/** Shift_JISのバイト列をUTF-8の文字列にする。壊れたバイトがあれば例外 */
export function decodeShiftJis(bytes: Uint8Array): string {
  return new TextDecoder("shift_jis", { fatal: true }).decode(bytes);
}

/**
 * CSVの文字列から、firstYear 以降の祝日を日付順に返す。形式が違う行、存在しない日付、
 * 重複、年ごとの数が少なすぎる場合は例外。入力を黙って直さない。
 */
export function parseHolidayCsv(text: string, firstYear: number): Holiday[] {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines[0]?.trim() !== HEADER) throw new Error(`unexpected CSV header: ${lines[0] ?? "(empty)"}`);

  const all: Holiday[] = [];
  for (const [i, line] of lines.slice(1).entries()) {
    const m = ROW.exec(line.trim());
    if (!m) throw new Error(`invalid CSV row ${i + 2}: ${line}`);
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const day = new Date(Date.UTC(y, mo - 1, d));
    if (day.getUTCFullYear() !== y || day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d) throw new Error(`invalid date in CSV row ${i + 2}: ${line}`);
    const name = m[4]!.trim();
    if (name === "") throw new Error(`empty name in CSV row ${i + 2}: ${line}`);
    all.push({ date: day.toISOString().slice(0, 10), name });
  }

  const holidays = all.filter((h) => Number(h.date.slice(0, 4)) >= firstYear).sort((a, b) => a.date.localeCompare(b.date));
  for (let i = 1; i < holidays.length; i++) {
    if (holidays[i]!.date === holidays[i - 1]!.date) throw new Error(`duplicate holiday: ${holidays[i]!.date}`);
  }

  const perYear = new Map<number, number>();
  for (const h of holidays) perYear.set(Number(h.date.slice(0, 4)), (perYear.get(Number(h.date.slice(0, 4))) ?? 0) + 1);
  if (perYear.size === 0) throw new Error(`no holidays from ${firstYear}`);
  const years = [...perYear.keys()];
  const lastYear = Math.max(...years);
  for (let y = firstYear; y <= lastYear; y++) {
    const n = perYear.get(y) ?? 0;
    if (n < MIN_PER_YEAR) throw new Error(`too few holidays in ${y}: ${n}`);
  }
  const dateSet = new Set(holidays.map((h) => h.date));
  for (let y = Math.max(firstYear, FIXED_FROM); y <= lastYear; y++) {
    for (const md of FIXED_DAYS) if (!dateSet.has(`${y}-${md}`)) throw new Error(`missing fixed holiday ${y}-${md}`);
  }
  return holidays;
}

export type HolidayYears = Record<string, [string, string][]>;

/** 年ごとの [日付, 名称] にまとめる。holidays.json の years と同じ形 */
export function groupByYear(holidays: readonly Holiday[]): HolidayYears {
  const years: HolidayYears = {};
  for (const h of holidays) (years[h.date.slice(0, 4)] ??= []).push([h.date, h.name]);
  return years;
}

/** 内容のハッシュを取るための、決まった形の文字列（年の昇順、各年は日付順） */
export function canonicalYears(years: HolidayYears): string {
  return JSON.stringify(Object.keys(years).sort().map((y) => [y, years[y]]));
}

/** protectThrough 年までで、祝日の日付か名称が変わった（増えた・減った・消えた年を含む）年 */
export function changedPastYears(before: HolidayYears, after: HolidayYears, protectThrough: number): string[] {
  const ys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...ys]
    .filter((y) => Number(y) <= protectThrough && y in before && JSON.stringify(before[y]) !== JSON.stringify(after[y]))
    .sort();
}
