/** Hand-rolled SVG donut chart — neumorphism-friendly, no chart library.
 *
 * Each slice is an SVG arc. Inner padding leaves a hole for a centered label
 * (total / largest / whatever the caller wants to render in the middle).
 */

export type DonutSlice = {
  label: string;
  value: number;
  color: string; // CSS color (e.g. var(--c-emerald))
};

type Props = {
  data: DonutSlice[];
  size?: number;
  thickness?: number;
  centerLabel?: React.ReactNode;
  ariaLabel?: string;
};

export function DonutChart({
  data,
  size = 180,
  thickness = 28,
  centerLabel,
  ariaLabel = "Distribution chart",
}: Props) {
  const total = data.reduce((s, d) => s + d.value, 0);
  const r = size / 2 - thickness / 2;
  const cx = size / 2;
  const cy = size / 2;

  if (total === 0) {
    return (
      <div
        className="flex items-center justify-center text-xs text-[var(--neu-text-subtle)]"
        style={{ width: size, height: size }}
      >
        No data
      </div>
    );
  }

  let acc = 0;
  const arcs = data.map((slice) => {
    const startAngle = (acc / total) * Math.PI * 2;
    acc += slice.value;
    const endAngle = (acc / total) * Math.PI * 2;
    const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;
    const x1 = cx + r * Math.sin(startAngle);
    const y1 = cy - r * Math.cos(startAngle);
    const x2 = cx + r * Math.sin(endAngle);
    const y2 = cy - r * Math.cos(endAngle);
    return {
      d: `M ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2}`,
      color: slice.color,
      label: slice.label,
      value: slice.value,
    };
  });

  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} role="img" aria-label={ariaLabel}>
        {/* Track */}
        <circle
          cx={cx}
          cy={cy}
          r={r}
          fill="none"
          stroke="var(--neu-shadow-dark-soft)"
          strokeWidth={thickness}
          opacity={0.3}
        />
        {/* Slices */}
        {arcs.map((a, i) => (
          <path
            key={i}
            d={a.d}
            stroke={a.color}
            strokeWidth={thickness}
            fill="none"
            strokeLinecap="butt"
          >
            <title>
              {a.label}: {a.value}
            </title>
          </path>
        ))}
      </svg>
      {centerLabel && (
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          {centerLabel}
        </div>
      )}
    </div>
  );
}

/** Companion legend for the donut. */
export function DonutLegend({ data }: { data: DonutSlice[] }) {
  const total = data.reduce((s, d) => s + d.value, 0);
  return (
    <ul className="space-y-1.5 text-xs">
      {data.map((d) => {
        const pct = total > 0 ? (d.value / total) * 100 : 0;
        return (
          <li key={d.label} className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <span
                className="h-2.5 w-2.5 rounded-sm shrink-0"
                style={{ background: d.color }}
                aria-hidden="true"
              />
              <span className="text-[var(--neu-text-muted)] truncate">{d.label}</span>
            </div>
            <span className="font-mono text-[var(--neu-text)] tabular-nums shrink-0">
              {d.value} ({pct.toFixed(1)}%)
            </span>
          </li>
        );
      })}
    </ul>
  );
}
