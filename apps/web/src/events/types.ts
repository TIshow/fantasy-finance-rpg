// 監査用イベントログの型（docs/EVENT_LOG.md §2・§3）。種類ごとの中身の型と検査は、再計算のPRで足す。

export const SCHEMA = 1;

export const EVENT_TYPES = [
  "source.captured",
  "prices.open",
  "prices.close",
  "corporate_action.announced",
  "company.listed",
  "auction.cleared",
  "shares.allotted",
  "company.disclosed",
  "market.closed",
  "holidays.adopted",
  "universe.set",
  "agent.registered",
  "agent.run",
  "llm.batch.submitted",
  "llm.batch.sent",
  "llm.batch.closed",
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

/**
 * agent.run と llm.batch.submitted の、省略できる試運転の印（#179）。試運転の日の記録だけが dryRun: true を書く。false などほかの値は断り、
 * 試運転でない記録は項目を書かない。印は依頼（llm.batch.submitted）を記録したときに決まり、その答えから書く agent.run は
 * 依頼と同じ印を持つ（食い違えば断る）。印のある注文の判断（purpose: "order"）からは、注文票を確定できない（拒否の記録が残る）
 */
export interface AgentRunDryRun {
  dryRun?: true;
}

/**
 * correction.issued の対象の種類（#179）。post は投稿（targetSeq は post.published）。input は入力データ（targetSeq は
 * EVENT_LOG §6.2 の prices.open・prices.close・corporate_action.announced）。台帳の誤りは ledger.adjusted で直す
 */
export const CORRECTION_KINDS = ["post", "input"] as const;
export type CorrectionKind = (typeof CORRECTION_KINDS)[number];
/** correction.issued の理由の最大の文字数（JavaScript の文字列の長さ） */
export const CORRECTION_REASON_MAX = 500;

/**
 * correction.issued の中身（#179。EVENT_LOG §3.4）。訂正する対象は targetSeq の1件だけで、前の seq であること。
 * refs に入れた、targetSeq のほかの seq は引用として扱う。ここにない項目は断る
 */
export interface CorrectionIssuedPayload {
  targetSeq: number;
  kind: CorrectionKind;
  /** 空でない、CORRECTION_REASON_MAX 文字までの理由 */
  reason: string;
  /** 新しい本文（または正しい値）のハッシュ。SHA-256 の16進（小文字64文字）。あれば書く */
  newBodyHash?: string;
}

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
