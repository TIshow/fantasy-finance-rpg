// LLM の AI 投資家の出力を読み、形と上限を確かめる（#179）。
// 形：{"post":{"board","text"} または null,"orders":[{"symbol","side","qty","limit"?}],"note"?}。前後の説明は許さない（```json の囲みだけは外す）。
// 文字：投稿の本文・note・銘柄は、NFC であること・U+0000 と対になっていないサロゲートを含まないこと（記録の正規化した JSON で断られるものを、ここで理由つきで断る）。
// 投稿の本文が空白と見えない文字（ゼロ幅スペースなど）だけなら断る。
// 上限：投稿は1件・本文は400字まで・note は200字まで・銘柄は16文字まで・掲示板は上場した取引対象の銘柄か「全体」。注文は10件まで。出力が上限で途中で切れた答えは使わない。
// 合わなければ、毎日の実行が agent.run を失敗（invalid_output）として記録し、そのAIはその日は注文しない（見る人に見える失敗として残す）。
// 注文の中身（100株単位・持っている株数・値幅・知らない銘柄など）はここでは見ない。注文票の確定の検査が、拒否の記録にする。
import { TICK } from "../ledger/auction";
import type { Order } from "../ledger/types";
import { GENERAL_BOARD, MAX_ORDERS, NOTE_MAX_CHARS, POST_MAX_CHARS } from "./investor-prompt";

export interface InvestorDecision {
  post: { board: string; text: string } | null;
  /** 指値は 0.1円単位に直したもの（出力は円の整数） */
  orders: Order[];
  note: string;
}

/** 失敗の理由（記録には書かず、毎日の実行の結果と試験で使う） */
export type InvestorOutputProblem =
  | "truncated"
  | "not_json"
  | "shape"
  /** 文字の決まり（NFC・U+0000・対になっていないサロゲート）に合わない */
  | "text_chars"
  | "post_board"
  | "post_length"
  /** 投稿の本文が、空白と見えない文字だけ */
  | "post_blank"
  | "note_length"
  | "too_many_orders"
  | "order_shape";

export type InvestorOutput = { ok: true; decision: InvestorDecision } | { ok: false; problem: InvestorOutputProblem };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const only = (o: Record<string, unknown>, keys: readonly string[]) => Object.keys(o).every((k) => keys.includes(k));
const isPositiveInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 1;
/** 指値の上限（円）。0.1円単位に直しても安全な整数に収まる範囲 */
const MAX_LIMIT_YEN = Math.floor(Number.MAX_SAFE_INTEGER / TICK);
/** 銘柄の文字数の上限（取引対象の銘柄コードより十分長い。知らない銘柄は注文票の確定の検査が断る） */
export const SYMBOL_MAX_CHARS = 16;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const badChars = (s: string) => s.includes("\u0000") || LONE_SURROGATE.test(s) || s !== s.normalize("NFC");
/**
 * 空白・制御文字・書式の文字（ゼロ幅スペース・ゼロ幅接合子・BOM・向きの指定など）、結合文字（異体字セレクタ・U+034F・U+17B4 など。
 * 前の文字に付くだけで、それだけでは見えない）と、見えない詰め物の文字
 */
const INVISIBLE = /[\p{White_Space}\p{Cc}\p{Cf}\p{M}\u115F\u1160\u3164\uFFA0\u2800]/gu;
const chars = (s: string) => [...s].length;
const FENCE = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```$/;

/**
 * 出力を読む。boards は投稿してよい銘柄（上場した取引対象の銘柄）。truncated は、出力の上限で途中で切れた答え
 * （閉じた結果の truncated: true）
 */
export function parseInvestorOutput(output: string, o: { boards: readonly string[]; truncated: boolean }): InvestorOutput {
  if (o.truncated) return { ok: false, problem: "truncated" };
  const trimmed = output.trim();
  let v: unknown;
  try {
    v = JSON.parse(FENCE.exec(trimmed)?.[1] ?? trimmed);
  } catch {
    return { ok: false, problem: "not_json" };
  }
  if (!isObj(v) || !only(v, ["post", "orders", "note"]) || !Array.isArray(v.orders) || (v.note !== undefined && typeof v.note !== "string")) return { ok: false, problem: "shape" };
  if (typeof v.note === "string" && badChars(v.note)) return { ok: false, problem: "text_chars" };
  if (typeof v.note === "string" && chars(v.note) > NOTE_MAX_CHARS) return { ok: false, problem: "note_length" };
  let post: InvestorDecision["post"] = null;
  if (v.post !== null && v.post !== undefined) {
    const p = v.post;
    if (!isObj(p) || !only(p, ["board", "text"]) || typeof p.board !== "string" || typeof p.text !== "string") return { ok: false, problem: "shape" };
    if (p.board !== GENERAL_BOARD && !o.boards.includes(p.board)) return { ok: false, problem: "post_board" };
    if (badChars(p.text)) return { ok: false, problem: "text_chars" };
    if (chars(p.text) > POST_MAX_CHARS) return { ok: false, problem: "post_length" };
    if (p.text.replace(INVISIBLE, "") === "") return { ok: false, problem: "post_blank" };
    post = { board: p.board, text: p.text };
  }
  if (v.orders.length > MAX_ORDERS) return { ok: false, problem: "too_many_orders" };
  const orders: Order[] = [];
  for (const x of v.orders as unknown[]) {
    if (!isObj(x) || !only(x, ["symbol", "side", "qty", "limit"]) || typeof x.symbol !== "string" || (x.side !== "buy" && x.side !== "sell") || !isPositiveInt(x.qty)) return { ok: false, problem: "order_shape" };
    if (badChars(x.symbol) || chars(x.symbol) > SYMBOL_MAX_CHARS) return { ok: false, problem: "order_shape" };
    if (x.limit !== undefined && (!isPositiveInt(x.limit) || x.limit > MAX_LIMIT_YEN)) return { ok: false, problem: "order_shape" };
    orders.push({ symbol: x.symbol, side: x.side, qty: x.qty, ...(x.limit === undefined ? {} : { limit: x.limit * TICK }) });
  }
  return { ok: true, decision: { post, orders, note: (v.note as string | undefined) ?? "" } };
}
