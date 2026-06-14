/** Hand-rolled vertical bar chart with explicit track heights.
 *
 * Why explicit heights instead of `flex-1`: when the parent row uses
 * `items-end` (so bars sit on a shared baseline), flex children collapse to
 * content height — `flex-1` then has nothing to fill and the bar track ends
 * up 0px tall. We reserve fixed pixels for the value label + category label
 * and give the track whatever's left.
 */

export type BarDatum = {
  label: string;
  value: number;
  color?: string;
  valueLabel?: string;
};

type Props = {
  data: BarDatum[];
  height?: number;
  maxValue?: number;
  valueFormatter?: (v: number) => string;
  ariaLabel?: string;
};

export function BarChart({
  data,
  height = 200,
  maxValue,
  valueFormatter = (v) => v.toLocaleString("en-IN"),
  ariaLabel = "Bar chart",
}: Props) {
  if (data.length === 0) {
    return (
      <div className="text-xs text-[var(--neu-text-subtle)] flex items-center justify-center" style={{ height }}>
        No data
      </div>
    );
  }
  const max = maxValue ?? Math.max(...data.map((d) => d.value), 1);
  const VALUE_LABEL_H = 16;
  const CATEGORY_LABEL_H = 22;
  const trackHeight = Math.max(40, height - VALUE_LABEL_H - CATEGORY_LABEL_H - 8);
  return (
    <div role="img" aria-label={ariaLabel}>
      <div className="flex gap-3 items-stretch" style={{ height }}>
        {data.map((d, i) => {
          // Honor the true ratio; tiny non-zero values still get a 1px floor so
          // the sliver is visible without distorting comparisons.
          const rawPct = max > 0 ? (d.value / max) * 100 : 0;
          const pct = d.value > 0 ? Math.max(0.5, rawPct) : 0;
          const color = d.color ?? "var(--xeno-blue)";
          return (
            <div key={i} className="flex-1 flex flex-col items-center gap-1 min-w-0">
              <div
                className="text-[10px] font-mono text-[var(--neu-text-muted)] tabular-nums leading-none flex items-end justify-center"
                style={{ height: VALUE_LABEL_H }}
              >
                {d.valueLabel ?? valueFormatter(d.value)}
              </div>
              <div
                className="w-full neu-inset-sm rounded-md relative overflow-hidden"
                style={{ height: trackHeight }}
              >
                <div
                  className="bar-fill absolute bottom-0 left-0 right-0 rounded-md"
                  style={{
                    height: `${pct}%`,
                    background: `linear-gradient(180deg, ${color}, color-mix(in srgb, ${color}, black 25%))`,
                    boxShadow: `0 0 14px color-mix(in srgb, ${color}, transparent 55%)`,
                  }}
                />
              </div>
              <div
                className="text-[10px] text-[var(--neu-text-subtle)] truncate w-full text-center leading-tight flex items-start justify-center pt-0.5"
                style={{ height: CATEGORY_LABEL_H }}
                title={d.label}
              >
                {d.label}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
