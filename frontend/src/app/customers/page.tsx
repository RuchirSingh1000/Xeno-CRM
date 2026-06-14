"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { Stat } from "@/components/Stat";
import { Skeleton } from "@/components/Skeleton";
import {
  aiIngestCustomers,
  getCustomerStats,
  listCustomers,
  type AIIngestResponse,
  type CustomerListResponse,
  type CustomerStats,
} from "@/lib/api";
import { fmtInr, fmtNum, fmtRelative } from "@/lib/format";
import { AILoader } from "@/components/AILoader";
import { useToast } from "@/components/Toast";
import { useAIThinking } from "@/components/AIThinking";

const PAGE_SIZE = 25;

export default function CustomersPage() {
  const [data, setData] = useState<CustomerListResponse | null>(null);
  const [stats, setStats] = useState<CustomerStats | null>(null);
  const [loading, setLoading] = useState(true);

  const [search, setSearch] = useState("");
  const [city, setCity] = useState("");
  const [tier, setTier] = useState("");
  const [minSources, setMinSources] = useState<string>("");
  const [page, setPage] = useState(0);

  // AI ingest panel state
  const [aiOpen, setAiOpen] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiPreview, setAiPreview] = useState<AIIngestResponse | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const toast = useToast();
  const ai = useAIThinking();

  const onAiParse = async () => {
    if (!aiPrompt.trim()) return;
    setAiBusy(true);
    setAiError(null);
    setAiPreview(null);
    const r = await ai.run("Parsing customers with AI…", () => aiIngestCustomers(aiPrompt, false));
    setAiBusy(false);
    if (!r) {
      setAiError("AI parse failed. Check /ai-runs for details.");
      return;
    }
    setAiPreview(r);
  };

  const onAiConfirm = async () => {
    if (!aiPreview) return;
    setAiBusy(true);
    const r = await ai.run("Saving customers…", () => aiIngestCustomers(aiPrompt, true));
    setAiBusy(false);
    if (!r || !r.persisted) {
      toast.error("Save failed");
      return;
    }
    toast.success(
      `${r.created?.length ?? 0} customer${(r.created?.length ?? 0) === 1 ? "" : "s"} added`,
      `via AI ingest · ${r.provider}/${r.model}`
    );
    setAiPreview(null);
    setAiPrompt("");
    setAiOpen(false);
    // Refresh both stats and list
    getCustomerStats().then(setStats);
    setPage(0);
    listCustomers({ limit: PAGE_SIZE, offset: 0 }).then(setData);
  };

  const AI_SAMPLE_PROMPTS = [
    "Add Rohit Sharma, phone 9876543210, email rohit.sharma@gmail.com, from Bengaluru, loyalty gold.",
    "Add 2 new customers: Priya Mehta in Mumbai with phone 9988776655 (silver tier); and Arjun Reddy in Hyderabad, email arjun@example.com.",
    "Quick add: Neha Iyer, Chennai, +91-98765-12345, opted out of SMS.",
  ];

  useEffect(() => {
    getCustomerStats().then(setStats);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(() => {
      listCustomers({
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
        search: search || undefined,
        city: city || undefined,
        tier: tier || undefined,
        min_sources: minSources === "1+" ? 1 : undefined,
        sources_eq: minSources === "" || minSources === "1+" ? undefined : Number(minSources),
      }).then((d) => {
        if (cancelled) return;
        setData(d);
        setLoading(false);
      });
    }, 200); // debounce typing
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [search, city, tier, minSources, page]);

  useEffect(() => {
    setPage(0);
  }, [search, city, tier, minSources]);

  const totalPages = useMemo(() => {
    if (!data) return 0;
    return Math.ceil(data.total / PAGE_SIZE);
  }, [data]);

  if (stats && stats.total_customers === 0) {
    return (
      <div className="min-h-screen">
        <PageHeader eyebrow="Customers" title="Customers" />
        <div className="px-8 py-8 max-w-3xl">
          <EmptyState
            title="No customers yet"
            description="Run identity resolution first — that step collapses staged source rows into canonical customers."
            actionLabel="Go to Ingest"
            actionHref="/ingest"
          />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen animate-fade-in">
      <PageHeader
        eyebrow="Customers"
        title="Canonical customers"
        description="Unified customer view after identity resolution. Filter by city, loyalty tier, or source coverage (how many systems each customer appears in)."
        actions={
          <button
            onClick={() => setAiOpen(!aiOpen)}
            className="neu-btn neu-btn-primary px-3 py-1.5 text-sm"
          >
            {aiOpen ? "Close AI ingest" : "AI ingest"}
          </button>
        }
      />

      <div className="px-8 py-8 max-w-7xl space-y-6">
        {/* AI ingest panel */}
        {aiOpen && (
          <section className="neu-card accent-violet p-5 animate-fade-in">
            <div className="flex items-baseline justify-between mb-3">
              <div>
                <div className="text-[10px] uppercase tracking-widest text-c-violet font-semibold mb-1">
                  AI · customer ingest
                </div>
                <p className="text-sm text-[var(--neu-text-muted)] max-w-2xl">
                  Describe new customers in plain English. The model parses into
                  structured rows, you review, then persist. Phone formats are
                  normalized; consent defaults to opted-in unless your prompt says
                  otherwise.
                </p>
              </div>
            </div>

            <textarea
              value={aiPrompt}
              onChange={(e) => setAiPrompt(e.target.value)}
              placeholder='e.g., "Add Rohit Sharma, phone 9876543210, email rohit@gmail.com, from Bengaluru, gold tier."'
              rows={3}
              className="w-full neu-input p-3 text-sm font-mono"
            />

            <div className="mt-3 flex flex-wrap gap-1.5">
              <span className="text-[11px] text-[var(--neu-text-subtle)] mr-1">Try:</span>
              {AI_SAMPLE_PROMPTS.map((p) => (
                <button
                  key={p}
                  onClick={() => setAiPrompt(p)}
                  className="text-[11px] neu-raised-xs px-2.5 py-1 hover:text-xeno transition"
                >
                  {p.length > 60 ? p.slice(0, 57) + "…" : p}
                </button>
              ))}
            </div>

            <div className="mt-3 flex items-center gap-2">
              <button
                onClick={onAiParse}
                disabled={aiBusy || !aiPrompt.trim()}
                className="neu-btn neu-btn-primary px-4 py-2 text-sm min-w-[150px]"
              >
                {aiBusy && !aiPreview ? <AILoader label="Parsing…" /> : "Parse with AI"}
              </button>
              {aiPreview && (
                <>
                  <button
                    onClick={onAiConfirm}
                    disabled={aiBusy}
                    className="neu-btn neu-btn-primary px-4 py-2 text-sm min-w-[180px]"
                  >
                    {aiBusy ? <AILoader label="Saving…" /> : `Add ${aiPreview.parsed_customers.length} customer${aiPreview.parsed_customers.length === 1 ? "" : "s"}`}
                  </button>
                  <button
                    onClick={() => { setAiPreview(null); setAiPrompt(""); }}
                    className="neu-btn px-3 py-2 text-sm"
                  >
                    Discard
                  </button>
                </>
              )}
            </div>

            {aiError && (
              <div className="mt-3 neu-inset-sm px-3 py-2 text-xs text-c-rose">{aiError}</div>
            )}

            {aiPreview && (
              <div className="mt-4 space-y-2">
                <div className="text-[10px] uppercase tracking-wider text-[var(--neu-text-subtle)] flex items-center gap-2">
                  Preview
                  <span className="font-mono text-[var(--neu-text-faint)]">
                    {aiPreview.provider}/{aiPreview.model} · {aiPreview.latency_ms}ms · {aiPreview.validation_status}
                  </span>
                </div>
                <div className="neu-inset-sm p-3 text-xs text-[var(--neu-text-muted)] italic">
                  {aiPreview.rationale}
                </div>
                <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
                  {aiPreview.parsed_customers.map((c, i) => (
                    <div key={i} className="neu-raised-xs p-3">
                      <div className="text-sm font-semibold text-[var(--neu-text)]">{c.full_name}</div>
                      <div className="text-[11px] text-[var(--neu-text-muted)] mt-1 space-y-0.5 font-mono">
                        {c.phone && <div>📞 {c.phone}</div>}
                        {c.email && <div>✉ {c.email}</div>}
                        {c.city && <div>📍 {c.city}</div>}
                        {c.loyalty_tier && <div className="text-c-amber">tier: {c.loyalty_tier}</div>}
                      </div>
                      {c.notes && (
                        <div className="mt-2 text-[10px] text-[var(--neu-text-subtle)] italic">{c.notes}</div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>
        )}

        {/* Stats strip */}
        {stats && (
          <section className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <Stat label="Total customers" value={fmtNum(stats.total_customers)} tone="emerald" />
            <Stat label="LTV p50" value={fmtInr(stats.ltv.p50)} tone="amber" sub="median" />
            <Stat label="LTV p90" value={fmtInr(stats.ltv.p90)} tone="violet" sub="top decile" />
            <Stat label="WhatsApp opted-in" value={fmtNum(stats.consent.whatsapp)} tone="sky" />
            <Stat label="DND flagged" value={fmtNum(stats.consent.dnd)} tone={stats.consent.dnd > 0 ? "amber" : "default"} sub="TRAI registry" />
          </section>
        )}

        {/* Filters */}
        <section className="rounded-lg border border-neutral-800 bg-neutral-900/30 p-4">
          <div className="flex flex-wrap gap-3 items-center">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name, email, phone, master ID…"
              className="customer-search flex-1 min-w-[260px] px-3 py-2 text-sm"
            />
            <select
              value={city}
              onChange={(e) => setCity(e.target.value)}
              className="rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm"
            >
              <option value="">All cities</option>
              {stats?.by_city_top10.map((c) => (
                <option key={c.city} value={c.city}>
                  {c.city} ({c.count})
                </option>
              ))}
            </select>
            <select
              value={tier}
              onChange={(e) => setTier(e.target.value)}
              className="rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm"
            >
              <option value="">All tiers</option>
              {stats?.by_tier.map((t) => (
                <option key={t.tier} value={t.tier}>
                  {t.tier} ({t.count})
                </option>
              ))}
            </select>
            <select
              value={minSources}
              onChange={(e) => setMinSources(e.target.value)}
              className="rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm"
            >
              <option value="">All source coverages</option>
              <option value="1+">1+ sources</option>
              <option value="1">1 source</option>
              <option value="2">2 sources</option>
              <option value="3">3 sources</option>
            </select>
            {(search || city || tier || minSources !== "") && (
              <button
                onClick={() => {
                  setSearch("");
                  setCity("");
                  setTier("");
                  setMinSources("");
                }}
                className="text-xs text-neutral-400 hover:text-neutral-200 underline"
              >
                Clear filters
              </button>
            )}
          </div>
        </section>

        {/* Results */}
        <section>
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="text-[11px] uppercase tracking-widest text-neutral-500">
              Results
            </h2>
            {data && (
              <span className="text-xs text-neutral-500">
                {loading ? "Loading…" : `${fmtNum(data.total)} customers · page ${page + 1} of ${totalPages || 1}`}
              </span>
            )}
          </div>

          <div className="rounded-lg border border-neutral-800 bg-neutral-900/30 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-neutral-900/80 text-[10px] uppercase tracking-wider text-neutral-500">
                <tr>
                  <th className="text-left px-4 py-2.5">Master ID</th>
                  <th className="text-left px-4 py-2.5">Customer</th>
                  <th className="text-left px-4 py-2.5">Contact</th>
                  <th className="text-left px-4 py-2.5">City</th>
                  <th className="text-left px-4 py-2.5">Tier</th>
                  <th className="text-center px-4 py-2.5">Sources</th>
                  <th className="text-right px-4 py-2.5">Orders</th>
                  <th className="text-right px-4 py-2.5">LTV</th>
                  <th className="text-left px-4 py-2.5">Last seen</th>
                </tr>
              </thead>
              <tbody>
                {data?.customers.map((c) => (
                  <tr
                    key={c.id}
                    className="border-t border-neutral-800/60 hover:bg-neutral-900/50 transition cursor-pointer"
                    onClick={() => (window.location.href = `/customers/${c.id}`)}
                  >
                    <td className="px-4 py-2 font-mono text-[11px] text-neutral-500">
                      <Link href={`/customers/${c.id}`}>{c.master_customer_id}</Link>
                    </td>
                    <td className="px-4 py-2">
                      <div className="font-medium">{c.full_name ?? "—"}</div>
                    </td>
                    <td className="px-4 py-2 text-xs font-mono text-neutral-400">
                      {c.primary_email && <div>{c.primary_email}</div>}
                      {c.primary_phone && <div className="text-neutral-500">{c.primary_phone}</div>}
                    </td>
                    <td className="px-4 py-2 text-neutral-300">{c.city ?? "—"}</td>
                    <td className="px-4 py-2">
                      {c.loyalty_tier ? <TierBadge tier={c.loyalty_tier} /> : <span className="text-neutral-600">—</span>}
                    </td>
                    <td className="px-4 py-2 text-center">
                      <SourceDots n={c.identity_count} />
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">{c.total_orders}</td>
                    <td className="px-4 py-2 text-right tabular-nums font-mono text-emerald-400/90">
                      {c.lifetime_value > 0 ? fmtInr(c.lifetime_value) : "—"}
                    </td>
                    <td className="px-4 py-2 text-xs text-neutral-400">
                      {fmtRelative(c.last_order_at)}
                    </td>
                  </tr>
                ))}
                {!loading && data?.customers.length === 0 && (
                  <tr>
                    <td colSpan={9} className="text-center py-10 text-sm text-neutral-500">
                      No customers match these filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between mt-3 text-sm">
              <button
                disabled={page === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 hover:bg-neutral-800 transition disabled:opacity-30"
              >
                ← Previous
              </button>
              <div className="text-xs text-neutral-500">
                Page {page + 1} of {totalPages}
              </div>
              <button
                disabled={page + 1 >= totalPages}
                onClick={() => setPage((p) => p + 1)}
                className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 hover:bg-neutral-800 transition disabled:opacity-30"
              >
                Next →
              </button>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

const TIER_COLORS: Record<string, string> = {
  bronze: "#b45309",
  silver: "#64748b",
  gold: "#ca8a04",
  platinum: "#7c3aed",
};
function TierBadge({ tier }: { tier: string }) {
  const c = TIER_COLORS[tier.toLowerCase()] ?? "#64748b";
  return (
    <span
      className="tier-pill"
      style={{
        color: c,
        background: `color-mix(in srgb, ${c}, transparent 88%)`,
      }}
    >
      {tier}
    </span>
  );
}

function SourceDots({ n }: { n: number }) {
  return (
    <div className="inline-flex items-center gap-0.5">
      {[1, 2, 3].map((i) => (
        <span
          key={i}
          className={`h-1.5 w-1.5 rounded-full ${
            i <= n ? "bg-emerald-500" : "bg-neutral-800"
          }`}
        />
      ))}
      <span className="ml-1.5 text-[11px] font-mono text-neutral-400 tabular-nums">{n}</span>
    </div>
  );
}
