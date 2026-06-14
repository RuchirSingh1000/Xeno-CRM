"use client";

/** Webhook reliability page.
 *
 * Translates the receiver's defensive design into demoable numbers. The brief
 * asks how we handle "volume, ordering, retries, failures" — this page is the
 * answer in one screen, with a paragraph of plain English per guarantee.
 */

import { useEffect, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { Stat } from "@/components/Stat";
import { SkeletonCard, SkeletonStat } from "@/components/Skeleton";
import { EmptyState } from "@/components/EmptyState";
import {
  getReliabilitySummary,
  listFailedDeliveries,
  replayDelivery,
  simulateWebhookFailure,
  type ReliabilitySummary,
  type FailedDelivery,
} from "@/lib/api";
import { fmtNum, fmtPct } from "@/lib/format";
import { useToast } from "@/components/Toast";

export default function ReliabilityPage() {
  const [summary, setSummary] = useState<ReliabilitySummary | null>(null);
  const [failed, setFailed] = useState<FailedDelivery[]>([]);
  const [loading, setLoading] = useState(true);
  const [replaying, setReplaying] = useState<number | null>(null);
  const toast = useToast();

  const refresh = async () => {
    setLoading(true);
    const [s, f] = await Promise.all([getReliabilitySummary(), listFailedDeliveries(25)]);
    setSummary(s);
    setFailed(f.deliveries);
    setLoading(false);
  };

  useEffect(() => {
    refresh();
  }, []);

  const onReplay = async (id: number) => {
    setReplaying(id);
    const r = await replayDelivery(id);
    setReplaying(null);
    if (!r) {
      toast.error("Replay failed", "Network error.");
      return;
    }
    toast.success(`Replay outcome: ${r.outcome}`, r.error ?? "Same idempotency guard prevented double-application.");
    await refresh();
  };

  if (loading || !summary) {
    return (
      <div className="min-h-screen animate-fade-in">
        <PageHeader eyebrow="Engagement" title="Webhook reliability" />
        <div className="px-8 py-8 max-w-6xl space-y-6">
          <section className="grid grid-cols-2 md:grid-cols-5 gap-3">
            {Array.from({ length: 5 }).map((_, i) => <SkeletonStat key={i} />)}
          </section>
          <SkeletonCard rows={5} />
        </div>
      </div>
    );
  }

  const s = summary;
  const oooRate = s.total_deliveries > 0 ? s.ordering.out_of_order_events / s.total_deliveries : 0;

  return (
    <div className="min-h-screen animate-fade-in">
      <PageHeader
        eyebrow="Engagement"
        title="Webhook reliability"
        description='The channel simulator is a separate service that calls back asynchronously. This page shows how the receiver handles "volume, ordering, retries, and failures" — the four things the brief asks about. Every number maps to a code-level guarantee.'
        actions={
          <div className="flex items-center gap-2">
            <button
              onClick={async () => {
                const r = await simulateWebhookFailure("transient");
                if (r) {
                  toast.success("Simulated failure injected", `Delivery #${r.delivery_id} created. Click Replay below.`);
                  await refresh();
                } else {
                  toast.error("Couldn't inject failure");
                }
              }}
              className="neu-btn px-3 py-1.5 text-sm"
              title="Inject a fake failed delivery so you can demo the replay flow"
            >
              + Simulate failure
            </button>
            <button onClick={refresh} className="neu-btn px-3 py-1.5 text-sm">
              Refresh
            </button>
          </div>
        }
      />

      <div className="px-8 py-8 max-w-6xl space-y-6">
        {/* Top strip */}
        <section className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <Stat label="Total deliveries" value={fmtNum(s.total_deliveries)} tone="emerald" sub="webhook POSTs received" />
          <Stat label="Processed cleanly" value={fmtNum(s.by_status.processed)} tone="sky" sub={`${fmtPct(s.by_status.processed / (s.total_deliveries || 1))} of total`} />
          <Stat label="Duplicates absorbed" value={fmtNum(s.idempotency.duplicates_absorbed)} tone="violet" sub="idempotency saved double-counts" />
          <Stat label="Out-of-order events" value={fmtNum(s.ordering.out_of_order_events)} tone="amber" sub={`${fmtPct(oooRate)} — reducer handled`} />
          <Stat label="Failed (replayable)" value={fmtNum(s.retries.failed_pending_replay)} tone={s.retries.failed_pending_replay > 0 ? "rose" : "emerald"} sub="ready for operator action" />
        </section>

        {/* Guarantee cards */}
        <section className="grid lg:grid-cols-2 gap-4">
          <GuaranteeCard
            label="Idempotency"
            value={`${fmtNum(s.idempotency.duplicates_absorbed)} duplicates`}
            color="violet"
            note={s.idempotency.note}
          />
          <GuaranteeCard
            label="Ordering"
            value={`${fmtNum(s.ordering.out_of_order_events)} out-of-order`}
            color="amber"
            note={s.ordering.note}
          />
          <GuaranteeCard
            label="HMAC security"
            value={`${fmtNum(s.security.rejected_invalid_signature)} rejected`}
            color="emerald"
            note={s.security.note}
          />
          <GuaranteeCard
            label="Retries & replay"
            value={`${fmtNum(s.retries.total_retries)} retries · ${fmtNum(s.retries.failed_pending_replay)} pending`}
            color="sky"
            note={s.retries.note}
          />
        </section>

        {/* Throughput */}
        <section className="neu-card p-5">
          <div className="text-[10px] uppercase tracking-wider text-c-violet font-semibold mb-1">Throughput</div>
          <div className="text-2xl font-semibold tabular-nums text-c-violet mb-2">
            {fmtNum(s.throughput.events_last_hour)} <span className="text-sm text-[var(--neu-text-subtle)]">events / last hour</span>
          </div>
          <p className="text-xs text-[var(--neu-text-muted)] leading-relaxed">{s.throughput.note}</p>
        </section>

        {/* Failed deliveries with replay */}
        <section>
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="text-[11px] uppercase tracking-widest text-[var(--neu-text-subtle)] font-semibold">
              Failed deliveries (replayable)
            </h2>
            <span className="text-[10px] text-[var(--neu-text-subtle)]">
              same idempotency guard prevents double-apply on replay
            </span>
          </div>
          {failed.length === 0 ? (
            <EmptyState
              title="No failed deliveries"
              description="Either nothing has failed yet, or every failure was already resolved. The receiver retries before parking; only true poison messages land here."
            />
          ) : (
            <div className="neu-card overflow-hidden">
              <table className="w-full text-sm">
                <thead className="text-[10px] uppercase tracking-wider text-[var(--neu-text-subtle)]">
                  <tr>
                    <th className="text-left px-4 py-2">#</th>
                    <th className="text-left px-4 py-2">Status</th>
                    <th className="text-left px-4 py-2">Retries</th>
                    <th className="text-left px-4 py-2">Last error</th>
                    <th className="text-left px-4 py-2">Received</th>
                    <th className="text-right px-4 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {failed.map((d) => (
                    <tr key={d.id} className="border-t border-[var(--neu-shadow-dark-soft)]">
                      <td className="px-4 py-2 font-mono text-[11px] text-[var(--neu-text-subtle)]">{d.id}</td>
                      <td className="px-4 py-2">
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-c-rose">{d.status}</span>
                      </td>
                      <td className="px-4 py-2 tabular-nums">{d.retry_count}</td>
                      <td className="px-4 py-2 text-xs text-[var(--neu-text-muted)] max-w-xs truncate" title={d.last_error ?? ""}>
                        {d.last_error || "—"}
                      </td>
                      <td className="px-4 py-2 text-[11px] text-[var(--neu-text-subtle)]">
                        {d.received_at ? new Date(d.received_at).toLocaleString() : "—"}
                      </td>
                      <td className="px-4 py-2 text-right">
                        <button
                          onClick={() => onReplay(d.id)}
                          disabled={replaying === d.id}
                          className="neu-btn neu-btn-primary px-3 py-1 text-xs disabled:opacity-50"
                        >
                          {replaying === d.id ? "Replaying…" : "Replay"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function GuaranteeCard({
  label,
  value,
  color,
  note,
}: {
  label: string;
  value: string;
  color: "violet" | "amber" | "emerald" | "sky";
  note: string;
}) {
  const textCls = {
    violet: "text-c-violet",
    amber: "text-c-amber",
    emerald: "text-c-emerald",
    sky: "text-c-sky",
  }[color];
  return (
    <div className="neu-card p-5">
      <div className={`text-[10px] uppercase tracking-wider font-semibold mb-1 ${textCls}`}>{label}</div>
      <div className={`text-xl font-semibold tabular-nums mb-2 ${textCls}`}>{value}</div>
      <p className="text-xs text-[var(--neu-text-muted)] leading-relaxed">{note}</p>
    </div>
  );
}
