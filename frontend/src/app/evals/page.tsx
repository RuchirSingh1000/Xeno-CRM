"use client";

/** AI eval harness — UI surface for the campaign-planner test suite.
 *
 * Shows pass/fail per case, provider/latency, failure reasons inline, and a
 * "Run now" button that re-executes the whole suite. The harness lives in
 * backend/crm-api/evals; this page renders the cached last_run.json so the
 * default load is instant, and lets the operator trigger a fresh run on demand.
 *
 * Why this exists: most AI take-homes can't answer "how often does it work?"
 * with a number. This page is that number, with the failing assertions visible.
 */

import { useEffect, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { Stat } from "@/components/Stat";
import { SkeletonCard, SkeletonStat } from "@/components/Skeleton";
import { AILoader } from "@/components/AILoader";
import { useToast } from "@/components/Toast";
import { useAIThinking } from "@/components/AIThinking";
import {
  getLastEvalRun,
  runEvalsNow,
  type EvalCaseResult,
  type EvalRunSummary,
} from "@/lib/api";
import { fmtNum, fmtPct, fmtRelative } from "@/lib/format";

export default function EvalsPage() {
  const [data, setData] = useState<EvalRunSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [filter, setFilter] = useState<"all" | "pass" | "fail">("all");
  const toast = useToast();
  const ai = useAIThinking();

  const refresh = async () => {
    const r = await getLastEvalRun();
    setData(r);
    setLoading(false);
  };

  useEffect(() => {
    refresh();
  }, []);

  const onRunNow = async () => {
    setRunning(true);
    const r = await ai.run(
      "Re-running eval harness (real LLM calls, ~90s)…",
      () => runEvalsNow(),
    );
    setRunning(false);
    if (!r) {
      toast.error("Eval run failed", "Check the server logs.");
      return;
    }
    setData(r);
    toast.success(
      "Eval suite complete",
      `${r.passing}/${r.total} passed (${r.pct.toFixed(1)}%) in ${r.elapsed_seconds.toFixed(1)}s`,
    );
  };

  if (loading) {
    return (
      <div className="min-h-screen animate-fade-in">
        <PageHeader eyebrow="Intelligence" title="AI evals" />
        <div className="px-8 py-8 max-w-6xl space-y-6">
          <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {Array.from({ length: 4 }).map((_, i) => <SkeletonStat key={i} />)}
          </section>
          <SkeletonCard rows={5} />
        </div>
      </div>
    );
  }

  if (!data || data.never_run) {
    return (
      <div className="min-h-screen animate-fade-in">
        <PageHeader
          eyebrow="Intelligence"
          title="AI evals"
          description="Structural test suite for the AI campaign planner — 15 hand-written goal cases with Pydantic-validated assertions. Re-run from here, or via the CLI."
          actions={
            <button onClick={onRunNow} disabled={running} className="neu-btn neu-btn-primary px-4 py-1.5 text-sm">
              {running ? <AILoader label="Running…" /> : "Run suite now"}
            </button>
          }
        />
        <div className="px-8 py-8 max-w-3xl">
          <div className="neu-inset-sm p-6 text-center text-sm text-[var(--neu-text-muted)]">
            No cached run yet. Click <strong>Run suite now</strong> to execute the harness — takes ~90s for 15 cases.
          </div>
        </div>
      </div>
    );
  }

  const results = data.results.filter((r) => {
    if (filter === "pass") return r.passed;
    if (filter === "fail") return !r.passed;
    return true;
  });

  // Per-provider summary
  const byProvider = data.results.reduce<Record<string, { total: number; passed: number }>>((acc, r) => {
    const k = r.provider || "unknown";
    if (!acc[k]) acc[k] = { total: 0, passed: 0 };
    acc[k].total += 1;
    if (r.passed) acc[k].passed += 1;
    return acc;
  }, {});

  const avgLatency = data.results.length > 0
    ? Math.round(data.results.reduce((s, r) => s + r.latency_ms, 0) / data.results.length)
    : 0;
  const failingCount = data.total - data.passing;

  return (
    <div className="min-h-screen animate-fade-in">
      <PageHeader
        eyebrow="Intelligence"
        title="AI evals"
        description="Structural test suite for the AI campaign planner. Each case feeds the planner a natural-language goal and asserts properties on the structured output — not on text, so the LLM can vary phrasing without breaking the suite."
        actions={
          <div className="flex items-center gap-2">
            <button onClick={refresh} className="neu-btn px-3 py-1.5 text-sm">
              Refresh
            </button>
            <button onClick={onRunNow} disabled={running} className="neu-btn neu-btn-primary px-4 py-1.5 text-sm">
              {running ? <AILoader label="Running…" /> : "Run suite now"}
            </button>
          </div>
        }
      />

      <div className="px-8 py-8 max-w-6xl space-y-6">
        {/* Top strip */}
        <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Stat
            label="Passing"
            value={`${data.passing}/${data.total}`}
            tone={data.pct === 100 ? "emerald" : data.pct >= 80 ? "sky" : "amber"}
            sub={`${fmtPct(data.pct / 100)} pass rate`}
          />
          <Stat
            label="Failing"
            value={fmtNum(failingCount)}
            tone={failingCount === 0 ? "emerald" : "rose"}
            sub={failingCount === 0 ? "all green" : "needs attention"}
          />
          <Stat
            label="Avg latency"
            value={`${avgLatency}ms`}
            tone="violet"
            sub="per LLM call"
          />
          <Stat
            label="Total elapsed"
            value={`${data.elapsed_seconds.toFixed(1)}s`}
            tone="amber"
            sub={data.generated_at ? `ran ${fmtRelative(data.generated_at)}` : "—"}
          />
        </section>

        {/* Per-provider breakdown */}
        <section className="grid sm:grid-cols-2 gap-4">
          <div className="neu-card p-5">
            <div className="text-[10px] uppercase tracking-wider text-c-violet font-semibold mb-3">
              Providers used
            </div>
            <div className="space-y-2">
              {Object.entries(byProvider).map(([provider, { total, passed }]) => {
                const pct = total > 0 ? (passed / total) * 100 : 0;
                const tone = pct === 100 ? "var(--c-emerald)" : pct >= 80 ? "var(--c-sky)" : "var(--c-amber)";
                return (
                  <div key={provider}>
                    <div className="flex items-baseline justify-between text-xs mb-1">
                      <span className="font-mono text-[var(--neu-text)]">{provider}</span>
                      <span className="font-mono text-[var(--neu-text-muted)] tabular-nums">
                        {passed}/{total} ({pct.toFixed(0)}%)
                      </span>
                    </div>
                    <div className="h-2 rounded-full bg-[var(--neu-shadow-dark-soft)] overflow-hidden">
                      <div className="h-full bar-fill rounded-full" style={{ width: `${pct}%`, background: tone }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="neu-card p-5">
            <div className="text-[10px] uppercase tracking-wider text-c-amber font-semibold mb-3">
              Why this exists
            </div>
            <p className="text-xs text-[var(--neu-text-muted)] leading-relaxed mb-2">
              Most AI take-homes can answer "does it work?" but not "<em>how often</em>". This suite
              gives a number. Each case is a natural-language goal; assertions check structural
              properties of the planner's output — channel mix, audience filters, template variables,
              compliance flags.
            </p>
            <p className="text-xs text-[var(--neu-text-muted)] leading-relaxed">
              Run via the button above or the CLI: <code className="text-c-violet">python evals/run_evals.py</code>.
              Cached in <code className="text-c-violet">evals/last_run.json</code>.
            </p>
          </div>
        </section>

        {/* Filter + results */}
        <section>
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="text-[11px] uppercase tracking-widest text-[var(--neu-text-subtle)] font-semibold">
              Per-case results
            </h2>
            <div className="flex items-center gap-1 text-xs">
              <span className="text-[var(--neu-text-subtle)] mr-1">Filter:</span>
              {(["all", "pass", "fail"] as const).map((f) => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={`rounded px-2 py-0.5 transition border ${
                    filter === f
                      ? "bg-[var(--c-violet)]/15 text-c-violet border-c-violet/40"
                      : "text-[var(--neu-text-subtle)] border-transparent hover:text-[var(--neu-text)]"
                  }`}
                >
                  {f === "all" ? `all (${data.total})` : f === "pass" ? `pass (${data.passing})` : `fail (${failingCount})`}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            {results.map((r) => (
              <CaseRow key={r.id} result={r} />
            ))}
            {results.length === 0 && (
              <div className="neu-inset-sm p-6 text-center text-sm text-[var(--neu-text-subtle)]">
                No cases match this filter.
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function CaseRow({ result }: { result: EvalCaseResult }) {
  const [open, setOpen] = useState(!result.passed);
  return (
    <div
      className={`neu-card p-4 border-l-4 ${
        result.passed ? "border-l-[var(--c-emerald)]" : "border-l-[var(--c-rose)]"
      }`}
    >
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-3 text-left"
      >
        <span
          className={`shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-full text-[11px] font-bold ${
            result.passed
              ? "bg-[var(--c-emerald)]/15 text-c-emerald"
              : "bg-[var(--c-rose)]/15 text-c-rose"
          }`}
        >
          {result.passed ? "✓" : "✕"}
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-mono text-[var(--neu-text)] truncate">{result.id}</div>
          {result.input_goal && (
            <div className="text-[11px] text-[var(--neu-text-subtle)] mt-0.5 truncate italic">
              “{result.input_goal}”
            </div>
          )}
        </div>
        <div className="flex items-center gap-3 shrink-0 text-[10px] font-mono">
          <span className="text-[var(--neu-text-subtle)]">{result.provider}</span>
          <span className="text-[var(--neu-text-subtle)]">{result.latency_ms}ms</span>
          <span
            className={
              result.validation_status === "ok"
                ? "text-c-emerald"
                : result.validation_status === "retry_used"
                ? "text-c-sky"
                : "text-c-amber"
            }
          >
            {result.validation_status}
          </span>
          <span className="text-[var(--neu-text-subtle)] w-3 text-center">{open ? "▾" : "▸"}</span>
        </div>
      </button>

      {open && (
        <div className="mt-3 pt-3 border-t border-[var(--neu-shadow-dark-soft)] space-y-2">
          {result.expected_summary && result.expected_summary.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-[var(--neu-text-subtle)] font-semibold mb-1">
                Assertions checked
              </div>
              <div className="flex flex-wrap gap-1">
                {result.expected_summary.map((k) => (
                  <span
                    key={k}
                    className="text-[10px] font-mono px-2 py-0.5 rounded neu-inset-sm text-[var(--neu-text-muted)]"
                  >
                    {k}
                  </span>
                ))}
              </div>
            </div>
          )}
          {result.failures.length > 0 ? (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-c-rose font-semibold mb-1">
                Failing assertions ({result.failures.length})
              </div>
              <ul className="space-y-1">
                {result.failures.map((f, i) => (
                  <li key={i} className="text-[11px] font-mono text-c-rose neu-inset-sm px-2.5 py-1.5">
                    {f}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="text-[11px] text-c-emerald">
              ✓ All structural assertions pass.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
