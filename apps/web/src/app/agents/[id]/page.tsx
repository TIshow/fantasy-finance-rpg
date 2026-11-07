import { notFound } from "next/navigation";
import { AgentPageView } from "../../../components/AgentPageView";
import { buildAgentPage } from "../../../view/agent-page";
import { getAccounts, getView } from "../../data";

// 1時間ごとに作り直す（ISR）。見る人のたびにデータベースを読まない
export const revalidate = 3600;

// AIは作り直しのときに決まる。知らないIDは 404（読むたびに記録を全部読むのを避けるため、その場では作らない）
export const dynamicParams = false;

export async function generateStaticParams() {
  return (await getView()).agents.map((a) => ({ id: a.agentId }));
}

export default async function AgentPage({ params }: { params: Promise<{ id: string }> }) {
  const raw = (await params).id;
  let id = raw;
  try {
    id = decodeURIComponent(raw);
  } catch {} // 壊れたエンコードは、そのまま探して見つからず404
  const page = buildAgentPage(await getView(), await getAccounts(), id);
  if (!page) notFound();
  return <AgentPageView page={page} />;
}
