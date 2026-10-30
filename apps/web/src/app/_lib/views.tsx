"use client";
import type { ReactNode } from "react";
import { PHASE_LABEL, type OwnState, type PublicState } from "./client";

type Guild = PublicState["scenario"]["guilds"][number];

export function cx(...names: (string | false | null | undefined)[]) {
  return names.filter(Boolean).join(" ");
}

export function Card({ children, className, testId }: { children: ReactNode; className?: string; testId?: string }) {
  return (
    <section data-testid={testId} className={cx("rounded-xl border border-line bg-panel p-3 sm:p-4", className)}>
      {children}
    </section>
  );
}

/** ギルドの印（インラインSVG。絵文字は使わない） */
export function GuildSeal({ guild, size = 36 }: { guild: Guild; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" role="img" aria-label={guild.name} className="shrink-0">
      <circle cx="20" cy="20" r="18" fill="none" stroke={guild.color} strokeWidth="2.5" />
      <circle cx="20" cy="20" r="14" fill={guild.color} fillOpacity="0.18" />
      <text x="20" y="26" textAnchor="middle" fontSize="16" fontWeight="700" fill={guild.color}>
        {guild.seal}
      </text>
    </svg>
  );
}

/** 前回比。色だけでなく矢印と符号でも示す */
export function Change({ now, before, className }: { now: number; before?: number; className?: string }) {
  if (before === undefined || before === now) return <span className={cx("text-mute", className)}>±0</span>;
  const d = now - before;
  return <span className={cx(d > 0 ? "text-buy" : "text-sell", className)}>{d > 0 ? `▲ +${d}` : `▼ ${d}`}</span>;
}

export function PhaseBar({ p, seconds, totalMs }: { p: PublicState; seconds: number | null; totalMs?: number }) {
  const ratio = seconds !== null && totalMs ? Math.max(0, Math.min(1, (seconds * 1000) / totalMs)) : null;
  return (
    <div>
      <div className="flex items-center gap-3">
        <span className="text-sm text-mute">{p.round > 0 ? `第${p.round}ラウンド／全${p.totalRounds}` : "開始前"}</span>
        <span data-testid="phase-label" className={cx("rounded-full px-2 py-0.5 text-sm font-bold", p.phase === "ORDER_OPEN" ? "bg-gold text-night" : "bg-panel-2")}>
          {PHASE_LABEL[p.phase] ?? p.phase}
        </span>
        {seconds !== null && (
          <span className="ml-auto text-2xl font-bold tabular-nums" aria-live="off">
            {seconds}秒
          </span>
        )}
      </div>
      {ratio !== null && (
        <div className="mt-2 h-1.5 overflow-hidden rounded bg-panel-2" aria-hidden>
          <div className="h-full bg-gold transition-[width] duration-300" style={{ width: `${ratio * 100}%` }} />
        </div>
      )}
    </div>
  );
}

