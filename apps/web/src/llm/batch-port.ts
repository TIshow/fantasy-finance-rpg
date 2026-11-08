// 3社のバッチの口（契約 LlmBatchPort。src/contracts/llm.ts）に共通する部分（#179）。
// 流れは契約のとおり：prepare（本文を作る。送らない）→ runner が予約の記録①を書く → send（本文をそのまま送る）→ ③、
// 止まったあとは find、受け取りは collect、締めでの打ち切りは abandon。予約は記録にあるので、この口は予約を持たない。
// 提供元ごとの違いは BatchDriver に閉じ込める（anthropic-port.ts など）。
// 提供元のエラー文は受け取らず、返さない。API キーはここに来ない（提供元ごとのクライアントが環境変数から読んで持つ）。
import type { Clock, LlmBatchClosed, LlmBatchPort, LlmBatchPrice, LlmBatchRequest, LlmBatchReservation, LlmBatchTicket, LlmFindResult, LlmPolicy, LlmPreparedBatch, LlmSendResult } from "../contracts";
import { sha256Hex } from "../events/hash";
import { llmTokenCost } from "../events/llm-cost";
import type { BatchErrorCode } from "./batch-types";
import type { TokenUsage } from "./cost";

/** 1ドルあたりの円（#179 の lead の決定。owner の答えを待つあいだの既定値）。費用の 0.1円未満は切り上げる */
export const YEN_PER_USD = 160;

/** 使うモデル（#179） */
export const LLM_BATCH_MODEL_IDS = Object.freeze({ anthropic: "claude-sonnet-5-5", openai: "gpt-6.1-sol", google: "gemini-3.8-flash" });

/** 1回の入力の上限（トークン。#179 の lead の決定2）。1トークンは1バイト以上なので、本文がこのバイト数÷inputCostFactor 以下なら必ず収まる */
export const BATCH_MAX_INPUT_TOKENS = 20_000;

/** submittedAt と、この口の時計の今とのずれの許し（5分）。外れたら RangeError */
export const SUBMITTED_AT_SKEW_MS = 300_000;
/** 送る時間の上限（契約：10分。超えたら打ち切って billingUnknown） */
export const BATCH_SEND_TIMEOUT_MS = 600_000;
/** find が見る作成時刻の範囲：reservedAt の5分前から、reservedAt ＋ 送る時間の上限 ＋ 5分まで（契約の LlmFindResult） */
export const FIND_BEFORE_MS = 300_000;
export const FIND_AFTER_MS = BATCH_SEND_TIMEOUT_MS + 300_000;

/** customId の末尾に付ける、本文のハッシュの文字数と、前半（agentId-YYYYMMDD）の長さの上限（契約の LlmPreparedBatch.customId） */
const HASH_CHARS = 16;
const PREFIX_MAX = 47;

/**
 * 本文の中の1件のID（Anthropic・OpenAI の custom_id、Gemini の表示名など）。前半「agentId-YYYYMMDD」で、47文字まで（長ければ agentId を
 * 先頭から切り詰める）。本文のハッシュは本文の中に書けないので、本文にはこの前半だけを入れる
 */
export function batchItemIdOf(agentId: string, tradingDate: string): string {
  const date = tradingDate.replaceAll("-", "");
  return `${agentId.slice(0, PREFIX_MAX - 1 - date.length)}-${date}`;
}
/** customId：前半 ＋ "-" ＋ 本文のハッシュの先頭16文字 */
export const batchCustomIdOf = (itemId: string, sentBodyHash: string): string => `${itemId}-${sentBodyHash.slice(0, HASH_CHARS)}`;
/** customId から、本文の中の1件のID（前半）を取り出す */
export const batchItemIdOfCustomId = (customId: string): string => customId.slice(0, -(HASH_CHARS + 1));

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ROLES: readonly unknown[] = ["system", "user", "assistant"];
const ITEM_ID = /^[A-Za-z0-9_-]{1,47}$/;
const CUSTOM_ID = /^[A-Za-z0-9_-]{1,64}$/;
const HASH = /^[0-9a-f]{64}$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** 送った結果（提供元ごと）。契約の LlmSendResult と同じ */
export type SendResult = LlmSendResult;

/**
 * 終わったバッチの1件の結果。truncated：出力の上限で切れた。
 * costUnknown：答えがない（失敗・期限切れ・取り消し）。送ったバッチは、課金されないと資料にあっても費用0で閉じられないので、すべてこれ（費用 maxCost）
 */
