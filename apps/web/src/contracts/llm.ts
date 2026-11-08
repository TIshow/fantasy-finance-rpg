// 外側とのつなぎ目の契約：LLM（docs/EVENT_LOG.md §3.2 の agent.run）。型だけ。
// 入力・プロンプト・モデルの版・出力・費用を、agent.run に残せる形で返す。
// 費用の上限と試運転モード（注文を出さない）は policy で表す。提供元・モデルは #21 が未決なので決めない。
import type { Deciyen } from "../ledger/types";

export type LlmPurpose = "post" | "order";

export interface LlmModel {
  provider: string;
  modelId: string;
  /** 設定値。小数（temperature など）は文字列で持つ（EVENT_LOG §5.1） */
  settings: Readonly<Record<string, string>>;
}

export interface LlmPrompt {
  id: string;
  version: string;
  /** プロンプトの本文のハッシュ（agent.run に残す） */
  hash: string;
}

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * 費用の上限と試運転。
 * dailyCostLimit は 0 以上の安全な整数（0 は「呼ばない」で、停止に使える）。外れた値の policy では実装を作れない
 * （実装の作成時に RangeError）。実装は policy を複製して持ち、作ったあとに呼び出し側が書き換えても効かない。
 * dryRun が true の間は注文を出さない。runner には commitSheet を持たない OrderlessEventStore だけを渡す
 * （保証は runner の工場関数の仕事。event-store.ts の OrderlessEventStore を見る）。投稿と agent.run は書く
 * （費用と下書きを監査できるように）。
 */
export interface LlmPolicy {
  /** 1日（日本時間の暦日）に使ってよい費用の上限。0.1円単位の整数 */
  dailyCostLimit: Deciyen;
  dryRun: boolean;
}

export interface LlmRequest {
  agentId: string;
  purpose: LlmPurpose;
  model: LlmModel;
  prompt: LlmPrompt;
  /** 入力に渡したイベントの seq。リクエストはこれとプロンプトの版から決定論的に組み立てる */
  inputSeqs: readonly number[];
  /**
   * 実装はこのメッセージを加工せずそのまま送る（呼び出し側が計算したリクエストのハッシュが、実際に送った内容と一致するように）。
   * 提供元に送るのは model.settings と messages だけで、実装は何も足さない（ツールなし。EVENT_LOG §3.2）。
   */
  messages: readonly LlmMessage[];
  /**
   * この呼び出しの費用の上限（呼び出し側の見積もり。出力トークンの上限などから決める）。1 以上の安全な整数
   * （0 だと予約がなく、上限の保証が成り立たないため）。
   * NaN・負・小数などは、呼ばずに RangeError で断る（complete が拒否される。budget_exceeded ではない）。
   *
   * 予約：実装は、その日の使用済み（予約中を含む）＋maxCost が dailyCostLimit を超えるなら呼ばずに断り
   * （budget_exceeded）、そうでなければ maxCost を予約してから呼ぶ。判定と予約は原子的に行う
   * （同時に呼ばれても上限を超えない）。
   * 精算：呼び出しが終わったら、予約を実費に置き換える。実費が maxCost を超えても切り捨てず、そのまま
   * usage.cost と spent に記録する。usage.cost > maxCost は異常で、呼び出し側は運用者に知らせる。
   * 課金されたかどうか分からない失敗（timeout など）は、予約した maxCost を費用として残す。
   * 提供元の例外・通信断も同じ扱いで、complete は reject せず ok: false（provider_error か timeout）を返し、
   * maxCost を費用に残す（try/finally で予約を 0 に戻さない）。complete が reject するのは、maxCost の RangeError だけ。
   *
   * 費用の順序：#21 の換算（端数は切り上げ）を先に行い、その結果が 0 以上の安全な整数でないとき
   * （NaN・負・Infinity など）だけ maxCost を費用とする（上限を効かなくする方向には倒さない）。
   *
   * 提供元の呼び出しは直列にしない（複数の complete を並行に呼べる）。直列にするのは判定と予約だけ。
   */
  maxCost: Deciyen;
}

export interface LlmUsage {
  /** 数えられないとき（失敗・タイムアウトなど）は 0 */
  inputTokens: number;
  /** 数えられないとき（失敗・タイムアウトなど）は 0 */
  outputTokens: number;
  /**
   * この呼び出しの費用。0.1円単位の整数（端数は切り上げ）。失敗でも課金されたら入れる。
   * トークン数や外貨からの換算（為替・単価）は #21 で決める。
   */
  cost: Deciyen;
}

