// 国民の祝日の一覧（東証の休業日の判定に使う）。`holidays.json` は `npm run holidays:update` が内閣府のCSVから作る（手で直さない）。
// 台帳（src/ledger/）には `holidaysFor()` の結果を引数で渡す。`holidayTable.dates` は範囲を確かめないので、台帳に直接渡さない。
// 返す集合は has() でだけ範囲を確かめる。写し取らず（new Set(...) や [...h] にせず）そのまま渡す。
import data from "./holidays.json";
import { coveredHolidays, type HolidayTable } from "./table";

export type { HolidayTable } from "./table";

const dates = new Set<string>();
for (const rows of Object.values(data.years)) for (const [date] of rows) dates.add(date as string);

export const holidayTable: HolidayTable = {
  firstYear: data.firstYear,
  lastYear: data.lastYear,
  sourceSha256: data.sourceSha256,
  contentSha256: data.contentSha256,
  dates,
};

/**
 * from から to までの日付を判定するための祝日の一覧を返す。from・to のどちらかの年がデータの範囲の外なら例外。
 * 返す集合も、範囲の外の日付を has() で引くと例外になる。
 */
export function holidaysFor(from: string, to: string = from, table: HolidayTable = holidayTable): ReadonlySet<string> {
  return coveredHolidays(table, from, to);
}
