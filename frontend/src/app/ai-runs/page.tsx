"use client";

import { useEffect, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { Stat } from "@/components/Stat";
import { SkeletonCard, SkeletonStat } from "@/components/Skeleton";
import { clearAIRuns, listAIRuns, type AIRun, type AIRunsResponse } from "@/lib/api";
import { useToast } from "@/components/Toast";
import { fmtNum } from "@/lib/format";

export default function AIRunsPage() {
  const [data, setData] = useState<AIRunsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<number | null>(null);
  const [clearing, setClearing] = useState(false);
  const toast = useToast();

  const refresh = async () => {
    setLoading(true);
    const r = await listAIRuns(100);
    setData(r);
    setLoading(false);
  };

  useEffect(() => {
    refresh();
  }, []);

  const onClearFallbacks = async () => {
    if (!confirm("Remove all fallback_used runs from the audit log? (Keeps ok + retry_used runs.)")) return;
    setClearing(true);
    const r = await clearAIRuns({ status: "fallback_used" });
    setClearing(false);
    if (r) {
      toast.success("Fallback runs cleared", `${r.deleted} entries removed.`);
      refresh();
    }
  };

  const onClearAll = async () => {
    if (!confirm("Wipe the entire AI audit log? This cannot be undone.")) return;
    setClearing(true);
    const r = await clearAIRuns({});
    setClearing(false);
    if (r) {
      toast.success("Audit log cleared", `${r.deleted} entries removed.`);
      refresh();
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen animate-fade-in">
        <PageHeader eyebrow="Intelligence" title="AI runs" />
        <div className="px-8 py-8 max-w-6xl space-y-6">
          <SkeletonCard rows={3} />
          <section className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {Array.from({ length: 4 }).map((_, i) => <SkeletonStat key={i} />)}
          </section>
          <SkeletonCard rows={6} />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <PageHeader
        eyebrow="Intelligence · Audit"
        title="AI runs"
        description="Every LLM call this app makes is captured here: provider, model, prompt version, validated output, latency, and any error. This is the audit trail that lets you defend AI decisions in front of a customer."
        actions={
          <div className="flex items-center gap-2">
            <button onClick={onClearFallbacks} disabled={clearing} className="neu-btn px-3 py-1.5 text-sm">
              Clear fallbacks
            </button>
            <button onClick={onClearAll} disabled={clearing} className="neu-btn px-3 py-1.5 text-sm text-c-rose">
              Clear all
            </button>
            <button onClick={refresh} className="neu-btn neu-btn-primary px-3 py-1.5 text-sm">
              Refresh
            </button>
          </div>
        }
      />

      <div className="px-8 py-8 max-w-6xl space-y-6">
        {/* Provider status */}
        {data?.provider_status && <ProviderStatus status={data.provider_status} />}

        {/* Summary stats */}
        {data && data.total > 0 && <SummaryStats runs={data.runs} total={data.total} />}

        {/* Runs list */}
        {data && data.total === 0 ? (
          <EmptyState
            title="No AI runs yet"
            description='Open a flagged customer and click "Explain merge with AI", or use the AI campaign planner — every LLM call lands here with provider, latency, validation, and full prompt/response.'
            actionLabel="Go to flagged customers"
            actionHref="/identities"
          />
        ) : (
          <section>
            <h2 className="text-[11px] uppercase tracking-widest text-neutral-500 mb-3">
              Run history
            </h2>
            <div className="space-y-2">
              {data?.runs.map((r) => (
                <RunRow
                  key={r.id}
                  run={r}
                  expanded={openId === r.id}
                  onToggle={() => setOpenId(openId === r.id ? null : r.id)}
                />
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function ProviderStatus({ status }: { status: AIRunsResponse["provider_status"] }) {
  const isStub = status.effective_provider === "stub";
  const tone = isStub
    ? "border-amber-500/30 bg-amber-500/[0.04]"
    : "border-emerald-500/30 bg-emerald-500/[0.04]";
  return (
    <section className={`rounded-lg border ${tone} p-4`}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-neutral-500 mb-1">
            Provider status
          </div>
          <div className="text-sm flex items-center gap-2 flex-wrap">
            <span className="text-neutral-400">Primary:</span>
            <span className="font-mono text-neutral-200">{status.configured_provider}</span>
            <span className="text-neutral-700">·</span>
            <span className="text-neutral-400">Effective:</span>
            <span
              className={`font-mono font-semibold ${
                isStub ? "text-amber-300" : "text-emerald-300"
              }`}
            >
              {status.effective_provider}
            </span>
            {status.fallback_provider && (
              <>
                <span className="text-neutral-700">·</span>
                <span className="text-neutral-400">Fallback:</span>
                <span className="font-mono font-semibold text-sky-300">
                  {status.fallback_provider}
                </span>
                <span className="text-[10px] text-sky-200/80">
                  (transparent on primary failure)
                </span>
              </>
            )}
          </div>
          {isStub && (
            <p className="mt-2 text-xs text-amber-200/80 max-w-2xl">
              No live LLM provider is configured — every AI surface falls back to a deterministic
              stub so the app remains fully functional. Configure a Gemini or Groq key on the
              backend to switch to real model calls.
            </p>
          )}
        </div>
        <div className="flex flex-col gap-1 text-[11px] text-neutral-400">
          <KeyBadge label="Gemini key · gemini-2.5-flash" present={status.has_gemini_key} />
          <KeyBadge label="Groq key · openai/gpt-oss-120b" present={status.has_groq_key} />
        </div>
      </div>
    </section>
  );
}

function KeyBadge({ label, present }: { label: string; present: boolean }) {
  return (
    <div className="flex items-center gap-1.5">
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          present ? "bg-emerald-500" : "bg-neutral-700"
        }`}
      />
      <span>{label}</span>
    </div>
  );
}

function SummaryStats({ runs, total }: { runs: AIRun[]; total: number }) {
  const ok = runs.filter((r) => r.validation_status === "ok").length;
  const retry = runs.filter((r) => r.validation_status === "retry_used").length;
  const fallback = runs.filter((r) => r.validation_status === "fallback_used").length;
  // Success = real LLM served the request (with or without retry). Fallback
  // only counts when the deterministic safety net had to take over.
  const succeeded = ok + retry;
  const successRate = runs.length > 0 ? succeeded / runs.length : 1;
  const avgLatency =
    runs.length > 0
      ? Math.round(
          runs.filter((r) => r.latency_ms).reduce((s, r) => s + (r.latency_ms ?? 0), 0) /
            Math.max(1, runs.filter((r) => r.latency_ms).length)
        )
      : 0;
  return (
    <section className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      <Stat label="Total runs" value={fmtNum(total)} tone="xeno" />
      <Stat
        label="Success rate"
        value={`${(successRate * 100).toFixed(1)}%`}
        tone={successRate >= 0.9 ? "emerald" : successRate >= 0.7 ? "sky" : "amber"}
        sub={`${fmtNum(succeeded)} of ${fmtNum(runs.length)} runs`}
        animate={false}
      />
      <Stat
        label="Avg latency"
        value={`${avgLatency}ms`}
        tone="violet"
        sub="real LLM calls only"
      />
      <Stat
        label="Fallback caught"
        value={fmtNum(fallback)}
        tone={fallback > 0 ? "amber" : "emerald"}
        sub={fallback > 0 ? "deterministic safety net saved the UI" : "no failures needed"}
      />
    </section>
  );
}

function RunRow({
  run,
  expanded,
  onToggle,
}: {
  run: AIRun;
  expanded: boolean;
  onToggle: () => void;
}) {
  const status = run.validation_status;
  const statusTone =
    status === "ok"
      ? "text-emerald-400"
      : status === "retry_used"
      ? "text-sky-400"
      : status === "fallback_used"
      ? "text-amber-400"
      : "text-red-400";
  return (
    <div className="rounded-md border border-neutral-800 bg-neutral-900/30 overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full text-left px-4 py-2.5 hover:bg-neutral-900/60 transition flex items-center gap-3"
      >
        <div className="font-mono text-[11px] text-neutral-500 w-10 tabular-nums">
          #{run.id}
        </div>
        <div className="text-xs rounded bg-neutral-800 px-1.5 py-0.5 text-neutral-300">
          {run.purpose}
        </div>
        <div className="text-xs text-neutral-500 font-mono">
          {run.provider}/{run.model}
        </div>
        <div className="flex-1 text-xs text-neutral-300 truncate">
          {run.input_summary}
        </div>
        <div className={`text-xs ${statusTone}`}>{status}</div>
        <div className="text-xs font-mono text-neutral-500 tabular-nums w-16 text-right">
          {run.latency_ms != null ? `${run.latency_ms}ms` : "—"}
        </div>
        <div className="text-xs text-neutral-600">{expanded ? "▴" : "▾"}</div>
      </button>

      {expanded && (
        <div className="border-t border-neutral-800/60 bg-neutral-950/40 p-4 space-y-3">
          <div className="grid sm:grid-cols-3 gap-3 text-xs">
            <KV label="Prompt version" value={run.prompt_version} />
            <KV label="Provider" value={`${run.provider} (${run.model})`} />
            <KV label="Created" value={run.created_at ? new Date(run.created_at).toLocaleString() : "—"} />
          </div>

          {run.error && (
            <div className="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">
              <div className="text-[10px] uppercase tracking-wider text-red-400 mb-0.5">
                Error
              </div>
              <div className="font-mono break-all">{run.error}</div>
            </div>
          )}

          {run.parsed_output ? (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-neutral-500 mb-1">
                Parsed output
              </div>
              <pre className="rounded border border-neutral-800 bg-neutral-950 px-3 py-2 text-[11px] font-mono text-neutral-200 overflow-x-auto whitespace-pre-wrap">
                {JSON.stringify(run.parsed_output, null, 2)}
              </pre>
            </div>
          ) : null}

          {run.raw_output && (
            <details className="text-xs">
              <summary className="cursor-pointer text-neutral-500 hover:text-neutral-300">
                Raw LLM output
              </summary>
              <pre className="mt-2 rounded border border-neutral-800 bg-neutral-950 px-3 py-2 text-[11px] font-mono text-neutral-400 overflow-x-auto whitespace-pre-wrap">
                {run.raw_output}
              </pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

function KV({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-neutral-800 bg-neutral-950/40 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-neutral-500">{label}</div>
      <div className="mt-0.5 text-xs font-mono text-neutral-200">{value}</div>
    </div>
  );
}
