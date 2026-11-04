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
 * dryRun が true の間は注文を出さない。runner には commitSheet を持たない OrderlessEventStore だけを渡し、
 * 型で禁止する。投稿と agent.run は書く（費用と下書きを監査できるように）。
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
  /** 実装はこのメッセージを加工せずそのまま送る（呼び出し側が計算したリクエストのハッシュが、実際に送った内容と一致するように） */
  messages: readonly LlmMessage[];
  /**
   * この呼び出しの費用の上限（呼び出し側の見積もり。出力トークンの上限などから決める）。
   * 実装は、その日の使用済み＋maxCost が dailyCostLimit を超えるなら呼ばずに断り、そうでなければ maxCost を予約してから呼ぶ。
   * 判定と予約は原子的に行う（同時に呼ばれても上限を超えない）。実際の費用は maxCost 以下に抑える
   */
  maxCost: Deciyen;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  /** この呼び出しの費用。0.1円単位の整数（端数は切り上げ）。失敗でも課金されたら入れる */
  cost: Deciyen;
}

/** agent.run の失敗に残すエラーコード。提供元のエラー文（リクエストIDなどを含みうる）は書かない（EVENT_LOG §1） */
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
  /** 1回呼ぶ。上限を超えるなら、呼ばずに errorCode: "budget_exceeded"（費用0）を返す */
  complete(request: LlmRequest): Promise<LlmResult>;
}
