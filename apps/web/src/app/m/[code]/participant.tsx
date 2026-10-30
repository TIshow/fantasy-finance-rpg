"use client";
import { useEffect, useState } from "react";
import { api, ApiError, ERROR_LABEL, REASON_LABEL, useCountdown, useMatch, type OwnState, type PublicState } from "@/app/_lib/client";
import { Card, Change, cx, FlowCard, GuildSeal, NewsCard, PhaseBar, RankingCard, ReplayChart } from "@/app/_lib/views";

const QTYS = [1, 5, 10];
const reserveUnit = (price: number) => Math.min(99, Math.ceil(price * 1.5));

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

  if (lookupError) return <Shell><p className="text-sell">{ERROR_LABEL[lookupError] ?? lookupError}</p></Shell>;
  if (!snap) return <Shell><p className="text-mute">読み込み中…</p></Shell>;
  if (!snap.own) return <Join code={code} p={snap.public} onJoined={refresh} />;
  return (
    <>
      <Game p={snap.public} own={snap.own} seconds={seconds} refresh={refresh} />
      {error && <p className="px-4 text-sm text-sell">{ERROR_LABEL[error] ?? error}（自動で再接続します）</p>}
    </>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <main className="mx-auto max-w-3xl p-4">{children}</main>;
}

function Join({ code, p, onJoined }: { code: string; p: PublicState; onJoined: () => void }) {
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api("/api/join", { method: "POST", body: { code, nickname: name } });
      onJoined();
    } catch (e) {
      setErr(e instanceof ApiError ? e.code : "network");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Shell>
      <h1 className="text-2xl font-bold text-gold">GUILD MARKET</h1>
      <p className="mt-1 text-mute">{p.scenario.title}</p>
      <Card className="mt-4">
        <p>あなたは王国の「予測商会」。4つのギルドの未来を読み、王国の商会100と同じ市場で売買します。</p>
        <form onSubmit={submit} className="mt-3 flex flex-wrap gap-2">
          <input
            data-testid="join-nickname"
            value={name}
            maxLength={12}
            placeholder="商会名（12文字まで）"
            aria-label="商会名"
            onChange={(e) => setName(e.target.value)}
            className="min-h-11 flex-1 rounded-lg border border-line bg-night px-3 text-base"
          />
          <button
            data-testid="join-submit"
            disabled={!name.trim() || p.phase !== "LOBBY" || busy}
            className="min-h-11 rounded-lg bg-gold px-5 font-bold text-night disabled:opacity-40"
          >
            参加する
          </button>
        </form>
        <p className="mt-2 text-sm text-mute">本名は入れないでください。参加中 {p.teamCount}／{p.capacity}</p>
        {p.phase !== "LOBBY" && <p className="mt-2 text-sell">{ERROR_LABEL.match_started}</p>}
        {err && <p className="mt-2 text-sell">{ERROR_LABEL[err] ?? err}</p>}
      </Card>
    </Shell>
  );
}

