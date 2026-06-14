"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { Stat } from "@/components/Stat";
import { ChannelBadge } from "@/components/ChannelBadge";
import { EmptyState } from "@/components/EmptyState";
import { SkeletonCard, SkeletonStat } from "@/components/Skeleton";
import { DonutChart, DonutLegend } from "@/components/charts/DonutChart";
import { BarChart } from "@/components/charts/BarChart";
import {
  getAnalyticsDashboard,
  type AnalyticsDashboard,
  type ChannelStats,
  type LeaderboardCampaign,
} from "@/lib/api";
import { fmtInr, fmtNum, fmtPct } from "@/lib/format";

type SortKey = "revenue" | "conversion" | "ctr" | "delivery" | "targeted";

const CHANNEL_COLORS: Record<string, string> = {
  whatsapp: "var(--c-emerald)",
  sms: "var(--c-sky)",
  email: "var(--c-violet)",
  rcs: "var(--c-amber)",
};
const FAILURE_REASON_COLORS = [
  "var(--c-rose)",
  "var(--c-amber)",
  "var(--c-violet)",
  "var(--c-sky)",
  "var(--c-emerald)",
];

export default function AnalyticsPage() {
  const [data, setData] = useState<AnalyticsDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [sortKey, setSortKey] = useState<SortKey>("revenue");
  // Campaign comparison — N-way (start with two empty slots)
  const [compareIds, setCompareIds] = useState<(number | null)[]>([null, null]);
  const MAX_COMPARE = 5;

  const refresh = async () => {
    setLoading(true);
    const r = await getAnalyticsDashboard();
    setData(r);
    setLoading(false);
  };

  useEffect(() => {
    refresh();
  }, []);

  const sortedCampaigns = useMemo(() => {
    if (!data) return [];
    const c = [...data.campaigns];
    const k: Record<SortKey, (x: LeaderboardCampaign) => number> = {
      revenue: (x) => x.revenue_inr,
      conversion: (x) => x.conversion_rate,
      ctr: (x) => x.click_through_rate,
      delivery: (x) => x.delivery_rate,
      targeted: (x) => x.targeted,
    };
    return c.sort((a, b) => k[sortKey](b) - k[sortKey](a));
  }, [data, sortKey]);

  if (loading) {
    return (
      <div className="min-h-screen animate-fade-in">
        <PageHeader eyebrow="Intelligence" title="Analytics" />
        <div className="px-8 py-8 max-w-7xl space-y-6">
          <section className="grid grid-cols-2 md:grid-cols-5 gap-3">
            {Array.from({ length: 5 }).map((_, i) => <SkeletonStat key={i} />)}
          </section>
          <div className="grid lg:grid-cols-3 gap-4">
            <SkeletonCard rows={5} />
            <div className="lg:col-span-2"><SkeletonCard rows={5} /></div>
          </div>
          <SkeletonCard rows={6} />
        </div>
      </div>
    );
  }

  if (!data || data.overview.total_campaigns === 0) {
    return (
      <div className="min-h-screen">
        <PageHeader eyebrow="Intelligence" title="Analytics" />
        <div className="px-8 py-8 max-w-3xl">
          <EmptyState
            title="No campaigns yet"
            description="Launch a campaign to see cross-portfolio analytics here — channel performance, leaderboard, failure breakdown, AI usage, revenue."
            actionLabel="Go to campaigns"
            actionHref="/campaigns"
          />
        </div>
      </div>
    );
  }

  const ov = data.overview;

  return (
    <div className="min-h-screen animate-fade-in">
      <PageHeader
        eyebrow="Intelligence"
        title="Portfolio analytics"
        description="Cross-campaign view: which channels drive conversion, which campaigns pull above their weight, what's eating deliverability, how the AI layer is performing. Every aggregate derives from the same source tables — no warehouse."
        actions={
          <button
            onClick={refresh}
            className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm hover:bg-neutral-800 transition"
          >
            Refresh
          </button>
        }
      />

      <div className="px-8 py-8 max-w-7xl space-y-8">
        {/* Hero KPIs */}
        <section className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <Stat
            label="Total revenue"
            value={fmtInr(ov.total_revenue_inr)}
            tone="amber"
            sub="attributed to campaigns"
          />
          <Stat
            label="Campaigns run"
            value={fmtNum(ov.total_campaigns)}
            tone="violet"
            sub={Object.entries(ov.campaigns_by_status).map(([s, n]) => `${n} ${s}`).join(" · ")}
          />
          <Stat
            label="Customers reached"
            value={fmtNum(ov.customers_reached)}
            tone="emerald"
            sub="distinct"
          />
          <Stat
            label="Conversion rate"
            value={fmtPct(ov.conversion_rate)}
            tone="sky"
            sub="of delivered"
          />
          <Stat
            label="Failure rate"
            value={fmtPct(ov.failure_rate)}
            tone={ov.failure_rate > 0.1 ? "rose" : "emerald"}
            sub="of sent"
          />
        </section>

        {/* Portfolio funnel summary + channel side-by-side */}
        <section className="grid lg:grid-cols-3 gap-4">
          <div className="rounded-lg border border-neutral-800 bg-neutral-900/30 p-5">
            <h3 className="text-[11px] uppercase tracking-widest text-neutral-500 mb-3">
              Portfolio funnel
            </h3>
            <FunnelMini
              stages={[
                { label: "sent", n: ov.sent_reached, tone: "neutral" },
                { label: "delivered", n: ov.delivered_reached, tone: "emerald" },
                { label: "clicked", n: ov.clicked_reached, tone: "violet" },
                { label: "converted", n: ov.converted_reached, tone: "amber" },
                { label: "failed", n: ov.failed, tone: "red" },
              ]}
              denominator={ov.sent_reached}
            />
            <div className="mt-4 pt-4 border-t border-neutral-800 grid grid-cols-3 gap-2 text-xs">
              <div>
                <div className="text-[10px] uppercase text-neutral-500">Delivery</div>
                <div className="font-semibold text-emerald-400 tabular-nums">{fmtPct(ov.delivery_rate)}</div>
              </div>
              <div>
                <div className="text-[10px] uppercase text-neutral-500">CTR</div>
                <div className="font-semibold text-violet-400 tabular-nums">{fmtPct(ov.click_through_rate)}</div>
              </div>
              <div>
                <div className="text-[10px] uppercase text-neutral-500">Conv.</div>
                <div className="font-semibold text-amber-400 tabular-nums">{fmtPct(ov.conversion_rate)}</div>
              </div>
            </div>
          </div>

          <div className="lg:col-span-2 rounded-lg border border-neutral-800 bg-neutral-900/30 p-5">
            <h3 className="text-[11px] uppercase tracking-widest text-neutral-500 mb-3">
              Channel performance
            </h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-[10px] uppercase tracking-wider text-neutral-500">
                  <tr>
                    <th className="text-left pb-2">Channel</th>
                    <th className="text-right pb-2">Sent</th>
                    <th className="text-right pb-2">Delivery</th>
                    <th className="text-right pb-2">CTR</th>
                    <th className="text-right pb-2">Conv.</th>
                    <th className="text-right pb-2">Revenue</th>
                    <th className="text-right pb-2">₹/send</th>
                  </tr>
                </thead>
                <tbody>
                  {data.channels.map((c) => (
                    <tr key={c.channel} className="border-t border-neutral-800/60">
                      <td className="py-2"><ChannelBadge channel={c.channel} size="md" /></td>
                      <td className="py-2 text-right tabular-nums">{fmtNum(c.sent)}</td>
                      <td className="py-2 text-right tabular-nums text-emerald-400/90">{fmtPct(c.delivery_rate)}</td>
                      <td className="py-2 text-right tabular-nums text-violet-400/90">{fmtPct(c.click_through_rate)}</td>
                      <td className="py-2 text-right tabular-nums text-amber-400/90">{fmtPct(c.conversion_rate)}</td>
                      <td className="py-2 text-right tabular-nums font-mono">{fmtInr(c.revenue_inr)}</td>
                      <td className="py-2 text-right tabular-nums font-mono text-neutral-400">{fmtInr(c.revenue_per_send_inr)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        {/* Campaign performance bars */}
        {data.campaigns.length > 0 && (
          <section>
            <div className="flex items-baseline justify-between mb-3">
              <h2 className="text-[11px] uppercase tracking-widest text-neutral-500">
                Campaign performance
              </h2>
              <span className="text-[10px] text-[var(--neu-text-subtle)]">
                top {Math.min(data.campaigns.length, 10)} by revenue
              </span>
            </div>
            <div className="grid lg:grid-cols-3 gap-4">
              <div className="neu-card p-5">
                <div className="text-[10px] uppercase tracking-wider text-c-amber font-semibold mb-3">
                  Revenue by campaign
                </div>
                <BarChart
                  height={220}
                  ariaLabel="Revenue per campaign"
                  data={[...data.campaigns]
                    .sort((a, b) => b.revenue_inr - a.revenue_inr)
                    .slice(0, 10)
                    .map((c) => ({
                      label: c.name.length > 14 ? c.name.slice(0, 12) + "…" : c.name,
                      value: c.revenue_inr,
                      color: "var(--c-amber)",
                      valueLabel: c.revenue_inr > 0 ? fmtInr(c.revenue_inr) : "—",
                    }))}
                  valueFormatter={(v) => fmtInr(v)}
                />
              </div>
              <div className="neu-card p-5">
                <div className="text-[10px] uppercase tracking-wider text-c-violet font-semibold mb-3">
                  CTR by campaign
                </div>
                <BarChart
                  height={220}
                  maxValue={100}
                  ariaLabel="Click-through rate per campaign"
                  data={[...data.campaigns]
                    .sort((a, b) => b.click_through_rate - a.click_through_rate)
                    .slice(0, 10)
                    .map((c) => ({
                      label: c.name.length > 14 ? c.name.slice(0, 12) + "…" : c.name,
                      value: c.click_through_rate * 100,
                      color: "var(--c-violet)",
                      valueLabel: fmtPct(c.click_through_rate),
                    }))}
                  valueFormatter={(v) => `${v.toFixed(1)}%`}
                />
              </div>
              <div className="neu-card p-5">
                <div className="text-[10px] uppercase tracking-wider text-c-sky font-semibold mb-3">
                  Conversion by campaign
                </div>
                <BarChart
                  height={220}
                  maxValue={100}
                  ariaLabel="Conversion rate per campaign"
                  data={[...data.campaigns]
                    .sort((a, b) => b.conversion_rate - a.conversion_rate)
                    .slice(0, 10)
                    .map((c) => ({
                      label: c.name.length > 14 ? c.name.slice(0, 12) + "…" : c.name,
                      value: c.conversion_rate * 100,
                      color: "var(--c-sky)",
                      valueLabel: fmtPct(c.conversion_rate),
                    }))}
                  valueFormatter={(v) => `${v.toFixed(1)}%`}
                />
              </div>
            </div>
          </section>
        )}

        {/* Campaign leaderboard */}
        <section>
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="text-[11px] uppercase tracking-widest text-neutral-500">
              Campaign leaderboard
            </h2>
            <div className="flex items-center gap-1 text-xs">
              <span className="text-neutral-500 mr-1">Sort by:</span>
              {(["revenue", "conversion", "ctr", "delivery", "targeted"] as SortKey[]).map((k) => (
                <button
                  key={k}
                  onClick={() => setSortKey(k)}
                  className={`rounded px-2 py-0.5 transition ${
                    sortKey === k
                      ? "bg-emerald-500/10 text-emerald-300 border border-emerald-500/30"
                      : "text-neutral-500 hover:text-neutral-300 border border-transparent"
                  }`}
                >
                  {k}
                </button>
              ))}
            </div>
          </div>
          <div className="rounded-lg border border-neutral-800 bg-neutral-900/30 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-neutral-900/80 text-[10px] uppercase tracking-wider text-neutral-500">
                <tr>
                  <th className="text-left px-4 py-2">Campaign</th>
                  <th className="text-left px-4 py-2">Status</th>
                  <th className="text-right px-4 py-2">Targeted</th>
                  <th className="text-right px-4 py-2">Delivered</th>
                  <th className="text-right px-4 py-2">CTR</th>
                  <th className="text-right px-4 py-2">Conv.</th>
                  <th className="text-right px-4 py-2">Revenue</th>
                </tr>
              </thead>
              <tbody>
                {sortedCampaigns.map((c) => (
                  <tr key={c.id} className="border-t border-neutral-800/60 hover:bg-neutral-900/40">
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-2">
                        <Link
                          href={`/campaigns/${c.id}`}
                          className="text-sm text-neutral-200 hover:text-emerald-300 truncate max-w-[280px] inline-block"
                        >
                          {c.name}
                        </Link>
                        {c.is_ai_planned && (
                          <span className="text-[9px] rounded border border-violet-500/40 bg-violet-500/10 text-violet-300 px-1 py-0.5 uppercase tracking-wider font-mono">
                            AI
                          </span>
                        )}
                      </div>
                      <div className="text-[10px] font-mono text-neutral-500">#{c.id}</div>
                    </td>
                    <td className="px-4 py-2">
                      <StatusPill status={c.status} />
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">{fmtNum(c.targeted)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {fmtNum(c.delivered)}{" "}
                      <span className="text-[10px] text-neutral-500">({fmtPct(c.delivery_rate)})</span>
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-violet-400/90">{fmtPct(c.click_through_rate)}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-amber-400/90">{fmtPct(c.conversion_rate)}</td>
                    <td className="px-4 py-2 text-right tabular-nums font-mono">
                      {c.revenue_inr > 0 ? fmtInr(c.revenue_inr) : <span className="text-neutral-600">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* Failures + AI usage */}
        <section className="grid lg:grid-cols-2 gap-4">
          {/* Failures */}
          <div className="rounded-lg border border-neutral-800 bg-neutral-900/30 p-5">
            <h3 className="text-[11px] uppercase tracking-widest text-neutral-500 mb-3">
              Failure analysis
            </h3>
            {data.failures.by_reason.length === 0 ? (
              <div className="text-sm text-[var(--neu-text-subtle)]">No failures recorded yet.</div>
            ) : (
              <div className="flex items-center gap-5">
                <DonutChart
                  data={data.failures.by_reason.map((r, i) => ({
                    label: r.reason,
                    value: r.count,
                    color: FAILURE_REASON_COLORS[i % FAILURE_REASON_COLORS.length],
                  }))}
                  size={160}
                  thickness={24}
                  centerLabel={
                    <div className="text-center">
                      <div className="text-[10px] uppercase text-[var(--neu-text-subtle)]">Total</div>
                      <div className="text-base font-semibold text-c-rose tabular-nums">
                        {data.failures.by_reason.reduce((s, r) => s + r.count, 0)}
                      </div>
                    </div>
                  }
                />
                <div className="flex-1">
                  <DonutLegend
                    data={data.failures.by_reason.map((r, i) => ({
                      label: r.reason,
                      value: r.count,
                      color: FAILURE_REASON_COLORS[i % FAILURE_REASON_COLORS.length],
                    }))}
                  />
                </div>
              </div>
            )}
            <div className="mt-4 pt-4 border-t border-neutral-800">
              <div className="text-[10px] uppercase tracking-widest text-neutral-500 mb-2">
                Webhook integrity (operator view)
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <IntegrityStat label="Processed" value={data.failures.webhook_integrity.processed} tone="emerald" />
                <IntegrityStat label="Duplicates ignored" value={data.failures.webhook_integrity.duplicates_ignored} tone="sky" />
                <IntegrityStat label="Invalid signatures" value={data.failures.webhook_integrity.invalid_signatures} tone={data.failures.webhook_integrity.invalid_signatures > 0 ? "red" : "default"} />
                <IntegrityStat label="No matching comm" value={data.failures.webhook_integrity.no_communication} tone={data.failures.webhook_integrity.no_communication > 0 ? "amber" : "default"} />
              </div>
            </div>
          </div>

          {/* AI usage */}
          <div className="rounded-lg border border-neutral-800 bg-neutral-900/30 p-5">
            <div className="flex items-baseline justify-between mb-3">
              <h3 className="text-[11px] uppercase tracking-widest text-neutral-500">
                AI layer health
              </h3>
              <Link href="/ai-runs" className="text-[11px] text-emerald-400 hover:text-emerald-300">
                Audit log →
              </Link>
            </div>
            <div className="grid grid-cols-3 gap-2 mb-4">
              <Stat label="Total AI runs" value={fmtNum(data.ai_usage.total_runs)} tone="sky" />
              <Stat
                label="Fallback rate"
                value={fmtPct(data.ai_usage.overall.fallback_rate)}
                tone={data.ai_usage.overall.fallback_rate > 0.3 ? "amber" : "emerald"}
                sub="determinism kicks"
              />
              <Stat
                label="Providers used"
                value={String(data.ai_usage.by_provider.length)}
                sub={data.ai_usage.by_provider.map((p) => p.provider).join(", ")}
              />
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-widest text-neutral-500 mb-1.5">
                By purpose
              </div>
              <div className="divide-y divide-neutral-800/60">
                {data.ai_usage.by_purpose.map((p) => {
                  const okPct = (p.ok / Math.max(1, p.runs)) * 100;
                  const retryPct = (p.retry_used / Math.max(1, p.runs)) * 100;
                  const fallbackPct = (p.fallback_used / Math.max(1, p.runs)) * 100;
                  return (
                    <div key={p.purpose} className="py-1.5 flex items-center gap-3">
                      <span className="text-[11px] font-mono text-neutral-300 truncate flex-1 min-w-0" title={p.purpose}>
                        {p.purpose}
                      </span>
                      <div className="flex h-1.5 w-24 rounded-full bg-neutral-800 overflow-hidden shrink-0">
                        <div className="bg-emerald-500" style={{ width: `${okPct}%` }} />
                        <div className="bg-sky-500" style={{ width: `${retryPct}%` }} />
                        <div className="bg-amber-500" style={{ width: `${fallbackPct}%` }} />
                      </div>
                      <span className="text-[10px] font-mono text-neutral-500 tabular-nums shrink-0 w-28 text-right">
                        {fmtNum(p.runs)}r · {p.avg_latency_ms}ms
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </section>

        {/* Visual breakdowns: channel revenue (donut) + revenue (bar) */}
        <section className="grid lg:grid-cols-2 gap-4">
          {data.channels.length > 0 && (
            <div className="neu-card p-5">
              <h3 className="text-[11px] uppercase tracking-widest text-[var(--neu-text-subtle)] font-semibold mb-3">
                Revenue share by channel
              </h3>
              <div className="flex items-center gap-6">
                <DonutChart
                  data={data.channels
                    .filter((c) => c.revenue_inr > 0)
                    .map((c) => ({
                      label: c.channel,
                      value: c.revenue_inr,
                      color: CHANNEL_COLORS[c.channel] ?? "var(--xeno-blue)",
                    }))}
                  size={180}
                  thickness={28}
                  centerLabel={
                    <div className="text-center">
                      <div className="text-[10px] uppercase text-[var(--neu-text-subtle)]">Total</div>
                      <div className="text-base font-semibold text-c-amber tabular-nums">{fmtInr(data.overview.total_revenue_inr)}</div>
                    </div>
                  }
                />
                <div className="flex-1">
                  <DonutLegend
                    data={data.channels
                      .filter((c) => c.revenue_inr > 0)
                      .map((c) => ({
                        label: c.channel,
                        value: Math.round(c.revenue_inr),
                        color: CHANNEL_COLORS[c.channel] ?? "var(--xeno-blue)",
                      }))}
                  />
                </div>
              </div>
            </div>
          )}

          <div className="neu-card p-5">
            <h3 className="text-[11px] uppercase tracking-widest text-[var(--neu-text-subtle)] font-semibold mb-3">
              CTR by channel
            </h3>
            <BarChart
              height={200}
              maxValue={1}
              valueFormatter={(v) => `${(v * 100).toFixed(1)}%`}
              data={data.channels.map((c) => ({
                label: c.channel,
                value: c.click_through_rate,
                color: CHANNEL_COLORS[c.channel] ?? "var(--xeno-blue)",
                valueLabel: `${(c.click_through_rate * 100).toFixed(1)}%`,
              }))}
            />
          </div>
        </section>

        {/* Campaign comparison */}
        {data.campaigns.length >= 2 && (() => {
          const selected = compareIds
            .map((id) => (id ? data.campaigns.find((c) => c.id === id) : null))
            .filter((c): c is LeaderboardCampaign => !!c);
          const readyToCompare = selected.length >= 2;
          return (
            <section>
              <h2 className="text-[11px] uppercase tracking-widest text-[var(--neu-text-subtle)] font-semibold mb-3">
                Compare campaigns
              </h2>
              <div className="neu-card p-5 space-y-4">
                <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {compareIds.map((id, idx) => (
                    <div key={idx} className="flex items-end gap-2">
                      <div className="flex-1 min-w-0">
                        <CampaignPicker
                          label={`Campaign ${String.fromCharCode(65 + idx)}`}
                          value={id}
                          onChange={(v) => setCompareIds((prev) => prev.map((p, i) => (i === idx ? v : p)))}
                          campaigns={data.campaigns}
                          excludeIds={compareIds.filter((_, i) => i !== idx).filter((x): x is number => x !== null)}
                        />
                      </div>
                      {compareIds.length > 2 && (
                        <button
                          onClick={() => setCompareIds((prev) => prev.filter((_, i) => i !== idx))}
                          className="neu-btn px-2 py-1.5 text-sm shrink-0"
                          aria-label={`Remove campaign ${String.fromCharCode(65 + idx)}`}
                          title="Remove slot"
                        >
                          ×
                        </button>
                      )}
                    </div>
                  ))}
                  {compareIds.length < MAX_COMPARE && compareIds.length < data.campaigns.length && (
                    <button
                      onClick={() => setCompareIds((prev) => [...prev, null])}
                      className="neu-inset-sm flex items-center justify-center text-sm text-[var(--neu-text-muted)] hover:text-c-violet transition px-3 py-2 rounded-md"
                    >
                      + Add campaign
                    </button>
                  )}
                </div>
                {readyToCompare ? (
                  <CampaignComparison campaigns={selected} />
                ) : (
                  <div className="neu-inset-sm px-4 py-6 text-center text-sm text-[var(--neu-text-subtle)]">
                    Pick at least two campaigns to see a side-by-side metric comparison.
                  </div>
                )}
              </div>
            </section>
          );
        })()}

        {/* Revenue timeline */}
        {data.revenue_timeline.length > 0 && (
          <section>
            <h2 className="text-[11px] uppercase tracking-widest text-neutral-500 mb-3">
              Revenue by campaign
            </h2>
            <div className="rounded-lg border border-neutral-800 bg-neutral-900/30 p-5">
              <div className="space-y-2">
                {data.revenue_timeline.map((r) => {
                  const max = Math.max(...data.revenue_timeline.map((x) => x.revenue_inr));
                  const pct = max > 0 ? (r.revenue_inr / max) * 100 : 0;
                  return (
                    <div key={r.campaign_id}>
                      <div className="flex items-center justify-between text-xs mb-1">
                        <Link href={`/campaigns/${r.campaign_id}`} className="text-neutral-300 hover:text-emerald-300 truncate max-w-[60%]">
                          {r.name}
                        </Link>
                        <span className="font-mono text-amber-300 tabular-nums">{fmtInr(r.revenue_inr)}</span>
                      </div>
                      <div className="h-2 rounded-full bg-[var(--neu-shadow-dark-soft)] overflow-hidden">
                        <div
                          className="h-full bar-fill rounded-full"
                          style={{
                            width: `${pct}%`,
                            background: "linear-gradient(90deg, var(--c-amber), #d97706)",
                          }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function FunnelMini({
  stages,
  denominator,
}: {
  stages: Array<{ label: string; n: number; tone: string }>;
  denominator: number;
}) {
  const toneCls: Record<string, string> = {
    neutral: "bg-neutral-500",
    emerald: "bg-emerald-500",
    sky: "bg-sky-500",
    violet: "bg-violet-500",
    amber: "bg-amber-400",
    red: "bg-red-500",
  };
  return (
    <div className="space-y-2">
      {stages.map((s) => {
        const pct = denominator > 0 ? (s.n / denominator) * 100 : 0;
        return (
          <div key={s.label}>
            <div className="flex items-center justify-between text-xs mb-1">
              <span className="font-mono text-neutral-300">{s.label}</span>
              <span className="font-mono text-neutral-500 tabular-nums">
                {fmtNum(s.n)} ({pct.toFixed(1)}%)
              </span>
            </div>
            <div className="h-1.5 rounded-full bg-neutral-800 overflow-hidden">
              <div className={toneCls[s.tone] ?? "bg-neutral-500"} style={{ width: `${pct}%`, height: "100%" }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function CampaignPicker({
  label,
  value,
  onChange,
  campaigns,
  excludeIds = [],
}: {
  label: string;
  value: number | null;
  onChange: (id: number | null) => void;
  campaigns: LeaderboardCampaign[];
  excludeIds?: number[];
}) {
  const excluded = new Set(excludeIds);
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-[var(--neu-text-subtle)] font-semibold mb-1.5">
        {label}
      </div>
      <select
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
        className="w-full neu-input px-3 py-2 text-sm"
      >
        <option value="">— select —</option>
        {campaigns
          .filter((c) => !excluded.has(c.id))
          .map((c) => (
            <option key={c.id} value={c.id}>
              #{c.id} · {c.name.length > 55 ? c.name.slice(0, 55) + "…" : c.name} ({c.status})
            </option>
          ))}
      </select>
    </div>
  );
}

const COMPARE_COLORS = [
  "var(--xeno-blue)",
  "var(--c-amber)",
  "var(--c-emerald)",
  "var(--c-violet)",
  "var(--c-rose)",
];

function CampaignComparison({ campaigns }: { campaigns: LeaderboardCampaign[] }) {
  const colors = campaigns.map((_, i) => COMPARE_COLORS[i % COMPARE_COLORS.length]);

  const buildSeries = (extractor: (c: LeaderboardCampaign) => number) =>
    campaigns.map((c, i) => ({ label: c.name, value: extractor(c), color: colors[i] }));

  const volumeMetrics: Array<{ metric: string; series: { label: string; value: number; color: string }[] }> = [
    { metric: "Targeted", series: buildSeries((c) => c.targeted) },
    { metric: "Delivered", series: buildSeries((c) => c.delivered) },
    { metric: "Clicked", series: buildSeries((c) => c.clicked) },
    { metric: "Converted", series: buildSeries((c) => c.converted) },
    { metric: "Failed", series: buildSeries((c) => c.failed) },
  ];
  const rateMetrics = [
    { metric: "Delivery", series: buildSeries((c) => c.delivery_rate * 100) },
    { metric: "CTR", series: buildSeries((c) => c.click_through_rate * 100) },
    { metric: "Conversion", series: buildSeries((c) => c.conversion_rate * 100) },
  ];
  const revenueMetric = [{ metric: "Revenue", series: buildSeries((c) => c.revenue_inr) }];

  return (
    <div className="space-y-5">
      {/* Header strip — one per campaign */}
      <div className={`grid gap-3 ${campaigns.length <= 2 ? "grid-cols-2" : campaigns.length === 3 ? "grid-cols-3" : "grid-cols-2 lg:grid-cols-" + campaigns.length}`}>
        {campaigns.map((c, i) => (
          <CompareHeader key={c.id} campaign={c} colorVar={colors[i]} />
        ))}
      </div>

      {/* Legend */}
      <div className="flex items-center gap-4 text-xs flex-wrap">
        {campaigns.map((c, i) => (
          <div key={c.id} className="flex items-center gap-2">
            <span className="h-3 w-3 rounded-sm" style={{ background: colors[i] }} />
            <span className="text-[var(--neu-text-muted)] truncate max-w-[240px]">{c.name}</span>
          </div>
        ))}
      </div>

      {/* Grouped bar charts */}
      <div className="grid lg:grid-cols-3 gap-4">
        <div className="neu-inset-sm p-4">
          <div className="text-[10px] uppercase tracking-wider text-[var(--neu-text-subtle)] mb-3 font-semibold">
            Volume metrics
          </div>
          <GroupedCompareBars data={volumeMetrics} format={(n) => fmtNum(n)} />
        </div>
        <div className="neu-inset-sm p-4">
          <div className="text-[10px] uppercase tracking-wider text-[var(--neu-text-subtle)] mb-3 font-semibold">
            Rate metrics (%)
          </div>
          <GroupedCompareBars data={rateMetrics} format={(n) => `${n.toFixed(1)}%`} maxOverride={100} />
        </div>
        <div className="neu-inset-sm p-4">
          <div className="text-[10px] uppercase tracking-wider text-[var(--neu-text-subtle)] mb-3 font-semibold">
            Revenue (INR)
          </div>
          <GroupedCompareBars data={revenueMetric} format={(n) => fmtInr(n)} />
        </div>
      </div>
    </div>
  );
}

/** Grouped-bar comparison: for each metric, two adjacent bars (A vs B) sharing a y-axis. */
function GroupedCompareBars({
  data,
  format,
  height = 220,
  maxOverride,
}: {
  data: Array<{ metric: string; series: { label: string; value: number; color: string }[] }>;
  format: (n: number) => string;
  height?: number;
  maxOverride?: number;
}) {
  const allValues = data.flatMap((d) => d.series.map((s) => s.value));
  const max = maxOverride ?? Math.max(...allValues, 1);
  const VALUE_H = 16;
  const LABEL_H = 22;
  const trackH = Math.max(50, height - VALUE_H - LABEL_H - 10);
  return (
    <div role="img" aria-label="Grouped comparison bars">
      <div className="flex items-stretch gap-4" style={{ height }}>
        {data.map((d) => {
          const bestVal = Math.max(...d.series.map((s) => s.value));
          return (
            <div key={d.metric} className="flex-1 flex flex-col items-center gap-1 min-w-0">
              {/* Value labels */}
              <div className="flex w-full gap-0.5" style={{ height: VALUE_H }}>
                {d.series.map((s, i) => {
                  const isBest = s.value === bestVal && s.value > 0;
                  return (
                    <div
                      key={i}
                      className={`flex-1 text-[9px] font-mono tabular-nums text-center leading-none flex items-end justify-center ${isBest ? "font-bold" : "text-[var(--neu-text-muted)]"}`}
                      style={isBest ? { color: s.color } : undefined}
                    >
                      {format(s.value)}
                    </div>
                  );
                })}
              </div>
              {/* Bar tracks */}
              <div className="flex w-full gap-0.5" style={{ height: trackH }}>
                {d.series.map((s, i) => {
                  const pct = s.value > 0 ? Math.max(0.5, (s.value / max) * 100) : 0;
                  return (
                    <div key={i} className="flex-1 neu-inset-sm rounded-md relative overflow-hidden">
                      <div
                        className="bar-fill absolute bottom-0 left-0 right-0 rounded-md"
                        style={{
                          height: `${pct}%`,
                          background: `linear-gradient(180deg, ${s.color}, color-mix(in srgb, ${s.color}, black 25%))`,
                          boxShadow: `0 0 12px color-mix(in srgb, ${s.color}, transparent 60%)`,
                        }}
                      />
                    </div>
                  );
                })}
              </div>
              {/* Metric label */}
              <div
                className="text-[10px] text-[var(--neu-text-subtle)] truncate w-full text-center font-semibold uppercase tracking-wider leading-tight flex items-start justify-center pt-0.5"
                style={{ height: LABEL_H }}
                title={d.metric}
              >
                {d.metric}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CompareHeader({
  campaign,
  colorVar,
}: {
  campaign: LeaderboardCampaign;
  colorVar: string;
}) {
  return (
    <div className="neu-raised-xs p-3">
      <div className="flex items-center gap-2 mb-1">
        <span className="h-2 w-2 rounded-full shrink-0" style={{ background: colorVar }} />
        <span className="text-xs font-semibold text-[var(--neu-text)] truncate">{campaign.name}</span>
        {campaign.is_ai_planned && (
          <span className="neu-pill text-c-violet shrink-0">AI</span>
        )}
      </div>
      <div className="text-[10px] font-mono text-[var(--neu-text-subtle)]">
        #{campaign.id} · {campaign.status}
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const styles: Record<string, string> = {
    draft: "bg-neutral-800 text-neutral-300 border-neutral-700",
    launching: "bg-amber-500/10 text-amber-300 border-amber-500/30",
    running: "bg-sky-500/10 text-sky-300 border-sky-500/30",
    completed: "bg-emerald-500/10 text-emerald-300 border-emerald-500/30",
    failed: "bg-red-500/10 text-red-300 border-red-500/30",
  };
  return (
    <span className={`text-[10px] font-mono uppercase tracking-wider rounded border px-1.5 py-0.5 ${styles[status] ?? styles.draft}`}>
      {status}
    </span>
  );
}

function IntegrityStat({ label, value, tone }: { label: string; value: number; tone: "default" | "emerald" | "amber" | "red" | "sky" }) {
  const cls: Record<string, string> = {
    default: "text-neutral-200",
    emerald: "text-emerald-400",
    amber: "text-amber-400",
    red: "text-red-400",
    sky: "text-sky-400",
  };
  return (
    <div className="rounded-md border border-neutral-800 bg-neutral-950/40 px-2.5 py-1.5">
      <div className="text-[10px] uppercase tracking-wider text-neutral-500">{label}</div>
      <div className={`text-sm font-semibold tabular-nums mt-0.5 ${cls[tone]}`}>{fmtNum(value)}</div>
    </div>
  );
}
