// Route Handlers の共通処理。入力は zod で確かめ、書き込みには独自ヘッダーとJSONを必須にする（CSRF対策）。
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { AppError } from "./errors";

export const CLIENT_HEADER = "x-gm-client";
export const HOST_TOKEN_HEADER = "x-host-token";
export const teamCookieName = (matchId: string) => `gm_${matchId.replaceAll("-", "")}`;

export const uuid = z.uuid();
export const guildIdParam = z.string().regex(/^[a-z]{1,20}$/);
export const roundParam = z.coerce.number().int().min(1).max(50);
export const nickname = z
  .string()
  .transform((s) => s.normalize("NFKC").trim())
  .pipe(z.string().min(1).max(12).regex(/^[^\p{C}<>]+$/u));

export const joinBody = z.object({ code: z.string().regex(/^\d{6}$/), nickname });
export const orderBody = z.object({
  side: z.enum(["buy", "sell"]),
  qty: z.number().int().min(1).max(100),
  baseRevision: z.number().int().min(0),
});
export const cancelBody = z.object({ baseRevision: z.number().int().min(0) });
export const investigateBody = z.object({ source: z.enum(["newspaper", "official", "ai"]) });
export const extendBody = z.object({ ms: z.number().int().min(1000).max(600_000) }).partial();
export const hostAction = z.enum(["start", "pause", "resume", "extend", "close-now", "next", "abort"]);

export function json(data: unknown, init?: ResponseInit) {
  return NextResponse.json(data, { ...init, headers: { "cache-control": "no-store", ...init?.headers } });
}

/** 書き込みAPIの前提：独自ヘッダー（フォームや画像タグからは送れない）とJSON */
export function assertWriteRequest(req: NextRequest) {
  if (req.headers.get(CLIENT_HEADER) !== "1") throw new AppError("missing_client_header", 400);
  const type = req.headers.get("content-type") ?? "";
  if (!type.startsWith("application/json")) throw new AppError("json_required", 415);
}

export async function readJson<T>(req: NextRequest, schema: z.ZodType<T>): Promise<T> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new AppError("invalid_json", 400);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new AppError("invalid_input", 400);
  return parsed.data;
}

export function parseParam<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AppError("not_found", 404);
  return parsed.data;
}

/** AppError は code だけを返す。それ以外は中身を出さずに500にする（ログにもトークンや商会名を出さない）。 */
export async function handle(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof AppError) return json({ error: e.code, ...e.detail }, { status: e.status });
    console.error("request failed:", e instanceof Error ? e.name : "unknown");
    return json({ error: "internal" }, { status: 500 });
  }
}

/**
 * 参加者のcookie。Secure は接続がHTTPSのときだけ付ける。
 * LANの内部テスト（http://192.168.x.x）で Secure を付けると、スマートフォンのブラウザが保存せず参加できない。
 * 本番（Vercel）はHTTPSなので必ず付く。
 */
export function setTeamCookie(req: NextRequest, res: NextResponse, matchId: string, token: string) {
  res.cookies.set(teamCookieName(matchId), token, {
    httpOnly: true,
    secure: req.nextUrl.protocol === "https:",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 12,
  });
}

export function teamToken(req: NextRequest, matchId: string): string | undefined {
  return req.cookies.get(teamCookieName(matchId))?.value;
}
