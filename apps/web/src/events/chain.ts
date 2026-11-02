// ハッシュの連鎖（docs/EVENT_LOG.md §5.1）。追記の前の検査（書ける者・時刻・順序）は再計算のPRで足す。
import { eventHash } from "./hash";
import { EVENT_TYPES, GENESIS_HASH, SCHEMA, type EventDraft, type LogEvent } from "./types";

const TYPES: ReadonlySet<string> = new Set(EVENT_TYPES);
const ACTOR = /^(system|agent:[a-z0-9][a-z0-9_-]*|operator:[a-z0-9][a-z0-9_-]*)$/;
const HASH = /^[0-9a-f]{64}$/;

/** 最後のイベント（なければ null）のあとに続くイベントを作る。中身が正規化できなければ例外 */
export async function sealEvent(last: LogEvent | null, draft: EventDraft): Promise<LogEvent> {
  const unsealed: Omit<LogEvent, "hash"> = {
    seq: last ? last.seq + 1 : 1,
    schema: SCHEMA,
    type: draft.type,
    recordedAt: draft.recordedAt,
    actor: draft.actor,
    keys: draft.keys,
    refs: draft.refs,
    payload: draft.payload,
    prevHash: last ? last.hash : GENESIS_HASH,
  };
  return { ...unsealed, hash: await eventHash(unsealed) };
}

/** ログ全体を先頭から確かめ、問題を並べて返す（空なら問題なし） */
export async function verifyChain(events: readonly LogEvent[]): Promise<string[]> {
  const problems: string[] = [];
  const keys = new Set<string>();
  let prev: LogEvent | null = null;
  for (const [i, e] of events.entries()) {
    const at = `event #${i} (seq ${e.seq})`;
    if (e.seq !== i + 1) problems.push(`${at}: seq should be ${i + 1}`);
    if (e.schema !== SCHEMA) problems.push(`${at}: unknown schema ${e.schema}`);
    if (!TYPES.has(e.type)) problems.push(`${at}: unknown type ${e.type}`);
    if (typeof e.actor !== "string" || !ACTOR.test(e.actor)) problems.push(`${at}: invalid actor`);
    if (!Number.isSafeInteger(e.recordedAt)) problems.push(`${at}: invalid recordedAt`);
    else if (prev && e.recordedAt < prev.recordedAt) problems.push(`${at}: recordedAt goes backwards`);
    if (!Array.isArray(e.refs) || !e.refs.every((r) => Number.isSafeInteger(r) && r >= 1 && r < e.seq)) problems.push(`${at}: refs must point to earlier events`);
    if (!Array.isArray(e.keys)) problems.push(`${at}: keys must be an array`);
    else {
      for (const k of e.keys) {
        if (typeof k !== "string" || k === "") problems.push(`${at}: invalid key`);
        else if (keys.has(k)) problems.push(`${at}: duplicate key ${k}`);
        else keys.add(k);
      }
    }
    const expectedPrev = prev ? prev.hash : GENESIS_HASH;
    if (e.prevHash !== expectedPrev) problems.push(`${at}: prevHash does not match the previous event`);
    if (typeof e.hash !== "string" || !HASH.test(e.hash)) problems.push(`${at}: invalid hash`);
    else {
      const { hash, ...rest } = e;
      try {
        if ((await eventHash(rest)) !== hash) problems.push(`${at}: hash does not match the content`);
      } catch (err) {
        problems.push(`${at}: cannot canonicalize: ${(err as Error).message}`);
      }
    }
    prev = e;
  }
  return problems;
}
