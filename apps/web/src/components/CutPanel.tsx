import type { CSSProperties, ReactNode } from "react";

/** 斜めに角を切ったパネル。edge は外枠の色（AIごとの色）、cut は切り込みの大きさ(px) */
export function CutPanel({ edge, bg, cut = 28, children, style }: { edge: string; bg: string; cut?: number; children: ReactNode; style?: CSSProperties }) {
  const poly = (c: number) => `polygon(0 0, calc(100% - ${c}px) 0, 100% ${c}px, 100% 100%, ${c}px 100%, 0 calc(100% - ${c}px))`;
  return (
    <div style={{ background: edge, padding: 2, clipPath: poly(cut), ...style }}>
      <div style={{ background: bg, height: "100%", clipPath: poly(cut - 1) }}>{children}</div>
    </div>
  );
}
