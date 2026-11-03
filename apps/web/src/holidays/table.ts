// 祝日の一覧の型と、範囲の外の日付を例外にする集合。JSON を読まない純粋なモジュール（イベントログの照合が版ごとの一覧に使う）。
export interface HolidayTable {
  firstYear: number;
  lastYear: number;
  /** 取得元CSVのSHA-256（取得元の記録） */
  sourceSha256: string;
  /** 一覧の中身（years を canonicalYears にした文字列）のSHA-256。台帳の約定・評価の記録に、使った一覧の版として残す */
  contentSha256: string;
  dates: ReadonlySet<string>;
}

function yearOf(date: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const [y, mo, d] = [Number(m?.[1]), Number(m?.[2]), Number(m?.[3])];
  const day = new Date(Date.UTC(y, mo - 1, d));
  if (!m || day.getUTCFullYear() !== y || day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d) throw new Error(`invalid date: ${date}`);
  return y;
}

/** 一覧の範囲の外の日付を引かれたら例外にする集合。カレンダーが前後の営業日を探して範囲の外まで歩いても、黙って営業日にしない */
class CoveredHolidays extends Set<string> {
  constructor(
    private readonly table: HolidayTable,
    values: Iterable<string>,
  ) {
    super(values);
  }
  override has(date: string): boolean {
    const year = yearOf(date);
    if (year < this.table.firstYear || year > this.table.lastYear) throw new Error(`holiday data covers ${this.table.firstYear}-${this.table.lastYear}, not ${year}`);
    return super.has(date);
  }
}

/**
 * from から to までの日付を判定するための祝日の一覧を返す。from・to のどちらかの年がデータの範囲の外なら例外。
 * 返す集合も、範囲の外の日付を has() で引くと例外になる。
 */
export function coveredHolidays(table: HolidayTable, from: string, to: string = from): ReadonlySet<string> {
  const covered = new CoveredHolidays(table, table.dates);
  for (const date of [from, to]) covered.has(date);
  return covered;
}
