import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

/** 32バイトの乱数トークン。DBにはハッシュだけを保存する（ARCHITECTURE §10）。 */
export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** トークンが保存済みのハッシュと一致するか。比較にかかる時間から一致の度合いを推測されないようにする。 */
export function tokenMatches(token: string | undefined, storedHash: string): boolean {
  if (!token) return false;
  const a = Buffer.from(hashToken(token), "hex");
  const b = Buffer.from(storedHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** 6桁の参加コード */
export function newJoinCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}
