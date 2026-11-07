// 3社のバッチの口（契約 LlmBatchPort。src/contracts/llm.ts）に共通する部分（#179）。
// - 費用の上限の予約（BatchBudget）：全提供元で1つを共有する。記録にある分は呼び出し側が渡す読み出し口から数え、
//   依頼してから記録されるまでのあいだの自分の予約は、ここで持って数える
// - 送る前の確かめ（外れたら RangeError）と、閉じた結果（LlmBatchClosed）の組み立て
// - 提供元ごとの違いは BatchDriver に閉じ込める（anthropic-port.ts など）
// 提供元のエラー文は受け取らず、返さない。API キーはここに来ない（提供元ごとのクライアントが環境変数から読んで持つ）。
import type { Clock, LlmBatchClosed, LlmBatchPort, LlmBatchPrice, LlmBatchRequest, LlmBatchTicket, LlmCollectResult, LlmPolicy, LlmSubmitResult } from "../contracts";
import { sha256Hex } from "../events/hash";
import { jstDayOf, llmCostUsed, llmTokenCost } from "../events/llm-cost";
import type { Draft } from "../events/append";
import type { LogEvent } from "../events/types";
import type { Deciyen } from "../ledger/types";
import type { BatchErrorCode } from "./batch-types";
import type { TokenUsage } from "./cost";

/** 1ドルあたりの円（#179 の lead の決定。owner の答えを待つあいだの既定値）。費用の 0.1円未満は切り上げる */
export const YEN_PER_USD = 160;

/** 使うモデル（#179） */
export const LLM_BATCH_MODEL_IDS = Object.freeze({ anthropic: "claude-sonnet-5-5", openai: "gpt-6.1-sol", google: "gemini-3.8-flash" });

/** 記録の一意キー（llm.batch.submitted の llmbatch:<AIのID>:<取引日>） */
export const batchKeyOf = (agentId: string, tradingDate: string): string => `llmbatch:${agentId}:${tradingDate}`;

/** バッチの中の1件のID。一意キーから決まる（同じ AI・同じ取引日なら同じ）。"llm-" と16進48文字 */
export async function batchCustomIdOf(agentId: string, tradingDate: string): Promise<string> {
  return `llm-${(await sha256Hex(new TextEncoder().encode(batchKeyOf(agentId, tradingDate)))).slice(0, 48)}`;
}

/** 記録から読んだ使用済み。recordedKeys は、記録にある llm.batch.submitted の一意キー（日を問わずすべて） */
export interface BatchSpend {
  used: Deciyen;
  recordedKeys: ReadonlySet<string>;
}
/** 記録の読み出し口。runner が自分の記録から作る（batchSpendOf） */
export type BatchSpendSource = (day: string) => Promise<BatchSpend>;

/** 記録から、day（日本時間）の使用済みと、記録にある一意キーを出す。数え方は src/events/llm-cost.ts の llmCostUsed */
export function batchSpendOf(events: readonly Pick<LogEvent, "seq" | "type" | "recordedAt" | "payload">[], day: string): BatchSpend {
  const keys = new Set<string>();
  for (const e of events) {
    if (e.type !== "llm.batch.submitted") continue;
    const p = e.payload as { agentId: string; tradingDate: string };
    keys.add(batchKeyOf(p.agentId, p.tradingDate));
  }
  return { used: llmCostUsed(events, day), recordedKeys: keys };
}

/** submittedAt と、この口の時計の今とのずれの許し（5分）。外れたら RangeError */
export const SUBMITTED_AT_SKEW_MS = 300_000;

/**
 * 課金されたか分からない依頼の2つの記録：llm.batch.submitted（batchId: null）と、すぐ閉じる llm.batch.closed（failed・costUnknown・費用 maxCost）。
 * submit が billingUnknown を返したとき（sentBodyHash はその値）と、やり直す前の findUnrecorded が found・unknown のとき
 * （BatchPort.unrecordedDrafts）に使う。closedFor には書けた llm.batch.submitted の seq を渡す
 */
