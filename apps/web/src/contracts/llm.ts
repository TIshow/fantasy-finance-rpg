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

// ---- バッチの口（#179。lead の決定：依頼・受け取り・締めでの打ち切りに分ける） ----
// 依頼（前の営業日 16:35）と受け取り（翌朝 06:50・07:20）は別の実行なので、1回の complete では済まない。
// 予約と依頼の控えはイベント（llm.batch.submitted・llm.batch.closed。EVENT_LOG §3.2）に残し、どの実行からも見えるようにする。
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
   * 依頼を決めた時刻（UNIXミリ秒）。runner が送る直前に時計から読み、送る前の確かめ（EventLog.canAppend）と記録に同じ値を使う。
   * 取引日と費用の暦日（日本時間）はこれで決まる。記録はこの時刻から1時間以内に書く（LLM_RECORD_WINDOW_MS）
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
   * 満たさなければ、送らずに RangeError で reject
   */
  maxInputTokens: number;
  maxOutputTokens: number;
}

/**
 * 依頼の控え。llm.batch.submitted の記録だけから作り直せる値で作る（翌朝の別の実行が受け取れるように。llmTicketOf）。
 * 提供元ごとの追加の値（OpenAI の結果のファイルなど）は、batchId から引き直す。
 */
export interface LlmBatchTicket {
  agentId: string;
  provider: string;
  modelId: string;
  /** 提供元のバッチのID */
  batchId: string;
  /** バッチの中の1件のID（英数字・ハイフン・下線で1〜64文字） */
  customId: string;
  /** 予約した費用（LlmRequest.maxCost） */
  maxCost: Deciyen;
  tradingDate: string;
  /** 依頼を決めた時刻（LlmBatchRequest.submittedAt をそのまま）。記録では llm.batch.submitted の submittedAt */
  submittedAt: number;
}

/**
 * 依頼の結果。sentBodyHash は、提供元に実際に渡した本文（JSON。OpenAI は上げたファイルの中身）のバイト列の SHA-256（16進の小文字）。
 * ok: false のうち、
 * - budget_exceeded：送っていない。費用0。llm.batch.submitted は書かない（agent.run の失敗だけを書く）
 * - billingUnknown: true：バッチが作られた（課金されうる）か分からない。呼び出し側は batchId を null にした llm.batch.submitted を書き、
 *   すぐに result: "failed"・費用 maxCost の llm.batch.closed で閉じる（予約を使ったものとして数える。安全側）。自動で再試行しない
 * - billingUnknown がないもの：作られていないと分かっている（提供元が断った）。費用0。llm.batch.submitted は書かない
 */
