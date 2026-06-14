"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { SourceBadge } from "@/components/SourceBadge";
import { Stat } from "@/components/Stat";
import {
  aiIngestCustomers,
  getCustomerStats,
  getDataQuality,
  getIdentityDashboard,
  ingestAllSeed,
  ingestSource,
  listBatches,
  resetAll,
  runResolution,
  type AIIngestResponse,
  type DataQualityReport,
  type IdentityDashboard,
  type ImportBatch,
  type ResolutionResult,
} from "@/lib/api";
import { fmtNum, fmtPct, sourceLabel } from "@/lib/format";
import { useToast } from "@/components/Toast";
import { CsvMapper } from "@/components/CsvMapper";
import { AILoader } from "@/components/AILoader";
import { useAIThinking } from "@/components/AIThinking";

type RunState = "idle" | "ingesting" | "resolving" | "done";

export default function IngestPage() {
  const [batches, setBatches] = useState<ImportBatch[]>([]);
  const [dq, setDq] = useState<DataQualityReport | null>(null);
  const [dash, setDash] = useState<IdentityDashboard | null>(null);
  const [lastResult, setLastResult] = useState<ResolutionResult | null>(null);
  const [runState, setRunState] = useState<RunState>("idle");
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const ai = useAIThinking();

  // AI customer ingest panel
  const [aiOpen, setAiOpen] = useState(false);
  const [aiTab, setAiTab] = useState<"nl" | "csv">("csv");
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiPreview, setAiPreview] = useState<AIIngestResponse | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);

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
    getCustomerStats().catch(() => {});
    refresh();
  };

  const AI_INGEST_SAMPLES = [
    "Add Rohit Sharma, phone 9876543210, email rohit.sharma@gmail.com, Bengaluru, gold tier.",
    "Add 2 new customers: Priya Mehta in Mumbai with phone 9988776655 (silver tier); and Arjun Reddy in Hyderabad, email arjun@example.com.",
    "Quick add: Neha Iyer, Chennai, +91-98765-12345, opted out of SMS.",
  ];

  const refresh = async () => {
    const [b, q, d] = await Promise.all([listBatches(), getDataQuality(), getIdentityDashboard()]);
    setBatches(b);
    setDq(q);
    setDash(d);
  };

  useEffect(() => {
    refresh();
  }, []);

  const onSeedAll = async () => {
    setError(null);
    setRunState("ingesting");
    try {
      await ingestAllSeed();
      await refresh();
      setRunState("idle");
      toast.success("Seed data ingested", "All three sources staged. Run identity resolution next.");
    } catch (e) {
      setError(String(e));
      setRunState("idle");
      toast.error("Ingest failed", String(e));
    }
  };

  const onResolve = async () => {
    setError(null);
    setRunState("resolving");
    try {
      const r = await runResolution();
      setLastResult(r);
      await refresh();
      setRunState("done");
      if (r) {
        toast.success(
          "Resolution complete",
          `${r.customers_created} canonical customers from ${r.staged_rows} staged rows.`
        );
      }
    } catch (e) {
      setError(String(e));
      setRunState("idle");
      toast.error("Resolution failed", String(e));
    }
  };

  const onReset = async () => {
    if (!confirm("Reset will wipe staged records, canonical customers, identities, consent, and orders. Continue?")) {
      return;
    }
    setError(null);
    await resetAll();
    setLastResult(null);
    await refresh();
    toast.info("Reset complete", "All staged + canonical data cleared.");
  };

  const sourceMap: Record<string, ImportBatch | undefined> = Object.fromEntries(
    batches.map((b) => [b.source_type, b])
  );

  const hasStaged = batches.length > 0;
  const hasResolved = (dash?.canonical_total ?? 0) > 0;

  return (
    <div className="min-h-screen animate-fade-in">
      <PageHeader
        eyebrow="Ingestion"
        title="Ingest source data"
        description="Upload POS, ecommerce, and loyalty CSVs — or use the seeded Brewhouse Co. data. Once all three are staged, run identity resolution to collapse them into canonical customers with provenance."
        actions={
          <div className="flex items-center gap-2">
            <button
              onClick={() => setAiOpen(!aiOpen)}
              className="neu-btn neu-btn-primary px-3 py-1.5 text-sm"
            >
              {aiOpen ? "Close AI ingest" : "AI ingest"}
            </button>
            <button
              onClick={onReset}
              className="neu-btn px-3 py-1.5 text-sm"
            >
              Reset
            </button>
            <button
              onClick={refresh}
              className="neu-btn px-3 py-1.5 text-sm"
            >
              Refresh
            </button>
          </div>
        }
      />

      <div className="px-8 py-8 max-w-6xl space-y-8">
        {/* Unified AI ingest panel: tab between bulk CSV and quick NL add */}
        {aiOpen && (
          <section className="neu-card accent-violet p-5 animate-fade-in">
            <div className="flex items-center justify-between gap-3 mb-3">
              <div className="text-[10px] uppercase tracking-widest text-c-violet font-semibold">
                AI · customer ingest
              </div>
              <div className="inline-flex rounded-md neu-inset-sm p-0.5 text-xs">
                <button
                  onClick={() => setAiTab("csv")}
                  className={`px-3 py-1 rounded ${aiTab === "csv" ? "bg-[var(--c-violet)]/20 text-c-violet font-semibold" : "text-[var(--neu-text-muted)] hover:text-c-violet"}`}
                >
                  Messy CSV (bulk)
                </button>
                <button
                  onClick={() => setAiTab("nl")}
                  className={`px-3 py-1 rounded ${aiTab === "nl" ? "bg-[var(--c-violet)]/20 text-c-violet font-semibold" : "text-[var(--neu-text-muted)] hover:text-c-violet"}`}
                >
                  Natural-language (quick add)
                </button>
              </div>
            </div>

            {aiTab === "csv" && <CsvMapper bare onApplied={refresh} />}

            {aiTab === "nl" && (
              <div className="animate-fade-in">
                <p className="text-sm text-[var(--neu-text-muted)] max-w-2xl mb-3">
                  Describe a handful of new customers in plain English. Phone formats are normalized;
                  consent defaults to opted-in unless the prompt says otherwise. Best for ad-hoc
                  entries — for bulk import from a real source system, use Messy CSV.
                </p>

            <textarea
              value={aiPrompt}
              onChange={(e) => setAiPrompt(e.target.value)}
              placeholder='e.g., "Add Rohit Sharma, phone 9876543210, email rohit@gmail.com, from Bengaluru, gold tier."'
              rows={3}
              className="w-full neu-input p-3 text-sm font-mono"
            />

            <div className="mt-3 flex flex-wrap gap-1.5">
              <span className="text-[11px] text-[var(--neu-text-subtle)] mr-1">Try:</span>
              {AI_INGEST_SAMPLES.map((p) => (
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
              </div>
            )}
          </section>
        )}

        {/* Headline action panel */}
        <section className="rounded-lg border border-neutral-800 bg-gradient-to-br from-neutral-900/70 to-neutral-900/10 p-6">
          <div className="flex items-start justify-between gap-6">
            <div className="min-w-0">
              <div className="text-[10px] uppercase tracking-widest text-emerald-400 mb-1.5">
                One-click demo
              </div>
              <div className="text-lg font-semibold">Ingest all three seed CSVs, then resolve identities.</div>
              <p className="text-sm text-neutral-400 mt-1 max-w-2xl">
                Uses the generated Brewhouse Co. data: 1,002 POS rows · 988 Shopify rows · 973 loyalty rows.
                Resolution collapses these via phone exact / email exact / phone+name fuzzy / name+city fuzzy rules,
                then ingests 5,000 orders against the resolved customers.
              </p>
            </div>
            <div className="shrink-0 flex flex-col gap-2 min-w-[180px]">
              <button
                onClick={onSeedAll}
                disabled={runState !== "idle"}
                className="rounded-md border border-neutral-700 bg-neutral-900 px-4 py-2 text-sm hover:bg-neutral-800 transition disabled:opacity-50"
              >
                {runState === "ingesting" ? "Ingesting…" : "1. Ingest seed data"}
              </button>
              <button
                onClick={onResolve}
                disabled={!hasStaged || runState !== "idle"}
                className="rounded-md border border-emerald-500/40 bg-emerald-500/10 text-emerald-300 px-4 py-2 text-sm hover:bg-emerald-500/20 transition disabled:opacity-30"
              >
                {runState === "resolving" ? "Resolving…" : "2. Run identity resolution"}
              </button>
            </div>
          </div>

          {error && (
            <div className="mt-4 rounded border border-red-500/40 bg-red-500/10 text-red-300 px-3 py-2 text-xs">
              {error}
            </div>
          )}
        </section>

        {/* Source upload zones */}
        <section>
          <SectionHeader title="Source systems" />
          <div className="grid lg:grid-cols-3 gap-3">
            {(["pos", "ecommerce", "loyalty"] as const).map((src) => (
              <SourceZone
                key={src}
                source={src}
                batch={sourceMap[src]}
                disabled={runState !== "idle"}
                onComplete={refresh}
              />
            ))}
          </div>
        </section>

        {/* Last resolution result */}
        {lastResult && (
          <section>
            <SectionHeader title="Last resolution run" />
            <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-5">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <Stat
                  label="Staged rows"
                  value={fmtNum(lastResult.staged_rows)}
                />
                <Stat
                  label="Canonical customers"
                  value={fmtNum(lastResult.customers_created)}
                  tone="emerald"
                />
                <Stat
                  label="Dedup rate"
                  value={fmtPct(lastResult.deduplication_rate)}
                  sub="staged → canonical"
                />
                <Stat
                  label="Flagged for review"
                  value={fmtNum(lastResult.flagged_components)}
                  tone="amber"
                  sub="lower-confidence merges"
                />
              </div>

              <div className="grid sm:grid-cols-2 gap-3 mt-4">
                <RuleMix counts={lastResult.rule_counts} />
                <ComponentSize dist={lastResult.component_size_distribution} />
              </div>

              {lastResult.orders && (
                <div className="mt-4 rounded-md border border-neutral-800 bg-neutral-950/60 p-3 text-xs text-neutral-400">
                  <span className="text-neutral-200 font-medium">Orders:</span>{" "}
                  {fmtNum(lastResult.orders.orders_ingested)} ingested · {fmtPct(lastResult.orders.match_rate)} matched to a canonical customer · {fmtNum(lastResult.orders.unattributed)} unattributed
                </div>
              )}

              <div className="mt-4 flex items-center gap-3">
                <Link
                  href="/identities"
                  className="text-xs text-emerald-300 hover:text-emerald-200"
                >
                  Open identity resolution dashboard →
                </Link>
                <Link
                  href="/customers"
                  className="text-xs text-emerald-300 hover:text-emerald-200"
                >
                  Browse canonical customers →
                </Link>
              </div>
            </div>
          </section>
        )}

        {/* Current state */}
        {hasResolved && !lastResult && dash && (
          <section>
            <SectionHeader title="Current state" />
            <div className="rounded-lg border border-neutral-800 bg-neutral-900/30 p-5">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <Stat label="Staged" value={fmtNum(dash.staged_total)} tone="violet" />
                <Stat label="Canonical" value={fmtNum(dash.canonical_total)} tone="emerald" />
                <Stat label="Dedup rate" value={fmtPct(dash.deduplication_rate)} tone="sky" />
                <Stat label="Flagged" value={fmtNum(dash.flagged_count)} tone={dash.flagged_count > 0 ? "amber" : "emerald"} />
              </div>
            </div>
          </section>
        )}

        {/* DQ report */}
        {dq && dq.total_rows > 0 && (
          <section>
            <SectionHeader title="Data quality report" />
            <div className="rounded-lg border border-neutral-800 bg-neutral-900/30 p-5">
              <div className="flex items-baseline justify-between mb-3">
                <div className="text-sm">
                  <span className="text-neutral-200 font-medium">
                    {fmtNum(dq.total_rows)} rows
                  </span>{" "}
                  <span className="text-neutral-500">scanned across all batches</span>
                </div>
                <div className="text-sm">
                  <span className="text-neutral-500">Overall completeness:</span>{" "}
                  <span className="text-emerald-400 font-semibold">{fmtPct(dq.overall_completeness, 1)}</span>
                </div>
              </div>
              <div className="grid lg:grid-cols-3 gap-3">
                {Object.entries(dq.by_source).map(([src, info]) => (
                  <SourceDQ key={src} source={src} info={info} />
                ))}
              </div>
              {dq.cross_source && (dq.cross_source.likely_merges_estimate > 0) && (
                <div className="mt-4 rounded-md border border-sky-500/30 bg-sky-500/[0.05] p-3">
                  <div className="text-[10px] uppercase tracking-widest text-sky-300 mb-1.5">
                    Cross-source overlap detected
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-2">
                    <Stat
                      label="Phone keys in 2+ sources"
                      value={fmtNum(dq.cross_source.phone_cross_source_keys)}
                      tone="sky"
                    />
                    <Stat
                      label="Email keys in 2+ sources"
                      value={fmtNum(dq.cross_source.email_cross_source_keys)}
                      tone="sky"
                    />
                    <Stat
                      label="In all 3 sources (phone)"
                      value={fmtNum(dq.cross_source.triple_source_phone)}
                      tone="emerald"
                    />
                    <Stat
                      label="Likely merges"
                      value={fmtNum(dq.cross_source.likely_merges_estimate)}
                      tone="emerald"
                      sub="resolution will collapse"
                    />
                  </div>
                  <p className="text-xs text-sky-200/70 leading-relaxed">
                    This is the FDE&apos;s preview of how much work identity resolution has to do.
                    Within-source data is clean, but the same customer appears across systems with
                    different formats. Run resolution next to collapse them.
                  </p>
                </div>
              )}
              <p className="text-xs text-neutral-500 mt-4 leading-relaxed">
                Within-source data is internally consistent — the FDE work is in cross-source resolution.
              </p>
            </div>
          </section>
        )}

        {/* Batches table */}
        {batches.length > 0 && (
          <section>
            <SectionHeader title="Import batches" />
            <div className="rounded-lg border border-neutral-800 bg-neutral-900/30 overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-neutral-900/80 text-[10px] uppercase tracking-wider text-neutral-500">
                  <tr>
                    <th className="text-left px-4 py-2">#</th>
                    <th className="text-left px-4 py-2">Source</th>
                    <th className="text-left px-4 py-2">Filename</th>
                    <th className="text-right px-4 py-2">Rows</th>
                    <th className="text-left px-4 py-2">Status</th>
                    <th className="text-left px-4 py-2">Completed</th>
                  </tr>
                </thead>
                <tbody>
                  {batches.map((b) => (
                    <tr key={b.id} className="border-t border-neutral-800/60">
                      <td className="px-4 py-2 font-mono text-xs text-neutral-500">{b.id}</td>
                      <td className="px-4 py-2"><SourceBadge source={b.source_type} /></td>
                      <td className="px-4 py-2 font-mono text-xs text-neutral-300">{b.filename}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{fmtNum(b.row_count)}</td>
                      <td className="px-4 py-2 text-xs">
                        <span className="text-emerald-400">{b.status}</span>
                      </td>
                      <td className="px-4 py-2 text-xs text-neutral-500">
                        {b.completed_at ? new Date(b.completed_at).toLocaleString() : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function SectionHeader({ title }: { title: string }) {
  return (
    <h2 className="text-[11px] uppercase tracking-widest text-neutral-500 mb-3">{title}</h2>
  );
}

function SourceZone({
  source,
  batch,
  disabled,
  onComplete,
}: {
  source: "pos" | "ecommerce" | "loyalty";
  batch: ImportBatch | undefined;
  disabled: boolean;
  onComplete: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const onSeed = async () => {
    setBusy(true);
    try {
      await ingestSource(source);
      onComplete();
    } finally {
      setBusy(false);
    }
  };

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    try {
      await ingestSource(source, file);
      onComplete();
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const isDone = !!batch && batch.status === "completed";

  return (
    <div className={`rounded-lg border p-4 ${isDone ? "border-emerald-500/30 bg-emerald-500/[0.04]" : "border-neutral-800 bg-neutral-900/30"}`}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2.5">
          <SourceBadge source={source} size="md" />
          <span className="text-sm font-medium">{sourceLabel(source)} export</span>
        </div>
        {isDone && (
          <span className="text-[10px] font-mono uppercase tracking-wider text-emerald-400">
            ✓ staged
          </span>
        )}
      </div>

      {batch ? (
        <div className="text-xs text-neutral-400 mb-3">
          <div className="font-mono text-neutral-500 truncate">{batch.filename}</div>
          <div className="mt-1">{fmtNum(batch.row_count)} rows · batch #{batch.id}</div>
        </div>
      ) : (
        <div className="text-xs text-neutral-500 mb-3">No batch yet</div>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          onClick={onSeed}
          disabled={disabled || busy}
          className="text-xs rounded-md border border-neutral-700 bg-neutral-900 px-2.5 py-1 hover:bg-neutral-800 transition disabled:opacity-50"
        >
          {busy ? "…" : isDone ? "Re-ingest seed" : "Use seed file"}
        </button>
        <label
          className={`text-xs rounded-md border border-neutral-700 bg-neutral-900 px-2.5 py-1 hover:bg-neutral-800 transition cursor-pointer ${
            disabled || busy ? "opacity-50 pointer-events-none" : ""
          }`}
        >
          Upload CSV
          <input ref={inputRef} type="file" accept=".csv" hidden onChange={onFile} />
        </label>
      </div>
    </div>
  );
}

function SourceDQ({
  source,
  info,
}: {
  source: string;
  info: DataQualityReport["by_source"][string];
}) {
  const failedChecks = Object.entries(info.checks).filter(([, v]) => (v as number) > 0);
  return (
    <div className="rounded-md border border-neutral-800 bg-neutral-950/40 p-3">
      <div className="flex items-center justify-between mb-2">
        <SourceBadge source={source} />
        <div className="text-xs">
          <span className="text-neutral-500">Score </span>
          <span className="text-emerald-400 font-semibold">{fmtPct(info.completeness_score)}</span>
        </div>
      </div>
      <div className="text-xs text-neutral-500 mb-2">{fmtNum(info.rows)} rows · {info.issues_total} issues</div>
      {failedChecks.length > 0 ? (
        <ul className="space-y-0.5">
          {failedChecks.map(([k, v]) => (
            <li key={k} className="text-[11px] text-amber-300 font-mono">
              {k}: {v as number}
            </li>
          ))}
        </ul>
      ) : (
        <div className="text-[11px] text-neutral-500">No issues caught at source level</div>
      )}
    </div>
  );
}

function RuleMix({ counts }: { counts: Record<string, number> }) {
  const total = Object.values(counts).reduce((s, n) => s + n, 0);
  const labels: Record<string, string> = {
    phone_exact: "Phone exact",
    email_exact: "Email exact",
    phone8_name_city: "Phone₈ + name + city",
    name_city_only: "Name + city (flagged)",
  };
  const colors: Record<string, string> = {
    phone_exact: "bg-emerald-500",
    email_exact: "bg-sky-500",
    phone8_name_city: "bg-amber-500",
    name_city_only: "bg-red-500",
  };
  return (
    <div className="rounded-md border border-neutral-800 bg-neutral-950/40 p-3">
      <div className="text-[10px] uppercase tracking-wider text-neutral-500 mb-2">
        Rule mix
      </div>
      <div className="space-y-2">
        {Object.entries(counts).map(([rule, n]) => {
          const pct = total > 0 ? (n / total) * 100 : 0;
          return (
            <div key={rule}>
              <div className="flex items-center justify-between text-xs mb-1">
                <span className="text-neutral-300">{labels[rule] ?? rule}</span>
                <span className="font-mono text-neutral-500 tabular-nums">
                  {fmtNum(n)} ({pct.toFixed(0)}%)
                </span>
              </div>
              <div className="h-1 rounded-full bg-neutral-800 overflow-hidden">
                <div className={`h-full ${colors[rule] ?? "bg-neutral-500"}`} style={{ width: `${pct}%` }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ComponentSize({ dist }: { dist: Record<string, number> }) {
  return (
    <div className="rounded-md border border-neutral-800 bg-neutral-950/40 p-3">
      <div className="text-[10px] uppercase tracking-wider text-neutral-500 mb-2">
        Customers by source coverage
      </div>
      <div className="space-y-1.5">
        {Object.entries(dist)
          .sort(([a], [b]) => Number(a) - Number(b))
          .map(([size, count]) => (
            <div key={size} className="flex items-center justify-between text-xs">
              <span className="text-neutral-400">
                {size} source{size === "1" ? "" : "s"}
              </span>
              <span className="font-mono text-neutral-300 tabular-nums">{fmtNum(count)}</span>
            </div>
          ))}
      </div>
    </div>
  );
}