export function NewsCard({ p, big = false }: { p: PublicState; big?: boolean }) {
  if (!p.news) return null;
  return (
    <Card testId="news">
      <div className="text-sm text-gold">
        {p.news.act}「{p.news.title}」
      </div>
      <p className={cx("mt-1 leading-relaxed", big ? "text-2xl font-bold" : "text-base")}>{p.news.text}</p>
      {p.news.details.length > 0 && (
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {p.news.details.map((d) => (
            <div key={d.label} className="rounded-lg bg-panel-2 p-2 text-sm leading-relaxed">
              <div className="font-bold text-info">{d.label}</div>
              {d.text}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

/** 直前のラウンドの注文の内訳（人数）。王国の商会100と参加者を分けて示す */
export function FlowCard({ p, big = false }: { p: PublicState; big?: boolean }) {
  const c = p.lastClearing;
  if (!c) return null;
  return (
    <Card testId="flow">
      <h3 className={cx("font-bold", big ? "text-xl" : "text-base")}>第{c.round}ラウンドの注文（人数）</h3>
      <div className="mt-2 grid gap-2">
        {p.scenario.guilds.map((g) => {
          const s = c.stats[g.id]!;
          const hold = c.npcCount - s.npcBuyers - s.npcSellers;
          return (
            <div key={g.id} className="grid grid-cols-[6.5rem_1fr] items-center gap-2 text-sm">
              <span className="truncate">{g.name}</span>
              <div>
                <div className="flex h-3 overflow-hidden rounded" aria-hidden>
                  <div className="bg-buy" style={{ width: `${s.npcBuyers}%` }} />
                  <div className="bg-sell" style={{ width: `${s.npcSellers}%` }} />
                  <div className="bg-panel-2" style={{ width: `${hold}%` }} />
                </div>
                <div className="mt-0.5 text-xs text-mute">
                  王国の商会：買い{s.npcBuyers}・売り{s.npcSellers}・様子見{hold}　参加者：買い{s.playerBuyers}・売り{s.playerSellers}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

export function RankingCard({ p, highlight, big = false }: { p: PublicState; highlight?: string; big?: boolean }) {
  if (!p.ranking) return null;
  return (
    <Card testId="ranking">
      <h3 className={cx("font-bold", big ? "text-xl" : "text-base")}>順位</h3>
      <ol className="mt-2 grid gap-1">
        {p.ranking.map((r) => (
          <li key={r.nickname} className={cx("flex items-center gap-3 rounded px-2 py-1", r.nickname === highlight && "bg-panel-2 font-bold", big && "text-xl")}>
            <span className="w-10 text-gold">{r.rank}位</span>
            <span className="truncate">{r.nickname}</span>
            <span className="ml-auto tabular-nums">{r.assets.toLocaleString()}G</span>
          </li>
        ))}
      </ol>
    </Card>
  );
}

/**
 * 価格のリプレイ（MEETING_MVP_SPEC §5.4）。横軸はラウンド、縦軸は価格。
 * ニュースの位置、自分の注文と調査券（参加者のみ）、NPCの注文のまとまりを重ねる。
 */
export function ReplayChart({ p, own }: { p: PublicState; own?: OwnState | null }) {
  const history = p.priceHistory;
  if (history.length < 2) return null;
  const W = 640;
  const H = 260;
  const pad = { l: 34, r: 12, t: 26, b: 28 };
  const max = Math.max(...history.flatMap((h) => Object.values(h))) + 5;
  const x = (i: number) => pad.l + (i * (W - pad.l - pad.r)) / (history.length - 1);
  const y = (v: number) => pad.t + (1 - v / max) * (H - pad.t - pad.b);
  const guild = (id: string) => p.scenario.guilds.find((g) => g.id === id)!;
  const fills = own?.allFills ?? [];
  return (
    <Card testId="replay">
      <h3 className="font-bold">価格のリプレイ</h3>
      <svg viewBox={`0 0 ${W} ${H}`} className="mt-2 w-full" role="img" aria-label="ラウンドごとの4ギルドの価格">
        {[0, 25, 50].filter((v) => v < max).map((v) => (
          <g key={v}>
            <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} stroke="#2a3a6e" />
            <text x={pad.l - 6} y={y(v) + 4} textAnchor="end" fontSize="11" fill="#a9b4d6">
              {v}G
            </text>
          </g>
        ))}
        {history.map((_, i) => (
          <g key={i}>
            {i > 0 && <line x1={x(i)} x2={x(i)} y1={pad.t} y2={H - pad.b} stroke="#2a3a6e" strokeDasharray="3 4" />}
            <text x={x(i)} y={H - 8} textAnchor="middle" fontSize="11" fill="#a9b4d6">
              {i === 0 ? "開始" : `R${i}`}
            </text>
            {i > 0 && (
              <text x={x(i)} y={14} textAnchor="middle" fontSize="10" fill="#e8c15a">
                {p.scenario.rounds[i - 1]?.title}
              </text>
            )}
          </g>
        ))}
        {p.scenario.guilds.map((g) => (
          <polyline key={g.id} fill="none" stroke={g.color} strokeWidth="2.5" points={history.map((h, i) => `${x(i)},${y(h[g.id]!)}`).join(" ")} />
        ))}
        {fills
          .filter((f) => f.filled > 0)
          .map((f, i) => (
            <text key={i} x={x(f.round)} y={y(f.price) + (f.side === "buy" ? 16 : -8)} textAnchor="middle" fontSize="12" fill={f.side === "buy" ? "#3fbf7f" : "#e5534b"}>
              {f.side === "buy" ? "▲" : "▼"}
            </text>
          ))}
        {own?.investigation && (
          <text x={x(own.investigation.round)} y={pad.t + 12} textAnchor="middle" fontSize="11" fill="#5aa7ff">
            調査
          </text>
        )}
      </svg>
      <div className="mt-1 flex flex-wrap gap-3 text-xs">
        {p.scenario.guilds.map((g) => (
          <span key={g.id} className="flex items-center gap-1">
            <span className="inline-block h-2 w-4 rounded" style={{ background: g.color }} />
            {g.name}
          </span>
        ))}
        {own && <span className="text-mute">▲ あなたの買い　▼ あなたの売り</span>}
      </div>
      {p.flowHistory && (
        <ul className="mt-2 grid gap-0.5 text-xs text-mute">
          {p.flowHistory.map((f) => {
            const [g, net] = Object.entries(f.npcNet).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))[0]!;
            return (
              <li key={f.round}>
                R{f.round}：王国の商会は{guild(g).name}を{net >= 0 ? `${net}口 買い越し` : `${-net}口 売り越し`}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
