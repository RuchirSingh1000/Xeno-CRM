"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { ChannelBadge } from "@/components/ChannelBadge";
import { Stat } from "@/components/Stat";
import {
  aiPlanCreate,
  autopilotNext,
  getCampaign,
  getCampaignFunnel,
  getCampaignInsight,
  launchCampaignNow,
  listSegments,
  previewCampaign,
  retryQueued,
  updateCampaign,
  type AutopilotNextResponse,
  type CampaignFunnel,
  type CampaignIn,
  type CampaignInsightResponse,
  type CampaignPreview,
  type CampaignRow,
  type LaunchResult,
  type RetryQueuedResult,
  type SegmentRow,
} from "@/lib/api";
import { fmtNum, fmtPct } from "@/lib/format";
import { useToast } from "@/components/Toast";
import { AILoader, AILoaderBlock } from "@/components/AILoader";
import { useAIThinking } from "@/components/AIThinking";
import { useNavHistory } from "@/components/NavHistory";

const ALL_CHANNELS = ["whatsapp", "sms", "email", "rcs"];

const SKIPPED_LABELS: Record<string, string> = {
  dnd_suppressed: "DND suppressed",
  no_eligible_channel: "No eligible channel",
  no_channel_consent: "No channel consent",
  no_contactability: "No phone or email",
};

const SKIPPED_COLORS: Record<string, string> = {
  dnd_suppressed: "bg-red-500",
  no_eligible_channel: "bg-amber-500",
  no_channel_consent: "bg-amber-400",
  no_contactability: "bg-neutral-500",
};

const CHANNEL_COLORS: Record<string, string> = {
  whatsapp: "bg-emerald-500",
  sms: "bg-sky-500",
  email: "bg-violet-500",
  rcs: "bg-amber-500",
};

