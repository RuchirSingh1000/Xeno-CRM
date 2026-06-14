"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { Stat } from "@/components/Stat";
import { ChannelBadge } from "@/components/ChannelBadge";
import {
  getEventStats,
  listEvents,
  listWebhookDeliveries,
  replayDelivery,
  type CommunicationEvent,
  type EventStats,
  type WebhookDelivery,
} from "@/lib/api";
import { fmtNum, fmtRelative } from "@/lib/format";

const EVENT_TYPE_TONE: Record<string, string> = {
  queued: "text-neutral-400",
  sent: "text-neutral-300",
  delivered: "text-emerald-400",
  opened: "text-sky-400",
  read: "text-sky-400",
  clicked: "text-violet-400",
  converted: "text-amber-300",
  failed: "text-red-400",
};

const DELIVERY_STATUS_TONE: Record<string, string> = {
  processed: "text-emerald-400",
  duplicate: "text-sky-400",
  invalid_signature: "text-red-400",
  no_communication: "text-amber-400",
  failed: "text-red-400",
  received: "text-neutral-400",
};

export default function EventLogPage() {
  const [tab, setTab] = useState<"events" | "deliveries">("events");
  const [events, setEvents] = useState<CommunicationEvent[]>([]);
  const [stats, setStats] = useState<EventStats | null>(null);
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [filter, setFilter] = useState<string>("");

  const refresh = async () => {
    const [e, s, d] = await Promise.all([
      listEvents({ limit: 200 }),
      getEventStats(),
      listWebhookDeliveries(100),
    ]);
    setEvents(e);
    setStats(s);
    setDeliveries(d);
  };

  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => {
    if (!autoRefresh) return;
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [autoRefresh]);

  const filteredEvents = useMemo(
    () => (filter ? events.filter((e) => e.event_type === filter) : events),
    [events, filter]
  );

  return (
    <div className="min-h-screen animate-fade-in">
      <PageHeader
        eyebrow="Engagement"
        title="Event log"
        description="Append-only audit of every webhook event the CRM has received from the Channel Simulator. HMAC-signed on send, deduplicated on receipt by event_id. Communication state is derived from max(sequence), so out-of-order delivery is safe by construction."
        actions={
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs text-neutral-400">
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={(e) => setAutoRefresh(e.target.checked)}
                className="accent-emerald-500"
              />
              Auto-refresh
              {autoRefresh && (
                <span className="text-emerald-400 text-[10px] animate-pulse">●</span>
              )}
            </label>
            <button
              onClick={refresh}
              className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm hover:bg-neutral-800 transition"
            >
              Refresh
            </button>
          </div>
        }
      />

      <div className="px-8 py-8 max-w-7xl space-y-6">
        {/* Top stats */}
        {stats && (
          <section className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            <Stat label="Total events" value={fmtNum(stats.total_events)} tone="emerald" />
            <Stat label="Duplicates ignored" value={fmtNum(stats.duplicates_ignored)} tone="sky" sub="idempotency works" />
            <Stat label="Invalid signatures" value={fmtNum(stats.invalid_signatures)} tone={stats.invalid_signatures > 0 ? "rose" : "emerald"} sub="HMAC rejected" />
            <Stat label="Failed deliveries" value={fmtNum(stats.failed_deliveries)} tone={stats.failed_deliveries > 0 ? "amber" : "emerald"} />
            <Stat label="Lifecycle types" value={Object.keys(stats.by_type).length} tone="violet" sub="states observed" />
          </section>
        )}

        {/* Event type filter chips */}
        {stats && Object.keys(stats.by_type).length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-neutral-500 mr-1">Filter:</span>
            <button
              onClick={() => setFilter("")}
              className={`text-[11px] rounded-full border px-2 py-0.5 transition ${
                !filter
                  ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-300"
                  : "border-neutral-700 bg-neutral-900 text-neutral-400 hover:bg-neutral-800"
              }`}
            >
              All ({fmtNum(stats.total_events)})
            </button>
            {Object.entries(stats.by_type).map(([t, n]) => (
              <button
                key={t}
                onClick={() => setFilter(t)}
                className={`text-[11px] rounded-full border px-2 py-0.5 transition ${
                  filter === t
                    ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-300"
                    : "border-neutral-700 bg-neutral-900 text-neutral-400 hover:bg-neutral-800"
                }`}
              >
                <span className={EVENT_TYPE_TONE[t]}>{t}</span>{" "}
                <span className="text-neutral-500">{fmtNum(n)}</span>
              </button>
            ))}
          </div>
        )}

        {/* Tabs */}
        <div className="border-b border-neutral-800 flex gap-1">
          <TabButton active={tab === "events"} onClick={() => setTab("events")}>
            Events <span className="ml-1.5 text-[10px] font-mono text-neutral-500">{events.length}</span>
          </TabButton>
          <TabButton active={tab === "deliveries"} onClick={() => setTab("deliveries")}>
            Webhook deliveries <span className="ml-1.5 text-[10px] font-mono text-neutral-500">{deliveries.length}</span>
          </TabButton>
        </div>

        {tab === "events" &&
          (filteredEvents.length === 0 ? (
            <EmptyState
              title="No events yet"
              description="Launch a campaign to see webhooks stream in. Communications go queued → sent → delivered → opened/read → clicked → converted (or failed)."
              actionLabel="Open campaigns"
              actionHref="/campaigns"
            />
          ) : (
            <div className="rounded-lg border border-neutral-800 bg-neutral-900/30 overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-neutral-900/80 text-[10px] uppercase tracking-wider text-neutral-500">
                  <tr>
                    <th className="text-left px-3 py-2">#</th>
                    <th className="text-left px-3 py-2">Event ID</th>
                    <th className="text-left px-3 py-2">Type</th>
                    <th className="text-left px-3 py-2">Channel</th>
                    <th className="text-left px-3 py-2">Campaign / Comm</th>
                    <th className="text-left px-3 py-2">Seq</th>
                    <th className="text-left px-3 py-2">Occurred</th>
                    <th className="text-left px-3 py-2">Received</th>
                    <th className="text-left px-3 py-2">Failure reason</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredEvents.map((e) => (
                    <tr key={e.id} className="border-t border-neutral-800/60 hover:bg-neutral-900/40">
                      <td className="px-3 py-1.5 font-mono text-[11px] text-neutral-500">{e.id}</td>
                      <td className="px-3 py-1.5 font-mono text-[11px] text-neutral-400 truncate max-w-[180px]">
                        {e.event_id}
                      </td>
                      <td className={`px-3 py-1.5 text-xs font-mono ${EVENT_TYPE_TONE[e.event_type] ?? "text-neutral-300"}`}>
                        {e.event_type}
                      </td>
                      <td className="px-3 py-1.5">
                        {e.resolved_channel ? <ChannelBadge channel={e.resolved_channel} /> : <span className="text-neutral-700">—</span>}
                      </td>
                      <td className="px-3 py-1.5 text-xs text-neutral-400">
                        {e.campaign_id && (
                          <Link href={`/campaigns/${e.campaign_id}`} className="text-emerald-400 hover:text-emerald-300">
                            #{e.campaign_id}
                          </Link>
                        )}
                        <span className="text-neutral-700"> / </span>
                        <span className="font-mono">{e.communication_id}</span>
                      </td>
                      <td className="px-3 py-1.5 font-mono text-[11px] text-neutral-500 tabular-nums">{e.sequence}</td>
                      <td className="px-3 py-1.5 text-xs text-neutral-400">{fmtRelative(e.occurred_at)}</td>
                      <td className="px-3 py-1.5 text-xs text-neutral-500">{fmtRelative(e.received_at)}</td>
                      <td className="px-3 py-1.5 text-xs text-red-300/80">{e.failure_reason ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}

        {tab === "deliveries" && (
          <DeliveriesTable deliveries={deliveries} onReplay={async (id) => {
            await replayDelivery(id);
            await refresh();
          }} />
        )}
      </div>
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`relative px-3 py-2 text-sm transition ${
        active ? "text-neutral-100" : "text-neutral-500 hover:text-neutral-300"
      }`}
    >
      {children}
      {active && <span className="absolute -bottom-px left-2 right-2 h-px bg-emerald-400" />}
    </button>
  );
}

function DeliveriesTable({
  deliveries,
  onReplay,
}: {
  deliveries: WebhookDelivery[];
  onReplay: (id: number) => Promise<void>;
}) {
  if (deliveries.length === 0) {
    return (
      <EmptyState
        title="No webhook deliveries yet"
        description="This view captures every inbound webhook attempt: processed, duplicate, invalid signature, or failed. Replay button next to failures forces a re-process."
      />
    );
  }
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/30 overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-neutral-900/80 text-[10px] uppercase tracking-wider text-neutral-500">
          <tr>
            <th className="text-left px-3 py-2">#</th>
            <th className="text-left px-3 py-2">Provider event id</th>
            <th className="text-left px-3 py-2">Status</th>
            <th className="text-left px-3 py-2">Retries</th>
            <th className="text-left px-3 py-2">Received</th>
            <th className="text-left px-3 py-2">Processed</th>
            <th className="text-left px-3 py-2">Last error</th>
            <th className="px-3 py-2"></th>
          </tr>
        </thead>
        <tbody>
          {deliveries.map((d) => {
            const canReplay = d.status === "failed" || d.status === "no_communication" || d.status === "invalid_signature";
            return (
              <tr key={d.id} className="border-t border-neutral-800/60">
                <td className="px-3 py-1.5 font-mono text-[11px] text-neutral-500">{d.id}</td>
                <td className="px-3 py-1.5 font-mono text-[11px] text-neutral-400 truncate max-w-[200px]">
                  {d.provider_event_id ?? "—"}
                </td>
                <td className={`px-3 py-1.5 text-xs font-mono ${DELIVERY_STATUS_TONE[d.status] ?? "text-neutral-300"}`}>
                  {d.status}
                </td>
                <td className="px-3 py-1.5 font-mono text-[11px] text-neutral-500 tabular-nums">{d.retry_count}</td>
                <td className="px-3 py-1.5 text-xs text-neutral-400">{fmtRelative(d.received_at)}</td>
                <td className="px-3 py-1.5 text-xs text-neutral-500">{fmtRelative(d.processed_at)}</td>
                <td className="px-3 py-1.5 text-[11px] text-red-300/80 truncate max-w-[260px]">
                  {d.last_error ?? ""}
                </td>
                <td className="px-3 py-1.5 text-right">
                  {canReplay && (
                    <button
                      onClick={() => onReplay(d.id)}
                      className="text-[11px] text-emerald-400 hover:text-emerald-300"
                    >
                      Replay
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
