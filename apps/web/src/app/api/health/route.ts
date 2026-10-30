import { handle, json } from "@/server/http";
import { checkDatabase } from "@/server/maintenance";

/** 当日の朝の確認用。DBにつながるかだけを返す（接続先などは出さない）。 */
export async function GET() {
  return handle(async () => {
    const db = await checkDatabase().catch(() => false);
    return json({ ok: db, db }, { status: db ? 200 : 503 });
  });
}
