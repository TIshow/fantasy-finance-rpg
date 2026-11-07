// AIのモデル（提供元と版）の表示。判断の記録（agent.run）の model を読むだけ。
// 規則で動くAIは provider が "rule"。LLM の提供元は anthropic・openai・google。それ以外の値は、書かれたまま出す。
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
  return { kind: known?.kind ?? "other", kindText: known?.kindText ?? "提供元は未登録", providerText, modelId, text: `${providerText} · ${modelId}` };
}

/** AIごとの、最後の判断の記録のモデル。判断の記録がないAIは含まない */
export function modelsOf(view: View): Map<string, ModelLabel> {
  return new Map(view.models.map((m) => [m.agentId, labelModel(m.provider, m.modelId)] as const));
}