export type BatchOutcome =
  | { kind: "succeeded"; output: string; respondedModel: string; usage: TokenUsage; truncated: boolean }
  | { kind: "costUnknown"; result: "expired" | "failed"; errorCode: BatchErrorCode };

/** find の問い。作成時刻が from〜to の、名前が customId のバッチを探す */
export interface BatchFindQuery {
  reservation: LlmBatchReservation;
  from: number;
  to: number;
}

/** 提供元ごとの違い */
export interface BatchDriver {
  readonly provider: string;
  /** model.settings に許す鍵（temperature は入れない。#179 の lead の決定） */
  readonly settingKeys: readonly string[];
  /** 送る出力の上限（考える分も含む。#179 の lead の決定2）。settings.max_tokens はこれと同じ、maxOutputTokens はこれ以上 */
  readonly maxOutputTokens: number;
  /** 費用の式が入力の1トークンに掛ける倍率の最大（キャッシュへの書き込みを入力の欄と書き込みの欄の両方に入れるなら3）。既定は1 */
  readonly inputCostFactor?: number;
  /** submittedAt の時点の料金（1,000万トークンあたりのセント）。料金表にないモデルは undefined */
  priceAt(modelId: string, submittedAt: number): LlmBatchPrice | undefined;
  /** 送る本文を決まった形で作る。itemId は本文の中の1件のID。決まりに合わなければ RangeError */
  body(request: LlmBatchRequest, itemId: string): string;
  /** body を加工せずに送る。customId は本文の外に名前を持てる提供元（OpenAI のメタデータ）が使う */
  send(body: string, request: LlmBatchRequest, customId: string): Promise<SendResult>;
  /** 探す。確かめられない提供元は not_found。一覧が読めなければ unknown */
  find(query: BatchFindQuery): Promise<LlmFindResult>;
  /** 今の様子。終わっていない・読めない（通信の失敗など）ときは "pending"。itemId は本文の中の1件のID */
  outcome(ticket: LlmBatchTicket, itemId: string): Promise<BatchOutcome | "pending">;
  /** 取り消しを頼む。頼めたら true */
  cancel(batchId: string): Promise<boolean>;
}

export interface BatchPortOptions {
  /** 1日の上限と dryRun。runner が流れの1で使う（この口は予約を持たない） */
  policy: LlmPolicy;
  /** submittedAt のずれの確かめと、閉じた時刻（finishedAt）に使う */
  clock: Clock;
  /** 1ドルあたりの円。既定は YEN_PER_USD */
  yenPerUsd?: number;
  /** 送る時間の上限（ミリ秒）。試験で短くする。既定は BATCH_SEND_TIMEOUT_MS（これより長くはできない） */
  sendTimeoutMs?: number;
}

/** 閉じた結果。truncated: true は、出力の上限で途中で切れた答え（collected のときだけ付く。記録に書く前に外す） */
export type BatchClosed = LlmBatchClosed & { truncated?: true };

/**
 * 契約 LlmBatchPort の実装。決まりは契約のとおり。ほかに：
 * - reservePrice は、提供元の料金表の submittedAt の時点の料金と、この口の1ドルあたりの円に、ちょうど一致すること
 * - settings.max_tokens は driver.maxOutputTokens と同じで、maxOutputTokens はそれ以上。maxInputTokens は BATCH_MAX_INPUT_TOKENS 以下で、
 *   送る本文の UTF-8 のバイト数×driver.inputCostFactor 以上（トークン数はバイト数を超えないので、予約が上限として働く）。外れたら RangeError
 * - send は、渡された本文のハッシュと customId が prepare の結果と合わなければ RangeError（送らない）
 * - 受け取り・打ち切りで読めなかったときは pending（打ち切りでは、課金が分からないとして maxCost）
 */
export class BatchPort implements LlmBatchPort {
  readonly policy: LlmPolicy;
  readonly #driver: BatchDriver;
  readonly #clock: Clock;
  readonly #yen: number;
  readonly #sendTimeoutMs: number;