export default function CampaignDetailPage() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);

  const [campaign, setCampaign] = useState<CampaignRow | null>(null);
  const [segments, setSegments] = useState<SegmentRow[]>([]);
  const [preview, setPreview] = useState<CampaignPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedNotice, setSavedNotice] = useState(false);

  // Launch state
  const [launching, setLaunching] = useState(false);
  const [launchResult, setLaunchResult] = useState<LaunchResult | null>(null);
  const [funnel, setFunnel] = useState<CampaignFunnel | null>(null);
  const [pollFunnel, setPollFunnel] = useState(false);

  // AI insight state
  const [insight, setInsight] = useState<CampaignInsightResponse | null>(null);
  const [insightBusy, setInsightBusy] = useState(false);
  const [insightError, setInsightError] = useState<string | null>(null);
  // Autopilot state
  const [autopilot, setAutopilot] = useState<AutopilotNextResponse | null>(null);
  const [autopilotBusy, setAutopilotBusy] = useState(false);
  const [autopilotAccepting, setAutopilotAccepting] = useState(false);

  // Retry-queued state
  const [retrying, setRetrying] = useState(false);
  const [retryResult, setRetryResult] = useState<RetryQueuedResult | null>(null);
  const toast = useToast();
  const ai = useAIThinking();
  const nav = useNavHistory();

  const onRetryQueued = async () => {
    setRetrying(true);
    const r = await retryQueued(id);
    setRetrying(false);
    setRetryResult(r);
    setPollFunnel(true);
    if (r) {
      if (r.send_failures === 0) {
        toast.success("Retry complete", `${r.retried} stuck communications re-dispatched.`);
      } else {
        toast.warning(
          "Retry partial",
          `${r.retried} re-dispatched, ${r.send_failures} send failures.`
        );
      }
    }
  };

  const onGenerateInsight = async () => {
    setInsightBusy(true);
    setInsightError(null);
    const r = await ai.run("Analyzing campaign with AI…", () => getCampaignInsight(id));
    setInsightBusy(false);
    if (!r) {
      setInsightError("AI insight failed. Check /ai-runs for details.");
      toast.error("AI insight failed", "Check /ai-runs for the failed run.");
      return;
    }
    setInsight(r);
    toast.success(
      "Insight generated",
      `${r.provider}/${r.model} · ${r.latency_ms}ms`
    );
  };

  const onAutopilotNext = async () => {
    setAutopilotBusy(true);
    const r = await ai.run(
      "Autopilot: analyst → follow-up goal → planner…",
      () => autopilotNext(id),
    );
    setAutopilotBusy(false);
    if (!r) {
      toast.error("Autopilot failed", "Check /ai-runs for details.");
      return;
    }
    setAutopilot(r);
    toast.success(
      "Autopilot ready",
      `3 AI calls · ${r.latency_ms.total}ms total`,
    );
  };

  const onAcceptAutopilot = async () => {
    if (!autopilot) return;
    setAutopilotAccepting(true);
    const r = await aiPlanCreate({
      goal: autopilot.followup_goal.goal,
      name: autopilot.plan.name,
      rationale: autopilot.plan.rationale,
      segment_definition: autopilot.plan.segment_definition,
      channel_priority: autopilot.plan.channel_priority,
      message_template: autopilot.plan.message_template,
      message_angle: autopilot.plan.message_angle,
      success_metric: autopilot.plan.success_metric,
      suppression_notes: autopilot.plan.suppression_notes,
      ai_run_id: autopilot.ai_runs.planner,
    });
    setAutopilotAccepting(false);
    if (!r) {
      toast.error("Draft creation failed");
      return;
    }
    toast.success("Follow-up draft created", "Edit and launch when ready.");
    window.location.href = `/campaigns/${r.campaign_id}`;
  };

  // Editable fields
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [segmentId, setSegmentId] = useState<number | null>(null);
  const [template, setTemplate] = useState("");
  const [priority, setPriority] = useState<string[]>([]);

  useEffect(() => {
    if (!Number.isFinite(id)) return;
    Promise.all([getCampaign(id), listSegments()]).then(([c, s]) => {
      if (c) {
        setCampaign(c);
        setName(c.name);
        setGoal(c.goal ?? "");
        setSegmentId(c.segment?.id ?? null);
        setTemplate(c.message_template);
        setPriority(c.channel_policy.priority);
      }
      setSegments(s);
    });
  }, [id]);

  // Live preview after save
  const refreshPreview = async () => {
    setPreviewing(true);
    const p = await previewCampaign(id);
    setPreview(p);
    setPreviewing(false);
  };

  const onSave = async () => {
    if (!segmentId) return;
    setSaving(true);
    const payload: CampaignIn = {
      name,
      goal: goal || null,
      segment_id: segmentId,
      message_template: template,
      channel_policy: { priority, respect_consent: true, respect_dnd: true },
    };
    const r = await updateCampaign(id, payload);
    setSaving(false);
    if (r) {
      setCampaign(r);
      setSavedNotice(true);
      setTimeout(() => setSavedNotice(false), 2000);
      await refreshPreview();
    }
  };

  // Auto-preview on first load
  useEffect(() => {
    if (campaign) refreshPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaign?.id]);

  // Load funnel once if campaign is already launched
  useEffect(() => {
    if (!campaign) return;
    if (campaign.status === "running" || campaign.status === "completed" || campaign.status === "launching") {
      getCampaignFunnel(id).then((f) => setFunnel(f));
      setPollFunnel(campaign.status === "running" || campaign.status === "launching");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaign?.status]);

  // Live funnel polling while campaign is running
  useEffect(() => {
    if (!pollFunnel) return;
    const t = setInterval(async () => {
      const f = await getCampaignFunnel(id);
      setFunnel(f);
      if (f?.status === "completed") setPollFunnel(false);
    }, 2000);
    return () => clearInterval(t);
  }, [pollFunnel, id]);

  const onLaunch = async () => {
    if (!confirm(`Launch this campaign? It will create one communication per targeted customer in the segment and dispatch via the channel simulator.`)) {
      return;
    }
    setLaunching(true);
    const r = await launchCampaignNow(id);
    setLaunching(false);
    setLaunchResult(r);
    // Reload campaign + start funnel polling
    const c = await getCampaign(id);
    if (c) setCampaign(c);
    setPollFunnel(true);
    if (r?.launched) {
      toast.success(
        "Campaign launched",
        `${r.targeted} communications dispatched · webhooks streaming in.`
      );
    } else if (r) {
      toast.error("Launch failed", r.error ?? "Unknown error");
    }
  };

  if (!campaign) {
    return (
      <div className="min-h-screen">
        <PageHeader title="Loading…" />
      </div>
    );
  }

  const movePriority = (idx: number, delta: number) => {
    const next = [...priority];
    const target = idx + delta;
    if (target < 0 || target >= next.length) return;
    [next[idx], next[target]] = [next[target], next[idx]];
    setPriority(next);
  };

  const togglePriorityChannel = (ch: string) => {
    setPriority(priority.includes(ch) ? priority.filter((c) => c !== ch) : [...priority, ch]);
  };

  return (
    <div className="min-h-screen">
      <div className="border-b border-neutral-800/80 bg-neutral-950 px-8 py-5">
        {nav.canGoBack ? (
          <button
            onClick={() => nav.back()}
            className="text-xs text-neutral-500 hover:text-neutral-300"
            aria-label="Go back to previous page"
          >
            ← Back
          </button>
        ) : (
          <Link href="/campaigns" className="text-xs text-neutral-500 hover:text-neutral-300">
            ← Campaigns
          </Link>
        )}
        <div className="flex items-start justify-between mt-3 gap-4">
          <div className="min-w-0 flex-1">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="text-2xl font-semibold bg-transparent w-full focus:outline-none focus:border-b focus:border-emerald-500/50"
            />
            <div className="flex items-center gap-2 mt-1 text-xs text-neutral-500">
              <span className="font-mono">campaign #{campaign.id}</span>
              <span className="text-neutral-700">·</span>
              <span className="rounded border border-neutral-700 px-1.5 py-0.5 text-[10px] uppercase">
                {campaign.status}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {savedNotice && (
              <span className="text-xs text-emerald-400 animate-pulse">Saved</span>
            )}
            {campaign.status === "draft" && (
              <>
                <button
                  onClick={onSave}
                  disabled={saving}
                  className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm hover:bg-neutral-800 transition disabled:opacity-50"
                >
                  {saving ? "Saving…" : "Save draft"}
                </button>
                <button
                  onClick={onLaunch}
                  disabled={launching || !preview?.template_report.valid}
                  className="rounded-md border border-emerald-500/40 bg-emerald-500/15 text-emerald-200 px-3 py-1.5 text-sm hover:bg-emerald-500/25 transition disabled:opacity-40"
                  title={!preview?.template_report.valid ? "Fix template errors before launching" : ""}
                >
                  {launching ? "Launching…" : "Launch campaign"}
                </button>
              </>
            )}
            {campaign.status !== "draft" && (
              <>
                {funnel && (funnel.by_status?.queued ?? 0) > 0 && (
                  <button
                    onClick={onRetryQueued}
                    disabled={retrying}
                    title="Re-dispatch any communications stuck in queued state"
                    className="rounded-md border border-amber-500/40 bg-amber-500/10 text-amber-200 px-3 py-1.5 text-sm hover:bg-amber-500/20 transition disabled:opacity-40"
                  >
                    {retrying ? "Retrying…" : `Retry ${funnel.by_status.queued} queued`}
                  </button>
                )}
                <span className="text-xs text-neutral-400">
                  Launched {fmtNum(campaign.launched_at ? Math.round((Date.now() - new Date(campaign.launched_at).getTime()) / 1000) : 0)}s ago
                </span>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="px-8 py-6 max-w-6xl space-y-6">
        {/* Live funnel — shows once launched */}
        {funnel && campaign.status !== "draft" && (
          <LiveFunnel funnel={funnel} polling={pollFunnel} />
        )}

        {/* AI insight — only meaningful after launch */}
        {funnel && campaign.status !== "draft" && (
          <InsightPanel
            insight={insight}
            busy={insightBusy}
            error={insightError}
            onGenerate={onGenerateInsight}
          />
        )}

        {/* Campaign Autopilot — analyst → follow-up goal → planner, one click */}
        {funnel && campaign.status !== "draft" && (
          <AutopilotPanel
            data={autopilot}
            busy={autopilotBusy}
            accepting={autopilotAccepting}
            onGenerate={onAutopilotNext}
            onAccept={onAcceptAutopilot}
          />
        )}

        {/* Launch result toast */}
        {launchResult && launchResult.launched && (
          <div className="rounded-md border border-emerald-500/30 bg-emerald-500/[0.05] px-4 py-2.5 text-sm text-emerald-200">
            ✓ Launched. {launchResult.targeted} communications dispatched.{" "}
            <Link href="/events" className="text-emerald-300 underline">Watch events stream in →</Link>
          </div>
        )}
        {launchResult && !launchResult.launched && (
          <div className="rounded-md border border-red-500/30 bg-red-500/[0.05] px-4 py-2.5 text-sm text-red-300">
            Launch failed: {launchResult.error ?? "unknown"}
          </div>
        )}

        {retryResult && (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/[0.05] px-4 py-2.5 text-sm text-amber-200">
            ✓ Re-dispatched {retryResult.retried} stuck communications.
            {retryResult.send_failures > 0 && ` ${retryResult.send_failures} failed.`}
            {" "}
            Watch the funnel above and the{" "}
            <Link href="/events" className="text-amber-300 underline">event log</Link> for the new arrivals.
          </div>
        )}

        {/* Goal + segment row */}
        <section className="grid lg:grid-cols-2 gap-4">
          <div className="rounded-lg border border-neutral-800 bg-neutral-900/30 p-4">
            <div className="text-[10px] uppercase tracking-widest text-neutral-500 mb-1.5">
              Marketer goal
            </div>
            <textarea
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="Win back high-value shoppers who haven't ordered in 60 days…"
              rows={3}
              className="w-full bg-transparent text-sm text-neutral-200 placeholder:text-neutral-600 focus:outline-none resize-none"
            />
          </div>
          <div className="rounded-lg border border-neutral-800 bg-neutral-900/30 p-4">
            <div className="text-[10px] uppercase tracking-widest text-neutral-500 mb-1.5">
              Audience segment
            </div>
            <select
              value={segmentId ?? ""}
              onChange={(e) => setSegmentId(e.target.value ? Number(e.target.value) : null)}
              className="w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm"
            >
              {segments.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({fmtNum(s.preview_count)} customers)
                </option>
              ))}
            </select>
            {campaign.segment && (
              <div className="mt-2 text-xs text-neutral-500">
                Currently: <span className="text-neutral-300">{campaign.segment.name}</span> · {fmtNum(campaign.segment.preview_count)} customers
              </div>
            )}
          </div>
        </section>

        {/* Channel priority */}
        <section className="rounded-lg border border-neutral-800 bg-neutral-900/30 p-5">
          <div className="text-[11px] uppercase tracking-widest text-neutral-500 mb-3">
            Channel priority
          </div>
          <p className="text-xs text-neutral-500 mb-3 max-w-2xl">
            Each customer is routed to the FIRST channel they're opted into. Reorder by clicking ↑↓. The AI planner can also propose this order based on your campaign goal.
          </p>
          <div className="space-y-1.5">
            {priority.map((ch, idx) => (
              <div
                key={ch}
                className="flex items-center gap-2 rounded-md border border-neutral-800 bg-neutral-950/60 px-3 py-2"
              >
                <span className="font-mono text-xs text-neutral-500 w-5">{idx + 1}</span>
                <ChannelBadge channel={ch} size="md" />
                <span className="flex-1" />
                <button
                  onClick={() => movePriority(idx, -1)}
                  disabled={idx === 0}
                  className="text-xs text-neutral-500 hover:text-neutral-200 disabled:opacity-30"
                >
                  ↑
                </button>
                <button
                  onClick={() => movePriority(idx, 1)}
                  disabled={idx === priority.length - 1}
                  className="text-xs text-neutral-500 hover:text-neutral-200 disabled:opacity-30"
                >
                  ↓
                </button>
                <button
                  onClick={() => togglePriorityChannel(ch)}
                  className="text-xs text-neutral-500 hover:text-red-400"
                >
                  remove
                </button>
              </div>
            ))}
          </div>
          {priority.length < ALL_CHANNELS.length && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              <span className="text-xs text-neutral-500">Add:</span>
              {ALL_CHANNELS.filter((c) => !priority.includes(c)).map((ch) => (
                <button
                  key={ch}
                  onClick={() => togglePriorityChannel(ch)}
                  className="text-[11px] rounded border border-neutral-700 bg-neutral-900 hover:bg-neutral-800 px-2 py-0.5 transition"
                >
                  + {ch}
                </button>
              ))}
            </div>
          )}
        </section>

        {/* Template editor */}
        <section className="rounded-lg border border-neutral-800 bg-neutral-900/30 p-5">
          <div className="flex items-baseline justify-between mb-3">
            <div className="text-[11px] uppercase tracking-widest text-neutral-500">
              Message template
            </div>
            <div className="text-xs text-neutral-500">
              {template.length} chars
            </div>
          </div>
          <textarea
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
            placeholder="Hi {{first_name}}, it's been {{last_order_days}} days since your last order at {{brand_name}}. As a {{loyalty_tier}} member, here's 15% off your next order."
            rows={5}
            className="w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm font-mono text-neutral-200 placeholder:text-neutral-600 focus:border-emerald-500/50 focus:outline-none resize-vertical"
          />
          <div className="mt-3 flex flex-wrap gap-1.5">
            <span className="text-xs text-neutral-500 mr-1">Insert:</span>
            {Object.keys(preview?.allowed_variables ?? {
              first_name: "", last_name: "", full_name: "", city: "",
              loyalty_tier: "", total_orders: "", lifetime_value: "",
              lifetime_value_inr: "", last_order_days: "", brand_name: "",
            }).map((v) => (
              <button
                key={v}
                onClick={() => setTemplate(template + ` {{${v}}}`)}
                className="text-[11px] font-mono rounded bg-neutral-800/80 hover:bg-neutral-700 px-1.5 py-0.5 text-neutral-300 transition"
              >
                {`{{${v}}}`}
              </button>
            ))}
          </div>

          {preview?.template_report && preview.template_report.unknown_variables.length > 0 && (
            <div className="mt-3 rounded border border-red-500/40 bg-red-500/[0.05] px-3 py-2 text-xs text-red-300">
              Unknown variables: {preview.template_report.unknown_variables.map((v) => `{{${v}}}`).join(", ")}.
              These will not render and will appear literally in the message. Fix before launch.
            </div>
          )}
        </section>

        {/* Routing breakdown */}
        {preview && (
          <section>
            <h2 className="text-[11px] uppercase tracking-widest text-neutral-500 mb-3">
              Pre-launch routing breakdown
            </h2>
            <RoutingPanel routing={preview.routing_breakdown} />
          </section>
        )}

        {/* Sample renders */}
        {preview && preview.samples.length > 0 && (
          <section>
            <h2 className="text-[11px] uppercase tracking-widest text-neutral-500 mb-3">
              Sample renders
            </h2>
            <div className="grid lg:grid-cols-3 gap-3">
              {preview.samples.map((s) => (
                <SampleRenderCard key={s.customer.id} sample={s} priority={priority} />
              ))}
            </div>
          </section>
        )}

        {previewing && (
          <div className="text-xs text-neutral-500 italic">Refreshing preview…</div>
        )}
      </div>
    </div>
  );
}

