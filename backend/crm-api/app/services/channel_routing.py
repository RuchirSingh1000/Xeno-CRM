"""Deterministic per-customer channel routing.

Given a customer + their consent + a channel priority list (e.g.
`[whatsapp, sms, email]`), pick the first eligible channel and return the
reason. Eligibility = consent + contactability + not-DND.

This service is the foundation Phase 5's AI campaign planner plugs into. The
LLM picks the channel *priority list*; this function does the actual customer-
by-customer routing. AI decides policy, deterministic code decides each row —
that's the production-AI pattern this whole app demonstrates.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from sqlalchemy.orm import Session

from app.models import Consent, Customer
from app.services.segment_engine import SegmentDefinition, build_query


VALID_CHANNELS = ("whatsapp", "sms", "email", "rcs")
DEFAULT_PRIORITY = ["whatsapp", "sms", "email"]


@dataclass
class RoutingDecision:
    customer_id: int
    channel: Optional[str]
    reason: str


def route_one(
    customer: Customer,
    consent: Optional[Consent],
    priority: list[str],
) -> RoutingDecision:
    """Resolve a single customer to one channel, or None with a reason."""
    if consent and consent.dnd_status:
        return RoutingDecision(customer.id, None, "dnd_suppressed")

    for ch in priority:
        if ch not in VALID_CHANNELS:
            continue
        if ch in ("whatsapp", "sms", "rcs"):
            if not customer.primary_phone:
                continue
            if not consent:
                continue
            if ch == "whatsapp" and consent.whatsapp_opted_in:
                return RoutingDecision(customer.id, "whatsapp", "opted_in_whatsapp")
            if ch == "sms" and consent.sms_opted_in:
                return RoutingDecision(customer.id, "sms", "opted_in_sms")
            if ch == "rcs" and consent.rcs_opted_in:
                return RoutingDecision(customer.id, "rcs", "opted_in_rcs")
        if ch == "email":
            if not customer.primary_email:
                continue
            if not consent:
                continue
            if consent.email_opted_in:
                return RoutingDecision(customer.id, "email", "opted_in_email")

    # Nothing matched — diagnose
    if not customer.primary_phone and not customer.primary_email:
        reason = "no_contactability"
    else:
        reason = "no_channel_consent"
    return RoutingDecision(customer.id, None, reason)


def route_segment(
    db: Session,
    brand_id: int,
    definition: SegmentDefinition,
    priority: list[str],
) -> dict:
    """Compute the routing breakdown across an entire segment.

    Returns counts per channel + per skip reason. This is what the
    Campaign draft pre-launch summary shows the marketer.
    """
    q = build_query(db, brand_id, definition)
    customers = q.all()
    if not customers:
        return {
            "total": 0,
            "by_channel": {},
            "skipped": 0,
            "skipped_reasons": {},
            "priority": priority,
        }

    customer_ids = [c.id for c in customers]
    consents = {
        c.customer_id: c
        for c in db.query(Consent).filter(Consent.customer_id.in_(customer_ids)).all()
    }

    by_channel: dict[str, int] = {}
    skipped_reasons: dict[str, int] = {}
    decisions: list[RoutingDecision] = []
    for c in customers:
        d = route_one(c, consents.get(c.id), priority)
        decisions.append(d)
        if d.channel:
            by_channel[d.channel] = by_channel.get(d.channel, 0) + 1
        else:
            skipped_reasons[d.reason] = skipped_reasons.get(d.reason, 0) + 1

    skipped = sum(skipped_reasons.values())
    return {
        "total": len(customers),
        "by_channel": by_channel,
        "skipped": skipped,
        "skipped_reasons": skipped_reasons,
        "priority": priority,
    }
