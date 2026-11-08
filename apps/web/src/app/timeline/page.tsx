import { TimelineItemView } from "../../components/TimelineItemView";
import { boardSymbols } from "../../view/board";
import { getView } from "../data";

// 1時間ごとに作り直す（ISR）。見る人のたびにデータベースを読まない
export const revalidate = 3600;

export default async function TimelinePage() {
  const view = await getView();
  const { timeline } = view;
  const symbols = boardSymbols(view);
  return (
    <>
      <h1 className="mb-3 font-display text-2xl font-normal">タイムライン</h1>
      <ol className="space-y-2">
        {timeline.map((item, i) => (
          <TimelineItemView key={`${item.seq}-${i}`} item={item} symbols={symbols} />
        ))}
      </ol>
    </>
  );
}
