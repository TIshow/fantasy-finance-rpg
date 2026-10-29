"use client";
import type { PublicState } from "./client";
import { PHASE_LABEL } from "./client";

export function Change({ now, before }: { now: number; before?: number }) {
  if (before === undefined || before === now) return <span className="muted">±0</span>;
  const d = now - before;
  return <span className={d > 0 ? "up" : "down"}>{d > 0 ? `▲+${d}` : `▼${d}`}</span>;
}

export function PhaseBar({ p, seconds }: { p: PublicState; seconds: number | null }) {
  return (
    <div className="row">
      <strong>{p.round > 0 ? `第${p.round}ラウンド / ${p.totalRounds}` : "開始前"}</strong>
      <span>{PHASE_LABEL[p.phase] ?? p.phase}</span>
      {seconds !== null && <span className="big">{seconds}秒</span>}
    </div>
  );
}

export function News({ p }: { p: PublicState }) {
  if (!p.news) return null;
  return (
    <section>
      <div className="muted">
        {p.news.act}「{p.news.title}」
      </div>
      <p>{p.news.text}</p>
      {p.news.details.map((d) => (
        <p key={d.label}>
          <strong>{d.label}：</strong>
          {d.text}
        </p>
      ))}
    </section>
  );
}

export function Flow({ p }: { p: PublicState }) {
  const c = p.lastClearing;
  if (!c) return null;
  return (
    <section>
      <h3>第{c.round}ラウンドの注文（人数）</h3>
      <table>
        <thead>
          <tr>
            <th>ギルド</th>
            <th>王国の商会{c.npcCount}</th>
            <th>参加者</th>
          </tr>
        </thead>
        <tbody>
          {p.scenario.guilds.map((g) => {
            const s = c.stats[g.id]!;
            return (
              <tr key={g.id}>
                <td>{g.name}</td>
                <td>
                  買い{s.npcBuyers}・売り{s.npcSellers}・様子見{c.npcCount - s.npcBuyers - s.npcSellers}
                </td>
                <td>
                  買い{s.playerBuyers}・売り{s.playerSellers}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

export function Ranking({ p }: { p: PublicState }) {
  if (!p.ranking) return null;
  return (
    <section>
      <h3>順位</h3>
      <table>
        <tbody>
          {p.ranking.map((r) => (
            <tr key={r.nickname}>
              <td>{r.rank}位</td>
              <td>{r.nickname}</td>
              <td>{r.assets.toLocaleString()}G</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export function History({ p }: { p: PublicState }) {
  if (p.priceHistory.length < 2) return null;
  return (
    <section>
      <h3>価格の推移</h3>
      <table>
        <thead>
          <tr>
            <th>ギルド</th>
            {p.priceHistory.map((_, i) => (
              <th key={i}>{i === 0 ? "開始" : `R${i}`}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {p.scenario.guilds.map((g) => (
            <tr key={g.id}>
              <td>{g.name}</td>
              {p.priceHistory.map((h, i) => (
                <td key={i}>{h[g.id]}G</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
