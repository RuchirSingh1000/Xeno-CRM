"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { HeroStat, Stat } from "@/components/Stat";
import { ChannelBadge } from "@/components/ChannelBadge";
import { SkeletonCard, SkeletonStat } from "@/components/Skeleton";
import {
  CHANNEL_SIM,
  CRM_API,
  fetchHealth,
  getAnalyticsDashboard,
  type AnalyticsDashboard,
  type HealthResponse,
} from "@/lib/api";
import { fmtInr, fmtNum, fmtPct, fmtRelative } from "@/lib/format";

type ServiceStatus = {
  name: string;
  url: string;
  data: HealthResponse | null;
  loading: boolean;
};

export default function Overview() {
  const [dashboard, setDashboard] = useState<AnalyticsDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [services, setServices] = useState<ServiceStatus[]>([
    { name: "CRM API", url: CRM_API, data: null, loading: true },
    { name: "Channel Simulator", url: CHANNEL_SIM, data: null, loading: true },
  ]);

  const refresh = async () => {
    setLoading(true);
    setServices((prev) => prev.map((s) => ({ ...s, loading: true })));
    const [d, crm, sim] = await Promise.all([
      getAnalyticsDashboard(),
      fetchHealth(CRM_API),
      fetchHealth(CHANNEL_SIM),
    ]);
    setDashboard(d);
    setServices([
      { name: "CRM API", url: CRM_API, data: crm, loading: false },
      { name: "Channel Simulator", url: CHANNEL_SIM, data: sim, loading: false },
    ]);
    setLoading(false);
  };

  useEffect(() => {
    refresh();
  }, []);

  const ov = dashboard?.overview;
  const hasData = ov && ov.total_campaigns > 0;
  const topCampaign = dashboard?.campaigns
    ? [...dashboard.campaigns].sort((a, b) => b.revenue_inr - a.revenue_inr)[0]
    : null;

  return (
    <div className="min-h-screen animate-fade-in">
      <PageHeader
        eyebrow="Brewhouse Co. · Retail Activation Console"
        title="Overview"
        description="A glance across the entire engagement program — revenue, customers, channel mix, and the AI surfaces that drive them."
        actions={
          <button onClick={refresh} className="neu-btn px-3 py-1.5 text-sm">
            Refresh
          </button>
        }
      />

      <div className="px-8 py-6 max-w-7xl space-y-8">
        {/* Hero KPIs */}
        {!hasData && loading ? (
          <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <SkeletonStat key={i} />
            ))}
          </section>
        ) : !hasData ? (
          <EmptyHero />
        ) : (
          <>
            <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <HeroStat
                label="Total revenue"
                value={ov!.total_revenue_inr > 0 ? fmtInr(ov!.total_revenue_inr) : "—"}
                tone="xeno"
                sub={
                  topCampaign && topCampaign.revenue_inr > 0 ? (
                    <span>
                      Top:{" "}
                      <Link
                        href={`/campaigns/${topCampaign.id}`}
                        className="text-xeno hover:underline"
                      >
                        {topCampaign.name.length > 40
                          ? topCampaign.name.slice(0, 40) + "…"
                          : topCampaign.name}
                      </Link>
                    </span>
                  ) : (
                    "attributed to campaigns"
                  )
                }
              />
              <HeroStat
                label="Customers reached"
                value={ov!.customers_reached}
                tone="emerald"
                sub="distinct, across all campaigns"
              />
              <HeroStat
                label="Campaigns"
                value={ov!.total_campaigns}
                tone="violet"
                sub={Object.entries(ov!.campaigns_by_status)
                  .map(([s, n]) => `${n} ${s}`)
                  .join(" · ")}
              />
              <HeroStat
                label="Conversion rate"
                value={`${(ov!.conversion_rate * 100).toFixed(2)}%`}
                tone="sky"
                sub={`${fmtNum(ov!.converted_reached)} of ${fmtNum(ov!.delivered_reached)} delivered`}
              />
            </section>

            {/* Quick actions */}
            <section>
              <SectionLabel>Quick actions</SectionLabel>
              <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
                <QuickAction
                  href="/campaigns"
                  title="Plan with AI"
                  description="Describe your goal — model returns a full validated campaign plan."
                  badge="AI"
                  tone="violet"
                />
                <QuickAction
                  href="/segments"
                  title="Build a segment"
                  description="Filter chips, live preview, why-included reasoning per customer."
                  tone="emerald"
                />
                <QuickAction
                  href="/ingest"
                  title="Ingest data"
                  description="POS, ecommerce, loyalty — resolve identities across all three."
                  tone="sky"
                />
                <QuickAction
                  href="/analytics"
                  title="Portfolio analytics"
                  description="Channel performance, leaderboard, failure mix, AI usage."
                  tone="amber"
                />
              </div>
            </section>

            {/* Channel mix + AI health side by side */}
            <section className="grid lg:grid-cols-3 gap-4">
              <div className="lg:col-span-2 neu-card p-5">
                <div className="flex items-baseline justify-between mb-4">
                  <SectionLabel className="mb-0">Channel performance</SectionLabel>
                  <Link
                    href="/analytics"
                    className="text-[11px] text-xeno hover:underline"
                  >
                    Full analytics →
                  </Link>
                </div>
                {dashboard && dashboard.channels.length > 0 ? (
                  <div className="space-y-3">
                    {dashboard.channels.map((c) => (
                      <ChannelRow key={c.channel} c={c} />
                    ))}
                  </div>
                ) : (
                  <div className="text-sm text-[var(--neu-text-muted)]">No channels active yet.</div>
                )}
              </div>

              <div className="neu-card p-5">
                <div className="flex items-baseline justify-between mb-4">
                  <SectionLabel className="mb-0">AI layer</SectionLabel>
                  <Link href="/ai-runs" className="text-[11px] text-xeno hover:underline">
                    Audit →
                  </Link>
                </div>
                {dashboard?.ai_usage ? (
                  <>
                    <div className="grid grid-cols-2 gap-3 mb-4">
                      <Stat
                        label="Total runs"
                        value={dashboard.ai_usage.total_runs}
                        tone="violet"
                      />
                      <Stat
                        label="Fallback rate"
                        value={`${(dashboard.ai_usage.overall.fallback_rate * 100).toFixed(1)}%`}
                        tone={
                          dashboard.ai_usage.overall.fallback_rate > 0.3 ? "amber" : "emerald"
                        }
                        sub="determinism saves the day"
                        animate={false}
                      />
                    </div>
                    <div className="space-y-1.5">
                      {dashboard.ai_usage.by_purpose.slice(0, 4).map((p) => (
                        <div
                          key={p.purpose}
                          className="neu-inset-sm flex items-center justify-between px-3 py-1.5 text-[11px]"
                        >
                          <span className="font-mono text-[var(--neu-text-muted)]">{p.purpose}</span>
                          <span className="font-mono text-[var(--neu-text)] tabular-nums">
                            {fmtNum(p.runs)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </>
                ) : (
                  <SkeletonCard rows={4} />
                )}
              </div>
            </section>

            {/* Recent campaigns */}
            <section>
              <div className="flex items-baseline justify-between mb-3">
                <SectionLabel className="mb-0">Recent campaigns</SectionLabel>
                <Link
                  href="/campaigns"
                  className="text-[11px] text-xeno hover:underline"
                >
                  All campaigns →
                </Link>
              </div>
              <div className="neu-card overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="text-[10px] uppercase tracking-wider text-[var(--neu-text-subtle)]">
                    <tr>
                      <th className="text-left px-5 py-3">Campaign</th>
                      <th className="text-left px-5 py-3">Status</th>
                      <th className="text-right px-5 py-3">Targeted</th>
                      <th className="text-right px-5 py-3">Conv.</th>
                      <th className="text-right px-5 py-3">Revenue</th>
                      <th className="text-left px-5 py-3">Launched</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(dashboard?.campaigns ?? []).slice(0, 5).map((c) => (
                      <tr
                        key={c.id}
                        className="border-t border-[var(--neu-shadow-dark-soft)]/30 hover:bg-[var(--neu-surface-2)]/40 transition"
                      >
                        <td className="px-5 py-3">
                          <div className="flex items-center gap-2">
                            <Link
                              href={`/campaigns/${c.id}`}
                              className="text-sm font-medium text-[var(--neu-text)] hover:text-xeno truncate max-w-[280px] inline-block"
                            >
                              {c.name}
                            </Link>
                            {c.is_ai_planned && (
                              <span className="neu-pill text-c-violet">AI</span>
                            )}
                          </div>
                        </td>
                        <td className="px-5 py-3">
                          <StatusPill status={c.status} />
                        </td>
                        <td className="px-5 py-3 text-right tabular-nums">{fmtNum(c.targeted)}</td>
                        <td className="px-5 py-3 text-right tabular-nums text-c-amber font-semibold">
                          {fmtPct(c.conversion_rate)}
                        </td>
                        <td className="px-5 py-3 text-right tabular-nums font-mono">
                          {c.revenue_inr > 0 ? (
                            fmtInr(c.revenue_inr)
                          ) : (
                            <span className="text-[var(--neu-text-faint)]">—</span>
                          )}
                        </td>
                        <td className="px-5 py-3 text-xs text-[var(--neu-text-subtle)]">
                          {fmtRelative(c.launched_at)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}

        {/* Service health footer */}
        <section>
          <SectionLabel>Service health</SectionLabel>
          <div className="grid sm:grid-cols-2 gap-3">
            {services.map((s) => (
              <ServiceCard key={s.name} status={s} />
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function SectionLabel({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <h2
      className={`text-[11px] uppercase tracking-widest text-[var(--neu-text-subtle)] font-semibold mb-3 ${className}`}
    >
      {children}
    </h2>
  );
}

function EmptyHero() {
  return (
    <div className="neu-inset px-8 py-12 text-center animate-fade-in">
      <div className="text-xl font-semibold mb-2 text-[var(--neu-text)]">Nothing to report yet</div>
      <p className="text-sm text-[var(--neu-text-muted)] mb-5 max-w-md mx-auto">
        Ingest the seed data and launch your first campaign to populate this dashboard.
      </p>
      <div className="flex items-center justify-center gap-2">
        <Link href="/ingest" className="neu-btn neu-btn-primary px-4 py-2 text-sm">
          Ingest seed data →
        </Link>
        <Link href="/data-sources" className="neu-btn px-4 py-2 text-sm">
          View data sources
        </Link>
      </div>
    </div>
  );
}

function QuickAction({
  href,
  title,
  description,
  badge,
  tone,
}: {
  href: string;
  title: string;
  description: string;
  badge?: string;
  tone: "violet" | "emerald" | "sky" | "amber";
}) {
  const accentCls: Record<string, string> = {
    violet: "accent-violet",
    emerald: "accent-emerald",
    sky: "accent-sky",
    amber: "accent-amber",
  };
  const badgeCls: Record<string, string> = {
    violet: "text-c-violet",
    emerald: "text-c-emerald",
    sky: "text-c-sky",
    amber: "text-c-amber",
  };
  return (
    <Link href={href} className={`neu-card ${accentCls[tone]} p-5 group`}>
      <div className="flex items-center gap-2 mb-2">
        <div className="text-sm font-semibold text-[var(--neu-text)] flex-1">{title}</div>
        {badge && <span className={`neu-pill ${badgeCls[tone]}`}>{badge}</span>}
      </div>
      <div className="text-xs text-[var(--neu-text-muted)] leading-relaxed">{description}</div>
      <div className="text-[11px] text-[var(--neu-text-subtle)] mt-3 group-hover:text-xeno transition">
        Open →
      </div>
    </Link>
  );
}

function ChannelRow({
  c,
}: {
  c: NonNullable<AnalyticsDashboard["channels"][number]>;
}) {
  const colorCls: Record<string, string> = {
    whatsapp: "bg-[var(--c-emerald)]",
    sms: "bg-[var(--c-sky)]",
    email: "bg-[var(--c-violet)]",
    rcs: "bg-[var(--c-amber)]",
  };
  return (
    <div className="neu-inset-sm px-4 py-3">
      <div className="flex items-baseline justify-between mb-2">
        <div className="flex items-center gap-2">
          <ChannelBadge channel={c.channel} size="md" />
          <span className="text-xs text-[var(--neu-text-subtle)] font-mono tabular-nums">
            {fmtNum(c.sent)} sent
          </span>
        </div>
        <div className="text-sm font-mono text-c-amber font-semibold tabular-nums">
          {fmtInr(c.revenue_inr)}
        </div>
      </div>
      <div className="grid grid-cols-3 gap-3 text-[11px] mb-2">
        <Mini label="Delivery" value={c.delivery_rate} tone="emerald" />
        <Mini label="CTR" value={c.click_through_rate} tone="violet" />
        <Mini label="Conv." value={c.conversion_rate} tone="amber" />
      </div>
      <div className="h-1.5 rounded-full bg-[var(--neu-shadow-dark-soft)] overflow-hidden">
        <div
          className={`${colorCls[c.channel] ?? "bg-[var(--xeno-blue)]"} bar-fill h-full`}
          style={{ width: `${Math.min(100, c.delivery_rate * 100)}%` }}
        />
      </div>
    </div>
  );
}

function Mini({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "emerald" | "violet" | "amber";
}) {
  const cls: Record<string, string> = {
    emerald: "text-c-emerald",
    violet: "text-c-violet",
    amber: "text-c-amber",
  };
  return (
    <div className="flex items-center justify-between">
      <span className="text-[var(--neu-text-subtle)]">{label}</span>
      <span className={`tabular-nums font-semibold ${cls[tone]}`}>
        {(value * 100).toFixed(1)}%
      </span>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const cls: Record<string, string> = {
    draft: "text-[var(--neu-text-muted)]",
    launching: "text-c-amber",
    running: "text-c-sky",
    completed: "text-c-emerald",
    failed: "text-c-rose",
  };
  return <span className={`neu-pill ${cls[status] ?? cls.draft}`}>{status}</span>;
}

function ServiceCard({ status }: { status: ServiceStatus }) {
  const ok = !!status.data;
  return (
    <div className="neu-raised-sm px-4 py-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span
            className={`h-2 w-2 rounded-full ${
              status.loading
                ? "bg-[var(--neu-text-subtle)] animate-pulse"
                : ok
                ? "bg-[var(--c-emerald)] animate-pulse-glow"
                : "bg-[var(--c-rose)]"
            }`}
          />
          <span className="text-xs font-semibold text-[var(--neu-text)]">{status.name}</span>
        </div>
        <span
          className={`text-[11px] font-medium ${
            status.loading
              ? "text-[var(--neu-text-subtle)]"
              : ok
              ? "text-c-emerald"
              : "text-c-rose"
          }`}
        >
          {status.loading ? "checking…" : ok ? "ok" : "unreachable"}
        </span>
      </div>
      <div className="mt-1 text-[10px] font-mono text-[var(--neu-text-subtle)]">{status.url}</div>
    </div>
  );
}