/**
 * agent.run の失敗に残すエラーコード。提供元のエラー文（リクエストIDなどを含みうる）は書かない（EVENT_LOG §1）。
 * invalid_output は、LlmPort ではなく呼び出し側（runner）が出力の形式を検査して決め、agent.run に残す。LlmPort は返さない。
 */
export type LlmErrorCode = "budget_exceeded" | "timeout" | "rate_limited" | "provider_error" | "invalid_output";

/** agent.run の「開始・終了時刻・出力・成否」にあたる部分。ハッシュの計算は呼び出し側が行う */
export type LlmResult =
  | {
      ok: true;
      output: string;
      usage: LlmUsage;
      /** 実際に応答したモデルの版（modelId が別名のとき、どの版が答えたかを残す） */
      respondedModel: string;
      startedAt: number;
      finishedAt: number;
    }
  | { ok: false; errorCode: LlmErrorCode; usage: LlmUsage; startedAt: number; finishedAt: number };

export interface LlmPort {
  readonly policy: LlmPolicy;
  /** day（YYYY-MM-DD、日本時間）に使った費用の合計（予約中の maxCost を含む） */
  spent(day: string): Promise<Deciyen>;
  /**
   * 1回呼ぶ。費用の暦日は startedAt（日本時間）で決める。上限を超えるなら、呼ばずに
   * errorCode: "budget_exceeded"（費用0）を返す。maxCost の検査は LlmRequest を見る。
   * Promise を返す口の RangeError は reject（同期で投げない）。NaN・Infinity も対象。
   */
  complete(request: LlmRequest): Promise<LlmResult>;
}

// ---- バッチの口（#179。lead の決定：本文を作る・送る・探す・受け取り・締めでの打ち切りに分ける） ----
// 依頼（前の営業日 16:35）と受け取り（翌朝 06:50・07:20）は別の実行なので、1回の complete では済まない。
// 予約と依頼の控えはイベント（EVENT_LOG §3.2）に残し、どの実行からも見えるようにする。順は次のとおり（2026-11-08 の lead の決定）。
//   ① llm.batch.submitted：提供元に送る前に書く予約（送る本文のハッシュ・予約した費用。提供元のバッチのIDは持たない）
//   ② 提供元に送る
//   ③ llm.batch.sent：①を指し、返ってきた提供元のバッチのIDを足す
//   llm.batch.closed：①を指して閉じる
// 課金されうる依頼は、送る前に必ず①として記録に載る。どこで止まっても、費用は記録から数えられる（閉じていない①は予約した費用）。
// この口はイベントを書かない。書くのは呼び出し側（runner）で、返した値をそのまま記録に入れる。

/** 料金。単価は1,000万トークンあたりのセント（整数。Gemini の半セントも表せる）。換算は src/events/llm-cost.ts の llmTokenCost */
export interface LlmBatchPrice {
  inputCentsPer10MTok: number;
  outputCentsPer10MTok: number;
}

/** バッチに依頼する1件。判断を使う取引日などを足す（記録の一意キー llmbatch:<agentId>:<tradingDate> になる） */
export interface LlmBatchRequest extends LlmRequest {
  /** 判断を使う取引日（YYYY-MM-DD）。submittedAt で締めがまだ来ていない最初の営業日 */
  tradingDate: string;
  /**
   * 依頼を決めた時刻（UNIXミリ秒）。runner が本文を作る前に時計から読み、①の記録の submittedAt に同じ値を使う。
   * 取引日と費用の暦日（日本時間）はこれで決まる。①はこの時刻から1時間以内に書く（LLM_RECORD_WINDOW_MS）
   */
  submittedAt: number;
  /**
   * 予約に使う料金と1ドルあたりの円（既定160）。料金は予約のときに一度だけ、submittedAt の時点の料金で決める
   * （Gemini は 2027-01-01 から値上げ。依頼が切り替えをまたいでも、閉じたときは同じ料金を使う）。
   * 閉じたときの料金と円は、これとちょうど同じ値（記録の検査が確かめる）
   */
  reservePrice: LlmBatchPrice & { yenPerUsd: number };
  /**
   * 予約の見積もりに使うトークン数の上限。maxCost は llmTokenCost(この2つ, reservePrice) 以上（上限として見積もる）。
   * 満たさなければ、本文を作らずに RangeError で reject
   */
  maxInputTokens: number;
  maxOutputTokens: number;
}

/**
 * 送る前に作った本文（prepare の結果）。runner は sentBodyHash と customId を①に書いてから、これを send に渡す。
 * body は提供元に実際に渡す本文（JSON。OpenAI は上げるファイルの中身）。sentBodyHash はその UTF-8 のバイト列の SHA-256（16進の小文字）。
 * send は body を加工せずに送る（記録のハッシュが、実際に送った本文と一致するように）
 */
