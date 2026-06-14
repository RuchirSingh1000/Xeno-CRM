"""Segment definition schema + execution engine.

Why a JSON definition instead of raw SQL or an LLM-written query:
- **Auditability.** A marketer (or compliance) can read the segment definition
  and verify what it means without parsing SQL.
- **Validation.** The Pydantic schema rejects invalid combinations at the API
  boundary; the executor compiles a known shape to SQLAlchemy. No injection
  surface, no LLM hallucination risk.
- **Re-use.** The same definition powers preview, save, campaign execution,
  and the Phase 5 AI campaign planner's structured output.

The executor is intentionally simple: filters compose with AND. OR/NOT could
be added later as a `groups: list[{op: and|or, filters: [...]}]` extension,
but we don't need them for any realistic retail-marketing segment.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field
from sqlalchemy import and_, func, or_
from sqlalchemy.orm import Query, Session

from app.models import Consent, Customer, CustomerIdentity, Order


# ---------- Schemas ----------

class AudienceCriteria(BaseModel):
    """Inclusion filters. All AND-combined."""
    last_order_days_min: Optional[int] = Field(None, ge=0, description="Only include customers whose last order is at least N days ago.")
    last_order_days_max: Optional[int] = Field(None, ge=0, description="Only include customers whose last order is at most N days ago.")
    ltv_min: Optional[float] = Field(None, ge=0)
    ltv_max: Optional[float] = Field(None, ge=0)
    total_orders_min: Optional[int] = Field(None, ge=0)
    total_orders_max: Optional[int] = Field(None, ge=0)
    cities: Optional[list[str]] = None
    loyalty_tiers: Optional[list[Literal["bronze", "silver", "gold", "platinum"]]] = None
    min_source_coverage: Optional[int] = Field(None, ge=1, le=3, description="Only customers found in N or more source systems.")


class SuppressionRules(BaseModel):
    """Exclusion filters. Layered on top of audience_criteria."""
    exclude_dnd: bool = True
    require_channel_consent: Optional[Literal["whatsapp", "sms", "email", "rcs", "any"]] = None
    recently_contacted_days: Optional[int] = Field(None, ge=0, description="Phase 5 placeholder. Not enforced yet (no campaign history).")


class SegmentDefinition(BaseModel):
    audience_criteria: AudienceCriteria = Field(default_factory=AudienceCriteria)
    suppression_rules: SuppressionRules = Field(default_factory=SuppressionRules)


# ---------- Execution ----------

def build_query(db: Session, brand_id: int, definition: SegmentDefinition) -> Query:
    """Compile a SegmentDefinition to a SQLAlchemy query over canonical customers."""
    q = db.query(Customer).filter(Customer.brand_id == brand_id)
    ac = definition.audience_criteria
    sr = definition.suppression_rules

    now = datetime.now(timezone.utc)

    if ac.last_order_days_min is not None:
        cutoff = now - timedelta(days=ac.last_order_days_min)
        q = q.filter(Customer.last_order_at < cutoff)
    if ac.last_order_days_max is not None:
        cutoff = now - timedelta(days=ac.last_order_days_max)
        q = q.filter(Customer.last_order_at >= cutoff)
    if ac.ltv_min is not None:
        q = q.filter(Customer.lifetime_value >= ac.ltv_min)
    if ac.ltv_max is not None:
        q = q.filter(Customer.lifetime_value <= ac.ltv_max)
    if ac.total_orders_min is not None:
        q = q.filter(Customer.total_orders >= ac.total_orders_min)
    if ac.total_orders_max is not None:
        q = q.filter(Customer.total_orders <= ac.total_orders_max)
    if ac.cities:
        q = q.filter(Customer.city.in_(ac.cities))
    if ac.loyalty_tiers:
        q = q.filter(Customer.loyalty_tier.in_(ac.loyalty_tiers))

    if ac.min_source_coverage is not None and ac.min_source_coverage > 1:
        subq = (
            db.query(
                CustomerIdentity.customer_id.label("customer_id"),
                func.count(CustomerIdentity.id).label("ic"),
            )
            .group_by(CustomerIdentity.customer_id)
            .subquery()
        )
        q = q.join(subq, subq.c.customer_id == Customer.id).filter(subq.c.ic >= ac.min_source_coverage)

    if sr.exclude_dnd or sr.require_channel_consent:
        q = q.outerjoin(Consent, Consent.customer_id == Customer.id)
        if sr.exclude_dnd:
            q = q.filter(or_(Consent.dnd_status == False, Consent.id.is_(None)))  # noqa: E712
        ch = sr.require_channel_consent
        if ch == "whatsapp":
            q = q.filter(Consent.whatsapp_opted_in == True)  # noqa: E712
        elif ch == "sms":
            q = q.filter(Consent.sms_opted_in == True)
        elif ch == "email":
            q = q.filter(Consent.email_opted_in == True)
        elif ch == "rcs":
            q = q.filter(Consent.rcs_opted_in == True)
        elif ch == "any":
            q = q.filter(
                or_(
                    Consent.whatsapp_opted_in == True,
                    Consent.sms_opted_in == True,
                    Consent.email_opted_in == True,
                    Consent.rcs_opted_in == True,
                )
            )

    return q.order_by(Customer.lifetime_value.desc().nullslast())


def count(db: Session, brand_id: int, definition: SegmentDefinition) -> int:
    return build_query(db, brand_id, definition).count()


def sample(db: Session, brand_id: int, definition: SegmentDefinition, limit: int = 5) -> list[Customer]:
    return build_query(db, brand_id, definition).limit(limit).all()


# ---------- "Why included" explainability ----------

def why_included(customer: Customer, consent: Consent | None, definition: SegmentDefinition) -> list[str]:
    """Return human-readable reasons this customer matched the segment.

    Deterministic, not AI. Each criterion gets a short phrase mentioning the
    customer's actual value, so a marketer can audit a single row without
    re-running the query.
    """
    reasons: list[str] = []
    ac = definition.audience_criteria
    sr = definition.suppression_rules
    now = datetime.now(timezone.utc)

    if customer.last_order_at:
        last_at = customer.last_order_at
        if last_at.tzinfo is None:
            last_at = last_at.replace(tzinfo=timezone.utc)
        days = (now - last_at).days
        if ac.last_order_days_min is not None and days >= ac.last_order_days_min:
            reasons.append(f"Last ordered {days}d ago (>={ac.last_order_days_min}d)")
        elif ac.last_order_days_max is not None and days <= ac.last_order_days_max:
            reasons.append(f"Last ordered {days}d ago (<={ac.last_order_days_max}d)")
    if ac.ltv_min is not None and customer.lifetime_value >= ac.ltv_min:
        reasons.append(f"LTV ₹{int(customer.lifetime_value)} (>=₹{int(ac.ltv_min)})")
    if ac.total_orders_min is not None and customer.total_orders >= ac.total_orders_min:
        reasons.append(f"{customer.total_orders} orders (>={ac.total_orders_min})")
    if ac.total_orders_max is not None and customer.total_orders <= ac.total_orders_max:
        reasons.append(f"{customer.total_orders} orders (<={ac.total_orders_max})")
    if ac.cities and customer.city in ac.cities:
        reasons.append(f"City: {customer.city}")
    if ac.loyalty_tiers and customer.loyalty_tier in ac.loyalty_tiers:
        reasons.append(f"Tier: {customer.loyalty_tier}")
    if sr.require_channel_consent and consent:
        ch = sr.require_channel_consent
        if ch == "whatsapp" and consent.whatsapp_opted_in:
            reasons.append("WhatsApp opted-in")
        elif ch == "sms" and consent.sms_opted_in:
            reasons.append("SMS opted-in")
        elif ch == "email" and consent.email_opted_in:
            reasons.append("Email opted-in")
        elif ch == "rcs" and consent.rcs_opted_in:
            reasons.append("RCS opted-in")
        elif ch == "any":
            reasons.append("Reachable on at least one channel")
    return reasons


def sample_with_reasons(
    db: Session, brand_id: int, definition: SegmentDefinition, limit: int = 5
) -> list[dict[str, Any]]:
    customers = sample(db, brand_id, definition, limit=limit)
    if not customers:
        return []
    consents = {c.customer_id: c for c in db.query(Consent).filter(Consent.customer_id.in_([c.id for c in customers])).all()}
    out = []
    for c in customers:
        out.append({
            "id": c.id,
            "master_customer_id": c.master_customer_id,
            "full_name": c.full_name,
            "city": c.city,
            "loyalty_tier": c.loyalty_tier,
            "lifetime_value": c.lifetime_value,
            "total_orders": c.total_orders,
            "last_order_at": c.last_order_at.isoformat() if c.last_order_at else None,
            "reasons": why_included(c, consents.get(c.id), definition),
        })
    return out


# ---------- Pre-built templates ----------

PREBUILT_TEMPLATES: list[dict[str, Any]] = [
    {
        "key": "lapsed_high_value",
        "name": "Lapsed high-value shoppers",
        "description": "LTV >= ₹5,000, no order in last 60 days. Classic win-back.",
        "definition": SegmentDefinition(
            audience_criteria=AudienceCriteria(last_order_days_min=60, ltv_min=5000),
            suppression_rules=SuppressionRules(exclude_dnd=True, require_channel_consent="any"),
        ).model_dump(),
    },
    {
        "key": "vip",
        "name": "VIP — Gold & Platinum",
        "description": "Loyalty tier gold or platinum. Frequent, high-spend customers.",
        "definition": SegmentDefinition(
            audience_criteria=AudienceCriteria(loyalty_tiers=["gold", "platinum"]),
            suppression_rules=SuppressionRules(exclude_dnd=True, require_channel_consent="any"),
        ).model_dump(),
    },
    {
        "key": "first_time_buyers",
        "name": "First-time buyers",
        "description": "Customers with exactly one order so far — nurture toward repeat.",
        "definition": SegmentDefinition(
            audience_criteria=AudienceCriteria(total_orders_min=1, total_orders_max=1),
            suppression_rules=SuppressionRules(exclude_dnd=True, require_channel_consent="any"),
        ).model_dump(),
    },
    {
        "key": "multi_source_known",
        "name": "Customers known across all 3 systems",
        "description": "Found in POS + ecommerce + loyalty. Most complete profiles.",
        "definition": SegmentDefinition(
            audience_criteria=AudienceCriteria(min_source_coverage=3),
            suppression_rules=SuppressionRules(exclude_dnd=True, require_channel_consent="any"),
        ).model_dump(),
    },
    {
        "key": "active_recent",
        "name": "Active in last 30 days",
        "description": "Recently engaged customers — good for upsell or category-cross.",
        "definition": SegmentDefinition(
            audience_criteria=AudienceCriteria(last_order_days_max=30, total_orders_min=2),
            suppression_rules=SuppressionRules(exclude_dnd=True, require_channel_consent="any"),
        ).model_dump(),
    },
    {
        "key": "whatsapp_reachable_bengaluru",
        "name": "WhatsApp-reachable Bengaluru",
        "description": "Bengaluru customers opted-in to WhatsApp. India-specific channel pilot.",
        "definition": SegmentDefinition(
            audience_criteria=AudienceCriteria(cities=["Bengaluru"]),
            suppression_rules=SuppressionRules(exclude_dnd=True, require_channel_consent="whatsapp"),
        ).model_dump(),
    },
]
