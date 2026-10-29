// HTTP経由の通し確認。6商会・運営・会場が、短縮版の5ラウンドを最後まで遊ぶ。
// 使い方: npm run dev（別の端末）→ npm run smoke -- [http://localhost:3000]
// 各商会は自分のcookieを持ち、状態の取得・締切処理・注文をすべてAPIで行う。
import { createMatch } from "../src/server/service";
import { prisma } from "../src/server/db/client";
import { createRng } from "../src/engine/rng";

const base = process.argv[2] ?? "http://localhost:3000";
const TEAMS = 6;

class Client {
  cookie = "";
  constructor(readonly name: string) {}
  async call(path: string, method = "GET", body?: unknown, extra: Record<string, string> = {}) {
    const res = await fetch(base + path, {
      method,
      headers: { "x-gm-client": "1", "content-type": "application/json", cookie: this.cookie, ...extra },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get("set-cookie");
    if (set) this.cookie = set.split(";")[0]!;
    return { status: res.status, data: (await res.json()) as any };
  }
}

const { matchId, joinCode, hostToken } = await createMatch({
  scenarioId: "s01-meeting-5r",
  k: 2,
  timing: { newsMs: 1_000, orderMs: 3_000, publishMs: 2_500, revealDelayMs: 1_500 },
});
await prisma.$disconnect();
console.log(`試合 ${matchId}（参加コード ${joinCode}）`);

const teams = Array.from({ length: TEAMS }, (_, i) => new Client(`商会${i + 1}`));
for (const t of teams) {
  const r = await t.call("/api/join", "POST", { code: joinCode, nickname: t.name });
  if (r.status !== 200) throw new Error(`join failed: ${JSON.stringify(r.data)}`);
}
const hostClient = new Client("host");
const start = await hostClient.call(`/api/m/${matchId}/host/start`, "POST", {}, { "x-host-token": hostToken });
if (start.status !== 200) throw new Error(`start failed: ${JSON.stringify(start.data)}`);

const rng = createRng(7);
const ordered = new Set<string>();
const reveals: Record<number, number[]> = {};
let result: any = null;
const t0 = Date.now();
while (Date.now() - t0 < 120_000) {
  const states = await Promise.all(teams.map((t) => t.call(`/api/m/${matchId}/state`)));
  const p = states[0]!.data.public;
  // 新価格が見えた時刻（各クライアント）を記録する
  for (const [i, s] of states.entries()) {
    const c = s.data.public.lastClearing;
    if (c && !(reveals[c.round] ??= []).includes(i)) reveals[c.round]!.push(i);
  }
  if (p.phase === "RESULT") {
    result = states;
    break;
  }
  if (p.phase === "ORDER_OPEN" && !ordered.has(String(p.round))) {
    ordered.add(String(p.round));
    await Promise.all(
      teams.map(async (t, i) => {
        const own = states[i]!.data.own;
        const g = p.scenario.guilds[Math.floor(rng() * 4)].id;
        const held = own.positions[g]?.qty ?? 0;
        const side = held > 0 && rng() < 0.4 ? "sell" : "buy";
        const qty = side === "sell" ? Math.min(held, 5) : 1 + Math.floor(rng() * 10);
        const r = await t.call(`/api/m/${matchId}/r/${p.round}/orders/${g}`, "PUT", { side, qty, baseRevision: 0 });
        if (r.status !== 200 && r.data.error !== "insufficient_cash") throw new Error(`order failed: ${JSON.stringify(r.data)}`);
      }),
    );
  }
  // 期限を過ぎていれば、全員が締切処理を送る（冪等）
  const now = p.serverNow;
  if (p.phaseEndsAt !== null && now >= p.phaseEndsAt + (p.phase === "ORDER_OPEN" ? p.graceMs : 0)) {
    await Promise.all(teams.map((t) => t.call(`/api/m/${matchId}/tick`, "POST", {})));
  }
  await new Promise((r) => setTimeout(r, 250));
}
if (!result) throw new Error("did not reach RESULT within 120 s");

const screen = await new Client("screen").call(`/api/m/${matchId}/screen`);
const ranking = screen.data.ranking as { nickname: string; assets: number }[];
console.log(`決算：${screen.data.scenario.winner}、価格の推移 ${screen.data.priceHistory.map((h: any) => h.dragon).join("→")}（ドラゴン）`);
console.log(`順位：${ranking.map((r) => `${r.nickname} ${r.assets}G`).join(" / ")}`);
const leak = JSON.stringify(screen.data).includes("cookie") || "own" in screen.data;
console.log(`会場画面に本人の情報が含まれない：${!leak}`);
const ownCounts = result.map((s: any) => s.data.own.allFills.length);
console.log(`各商会の約定記録：${ownCounts.join(", ")}件、所要時間 ${((Date.now() - t0) / 1000).toFixed(1)}秒`);
if (screen.data.priceHistory.length !== 6) throw new Error("expected 5 cleared rounds");
