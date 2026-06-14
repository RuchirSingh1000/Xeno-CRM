"""Campaign launch — the bridge from draft to live communications.

What launch does, in order:

1. Validate the campaign is in a launchable state (status=`draft`, has a segment,
   has a message template).
2. Run the segment query against current customer state. This is intentionally
   live, not snapshotted — re-launching tomorrow picks up newly-lapsed customers.
3. For each customer, the channel routing service picks one channel (or skips
   with a reason).
4. Create one `Communication` row per *targeted* customer, with rendered_message
   stored.
5. POST each one to the channel simulator's /send. The simulator returns a
   provider_message_id; we write it back so incoming webhooks can join.
6. Mark the campaign `running`. Webhook ingestion does the rest.

Per-customer rendering happens here so we don't store unrendered templates on
the Communication. That makes the event log auditable: "what did we send to
this exact person?" — answer is `Communication.rendered_message`, no template
re-rendering needed.

Errors during /send are tolerated per-customer — a single provider failure
shouldn't abort the launch. The Communication row stays in `queued` state and
can be retried later.
"""
from __future__ import annotations

import json
import logging
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from typing import Any

import httpx
from sqlalchemy.orm import Session

from app.config import settings
from app.models import (
    Campaign,
    Communication,
    Consent,
    Customer,
    Segment,
)
from app.services.channel_routing import DEFAULT_PRIORITY, VALID_CHANNELS, route_one
from app.services.segment_engine import SegmentDefinition, build_query
from app.services.template import build_context, render

logger = logging.getLogger("launch")


def launch_campaign(db: Session, brand_name: str, campaign: Campaign) -> dict:
    """Synchronous launch. Returns a summary suitable for the API response.

    Synchronous because the simulator's /send is fast (accept + schedule). At
    production scale this would be a background worker; we'd batch + rate-limit
    by channel provider. For the demo, blocking is acceptable and lets the UI
    show the launch result immediately.
    """
    if campaign.status != "draft":
        return {"launched": False, "error": f"campaign is in '{campaign.status}' state, not draft"}
    if not campaign.segment_id:
        return {"launched": False, "error": "campaign has no segment"}
    if not (campaign.message_template or "").strip():
        return {"launched": False, "error": "campaign has no message template"}

    seg = db.get(Segment, campaign.segment_id)
    if not seg:
        return {"launched": False, "error": "segment not found"}

    definition = SegmentDefinition.model_validate(seg.definition_json or {})
    priority: list[str] = (campaign.channel_policy_json or {}).get("priority", list(DEFAULT_PRIORITY))
    priority = [p for p in priority if p in VALID_CHANNELS] or list(DEFAULT_PRIORITY)

    # Mark launching before any side effects so a crash leaves visible state.
    campaign.status = "launching"
    campaign.launched_at = datetime.now(timezone.utc)
    db.commit()

    customers: list[Customer] = build_query(db, campaign.brand_id, definition).all()
    if not customers:
        campaign.status = "draft"
        db.commit()
        return {"launched": False, "error": "segment matched 0 customers"}

    customer_ids = [c.id for c in customers]
    consents = {
        c.customer_id: c
        for c in db.query(Consent).filter(Consent.customer_id.in_(customer_ids)).all()
    }

    targeted = 0
    skipped = 0
    skipped_reasons: dict[str, int] = {}
    by_channel: dict[str, int] = {}
    sent_failures = 0

    # Pre-generate provider_message_ids. Setting them BEFORE commit closes the
    # race window where the simulator's first webhook could arrive at the CRM
    # receiver before the Communication row's provider_message_id was committed —
    # which dropped events into status=no_communication for the whole launch.
    to_dispatch: list[dict[str, Any]] = []
    for cust in customers:
        decision = route_one(cust, consents.get(cust.id), priority)
        if not decision.channel:
            skipped += 1
            skipped_reasons[decision.reason] = skipped_reasons.get(decision.reason, 0) + 1
            continue

        ctx = build_context(cust, brand_name)
        rendered = render(campaign.message_template, ctx)
        recipient = cust.primary_phone if decision.channel in ("whatsapp", "sms", "rcs") else cust.primary_email
        pmid = f"msg_{uuid.uuid4().hex[:16]}"

        comm = Communication(
            campaign_id=campaign.id,
            customer_id=cust.id,
            resolved_channel=decision.channel,
            routing_reason=decision.reason,
            rendered_message=rendered,
            recipient=recipient,
            current_status="queued",
            provider_message_id=pmid,
        )
        db.add(comm)
        targeted += 1
        by_channel[decision.channel] = by_channel.get(decision.channel, 0) + 1
        to_dispatch.append({
            "comm_pending": comm,
            "channel": decision.channel,
            "recipient": recipient or "",
            "rendered": rendered,
            "provider_message_id": pmid,
        })

    db.flush()  # assign Communication.id

    # CRITICAL: commit BEFORE dispatch so the webhook receiver — running in a
    # different DB session — can SELECT * WHERE provider_message_id matches as
    # soon as the simulator fires its first event (which happens within ~30ms
    # of the simulator's BackgroundTasks accepting our /send).
    campaign.status = "launching"
    db.commit()

    # 5. Dispatch to the simulator in parallel. Sequential dispatch turned the
    # launch endpoint into the bottleneck — 165 sequential 50-100ms POSTs ate
    # the simulator's own scheduling window. A bounded thread pool gets us to
    # ~all-sent within a couple of seconds without hammering the simulator with
    # unlimited concurrency.
    #
    # Share one httpx.Client across the pool: creating per-request clients
    # burns through Windows ephemeral ports (each one leaves a TIME_WAIT entry)
    # and starts dropping connections at ~80-100 sends. A shared client with
    # keep-alive lets all workers reuse the same TCP connections.
    if to_dispatch:
        sent_failures = _dispatch_parallel(to_dispatch, campaign.id, campaign.name)

    campaign.status = "running"
    campaign.total_targeted = targeted
    campaign.total_skipped = skipped
    db.commit()

    return {
        "launched": True,
        "campaign_id": campaign.id,
        "targeted": targeted,
        "skipped": skipped,
        "skipped_reasons": skipped_reasons,
        "by_channel": by_channel,
        "send_failures": sent_failures,
        "demo_timescale": _get_simulator_timescale(),
    }


