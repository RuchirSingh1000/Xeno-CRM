import Link from "next/link";

export function EmptyState({
  title,
  description,
  actionLabel,
  actionHref,
  secondaryLabel,
  secondaryHref,
}: {
  title: string;
  description: string;
  actionLabel?: string;
  actionHref?: string;
  secondaryLabel?: string;
  secondaryHref?: string;
}) {
  return (
    <div className="neu-inset px-6 py-12 text-center animate-fade-in">
      <div className="mx-auto mb-3 h-12 w-12 rounded-full neu-raised-xs flex items-center justify-center">
        <span className="text-[var(--neu-text-subtle)] text-2xl leading-none">·</span>
      </div>
      <div className="text-lg font-semibold text-[var(--neu-text)]">{title}</div>
      <div className="text-sm text-[var(--neu-text-muted)] mt-1 max-w-md mx-auto leading-relaxed">
        {description}
      </div>
      {(actionLabel || secondaryLabel) && (
        <div className="mt-5 flex items-center justify-center gap-2">
          {actionLabel && actionHref && (
            <Link
              href={actionHref}
              className="neu-btn neu-btn-primary px-4 py-2 text-sm"
            >
              {actionLabel}
            </Link>
          )}
          {secondaryLabel && secondaryHref && (
            <Link href={secondaryHref} className="neu-btn px-4 py-2 text-sm">
              {secondaryLabel}
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
