// 投稿の本文（ログの外の値）と、投稿の種類・見立ての読み取り。
// 本文は文字列。種類（intent）と見立て（stance）は、`post.published` の記録の項目が正本（#107）。
// 一覧にない値・文字列でない値は捨てて null（未分類・見立てなし）にする
import { POST_INTENTS, POST_STANCES, type PostIntent, type PostStance } from "../events/types";

export type Intent = PostIntent;
export type Stance = PostStance;

/** 本文。文字列でなければ null */
export const readText = (v: unknown): string | null => (typeof v === "string" ? v : null);
export const intentOf = (v: unknown): Intent | null => POST_INTENTS.find((x) => x === v) ?? null;
export const stanceOf = (v: unknown): Stance | null => POST_STANCES.find((x) => x === v) ?? null;
