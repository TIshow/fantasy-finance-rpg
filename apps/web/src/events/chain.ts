// ハッシュの連鎖（docs/EVENT_LOG.md §5.1）。追記の前の検査（種類ごとの書ける者・時刻・順序）は再計算のPRで足す。
import { canonicalize, CanonicalizeError } from "./canonical";
import { eventHash } from "./hash";
import { EVENT_TYPES, GENESIS_HASH, SCHEMA, type EventDraft, type LogEvent } from "./types";

const TYPES: ReadonlySet<string> = new Set(EVENT_TYPES);
const ACTOR = /^(system|agent:[a-z0-9][a-z0-9_-]*|operator:[a-z0-9][a-z0-9_-]*)$/;
const HASH = /^[0-9a-f]{64}$/;
const FIELDS = ["actor", "hash", "keys", "payload", "prevHash", "recordedAt", "refs", "schema", "seq", "type"];

const show = (v: unknown): string => {
  try {
    return `${JSON.stringify(v) ?? String(v)} (${typeof v})`;
  } catch {
    return typeof v;
  }
};

interface Expected {
  seq: number;
  /** 直前のイベントの hash。直前が壊れていて分からなければ null（その場合は照合しない） */
  prevHash: string | null;
  prevRecordedAt: number | null;
}

/** 1件の形式を、期待する seq・直前のイベント・それまでに使われた一意キーに照らして確かめる */
function formatProblems(e: Record<string, unknown>, x: Expected, usedKeys: ReadonlySet<string>): string[] {
  const p: string[] = [];
  const seq = x.seq;
  for (const f of FIELDS) if (!Object.hasOwn(e, f)) p.push(`missing field ${f}`);
  for (const f of Object.keys(e)) if (!FIELDS.includes(f)) p.push(`unknown field ${f}`);
  if (e.seq !== seq) p.push(`seq should be ${seq}, got ${show(e.seq)}`);
  if (e.schema !== SCHEMA) p.push(`unknown schema ${show(e.schema)}`);
  if (typeof e.type !== "string" || !TYPES.has(e.type)) p.push(`unknown type ${show(e.type)}`);
  if (typeof e.actor !== "string" || !ACTOR.test(e.actor)) p.push(`invalid actor ${show(e.actor)}`);
  const at = e.recordedAt;
  if (typeof at !== "number" || !Number.isSafeInteger(at) || at < 0) p.push(`invalid recordedAt ${show(at)}`);
  else if (x.prevRecordedAt !== null && at < x.prevRecordedAt) p.push("recordedAt goes backwards");
  const refs = e.refs;
  if (!Array.isArray(refs) || !refs.every((r) => Number.isSafeInteger(r) && r >= 1 && r < seq)) p.push("refs must point to earlier events");
  else if (new Set(refs).size !== refs.length) p.push("duplicate refs");
  const keys = e.keys;
  if (!Array.isArray(keys)) p.push("keys must be an array");
  else {
    const own = new Set<string>();
    for (const k of keys) {
      if (typeof k !== "string" || k === "") p.push(`invalid key ${show(k)}`);
      else if (usedKeys.has(k) || own.has(k)) p.push(`duplicate key ${k}`);
      else own.add(k);
    }
  }
  if (x.prevHash !== null && e.prevHash !== x.prevHash) p.push("prevHash does not match the previous event");
  return p;
}

/**
 * 最後のイベント（なければ null）のあとに続くイベントを作る。形式が合わないか、中身が正規化できなければ例外。
 * 返すイベントは draft の写しで、凍結してある（作ったあとに draft を変えても、ハッシュとずれない）
 */
// usedKeys：それまでのログで使われた一意キー。追記の処理（§8の3）はログ全体の集合を渡す。省略すると、このイベントの中の重複だけを確かめる
export async function sealEvent(last: LogEvent | null, draft: EventDraft, usedKeys: ReadonlySet<string> = new Set()): Promise<LogEvent> {
  const unsealed = {
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
  const expected = { seq: unsealed.seq, prevHash: unsealed.prevHash, prevRecordedAt: last ? last.recordedAt : null };
  const problems = formatProblems({ ...unsealed, hash: "" }, expected, usedKeys);
  if (problems.length > 0) throw new Error(`invalid event: ${problems.join("; ")}`);
  const copy = deepFreeze(JSON.parse(canonicalize(unsealed)) as Omit<LogEvent, "hash">);
  return Object.freeze({ ...copy, hash: await eventHash(copy) });
}

/**
 * ログ全体を先頭から確かめ、問題を並べて返す（空なら問題なし）。
 * 正規化できない中身は問題として報告し、ハッシュの計算そのものの失敗（Web Crypto がないなど）は例外にする
 */
export async function verifyChain(events: readonly unknown[]): Promise<string[]> {
  const problems: string[] = [];
  const usedKeys = new Set<string>();
  let prevHash: string | null = GENESIS_HASH;
  let prevRecordedAt: number | null = null;
  for (const [i, raw] of events.entries()) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      problems.push(`event #${i}: not an object`);
      prevHash = null;
      continue;
    }
    const e = raw as Record<string, unknown>;
    const at = `event #${i} (seq ${show(e.seq)})`;
    for (const p of formatProblems(e, { seq: i + 1, prevHash, prevRecordedAt }, usedKeys)) problems.push(`${at}: ${p}`);
    if (Array.isArray(e.keys)) for (const k of e.keys) if (typeof k === "string" && k !== "") usedKeys.add(k);
    if (typeof e.hash !== "string" || !HASH.test(e.hash)) problems.push(`${at}: invalid hash`);
    else {
      const { hash, ...rest } = e;
      try {
        if ((await eventHash(rest as Omit<LogEvent, "hash">)) !== hash) problems.push(`${at}: hash does not match the content`);
      } catch (err) {
        if (!(err instanceof CanonicalizeError)) throw err;
        problems.push(`${at}: cannot canonicalize: ${err.message}`);
      }
    }
    prevHash = typeof e.hash === "string" ? e.hash : null;
    if (typeof e.recordedAt === "number" && Number.isSafeInteger(e.recordedAt)) prevRecordedAt = e.recordedAt;
  }
  return problems;
}

function deepFreeze<T>(v: T): T {
  if (typeof v === "object" && v !== null) {
    for (const x of Object.values(v)) deepFreeze(x);
    Object.freeze(v);
  }
  return v;
}
