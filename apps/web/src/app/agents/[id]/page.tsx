import { notFound } from "next/navigation";
import { AgentPageView } from "../../../components/AgentPageView";
import { buildAgentPage } from "../../../view/agent-page";
import { getAccounts, getView } from "../../data";

// AIはビルドの時点で決まる。知らないIDは 404
export const dynamicParams = false;

export async function generateStaticParams() {
  return (await getView()).agents.map((a) => ({ id: a.agentId }));
}

export default async function AgentPage({ params }: { params: Promise<{ id: string }> }) {
  const page = buildAgentPage(await getView(), await getAccounts(), decodeURIComponent((await params).id));
  if (!page) notFound();
  return <AgentPageView page={page} />;
}
