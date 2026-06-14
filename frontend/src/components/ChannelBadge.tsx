const STYLES: Record<string, { bg: string; text: string }> = {
  whatsapp: { bg: "bg-c-emerald-soft", text: "text-c-emerald" },
  sms: { bg: "bg-c-sky-soft", text: "text-c-sky" },
  email: { bg: "bg-c-violet-soft", text: "text-c-violet" },
  rcs: { bg: "bg-c-amber-soft", text: "text-c-amber" },
};

const LABELS: Record<string, string> = {
  whatsapp: "WhatsApp",
  sms: "SMS",
  email: "Email",
  rcs: "RCS",
};

export function ChannelBadge({ channel, size = "sm" }: { channel: string; size?: "sm" | "md" }) {
  const s = STYLES[channel] ?? { bg: "bg-[var(--neu-surface-2)]", text: "text-[var(--neu-text-muted)]" };
  const sizeClass =
    size === "md" ? "text-[11px] px-2.5 py-0.5" : "text-[10px] px-2 py-0.5";
  return (
    <span
      className={`inline-flex items-center rounded-md font-mono uppercase tracking-wider font-semibold ${sizeClass} ${s.bg} ${s.text}`}
    >
      {LABELS[channel] ?? channel}
    </span>
  );
}
