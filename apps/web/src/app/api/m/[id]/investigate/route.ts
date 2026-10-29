import type { NextRequest } from "next/server";
import { assertWriteRequest, handle, investigateBody, json, parseParam, readJson, teamToken, uuid } from "@/server/http";
import { useInvestigation } from "@/server/service";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    assertWriteRequest(req);
    const id = parseParam(uuid, (await ctx.params).id);
    const body = await readJson(req, investigateBody);
    const r = await useInvestigation(id, teamToken(req, id), body.source);
    return json({ round: r.round, source: r.source.id, name: r.source.name, result: r.source.result });
  });
}