export async function unknownCostDrafts(r: LlmBatchRequest, sentBodyHash: string, recordedAt: number): Promise<{ submitted: Draft; closedFor(batchSeq: number): Draft }> {
  const { yenPerUsd, inputCentsPer10MTok, outputCentsPer10MTok } = r.reservePrice;
  const customId = await batchCustomIdOf(r.agentId, r.tradingDate);
  const payload = { agentId: r.agentId, provider: r.model.provider, modelId: r.model.modelId, promptVersion: r.prompt.version, sentBodyHash, batchId: null, customId, maxCost: r.maxCost, tradingDate: r.tradingDate, submittedAt: r.submittedAt, yenPerUsd, inputCentsPer10MTok, outputCentsPer10MTok, maxInputTokens: r.maxInputTokens, maxOutputTokens: r.maxOutputTokens };
  const closed = { agentId: r.agentId, result: "failed", cost: r.maxCost, costUnknown: true, inputTokens: 0, outputTokens: 0 };
  return { submitted: { type: "llm.batch.submitted", recordedAt, actor: "system", refs: [], payload }, closedFor: (batchSeq) => ({ type: "llm.batch.closed", recordedAt, actor: "system", refs: [batchSeq], payload: { batchSeq, ...closed } }) };
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ROLES: readonly unknown[] = ["system", "user", "assistant"];
const CUSTOM_ID = /^[A-Za-z0-9_-]{1,64}$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/**
 * その日の使用済み ＝ 記録にある分 ＋ まだ記録されていない自分の予約。全提供元で1つを共有する（上限は合計で数えるため）。
 * 判定と予約は、この中で1つずつ続けて行う（同じプロセスで同時に呼ばれても上限を超えない）。
 * 予約は、その一意キーの llm.batch.submitted が記録に現れたら、記録の側で数えるので外す。
 */
export class BatchBudget {
  readonly policy: LlmPolicy;
  readonly #read: BatchSpendSource;
  readonly #pending = new Map<string, { day: string; maxCost: Deciyen }>();
  #queue: Promise<unknown> = Promise.resolve();

  constructor(policy: LlmPolicy, read: BatchSpendSource) {
    if (!isObj(policy) || !isCount(policy.dailyCostLimit) || typeof policy.dryRun !== "boolean") throw new RangeError("policy.dailyCostLimit must be a non-negative safe integer and dryRun a boolean");
    this.policy = Object.freeze({ dailyCostLimit: policy.dailyCostLimit, dryRun: policy.dryRun });
    this.#read = read;
  }

  async spent(day: string): Promise<Deciyen> {
    if (!isStr(day) || !DAY.test(day)) throw new RangeError("day must be YYYY-MM-DD");
    return this.#total(day, await this.#read(day));
  }

  #total(day: string, s: BatchSpend): Deciyen {
    let sum = s.used;
    for (const [key, r] of this.#pending) {
      if (s.recordedKeys.has(key)) this.#pending.delete(key);
      else if (r.day === day) sum += r.maxCost;
    }
    return sum;
  }

  /** 上限に収まれば予約して true、超えるなら false。同じ一意キーが記録済み・予約中なら RangeError（1体1日1回） */
  reserve(key: string, day: string, maxCost: Deciyen): Promise<boolean> {
    const run = this.#queue.then(async () => {
      const s = await this.#read(day);
      if (s.recordedKeys.has(key)) throw new RangeError("this agent already has a submission for the trading date");
      const used = this.#total(day, s);
      if (this.#pending.has(key)) throw new RangeError("a submission for this agent and trading date is in progress");
      if (used + maxCost > this.policy.dailyCostLimit) return false;
      this.#pending.set(key, { day, maxCost });
      return true;
    });
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /** 作られていないと分かった依頼の予約を外す */
  release(key: string): void {
    this.#pending.delete(key);
  }
}

/** 送る本文（提供元に渡すバイト列の元の文字列）と、それを送る関数 */
export interface Prepared {
  body: string;
  send(): Promise<SendResult>;
}
/** 送った結果。sentBodyHash はクライアントが実際に送った本文の SHA-256 */
export type SendResult = { ok: true; batchId: string; sentBodyHash: string } | { ok: false; errorCode: BatchErrorCode; billingUnknown?: true };

/**
 * 終わったバッチの、依頼した1件の結果。
 * notBilled：課金されないと資料にあるもの（費用0）。costUnknown：課金されたか分からないもの（費用は予約した maxCost）
 */
export type BatchOutcome =
  | { kind: "succeeded"; output: string; respondedModel: string; usage: TokenUsage }
  | { kind: "notBilled" | "costUnknown"; result: "expired" | "failed"; errorCode: BatchErrorCode };

