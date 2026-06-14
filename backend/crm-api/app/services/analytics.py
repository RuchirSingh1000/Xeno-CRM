"""Cross-campaign analytics.

Phase 5 gave us per-campaign AI insight; Phase 6 is the portfolio view a CMO
or Growth lead would actually open every Monday. Questions answered here:

  - Which channels drive the most conversions per ₹ sent?
  - Which campaigns are pulling above (or below) their weight?
  - What's eating deliverability — invalid numbers, unsubscribes, rate limits?
  - How much revenue have campaigns moved this period?
  - Is the AI layer fast and reliable, or is it falling back?
  - How well are AI-generated plans performing vs hand-built ones?

Design choices:
- All aggregates derive from the same source tables (`communications`,
  `communication_events`, `ai_runs`). No separate analytics warehouse — Phase 6
  is a query-time view, not an ETL pipeline. Production scale would precompute
  rolling aggregates into `campaign_stats` rows, which is the path Phase 7
  notes for the deployment doc.
- Conversion revenue is parsed from `CommunicationEvent.raw_payload` at query
  time via SQLite's `json_extract`. Cleaner than a denormalized column, fast
  enough for the demo's hundreds-of-events dataset.
- Funnel reach uses `current_status` (the SoT) so every rate respects lifecycle
  invariants — same logic that fixed the per-campaign funnel.
"""
from __future__ import annotations

from typing import Any, Optional

from sqlalchemy import Float, case, cast, func
from sqlalchemy.orm import Session

from app.models import (
    AIRun,
    Campaign,
    Communication,
    CommunicationEvent,
    Customer,
    Segment,
    WebhookDelivery,
)


# ----- helpers -----

def _safe_pct(numerator: int | float, denominator: int | float) -> float:
    if not denominator:
        return 0.0
    return round(float(numerator) / float(denominator), 4)


def _conv_value_expr():
    """Return a SQLAlchemy expression that pulls conversion_value_inr from the
    raw_payload JSON. Works on SQLite via json_extract."""
    return cast(
        func.json_extract(CommunicationEvent.raw_payload, "$.metadata.conversion_value_inr"),
        Float,
    )


# ----- aggregates -----

def overview(db: Session, brand_id: int) -> dict[str, Any]:
    """Top-line numbers for the dashboard hero strip."""
    # Total campaigns by status
    camp_rows = (
        db.query(Campaign.status, func.count(Campaign.id))
        .filter(Campaign.brand_id == brand_id)
        .group_by(Campaign.status)
        .all()
    )
    by_status = dict(camp_rows)
    total_campaigns = sum(by_status.values())

    # Customers touched: distinct customer_id across all communications
    customers_reached = (
        db.query(func.count(func.distinct(Communication.customer_id)))
        .join(Campaign, Campaign.id == Communication.campaign_id)
        .filter(Campaign.brand_id == brand_id)
        .scalar() or 0
    )

    # Communications by current_status (across all campaigns)
    cs_rows = (
        db.query(Communication.current_status, func.count(Communication.id))
        .join(Campaign, Campaign.id == Communication.campaign_id)
        .filter(Campaign.brand_id == brand_id)
        .group_by(Communication.current_status)
        .all()
    )
    cs = dict(cs_rows)

    n_queued = cs.get("queued", 0)
    n_sent = cs.get("sent", 0)
    n_delivered = cs.get("delivered", 0)
    n_opened = cs.get("opened", 0)
    n_read = cs.get("read", 0)
    n_clicked = cs.get("clicked", 0)
    n_converted = cs.get("converted", 0)
    n_failed = cs.get("failed", 0)
    total_comms = sum(cs.values())

    sent_reached = total_comms - n_queued
    delivered_reached = n_delivered + n_opened + n_read + n_clicked + n_converted
    clicked_reached = n_clicked + n_converted
    converted_reached = n_converted

    # Revenue: SUM(conversion_value_inr) across all converted events for this brand
    revenue = (
        db.query(func.sum(_conv_value_expr()))
        .join(Communication, Communication.id == CommunicationEvent.communication_id)
        .join(Campaign, Campaign.id == Communication.campaign_id)
        .filter(
            Campaign.brand_id == brand_id,
            CommunicationEvent.event_type == "converted",
        )
        .scalar() or 0.0
    )

    return {
        "total_campaigns": total_campaigns,
        "campaigns_by_status": by_status,
        "customers_reached": customers_reached,
        "total_communications": total_comms,
        "sent_reached": sent_reached,
        "delivered_reached": delivered_reached,
        "clicked_reached": clicked_reached,
        "converted_reached": converted_reached,
        "failed": n_failed,
        "delivery_rate": _safe_pct(delivered_reached, sent_reached),
        "click_through_rate": _safe_pct(clicked_reached, delivered_reached),
        "conversion_rate": _safe_pct(converted_reached, delivered_reached),
        "failure_rate": _safe_pct(n_failed, sent_reached),
        "total_revenue_inr": round(float(revenue), 2),
        "revenue_per_communication_inr": _safe_pct(float(revenue), total_comms) * total_comms / max(1, total_comms),
    }


