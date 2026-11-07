import type { ModelLabel } from "../view/models";

/** モデル（提供元と版）と、LLM で考えるか規則で動くかの表示 */
export function ModelChip({ model, color }: { model: ModelLabel; color: string }) {
  return (
    <span className="flex min-w-0 flex-col gap-0.5 font-num text-[11px]">
      <span className="w-fit px-1.5 font-bold text-ground" style={{ background: model.kind === "llm" ? color : "#A98BD6" }}>{model.kindText}</span>
      {model.lastText && <span className="text-sub">{model.lastText}</span>}
      <span className="break-all text-soft">{model.text}</span>
      {model.changed && <span className="text-neon-pink">途中でモデルを変えています。過去の判断のモデルは、日ごとの判断に出ます</span>}
    </span>
  );
}
