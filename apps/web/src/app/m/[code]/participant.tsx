"use client";
import { useEffect, useState } from "react";
import { api, ApiError, ERROR_LABEL, REASON_LABEL, useCountdown, useMatch, type OwnState, type PublicState } from "@/app/_lib/client";
import { Change, Flow, History, News, PhaseBar, Ranking } from "@/app/_lib/views";

const QTYS = [1, 5, 10];

export function Participant({ code }: { code: string }) {
  const [matchId, setMatchId] = useState<string | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  useEffect(() => {
    api<{ matchId: string }>(`/api/code/${code}`)
      .then((r) => setMatchId(r.matchId))
      .catch((e) => setLookupError(e instanceof ApiError ? e.code : "network"));
  }, [code]);
  const { snap, error, refresh } = useMatch(matchId ? `/api/m/${matchId}/state` : null);
  const seconds = useCountdown(snap);

  if (lookupError) return <main><p className="error">{ERROR_LABEL[lookupError] ?? lookupError}</p></main>;
  if (!snap) return <main><p className="muted">読み込み中…</p></main>;
  if (!snap.own) return <Join code={code} p={snap.public} onJoined={refresh} />;
  return (
    <main>
      <Game p={snap.public} own={snap.own} seconds={seconds} refresh={refresh} />
      {error && <p className="error">{ERROR_LABEL[error] ?? error}</p>}
    </main>
  );
}

function Join({ code, p, onJoined }: { code: string; p: PublicState; onJoined: () => void }) {
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    try {
      await api("/api/join", { method: "POST", body: { code, nickname: name } });
      onJoined();
    } catch (e) {
      setErr(e instanceof ApiError ? e.code : "network");
    }
  };
  return (
    <main>
      <h1>GUILD MARKET</h1>
      <section>
        <p>{p.scenario.title}</p>
        <p className="muted">商会名だけで参加できます（本名は入れないでください）。参加中 {p.teamCount}/{p.capacity}</p>
        <div className="row">
          <input value={name} maxLength={12} placeholder="商会名" onChange={(e) => setName(e.target.value)} />
          <button disabled={!name.trim() || p.phase !== "LOBBY"} onClick={submit}>
            参加する
          </button>
        </div>
        {p.phase !== "LOBBY" && <p className="error">{ERROR_LABEL.match_started}</p>}
        {err && <p className="error">{ERROR_LABEL[err] ?? err}</p>}
      </section>
    </main>
  );
}

