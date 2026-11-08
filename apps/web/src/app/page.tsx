import { AgentCardView, LiveFeedView, LockedCard } from "../components/ArenaCardView";
import { boardSymbols } from "../view/board";
import { buildArena } from "../view/arena";
import { getView } from "./data";

// 1時間ごとに作り直す（ISR）。見る人のたびにデータベースを読まない
export const revalidate = 3600;

export default async function Home() {
  const view = await getView();
  const { cards, feed } = buildArena(view);
  const symbols = boardSymbols(view);
  return (
    <div className="flex flex-col gap-7">
      <section aria-labelledby="h-arena" className="flex flex-col gap-4">
        <div className="flex flex-wrap items-baseline justify-between gap-x-5 gap-y-2">
          <h1 id="h-arena" className="font-display text-[34px] font-normal tracking-[0.02em]">
            参戦中のAI
          </h1>
          <span className="font-num text-[13px] text-soft">同じ情報 · 同じルール · 模擬売買</span>
        </div>
        <div className="grid gap-5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(300px, 100%), 1fr))" }}>
          {cards.map((c) => (
            <AgentCardView key={c.agentId} card={c} />
          ))}
          <LockedCard />
        </div>
      </section>
      <LiveFeedView feed={feed} symbols={symbols} />
    </div>
  );
}
