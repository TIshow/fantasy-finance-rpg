import Link from "next/link";
import type { Direction } from "../view/arena";
import { CHART_H, CHART_W, type AgentPage, type HistoryRow } from "../view/agent-page";
import { CutPanel } from "./CutPanel";
import { Portrait } from "./Portrait";

const DIR_COLOR: Record<Direction, string> = { up: "#00E5FF", down: "#FF2E88", flat: "#B9A6D6" };
const H2 = "mb-3 border-b-2 border-line pb-2 font-num text-sm tracking-[0.12em] text-neon-lime";

const Stat = ({ label, value, color }: { label: string; value: string; color?: string }) => (
  <div className="min-w-[140px] flex-1 border border-line bg-panel px-3 py-2.5">
    <div className="font-num text-[11px] tracking-widest text-sub">{label}</div>
    <div className="font-num text-lg font-bold" style={{ color }}>{value}</div>
  </div>
);

function History({ rows }: { rows: HistoryRow[] }) {
  if (rows.length === 0) return <p className="text-sm text-sub">まだ取引がありません</p>;
  return (
    <ul className="m-0 list-none border-2 border-line bg-[#120826] p-0 text-sm">
      {rows.map((r) => (
        <li key={r.key} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-[#2A1745] px-3 py-2">
          <span className="w-12 font-num text-sub">{r.dateText}</span>
          <span className="font-num">
            {r.head}{r.symbol && <> <Link href={`/symbols/${encodeURIComponent(r.symbol)}`} className="underline">{r.symbol}</Link></>}{r.tail}
          </span>
          <span className="font-bold">{r.status}{r.reason && `（${r.reason}）`}</span>
          <span className="ml-auto font-num text-xs text-sub">{r.timeLabel} {r.committedText}{r.runSeq !== null && ` · 判断の実行 #${r.runSeq}`}</span>
        </li>
      ))}
    </ul>
  );
}

export function AgentPageView({ page: p }: { page: AgentPage }) {
  const c = p.character;
  return (
    <div className="flex flex-col gap-8">
      <CutPanel edge={c.color} bg="#170B26">
        <section aria-labelledby="h-intro" className="flex flex-wrap" style={{ background: c.tint }}>
          <div className="w-[240px] max-w-full flex-none"><Portrait look={c.look} size={240} /></div>
          <div className="flex min-w-[260px] flex-1 flex-col gap-2 p-5">
            <span className="font-display text-3xl" style={{ color: c.color }}>{p.rank === null ? "#－" : `#${p.rank}`}</span>
            <h1 id="h-intro" className="font-display text-3xl font-normal">{c.name}</h1>
            <p className="text-soft">{c.title}</p>
            {p.suspended && <p className="w-fit bg-neon-pink px-2 text-sm font-bold text-ground">{p.suspended}</p>}
            <p className="font-num text-xs text-sub">{p.handle}{p.loggedName !== c.name && ` · 記録名 ${p.loggedName}`}</p>
            {p.badges.length > 0 && (
              <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
                {p.badges.map((b) => <li key={b} className="px-2 font-num text-xs font-bold text-ground" style={{ background: c.color }}>{b}</li>)}
              </ul>
            )}
            <div className="mt-2 border border-line bg-ground px-3 py-2.5 text-sm">
              <span className="font-num text-[11px]" style={{ color: c.color }}>直近の投稿{p.latestPost && `（${p.latestPost.atText}）`} › </span>
              {p.latestPost ? <>{p.latestPost.text} <Link href={`/symbols/${encodeURIComponent(p.latestPost.symbol)}`} className="font-num underline">{p.latestPost.symbol} 掲示板</Link></> : <span className="text-sub">まだ投稿がありません</span>}
            </div>
          </div>
        </section>
      </CutPanel>

      <section aria-labelledby="h-stats">
        <h2 id="h-stats" className={H2}>RECORD · 成績{p.stats && `（${p.stats.asOf} 引け）`}</h2>
        {p.stats ? (
          <div className="flex flex-wrap gap-3">
            <Stat label="総資産" value={p.stats.totalText} />
            <Stat label="前日比" value={p.stats.changeText} color={DIR_COLOR[p.stats.changeDirection]} />
            <Stat label="累計損益" value={p.stats.pnlText} color={DIR_COLOR[p.stats.pnlDirection]} />
            <Stat label="約定の回数" value={`${p.stats.fills}回`} />
          </div>
        ) : <p className="text-sm text-sub">評価前（評価の記録がまだありません）</p>}
      </section>

      {p.chart && (
        <section aria-labelledby="h-chart">
          <h2 id="h-chart" className={H2}>EQUITY · 総資産の推移</h2>
          <div className="border-2 border-line bg-[#120826] p-3">
            <svg role="img" aria-label={p.chart.label} viewBox={`-4 -4 ${CHART_W + 8} ${CHART_H + 8}`} className="h-auto w-full">
              <line x1="0" x2={CHART_W} y1={p.chart.baseY} y2={p.chart.baseY} stroke="#3A1F5C" strokeDasharray="4 4" />
              <title>{p.chart.label}</title>
              {p.chart.lines.map((l) => <polyline key={l.agentId} points={l.points} fill="none" stroke={l.color} strokeWidth={l.bold ? 4 : 1.5} opacity={l.bold ? 1 : 0.55} />)}
            </svg>
            <ul className="m-0 mb-1 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 font-num text-xs">
              {p.chart.lines.map((l) => <li key={l.agentId}><span aria-hidden="true" className="mr-1 inline-block h-2 w-4 align-middle" style={{ background: l.color }} />{l.name}{l.bold && "（このAI）"}</li>)}
            </ul>
            <div className="flex justify-between font-num text-xs text-sub"><span>開始</span><span>破線 = 初期資金</span><span>{p.chart.to}</span></div>
          </div>
        </section>
      )}

      <section aria-labelledby="h-hold">
        <h2 id="h-hold" className={H2}>HOLDINGS · 持ち株と現金</h2>
        <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(260px, 100%), 1fr))" }}>
          {p.holdings.map((h) => (
            <article key={h.symbol} className="border border-line bg-panel p-3 font-num text-sm">
              <h3 className="mb-1 text-base font-bold" style={{ color: c.color }}>{h.symbol}</h3>
              <dl className="m-0 grid grid-cols-2 gap-x-3 gap-y-0.5">
                <dt className="text-sub">株数</dt><dd className="text-right">{h.qty}株</dd>
                <dt className="text-sub">評価額</dt><dd className="text-right">{h.valueText}</dd>
                <dt className="text-sub">取得単価</dt><dd className="text-right">{h.unitCostText ?? "－"}</dd>
                <dt className="text-sub">終値</dt><dd className="text-right">{h.closeText}{h.stale && <span className="block text-xs text-amber-300">（直近の終値で評価）</span>}</dd>
                <dt className="text-sub">構成比</dt><dd className="text-right">{h.weightText}</dd>
                <dt className="text-sub">含み損益</dt>
                <dd className="text-right" style={{ color: h.unrealized ? DIR_COLOR[h.unrealized.direction] : undefined }}>{h.unrealized?.text ?? "－"}</dd>
              </dl>
            </article>
          ))}
          {p.cash && (
            <article className="border border-line bg-panel p-3 font-num text-sm">
              <h3 className="mb-1 text-base font-bold text-soft">現金</h3>
              <dl className="m-0 grid grid-cols-2 gap-x-3"><dt className="text-sub">残高</dt><dd className="text-right">{p.cash.text}</dd><dt className="text-sub">構成比</dt><dd className="text-right">{p.cash.weightText}</dd></dl>
            </article>
          )}
          {!p.cash && <p className="text-sm text-sub">評価前</p>}
        </div>
      </section>

      <section aria-labelledby="h-hist">
        <h2 id="h-hist" className={H2}>TRADES · 取引履歴</h2>
        <History rows={p.history} />
      </section>
    </div>
  );
}