function InsightPanel({
  insight,
  busy,
  error,
  onGenerate,
}: {
  insight: CampaignInsightResponse | null;
  busy: boolean;
  error: string | null;
  onGenerate: () => void;
}) {
  return (
    <section className="neu-card accent-violet p-5">
      <div className="flex items-start justify-between gap-4 mb-2">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[10px] uppercase tracking-widest text-c-violet font-semibold">
              AI · post-run analyst
            </span>
            <span className="text-[10px] uppercase tracking-wider text-[var(--neu-text-subtle)]">
              uses funnel + failure mix + goal
            </span>
          </div>
          <p className="text-sm text-[var(--neu-text-muted)] max-w-2xl">
            Generate a plain-English insight grounded in the actual numbers. The model
            sees only the funnel, failure reasons, segment, and goal — no chat freeform.
            Validated against a Pydantic schema and logged to ai_runs.
          </p>
        </div>
        <button
          onClick={onGenerate}
          disabled={busy}
          className="shrink-0 neu-btn neu-btn-primary px-4 py-2 text-sm min-w-[170px]"
        >
          {busy ? <AILoader label="Analyzing…" /> : insight ? "Refresh insight" : "Generate insight"}
        </button>
      </div>

      {error && (
        <div className="mt-3 neu-inset-sm px-3 py-2 text-xs text-c-rose">
          {error}
        </div>
      )}

      {insight && (
        <div className="mt-4 space-y-3">
          <div className="neu-inset-sm p-3">
            <div className="text-[10px] uppercase tracking-wider text-[var(--neu-text-subtle)] mb-1">
              Headline
            </div>
            <p className="text-sm font-medium text-[var(--neu-text-strong)]">{insight.insight.headline}</p>
          </div>
          <div className="grid sm:grid-cols-2 gap-3">
            <div className="neu-raised-xs p-3">
              <div className="text-[10px] uppercase tracking-wider text-c-emerald mb-1 font-semibold">
                What worked
              </div>
              <p className="text-xs text-[var(--neu-text-muted)] leading-relaxed">{insight.insight.what_worked}</p>
            </div>
            <div className="neu-raised-xs p-3">
              <div className="text-[10px] uppercase tracking-wider text-c-amber mb-1 font-semibold">
                What didn&apos;t
              </div>
              <p className="text-xs text-[var(--neu-text-muted)] leading-relaxed">{insight.insight.what_didnt}</p>
            </div>
          </div>
          <div className="neu-raised-xs p-3">
            <div className="text-[10px] uppercase tracking-wider text-xeno mb-1 font-semibold">
              Recommended next action
            </div>
            <p className="text-sm text-[var(--neu-text)] leading-relaxed">{insight.insight.next_action}</p>
          </div>
          <div className="text-[10px] font-mono text-[var(--neu-text-subtle)]">
            {insight.provider}/{insight.model} · {insight.latency_ms}ms ·{" "}
            <span
              className={
                insight.validation_status === "ok"
                  ? "text-c-emerald"
                  : insight.validation_status === "retry_used"
                  ? "text-xeno"
                  : "text-c-amber"
              }
            >
              {insight.validation_status}
            </span>
          </div>
        </div>
      )}
    </section>
  );
}

