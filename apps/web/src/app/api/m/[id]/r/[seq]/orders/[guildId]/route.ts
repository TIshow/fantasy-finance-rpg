import type { NextRequest } from "next/server";
import {
  assertWriteRequest,
  cancelBody,
  guildIdParam,
  handle,
  json,
  orderBody,
  parseParam,
  readJson,
  roundParam,
  teamToken,
  uuid,
} from "@/server/http";
import { cancelOrder, putOrder } from "@/server/service";

type Ctx = { params: Promise<{ id: string; seq: string; guildId: string }> };

async function params(ctx: Ctx) {
  const p = await ctx.params;
  return { id: parseParam(uuid, p.id), round: parseParam(roundParam, p.seq), guildId: parseParam(guildIdParam, p.guildId) };
}

/** 予約の作成・変更。枠（ラウンド×ギルド）単位で冪等。 */
export async function PUT(req: NextRequest, ctx: Ctx) {
  return handle(async () => {
    assertWriteRequest(req);
    const { id, round, guildId } = await params(ctx);
    const body = await readJson(req, orderBody);
    return json(await putOrder(id, teamToken(req, id), round, guildId, body));
  });
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  return handle(async () => {
    assertWriteRequest(req);
    const { id, round, guildId } = await params(ctx);
    const body = await readJson(req, cancelBody);
    return json(await cancelOrder(id, teamToken(req, id), round, guildId, body.baseRevision));
  });
}
