import { CHART_W, PRICE_H, VOLUME_H, type PriceChart } from "../view/market-chart";
import type { AuctionDay } from "../view/market";

const GAP = 12;

/** 値段の推移（線）と出来高（棒）。値つかずの日は線をつながず、下に▽の印を出す。表は同じ値の文字での表示 */
export function PriceChartView({ chart, days, color = "#00E5FF" }: { chart: PriceChart; days: readonly AuctionDay[]; color?: string }) {
  const H = PRICE_H + GAP + VOLUME_H;
  return (
    <div className="border-2 border-line bg-[#120826] p-3">
      <svg role="img" aria-label={chart.label} viewBox={`-4 -4 ${CHART_W + 8} ${H + 8}`} className="h-auto w-full">
        <line x1="0" x2={CHART_W} y1={chart.listedY} y2={chart.listedY} stroke="#8E78B4" strokeDasharray="4 4" />
        {chart.segments.map((s) => <polyline key={s} points={s} fill="none" stroke={color} strokeWidth="3" />)}
        {chart.dots.map((d) => <circle key={`${d.x}`} cx={d.x} cy={d.y} r="3.5" fill={color} />)}
        {chart.gaps.map((gx) => <path key={`g${gx}`} d={`M${gx - 5} ${PRICE_H - 12} L${gx + 5} ${PRICE_H - 12} L${gx} ${PRICE_H - 2} Z`} fill="none" stroke="#FF2E88" strokeWidth="1.5" />)}
        {chart.bars.map((b) => <rect key={b.seq} x={b.x - chart.barWidth / 2} y={PRICE_H + GAP + VOLUME_H - b.h} width={chart.barWidth} height={b.h} fill="#B9A6D6" opacity="0.7" />)}
      </svg>
      <div className="flex flex-wrap justify-between gap-x-4 font-num text-xs text-sub">
        <span>{chart.range ? `ついた価格の高値 ${chart.range.highText}　安値 ${chart.range.lowText}` : "ついた価格はありません（すべて値つかず）"}</span>
        <span>破線＝上場時の価格　▽＝値つかず　下の棒＝出来高</span>
      </div>
      <table className="mt-3 w-full border-collapse text-right font-num text-xs">
        <caption className="sr-only">板寄せの結果（最新が上）</caption>
        <thead><tr className="border-b border-line text-sub"><th className="p-1.5 text-left font-normal">日付</th><th className="p-1.5 font-normal">価格</th><th className="p-1.5 font-normal">出来高</th></tr></thead>
        <tbody>
          {[...days].reverse().map((d) => (
            <tr key={d.seq} className="border-b border-[#2A1745]">
              <td className="p-1.5 text-left">{d.dateText}</td>
              <td className="p-1.5" style={{ color: d.price === null ? "#FF2E88" : undefined }}>
                {d.price === null ? <>▽ {d.priceText}{d.carriedText && <span className="text-sub">（評価は前の価格 {d.carriedText}）</span>}</> : d.priceText}
              </td>
              <td className="p-1.5">{d.volumeText}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