/** 記録にないバッチを探す問い。since より後に作られたものを探す（提供元の時計とのずれの分、早めに渡す） */
export interface BatchLookupQuery {
  customId: string;
  since: number;
  now: number;
  /** 記録にあるバッチのID（探す対象から外す） */
  recordedBatchIds: ReadonlySet<string>;
}
/** none：作られていないと決めてよい。found：記録にないバッチがある（取り消しを頼む）。unknown：決められない（やり直さない） */
export type BatchLookup = { kind: "none" } | { kind: "found"; batchIds: string[] } | { kind: "unknown" };

/** 提供元ごとの違い */
export interface BatchDriver {
  readonly provider: string;
  /** model.settings に許す鍵（temperature は入れない。#179 の lead の決定） */
  readonly settingKeys: readonly string[];
  /** 費用の式が入力の1トークンに掛ける倍率の最大（キャッシュへの書き込みを入力の欄と書き込みの欄の両方に入れるなら3）。既定は1 */
  readonly inputCostFactor?: number;
  /** submittedAt の時点の料金（1,000万トークンあたりのセント）。料金表にないモデルは undefined */
  priceAt(modelId: string, submittedAt: number): LlmBatchPrice | undefined;
  /** 送る本文を決まった形で作る。決まりに合わなければ RangeError */
  prepare(request: LlmBatchRequest, customId: string): Prepared;
  /** 今の様子。終わっていない・読めない（通信の失敗など）ときは "pending" */
  outcome(ticket: LlmBatchTicket): Promise<BatchOutcome | "pending">;
  /** 取り消しを頼む。頼めたら true */
  cancel(batchId: string): Promise<boolean>;
  lookup(query: BatchLookupQuery): Promise<BatchLookup>;
}

export interface BatchPortOptions {
  /** 全提供元で共有する予約 */
  budget: BatchBudget;
  /** 閉じた時刻（finishedAt）に使う */
  clock: Clock;
  /** 1ドルあたりの円。既定は YEN_PER_USD */
  yenPerUsd?: number;
}

type ReservePrice = LlmBatchPrice & { yenPerUsd: number };
const UNKNOWN_PENDING: BatchOutcome = { kind: "costUnknown", result: "expired", errorCode: "timeout" };

/**
 * 契約 LlmBatchPort の実装。決まりは契約のとおり。ほかに：
 * - reservePrice は、提供元の料金表の submittedAt の時点の料金と、この口の1ドルあたりの円に、ちょうど一致すること
 * - maxOutputTokens は settings.max_tokens 以上、maxInputTokens は送る本文の UTF-8 のバイト数×driver.inputCostFactor 以上であること
 *   （トークン数はバイト数を超えないので、予約が上限として働く）。外れたら RangeError
 * - 記録の読み出しが失敗したら、送らずに budget_exceeded を返す（上限を確かめられないので、送らない側に倒す）
 * - 受け取り・打ち切りで読めなかったときは pending（打ち切りでは、課金が分からないとして maxCost）
 */
export class BatchPort implements LlmBatchPort {
  readonly #driver: BatchDriver;
  readonly #budget: BatchBudget;
  readonly #clock: Clock;
  readonly #yen: number;

  constructor(driver: BatchDriver, options: BatchPortOptions) {
    const yen = options.yenPerUsd ?? YEN_PER_USD;
    if (!Number.isSafeInteger(yen) || yen < 1) throw new RangeError("yenPerUsd must be a positive safe integer");
    this.#driver = driver;
    this.#budget = options.budget;
    this.#clock = options.clock;
    this.#yen = yen;
  }

  get policy(): LlmPolicy {
    return this.#budget.policy;
  }

  spent(day: string): Promise<Deciyen> {
    return this.#budget.spent(day);
  }

