"use client";
import { useEffect, useState } from "react";
import { api, ApiError, ERROR_LABEL, useCountdown, useMatch } from "@/app/_lib/client";
import { Flow, News, PhaseBar, Ranking } from "@/app/_lib/views";

/** 運営画面。トークンはURLの # 以降から読み、ヘッダーで送る（サーバーのログに残らない）。 */
export function Host({ matchId }: { matchId: string }) {
  const [token, setToken] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => setToken(window.location.hash.slice(1) || null), []);
  const { snap, refresh } = useMatch(`/api/m/${matchId}/screen`);
  const seconds = useCountdown(snap);
  if (!snap) return <main><p className="muted">読み込み中…</p></main>;
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
  const joinUrl = typeof window === "undefined" ? "" : `${window.location.origin}/m/${p.joinCode}`;
  return (
    <main>
      <h1>運営</h1>
      {!token && <p className="error">運営用のリンク（#以降を含む）から開いてください。</p>}
      <section>
        <p>
          参加コード <span className="big">{p.joinCode}</span>　参加 {p.teamCount}/{p.capacity}
        </p>
        <p className="muted">{joinUrl}</p>
        <PhaseBar p={p} seconds={seconds} />
        <div className="row">
          <button disabled={p.phase !== "LOBBY"} onClick={() => act("start", "試合を開始しますか？")}>
            開始
          </button>
          <button disabled={!["NEWS", "ORDER_OPEN", "PUBLISHED"].includes(p.phase)} onClick={() => act("pause")}>
            一時停止
          </button>
          <button disabled={p.phase !== "PAUSED"} onClick={() => act("resume")}>
            再開
          </button>
          <button disabled={!["NEWS", "ORDER_OPEN"].includes(p.phase)} onClick={() => act("extend")}>
            15秒延長
          </button>
          <button disabled={p.phase !== "ORDER_OPEN"} onClick={() => act("close-now", "注文受付を締め切りますか？")}>
            早期締切
          </button>
          <button disabled={!["NEWS", "ORDER_OPEN", "PUBLISHED"].includes(p.phase)} onClick={() => act("next")}>
            次へ
          </button>
          <button disabled={["RESULT", "ABORTED"].includes(p.phase)} onClick={() => act("abort", "試合を中止しますか？元に戻せません。")}>
            中止
          </button>
        </div>
        {err && <p className="error">{ERROR_LABEL[err] ?? err}</p>}
      </section>
      <News p={p} />
      <Flow p={p} />
      <Ranking p={p} />
    </main>
  );
}
