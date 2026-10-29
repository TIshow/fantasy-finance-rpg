import type { NextRequest } from "next/server";
import { z } from "zod";
import { notFound } from "@/server/errors";
import { handle, json, parseParam } from "@/server/http";
import { findMatchByCode } from "@/server/service";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ code: string }> }) {
  return handle(async () => {
    const code = parseParam(z.string().regex(/^\d{6}$/), (await ctx.params).code);
    const found = await findMatchByCode(code);
    if (!found) throw notFound("match_not_found");
    return json(found);
  });
}
