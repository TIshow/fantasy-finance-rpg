import { useId } from "react";
import type { Look } from "../view/characters";

// キャラの肖像（このサービスのオリジナルの図形。幅200×高さ240の座標）。外部の画像は使わない。
interface Art {
  label: string;
  main: string;
  bg: string;
  dot: string;
  jacket: string;
  hair: string;
  skin: string;
  skinShade: string;
  backHair: string;
  frontHair: string;
  collar: string;
  mouth: string;
  mark: string;
  slash: string;
  code: string;
  visor?: boolean;
  eyes?: boolean;
  implant?: boolean;
  beard?: boolean;
}

const EYE = "#0D0617";

const ART: Record<Look, Art> = {
  mia: {
    label: "ミア・ファイヴの肖像。シアンのバイザーと片側に流した髪。", main: "#00E5FF", bg: "#0B1A2E", dot: "#163452", jacket: "#1B1030", hair: "#1FD3E8", skin: "#F2D5C4", skinShade: "#B98A79",
    backHair: "M62 100 C58 60 90 58 112 62 C150 66 150 120 140 150 L132 150 C138 120 136 96 120 86 Z",
    frontHair: "M64 104 C64 70 96 62 120 70 C136 76 140 96 138 104 C120 82 92 86 70 112 Z",
    collar: "M62 186 L100 206 L138 186 L130 172 L100 190 L70 172 Z", mouth: "M92 136 Q100 140 108 136",
    mark: "M150 140 L164 140 L160 148 L146 148 Z", slash: "0,40 200,0 200,22 0,62", visor: true, code: "MA5 // TREND",
  },
  riva: {
    label: "リバ・ゼロの肖像。マゼンタのとがった髪と、右目の義眼。", main: "#FF2E88", bg: "#1E0A1E", dot: "#3D1239", jacket: "#120A1C", hair: "#FF2E88", skin: "#E9C1AE", skinShade: "#A9735F",
    backHair: "M70 92 L74 64 L84 82 L90 48 L100 76 L110 40 L118 74 L130 52 L130 92 Z",
    frontHair: "M68 98 C70 80 84 72 100 72 C118 72 130 80 132 98 C116 88 84 88 68 98 Z",
    collar: "M56 190 L82 176 L100 198 L118 176 L144 190 L140 200 L100 214 L60 200 Z", mouth: "M90 136 Q102 142 112 132",
    mark: "M44 150 L56 146 L54 160 L42 164 Z", slash: "0,150 200,110 200,128 0,168", eyes: true, implant: true, code: "REV // CONTRA",
  },
  holden: {
    label: "ホールデン翁の肖像。白い長髪とひげ、ライムのモノクル。", main: "#B6FF3B", bg: "#101A0C", dot: "#22361A", jacket: "#1A1424", hair: "#EDE6F7", skin: "#E2BFA8", skinShade: "#9C735E",
    backHair: "M60 98 C56 56 144 56 140 98 L146 170 L128 170 L126 110 L74 110 L72 170 L54 170 Z",
    frontHair: "M66 100 C70 74 130 74 134 100 C118 90 82 90 66 100 Z",
    collar: "M40 200 C60 176 80 172 100 186 C120 172 140 176 160 200 L150 210 C130 196 116 194 100 204 C84 194 70 196 50 210 Z", mouth: "M94 140 Q100 142 106 140",
    mark: "M100 80 L104 88 L100 96 L96 88 Z", slash: "0,0 60,0 0,60", eyes: true, implant: true, beard: true, code: "HOLD // LONG",
  },
  locked: {
    label: "まだ参戦していないAIのシルエット。", main: "#6B4E8F", bg: "#120A1C", dot: "#24163A", jacket: "#24163A", hair: "#24163A", skin: "#24163A", skinShade: "#3A2A55",
    backHair: "M66 96 C64 62 136 62 134 96 Z", frontHair: "M66 96 C70 76 130 76 134 96 Z",
    collar: "M70 180 L100 196 L130 180 Z", mouth: "M100 130 L100 130", mark: "M92 104 L108 104 L108 124 L92 124 Z", slash: "0,0 0,0 0,0", code: "??? // COMING",
  },
};

export function Portrait({ look, size = 200 }: { look: Look; size?: number }) {
  const a = ART[look];
  const dots = `dots-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  return (
    <svg role="img" aria-label={a.label} viewBox="0 0 200 240" width={size} height={Math.round(size * 1.2)} style={{ display: "block", maxWidth: "100%", height: "auto" }}>
      <defs>
        <pattern id={dots} width="8" height="8" patternUnits="userSpaceOnUse">
          <circle cx="2" cy="2" r="1.3" fill={a.dot} />
        </pattern>
      </defs>
      <rect width="200" height="240" fill={a.bg} />
      <rect width="200" height="240" fill={`url(#${dots})`} />
      <polygon points={a.slash} fill={a.main} opacity="0.9" />
      <path d="M14 240 C24 190 66 172 100 170 C134 172 176 190 186 240 Z" fill={a.jacket} />
      <path d={a.collar} fill={a.main} />
      <rect x="88" y="146" width="24" height="30" fill={a.skinShade} />
      <path d={a.backHair} fill={a.hair} />
      <ellipse cx="100" cy="112" rx="33" ry="40" fill={a.skin} />
      <path d={a.frontHair} fill={a.hair} />
      {a.visor && (
        <>
          <rect x="62" y="102" width="76" height="15" fill={a.main} />
          <rect x="62" y="108" width="76" height="2" fill={a.bg} opacity="0.6" />
        </>
      )}
      {a.eyes && (
        <>
          <path d="M76 110 Q84 104 92 110 Q84 114 76 110 Z" fill={EYE} />
          <path d="M108 110 Q116 104 124 110 Q116 114 108 110 Z" fill={EYE} />
        </>
      )}
      {a.implant && (
        <>
          <circle cx="116" cy="109" r="9" fill="none" stroke={a.main} strokeWidth="3" />
          <circle cx="116" cy="109" r="3" fill={a.main} />
          <path d="M125 109 L140 104" stroke={a.main} strokeWidth="2" />
        </>
      )}
      {a.beard && <path d="M72 124 C76 160 90 170 100 172 C110 170 124 160 128 124 C118 134 82 134 72 124 Z" fill={a.hair} />}
      <path d={a.mouth} fill="none" stroke={a.skinShade} strokeWidth="2.5" strokeLinecap="round" />
      <path d={a.mark} fill={a.main} />
      <rect x="0" y="216" width="200" height="24" fill={a.bg} opacity="0.85" />
      <text x="10" y="233" fill={a.main} fontFamily="var(--font-num), monospace" fontSize="13" letterSpacing="1.5">
        {a.code}
      </text>
    </svg>
  );
}
