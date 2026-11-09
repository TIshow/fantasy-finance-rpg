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

// ---- 架空の市場の取引日（D-047）----
// 架空の市場は、EVERY_DAY_FROM からは土日・祝日・年末年始も含めて毎日が取引日。それより前の日は、上の東証の営業日の決まりのまま
// （すでに記録した日の意味を変えないため）。運営者の臨時休場（market.closed）は、どの日でも取引日にしない。
// 実在の市場の暦（取り込み口など）は、上の isBusinessDay・nextBusinessDay・tradingDateFor を使い続ける。
//
// 下の関数の closed には、架空の市場の休みの集合を渡す。EventLog.holidays() か marketClosedDays() で作る。
// その集合は、EVERY_DAY_FROM より前は祝日と臨時休場、以後は臨時休場だけを含む（以後の祝日を含む生の一覧を渡さない）。

/** 架空の市場が毎日を取引日にする最初の日（D-047） */
export const EVERY_DAY_FROM = "2026-11-09";
const HOUR_MS = 3_600_000;

class MarketClosedDays extends Set<string> {
  constructor(
    private readonly base: ReadonlySet<string>,
    private readonly closures: ReadonlySet<string>,
  ) {
    super();
  }
  override has(date: string): boolean {
    return this.closures.has(date) || (date < EVERY_DAY_FROM && this.base.has(date));
  }
}

/**
 * 架空の市場の休みの集合を作る。EVERY_DAY_FROM より前は祝日（holidays）と臨時休場（closures）、以後は臨時休場だけ。
 * 以後の日は祝日の一覧を引かないので、一覧の範囲の外の日でも例外にならない
 */
export function marketClosedDays(holidays: ReadonlySet<string>, closures: ReadonlySet<string> = new Set()): ReadonlySet<string> {
  return new MarketClosedDays(holidays, closures);
}

/** 架空の市場の取引日か。EVERY_DAY_FROM 以後は、臨時休場でなければ毎日。それより前は isBusinessDay と同じ */
export function isTradingDay(date: string, closed: ReadonlySet<string>): boolean {
  parseDate(date);
  return date >= EVERY_DAY_FROM ? !closed.has(date) : isBusinessDay(date, closed);
}

function stepTradingDay(date: string, closed: ReadonlySet<string>, step: 1 | -1): string {
  let t = parseDate(date);
  for (let i = 0; i < 31; i++) {
    t += step * DAY_MS;
    if (isTradingDay(formatDate(t), closed)) return formatDate(t);
  }
  throw new Error(`no trading day within 31 days of ${date}`);
}

/** 架空の市場の次の取引日 */
export const nextTradingDay = (date: string, closed: ReadonlySet<string>) => stepTradingDay(date, closed, 1);
/** 架空の市場の前の取引日。例：2026-11-10 の前は 11-09。11-09 の前は、切り替えより前の土日を飛ばして 11-06 */
export const previousTradingDay = (date: string, closed: ReadonlySet<string>) => stepTradingDay(date, closed, -1);

/**
 * その時刻から見た、架空の市場の次の取引日：締め（8:30）がまだ来ていない最初の取引日（tradingDateFor の架空の市場の版）。
 * AIの登録の開始日、LLM の依頼の取引日、注文票の約定日に使う
 */
export function upcomingTradingDay(at: number, closed: ReadonlySet<string>): string {
  const today = formatDate(at + JST_MS);
  if (isTradingDay(today, closed) && at < cutoffOf(today)) return today;
  return nextTradingDay(today, closed);
}

/**
 * 取引日 D の判断（注文票の確定）を受け付け始める時刻：前の取引日の引け（16:30。締めの8時間後）。
 * 受け付けるのは、この時刻から D の締め（cutoffOf(D)）の前まで（#228 の lead の決定）
 */
export function decisionOpensAt(tradingDate: string, closed: ReadonlySet<string>): number {
  return cutoffOf(previousTradingDay(tradingDate, closed)) + 8 * HOUR_MS;
}
