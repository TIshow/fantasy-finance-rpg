// 東証の営業日と注文の締め（docs/PAPER_TRADING_RULES.md §1）。祝日の一覧は呼び出し側から受け取る。
const DAY_MS = 86_400_000;
const JST_MS = 9 * 3_600_000;

/** YYYY-MM-DD を、その日の 0:00 UTC の UNIXミリ秒にする。存在しない日付は例外 */
function parseDate(date: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const [y, mo, d] = [Number(m?.[1]), Number(m?.[2]), Number(m?.[3])];
  const t = Date.UTC(y, mo - 1, d);
  const day = new Date(t);
  if (!m || day.getUTCFullYear() !== y || day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d) throw new Error(`invalid trading date: ${date}`);
  return t;
}

const formatDate = (t: number) => new Date(t).toISOString().slice(0, 10);

/** 土日、12月31日〜1月3日、祝日（holidays）でなければ営業日 */
export function isBusinessDay(date: string, holidays: ReadonlySet<string>): boolean {
  const day = new Date(parseDate(date));
  const wd = day.getUTCDay();
  const md = date.slice(5);
  return wd !== 0 && wd !== 6 && md !== "12-31" && md !== "01-01" && md !== "01-02" && md !== "01-03" && !holidays.has(date);
}

/** 実在する YYYY-MM-DD の文字列か */
export function isValidDate(date: unknown): date is string {
  if (typeof date !== "string") return false;
  try {
    parseDate(date);
    return true;
  } catch {
    return false;
  }
}

function stepBusinessDay(date: string, holidays: ReadonlySet<string>, step: 1 | -1): string {
  let t = parseDate(date);
  for (let i = 0; i < 31; i++) {
    t += step * DAY_MS;
    if (isBusinessDay(formatDate(t), holidays)) return formatDate(t);
  }
  throw new Error(`no business day within 31 days of ${date}`);
}

export const nextBusinessDay = (date: string, holidays: ReadonlySet<string>) => stepBusinessDay(date, holidays, 1);
export const previousBusinessDay = (date: string, holidays: ReadonlySet<string>) => stepBusinessDay(date, holidays, -1);

/** 約定日の注文の締め：その日の 8:30（日本時間）を UNIXミリ秒で返す */
export function cutoffOf(tradingDate: string): number {
  return parseDate(tradingDate) - JST_MS + 8.5 * 3_600_000;
}

/** その時刻に確定した注文票が約定する営業日：締めがまだ来ていない最初の営業日 */
export function tradingDateFor(committedAt: number, holidays: ReadonlySet<string>): string {
  const today = formatDate(committedAt + JST_MS);
  if (isBusinessDay(today, holidays) && committedAt < cutoffOf(today)) return today;
  return nextBusinessDay(today, holidays);
}