  async submit(r: LlmBatchRequest): Promise<LlmSubmitResult> {
    this.#check(r);
    const customId = await batchCustomIdOf(r.agentId, r.tradingDate);
    const prepared = this.#driver.prepare(r, customId);
    const bytes = new TextEncoder().encode(prepared.body);
    if (r.maxInputTokens < bytes.length * (this.#driver.inputCostFactor ?? 1)) throw new RangeError("maxInputTokens must be at least the byte length of the body sent times inputCostFactor");
    const sentBodyHash = await sha256Hex(bytes);
    const submittedAt = r.submittedAt;
    const key = batchKeyOf(r.agentId, r.tradingDate);
    let reserved: boolean;
    try {
      reserved = await this.#budget.reserve(key, jstDayOf(submittedAt), r.maxCost);
    } catch (e) {
      if (e instanceof RangeError) throw e;
      reserved = false;
    }
    if (!reserved) return { ok: false, errorCode: "budget_exceeded", submittedAt };
    let sent: SendResult;
    try {
      sent = await prepared.send();
    } catch {
      // 送る途中の思いがけない例外は、作られたか分からないものとして扱う（文は捨てる）
      sent = { ok: false, errorCode: "provider_error", billingUnknown: true };
    }
    if (sent.ok) {
      const ticket: LlmBatchTicket = { agentId: r.agentId, provider: this.#driver.provider, modelId: r.model.modelId, batchId: sent.batchId, customId, maxCost: r.maxCost, tradingDate: r.tradingDate, submittedAt };
      return { ok: true, ticket, sentBodyHash: sent.sentBodyHash };
    }
    // 作られたか分からないなら、予約は残す（呼び出し側が batchId を null にした記録を書くまで）
    if (sent.billingUnknown) return { ok: false, errorCode: sent.errorCode, billingUnknown: true, sentBodyHash, submittedAt };
    this.#budget.release(key);
    return { ok: false, errorCode: sent.errorCode, sentBodyHash, submittedAt };
  }

  async collect(t: LlmBatchTicket): Promise<LlmCollectResult> {
    this.#checkTicket(t);
    const o = await this.#outcome(t);
    return o === "pending" ? { status: "pending" } : this.#closed(o, t, false);
  }

  async abandon(t: LlmBatchTicket): Promise<LlmBatchClosed> {
    this.#checkTicket(t);
    let o = await this.#outcome(t);
    if (o === "pending") {
      await this.cancelBatch(t.batchId);
      o = await this.#outcome(t);
    }
    return this.#closed(o === "pending" ? UNKNOWN_PENDING : o, t, true);
  }

  /** findUnrecorded が found・unknown のとき送らずに書く2つの記録。r はやり直すはずだった依頼で、ハッシュはその本文のもの */
  async unrecordedDrafts(r: LlmBatchRequest, recordedAt: number): Promise<{ submitted: Draft; closedFor(batchSeq: number): Draft }> {
    this.#check(r);
    const body = this.#driver.prepare(r, await batchCustomIdOf(r.agentId, r.tradingDate)).body;
    return unknownCostDrafts(r, await sha256Hex(new TextEncoder().encode(body)), recordedAt);
  }

  /**
   * 記録にないバッチを探す（runner の義務：同じ AI・同じ取引日の依頼をやり直す前に確かめる）。
   * found なら cancelBatch で取り消しを頼む。どちらでもやり直さず、unrecordedDrafts の記録で費用を maxCost で数える
   */
  async findUnrecorded(q: { agentId: string; tradingDate: string } & Omit<BatchLookupQuery, "customId">): Promise<BatchLookup> {
    if (!Number.isFinite(q.since) || !Number.isFinite(q.now)) throw new RangeError("since and now must be finite numbers");
    const customId = await batchCustomIdOf(q.agentId, q.tradingDate);
    try {
      return await this.#driver.lookup({ customId, since: q.since, now: q.now, recordedBatchIds: q.recordedBatchIds });
    } catch (e) {
      if (e instanceof RangeError) throw e;
      return { kind: "unknown" };
    }
  }

  /** バッチの取り消しを頼む（締めでの打ち切りと、あとで作られていたと分かったバッチ）。頼めたら true */
  async cancelBatch(batchId: string): Promise<boolean> {
    try {
      return await this.#driver.cancel(batchId);
    } catch (e) {
      if (e instanceof RangeError) throw e;
      return false;
    }
  }

  async #outcome(t: LlmBatchTicket): Promise<BatchOutcome | "pending"> {
    try {
      return await this.#driver.outcome(t);
    } catch (e) {
      if (e instanceof RangeError) throw e;
      return "pending";
    }
  }

  #check(r: LlmBatchRequest): void {
    if (!isObj(r)) throw new RangeError("request must be an object");
    if (!Number.isSafeInteger(r.maxCost) || r.maxCost < 1) throw new RangeError("maxCost must be a positive safe integer");
    if (!isStr(r.agentId) || r.agentId === "" || !isStr(r.tradingDate) || !DAY.test(r.tradingDate)) throw new RangeError("agentId and tradingDate (YYYY-MM-DD) are required");
    if (!isCount(r.submittedAt) || Math.abs(r.submittedAt - this.#clock.now()) > SUBMITTED_AT_SKEW_MS) throw new RangeError("submittedAt must be a safe integer within 5 minutes of now");
    if (!Array.isArray(r.messages) || !r.messages.every((x: unknown) => isObj(x) && ROLES.includes(x.role) && isStr(x.content))) throw new RangeError("messages must be an array of { role, content: string }");
    const m = r.model;
    if (!isObj(m) || m.provider !== this.#driver.provider || !isStr(m.modelId) || !isObj(m.settings)) throw new RangeError(`model.provider must be ${this.#driver.provider}`);
    const extra = Object.keys(m.settings).filter((k) => !this.#driver.settingKeys.includes(k));
    if (extra.length > 0) throw new RangeError(`unsupported settings: ${extra.join(",")}`);
    const price = this.#driver.priceAt(m.modelId, r.submittedAt);
    if (price === undefined) throw new RangeError("the model has no batch price");
    const rp = r.reservePrice;
    if (!isObj(rp) || rp.yenPerUsd !== this.#yen || rp.inputCentsPer10MTok !== price.inputCentsPer10MTok || rp.outputCentsPer10MTok !== price.outputCentsPer10MTok) {
      throw new RangeError("reservePrice must be the provider's price at submittedAt");
    }
    if (!isCount(r.maxInputTokens) || !isCount(r.maxOutputTokens)) throw new RangeError("maxInputTokens and maxOutputTokens must be non-negative safe integers");
    if (!(r.maxOutputTokens >= Number(m.settings.max_tokens))) throw new RangeError("maxOutputTokens must be at least settings.max_tokens");
    const bound = llmTokenCost({ inputTokens: r.maxInputTokens, outputTokens: r.maxOutputTokens }, rp);
    if (bound === null || r.maxCost < bound) throw new RangeError("maxCost must be at least the cost of maxInputTokens and maxOutputTokens");
  }

  #checkTicket(t: LlmBatchTicket): void {
    if (!isObj(t) || t.provider !== this.#driver.provider || !isStr(t.modelId) || !isStr(t.batchId) || !isStr(t.customId) || !CUSTOM_ID.test(t.customId)) throw new RangeError("invalid ticket");
    if (!Number.isSafeInteger(t.maxCost) || t.maxCost < 1 || !isCount(t.submittedAt)) throw new RangeError("invalid ticket");
  }

  /** 閉じた結果。料金は予約のときと同じ（submittedAt の時点の料金表）。abandoned なら result は expired（timeout） */
  #closed(o: BatchOutcome, t: LlmBatchTicket, abandoned: boolean): LlmBatchClosed {
    const finishedAt = this.#clock.now();
    const p = this.#driver.priceAt(t.modelId, t.submittedAt);
    const rp: ReservePrice | undefined = p && { yenPerUsd: this.#yen, ...p };
    const end = (result: "expired" | "failed", errorCode: BatchErrorCode) => (abandoned ? { result: "expired" as const, errorCode: "timeout" as const } : { result, errorCode });
    const unknown = (result: "expired" | "failed", errorCode: BatchErrorCode): LlmBatchClosed => ({ status: "closed", ...end(result, errorCode), usage: { inputTokens: 0, outputTokens: 0, cost: t.maxCost }, costUnknown: true, finishedAt });
    // 料金表からモデルが消えた（送る前の確かめで起きないはず）ときも、費用は分からないとする
    if (rp === undefined) return o.kind === "succeeded" ? unknown("failed", "provider_error") : unknown(o.result, o.errorCode);
    const price = { inputCentsPer10MTok: rp.inputCentsPer10MTok, outputCentsPer10MTok: rp.outputCentsPer10MTok };
    if (o.kind !== "succeeded") {
      if (o.kind === "costUnknown") return unknown(o.result, o.errorCode);
      return { status: "closed", ...end(o.result, o.errorCode), usage: { inputTokens: 0, outputTokens: 0, cost: 0 }, price, finishedAt };
    }
    const u = o.usage;
    const tokens = {
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      ...(u.cacheCreationInputTokens > 0 ? { cacheCreationInputTokens: u.cacheCreationInputTokens } : {}),
      ...(u.cacheReadInputTokens > 0 ? { cacheReadInputTokens: u.cacheReadInputTokens } : {}),
    };
    const cost = llmTokenCost(tokens, rp);
    if (cost === null) return unknown("failed", "provider_error");
    const usage = { ...tokens, cost };
    if (abandoned) return { status: "closed", result: "expired", errorCode: "timeout", usage, price, finishedAt };
    return { status: "closed", result: "collected", output: o.output, respondedModel: o.respondedModel, usage, price, finishedAt };
  }
}
