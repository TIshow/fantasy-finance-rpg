import { createHash, randomBytes, randomInt } from "node:crypto";

/** 32バイトの乱数トークン。DBにはハッシュだけを保存する（ARCHITECTURE §10）。 */
export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** 6桁の参加コード */
export function newJoinCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}
