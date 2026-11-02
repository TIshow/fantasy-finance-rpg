// イベント・口座・ログの外の本文のハッシュ（docs/EVENT_LOG.md §5）。
// SHA-256 は Web Crypto（crypto.subtle）で計算する。ブラウザと Node のどちらにもあり、node:* に依存しない。
import type { Account } from "../ledger/types";
import { canonicalize, checkText } from "./canonical";
import type { LogEvent } from "./types";

export const EVENT_PREFIX = "ffr-event-v1\n";
export const ACCOUNT_PREFIX = "ffr-account-v1\n";
export const SALT_BYTES = 16;

const utf8 = (s: string) => new TextEncoder().encode(s);

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** hash を除いたイベントのハッシュ */
export async function eventHash(event: Omit<LogEvent, "hash">): Promise<string> {
  return sha256Hex(utf8(EVENT_PREFIX + canonicalize(event)));
}

export async function accountHash(account: Account): Promise<string> {
  return sha256Hex(utf8(ACCOUNT_PREFIX + canonicalize(account)));
}

/**
 * ログの外に置く本文のハッシュ：SHA-256(乱数 ‖ 本文)（§5.2）。本文は NFC の文字列か、RFC 8785 で正規化する値。
 * 文字列の "123" と値の 123 は同じハッシュになる。どちらとして保存したかは、イベントの種類と項目で決まる
 */
export async function bodyHash(salt: Uint8Array, body: string | { value: unknown }): Promise<string> {
  if (!(salt instanceof Uint8Array) || salt.length !== SALT_BYTES) throw new Error(`salt must be ${SALT_BYTES} bytes`);
  let text: string;
  if (typeof body === "string") {
    checkText(body, "body");
    text = body;
  } else {
    text = canonicalize(body.value);
  }
  const b = utf8(text);
  const bytes = new Uint8Array(salt.length + b.length);
  bytes.set(salt);
  bytes.set(b, salt.length);
  return sha256Hex(bytes);
}
