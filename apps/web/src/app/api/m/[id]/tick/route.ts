import type { NextRequest } from "next/server";
import { assertWriteRequest, handle, json, parseParam, uuid } from "@/server/http";
import { advance } from "@/server/service";

/** advanceIfDue。誰が何回呼んでもよい。期限前なら何もしない。 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    assertWriteRequest(req);
    const id = parseParam(uuid, (await ctx.params).id);
    return json(await advance(id, { kind: "tick" }));
  });
}