  constructor(driver: BatchDriver, options: BatchPortOptions) {
    const { policy } = options;
    if (!isObj(policy) || !isCount(policy.dailyCostLimit) || typeof policy.dryRun !== "boolean") throw new RangeError("policy.dailyCostLimit must be a non-negative safe integer and dryRun a boolean");
    const yen = options.yenPerUsd ?? YEN_PER_USD;
    if (!Number.isSafeInteger(yen) || yen < 1) throw new RangeError("yenPerUsd must be a positive safe integer");
    const timeout = options.sendTimeoutMs ?? BATCH_SEND_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > BATCH_SEND_TIMEOUT_MS) throw new RangeError("sendTimeoutMs must be from 1 to 600000");
    this.policy = Object.freeze({ dailyCostLimit: policy.dailyCostLimit, dryRun: policy.dryRun });
    this.#driver = driver;
    this.#clock = options.clock;
    this.#yen = yen;
    this.#sendTimeoutMs = timeout;
  }

  async prepare(r: LlmBatchRequest): Promise<LlmPreparedBatch> {
    this.#check(r);
    const itemId = batchItemIdOf(r.agentId, r.tradingDate);
    const body = this.#driver.body(r, itemId);
    const bytes = new TextEncoder().encode(body);
    if (r.maxInputTokens < bytes.length * (this.#driver.inputCostFactor ?? 1)) throw new RangeError("maxInputTokens must be at least the byte length of the body sent times inputCostFactor");
    const sentBodyHash = await sha256Hex(bytes);
    return Object.freeze({ request: r, customId: batchCustomIdOf(itemId, sentBodyHash), bodyMaxOutputTokens: this.#driver.maxOutputTokens, body, sentBodyHash });
  }

  async send(p: LlmPreparedBatch, batchSeq: number): Promise<LlmSendResult> {
    if (!isObj(p) || !isStr(p.body) || !isCount(batchSeq)) throw new RangeError("prepared and batchSeq are required");
    this.#check(p.request, false);
    const hash = await sha256Hex(new TextEncoder().encode(p.body));
    if (p.sentBodyHash !== hash || p.customId !== batchCustomIdOf(batchItemIdOf(p.request.agentId, p.request.tradingDate), hash)) throw new RangeError("the prepared body does not match its hash or customId");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<LlmSendResult>((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, errorCode: "timeout", billingUnknown: true }), this.#sendTimeoutMs);
    });
    try {
      return await Promise.race([this.#driver.send(p.body, p.request, p.customId), late]);
    } catch {
      // 送る途中の思いがけない例外は、作られたか分からないものとして扱う（文は捨てる）
      return { ok: false, errorCode: "provider_error", billingUnknown: true };
    } finally {
      clearTimeout(timer);
    }
  }

  async find(r: LlmBatchReservation): Promise<LlmFindResult> {
    if (!isObj(r) || r.provider !== this.#driver.provider || !isStr(r.customId) || !CUSTOM_ID.test(r.customId) || !isStr(r.sentBodyHash) || !HASH.test(r.sentBodyHash) || !isCount(r.reservedAt)) throw new RangeError("invalid reservation");
    try {
      return await this.#driver.find({ reservation: r, from: r.reservedAt - FIND_BEFORE_MS, to: r.reservedAt + FIND_AFTER_MS });
    } catch (e) {
      if (e instanceof RangeError) throw e;
      return { status: "unknown" };
    }
  }

  async collect(t: LlmBatchTicket): Promise<{ status: "pending" } | BatchClosed> {
    this.#checkTicket(t);
    const o = await this.#outcome(t);
    return o === "pending" ? { status: "pending" } : this.#closed(o, t, false);
  }

  /** 打ち切り。終わっていなければ取り消しを頼み、もう一度様子を見る。終わったと確かめられなければ maxCost・costUnknown */
  async abandon(t: LlmBatchTicket): Promise<LlmBatchClosed> {
    this.#checkTicket(t);
    let o = await this.#outcome(t);
    if (o === "pending") {
      try {
        await this.#driver.cancel(t.batchId);
      } catch (e) {
        if (e instanceof RangeError) throw e;
      }
      o = await this.#outcome(t);
    }
    return this.#closed(o === "pending" ? { kind: "costUnknown", result: "expired", errorCode: "timeout" } : o, t, true);
  }

  async #outcome(t: LlmBatchTicket): Promise<BatchOutcome | "pending"> {
    try {
      return await this.#driver.outcome(t, batchItemIdOfCustomId(t.customId));
    } catch (e) {
      if (e instanceof RangeError) throw e;
      return "pending";
    }
  }

  /** withNow：submittedAt を今の時計と比べるか（send では prepare から時間がたっているので比べない） */
  #check(r: LlmBatchRequest, withNow = true): void {
    if (!isObj(r)) throw new RangeError("request must be an object");
    if (!Number.isSafeInteger(r.maxCost) || r.maxCost < 1) throw new RangeError("maxCost must be a positive safe integer");
    if (!isStr(r.agentId) || r.agentId === "" || !isStr(r.tradingDate) || !DAY.test(r.tradingDate) || !ITEM_ID.test(batchItemIdOf(r.agentId, r.tradingDate))) throw new RangeError("agentId ([A-Za-z0-9_-]) and tradingDate (YYYY-MM-DD) are required");
    if (!isCount(r.submittedAt) || (withNow && Math.abs(r.submittedAt - this.#clock.now()) > SUBMITTED_AT_SKEW_MS)) throw new RangeError("submittedAt must be a safe integer within 5 minutes of now");
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
    const cap = this.#driver.maxOutputTokens;
    if (m.settings.max_tokens !== String(cap) || r.maxOutputTokens < cap || r.maxInputTokens > BATCH_MAX_INPUT_TOKENS) throw new RangeError(`settings.max_tokens must be ${cap}, maxOutputTokens at least that, and maxInputTokens at most ${BATCH_MAX_INPUT_TOKENS}`);
    const bound = llmTokenCost({ inputTokens: r.maxInputTokens, outputTokens: r.maxOutputTokens }, rp);
    if (bound === null || r.maxCost < bound) throw new RangeError("maxCost must be at least the cost of maxInputTokens and maxOutputTokens");
  }

  #checkTicket(t: LlmBatchTicket): void {
    if (!isObj(t) || t.provider !== this.#driver.provider || !isStr(t.modelId) || !isStr(t.batchId) || !isStr(t.customId) || !CUSTOM_ID.test(t.customId) || t.customId.length <= HASH_CHARS + 1) throw new RangeError("invalid ticket");
    if (!Number.isSafeInteger(t.maxCost) || t.maxCost < 1 || !isCount(t.submittedAt)) throw new RangeError("invalid ticket");
  }

  /**
   * 閉じた結果。料金は予約のときと同じ（submittedAt の時点の料金表）。abandoned なら result は expired（timeout）。
   * 送ったバッチは、答えを受け取ったとき以外は費用0にできない。トークン数が0（入力か出力）なら、記録の検査が断るので costUnknown
   */
  #closed(o: BatchOutcome, t: LlmBatchTicket, abandoned: boolean): BatchClosed {
    const finishedAt = this.#clock.now();
    const p = this.#driver.priceAt(t.modelId, t.submittedAt);
    const end = (result: "expired" | "failed", errorCode: BatchErrorCode) => (abandoned ? { result: "expired" as const, errorCode: "timeout" as const } : { result, errorCode });
    const unknown = (result: "expired" | "failed", errorCode: BatchErrorCode): LlmBatchClosed => ({ status: "closed", ...end(result, errorCode), usage: { inputTokens: 0, outputTokens: 0, cost: t.maxCost }, costUnknown: true, finishedAt });
    if (o.kind === "costUnknown") return unknown(o.result, o.errorCode);
    const u = o.usage;
    // 料金表からモデルが消えた（送る前の確かめで起きないはず）・トークン数が0：費用は分からないとする
    if (p === undefined || u.outputTokens < 1 || u.inputTokens + u.cacheCreationInputTokens + u.cacheReadInputTokens < 1) return unknown("failed", "provider_error");
    const price = { inputCentsPer10MTok: p.inputCentsPer10MTok, outputCentsPer10MTok: p.outputCentsPer10MTok };
    const tokens = {
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      ...(u.cacheCreationInputTokens > 0 ? { cacheCreationInputTokens: u.cacheCreationInputTokens } : {}),
      ...(u.cacheReadInputTokens > 0 ? { cacheReadInputTokens: u.cacheReadInputTokens } : {}),
    };
    const cost = llmTokenCost(tokens, { yenPerUsd: this.#yen, ...price });
    if (cost === null) return unknown("failed", "provider_error");
    const usage = { ...tokens, cost };
    if (abandoned) return { status: "closed", result: "expired", errorCode: "timeout", usage, price, finishedAt };
    return { status: "closed", result: "collected", output: o.output, respondedModel: o.respondedModel, usage, price, finishedAt, ...(o.truncated ? { truncated: true as const } : {}) };
  }
}
