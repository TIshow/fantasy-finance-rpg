import type { NextRequest } from "next/server";
import { handle, json, parseParam, teamToken, uuid } from "@/server/http";
import { getState } from "@/server/state";

/** 公開状態と本人の状態。?since=版番号 が今の版と同じで、本人の情報も不要なら中身を省く。 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const id = parseParam(uuid, (await ctx.params).id);
    const state = await getState(id, teamToken(req, id));
    const since = Number(req.nextUrl.searchParams.get("since"));
    if (state.own === null && since === state.public.version) {
      return json({ unchanged: true, version: state.public.version, serverNow: state.public.serverNow });
    }
    return json(state);
  });
}
