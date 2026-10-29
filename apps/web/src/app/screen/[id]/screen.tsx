"use client";
import { useCountdown, useMatch } from "@/app/_lib/client";
import { Change, Flow, History, News, PhaseBar, Ranking } from "@/app/_lib/views";

/** 会場画面。公開情報だけを表示する（個別の予約や保有は出さない）。 */
export function Screen({ matchId }: { matchId: string }) {
  const { snap } = useMatch(`/api/m/${matchId}/screen`);
  const seconds = useCountdown(snap);
  if (!snap) return <main><p className="muted">読み込み中…</p></main>;
  const p = snap.public;
  const before = p.lastClearing?.pricesBefore;
  return (
    <main>
      <h1>GUILD MARKET — {p.scenario.title}</h1>
      <section>
        <PhaseBar p={p} seconds={seconds} />
        {p.phase === "LOBBY" && (
          <p>
            参加コード <span className="big">{p.joinCode}</span>　参加 {p.teamCount}/{p.capacity}
          </p>
        )}
      </section>
      <section className="grid">
        {p.scenario.guilds.map((g) => (
          <div key={g.id} className="panel">
            <div>
              <strong style={{ color: g.color }}>{g.seal}</strong> {g.name}
            </div>
            <div className="big">
              {p.prices[g.id]}G <Change now={p.prices[g.id]!} before={before?.[g.id]} />
            </div>
          </div>
        ))}
      </section>
      <News p={p} />
      <Flow p={p} />
      <Ranking p={p} />
      <History p={p} />
      {p.phase === "RESULT" && p.scenario.winner && (
        <section>
          <h2>{p.scenario.guilds.find((g) => g.id === p.scenario.winner)!.name}が王国勲章を獲得</h2>
        </section>
      )}
    </main>
  );
}
