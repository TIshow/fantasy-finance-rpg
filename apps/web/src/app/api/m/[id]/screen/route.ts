import type { NextRequest } from "next/server";
import { handle, json, parseParam, uuid } from "@/server/http";
import { getState } from "@/server/state";

/** 会場画面用。公開情報だけを返す。 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const id = parseParam(uuid, (await ctx.params).id);
    return json((await getState(id)).public);
  });
}
