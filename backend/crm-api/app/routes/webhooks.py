"""Webhook receipt + event log endpoints.

The receipt endpoint is the single integration boundary between the CRM and the
Channel Simulator (and, in production, between the CRM and real BSPs). It is
explicitly small — all the heavy logic lives in `webhook_receiver` so it can be
unit-tested cleanly.
"""
from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, Header, Request
from fastapi.responses import JSONResponse
from sqlalchemy import desc
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.models import Communication, CommunicationEvent, WebhookDelivery
from app.services.webhook_receiver import process_webhook, replay_delivery

router = APIRouter(tags=["webhooks"])


@router.post("/webhooks/channel-events")
async def receive_event(
    request: Request,
    x_xeno_signature: str | None = Header(default=None),
    x_xeno_event_id: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> JSONResponse:
    """Accept one event from the channel simulator.

    We read the raw body bytes for HMAC verification *before* JSON parsing,
    because re-serializing the parsed dict would break the signature.
    """
    raw = await request.body()
    try:
        import json
        payload = json.loads(raw.decode("utf-8")) if raw else {}
    except Exception:
        return JSONResponse({"error": "invalid json"}, status_code=400)

    # Push the sync DB work into a thread so the async event loop can keep
    # accepting webhooks concurrently. Without this, an `async def` route doing
    # sync SQL serializes all incoming webhooks through one coroutine.
    outcome, error = await asyncio.to_thread(
        process_webhook, db, raw, x_xeno_signature or "", x_xeno_event_id, payload
    )
    if outcome == "invalid_signature":
        return JSONResponse({"error": error}, status_code=401)
    if outcome == "no_communication":
        # 200 because we *received* it correctly — there's just no matching
        # communication yet. The simulator's retry policy shouldn't escalate.
        return JSONResponse({"outcome": outcome, "error": error}, status_code=200)
    if outcome == "failed":
        return JSONResponse({"outcome": outcome, "error": error}, status_code=400)
    return JSONResponse({"outcome": outcome}, status_code=200)


@router.get("/webhooks/deliveries")
def list_deliveries(db: Session = Depends(get_db), limit: int = 100) -> dict:
    rows = (
        db.query(WebhookDelivery)
        .order_by(desc(WebhookDelivery.id))
        .limit(limit)
        .all()
    )
    return {
        "deliveries": [
            {
                "id": d.id,
                "provider_event_id": d.provider_event_id,
                "status": d.status,
                "retry_count": d.retry_count,
                "last_error": d.last_error,
                "raw_payload": d.raw_payload,
                "received_at": d.received_at.isoformat() if d.received_at else None,
                "processed_at": d.processed_at.isoformat() if d.processed_at else None,
            }
            for d in rows
        ]
    }


@router.post("/webhooks/deliveries/{delivery_id}/replay")
def replay(delivery_id: int, db: Session = Depends(get_db)) -> dict:
    outcome, error = replay_delivery(db, delivery_id)
    return {"outcome": outcome, "error": error}


@router.get("/reliability/summary")
def reliability_summary(db: Session = Depends(get_db)) -> dict:
    """Snapshot of the webhook receiver's reliability story for the demo page.

    Surfaces the same answers any reviewer would want from looking at the
    code: how do you handle volume, ordering, retries, failures? Each number
    here maps to a code-level guarantee.
    """
    from sqlalchemy import func, case

    # Deliveries by terminal status
    by_status = dict(
        db.query(WebhookDelivery.status, func.count(WebhookDelivery.id))
        .group_by(WebhookDelivery.status)
        .all()
    )
    total_deliveries = sum(by_status.values())

    # Event-level signals — out-of-order is "any event whose sequence is lower
    # than a previously-applied event for the same communication". We don't
    # store an explicit flag, but we can infer the rate from the Communication
    # rows whose last_sequence is *less than* the max sequence among their
    # events (i.e. a higher-rank later event overrode an earlier-arriving one).
    from app.models import Communication, CommunicationEvent
    # cheap proxy: count events whose sequence is less than the running max
    # for that communication's events (using SQL window in a subquery)
    # SQLite-safe: do a python pass on (comm_id, sequence) ordered by id.
    rows = (
        db.query(
            CommunicationEvent.communication_id,
            CommunicationEvent.sequence,
            CommunicationEvent.id,
        )
        .order_by(CommunicationEvent.id.asc())
        .all()
    )
    out_of_order = 0
    seen_max: dict[int, int] = {}
    for cid, seq, _ in rows:
        prev = seen_max.get(cid)
        if prev is not None and seq < prev:
            out_of_order += 1
        if prev is None or seq > prev:
            seen_max[cid] = seq

    # Retries — sum WebhookDelivery.retry_count
    total_retries = (
        db.query(func.coalesce(func.sum(WebhookDelivery.retry_count), 0)).scalar() or 0
    )

    # Failed deliveries that are now eligible for replay (status = failed)
    failed_count = by_status.get("failed", 0)

    # Throughput context — events per minute over the last hour
    from datetime import datetime, timedelta, timezone
    one_hour_ago = datetime.now(timezone.utc) - timedelta(hours=1)
    recent_events = (
        db.query(func.count(CommunicationEvent.id))
        .filter(CommunicationEvent.received_at >= one_hour_ago)
        .scalar() or 0
    )

    duplicates = by_status.get("duplicate", 0)
    processed = by_status.get("processed", 0)
    invalid_sig = by_status.get("invalid_signature", 0)
    no_comm = by_status.get("no_communication", 0)

    return {
        "total_deliveries": total_deliveries,
        "by_status": {
            "processed": processed,
            "duplicate": duplicates,
            "invalid_signature": invalid_sig,
            "no_communication": no_comm,
            "failed": failed_count,
        },
        "idempotency": {
            "duplicates_absorbed": duplicates,
            "rate": (duplicates / total_deliveries) if total_deliveries else 0.0,
            "note": "UNIQUE(provider_event_id) on communication_events + INSERT-then-catch absorbs replays atomically. Every duplicate POST returns 200 OK without double-counting.",
        },
        "ordering": {
            "out_of_order_events": out_of_order,
            "note": "Events carry a monotonically increasing `sequence` per communication. The reducer keeps the highest-rank state, so a late-arriving `delivered` cannot overwrite a `clicked` even if the network reordered them.",
        },
        "security": {
            "rejected_invalid_signature": invalid_sig,
            "note": "Every webhook is HMAC-signed with a shared secret; signature failure → status=invalid_signature, 401 returned, no state mutation.",
        },
        "retries": {
            "total_retries": int(total_retries),
            "failed_pending_replay": failed_count,
            "note": "Failed deliveries persist with raw_payload + last_error. Operator can replay one via /webhooks/deliveries/{id}/replay — the same idempotency guard prevents double-application.",
        },
        "throughput": {
            "events_last_hour": recent_events,
            "note": "FastAPI default threadpool bumped to 200 tokens on startup so a burst of concurrent webhooks doesn't queue past the simulator's read timeout.",
        },
    }


@router.post("/reliability/simulate-failure")
def simulate_failure(db: Session = Depends(get_db), kind: str = "transient") -> dict:
    """Demo helper: inject a real WebhookDelivery row in a failure state so the
    reliability page has something to act on. Three flavours:
      - kind=transient:        status=failed, replay will succeed
      - kind=invalid_signature: status=invalid_signature, signature won't verify on replay
      - kind=no_communication:  status=no_communication, references unknown provider_message_id

    Why this exists: in a healthy demo the simulator delivers everything cleanly,
    so the replay surface looks dead. This lets reviewers see the full failure
    lifecycle end-to-end without us mutilating the receiver code.
    """
    import uuid
    from datetime import datetime, timezone

    payload = {
        "provider_event_id": f"sim-fail-{uuid.uuid4().hex[:10]}",
        "provider_message_id": f"sim-msg-{uuid.uuid4().hex[:10]}",
        "status": "failed" if kind == "transient" else "delivered",
        "sequence": 1,
        "occurred_at": datetime.now(timezone.utc).isoformat(),
        "failure_reason": "simulated_transient" if kind == "transient" else None,
    }

    status_map = {
        "transient": "failed",
        "invalid_signature": "invalid_signature",
        "no_communication": "no_communication",
    }
    err_map = {
        "transient": "Simulated transient downstream error. Safe to replay.",
        "invalid_signature": "HMAC signature did not match",
        "no_communication": "Referenced provider_message_id has no Communication row",
    }
    row_status = status_map.get(kind, "failed")

    delivery = WebhookDelivery(
        provider_event_id=payload["provider_event_id"],
        status=row_status,
        retry_count=0,
        last_error=err_map.get(kind, "Simulated failure"),
        raw_payload=payload,
        received_at=datetime.now(timezone.utc),
    )
    db.add(delivery)
    db.commit()
    db.refresh(delivery)
    return {
        "delivery_id": delivery.id,
        "status": delivery.status,
        "kind": kind,
        "note": "Open the reliability page and click Replay on this row to see the idempotent recovery path.",
    }


@router.get("/webhooks/deliveries/failed")
def list_failed_deliveries(db: Session = Depends(get_db), limit: int = 25) -> dict:
    """Recent failed deliveries with enough context for the replay button."""
    rows = (
        db.query(WebhookDelivery)
        .filter(WebhookDelivery.status.in_(["failed", "invalid_signature", "no_communication"]))
        .order_by(desc(WebhookDelivery.id))
        .limit(limit)
        .all()
    )
    return {
        "deliveries": [
            {
                "id": r.id,
                "provider_event_id": r.provider_event_id,
                "status": r.status,
                "retry_count": r.retry_count,
                "last_error": r.last_error,
                "received_at": r.received_at.isoformat() if r.received_at else None,
                "payload_preview": str(r.raw_payload)[:200] if r.raw_payload else None,
            }
            for r in rows
        ]
    }


@router.get("/events")
def list_events(
    db: Session = Depends(get_db),
    limit: int = 100,
    campaign_id: int | None = None,
    communication_id: int | None = None,
    event_type: str | None = None,
) -> dict:
    """Recent CommunicationEvents for the Event Log UI."""
    q = db.query(CommunicationEvent).join(Communication, Communication.id == CommunicationEvent.communication_id)
    if campaign_id is not None:
        q = q.filter(Communication.campaign_id == campaign_id)
    if communication_id is not None:
        q = q.filter(CommunicationEvent.communication_id == communication_id)
    if event_type:
        q = q.filter(CommunicationEvent.event_type == event_type)
    rows = q.order_by(desc(CommunicationEvent.id)).limit(limit).all()
    # Pull communication context in one batch
    comm_ids = list({r.communication_id for r in rows})
    comms = {
        c.id: c for c in db.query(Communication).filter(Communication.id.in_(comm_ids)).all()
    } if comm_ids else {}
    return {
        "events": [
            {
                "id": r.id,
                "event_id": r.event_id,
                "communication_id": r.communication_id,
                "campaign_id": comms.get(r.communication_id).campaign_id if comms.get(r.communication_id) else None,
                "event_type": r.event_type,
                "sequence": r.sequence,
                "occurred_at": r.occurred_at.isoformat() if r.occurred_at else None,
                "received_at": r.received_at.isoformat() if r.received_at else None,
                "failure_reason": r.failure_reason,
                "resolved_channel": comms.get(r.communication_id).resolved_channel if comms.get(r.communication_id) else None,
                "customer_id": comms.get(r.communication_id).customer_id if comms.get(r.communication_id) else None,
            }
            for r in rows
        ]
    }


@router.get("/events/stats")
def event_stats(db: Session = Depends(get_db)) -> dict:
    """High-level counts for the Event Log header — totals across all events ever."""
    from sqlalchemy import func
    by_type = dict(
        db.query(CommunicationEvent.event_type, func.count(CommunicationEvent.id))
        .group_by(CommunicationEvent.event_type)
        .all()
    )
    total = sum(by_type.values())
    duplicates = (
        db.query(func.count(WebhookDelivery.id))
        .filter(WebhookDelivery.status == "duplicate")
        .scalar() or 0
    )
    invalid_sigs = (
        db.query(func.count(WebhookDelivery.id))
        .filter(WebhookDelivery.status == "invalid_signature")
        .scalar() or 0
    )
    failed_deliveries = (
        db.query(func.count(WebhookDelivery.id))
        .filter(WebhookDelivery.status.in_(["failed", "no_communication"]))
        .scalar() or 0
    )
    return {
        "total_events": total,
        "by_type": by_type,
        "duplicates_ignored": duplicates,
        "invalid_signatures": invalid_sigs,
        "failed_deliveries": failed_deliveries,
    }