def channels(db: Session, brand_id: int) -> dict[str, Any]:
    """Per-channel performance: sent, delivered, clicked, converted, revenue."""
    # Group communications by resolved_channel and current_status
    rows = (
        db.query(
            Communication.resolved_channel,
            Communication.current_status,
            func.count(Communication.id),
        )
        .join(Campaign, Campaign.id == Communication.campaign_id)
        .filter(
            Campaign.brand_id == brand_id,
            Communication.resolved_channel.isnot(None),
        )
        .group_by(Communication.resolved_channel, Communication.current_status)
        .all()
    )

    by_channel: dict[str, dict[str, int]] = {}
    for channel, status, n in rows:
        by_channel.setdefault(channel, {})[status] = n

    # Per-channel revenue
    rev_rows = (
        db.query(Communication.resolved_channel, func.sum(_conv_value_expr()))
        .join(CommunicationEvent, CommunicationEvent.communication_id == Communication.id)
        .join(Campaign, Campaign.id == Communication.campaign_id)
        .filter(
            Campaign.brand_id == brand_id,
            CommunicationEvent.event_type == "converted",
        )
        .group_by(Communication.resolved_channel)
        .all()
    )
    revenue_by_channel = {ch: float(v or 0) for ch, v in rev_rows}

    out: list[dict[str, Any]] = []
    for channel in sorted(by_channel.keys()):
        cs = by_channel[channel]
        n_queued = cs.get("queued", 0)
        n_sent = cs.get("sent", 0)
        n_delivered = cs.get("delivered", 0)
        n_opened = cs.get("opened", 0)
        n_read = cs.get("read", 0)
        n_clicked = cs.get("clicked", 0)
        n_converted = cs.get("converted", 0)
        n_failed = cs.get("failed", 0)
        total = sum(cs.values())

        sent_r = total - n_queued
        delivered_r = n_delivered + n_opened + n_read + n_clicked + n_converted
        viewed_r = n_opened + n_read + n_clicked + n_converted
        clicked_r = n_clicked + n_converted
        converted_r = n_converted
        rev = revenue_by_channel.get(channel, 0.0)

        out.append({
            "channel": channel,
            "total": total,
            "sent": sent_r,
            "delivered": delivered_r,
            "viewed": viewed_r,
            "clicked": clicked_r,
            "converted": converted_r,
            "failed": n_failed,
            "delivery_rate": _safe_pct(delivered_r, sent_r),
            "view_rate": _safe_pct(viewed_r, delivered_r),
            "click_through_rate": _safe_pct(clicked_r, delivered_r),
            "conversion_rate": _safe_pct(converted_r, delivered_r),
            "revenue_inr": round(rev, 2),
            "revenue_per_send_inr": round(rev / max(1, sent_r), 2),
        })

    return {"channels": out}


