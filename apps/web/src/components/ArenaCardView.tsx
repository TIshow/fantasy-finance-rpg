import Link from "next/link";
import { MARK, SPARK_H, SPARK_W, type ArenaCard, type FeedItem } from "../view/arena";
import { ModelChip } from "./ModelChip";
import { CutPanel } from "./CutPanel";
import { Portrait } from "./Portrait";

const DIR_COLOR = { up: "#00E5FF", down: "#FF2E88", flat: "#B9A6D6" } as const;

export function AgentCardView({ card }: { card: ArenaCard }) {
  const { character: c, pnl, spark } = card;
  return (
    <Link href={`/agents/${encodeURIComponent(card.agentId)}`} className="block text-ink no-underline hover:no-underline">
      <CutPanel edge={c.color} bg="#170B26">
        <article className="flex h-full flex-col">
          <div className="flex" style={{ background: c.tint }}>
            <div className="w-[150px] flex-none">
              <Portrait look={c.look} size={150} />
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-1.5 px-4 pb-3 pt-3.5">
              <span className="font-display text-[28px] leading-none" style={{ color: c.color }}>
                {card.rank === null ? "#－" : `#${card.rank}`}
              </span>
              <h2 className="font-display text-xl font-normal leading-tight">{c.name}</h2>
              <span className="text-xs text-soft">{c.title}</span>
              {card.model && <ModelChip model={card.model} color={c.color} />}
              <span className="font-num text-[11px] text-sub">{card.handle}{card.loggedName !== c.name && ` · 記録名 ${card.loggedName}`}</span>
            </div>
          </div>
          <div className="flex flex-col gap-3 px-4 pb-4 pt-3.5">
            <div className="flex items-end justify-between gap-2">
              <div className="flex flex-col">
                <span className="font-num text-[11px] tracking-widest text-sub">総資産{card.asOf && ` · ${card.asOf} 引け`}</span>
                <span className="font-num text-[26px] font-bold leading-[1.1]">{card.totalText ?? "評価前"}</span>
                {pnl && (
                  <span className="font-num text-[13px]" style={{ color: DIR_COLOR[pnl.direction] }}>
                    {MARK[pnl.direction]} {pnl.percentText}　({pnl.text})
                  </span>
                )}
              </div>
              {spark && (
              <svg role="img" aria-label={spark.label} viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} width={SPARK_W} height={SPARK_H} className="flex-none">
                <line x1="0" x2={SPARK_W} y1={spark.baseY} y2={spark.baseY} stroke="#3A1F5C" strokeWidth="1" strokeDasharray="3 3" />
                <polyline points={spark.points} fill="none" stroke={c.color} strokeWidth="2.5" />
              </svg>
              )}
            </div>
            <div className="flex flex-col gap-1.5 border-t border-line pt-2.5">
              <span className="font-num text-[11px] tracking-widest text-sub">TOP HOLDINGS</span>
              {card.top.length === 0 && <span className="font-num text-[13px] text-soft">保有なし</span>}
              {card.top.map((h) => (
                <div key={h.symbol} className="flex items-center gap-2.5 font-num text-[13px]">
                  <span className="w-[46px] font-bold">{h.symbol}</span>
                  <div aria-hidden="true" className="h-1.5 flex-1 bg-[#2A1745]">
                    <div className="h-1.5" style={{ width: `${h.weightPct}%`, background: c.color }} />
                  </div>
                  <span className="w-[52px] text-right text-soft">{h.weightText}</span>
                </div>
              ))}
            </div>
            <div className="border border-line bg-ground px-3 py-2.5 text-[13px]" style={{ clipPath: "polygon(0 0, 100% 0, 100% 100%, 14px 100%, 0 calc(100% - 14px))" }}>
              <span className="font-num text-[11px]" style={{ color: c.color }}>今日のひとこと{card.quoteAt && `（${card.quoteAt}）`} › </span>
              {card.quote ?? <span className="text-sub">まだ投稿がありません</span>}
            </div>
            <span className="font-num text-xs text-soft">直近 {card.lastTrade ?? "売買なし"}</span>
          </div>
        </article>
      </CutPanel>
    </Link>
  );
}

export function LockedCard() {
  return (
    <CutPanel edge="#2A1745" bg="#120A1C">
      <article className="flex h-full flex-col items-center justify-center gap-2.5 p-5 text-center">
        <Portrait look="locked" size={120} />
        <h2 className="font-display text-lg font-normal text-soft">次のAI、参戦準備中</h2>
      </article>
    </CutPanel>
  );
}

export function LiveFeedView({ feed }: { feed: FeedItem[] }) {
  return (
    <section aria-labelledby="h-feed" className="border-2 border-line bg-[#120826]">
      <h2 id="h-feed" className="border-b-2 border-line px-4 py-2.5 font-num text-sm font-normal tracking-[0.12em] text-neon-lime">
        LIVE FEED · いまの動き
      </h2>
      <ul className="m-0 list-none p-0 text-sm">
        {feed.map((f) => (
          <li key={f.key} className="flex flex-wrap items-baseline gap-x-3.5 gap-y-1 border-b border-[#2A1745] px-4 py-2.5">
            <span className="w-[88px] font-num text-xs text-sub">{f.timeText}</span>
            <span className="px-2 font-num text-[11px] font-bold text-ground" style={{ background: f.color }}>
              {f.label}
            </span>
            <span className="min-w-[220px] flex-1">
              {f.text}
              {f.symbol && (
                <>
                  {" — "}
                  <Link href={`/symbols/${encodeURIComponent(f.symbol)}`} className="font-num underline">
                    {f.symbol} 掲示板
                  </Link>
                </>
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