function Game({ p, own, seconds, refresh }: { p: PublicState; own: OwnState; seconds: number | null; refresh: () => void }) {
  const [qty, setQty] = useState(5);
  const [selected, setSelected] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const open = p.phase === "ORDER_OPEN";
  const before = p.lastClearing?.pricesBefore;
  const guild = (id: string) => p.scenario.guilds.find((g) => g.id === id)!;

  const run = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof ApiError ? e.code : "network");
    }
    refresh();
  };
  const slot = (g: string) => own.orders.find((o) => o.guildId === g);
  const order = (g: string, side: "buy" | "sell") =>
    run(() => api(`/api/m/${p.matchId}/r/${p.round}/orders/${g}`, { method: "PUT", body: { side, qty, baseRevision: slot(g)?.revision ?? 0 } }));
  const cancel = (g: string) =>
    run(() => api(`/api/m/${p.matchId}/r/${p.round}/orders/${g}`, { method: "DELETE", body: { baseRevision: slot(g)!.revision } }));
  const investigate = (source: string) => run(() => api(`/api/m/${p.matchId}/investigate`, { method: "POST", body: { source } }));

  return (
    <>
      <section className="sticky">
        <div className="row">
          <strong>{own.nickname}</strong>
          <span>現金 {(own.cash - own.reserved).toLocaleString()}G</span>
          {own.reserved > 0 && <span className="muted">（予約中 {own.reserved}G）</span>}
          <span>総資産 {own.assets.toLocaleString()}G</span>
          <span className="muted">調査券 {own.investigation ? "使用済み" : "1枚"}</span>
        </div>
        <PhaseBar p={p} seconds={seconds} />
      </section>
      {p.phase === "LOBBY" && <section>開始をお待ちください。</section>}
      <News p={p} />
      <section>
        <div className="grid">
          {p.scenario.guilds.map((g) => {
            const o = slot(g.id);
            return (
              <div key={g.id} className="panel">
                <div className="row">
                  <strong style={{ color: g.color }}>{g.seal}</strong>
                  <span>{g.name}</span>
                </div>
                <div className="big">
                  {p.prices[g.id]}G <Change now={p.prices[g.id]!} before={before?.[g.id]} />
                </div>
                <div className="muted">保有 {own.positions[g.id]?.qty ?? 0}口</div>
                {o?.status === "active" && (
                  <div className="row">
                    <span className={o.side === "buy" ? "up" : "down"}>
                      予約：{o.side === "buy" ? "買い" : "売り"}
                      {o.qty}口{o.side === "buy" ? `（最大${o.reserveCash}G。余りは約定後に戻ります）` : ""}
                    </span>
                    {open && <button onClick={() => cancel(g.id)}>取消</button>}
                  </div>
                )}
                {open && (
                  <div className="row">
                    <button className={selected === g.id ? "sel" : ""} onClick={() => setSelected(g.id)}>
                      選ぶ
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>
      {open && selected && (
        <section className="sticky">
          <div className="row">
            <strong>{guild(selected).name}</strong>
            {QTYS.map((n) => (
              <button key={n} className={qty === n ? "sel" : ""} onClick={() => setQty(n)}>
                {n}口
              </button>
            ))}
            <button className="buy" onClick={() => order(selected, "buy")}>
              買う（最大{qty * Math.min(99, Math.ceil(p.prices[selected]! * 1.5))}G）
            </button>
            <button className="sell" disabled={(own.positions[selected]?.qty ?? 0) < qty} onClick={() => order(selected, "sell")}>
              売る
            </button>
          </div>
          <p className="muted">締切のあとに決まる新しい価格で、全員が同じ値段で約定します。</p>
        </section>
      )}
      {open && p.news?.investigationWindow && !own.investigation && (
        <section>
          <h3>調査券を使う（ゲーム中1回）</h3>
          <div className="row">
            <button onClick={() => investigate("newspaper")}>王国新聞</button>
            <button onClick={() => investigate("official")}>ギルド公式資料</button>
            <button onClick={() => investigate("ai")}>賢者オラクルのAI分析</button>
          </div>
        </section>
      )}
      {own.investigation && (
        <section>
          <h3>調査結果（{own.investigation.name}）</h3>
          <p>{own.investigation.result}</p>
        </section>
      )}
      {err && <p className="error">{ERROR_LABEL[err] ?? err}</p>}
      {own.lastFills.length > 0 && (
        <section>
          <h3>第{own.lastFills[0]!.round}ラウンドのあなたの結果</h3>
          {own.lastFills.map((f) => (
            <p key={f.guildId}>
              {guild(f.guildId).name}：{f.side === "buy" ? "買い" : "売り"} {f.filled}/{f.requested}口 @{f.price}G —{" "}
              {REASON_LABEL[f.reason] ?? f.reason}
            </p>
          ))}
        </section>
      )}
      <Flow p={p} />
      {p.phase === "RESULT" && (
        <section>
          <h2>決算：{p.scenario.winner ? guild(p.scenario.winner).name : ""}が王国勲章を獲得</h2>
          <p className="big">最終資産 {own.assets.toLocaleString()}G</p>
          {own.forecasts.length > 0 && (
            <p>
              保有から見た本命：最初 {label(own.forecasts[0]!.forecast, guild)} → 最後 {label(own.forecasts.at(-1)!.forecast, guild)}
            </p>
          )}
        </section>
      )}
      <Ranking p={p} />
      {p.phase === "RESULT" && <History p={p} />}
    </>
  );
}

function label(f: OwnState["forecasts"][number]["forecast"], guild: (id: string) => { name: string }) {
  if (f.favorite.kind === "none") return "未投資";
  if (f.favorite.kind === "split") return `分散・同率（資金配分${f.allocationPct}％）`;
  return `${guild(f.favorite.guildId).name}（資金配分${f.allocationPct}％）`;
}
