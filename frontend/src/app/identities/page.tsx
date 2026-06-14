"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { Stat } from "@/components/Stat";
import { SourceBadge } from "@/components/SourceBadge";
import { SkeletonCard, SkeletonStat } from "@/components/Skeleton";
import {
  confirmFlagged,
  getFlagged,
  getIdentityDashboard,
  rejectFlagged,
  type FlaggedCustomer,
  type IdentityDashboard,
} from "@/lib/api";
import { useToast } from "@/components/Toast";
import { fmtNum, fmtPct } from "@/lib/format";

const RULE_LABEL: Record<string, { label: string; conf: string; tone: string; expl: string }> = {
  phone_exact: {
    label: "Phone exact",
    conf: "1.00",
    tone: "emerald",
    expl: "Exact match on normalized phone (last 10 digits).",
  },
  email_exact: {
    label: "Email exact",
    conf: "0.95",
    tone: "sky",
    expl: "Exact match on normalized email after lowercase + trim.",
  },
  phone8_name_city: {
    label: "Phone₈ + name + city",
    conf: "0.85",
    tone: "amber",
    expl: "Last 8 digits of phone match + fuzzy name (rapidfuzz ≥ 85) + same city.",
  },
  name_city_only: {
    label: "Name + city only",
    conf: "0.70",
    tone: "red",
    expl: "Fuzzy name (rapidfuzz ≥ 92) + same city. No phone or email anchor. Flagged.",
  },
  singleton: {
    label: "Singleton",
    conf: "1.00",
    tone: "neutral",
    expl: "Only one source row — nothing to merge.",
  },
};

