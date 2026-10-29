"use client";
// 画面側の共通処理：APIの呼び出し、状態の定期取得、締切処理の送信、公開時刻での一斉表示（ARCHITECTURE §6）。
import { useCallback, useEffect, useRef, useState } from "react";
import type { OwnState, PublicState } from "@/server/state";

export type { OwnState, PublicState };

export class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown; hostToken?: string } = {}): Promise<T> {
  const headers: Record<string, string> = { "x-gm-client": "1" };
  if (init.body !== undefined || init.method) headers["content-type"] = "application/json";
  if (init.hostToken) headers["x-host-token"] = init.hostToken;
  const res = await fetch(path, {
    method: init.method ?? "GET",
    headers,
    body: init.method && init.method !== "GET" ? JSON.stringify(init.body ?? {}) : undefined,
    cache: "no-store",
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new ApiError(data.error ?? "network", res.status);
  return data;
}

interface Snapshot {
  public: PublicState;
  own: OwnState | null;
  /** サーバーの時計 − 端末の時計 */
  offset: number;
}

/** 締切を過ぎているか（サーバーの時計で判定。猶予を含む） */
export function isOverdue(s: Snapshot, nowMs = Date.now()): boolean {
  const p = s.public;
  if (p.phaseEndsAt === null || p.mode === "manual") return false;
  if (p.phase !== "NEWS" && p.phase !== "ORDER_OPEN" && p.phase !== "PUBLISHED") return false;
  const grace = p.phase === "ORDER_OPEN" ? p.graceMs : 0;
  return nowMs + s.offset >= p.phaseEndsAt + grace;
}

/**
 * 状態を定期的に取得する。受付中と締切の前後は1秒ごと、それ以外は3秒ごと。非表示のタブでは止める。
 * 期限を過ぎたら締切処理（tick）を送り、進むまで2秒ごとに送り直す。公開待ちなら公開時刻に取り直す。
 */
export function useMatch(url: string | null) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const snapRef = useRef<Snapshot | null>(null);
  const lastTick = useRef(0);

  const refresh = useCallback(async () => {
    if (!url) return;
    try {
      const t0 = Date.now();
      const data = await api<{ public: PublicState; own: OwnState | null } | PublicState>(url);
      const pub = "public" in data ? data.public : data;
      const own = "public" in data ? data.own : null;
      const offset = pub.serverNow - (t0 + Date.now()) / 2;
      const next = { public: pub, own, offset };
      snapRef.current = next;
      setSnap(next);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.code : "network");
    }
  }, [url]);

  useEffect(() => {
    if (!url) return;
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    const loop = async () => {
      if (stopped) return;
      if (document.visibilityState === "visible") {
        await refresh();
        const s = snapRef.current;
        // 運営・会場・参加者のだれが送ってもよい（冪等）。進むまで2秒ごとに送り直す
        if (s && isOverdue(s) && Date.now() - lastTick.current > 2000) {
          lastTick.current = Date.now();
          await api(`/api/m/${s.public.matchId}/tick`, { method: "POST" }).catch(() => undefined);
          await refresh();
        }
      }
      const s = snapRef.current;
      let wait = 3000;
      if (s) {
        const now = Date.now() + s.offset;
        const p = s.public;
        if (p.pendingReveal) wait = Math.max(30, p.pendingReveal.revealAt - now + 30);
        else if (p.phase === "ORDER_OPEN" || (p.phaseEndsAt !== null && p.phaseEndsAt - now < 3000)) wait = 1000;
      }
      timer = setTimeout(loop, Math.min(wait, 3000));
    };
    loop();
    const onVisible = () => document.visibilityState === "visible" && refresh();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [url, refresh]);

  return { snap, error, refresh };
}

/** 残り秒数（サーバーの時計で） */
export function useCountdown(snap: Snapshot | null): number | null {
  const [, setNow] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);
  if (!snap || snap.public.phaseEndsAt === null) return null;
  return Math.max(0, Math.ceil((snap.public.phaseEndsAt - (Date.now() + snap.offset)) / 1000));
}

export const PHASE_LABEL: Record<string, string> = {
  LOBBY: "参加受付中",
  NEWS: "ニュース",
  ORDER_OPEN: "注文受付中",
  PUBLISHED: "結果公開",
  PAUSED: "一時停止中",
  RESULT: "決算",
  ABORTED: "中止",
};

export const REASON_LABEL: Record<string, string> = {
  filled: "約定",
  partial_budget: "一部約定（予約額が足りない分を減らしました）",
  unfilled_budget: "不成立（予約額では1口も買えませんでした）",
};

export const ERROR_LABEL: Record<string, string> = {
  order_window_closed: "注文受付の時間外です",
  insufficient_cash: "使える現金が足りません",
  insufficient_holdings: "保有している口数を超えています",
  invalid_qty: "口数が正しくありません",
  stale_revision: "別の画面で変更されました。もう一度お試しください",
  nickname_taken: "その商会名はすでに使われています",
  match_started: "この試合はすでに始まっています",
  match_full: "定員に達しています",
  match_not_found: "参加コードが見つかりません",
  investigation_used: "調査券はもう使いました",
  no_investigation_window: "このラウンドでは調査できません",
  unauthorized: "参加し直してください",
  invalid_input: "入力を確かめてください",
  network: "通信できませんでした",
};
