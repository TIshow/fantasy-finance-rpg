// 東証の祝日の一覧。`holidays.json` は `npm run holidays:update` が内閣府のCSVから作る（手で直さない）。
// 台帳（src/ledger/）には `holidaysFor()` の結果を引数で渡す。
import data from "./holidays.json";

export interface HolidayTable {
  firstYear: number;
  lastYear: number;
  /** 取得元CSVのSHA-256。台帳の約定・評価の記録に、使った一覧の版として残す */
  sourceSha256: string;
  dates: ReadonlySet<string>;
}

const dates = new Set<string>();
for (const rows of Object.values(data.years)) for (const [date] of rows) dates.add(date as string);

export const holidayTable: HolidayTable = { firstYear: data.firstYear, lastYear: data.lastYear, sourceSha256: data.sourceSha256, dates };

function yearOf(date: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const [y, mo, d] = [Number(m?.[1]), Number(m?.[2]), Number(m?.[3])];
  const day = new Date(Date.UTC(y, mo - 1, d));
  if (!m || day.getUTCFullYear() !== y || day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d) throw new Error(`invalid date: ${date}`);
  return y;
}

/**
 * from から to までの日付を判定するための祝日の一覧を返す。from・to のどちらかの年がデータの範囲の外なら例外。
 * 一覧が古いまま祝日を営業日と誤判定するのを、黙って通さないため。呼び出し側は、判定で触れる日付の範囲
 * （前営業日・翌営業日を探して年をまたぐ分も含む）を渡すこと。返す集合は範囲の外を区別しない。
 */
export function holidaysFor(from: string, to: string = from, table: HolidayTable = holidayTable): ReadonlySet<string> {
  for (const date of [from, to]) {
    const year = yearOf(date);
    if (year < table.firstYear || year > table.lastYear) throw new Error(`holiday data covers ${table.firstYear}-${table.lastYear}, not ${year}`);
  }
  return table.dates;
}
