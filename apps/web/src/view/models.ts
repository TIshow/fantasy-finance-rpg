// AIのモデル（提供元と版）の表示。判断の記録（agent.run）の model を読むだけ。
// 規則で動くAIは provider が "rule"。LLM の提供元は anthropic・openai・google。それ以外の値は、書かれたまま出す。
import { formatJst, formatMonthDay } from "./format";
import type { View } from "./types";

export type ModelKind = "llm" | "rule" | "script" | "other";

export interface ModelLabel {
  kind: ModelKind;
  /** "LLMで考える" など、カードに出す短い説明 */
  kindText: string;
  /** "Anthropic" など。知らない提供元は記録のまま */
  providerText: string;
  modelId: string;
  /** "Anthropic · モデルID" */
  text: string;
  /** "最後の判断（11/09）のモデル"。AIごとの表示でだけ入る。1件ごとの判断のモデルでは null */
  lastText: string | null;
  /** 成功した判断の途中で、モデルが変わったことがあるか */
  changed: boolean;
}

const PROVIDERS: Record<string, { name: string; kind: ModelKind; kindText: string }> = {
  anthropic: { name: "Anthropic", kind: "llm", kindText: "LLMで考える" },
  openai: { name: "OpenAI", kind: "llm", kindText: "LLMで考える" },
  google: { name: "Google", kind: "llm", kindText: "LLMで考える" },
  rule: { name: "規則", kind: "rule", kindText: "規則で動く（比べる基準）" },
  fixture: { name: "台本", kind: "script", kindText: "台本どおり（表示確認用）" },
};

/** "constructor" などを提供元として扱わないため、own のキーだけを見る */
export function labelModel(provider: string, modelId: string): ModelLabel {
  const known = Object.hasOwn(PROVIDERS, provider) ? PROVIDERS[provider]! : null;
  const providerText = known?.name ?? provider;
  return { kind: known?.kind ?? "other", kindText: known?.kindText ?? "提供元は未登録", providerText, modelId, text: `${providerText} · ${modelId}`, lastText: null, changed: false };
}

/** AIごとの、最後に成功した判断のモデル（失敗した判断は数えない）。判断の記録がないAIは含まない */
export function modelsOf(view: View): Map<string, ModelLabel> {
  return new Map(view.models.map((m) => [m.agentId, { ...labelModel(m.provider, m.modelId), lastText: `最後の判断（${formatMonthDay(formatJst(m.at).slice(0, 10))}）のモデル`, changed: m.changed }] as const));
}

/** 判断の記録の番号（runSeq）から、そのときのモデル。記録がなければ null */
export function runModelOf(view: View, runSeq: number | null): ModelLabel | null {
  if (runSeq === null) return null;
  const r = view.runs.find((x) => x.seq === runSeq);
  return r ? labelModel(r.provider, r.modelId) : null;
}