export interface LlmPreparedBatch {
  readonly request: LlmBatchRequest;
  /**
   * 提供元で探せる、決まった名前（英数字・ハイフン・下線で1〜64文字）。agentId と tradingDate だけから作る
   * （記録の一意キー llmbatch:<agentId>:<tradingDate> を元にする）。②と③のあいだで止まったときに、find がこれで探す
   */
  readonly customId: string;
  readonly body: string;
  readonly sentBodyHash: string;
}

/** ①の記録から作り直せる予約の控え（src/events/llm-cost.ts の llmReservationOf）。find に渡す */
export interface LlmBatchReservation {
  /** ①（llm.batch.submitted）の seq。③と閉じる記録の batchSeq に入れる */
  batchSeq: number;
  agentId: string;
  provider: string;
  modelId: string;
  customId: string;
  /** 予約した費用（LlmRequest.maxCost） */
  maxCost: Deciyen;
  tradingDate: string;
  /** 依頼を決めた時刻（①の submittedAt） */
  submittedAt: number;
}

/**
 * 受け取りの控え。①と③の記録だけから作り直せる値で作る（翌朝の別の実行が受け取れるように。src/events/llm-cost.ts の llmTicketOf）。
 * 提供元ごとの追加の値（OpenAI の結果のファイルなど）は、batchId から引き直す。
 */
export interface LlmBatchTicket extends LlmBatchReservation {
  /** 提供元のバッチのID（③の batchId） */
  batchId: string;
}

/**
 * 送った結果（send）。
 * - ok：③（llm.batch.sent）に batchId を書く
 * - notCreated：バッチが作られていないと分かっている（提供元が断った、送る前に失敗した）。費用0。runner は result: "failed"・
 *   費用0・トークン数0・料金は reservePrice の llm.batch.closed で閉じる（③のない①だけが、費用0で閉じられる）
 * - billingUnknown：作られた（課金されうる）か分からない（timeout・通信断など）。runner は find で探す
 */
export type LlmSendResult =
  | { ok: true; batchId: string }
  | { ok: false; errorCode: Extract<LlmErrorCode, "timeout" | "rate_limited" | "provider_error">; notCreated: true }
  | { ok: false; errorCode: Extract<LlmErrorCode, "timeout" | "rate_limited" | "provider_error">; billingUnknown: true };

/**
 * 探した結果（find）。
 * - found：customId の名前で、この予約のバッチだと確かめられた。runner は③を書く
 * - not_found：見つからなかった、または見つけたものがこの予約のものか確かめられなかった。runner は result: "failed"・
 *   costUnknown: true・費用 maxCost の llm.batch.closed で閉じる（課金されたか分からないので、予約した費用を使ったものとして数える）
 * - unknown：一覧が読めなかった。あとで探し直す。取引日の締め（8:30）を過ぎても分からなければ、not_found と同じに閉じる
 */
export type LlmFindResult = { status: "found"; batchId: string } | { status: "not_found" } | { status: "unknown" };

/**
 * バッチが閉じた結果。llm.batch.closed の中身にあたる。
 * - collected：答えを受け取った。output と respondedModel がある
 * - expired：締め（8:30）で打ち切った、または提供元で期限が切れた
 * - failed：提供元で失敗した、結果が読めなかった
 * usage.cost は実際の費用（0.1円単位、端数は切り上げ）。llmTokenCost(usage のトークン数, reservePrice) ちょうど
 * （記録の検査が同じ計算で確かめる）。price は reservePrice の2つの単価をそのまま写したもの（違えば記録できない）。
 * 提供元が実際にはもっと安く請求しても（OpenAI の短い文脈の料金など）、予約の料金で数える（多めに数えるので安全側）。
 * 閉じたときに料金を選び直さない（提供元のバッチを作った時刻で選ぶと、値上げをまたいだ依頼が記録できなくなる）。
 * 費用が分からなければ、price を付けず、usage.cost に maxCost をそのまま入れ、costUnknown: true を付ける。
 * 送ったバッチ（③があるもの）は、費用0の failed では閉じられない（記録の検査が断る）。失敗の費用が0と分かっていても、costUnknown で閉じる。
 * 実費が maxCost を超えても切り捨てない。トークン数が分からなければ 0。
 */
export type LlmBatchClosed = { status: "closed"; usage: LlmBatchUsage; finishedAt: number } & (
  | { result: "collected"; output: string; respondedModel: string }
  | { result: "expired" | "failed"; errorCode: Extract<LlmErrorCode, "timeout" | "rate_limited" | "provider_error"> }
) &
  ({ price: LlmBatchPrice; costUnknown?: never } | { price?: never; costUnknown: true });

