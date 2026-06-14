import { sourceLabel } from "@/lib/format";

const STYLES: Record<string, { bg: string; text: string }> = {
  pos: { bg: "bg-c-amber-soft", text: "text-c-amber" },
  ecommerce: { bg: "bg-c-emerald-soft", text: "text-c-emerald" },
  loyalty: { bg: "bg-c-sky-soft", text: "text-c-sky" },
};

export function SourceBadge({ source, size = "sm" }: { source: string; size?: "sm" | "md" }) {
  const s = STYLES[source] ?? { bg: "bg-[var(--neu-surface-2)]", text: "text-[var(--neu-text-muted)]" };
  const sizeClass = size === "md" ? "text-[11px] px-2.5 py-0.5" : "text-[10px] px-2 py-0.5";
  return (
    <span
      className={`inline-flex items-center rounded-md font-mono uppercase tracking-wider font-semibold ${sizeClass} ${s.bg} ${s.text}`}
    >
      {sourceLabel(source)}
    </span>
  );
}
