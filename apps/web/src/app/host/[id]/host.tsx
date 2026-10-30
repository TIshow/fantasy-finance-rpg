"use client";
import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { api, ApiError, ERROR_LABEL, useCountdown, useMatch, type PublicState } from "@/app/_lib/client";
import { Card, cx, FlowCard, NewsCard, PhaseBar, RankingCard } from "@/app/_lib/views";

interface HostStatus {
  teams: { nickname: string; secondsSinceSeen: number | null; ordersThisRound: number }[];
}

/** 運営画面。トークンはURLの # 以降から読み、ヘッダーで送る（サーバーのログに残らない）。 */
export function Host({ matchId }: { matchId: string }) {
  const [token, setToken] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [status, setStatus] = useState<HostStatus | null>(null);
  // 接続状況の取得のエラーは、運営操作のエラーと分けて持つ。次に成功したら消す
  const [statusErr, setStatusErr] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const { snap, refresh } = useMatch(`/api/m/${matchId}/screen`);
  const seconds = useCountdown(snap);
  const joinCode = snap?.public.joinCode;

  useEffect(() => setToken(window.location.hash.slice(1) || null), []);
  useEffect(() => {
    if (!joinCode) return;
    QRCode.toString(`${window.location.origin}/m/${joinCode}`, { type: "svg", margin: 1, color: { dark: "#0b1330", light: "#ffffff" } })
      .then(setQr)
      .catch(() => setQr(null));
  }, [joinCode]);
  useEffect(() => {
    if (!token) return;
    let stopped = false;
    const load = async () => {
      try {
        const s = await api<HostStatus>(`/api/m/${matchId}/teams`, { hostToken: token });
        if (!stopped) {
          setStatus(s);
          setStatusErr(null);
        }
      } catch (e) {
        if (!stopped) setStatusErr(e instanceof ApiError ? e.code : "network");
      }
    };
    load();
    const id = setInterval(load, 3000);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [matchId, token]);

  if (!snap) return <main className="p-4 text-mute">読み込み中…</main>;
  const p = snap.public;
  const act = async (action: string, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return;
    setErr(null);
    try {
      await api(`/api/m/${matchId}/host/${action}`, { method: "POST", body: {}, hostToken: token ?? "" });
    } catch (e) {
      setErr(e instanceof ApiError ? e.code : "network");
    }
    refresh();
  };
  const running = ["NEWS", "ORDER_OPEN", "PUBLISHED"].includes(p.phase);
  const totalMs = p.phase in p.durations ? p.durations[p.phase as keyof PublicState["durations"]] : undefined;

  return (
    <main className="mx-auto grid max-w-5xl gap-3 p-4 lg:grid-cols-[1fr_20rem]">
      <div className="grid content-start gap-3">
        <h1 className="text-2xl font-bold text-gold">運営</h1>
        {!token && <p className="text-sell">運営用のリンク（#以降を含む）から開いてください。</p>}
        <Card>
          <PhaseBar p={p} seconds={seconds} totalMs={totalMs} />
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <HostButton testId="host-start" disabled={p.phase !== "LOBBY"} onClick={() => act("start", `${p.teamCount}商会で開始しますか？開始後は参加できません。`)}>
              開始
            </HostButton>
            <HostButton disabled={!running} onClick={() => act("pause")}>一時停止</HostButton>
            <HostButton disabled={p.phase !== "PAUSED"} onClick={() => act("resume")}>再開</HostButton>
            <HostButton disabled={!["NEWS", "ORDER_OPEN"].includes(p.phase)} onClick={() => act("extend")}>15秒延長</HostButton>
            <HostButton disabled={p.phase !== "ORDER_OPEN"} onClick={() => act("close-now", "注文受付を今すぐ締め切りますか？")}>早期締切</HostButton>
            <HostButton disabled={!running} onClick={() => act("next")}>次へ</HostButton>
            <HostButton danger disabled={["RESULT", "ABORTED"].includes(p.phase)} onClick={() => act("abort", "試合を中止しますか？元に戻せません。")}>
              中止
            </HostButton>
          </div>
          {err && <p className="mt-2 text-sell">{ERROR_LABEL[err] ?? err}</p>}
        </Card>
        <NewsCard p={p} />
        <FlowCard p={p} />
        <RankingCard p={p} />
      </div>
      <aside className="grid content-start gap-3">
        <Card>
          <div className="text-sm text-mute">参加コード</div>
          <div data-testid="host-join-code" className="text-4xl font-bold tracking-widest tabular-nums">
            {p.joinCode}
          </div>
          {qr && p.phase === "LOBBY" && <div className="mt-2 overflow-hidden rounded-lg bg-white p-2" dangerouslySetInnerHTML={{ __html: qr }} />}
        </Card>
        <Card testId="host-teams">
          <h3 className="font-bold">
            参加 {p.teamCount}／{p.capacity}
          </h3>
          <ul className="mt-2 grid gap-1 text-sm">
            {(status?.teams ?? []).map((t) => (
              <li key={t.nickname} className="flex items-center gap-2" data-testid="team-row">
                <span
                  aria-label={t.secondsSinceSeen === null ? "未接続" : `${t.secondsSinceSeen}秒前`}
                  className={cx(
                    "inline-block h-2.5 w-2.5 rounded-full",
                    t.secondsSinceSeen === null ? "bg-mute" : t.secondsSinceSeen <= 10 ? "bg-buy" : t.secondsSinceSeen <= 30 ? "bg-gold" : "bg-sell",
                  )}
                />
                <span className="truncate">{t.nickname}</span>
                <span className="ml-auto text-xs text-mute">
                  {t.secondsSinceSeen === null ? "未接続" : `${t.secondsSinceSeen}秒前`}
                  {p.phase === "ORDER_OPEN" && ` ・予約${t.ordersThisRound}`}
                </span>
              </li>
            ))}
          </ul>
          {statusErr && <p className="mt-2 text-sm text-sell">接続状況を取得できませんでした（{ERROR_LABEL[statusErr] ?? statusErr}）。自動で取り直します。</p>}
          <p className="mt-2 text-xs text-mute">緑：10秒以内、黄：30秒以内、赤：それ以上。表示が古い端末は、ページを再読み込みしてもらいます。</p>
        </Card>
      </aside>
    </main>
  );
}

function HostButton({ children, onClick, disabled, danger, testId }: { children: React.ReactNode; onClick: () => void; disabled?: boolean; danger?: boolean; testId?: string }) {
  return (
    <button
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      className={cx("min-h-11 rounded-lg border px-3 font-bold disabled:opacity-30", danger ? "border-sell text-sell" : "border-line bg-panel-2 hover:border-gold")}
    >
      {children}
    </button>
  );
}
