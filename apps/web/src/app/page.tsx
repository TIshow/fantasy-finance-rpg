import { TimelineItemView } from "../components/TimelineItemView";
import { getView } from "./data";

export default async function Home() {
  const { timeline } = await getView();
  return (
    <>
      <h1 className="mb-3 text-2xl font-bold">タイムライン</h1>
      <ol className="space-y-2">
        {timeline.map((item, i) => (
          <TimelineItemView key={`${item.seq}-${i}`} item={item} />
        ))}
      </ol>
    </>
  );
}