export type LlmSubmitResult =
  | { ok: true; ticket: LlmBatchTicket; sentBodyHash: string }
  | { ok: false; errorCode: "budget_exceeded"; submittedAt: number }
  | { ok: false; errorCode: Extract<LlmErrorCode, "timeout" | "rate_limited" | "provider_error">; billingUnknown?: true; sentBodyHash: string; submittedAt: number };

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
 * 費用の上限：その日の使用済み ＝ 閉じたバッチの実際の費用 ＋ 閉じていないバッチの予約（maxCost）。全提供元の合計。
 * 暦日は依頼した時刻の日本時間の日付。数え方は src/events/llm-cost.ts の llmCostUsed と同じにする（記録から誰でも確かめられるように）。
 * 暦日は依頼を決めた時刻（submittedAt）の日本時間の日付で、記録した日・閉じた日ではない。
 * 予約は llm.batch.submitted の記録で残す。依頼してから呼び出し側がそれを書くまでのあいだの予約は、実装が自分で持って数える。
 * 送る前の確かめ（呼び出し側の義務）：runner は submit を呼ぶ前に、送ったあとに書く llm.batch.submitted の記録を、
 * recordedAt と submittedAt を request.submittedAt に、batchId を null、sentBodyHash を仮の値（0 を64個）にして作り、
 * 自分の EventLog の canAppend に通す。通らなければ送らない（一意キーが使用済み、取引日が submittedAt から決まる日と違う、
 * 登録していないAI、祝日の一覧の範囲の外など。送ったあとに記録が断られて、課金されたのに記録がない依頼ができないように）。
 * 通ったら、submit の結果の ticket と sentBodyHash を入れた記録を、submittedAt から1時間以内に書く。
 * 同じ日の依頼を、複数の実行から同時に行わない（毎日の実行は1つずつ動かす前提。記録には提供元のバッチのIDが要るので、
 * 送る前に記録で予約することはできず、実行をまたいだ判定と予約は原子的にできないため）。
 * 依頼したのに記録を書く前に止まった場合に備え、同じ AI・同じ取引日の依頼をやり直す前に、提供元の一覧で作られていないかを確かめる。
 * 記録にないバッチが見つかった、または一覧からは分からなかったとき（呼び出し側の義務。#179）：
 * - 送り直さない。batchId を null にした llm.batch.submitted を書き、すぐに result: "failed"・costUnknown: true・費用 maxCost の
 *   llm.batch.closed で閉じる（billingUnknown のときと同じ。課金されたかもしれない分を予約の費用で数える。安全側）。
 *   一意キー llmbatch:<AIのID>:<取引日> を使うので、その日はもう依頼しない
 * - この組の submittedAt と recordedAt は、元の依頼の時刻ではなく、やり直しの実行の時刻にする（記録は submittedAt から1時間以内しか
 *   書けないため）。費用の暦日はやり直した日になる。tradingDate は、その時刻で締めがまだ来ていない最初の営業日（記録の検査の決まり）。
 *   sentBodyHash は、やり直しの実行で組み立てた本文のハッシュ（元の依頼と同じとは限らない。この組の答えは使わない）
 * - 書く前に、ほかの依頼と同じく canAppend で確かめる。通らなければ（その日のキーが使用済みなど）、記録は書かず、取り消しだけ頼む
 * - 見つかったバッチは、提供元に取り消しを頼む。あとで作られていたと分かったバッチ（batchId を null にしたもの）も同じ。
 * 提供元の形への直し方（system の置き場所、設定の文字列から数への変換など）は、提供元ごとに決まった形にし、試験で確かめる。
 * settings と messages のほかは足さない（ツールなし。temperature は送らない。#179 の lead の決定）。
 * Promise を返す口の RangeError は reject（同期で投げない）。それ以外の失敗は reject せず、決まった結果で返す。
 * 提供元のエラー文（リクエストIDなどを含みうる）は返さない（EVENT_LOG §1）。
 */
export interface LlmBatchPort {
  readonly policy: LlmPolicy;
  /** day（YYYY-MM-DD、日本時間）の使用済み。記録にある分と、まだ記録されていない自分の予約の合計 */
  spent(day: string): Promise<Deciyen>;
  /**
   * 依頼。maxCost の検査（LlmRequest と同じ。外れたら、または maxInputTokens・maxOutputTokens・reservePrice から出した費用より小さければ
   * RangeError で reject）→ spent(submittedAt の日)＋maxCost が
   * dailyCostLimit を超えるなら送らずに budget_exceeded → 予約して提供元に送る。dryRun でも依頼する（投稿は書くため）。
   */
  submit(request: LlmBatchRequest): Promise<LlmSubmitResult>;
  /** 受け取り。終わっていなければ pending（予約はそのまま）。終わっていれば閉じた結果を返す */
  collect(ticket: LlmBatchTicket): Promise<LlmCollectResult>;
  /**
   * 締め（8:30）での打ち切り。提供元にバッチの取り消しを頼み、result: "expired"（errorCode: "timeout"）で閉じた結果を返す。
   * 取り消しのあとで課金されたかが分からないときは、費用を maxCost にして costUnknown: true を付ける（安全側）。
   * 取り消しの前に答えが出ていても、締めのあとなので使わない（費用は実際の値を入れてよい）。pending は返さない。
   */
  abandon(ticket: LlmBatchTicket): Promise<LlmBatchClosed>;
}
