import type { NextRequest } from "next/server";
import { handle, HOST_TOKEN_HEADER, json, parseParam, uuid } from "@/server/http";
import { getHostStatus } from "@/server/state";

/** 運営画面用：各商会の接続状況と予約数。運営のトークンが要る。 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const id = parseParam(uuid, (await ctx.params).id);
    return json(await getHostStatus(id, req.headers.get(HOST_TOKEN_HEADER) ?? undefined));
  });
}
