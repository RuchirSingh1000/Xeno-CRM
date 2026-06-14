"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { ChannelBadge } from "@/components/ChannelBadge";
import {
  aiPlanCampaign,
  aiPlanCreate,
  aiRegenerateMessage,
  createCampaign,
  deleteCampaign,
  listCampaigns,
  listSegments,
  type AIPlanResponse,
  type CampaignIn,
  type CampaignPlan,
  type CampaignRow,
  type SegmentRow,
} from "@/lib/api";
import { fmtInr, fmtNum, fmtRelative } from "@/lib/format";
import { useToast } from "@/components/Toast";
import { AILoader, AILoaderBlock } from "@/components/AILoader";
import { useAIThinking } from "@/components/AIThinking";

// Force dynamic rendering — this page uses useSearchParams which Next 16
// won't statically prerender. Every render of this page hits the backend
// anyway, so prerendering buys nothing.
export const dynamic = "force-dynamic";

export default function CampaignsPage() {
  const searchParams = useSearchParams();
  const initialSegmentId = searchParams.get("segment_id");

  const [campaigns, setCampaigns] = useState<CampaignRow[]>([]);
  const [segments, setSegments] = useState<SegmentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newPanel, setNewPanel] = useState(!!initialSegmentId);

  // New campaign form
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [segmentId, setSegmentId] = useState<number | null>(
    initialSegmentId ? Number(initialSegmentId) : null
  );
  const [error, setError] = useState<string | null>(null);

  // AI plan state
  const [aiGoal, setAiGoal] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiResp, setAiResp] = useState<AIPlanResponse | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const [editedPlan, setEditedPlan] = useState<CampaignPlan | null>(null);
  const [aiCreating, setAiCreating] = useState(false);
  const toast = useToast();
  const ai = useAIThinking();

  const onAiPlan = async () => {
    if (!aiGoal.trim()) return;
    setAiBusy(true);
    setAiError(null);
    setAiResp(null);
    setEditedPlan(null);
    const r = await ai.run("Planning campaign with AI…", () => aiPlanCampaign(aiGoal));
    setAiBusy(false);
    if (!r) {
      setAiError("AI plan failed. Check /ai-runs for details.");
      toast.error("AI plan failed", "Check /ai-runs for the failed run.");
      return;
    }
    setAiResp(r);
    setEditedPlan(r.plan);
    toast.success(
      "AI plan generated",
      `${r.segment_preview.count} customers match · ${r.provider}/${r.model} · ${r.latency_ms}ms`
    );
  };

  const onAiCreate = async () => {
    if (!aiResp || !editedPlan) return;
    setAiCreating(true);
    const r = await ai.run("Creating campaign draft…", () => aiPlanCreate({
      goal: aiGoal,
      name: editedPlan.name,
      rationale: editedPlan.rationale,
      segment_definition: editedPlan.segment_definition,
      channel_priority: editedPlan.channel_priority,
      message_template: editedPlan.message_template,
      message_angle: editedPlan.message_angle,
      success_metric: editedPlan.success_metric,
      suppression_notes: editedPlan.suppression_notes,
      ai_run_id: aiResp.ai_run_id,
    }));
    setAiCreating(false);
    if (!r) {
      setAiError("Draft creation failed.");
      toast.error("Draft creation failed");
      return;
    }
    toast.success("Draft created from AI plan", "Edit and launch when ready.");
    window.location.href = `/campaigns/${r.campaign_id}`;
  };

  const SAMPLE_GOALS = [
    "win back lapsed shoppers who haven't ordered in 60+ days with a 15% off offer",
    "celebrate first-time buyers in their first month, prefer WhatsApp",
    "re-engage gold and platinum members across all cities, no discount",
    "active customers in last 14 days, upsell premium coffee beans",
  ];

  const refresh = async () => {
    setLoading(true);
    const [c, s] = await Promise.all([listCampaigns(), listSegments()]);
    setCampaigns(c);
    setSegments(s);
    setLoading(false);
  };

  useEffect(() => {
    refresh();
  }, []);

  const onCreate = async () => {
    if (!name.trim() || !segmentId) {
      setError("Name and segment are required.");
      return;
    }
    setCreating(true);
    setError(null);
    const payload: CampaignIn = {
      name,
      goal: goal || null,
      segment_id: segmentId,
      message_template: "",
      channel_policy: { priority: ["whatsapp", "sms", "email"], respect_consent: true, respect_dnd: true },
    };
    const r = await createCampaign(payload);
    setCreating(false);
    if (!r) {
      setError("Create failed. Check that the segment exists.");
      return;
    }
    // Navigate to the campaign detail
    window.location.href = `/campaigns/${r.id}`;
  };

  const onDelete = async (id: number) => {
    if (!confirm("Delete this campaign draft?")) return;
    const ok = await deleteCampaign(id);
    if (ok) setCampaigns(campaigns.filter((c) => c.id !== id));
  };

  return (
    <div className="min-h-screen animate-fade-in">
      <PageHeader
        eyebrow="Engagement"
        title="Campaigns"
        description="Build campaign drafts on top of saved segments. Draft messaging, set channel priorities, and preview the routing breakdown before launch."
        actions={
          <button
            onClick={() => setNewPanel(true)}
            className="rounded-md border border-emerald-500/40 bg-emerald-500/10 text-emerald-300 px-3 py-1.5 text-sm hover:bg-emerald-500/20 transition"
          >
            New campaign
          </button>
        }
      />

      <div className="px-8 py-8 max-w-6xl space-y-8">
        {/* AI campaign planner */}
        <section className="neu-card accent-violet p-5">
          <div className="flex items-start justify-between gap-4 mb-3">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[10px] uppercase tracking-widest text-c-violet font-semibold">
                  AI · campaign planner
                </span>
                <span className="text-[10px] uppercase tracking-wider text-[var(--neu-text-subtle)]">
                  validated · audited · editable
                </span>
              </div>
              <p className="text-sm text-[var(--neu-text-muted)] max-w-2xl">
                Describe your goal. The model returns a full plan — segment, channel
                priority, message angle, template, success metric. Review and edit
                before creating the draft. AI proposes; you and the deterministic
                engine execute.
              </p>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row gap-2">
            <input
              value={aiGoal}
              onChange={(e) => setAiGoal(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !aiBusy) onAiPlan();
              }}
              placeholder='e.g., "win back lapsed VIPs in Bengaluru with a 15% off offer, prefer WhatsApp"'
              className="flex-1 neu-input px-3 py-2 text-sm"
            />
            <button
              onClick={onAiPlan}
              disabled={aiBusy || !aiGoal.trim()}
              className="neu-btn neu-btn-primary px-4 py-2 text-sm min-w-[170px]"
            >
              {aiBusy ? <AILoader label="Planning…" /> : "Generate plan"}
            </button>
          </div>

          <div className="mt-3 flex flex-wrap gap-1.5">
            <span className="text-[11px] text-[var(--neu-text-subtle)] mr-1">Try:</span>
            {SAMPLE_GOALS.map((g) => (
              <button
                key={g}
                onClick={() => setAiGoal(g)}
                className="text-[11px] neu-raised-xs px-2.5 py-1 hover:text-xeno transition"
              >
                {g.length > 60 ? g.slice(0, 57) + "…" : g}
              </button>
            ))}
          </div>

          {aiError && (
            <div className="mt-3 neu-inset-sm px-3 py-2 text-xs text-c-rose">
              {aiError}
            </div>
          )}

          {aiBusy && !aiResp && (
            <div className="mt-4">
              <AILoaderBlock
                label="Asking the model to draft a complete campaign…"
                hint="Audience filters, channel priority, message angle, template — validated against a Pydantic schema."
              />
            </div>
          )}

          {aiResp && editedPlan && (
            <AIPlanPanel
              resp={aiResp}
              plan={editedPlan}
              goal={aiGoal}
              onChange={setEditedPlan}
              onCreate={onAiCreate}
              creating={aiCreating}
            />
          )}
        </section>

        {/* New campaign panel */}
        {newPanel && (
          <section className="rounded-lg border border-emerald-500/30 bg-gradient-to-br from-emerald-500/[0.05] to-emerald-500/[0.01] p-5">
            <div className="flex items-baseline justify-between mb-3">
              <h2 className="text-[11px] uppercase tracking-widest text-emerald-300">
                New campaign draft
              </h2>
              <button
                onClick={() => setNewPanel(false)}
                className="text-xs text-neutral-500 hover:text-neutral-300"
              >
                Cancel
              </button>
            </div>

            <div className="grid sm:grid-cols-2 gap-3">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Campaign name (e.g., Win back lapsed coffee lovers)"
                className="rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm placeholder:text-neutral-600 focus:border-emerald-500/50 focus:outline-none"
              />
              <select
                value={segmentId ?? ""}
                onChange={(e) => setSegmentId(e.target.value ? Number(e.target.value) : null)}
                className="rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm"
              >
                <option value="">Select a segment…</option>
                {segments.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({fmtNum(s.preview_count)})
                  </option>
                ))}
              </select>
            </div>

            <textarea
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="Marketer goal in plain English (optional). Example: 'Win back high-value shoppers who haven't ordered in 60 days, without bothering recent purchasers.'"
              rows={2}
              className="mt-3 w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm placeholder:text-neutral-600 focus:border-emerald-500/50 focus:outline-none"
            />

            {segments.length === 0 && (
              <div className="mt-3 rounded border border-amber-500/30 bg-amber-500/[0.05] px-3 py-2 text-xs text-amber-200/80">
                You don&apos;t have any segments yet.{" "}
                <Link href="/segments" className="text-amber-300 underline">
                  Create one first →
                </Link>
              </div>
            )}

            {error && <div className="mt-3 text-xs text-red-400">{error}</div>}

            <div className="mt-4 flex items-center gap-2">
              <button
                onClick={onCreate}
                disabled={creating || segments.length === 0}
                className="rounded-md border border-emerald-500/40 bg-emerald-500/15 text-emerald-300 px-3 py-1.5 text-sm hover:bg-emerald-500/25 transition disabled:opacity-40"
              >
                {creating ? "Creating…" : "Create draft"}
              </button>
              <span className="text-xs text-neutral-500">
                Next step: edit message template, channel priority, and preview routing.
              </span>
            </div>
          </section>
        )}

        {/* Campaigns list */}
        <section>
          <h2 className="text-[11px] uppercase tracking-widest text-neutral-500 mb-3">
            All campaigns
          </h2>
          {loading ? (
            <div className="text-sm text-neutral-500">Loading…</div>
          ) : campaigns.length === 0 ? (
            <EmptyState
              title="No campaigns yet"
              description="Create your first draft above. You'll write a message template, choose channel priorities, and preview the routing breakdown."
            />
          ) : (
            <div className="grid gap-3">
              {campaigns.map((c) => (
                <CampaignCard key={c.id} campaign={c} onDelete={() => onDelete(c.id)} />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function CampaignCard({ campaign, onDelete }: { campaign: CampaignRow; onDelete: () => void }) {
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/30 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1">
            <Link
              href={`/campaigns/${campaign.id}`}
              className="text-base font-medium text-neutral-100 hover:text-emerald-300"
            >
              {campaign.name}
            </Link>
            <StatusBadge status={campaign.status} />
          </div>
          {campaign.goal && (
            <div className="text-xs text-neutral-400 mb-2 line-clamp-2">{campaign.goal}</div>
          )}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            {campaign.segment ? (
              <Link
                href={`/segments`}
                className="text-neutral-400 hover:text-neutral-200"
              >
                Segment: <span className="text-neutral-200">{campaign.segment.name}</span>{" "}
                <span className="text-neutral-500">({fmtNum(campaign.segment.preview_count)})</span>
              </Link>
            ) : (
              <span className="text-amber-400">No segment</span>
            )}
            <span className="text-neutral-700">·</span>
            <div className="flex items-center gap-1">
              <span className="text-neutral-500">Priority:</span>
              {campaign.channel_policy.priority.map((ch) => (
                <ChannelBadge key={ch} channel={ch} />
              ))}
            </div>
            <span className="text-neutral-700">·</span>
            <span className="text-neutral-500">Created {fmtRelative(campaign.created_at)}</span>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1.5 shrink-0">
          <Link
            href={`/campaigns/${campaign.id}`}
            className="text-xs text-emerald-400 hover:text-emerald-300"
          >
            Open draft →
          </Link>
          <button onClick={onDelete} className="text-xs text-neutral-500 hover:text-red-400">
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

function AIPlanPanel({
  resp,
  plan,
  goal,
  onChange,
  onCreate,
  creating,
}: {
  resp: AIPlanResponse;
  plan: CampaignPlan;
  goal: string;
  onChange: (p: CampaignPlan) => void;
  onCreate: () => void;
  creating: boolean;
}) {
  const count = resp.segment_preview.count;
  const tooSmall = count === 0;
  const toast = useToast();
  const ai = useAIThinking();
  const [regenBusy, setRegenBusy] = useState(false);

  const onRegenerateMessage = async () => {
    setRegenBusy(true);
    const r = await ai.run("Rewriting message…", () =>
      aiRegenerateMessage({
        goal,
        message_angle: plan.message_angle ?? "",
        previous_template: plan.message_template,
        channel_priority: plan.channel_priority,
      })
    );
    setRegenBusy(false);
    if (!r) {
      toast.error("Regenerate failed", "Check /ai-runs for the failed run.");
      return;
    }
    onChange({ ...plan, message_template: r.message_template });
    toast.success(
      "New message generated",
      `${r.provider}/${r.model} · ${r.latency_ms}ms · ${r.validation_status}`
    );
  };

  return (
    <div className="mt-4 rounded-md border border-neutral-800 bg-neutral-950/60 p-4 space-y-4">
      {/* Header strip */}
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-[10px] uppercase tracking-wider text-neutral-500">
          AI plan · review and edit
        </div>
        <div className="text-[10px] font-mono text-neutral-500">
          {resp.provider}/{resp.model} · {resp.latency_ms}ms ·{" "}
          <span
            className={
              resp.validation_status === "ok"
                ? "text-emerald-400"
                : resp.validation_status === "retry_used"
                ? "text-sky-400"
                : "text-amber-400"
            }
          >
            {resp.validation_status}
          </span>
        </div>
      </div>

      {/* Audience preview */}
      <div
        className={`rounded-md border p-3 ${
          tooSmall
            ? "border-amber-500/40 bg-amber-500/[0.05]"
            : "border-emerald-500/30 bg-emerald-500/[0.04]"
        }`}
      >
        <div className="flex items-baseline justify-between">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-neutral-500">
              Audience preview
            </div>
            <div
              className={`text-2xl font-semibold tabular-nums mt-0.5 ${
                tooSmall ? "text-amber-300" : "text-emerald-300"
              }`}
            >
              {fmtNum(count)} <span className="text-sm text-neutral-500">customers match</span>
            </div>
          </div>
          {resp.segment_preview.sample.length > 0 && (
            <div className="text-right">
              <div className="text-[10px] uppercase tracking-wider text-neutral-500">
                Sample top-LTV
              </div>
              <div className="text-xs text-neutral-300 max-w-[260px] truncate">
                {resp.segment_preview.sample[0]?.full_name} ·{" "}
                {fmtInr(resp.segment_preview.sample[0]?.lifetime_value ?? 0)}
              </div>
            </div>
          )}
        </div>
        {tooSmall && (
          <p className="text-xs text-amber-200/80 mt-2">
            Plan produced an empty segment. Loosen filters below (drop a city, lower LTV minimum,
            extend the lapsed window) and the preview refreshes when you save the draft.
          </p>
        )}
      </div>

      {/* Name */}
      <Field label="Campaign name">
        <input
          value={plan.name}
          onChange={(e) => onChange({ ...plan, name: e.target.value })}
          className="w-full rounded-md border border-neutral-700 bg-neutral-950 px-2.5 py-1.5 text-sm focus:border-violet-500/50 focus:outline-none"
        />
      </Field>

      {/* Rationale */}
      <Field label="AI rationale">
        <p className="text-sm text-neutral-200 leading-relaxed">{plan.rationale}</p>
      </Field>

      {/* Channel priority */}
      <Field label="Channel priority (edit on the campaign detail page)">
        <div className="flex flex-wrap items-center gap-1.5">
          {plan.channel_priority.map((c, i) => (
            <span key={c} className="inline-flex items-center gap-1.5">
              <span className="font-mono text-[10px] text-neutral-500 tabular-nums">{i + 1}</span>
              <ChannelBadge channel={c} size="md" />
            </span>
          ))}
        </div>
      </Field>

      {/* Message template */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <div className="text-[10px] uppercase tracking-wider text-neutral-500">
            Message template (editable)
          </div>
          <button
            type="button"
            onClick={onRegenerateMessage}
            disabled={regenBusy || !goal.trim()}
            title="Re-roll the message with the same goal and angle"
            className="text-[11px] inline-flex items-center gap-1.5 rounded-md border border-violet-500/40 bg-violet-500/10 text-violet-200 px-2.5 py-1 hover:bg-violet-500/20 disabled:opacity-50 disabled:cursor-not-allowed transition"
          >
            {regenBusy ? <AILoader label="Rewriting…" /> : <>↻ Regenerate</>}
          </button>
        </div>
        <textarea
          value={plan.message_template}
          onChange={(e) => onChange({ ...plan, message_template: e.target.value })}
          rows={3}
          className="w-full rounded-md border border-neutral-700 bg-neutral-950 px-2.5 py-1.5 text-sm font-mono focus:border-violet-500/50 focus:outline-none"
        />
        <div className="text-[11px] text-neutral-500 mt-1">
          {plan.message_template.length} chars · variables: {Array.from(plan.message_template.matchAll(/\{\{([^}]+)\}\}/g)).map((m) => m[1]).join(", ") || "—"}
        </div>
      </div>

      {/* Angle + metric */}
      <div className="grid sm:grid-cols-2 gap-3">
        <Field label="Message angle">
          <p className="text-sm text-neutral-300">{plan.message_angle}</p>
        </Field>
        <Field label="Success metric">
          <p className="text-sm text-neutral-300">{plan.success_metric}</p>
        </Field>
      </div>

      {plan.suppression_notes && (
        <Field label="Suppression notes">
          <p className="text-xs text-neutral-400">{plan.suppression_notes}</p>
        </Field>
      )}

      {/* Definition viewer */}
      <details className="text-xs">
        <summary className="cursor-pointer text-neutral-500 hover:text-neutral-300">
          Underlying segment JSON (auditable)
        </summary>
        <pre className="mt-2 rounded border border-neutral-800 bg-neutral-950 px-3 py-2 text-[11px] font-mono text-neutral-300 overflow-x-auto">
          {JSON.stringify(plan.segment_definition, null, 2)}
        </pre>
      </details>

      <div className="flex items-center justify-between gap-3 border-t border-neutral-800 pt-3">
        <div className="text-xs text-neutral-500">
          On create, a new Segment + Campaign draft are saved. You'll land on the
          campaign detail page to fine-tune and launch.
        </div>
        <button
          onClick={onCreate}
          disabled={creating}
          className="shrink-0 rounded-md border border-violet-500/40 bg-violet-500/15 text-violet-200 px-3 py-1.5 text-sm hover:bg-violet-500/25 transition disabled:opacity-40"
        >
          {creating ? "Creating draft…" : "Create draft from plan →"}
        </button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-neutral-500 mb-1">{label}</div>
      {children}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
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
