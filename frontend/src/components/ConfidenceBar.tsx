export function ConfidenceBar({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const color =
    value >= 0.95 ? "bg-emerald-500" : value >= 0.85 ? "bg-sky-500" : value >= 0.75 ? "bg-amber-500" : "bg-red-500";
  return (
    <div className="flex items-center gap-2 min-w-[120px]">
      <div className="flex-1 h-1 rounded-full bg-neutral-800 overflow-hidden">
        <div className={`h-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[11px] font-mono text-neutral-400 tabular-nums w-9 text-right">{pct}%</span>
    </div>
  );
}
