// LlmPort の契約テスト（conformance.ts）が、実装の差し替えに使う「提供元の口」の型。
// platform は、自分の LlmPort 実装を作るときに、この口へ提供元の応答を差し込める形にしてテストを当てる。
// 実装は、この口に「費用を 0.1円単位で直接受け取る経路」を持つ必要がある（端数は切り上げる）。トークン数や外貨からの
// 換算（為替・単価）は #21 で決めるので、この契約テストでは検査しない。
import type { LlmErrorCode, LlmRequest } from "../../src/contracts";
import type { Deciyen } from "../../src/ledger/types";

/** 提供元の応答の代わり。cost: "unknown" は、課金されたか分からない失敗（timeout など） */
export type BackendReply =
  | { ok: true; output: string; cost: Deciyen; /** 実際に応答したモデルの版。LlmResult.respondedModel にそのまま出る */ respondedModel: string }
  | { ok: false; errorCode: Exclude<LlmErrorCode, "budget_exceeded" | "invalid_output">; cost: Deciyen | "unknown" };

/** 提供元を呼ぶ処理。テストは、解決を外から操作できる Promise を返して、呼び出し中の状態を確かめられる */
export type LlmBackend = (request: LlmRequest) => Promise<BackendReply>;