export default function IdentitiesPage() {
  const [dash, setDash] = useState<IdentityDashboard | null>(null);
  const [flagged, setFlagged] = useState<FlaggedCustomer[]>([]);
  const [loading, setLoading] = useState(true);
  const [actingOn, setActingOn] = useState<number | null>(null);
  const toast = useToast();

  const refresh = async () => {
    const [d, f] = await Promise.all([getIdentityDashboard(), getFlagged(50)]);
    setDash(d);
    setFlagged(f);
  };

  useEffect(() => {
    refresh().finally(() => setLoading(false));
  }, []);

  const onConfirm = async (customerId: number) => {
    setActingOn(customerId);
    const r = await confirmFlagged(customerId);
    setActingOn(null);
    if (!r) {
      toast.error("Confirm failed");
      return;
    }
    toast.success("Merge confirmed", `${r.updated} weak identities promoted to 1.00 confidence.`);
    await refresh();
  };

  const onReject = async (customerId: number) => {
    setActingOn(customerId);
    const r = await rejectFlagged(customerId);
    setActingOn(null);
    if (!r) {
      toast.error("Reject failed");
      return;
    }
    toast.success(
      "Merge rejected",
      r.customer_removed
        ? `${r.deleted_identities} identities detached; canonical row removed (no strong anchors left).`
        : `${r.deleted_identities} weak identities detached; canonical row kept on stronger evidence.`,
    );
    await refresh();
  };

  if (loading) {
    return (
      <div className="min-h-screen animate-fade-in">
        <PageHeader eyebrow="Ingestion" title="Identity resolution" />
        <div className="px-8 py-8 max-w-6xl space-y-6">
          <section className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {Array.from({ length: 4 }).map((_, i) => <SkeletonStat key={i} />)}
          </section>
          <SkeletonCard rows={5} />
          <div className="grid lg:grid-cols-2 gap-3">
            <SkeletonCard rows={4} />
            <SkeletonCard rows={4} />
          </div>
        </div>
      </div>
    );
  }

  if (!dash || dash.canonical_total === 0) {
    return (
      <div className="min-h-screen">
        <PageHeader eyebrow="Ingestion" title="Identity resolution" />
        <div className="px-8 py-8 max-w-3xl">
          <EmptyState
            title="No resolution run yet"
            description="Ingest the three source CSVs and run resolution to collapse them into canonical customers with provenance."
            actionLabel="Go to Ingest"
            actionHref="/ingest"
          />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <PageHeader
        eyebrow="Ingestion"
        title="Resolution dashboard"
        description="How many staged rows collapsed into how many canonical customers, the rule mix that drove the merges, and the components flagged for review."
      />

      <div className="px-8 py-8 max-w-6xl space-y-8">
        {/* Top stats */}
        <section className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Stat label="Staged rows" value={fmtNum(dash.staged_total)} tone="violet" sub="across 3 sources" />
          <Stat
            label="Canonical customers"
            value={fmtNum(dash.canonical_total)}
            tone="emerald"
            sub="after merge"
          />
          <Stat
            label="Deduplication rate"
            value={fmtPct(dash.deduplication_rate)}
            tone="sky"
            sub="rows collapsed away"
          />
          <a
            href="#flagged-review"
            onClick={(e) => {
              if (dash.flagged_count === 0) {
                e.preventDefault();
                return;
              }
              e.preventDefault();
              document.getElementById("flagged-review")?.scrollIntoView({ behavior: "smooth", block: "start" });
            }}
            className={dash.flagged_count > 0 ? "block cursor-pointer hover:opacity-90 transition" : "block"}
            title={dash.flagged_count > 0 ? "Jump to the flagged-for-review list" : "Nothing flagged"}
          >
            <Stat
              label="Flagged"
              value={fmtNum(dash.flagged_count)}
              tone={dash.flagged_count > 0 ? "amber" : "emerald"}
              sub={dash.flagged_count > 0 ? "click to review →" : "no low-confidence merges"}
            />
          </a>
        </section>

        {/* Rule mix */}
        <section>
          <h2 className="text-[11px] uppercase tracking-widest text-neutral-500 mb-3">
            Rule chain
          </h2>
          <div className="rounded-lg border border-neutral-800 bg-neutral-900/30 p-5">
            <p className="text-xs text-neutral-400 mb-4 max-w-3xl leading-relaxed">
              Rules run in priority order. The strongest rule that pulls a row into a
              component wins, and that rule&apos;s confidence is what gets shown on the
              customer&apos;s identity row. Rules below 0.85 are flagged for review.
            </p>
            <div className="space-y-3">
              {Object.entries(dash.rule_mix).map(([rule, count]) => (
                <RuleRow
                  key={rule}
                  rule={rule}
                  count={count}
                  total={Object.values(dash.rule_mix).reduce((s, n) => s + n, 0)}
                />
              ))}
            </div>
          </div>
        </section>

        {/* Source coverage */}
        <section className="grid lg:grid-cols-2 gap-3">
          <div className="rounded-lg border border-neutral-800 bg-neutral-900/30 p-5">
            <h3 className="text-[11px] uppercase tracking-widest text-neutral-500 mb-3">
              Source coverage histogram
            </h3>
            <p className="text-xs text-neutral-500 mb-3">
              How many canonical customers were assembled from N source rows?
            </p>
            <div className="space-y-2">
              {dash.source_coverage.map((c) => {
                const max = Math.max(...dash.source_coverage.map((x) => x.count));
                const pct = max > 0 ? (c.count / max) * 100 : 0;
                return (
                  <div key={c.sources}>
                    <div className="flex items-center justify-between text-xs mb-1">
                      <span className="text-neutral-300">
                        {c.sources} source{c.sources === 1 ? "" : "s"}
                      </span>
                      <span className="font-mono text-neutral-400 tabular-nums">
                        {fmtNum(c.count)}
                      </span>
                    </div>
                    <div className="h-1.5 rounded-full bg-neutral-800 overflow-hidden">
                      <div
                        className="h-full bg-emerald-500/70"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="rounded-lg border border-neutral-800 bg-neutral-900/30 p-5">
            <h3 className="text-[11px] uppercase tracking-widest text-neutral-500 mb-3">
              Staged by source
            </h3>
            <p className="text-xs text-neutral-500 mb-3">
              Per-source row counts that entered resolution.
            </p>
            <div className="space-y-2">
              {Object.entries(dash.staged_by_source).map(([src, n]) => (
                <div
                  key={src}
                  className="flex items-center justify-between rounded-md border border-neutral-800 bg-neutral-950/40 px-3 py-2"
                >
                  <SourceBadge source={src} size="md" />
                  <span className="font-mono text-sm tabular-nums">{fmtNum(n)}</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Flagged customers list */}
        {flagged.length > 0 && (
          <section id="flagged-review" className="scroll-mt-24">
            <div className="flex items-baseline justify-between mb-3">
              <h2 className="text-[11px] uppercase tracking-widest text-neutral-500">
                Flagged for review
              </h2>
              <span className="text-xs text-neutral-500">
                Showing {flagged.length} of {fmtNum(dash.flagged_count)}
              </span>
            </div>
            <div className="rounded-lg border border-amber-500/20 bg-amber-500/[0.04] p-1">
              <table className="w-full text-sm">
                <thead className="text-[10px] uppercase tracking-wider text-neutral-500">
                  <tr>
                    <th className="text-left px-3 py-2">Master ID</th>
                    <th className="text-left px-3 py-2">Name</th>
                    <th className="text-left px-3 py-2">City</th>
                    <th className="text-left px-3 py-2">Phone</th>
                    <th className="text-left px-3 py-2">Email</th>
                    <th className="px-3 py-2 text-right">Operator action</th>
                  </tr>
                </thead>
                <tbody>
                  {flagged.map((c) => {
                    const busy = actingOn === c.id;
                    return (
                      <tr key={c.id} className="border-t border-neutral-800/60">
                        <td className="px-3 py-2 font-mono text-[11px] text-neutral-500">
                          {c.master_customer_id}
                        </td>
                        <td className="px-3 py-2">{c.full_name ?? "—"}</td>
                        <td className="px-3 py-2 text-neutral-400">{c.city ?? "—"}</td>
                        <td className="px-3 py-2 font-mono text-[11px] text-neutral-400">
                          {c.primary_phone ?? "—"}
                        </td>
                        <td className="px-3 py-2 font-mono text-[11px] text-neutral-400">
                          {c.primary_email ?? "—"}
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex items-center justify-end gap-1.5">
                            <Link
                              href={`/customers/${c.id}`}
                              className="text-[11px] text-[var(--neu-text-subtle)] hover:text-c-violet underline mr-2"
                              title="Open the canonical customer detail"
                            >
                              inspect
                            </Link>
                            <button
                              onClick={() => onConfirm(c.id)}
                              disabled={busy}
                              className="neu-btn px-2.5 py-1 text-[11px] text-c-emerald disabled:opacity-50"
                              title="Confirm this is a correct merge — lifts the weak rule to 1.00 confidence"
                            >
                              {busy ? "…" : "✓ Confirm"}
                            </button>
                            <button
                              onClick={() => onReject(c.id)}
                              disabled={busy}
                              className="neu-btn px-2.5 py-1 text-[11px] text-c-rose disabled:opacity-50"
                              title="Reject the merge — detaches the weak identities; deletes the canonical row if nothing strong remains"
                            >
                              {busy ? "…" : "✕ Reject"}
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function RuleRow({
  rule,
  count,
  total,
}: {
  rule: string;
  count: number;
  total: number;
}) {
  const info = RULE_LABEL[rule] ?? { label: rule, conf: "—", tone: "neutral", expl: "" };
  const pct = total > 0 ? (count / total) * 100 : 0;
  const colorCls: Record<string, string> = {
    emerald: "bg-emerald-500",
    sky: "bg-sky-500",
    amber: "bg-amber-500",
    red: "bg-red-500",
    neutral: "bg-neutral-600",
  };
  return (
    <div className="rounded-md border border-neutral-800 bg-neutral-950/40 p-3">
      <div className="flex items-baseline justify-between mb-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{info.label}</span>
          <span className="text-[10px] font-mono uppercase tracking-wider text-neutral-500">
            conf {info.conf}
          </span>
          {info.tone === "red" && (
            <span className="text-[10px] uppercase tracking-wider text-amber-300">flagged</span>
          )}
        </div>
        <span className="font-mono text-xs text-neutral-400 tabular-nums">
          {fmtNum(count)} ({pct.toFixed(1)}%)
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-neutral-800 overflow-hidden mb-2">
        <div className={`h-full ${colorCls[info.tone]}`} style={{ width: `${pct}%` }} />
      </div>
      <p className="text-[11px] text-neutral-500">{info.expl}</p>
    </div>
  );
}
