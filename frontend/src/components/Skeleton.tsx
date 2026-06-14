export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-shimmer ${className}`} />;
}

export function SkeletonRow({ widths }: { widths: string[] }) {
  return (
    <div className="flex items-center gap-3">
      {widths.map((w, i) => (
        <Skeleton key={i} className={`h-3 ${w}`} />
      ))}
    </div>
  );
}

export function SkeletonStat() {
  return (
    <div className="neu-raised px-4 py-3 space-y-2">
      <Skeleton className="h-2 w-20" />
      <Skeleton className="h-6 w-20" />
    </div>
  );
}

export function SkeletonCard({ rows = 3 }: { rows?: number }) {
  return (
    <div className="neu-raised p-5 space-y-3">
      <Skeleton className="h-3 w-32" />
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-3 w-full" />
      ))}
    </div>
  );
}
