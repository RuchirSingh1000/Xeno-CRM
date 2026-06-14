"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { SourceBadge } from "@/components/SourceBadge";
import { ConfidenceBar } from "@/components/ConfidenceBar";
import { Stat } from "@/components/Stat";
import { Skeleton, SkeletonCard } from "@/components/Skeleton";
import { AILoader, AILoaderBlock } from "@/components/AILoader";
import { useAIThinking } from "@/components/AIThinking";
import { useNavHistory } from "@/components/NavHistory";
import { explainMerge, getCustomer, type CustomerDetail, type MergeExplanation } from "@/lib/api";
import { fmtDate, fmtInr, fmtNum, fmtRelative, sourceLabel } from "@/lib/format";

type Tab = "overview" | "identities" | "orders" | "consent";

const TABS: { key: Tab; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "identities", label: "Source identities" },
  { key: "orders", label: "Orders" },
  { key: "consent", label: "Consent" },
];

export default function CustomerDetailPage() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const [data, setData] = useState<CustomerDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("overview");
  const [notFound, setNotFound] = useState(false);
  const nav = useNavHistory();

  useEffect(() => {
    if (!Number.isFinite(id)) return;
    getCustomer(id).then((d) => {
      if (!d) setNotFound(true);
      setData(d);
      setLoading(false);
    });
  }, [id]);

  if (notFound) {
    return (
      <div className="min-h-screen">
        <PageHeader title="Customer not found" />
        <div className="px-8 py-8">
          <Link href="/customers" className="text-emerald-400 hover:text-emerald-300">
            ← Back to customers
          </Link>
        </div>
      </div>
    );
  }

  if (loading || !data) {
    return (
      <div className="min-h-screen animate-fade-in">
        <div className="border-b border-neutral-800/80 bg-neutral-950 px-8 py-5">
          <Skeleton className="h-3 w-24 mb-3" />
          <div className="flex items-center gap-4">
            <Skeleton className="h-12 w-12 rounded-md" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-5 w-48" />
              <Skeleton className="h-3 w-72" />
            </div>
          </div>
        </div>
        <div className="px-8 py-6 max-w-6xl space-y-4">
          <SkeletonCard rows={4} />
          <div className="grid lg:grid-cols-3 gap-4">
            <SkeletonCard rows={3} />
            <SkeletonCard rows={3} />
            <SkeletonCard rows={3} />
          </div>
        </div>
      </div>
    );
  }

  const hasFlagged = data.identities.some((i) =>
    i.match_reasoning?.startsWith("[name_city_only]")
  );

  return (
    <div className="min-h-screen">
      <div className="border-b border-neutral-800/80 bg-neutral-950">
        <div className="px-8 py-5">
          {nav.canGoBack ? (
            <button
              onClick={() => nav.back()}
              className="text-xs text-neutral-500 hover:text-neutral-300"
              aria-label="Go back to previous page"
            >
              ← Back
            </button>
          ) : (
            <Link
              href="/customers"
              className="text-xs text-neutral-500 hover:text-neutral-300"
            >
              ← Customers
            </Link>
          )}
        </div>

        <div className="px-8 pb-5">
          <div className="flex items-start gap-4">
            <Avatar name={data.full_name ?? "?"} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <h1 className="text-2xl font-semibold tracking-tight">
                  {data.full_name ?? "Unknown"}
                </h1>
                {hasFlagged && (
                  <span className="text-[10px] uppercase tracking-wider rounded border border-amber-500/40 bg-amber-500/10 text-amber-300 px-1.5 py-0.5">
                    Flagged
                  </span>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-neutral-400">
                <span className="font-mono text-neutral-500">{data.master_customer_id}</span>
                {data.city && (
                  <>
                    <span className="text-neutral-700">·</span>
                    <span>{data.city}</span>
                  </>
                )}
                {data.loyalty_tier && (
                  <>
                    <span className="text-neutral-700">·</span>
                    <span className="rounded-full border border-neutral-700 bg-neutral-900 px-2 py-0.5">
                      {data.loyalty_tier}
                    </span>
                  </>
                )}
                <span className="text-neutral-700">·</span>
                <span>{data.identities.length} source{data.identities.length === 1 ? "" : "s"}</span>
                <span className="text-neutral-700">·</span>
                <span>Last seen {fmtRelative(data.last_order_at)}</span>
              </div>
            </div>
            <div className="hidden md:grid grid-cols-3 gap-2 text-right">
              <Stat label="LTV" value={fmtInr(data.lifetime_value)} tone="emerald" />
              <Stat label="Orders" value={fmtNum(data.total_orders)} />
              <Stat label="Sources" value={data.identities.length} />
            </div>
          </div>
        </div>

        <div className="px-8">
          <div className="flex items-center gap-1">
            {TABS.map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`relative px-3 py-2 text-sm transition ${
                  tab === t.key
                    ? "text-neutral-100"
                    : "text-neutral-500 hover:text-neutral-300"
                }`}
              >
                {t.label}
                {t.key === "identities" && (
                  <span className="ml-1.5 text-[10px] font-mono text-neutral-500">
                    {data.identities.length}
                  </span>
                )}
                {t.key === "orders" && (
                  <span className="ml-1.5 text-[10px] font-mono text-neutral-500">
                    {data.orders.length}
                  </span>
                )}
                {tab === t.key && (
                  <span className="absolute -bottom-px left-2 right-2 h-px bg-emerald-400" />
                )}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="px-8 py-6 max-w-6xl">
        {tab === "overview" && <OverviewTab data={data} />}
        {tab === "identities" && <IdentitiesTab data={data} />}
        {tab === "orders" && <OrdersTab data={data} />}
        {tab === "consent" && <ConsentTab data={data} />}
      </div>
    </div>
  );
}

function Avatar({ name }: { name: string }) {
  const initials = name
    .split(" ")
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return (
    <div className="h-12 w-12 rounded-md bg-gradient-to-br from-emerald-500/40 to-emerald-700/40 border border-emerald-500/30 flex items-center justify-center shrink-0">
      <span className="text-base font-semibold text-emerald-100">{initials}</span>
    </div>
  );
}

function OverviewTab({ data }: { data: CustomerDetail }) {
  return (
    <div className="space-y-6">
      {/* Resolution chain — visual indicator of which sources merged */}
      <section>
        <h3 className="text-[11px] uppercase tracking-widest text-neutral-500 mb-3">
          Resolution chain
        </h3>
        <div className="rounded-lg border border-neutral-800 bg-neutral-900/30 p-4">
          <div className="flex flex-wrap items-center gap-2">
            {data.identities.map((i, idx) => (
              <div key={i.id} className="flex items-center gap-2">
                <div className="rounded-md border border-neutral-800 bg-neutral-950/60 px-2.5 py-1.5 flex items-center gap-2">
                  <SourceBadge source={i.source_system} />
                  <span className="text-xs text-neutral-400 font-mono">{i.match_confidence.toFixed(2)}</span>
                </div>
                {idx < data.identities.length - 1 && (
                  <span className="text-neutral-700 text-sm">→</span>
                )}
              </div>
            ))}
            <span className="text-neutral-700 text-sm">→</span>
            <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1.5">
              <span className="text-xs font-mono text-emerald-300">{data.master_customer_id}</span>
            </div>
          </div>
          {data.identities.length > 1 && (
            <p className="text-xs text-neutral-500 mt-3">
              {data.identities.length} source rows were resolved into this canonical
              customer. Click <span className="text-neutral-300">Source identities</span>{" "}
              above to see the raw values and merge reasoning.
            </p>
          )}
        </div>
      </section>

      <section className="grid lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 space-y-4">
          {/* Contact */}
          <div className="rounded-lg border border-neutral-800 bg-neutral-900/30 p-4">
            <h3 className="text-[11px] uppercase tracking-widest text-neutral-500 mb-3">
              Canonical contact
            </h3>
            <div className="grid sm:grid-cols-2 gap-3 text-sm">
              <Field label="Email" value={data.primary_email} mono />
              <Field label="Phone" value={data.primary_phone} mono />
              <Field label="City" value={data.city} />
              <Field label="Loyalty tier" value={data.loyalty_tier} />
            </div>
          </div>

          {/* Top categories */}
          {data.top_categories.length > 0 && (
            <div className="rounded-lg border border-neutral-800 bg-neutral-900/30 p-4">
              <h3 className="text-[11px] uppercase tracking-widest text-neutral-500 mb-3">
                Top categories
              </h3>
              <div className="space-y-1.5">
                {data.top_categories.map((c) => {
                  const max = Math.max(...data.top_categories.map((x) => x.count));
                  const pct = max > 0 ? (c.count / max) * 100 : 0;
                  return (
                    <div key={c.category}>
                      <div className="flex items-center justify-between text-xs mb-1">
                        <span className="text-neutral-300">{c.category}</span>
                        <span className="font-mono text-neutral-500 tabular-nums">
                          {c.count}
                        </span>
                      </div>
                      <div className="h-1 rounded-full bg-neutral-800 overflow-hidden">
                        <div className="h-full bg-emerald-500/70" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <div className="space-y-4">
          {/* Contactability summary */}
          <div className="rounded-lg border border-neutral-800 bg-neutral-900/30 p-4">
            <h3 className="text-[11px] uppercase tracking-widest text-neutral-500 mb-3">
              Contactability
            </h3>
            <div className="space-y-1.5 text-xs">
              <ContactRow channel="WhatsApp" ok={data.consent.whatsapp_opted_in} />
              <ContactRow channel="SMS" ok={data.consent.sms_opted_in} />
              <ContactRow channel="Email" ok={data.consent.email_opted_in} />
              <ContactRow channel="RCS" ok={data.consent.rcs_opted_in} />
            </div>
            {data.consent.dnd_status && (
              <div className="mt-3 rounded border border-red-500/40 bg-red-500/10 text-red-300 text-[11px] px-2 py-1.5">
                TRAI DND flag set — suppress all outbound
              </div>
            )}
          </div>

          {/* Top stores */}
          {data.top_stores.length > 0 && (
            <div className="rounded-lg border border-neutral-800 bg-neutral-900/30 p-4">
              <h3 className="text-[11px] uppercase tracking-widest text-neutral-500 mb-3">
                Top stores
              </h3>
              <div className="space-y-1.5 text-xs">
                {data.top_stores.map((s) => (
                  <div key={s.store} className="flex items-center justify-between">
                    <span className="font-mono text-neutral-300">{s.store}</span>
                    <span className="font-mono text-neutral-500 tabular-nums">{s.count}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function IdentitiesTab({ data }: { data: CustomerDetail }) {
  const [explanation, setExplanation] = useState<MergeExplanation | null>(null);
  const [explaining, setExplaining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ai = useAIThinking();

  const isFlagged = data.identities.some((i) =>
    i.match_reasoning?.startsWith("[name_city_only]")
  );
  const needsExplanation = data.identities.length > 1 && (isFlagged || data.identities.some(i => i.match_confidence < 0.95));

  const onExplain = async () => {
    setError(null);
    setExplaining(true);
    try {
      const r = await ai.run("Explaining merge with AI…", () => explainMerge(data.id));
      if (!r) {
        setError("AI explainer returned no response. Check /ai-runs for details.");
      } else {
        setExplanation(r);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setExplaining(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-sky-500/20 bg-sky-500/[0.04] px-4 py-2.5 text-xs text-sky-200/80">
        <span className="text-sky-300 font-medium">{data.identities.length}</span> source
        row{data.identities.length === 1 ? "" : "s"} merged into{" "}
        <span className="font-mono text-sky-300">{data.master_customer_id}</span>.
        Each card below shows the raw values pulled from that source, the normalized
        match keys, and the rule that pulled it into this customer.
      </div>

      {needsExplanation && (
        <div className="neu-card accent-violet p-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[10px] uppercase tracking-widest text-c-violet font-semibold">
                  AI · merge explainer
                </span>
                {isFlagged && (
                  <span className="text-[10px] uppercase tracking-wider text-c-amber">
                    flagged
                  </span>
                )}
              </div>
              <p className="text-sm text-[var(--neu-text-muted)]">
                Generate a plain-English explanation of why these source rows were merged.
                Validated against a Pydantic schema, logged to{" "}
                <Link href="/ai-runs" className="text-c-violet hover:underline underline-offset-2">
                  ai_runs
                </Link>
                .
              </p>
            </div>
            <button
              onClick={onExplain}
              disabled={explaining}
              className="shrink-0 neu-btn neu-btn-primary px-4 py-2 text-sm min-w-[170px]"
            >
              {explaining ? <AILoader label="Asking model…" /> : explanation ? "Re-run" : "Explain with AI"}
            </button>
          </div>

          {error && (
            <div className="mt-3 neu-inset-sm px-3 py-2 text-xs text-c-rose">
              {error}
            </div>
          )}

          {explanation && (
            <div className="mt-4 space-y-3">
              <div className="neu-inset-sm p-3">
                <div className="text-[10px] uppercase tracking-wider text-[var(--neu-text-subtle)] mb-1">
                  Explanation
                </div>
                <p className="text-sm text-[var(--neu-text-strong)] leading-relaxed">{explanation.explanation}</p>
              </div>
              <div className="grid sm:grid-cols-2 gap-3">
                <div className="neu-raised-xs p-3">
                  <div className="text-[10px] uppercase tracking-wider text-[var(--neu-text-subtle)] mb-1">
                    Confidence assessment
                  </div>
                  <p className="text-xs text-[var(--neu-text-muted)] leading-relaxed">{explanation.confidence_assessment}</p>
                </div>
                <div className="neu-raised-xs p-3 flex flex-col">
                  <div className="text-[10px] uppercase tracking-wider text-[var(--neu-text-subtle)] mb-1">
                    Recommendation
                  </div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <RecommendationBadge value={explanation.recommendation} />
                  </div>
                  <div className="mt-auto pt-2 text-[10px] text-[var(--neu-text-subtle)] font-mono">
                    {explanation.provider}/{explanation.model} · {explanation.latency_ms}ms ·{" "}
                    <span
                      className={
                        explanation.validation_status === "ok"
                          ? "text-c-emerald"
                          : explanation.validation_status === "retry_used"
                          ? "text-xeno"
                          : "text-c-amber"
                      }
                    >
                      {explanation.validation_status}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="grid gap-3">
        {data.identities.map((i) => (
          <IdentityCard key={i.id} identity={i} />
        ))}
      </div>
    </div>
  );
}

function RecommendationBadge({ value }: { value: "approve" | "review" | "reject" }) {
  const styles: Record<string, string> = {
    approve: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
    review: "bg-amber-500/15 text-amber-300 border-amber-500/40",
    reject: "bg-red-500/15 text-red-300 border-red-500/40",
  };
  return (
    <span
      className={`inline-flex items-center rounded border text-xs px-2 py-0.5 uppercase tracking-wider font-mono ${styles[value]}`}
    >
      {value}
    </span>
  );
}

function IdentityCard({
  identity,
}: {
  identity: CustomerDetail["identities"][number];
}) {
  const isFlagged = identity.match_reasoning?.startsWith("[name_city_only]");
  const isSingleton = identity.match_reasoning?.startsWith("[singleton]");

  // Parse reasoning prefix
  let ruleLabel = "—";
  let expl = identity.match_reasoning ?? "";
  const m = identity.match_reasoning?.match(/^\[([^\]]+)\]\s*(.*)$/);
  if (m) {
    ruleLabel = m[1];
    expl = m[2];
  }

  return (
    <div
      className={`rounded-lg border p-4 ${
        isFlagged
          ? "border-amber-500/30 bg-amber-500/[0.03]"
          : "border-neutral-800 bg-neutral-900/30"
      }`}
    >
      <div className="flex items-start justify-between gap-4 mb-3">
        <div className="flex items-center gap-3">
          <SourceBadge source={identity.source_system} size="md" />
          <div>
            <div className="text-sm font-medium">{sourceLabel(identity.source_system)}</div>
            <div className="text-[11px] font-mono text-neutral-500 truncate max-w-[300px]">
              {identity.source_record_id}
            </div>
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-[10px] uppercase tracking-wider text-neutral-500 mb-1">
            Match confidence
          </div>
          <ConfidenceBar value={identity.match_confidence} />
        </div>
      </div>

      <div className="grid sm:grid-cols-3 gap-3 mb-3">
        <RawField label="Raw name" value={identity.raw_name} />
        <RawField label="Raw phone" value={identity.raw_phone} />
        <RawField label="Raw email" value={identity.raw_email} />
      </div>

      {(identity.normalized_phone || identity.normalized_email) && (
        <div className="grid sm:grid-cols-2 gap-3 mb-3">
          {identity.normalized_phone && (
            <RawField
              label="Normalized phone"
              value={identity.normalized_phone}
              tone="emerald"
            />
          )}
          {identity.normalized_email && (
            <RawField
              label="Normalized email"
              value={identity.normalized_email}
              tone="emerald"
            />
          )}
        </div>
      )}

      <div className="rounded-md border border-neutral-800 bg-neutral-950/60 p-2.5">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-[10px] uppercase tracking-wider text-neutral-500">
            Match rule
          </span>
          <span className="text-[10px] font-mono uppercase tracking-wider rounded bg-neutral-800 px-1.5 py-0.5 text-neutral-300">
            {ruleLabel}
          </span>
          {isFlagged && (
            <span className="text-[10px] uppercase tracking-wider text-amber-300">
              flagged for review
            </span>
          )}
          {isSingleton && (
            <span className="text-[10px] uppercase tracking-wider text-neutral-500">
              single source
            </span>
          )}
        </div>
        <p className="text-xs text-neutral-400">{expl}</p>
      </div>
    </div>
  );
}

function RawField({
  label,
  value,
  tone,
}: {
  label: string;
  value: string | null;
  tone?: "emerald";
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-neutral-500 mb-0.5">
        {label}
      </div>
      <div
        className={`text-sm font-mono truncate ${
          value ? (tone === "emerald" ? "text-emerald-300" : "text-neutral-200") : "text-neutral-600"
        }`}
      >
        {value ?? "—"}
      </div>
    </div>
  );
}

function OrdersTab({ data }: { data: CustomerDetail }) {
  if (data.orders.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-neutral-800 bg-neutral-900/30 px-6 py-10 text-center text-sm text-neutral-500">
        No orders attributed to this customer yet.
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/30 overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-neutral-900/80 text-[10px] uppercase tracking-wider text-neutral-500">
          <tr>
            <th className="text-left px-4 py-2">Date</th>
            <th className="text-left px-4 py-2">Source</th>
            <th className="text-left px-4 py-2">Order ID</th>
            <th className="text-left px-4 py-2">Category</th>
            <th className="text-left px-4 py-2">Store</th>
            <th className="text-right px-4 py-2">Items</th>
            <th className="text-right px-4 py-2">Amount</th>
          </tr>
        </thead>
        <tbody>
          {data.orders.map((o) => (
            <tr key={o.id} className="border-t border-neutral-800/60">
              <td className="px-4 py-2 text-xs text-neutral-300">{fmtDate(o.order_date)}</td>
              <td className="px-4 py-2">
                <SourceBadge source={o.source_system} />
              </td>
              <td className="px-4 py-2 font-mono text-[11px] text-neutral-500">
                {o.source_order_id}
              </td>
              <td className="px-4 py-2 text-neutral-300">{o.category ?? "—"}</td>
              <td className="px-4 py-2 font-mono text-[11px] text-neutral-400">
                {o.store_id ?? "—"}
              </td>
              <td className="px-4 py-2 text-right tabular-nums">{o.items_count}</td>
              <td className="px-4 py-2 text-right tabular-nums font-mono text-emerald-400/90">
                {fmtInr(o.amount)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ConsentTab({ data }: { data: CustomerDetail }) {
  const channels: Array<{ key: string; label: string; opted: boolean }> = [
    { key: "whatsapp", label: "WhatsApp", opted: data.consent.whatsapp_opted_in },
    { key: "sms", label: "SMS", opted: data.consent.sms_opted_in },
    { key: "email", label: "Email", opted: data.consent.email_opted_in },
    { key: "rcs", label: "RCS", opted: data.consent.rcs_opted_in },
  ];
  return (
    <div className="space-y-4">
      {data.consent.dnd_status && (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 text-red-300 text-sm px-4 py-3">
          <div className="font-medium mb-0.5">TRAI DND registry flag active</div>
          <p className="text-xs text-red-300/80">
            This customer is on India&apos;s Do-Not-Disturb registry. All outbound
            commercial communication must be suppressed regardless of channel-level opt-in.
          </p>
        </div>
      )}

      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {channels.map((c) => (
          <ChannelConsent key={c.key} label={c.label} opted={c.opted} dnd={data.consent.dnd_status} />
        ))}
      </div>

      <p className="text-xs text-neutral-500 max-w-2xl">
        Consent in this app is multi-channel: a customer may opt into WhatsApp but not SMS,
        or Email but not WhatsApp. Multi-channel routing uses these flags to choose
        the right channel per customer at send time — never the segment level.
      </p>
    </div>
  );
}

function ChannelConsent({
  label,
  opted,
  dnd,
}: {
  label: string;
  opted: boolean;
  dnd: boolean;
}) {
  const effective = opted && !dnd;
  return (
    <div
      className={`rounded-lg border p-4 ${
        effective
          ? "border-emerald-500/30 bg-emerald-500/[0.04]"
          : "border-neutral-800 bg-neutral-900/30"
      }`}
    >
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium">{label}</div>
        <span
          className={`h-2 w-2 rounded-full ${
            effective ? "bg-emerald-500" : "bg-neutral-700"
          }`}
        />
      </div>
      <div className="text-xs text-neutral-500 mt-1">
        {dnd ? "Blocked by DND" : opted ? "Opted in" : "Not opted in"}
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  mono,
}: {
  label: string;
  value: string | null | undefined;
  mono?: boolean;
}) {
  return (
    <div className="rounded-md border border-neutral-800 bg-neutral-950/60 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-neutral-500">{label}</div>
      <div
        className={`mt-0.5 text-sm ${
          mono ? "font-mono" : ""
        } ${value ? "text-neutral-200" : "text-neutral-600"}`}
      >
        {value ?? "—"}
      </div>
    </div>
  );
}

function ContactRow({ channel, ok }: { channel: string; ok: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-neutral-300">{channel}</span>
      <span className={ok ? "text-emerald-400" : "text-neutral-600"}>
        {ok ? "opted-in" : "—"}
      </span>
    </div>
  );
}
