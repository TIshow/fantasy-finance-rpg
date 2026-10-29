import type { NextRequest } from "next/server";
import { assertWriteRequest, extendBody, handle, hostAction, HOST_TOKEN_HEADER, json, parseParam, readJson, uuid } from "@/server/http";
import { advance } from "@/server/service";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string; action: string }> }) {
  return handle(async () => {
    assertWriteRequest(req);
    const p = await ctx.params;
    const id = parseParam(uuid, p.id);
    const action = parseParam(hostAction, p.action);
    const body = await readJson(req, extendBody);
    const token = req.headers.get(HOST_TOKEN_HEADER) ?? undefined;
    return json(await advance(id, { kind: "host", action, token, ms: body.ms ?? 15_000 }));
  });
}