function AutopilotPanel({
  data,
  busy,
  accepting,
  onGenerate,
  onAccept,
}: {
  data: AutopilotNextResponse | null;
  busy: boolean;
  accepting: boolean;
  onGenerate: () => void;
  onAccept: () => void;
}) {
  return (
    <section className="neu-card accent-violet p-5">
      <div className="flex items-start justify-between gap-4 mb-2">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[10px] uppercase tracking-widest text-c-violet font-semibold">
              AI · campaign autopilot
            </span>
            <span className="text-[10px] uppercase tracking-wider text-[var(--neu-text-subtle)]">
              analyst → follow-up goal → planner · 3 audited AI calls
            </span>
          </div>
          <p className="text-sm text-[var(--neu-text-muted)] max-w-2xl">
            Close the loop. Given this campaign's funnel, the autopilot derives the smartest
            next campaign — a fresh segment + message + channel mix — and stages it as a
            draft you can review and launch. Each step lands as its own ai_runs row.
          </p>
        </div>
        <button
          onClick={onGenerate}
          disabled={busy || accepting}
          className="shrink-0 neu-btn neu-btn-primary px-4 py-2 text-sm min-w-[200px]"
        >
          {busy ? <AILoader label="Chaining…" /> : data ? "Re-run autopilot" : "What should I do next?"}
        </button>
      </div>

      {data && (
        <div className="mt-4 space-y-3">
          {/* Followup goal */}
          <div className="neu-inset-sm p-3">
            <div className="text-[10px] uppercase tracking-wider text-c-violet mb-1 font-semibold">
              Proposed follow-up goal
            </div>
            <p className="text-sm text-[var(--neu-text-strong)] leading-relaxed">{data.followup_goal.goal}</p>
            <p className="text-xs text-[var(--neu-text-subtle)] mt-2 italic">
              Why: {data.followup_goal.rationale}
            </p>
          </div>

          {/* Plan summary */}
          <div className="neu-raised-xs p-3 space-y-2">
            <div className="flex items-baseline justify-between">
              <div className="text-[10px] uppercase tracking-wider text-xeno font-semibold">
                Drafted plan
              </div>
              <div className="text-[10px] font-mono text-[var(--neu-text-subtle)]">
                ready to create as draft
              </div>
            </div>
            <div className="text-sm font-medium text-[var(--neu-text-strong)]">{data.plan.name}</div>
            <div className="text-xs text-[var(--neu-text-muted)] leading-relaxed">{data.plan.rationale}</div>
            <div className="flex flex-wrap items-center gap-1.5 pt-1">
              {data.plan.channel_priority.map((c, i) => (
                <span key={c} className="inline-flex items-center gap-1.5">
                  <span className="font-mono text-[10px] text-[var(--neu-text-subtle)] tabular-nums">{i + 1}</span>
                  <ChannelBadge channel={c} size="sm" />
                </span>
              ))}
            </div>
            <div className="neu-inset-sm p-2 mt-2">
              <div className="text-[10px] uppercase tracking-wider text-[var(--neu-text-subtle)] mb-1">Message</div>
              <p className="text-xs font-mono text-[var(--neu-text)] leading-relaxed">{data.plan.message_template}</p>
            </div>
          </div>

          {/* Provenance */}
          <div className="grid grid-cols-3 gap-2 text-[10px] font-mono">
            <div className="neu-inset-sm px-2 py-1.5">
              <div className="text-[var(--neu-text-subtle)] uppercase tracking-wider">Analyst</div>
              <div className="text-[var(--neu-text-muted)]">{data.providers.analyst} · {data.latency_ms.analyst}ms</div>
            </div>
            <div className="neu-inset-sm px-2 py-1.5">
              <div className="text-[var(--neu-text-subtle)] uppercase tracking-wider">Follow-up goal</div>
              <div className="text-[var(--neu-text-muted)]">{data.providers.followup_goal} · {data.latency_ms.followup_goal}ms</div>
            </div>
            <div className="neu-inset-sm px-2 py-1.5">
              <div className="text-[var(--neu-text-subtle)] uppercase tracking-wider">Planner</div>
              <div className="text-[var(--neu-text-muted)]">{data.providers.planner} · {data.latency_ms.planner}ms</div>
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 pt-1">
            <Link
              href="/ai-runs"
              className="text-[11px] text-[var(--neu-text-subtle)] hover:text-c-violet underline"
            >
              audit trail →
            </Link>
            <button
              onClick={onAccept}
              disabled={accepting || busy}
              className="neu-btn neu-btn-primary px-4 py-2 text-sm"
            >
              {accepting ? <AILoader label="Creating draft…" /> : "Accept & create draft →"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function LiveFunnel({ funnel, polling }: { funnel: CampaignFunnel; polling: boolean }) {
  const FUNNEL_ORDER = ["queued", "sent", "delivered", "viewed", "clicked", "converted", "failed"];
  const STAGE_TONE: Record<string, string> = {
    queued: "bg-neutral-700",
    sent: "bg-neutral-500",
    delivered: "bg-emerald-500",
    viewed: "bg-sky-500",
    opened: "bg-sky-500",
    read: "bg-sky-500",
    clicked: "bg-violet-500",
    converted: "bg-amber-400",
    failed: "bg-red-500",
  };
  const totalDispatched = funnel.total_targeted;
  const reached: Record<string, number> = { ...funnel.funnel };
  // Treat by_status (current state) as the floor for funnel display when historical is absent
  for (const [k, v] of Object.entries(funnel.by_status)) {
    reached[k] = Math.max(reached[k] ?? 0, v);
  }
  const failed = reached["failed"] ?? 0;
  const converted = reached["converted"] ?? 0;
  const clicked = reached["clicked"] ?? 0;

  return (
    <section className="rounded-lg border border-neutral-800 bg-neutral-900/30 p-5 space-y-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-[11px] uppercase tracking-widest text-neutral-500">Live funnel</h2>
        <div className="flex items-center gap-2 text-xs text-neutral-500">
          <span>Status: <span className="text-neutral-200">{funnel.status}</span></span>
          {polling && (
            <span className="text-emerald-400 text-[10px] animate-pulse">● polling</span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label="Targeted" value={fmtNum(totalDispatched)} />
        <Stat label="Reached delivered" value={fmtNum(reached["delivered"] ?? 0)} tone="emerald" />
        <Stat label="Clicked" value={fmtNum(clicked)} tone="sky" sub={totalDispatched > 0 ? `${((clicked / totalDispatched) * 100).toFixed(1)}% CTR` : undefined} />
        <Stat label="Converted" value={fmtNum(converted)} tone="amber" sub={totalDispatched > 0 ? `${((converted / totalDispatched) * 100).toFixed(2)}% conv.` : undefined} />
      </div>

      {/* Funnel bar */}
      <div className="space-y-2">
        {FUNNEL_ORDER.filter((k) => (reached[k] ?? 0) > 0).map((stage) => {
          const n = reached[stage] ?? 0;
          const pct = totalDispatched > 0 ? (n / totalDispatched) * 100 : 0;
          return (
            <div key={stage}>
              <div className="flex items-center justify-between text-xs mb-1">
                <span className="font-mono text-neutral-300">{stage}</span>
                <span className="font-mono text-neutral-500 tabular-nums">
                  {fmtNum(n)} ({pct.toFixed(1)}%)
                </span>
              </div>
              <div className="h-2 rounded-full bg-neutral-800 overflow-hidden">
                <div className={STAGE_TONE[stage] ?? "bg-neutral-500"} style={{ width: `${pct}%`, height: "100%" }} />
              </div>
            </div>
          );
        })}
      </div>

      {failed > 0 && Object.keys(funnel.failure_reasons).length > 0 && (
        <div className="rounded-md border border-red-500/30 bg-red-500/[0.05] p-3">
          <div className="text-[10px] uppercase tracking-wider text-red-300 mb-1.5">
            Failure reasons ({failed} total)
          </div>
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(funnel.failure_reasons).map(([reason, n]) => (
              <span key={reason} className="text-[11px] rounded bg-red-500/15 border border-red-500/30 text-red-300 px-1.5 py-0.5">
                {reason}: {n}
              </span>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function RoutingPanel({ routing }: { routing: CampaignPreview["routing_breakdown"] }) {
  const total = routing.total;
  const channels = Object.entries(routing.by_channel);
  const skipped = Object.entries(routing.skipped_reasons);
  const reached = total - routing.skipped;
  const reachPct = total > 0 ? reached / total : 0;

  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/30 p-5 space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label="Audience" value={fmtNum(total)} sub="customers in segment" />
        <Stat label="Reachable" value={fmtNum(reached)} tone="emerald" sub={fmtPct(reachPct)} />
        <Stat label="Skipped" value={fmtNum(routing.skipped)} tone={routing.skipped > 0 ? "amber" : "default"} sub="no eligible channel / DND" />
        <Stat label="Channels used" value={String(channels.length)} sub="of priority list" />
      </div>

      {/* Stacked bar */}
      <div>
        <div className="text-[10px] uppercase tracking-wider text-neutral-500 mb-1.5">
          Routing distribution
        </div>
        <div className="flex h-3 rounded-full overflow-hidden bg-neutral-800">
          {channels.map(([ch, n]) => (
            <div
              key={ch}
              className={CHANNEL_COLORS[ch] ?? "bg-neutral-500"}
              style={{ width: `${(n / total) * 100}%` }}
              title={`${ch}: ${n}`}
            />
          ))}
          {skipped.map(([reason, n]) => (
            <div
              key={reason}
              className={SKIPPED_COLORS[reason] ?? "bg-neutral-700"}
              style={{ width: `${(n / total) * 100}%`, opacity: 0.6 }}
              title={`${reason}: ${n}`}
            />
          ))}
        </div>
        <div className="flex flex-wrap gap-3 mt-2 text-[11px]">
          {channels.map(([ch, n]) => (
            <div key={ch} className="flex items-center gap-1.5">
              <span className={`h-2 w-2 rounded-full ${CHANNEL_COLORS[ch] ?? "bg-neutral-500"}`} />
              <ChannelBadge channel={ch} />
              <span className="text-neutral-400 font-mono tabular-nums">
                {fmtNum(n)} ({((n / total) * 100).toFixed(1)}%)
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Skipped reasons */}
      {skipped.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-neutral-500 mb-1.5">
            Skipped, with reasons
          </div>
          <div className="grid sm:grid-cols-2 gap-2">
            {skipped.map(([reason, n]) => (
              <div
                key={reason}
                className="flex items-center justify-between rounded-md border border-neutral-800 bg-neutral-950/40 px-3 py-1.5"
              >
                <div className="flex items-center gap-2">
                  <span className={`h-2 w-2 rounded-full ${SKIPPED_COLORS[reason] ?? "bg-neutral-500"}`} />
                  <span className="text-xs text-neutral-300">
                    {SKIPPED_LABELS[reason] ?? reason}
                  </span>
                </div>
                <span className="font-mono text-xs text-neutral-400 tabular-nums">
                  {fmtNum(n)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function SampleRenderCard({
  sample,
  priority,
}: {
  sample: CampaignPreview["samples"][number];
  priority: string[];
}) {
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/30 p-3 space-y-2">
      <div className="flex items-baseline justify-between">
        <div className="text-sm font-medium truncate">{sample.customer.full_name}</div>
        <span className="text-[10px] font-mono text-neutral-500">
          {sample.customer.master_customer_id}
        </span>
      </div>
      <div className="rounded-md border border-neutral-800 bg-neutral-950 p-2.5 text-xs text-neutral-200 whitespace-pre-wrap break-words">
        {sample.rendered || <span className="text-neutral-600">(empty template)</span>}
      </div>
      <div className="space-y-1">
        {priority.map((ch) => {
          const fb = sample.length_per_channel[ch];
          if (!fb) return null;
          const tone =
            fb.status === "over_limit"
              ? "text-red-400"
              : fb.status === "warning"
              ? "text-amber-400"
              : "text-neutral-500";
          return (
            <div key={ch} className="flex items-center justify-between text-[11px]">
              <div className="flex items-center gap-1.5">
                <ChannelBadge channel={ch} />
                <span className="text-neutral-500 font-mono tabular-nums">
                  {fb.length}/{fb.limit_soft}
                </span>
              </div>
              <span className={`text-[10px] ${tone}`}>{fb.note ?? fb.status}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
