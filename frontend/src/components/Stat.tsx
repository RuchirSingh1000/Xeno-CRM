"use client";

import { useCountUp } from "@/lib/useCountUp";

type Tone = "default" | "emerald" | "amber" | "sky" | "rose" | "violet" | "xeno";

const TONE_CLS: Record<Tone, string> = {
  default: "text-[var(--neu-text)]",
  emerald: "text-c-emerald",
  amber: "text-c-amber",
  sky: "text-c-sky",
  rose: "text-c-rose",
  violet: "text-c-violet",
  xeno: "text-xeno",
};

// Per-tone gradient backgrounds give each stat a subtle accent wash so the
// dashboard isn't a sea of plain white cards.
const TONE_ACCENT: Record<Tone, string> = {
  default: "",
  emerald: "accent-emerald",
  amber: "accent-amber",
  sky: "accent-sky",
  rose: "accent-rose",
  violet: "accent-violet",
  xeno: "accent-blue",
};

export function Stat({
  label,
  value,
  sub,
  tone = "default",
  animate = true,
}: {
  label: string;
  value: React.ReactNode;
  sub?: string;
  tone?: Tone;
  animate?: boolean;
}) {
  return (
    <div className={`neu-raised-sm ${TONE_ACCENT[tone]} px-4 py-3`}>
      <div className="text-[10px] uppercase tracking-wider text-[var(--neu-text-subtle)]">{label}</div>
      <div className={`text-lg font-semibold mt-0.5 tabular-nums ${TONE_CLS[tone]}`}>
        {animate && typeof value === "number" ? <AnimatedNumber value={value} /> : value}
      </div>
      {sub && <div className="text-[10px] text-[var(--neu-text-subtle)] mt-0.5">{sub}</div>}
    </div>
  );
}

function AnimatedNumber({ value }: { value: number }) {
  const v = useCountUp(value);
  return <>{Math.round(v).toLocaleString("en-IN")}</>;
}

/** Bigger hero variant for the Overview KPIs. */
export function HeroStat({
  label,
  value,
  sub,
  tone = "default",
}: {
  label: string;
  value: string | number;
  sub?: React.ReactNode;
  tone?: Tone;
}) {
  return (
    <div className={`neu-card ${TONE_ACCENT[tone]} p-6`}>
      <div className="text-[10px] uppercase tracking-widest text-[var(--neu-text-subtle)] mb-1.5">{label}</div>
      <div className={`text-3xl font-semibold tabular-nums tracking-tight ${TONE_CLS[tone]}`}>
        {typeof value === "number" ? <AnimatedNumber value={value} /> : value}
      </div>
      {sub && <div className="text-xs text-[var(--neu-text-muted)] mt-1.5">{sub}</div>}
    </div>
  );
}
