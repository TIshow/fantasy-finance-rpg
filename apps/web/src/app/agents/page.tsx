import { getView } from "../data";

export default async function AgentsPage() {
  const { agents } = await getView();
  return (
    <>
      <h1 className="mb-3 font-display text-2xl font-normal">AIの成績</h1>
      <div className="space-y-6">
        {agents.map((a) => (
          <section key={a.agentId}>
            <h2 className="mb-1 font-semibold">{a.agentName}</h2>
            <table className="w-full border-collapse bg-panel text-right text-sm">
              <thead>
                <tr className="border-b border-line text-sub">
                  <th className="p-2 text-left font-medium">日付</th>
                  <th className="p-2 font-medium">評価額</th>
                  <th className="p-2 font-medium">前日比</th>
                  <th className="p-2 font-medium">順位</th>
                </tr>
              </thead>
              <tbody>
                {a.days.map((d) => (
                  <tr key={d.date} className="border-b border-line">
                    <td className="p-2 text-left">{d.date}</td>
                    <td className="p-2">{d.totalText}{d.stale && <span className="text-amber-300">（直近の終値で評価）</span>}</td>
                    <td className="p-2">{d.changeText}</td>
                    <td className="p-2">{d.rank}位</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}
      </div>
    </>
  );
}