def campaigns_leaderboard(db: Session, brand_id: int, limit: int = 20) -> dict[str, Any]:
    """Per-campaign performance — sortable in the UI."""
    camps = (
        db.query(Campaign)
        .filter(Campaign.brand_id == brand_id)
        .order_by(Campaign.id.desc())
        .limit(limit)
        .all()
    )

    out: list[dict[str, Any]] = []
    for c in camps:
        cs_rows = (
            db.query(Communication.current_status, func.count(Communication.id))
            .filter(Communication.campaign_id == c.id)
            .group_by(Communication.current_status)
            .all()
        )
        cs = dict(cs_rows)
        n_queued = cs.get("queued", 0)
        n_sent = cs.get("sent", 0)
        n_delivered = cs.get("delivered", 0)
        n_opened = cs.get("opened", 0)
        n_read = cs.get("read", 0)
        n_clicked = cs.get("clicked", 0)
        n_converted = cs.get("converted", 0)
        n_failed = cs.get("failed", 0)
        total = sum(cs.values())
        sent_r = total - n_queued
        delivered_r = n_delivered + n_opened + n_read + n_clicked + n_converted
        clicked_r = n_clicked + n_converted
        converted_r = n_converted

        # Revenue for this campaign
        rev = (
            db.query(func.sum(_conv_value_expr()))
            .join(Communication, Communication.id == CommunicationEvent.communication_id)
            .filter(
                Communication.campaign_id == c.id,
                CommunicationEvent.event_type == "converted",
            )
            .scalar() or 0.0
        )

        # Was this AI-planned?
        is_ai = bool(c.ai_plan_json) or False
        if c.segment_id:
            seg = db.get(Segment, c.segment_id)
            if seg and seg.created_by_ai:
                is_ai = True

        out.append({
            "id": c.id,
            "name": c.name,
            "status": c.status,
            "is_ai_planned": is_ai,
            "targeted": total,
            "sent": sent_r,
            "delivered": delivered_r,
            "clicked": clicked_r,
            "converted": converted_r,
            "failed": n_failed,
            "delivery_rate": _safe_pct(delivered_r, sent_r),
            "click_through_rate": _safe_pct(clicked_r, delivered_r),
            "conversion_rate": _safe_pct(converted_r, delivered_r),
            "revenue_inr": round(float(rev), 2),
            "created_at": c.created_at.isoformat() if c.created_at else None,
            "launched_at": c.launched_at.isoformat() if c.launched_at else None,
        })
    return {"campaigns": out}


def failures(db: Session, brand_id: int) -> dict[str, Any]:
    """Failure-reason breakdown across all events, plus webhook integrity."""
    reasons = (
        db.query(CommunicationEvent.failure_reason, func.count(CommunicationEvent.id))
        .join(Communication, Communication.id == CommunicationEvent.communication_id)
        .join(Campaign, Campaign.id == Communication.campaign_id)
        .filter(
            Campaign.brand_id == brand_id,
            CommunicationEvent.event_type == "failed",
            CommunicationEvent.failure_reason.isnot(None),
        )
        .group_by(CommunicationEvent.failure_reason)
        .order_by(func.count(CommunicationEvent.id).desc())
        .all()
    )
    by_reason = [{"reason": r, "count": n} for r, n in reasons]

    # Per-channel failure mix
    chan_rows = (
        db.query(
            Communication.resolved_channel,
            CommunicationEvent.failure_reason,
            func.count(CommunicationEvent.id),
        )
        .join(Communication, Communication.id == CommunicationEvent.communication_id)
        .join(Campaign, Campaign.id == Communication.campaign_id)
        .filter(
            Campaign.brand_id == brand_id,
            CommunicationEvent.event_type == "failed",
            CommunicationEvent.failure_reason.isnot(None),
        )
        .group_by(Communication.resolved_channel, CommunicationEvent.failure_reason)
        .all()
    )
    by_channel: dict[str, dict[str, int]] = {}
    for ch, reason, n in chan_rows:
        if not ch:
            continue
        by_channel.setdefault(ch, {})[reason or "unknown"] = n

    # Webhook integrity stats (brand-agnostic at the integrity layer — these
    # are the operator's signal, not a per-brand customer report)
    integrity = {
        "duplicates_ignored": db.query(func.count(WebhookDelivery.id))
            .filter(WebhookDelivery.status == "duplicate").scalar() or 0,
        "invalid_signatures": db.query(func.count(WebhookDelivery.id))
            .filter(WebhookDelivery.status == "invalid_signature").scalar() or 0,
        "no_communication": db.query(func.count(WebhookDelivery.id))
            .filter(WebhookDelivery.status == "no_communication").scalar() or 0,
        "processed": db.query(func.count(WebhookDelivery.id))
            .filter(WebhookDelivery.status == "processed").scalar() or 0,
    }

    return {
        "by_reason": by_reason,
        "by_channel": by_channel,
        "webhook_integrity": integrity,
    }


