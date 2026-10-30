"use client";
import { useCountdown, useMatch, type PublicState } from "@/app/_lib/client";
import { Card, Change, cx, FlowCard, GuildSeal, NewsCard, PhaseBar, RankingCard, ReplayChart } from "@/app/_lib/views";

/** 会場画面（TV・プロジェクター向け）。公開情報だけを表示し、個別の予約や保有は出さない。 */
export function Screen({ matchId }: { matchId: string }) {
  const { snap } = useMatch(`/api/m/${matchId}/screen`);
  const seconds = useCountdown(snap);
  if (!snap) return <main className="p-6 text-mute">読み込み中…</main>;
  const p = snap.public;
  const before = p.lastClearing?.pricesBefore;
  const revealKey = p.lastClearing?.round ?? 0;
  const totalMs = p.phase in p.durations ? p.durations[p.phase as keyof PublicState["durations"]] : undefined;
  const winner = p.scenario.winner ? p.scenario.guilds.find((g) => g.id === p.scenario.winner) : null;
  return (
    <main className="mx-auto grid max-w-7xl gap-4 p-6">
      <div className="flex items-center gap-4">
        <h1 className="text-3xl font-bold text-gold">GUILD MARKET</h1>
        <span className="text-xl text-mute">{p.scenario.title}</span>
      </div>
      <Card>
        <PhaseBar p={p} seconds={seconds} totalMs={totalMs} />
        {p.phase === "LOBBY" && (
          <p className="mt-3 text-2xl">
            参加コード <span className="text-5xl font-bold tracking-widest text-gold">{p.joinCode}</span>　参加 {p.teamCount}／{p.capacity}
          </p>
        )}
      </Card>
      {winner && (
        <Card testId="screen-winner" className="border-gold text-center">
          <div className="text-4xl font-bold text-gold">{winner.name}が王国勲章を獲得</div>
        </Card>
      )}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {p.scenario.guilds.map((g) => (
          <Card key={g.id}>
            <div className="flex items-center gap-2 text-xl">
              <GuildSeal guild={g} size={44} />
              <span className="font-bold">{g.name}</span>
            </div>
            <div key={revealKey} className={cx("mt-3 flex items-baseline gap-3 px-1", revealKey > 0 && "reveal")}>
              <span data-testid={`screen-price-${g.id}`} className="text-6xl font-bold tabular-nums">
                {p.prices[g.id]}G
              </span>
              <Change now={p.prices[g.id]!} before={before?.[g.id]} className="text-2xl" />
            </div>
          </Card>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <NewsCard p={p} big />
        <FlowCard p={p} big />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <RankingCard p={p} big />
        {p.priceHistory.length > 1 && <ReplayChart p={p} />}
      </div>
    </main>
  );
}