function Game({ p, own, seconds, refresh }: { p: PublicState; own: OwnState; seconds: number | null; refresh: () => void }) {
  const [qty, setQty] = useState(5);
  const [selected, setSelected] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const open = p.phase === "ORDER_OPEN";
  const before = p.lastClearing?.pricesBefore;
  const revealKey = p.lastClearing?.round ?? 0;
  const guild = (id: string) => p.scenario.guilds.find((g) => g.id === id)!;
  const slot = (g: string) => own.orders.find((o) => o.guildId === g);
  const held = (g: string) => own.positions[g]?.qty ?? 0;
  const totalMs = p.phase in p.durations ? p.durations[p.phase as keyof PublicState["durations"]] : undefined;

  useEffect(() => {
    if (!open) setSelected(null);
  }, [open]);

  const run = async (fn: () => Promise<unknown>) => {
    setErr(null);
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof ApiError ? e.code : "network");
    } finally {
      setBusy(false);
    }
    refresh();
  };
  const order = (g: string, side: "buy" | "sell") =>
    run(() => api(`/api/m/${p.matchId}/r/${p.round}/orders/${g}`, { method: "PUT", body: { side, qty, baseRevision: slot(g)?.revision ?? 0 } }));
  const cancel = (g: string) => run(() => api(`/api/m/${p.matchId}/r/${p.round}/orders/${g}`, { method: "DELETE", body: { baseRevision: slot(g)!.revision } }));
  const investigate = (source: string) => run(() => api(`/api/m/${p.matchId}/investigate`, { method: "POST", body: { source } }));

  return (
    <main className={cx("mx-auto max-w-3xl px-3 pb-6 sm:px-4", open && selected && "pb-56")}>
      <header className="sticky top-0 z-10 -mx-3 border-b border-line bg-night/95 px-3 py-2 backdrop-blur sm:-mx-4 sm:px-4">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
          <strong data-testid="nickname" className="text-base text-gold">
            {own.nickname}
          </strong>
          <span>
            現金 <b data-testid="cash" className="tabular-nums">{(own.cash - own.reserved).toLocaleString()}G</b>
          </span>
          {own.reserved > 0 && <span className="text-mute">予約中 {own.reserved.toLocaleString()}G</span>}
          <span>
            総資産 <b className="tabular-nums">{own.assets.toLocaleString()}G</b>
          </span>
          <span className="text-mute">調査券 {own.investigation ? "使用済み" : "1枚"}</span>
        </div>
        <div className="mt-2">
          <PhaseBar p={p} seconds={seconds} totalMs={totalMs} />
        </div>
      </header>

      <div className="mt-3 grid gap-3">
        {p.phase === "LOBBY" && <Card testId="waiting">開始をお待ちください。運営が開始すると、最初のニュースが届きます。</Card>}
        {p.phase === "PAUSED" && <Card>運営が一時停止しています。</Card>}
        <NewsCard p={p} />

        <div className="grid gap-2 sm:grid-cols-2">
          {p.scenario.guilds.map((g) => {
            const o = slot(g.id);
            const active = o?.status === "active";
            return (
              <button
                key={g.id}
                data-testid={`guild-${g.id}`}
                disabled={!open}
                onClick={() => setSelected(g.id)}
                aria-pressed={selected === g.id}
                className={cx(
                  "rounded-xl border bg-panel p-3 text-left transition disabled:cursor-default",
                  selected === g.id ? "border-gold ring-2 ring-gold" : "border-line",
                  open && "hover:bg-panel-2",
                )}
              >
                <div className="flex items-center gap-2">
                  <GuildSeal guild={g} />
                  <div className="min-w-0">
                    <div className="truncate font-bold">{g.name}</div>
                    <div className="truncate text-xs text-mute">{g.project}</div>
                  </div>
                </div>
                <div key={revealKey} className={cx("mt-2 flex items-baseline gap-2 px-1", revealKey > 0 && "reveal")}>
                  <span data-testid={`price-${g.id}`} className="text-3xl font-bold tabular-nums">
                    {p.prices[g.id]}G
                  </span>
                  <Change now={p.prices[g.id]!} before={before?.[g.id]} className="text-sm" />
                </div>
                <div className="mt-1 text-sm text-mute">保有 {held(g.id)}口</div>
                {active && (
                  <div data-testid={`order-status-${g.id}`} className={cx("mt-1 text-sm", o.side === "buy" ? "text-buy" : "text-sell")}>
                    予約：{o.side === "buy" ? "買い" : "売り"} {o.qty}口{o.side === "buy" ? `（最大${o.reserveCash}G）` : ""}
                  </div>
                )}
              </button>
            );
          })}
        </div>

        {open && p.news?.investigationWindow && !own.investigation && (
          <Card testId="investigation">
            <h3 className="font-bold">調査券を使う（ゲーム中1回）</h3>
            <p className="text-sm text-mute">使える機会は、このラウンドと次のラウンドのどちらかです。温存してもかまいません。</p>
            <div className="mt-2 grid gap-2 sm:grid-cols-3">
              {[
                ["newspaper", "王国新聞"],
                ["official", "ギルド公式資料"],
                ["ai", "賢者オラクルのAI分析"],
              ].map(([id, name]) => (
                <button key={id} disabled={busy} onClick={() => investigate(id!)} className="min-h-11 rounded-lg border border-line bg-panel-2 px-3 hover:border-info">
                  {name}
                </button>
              ))}
            </div>
          </Card>
        )}
        {own.investigation && (
          <Card testId="investigation-result">
            <h3 className="font-bold text-info">調査結果：{own.investigation.name}（第{own.investigation.round}ラウンド）</h3>
            <p className="mt-1 leading-relaxed">{own.investigation.result}</p>
          </Card>
        )}

        {own.lastFills.length > 0 && (
          <Card testId="fills">
            <h3 className="font-bold">第{own.lastFills[0]!.round}ラウンドのあなたの結果</h3>
            <ul className="mt-1 grid gap-1 text-sm">
              {own.lastFills.map((f) => (
                <li key={f.guildId} data-testid={`fill-${f.guildId}`}>
                  {guild(f.guildId).name}：{f.side === "buy" ? "買い" : "売り"} {f.filled}／{f.requested}口 @{f.price}G
                  <span className={cx("ml-2", f.reason === "filled" ? "text-buy" : "text-gold")}>{REASON_LABEL[f.reason] ?? f.reason}</span>
                </li>
              ))}
            </ul>
          </Card>
        )}
        <FlowCard p={p} />

        {p.phase === "RESULT" && (
          <Card testId="result">
            <h2 className="text-xl font-bold text-gold">{p.scenario.winner ? guild(p.scenario.winner).name : ""}が王国勲章を獲得</h2>
            <p className="mt-1 text-sm text-mute">成功証は1口100Gで精算しました。</p>
            <p className="mt-2 text-3xl font-bold tabular-nums" data-testid="result-assets">
              {own.assets.toLocaleString()}G
            </p>
            {own.forecasts.length > 0 && (
              <p className="mt-2">
                保有から見た本命：最初 {label(own.forecasts[0]!.forecast, guild)} → 最後 {label(own.forecasts.at(-1)!.forecast, guild)}
              </p>
            )}
            <p className="mt-2 text-sm text-mute">何を根拠に判断を変えましたか。どの情報で、何を変えたかを振り返ってみましょう。</p>
          </Card>
        )}
        <RankingCard p={p} highlight={own.nickname} />
        {p.phase === "RESULT" && <ReplayChart p={p} own={own} />}
        {err && <p className="text-sell">{ERROR_LABEL[err] ?? err}</p>}
      </div>

      {open && selected && (
        <div data-testid="order-sheet" className="fixed inset-x-0 bottom-0 z-20 border-t border-gold bg-panel/98 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-2xl">
          <div className="mx-auto max-w-3xl">
            <div className="flex items-center gap-2">
              <GuildSeal guild={guild(selected)} size={28} />
              <strong>{guild(selected).name}</strong>
              <span className="tabular-nums">{p.prices[selected]}G</span>
              <button onClick={() => setSelected(null)} className="ml-auto min-h-11 px-3 text-mute" aria-label="閉じる">
                閉じる
              </button>
            </div>
            <div className="mt-2 flex gap-2">
              {QTYS.map((n) => (
                <button
                  key={n}
                  data-testid={`qty-${n}`}
                  onClick={() => setQty(n)}
                  aria-pressed={qty === n}
                  className={cx("min-h-11 flex-1 rounded-lg border", qty === n ? "border-gold bg-panel-2 font-bold" : "border-line")}
                >
                  {n}口
                </button>
              ))}
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <button data-testid="order-buy" disabled={busy} onClick={() => order(selected, "buy")} className="min-h-12 rounded-lg bg-buy/80 font-bold disabled:opacity-40">
                買う（最大{qty * reserveUnit(p.prices[selected]!)}G）
              </button>
              <button
                data-testid="order-sell"
                disabled={busy || held(selected) < qty}
                onClick={() => order(selected, "sell")}
                className="min-h-12 rounded-lg bg-sell/80 font-bold disabled:opacity-40"
              >
                売る（保有{held(selected)}口）
              </button>
            </div>
            {slot(selected)?.status === "active" && (
              <button onClick={() => cancel(selected)} className="mt-2 min-h-11 w-full rounded-lg border border-line text-sm">
                このギルドの予約を取り消す
              </button>
            )}
            <p className="mt-1 text-xs text-mute">締切のあとに決まる新しい価格で、全員が同じ値段で約定します。余った予約額は約定後に戻ります。</p>
          </div>
        </div>
      )}
    </main>
  );
}

function label(f: OwnState["forecasts"][number]["forecast"], guild: (id: string) => { name: string }) {
  if (f.favorite.kind === "none") return "未投資";
  if (f.favorite.kind === "split") return `分散・同率（資金配分${f.allocationPct}％）`;
  return `${guild(f.favorite.guildId).name}（資金配分${f.allocationPct}％）`;
}