def ai_usage(db: Session) -> dict[str, Any]:
    """AI run summary: counts by purpose, fallback rate, avg latency."""
    rows = (
        db.query(
            AIRun.purpose,
            func.count(AIRun.id),
            func.avg(AIRun.latency_ms),
            func.sum(case((AIRun.validation_status == "ok", 1), else_=0)),
            func.sum(case((AIRun.validation_status == "retry_used", 1), else_=0)),
            func.sum(case((AIRun.validation_status == "fallback_used", 1), else_=0)),
        )
        .group_by(AIRun.purpose)
        .all()
    )

    by_purpose: list[dict[str, Any]] = []
    total_runs = 0
    total_ok = 0
    total_retry = 0
    total_fallback = 0
    for purpose, n, avg_lat, ok, retry, fb in rows:
        ok = int(ok or 0)
        retry = int(retry or 0)
        fb = int(fb or 0)
        n = int(n or 0)
        total_runs += n
        total_ok += ok
        total_retry += retry
        total_fallback += fb
        by_purpose.append({
            "purpose": purpose,
            "runs": n,
            "ok": ok,
            "retry_used": retry,
            "fallback_used": fb,
            "fallback_rate": _safe_pct(fb, n),
            "avg_latency_ms": int(avg_lat or 0),
        })

    # Provider mix
    provider_rows = (
        db.query(AIRun.provider, func.count(AIRun.id))
        .group_by(AIRun.provider)
        .all()
    )
    by_provider = [{"provider": p, "runs": n} for p, n in provider_rows]

    return {
        "total_runs": total_runs,
        "by_purpose": by_purpose,
        "by_provider": by_provider,
        "overall": {
            "ok": total_ok,
            "retry_used": total_retry,
            "fallback_used": total_fallback,
            "fallback_rate": _safe_pct(total_fallback, total_runs),
        },
    }


def revenue_timeline(db: Session, brand_id: int) -> dict[str, Any]:
    """Total revenue per campaign in launch order — small chart on the dashboard."""
    rows = (
        db.query(
            Campaign.id,
            Campaign.name,
            Campaign.launched_at,
            func.sum(_conv_value_expr()).label("rev"),
        )
        .join(Communication, Communication.campaign_id == Campaign.id)
        .join(CommunicationEvent, CommunicationEvent.communication_id == Communication.id)
        .filter(
            Campaign.brand_id == brand_id,
            CommunicationEvent.event_type == "converted",
        )
        .group_by(Campaign.id, Campaign.name, Campaign.launched_at)
        .order_by(Campaign.launched_at.asc().nullslast())
        .all()
    )
    return {
        "timeline": [
            {
                "campaign_id": cid,
                "name": name,
                "launched_at": launched.isoformat() if launched else None,
                "revenue_inr": round(float(rev or 0), 2),
            }
            for cid, name, launched, rev in rows
        ]
    }
