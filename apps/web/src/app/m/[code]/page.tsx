import { Participant } from "./participant";

export default async function Page({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  return <Participant code={code} />;
}
