import type { NextRequest } from "next/server";
import { assertWriteRequest, handle, joinBody, json, readJson, setTeamCookie } from "@/server/http";
import { joinMatch } from "@/server/service";

export async function POST(req: NextRequest) {
  return handle(async () => {
    assertWriteRequest(req);
    const body = await readJson(req, joinBody);
    const { matchId, teamId, token } = await joinMatch(body.code, body.nickname);
    const res = json({ matchId, teamId });
    setTeamCookie(req, res, matchId, token);
    return res;
  });
}
