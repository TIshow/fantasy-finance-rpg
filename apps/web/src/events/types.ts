// 監査用イベントログの型（docs/EVENT_LOG.md §2・§3）。種類ごとの中身の型と検査は、再計算のPRで足す。

export const SCHEMA = 1;

export const EVENT_TYPES = [
  "source.captured",
  "prices.open",
  "prices.close",
  "corporate_action.announced",
  "company.listed",
  "auction.cleared",
  "market.closed",
  "holidays.adopted",
  "universe.set",
  "agent.registered",
  "agent.run",
  "post.published",
  "order_sheet.committed",
  "order_sheet.rejected",
  "fills.executed",
  "valuation.recorded",
  "corporate_actions.applied",
  "correction.issued",
  "ledger.adjusted",
  "content.withdrawn",
  "agent.suspended",
  "agent.resumed",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/** post.published の、省略できる投稿の種類と見立て（#107。観戦画面の掲示板が使う） */
export const POST_INTENTS = ["strategy", "feeling", "knowledge", "news"] as const;
export const POST_STANCES = ["bull", "bear", "neutral"] as const;
export type PostIntent = (typeof POST_INTENTS)[number];
export type PostStance = (typeof POST_STANCES)[number];

/** agent:<id> | system | operator:<役割>。認証した身元からサーバーが入れる */
export type Actor = `agent:${string}` | "system" | `operator:${string}`;

/** 連鎖に入れる前の中身。seq・prevHash・hash は sealEvent が入れる */
export interface EventDraft {
  type: EventType;
  /** サーバーが記録した時刻（UNIXミリ秒） */
  recordedAt: number;
  actor: Actor;
  /** 一意キーの並び（§4）。不要なら空 */
  keys: string[];
  /** 参照するイベントの seq。すべて自分の seq より小さい */
  refs: number[];
  /** RFC 8785 で正規化できる値（数は安全な整数だけ、文字列は NFC） */
  payload: unknown;
}

export interface LogEvent extends EventDraft {
  seq: number;
  schema: typeof SCHEMA;
  prevHash: string;
  hash: string;
}

/** seq 1 の prevHash */
export const GENESIS_HASH = "0".repeat(64);