/** バッチの費用に数えるトークン数。キャッシュの欄（書き込みは入力の2倍、読み出しは入力の単価で数える）は、使わなければ省く */
export interface LlmBatchUsage extends LlmUsage {
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

export type LlmCollectResult = { status: "pending" } | LlmBatchClosed;

/**
 * まとめて依頼し、あとで受け取る口（各社のバッチ）。
 *
 * 費用の上限：その日の使用済み ＝ 閉じたバッチの実際の費用 ＋ 閉じていないバッチの予約（maxCost）。全提供元の合計で、
 * 記録だけから数える（src/events/llm-cost.ts の llmCostUsed）。暦日は依頼を決めた時刻（submittedAt）の日本時間の日付。
 * 記録は、①を書くときに、使用済み＋maxCost が1日の上限（LLM_DAILY_COST_LIMIT）を超えるなら断る。予約は記録にあるので、
 * この口は予約を持たない。追記は保管（EventStore）が1件ずつ行うので、複数の実行が同時に依頼しても上限を超えない。
 * 同じ AI・同じ取引日の①は一意キーで1つだけなので、2つの実行が同じ依頼を二重に送ることもない。
 *
 * runner の流れ：
 * 1. prepare で本文を作る（送らない）。policy.dailyCostLimit が記録の上限より小さければ、llmCostUsed ＋ maxCost がそれを超えるときは
 *    ①を書かずに agent.run の失敗（budget_exceeded、費用0）を書く
 * 2. ①（llm.batch.submitted）を書く。sentBodyHash・customId は prepare の結果、submittedAt・料金・トークン数の上限は request から。
 *    断られたら（上限を超える、一意キーが使用済み、取引日の違いなど）送らない。上限で断られたときは budget_exceeded の agent.run を書く
 * 3. send で送る。結果は LlmSendResult のとおりに記録する（③、費用0の failed、または find）
 * 4. ②と③のあいだで止まった場合：次の実行は、閉じていない①のうち③のないもの（openLlmBatches と llmSentOf）を、
 *    llmReservationOf で控えにして find で探す。found なら③を書き、そのあとはふつうに受け取る（締めを過ぎていれば abandon）。
 *    not_found なら費用 maxCost（costUnknown）の failed で閉じる。③が断られた（もう閉じていた）ら、そのバッチの取り消しを頼む
 * 5. 受け取り（collect）と締めでの打ち切り（abandon）は、①と③から作った控え（llmTicketOf）で行う
 *
 * 提供元の形への直し方（system の置き場所、設定の文字列から数への変換など）は、提供元ごとに決まった形にし、試験で確かめる。
 * settings と messages のほかは足さない（ツールなし。temperature は送らない。#179 の lead の決定）。
 * Promise を返す口の RangeError は reject（同期で投げない）。それ以外の失敗は reject せず、決まった結果で返す。
 * 提供元のエラー文（リクエストIDなどを含みうる）は返さない（EVENT_LOG §1）。
 */
export interface LlmBatchPort {
  /** dryRun でも依頼する（投稿は書くため）。dailyCostLimit は runner が流れの1で使う */
  readonly policy: LlmPolicy;
  /**
   * 送る本文を作り、そのハッシュと customId を返す。提供元には何も送らない。
   * maxCost の検査（LlmRequest と同じ。外れたら、または maxInputTokens・maxOutputTokens・reservePrice から出した費用より小さければ
   * RangeError で reject）
   */
  prepare(request: LlmBatchRequest): Promise<LlmPreparedBatch>;
  /** ①を書いたあとに、prepared.body をそのまま提供元に送る。batchSeq は①の seq（提供元の名前などに使ってよい） */
  send(prepared: LlmPreparedBatch, batchSeq: number): Promise<LlmSendResult>;
  /** ②と③のあいだで止まったあとに、提供元の一覧から customId の名前でバッチを探す。見つけても取り消さない */
  find(reservation: LlmBatchReservation): Promise<LlmFindResult>;
  /** 受け取り。終わっていなければ pending（予約はそのまま）。終わっていれば閉じた結果を返す */
  collect(ticket: LlmBatchTicket): Promise<LlmCollectResult>;
  /**
   * 締め（8:30）での打ち切り。提供元にバッチの取り消しを頼み、result: "expired"（errorCode: "timeout"）で閉じた結果を返す。
   * 取り消しのあとで課金されたかが分からないときは、費用を maxCost にして costUnknown: true を付ける（安全側）。
   * 取り消しの前に答えが出ていても、締めのあとなので使わない（費用は実際の値を入れてよい）。pending は返さない。
   */
  abandon(ticket: LlmBatchTicket): Promise<LlmBatchClosed>;
}
