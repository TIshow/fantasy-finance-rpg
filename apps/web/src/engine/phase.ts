import type { Timing } from "./scenario";

export type Phase = "LOBBY" | "NEWS" | "ORDER_OPEN" | "PUBLISHED" | "PAUSED" | "RESULT" | "ABORTED";
export type ProgressMode = "auto" | "manual";
export type ActivePhase = "NEWS" | "ORDER_OPEN" | "PUBLISHED";

export interface Progress {
  phase: Phase;
  /** 現在のラウンド（1から）。LOBBYでは0 */
  round: number;
  totalRounds: number;
  mode: ProgressMode;
  phaseEndsAt: number | null;
  paused: { from: ActivePhase; remainingMs: number } | null;
}

export type Trigger =
  | { type: "start"; now: number }
  | { type: "tick"; now: number }
  | { type: "next"; now: number }
  | { type: "closeNow"; now: number }
  | { type: "pause"; now: number }
  | { type: "resume"; now: number }
  | { type: "extend"; now: number; ms: number }
  | { type: "abort"; now: number };

/** 遷移と同じトランザクションで実行する処理 */
export type Effect = "clearRound" | "settle";

export type Transition =
  | { ok: true; progress: Progress; effects: Effect[]; changed: boolean }
  | { ok: false; reason: "invalid_trigger" };

export function createProgress(totalRounds: number, mode: ProgressMode = "auto"): Progress {
  return { phase: "LOBBY", round: 0, totalRounds, mode, phaseEndsAt: null, paused: null };
}

const unchanged = (progress: Progress): Transition => ({ ok: true, progress, effects: [], changed: false });
const moved = (progress: Progress, effects: Effect[] = []): Transition => ({ ok: true, progress, effects, changed: true });
const invalid: Transition = { ok: false, reason: "invalid_trigger" };

/** 1段だけ進める。ORDER_OPENを抜けるときは清算、最終ラウンドの公開を抜けるときは決算を伴う。 */
function advance(p: Progress, now: number, timing: Timing): Transition {
  switch (p.phase) {
    case "NEWS":
      return moved({ ...p, phase: "ORDER_OPEN", phaseEndsAt: now + timing.orderMs });
    case "ORDER_OPEN":
      return moved({ ...p, phase: "PUBLISHED", phaseEndsAt: now + timing.publishMs }, ["clearRound"]);
    case "PUBLISHED":
      if (p.round >= p.totalRounds) {
        return moved({ ...p, phase: "RESULT", phaseEndsAt: null }, ["settle"]);
      }
      return moved({ ...p, phase: "NEWS", round: p.round + 1, phaseEndsAt: now + timing.newsMs });
    default:
      return invalid;
  }
}

/** 期限が来ているか。注文受付は締切＋猶予まで続く。 */
export function isDue(p: Progress, now: number, timing: Timing): boolean {
  if (p.phaseEndsAt === null) return false;
  const grace = p.phase === "ORDER_OPEN" ? timing.graceMs : 0;
  return now >= p.phaseEndsAt + grace;
}

/** 状態機械。時刻は引数で受け取り、ブラウザの時計には依存しない。 */
export function phaseAfter(p: Progress, trigger: Trigger, timing: Timing): Transition {
  const { now } = trigger;
  switch (trigger.type) {
    case "start":
      if (p.phase !== "LOBBY") return invalid;
      return moved({ ...p, phase: "NEWS", round: 1, phaseEndsAt: now + timing.newsMs });
    case "tick":
      // 誰が何回呼んでもよい。期限前や一時停止中は何もしない。
      if (p.mode === "manual" || !isDue(p, now, timing)) return unchanged(p);
      return advance(p, now, timing);
    case "next":
      return advance(p, now, timing);
    case "closeNow":
      if (p.phase !== "ORDER_OPEN") return invalid;
      return advance(p, now, timing);
    case "pause":
      if (p.phase !== "NEWS" && p.phase !== "ORDER_OPEN" && p.phase !== "PUBLISHED") return invalid;
      return moved({
        ...p,
        phase: "PAUSED",
        phaseEndsAt: null,
        paused: { from: p.phase, remainingMs: Math.max(0, (p.phaseEndsAt ?? now) - now) },
      });
    case "resume":
      if (p.phase !== "PAUSED" || !p.paused) return invalid;
      return moved({ ...p, phase: p.paused.from, phaseEndsAt: now + p.paused.remainingMs, paused: null });
    case "extend":
      if ((p.phase !== "NEWS" && p.phase !== "ORDER_OPEN") || p.phaseEndsAt === null || !Number.isFinite(trigger.ms) || trigger.ms <= 0) return invalid;
      return moved({ ...p, phaseEndsAt: p.phaseEndsAt + trigger.ms });
    case "abort":
      if (p.phase === "RESULT" || p.phase === "ABORTED") return invalid;
      return moved({ ...p, phase: "ABORTED", phaseEndsAt: null, paused: null });
  }
}

/** 注文を受け付けてよいか（締切＋猶予まで。一時停止中は不可）。 */
export function acceptsOrders(p: Progress, now: number, timing: Timing): boolean {
  if (p.phase !== "ORDER_OPEN") return false;
  if (p.mode === "manual") return true;
  return !isDue(p, now, timing);
}