def _dispatch_parallel(items: list[dict[str, Any]], campaign_id: int, campaign_name: str) -> int:
    """Send all items to the simulator concurrently using one shared client.

    Returns the number of send failures. The shared client keeps the connection
    pool bounded; the ThreadPoolExecutor bounds wall-clock time. Together they
    keep both ends healthy under a 100+ comm launch.
    """
    failures = 0
    limits = httpx.Limits(max_connections=32, max_keepalive_connections=16)
    with httpx.Client(timeout=15.0, limits=limits) as client:
        def one(item: dict[str, Any]) -> bool:
            try:
                r = client.post(
                    f"{settings.channel_service_url}/send",
                    json={
                        "communication_id": item["comm_id"] if "comm_id" in item else item["comm_pending"].id,
                        "campaign_id": campaign_id,
                        "channel": item["channel"],
                        "recipient": item["recipient"],
                        "rendered_message": item["rendered"],
                        "provider_message_id": item["provider_message_id"],
                        "metadata": {"campaign_name": campaign_name},
                    },
                )
                return 200 <= r.status_code < 300
            except Exception as e:
                logger.warning(f"send failed: {e}")
                return False

        with ThreadPoolExecutor(max_workers=24) as pool:
            futures = [pool.submit(one, item) for item in items]
            for fut in as_completed(futures):
                if not fut.result():
                    failures += 1
    return failures


def retry_queued(db: Session, campaign: Campaign, brand_name: str) -> dict:
    """Re-dispatch any Communications stuck in queued/sent state.

    Used when the original launch lost webhooks to a race (pre-fix campaigns),
    or when a transient simulator outage left some Comms un-dispatched. Fresh
    provider_message_ids are generated so old ghost-events from the simulator
    can't be replayed onto the new ones.
    """
    stuck = (
        db.query(Communication)
        .filter(
            Communication.campaign_id == campaign.id,
            Communication.current_status.in_(["queued", "sent"]),
        )
        .all()
    )
    if not stuck:
        return {"retried": 0, "skipped_no_recipient": 0, "send_failures": 0}

    # Rotate provider_message_ids first so the simulator can't conflate a new
    # dispatch with whatever it still has scheduled for the old pmid.
    rotations: list[dict[str, Any]] = []
    for comm in stuck:
        if not comm.recipient or not comm.resolved_channel:
            continue
        new_pmid = f"msg_{uuid.uuid4().hex[:16]}"
        comm.provider_message_id = new_pmid
        comm.current_status = "queued"
        comm.last_sequence = 0
        rotations.append({
            "comm_id": comm.id,
            "channel": comm.resolved_channel,
            "recipient": comm.recipient,
            "rendered": comm.rendered_message or "",
            "provider_message_id": new_pmid,
        })
    db.commit()

    skipped_no_recipient = len(stuck) - len(rotations)
    sent_failures = _dispatch_parallel(rotations, campaign.id, campaign.name) if rotations else 0

    if campaign.status == "completed":
        campaign.status = "running"
        campaign.completed_at = None
    db.commit()

    return {
        "retried": len(rotations),
        "skipped_no_recipient": skipped_no_recipient,
        "send_failures": sent_failures,
    }


def _get_simulator_timescale() -> float | None:
    try:
        with httpx.Client(timeout=2.0) as client:
            r = client.get(f"{settings.channel_service_url}/health")
            return r.json().get("demo_timescale")
    except Exception:
        return None
