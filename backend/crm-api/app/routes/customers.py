"""Customers list + detail endpoints.

The detail endpoint is intentionally rich — it returns identities, consent, an
order timeline, and category aggregates in one call. The detail page is the demo's
"this is real FDE work" moment so the API supports it in a single round-trip.
"""
from __future__ import annotations

from collections import Counter
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import case, func, or_
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.models import Consent, Customer, CustomerIdentity, Order
from app.services.ai_customer_ingester import parse_customers, persist_customers
from app.services.ai_explainer import explain_merge
from app.services.brand import get_or_create_demo_brand

router = APIRouter(prefix="/customers", tags=["customers"])


def _consent_dict(c: Optional[Consent]) -> dict:
    if not c:
        return {
            "whatsapp_opted_in": False,
            "sms_opted_in": False,
            "email_opted_in": False,
            "rcs_opted_in": False,
            "dnd_status": False,
        }
    return {
        "whatsapp_opted_in": c.whatsapp_opted_in,
        "sms_opted_in": c.sms_opted_in,
        "email_opted_in": c.email_opted_in,
        "rcs_opted_in": c.rcs_opted_in,
        "dnd_status": c.dnd_status,
    }


@router.get("/stats")
def stats(db: Session = Depends(get_db)) -> dict:
    brand = get_or_create_demo_brand(db)

    total = db.query(func.count(Customer.id)).filter(Customer.brand_id == brand.id).scalar() or 0
    cities = (
        db.query(Customer.city, func.count(Customer.id))
        .filter(Customer.brand_id == brand.id, Customer.city.isnot(None))
        .group_by(Customer.city)
        .order_by(func.count(Customer.id).desc())
        .limit(10)
        .all()
    )
    tiers = (
        db.query(Customer.loyalty_tier, func.count(Customer.id))
        .filter(Customer.brand_id == brand.id, Customer.loyalty_tier.isnot(None))
        .group_by(Customer.loyalty_tier)
        .all()
    )

    # Source coverage: how many customers have 1, 2, 3 source identities?
    coverage_rows = (
        db.query(Customer.id, func.count(CustomerIdentity.id))
        .join(CustomerIdentity, CustomerIdentity.customer_id == Customer.id)
        .filter(Customer.brand_id == brand.id)
        .group_by(Customer.id)
        .all()
    )
    coverage_hist: dict[int, int] = {}
    for _, count in coverage_rows:
        coverage_hist[count] = coverage_hist.get(count, 0) + 1

    # LTV percentiles
    ltvs = [
        v[0] for v in
        db.query(Customer.lifetime_value)
        .filter(Customer.brand_id == brand.id, Customer.lifetime_value > 0)
        .all()
    ]
    ltvs.sort()

    def pct(p: float) -> float:
        if not ltvs:
            return 0
        idx = max(0, min(len(ltvs) - 1, int(p * len(ltvs))))
        return round(ltvs[idx], 2)

    consent_counts = db.query(
        func.sum(case((Consent.whatsapp_opted_in == True, 1), else_=0)),  # noqa: E712
        func.sum(case((Consent.sms_opted_in == True, 1), else_=0)),
        func.sum(case((Consent.email_opted_in == True, 1), else_=0)),
        func.sum(case((Consent.rcs_opted_in == True, 1), else_=0)),
        func.sum(case((Consent.dnd_status == True, 1), else_=0)),
    ).join(Customer, Customer.id == Consent.customer_id).filter(Customer.brand_id == brand.id).one()

    return {
        "total_customers": total,
        "by_city_top10": [{"city": c, "count": n} for c, n in cities],
        "by_tier": [{"tier": t, "count": n} for t, n in tiers],
        "source_coverage": [
            {"sources": k, "count": v} for k, v in sorted(coverage_hist.items())
        ],
        "ltv": {
            "p50": pct(0.50),
            "p75": pct(0.75),
            "p90": pct(0.90),
            "p99": pct(0.99),
            "max": round(max(ltvs) if ltvs else 0, 2),
        },
        "consent": {
            "whatsapp": int(consent_counts[0] or 0),
            "sms": int(consent_counts[1] or 0),
            "email": int(consent_counts[2] or 0),
            "rcs": int(consent_counts[3] or 0),
            "dnd": int(consent_counts[4] or 0),
        },
    }


@router.get("")
def list_customers(
    db: Session = Depends(get_db),
    limit: int = Query(25, ge=1, le=200),
    offset: int = Query(0, ge=0),
    search: Optional[str] = None,
    city: Optional[str] = None,
    tier: Optional[str] = None,
    min_sources: Optional[int] = None,
    sources_eq: Optional[int] = None,
) -> dict:
    brand = get_or_create_demo_brand(db)
    q = db.query(Customer).filter(Customer.brand_id == brand.id)

    if search:
        s = f"%{search.lower()}%"
        q = q.filter(
            or_(
                func.lower(Customer.full_name).like(s),
                func.lower(Customer.primary_email).like(s),
                Customer.primary_phone.like(f"%{search}%"),
                Customer.master_customer_id.like(f"%{search.upper()}%"),
            )
        )
    if city:
        q = q.filter(Customer.city == city)
    if tier:
        q = q.filter(Customer.loyalty_tier == tier)

    if sources_eq is not None:
        # Exact identity-count match. 0 == customers with no CustomerIdentity rows.
        subq = (
            db.query(CustomerIdentity.customer_id, func.count(CustomerIdentity.id).label("c"))
            .group_by(CustomerIdentity.customer_id)
            .subquery()
        )
        q = q.outerjoin(subq, subq.c.customer_id == Customer.id).filter(
            func.coalesce(subq.c.c, 0) == sources_eq
        )
    elif min_sources and min_sources >= 1:
        subq = (
            db.query(CustomerIdentity.customer_id, func.count(CustomerIdentity.id).label("c"))
            .group_by(CustomerIdentity.customer_id)
            .subquery()
        )
        q = q.join(subq, subq.c.customer_id == Customer.id).filter(subq.c.c >= min_sources)

    total = q.count()

    rows = q.order_by(Customer.lifetime_value.desc().nullslast(), Customer.id.asc()).offset(offset).limit(limit).all()

    # Identity counts for the page
    ids = [r.id for r in rows]
    counts = {}
    if ids:
        for cid, c in (
            db.query(CustomerIdentity.customer_id, func.count(CustomerIdentity.id))
            .filter(CustomerIdentity.customer_id.in_(ids))
            .group_by(CustomerIdentity.customer_id)
            .all()
        ):
            counts[cid] = c

    return {
        "total": total,
        "limit": limit,
        "offset": offset,
        "customers": [
            {
                "id": c.id,
                "master_customer_id": c.master_customer_id,
                "full_name": c.full_name,
                "primary_email": c.primary_email,
                "primary_phone": c.primary_phone,
                "city": c.city,
                "loyalty_tier": c.loyalty_tier,
                "lifetime_value": c.lifetime_value,
                "total_orders": c.total_orders,
                "last_order_at": c.last_order_at.isoformat() if c.last_order_at else None,
                "identity_count": counts.get(c.id, 0),
            }
            for c in rows
        ],
    }


@router.get("/{customer_id}")
def get_customer(customer_id: int, db: Session = Depends(get_db)) -> dict:
    brand = get_or_create_demo_brand(db)
    cust = db.query(Customer).filter(Customer.id == customer_id, Customer.brand_id == brand.id).first()
    if not cust:
        raise HTTPException(status_code=404, detail="customer not found")

    identities = (
        db.query(CustomerIdentity)
        .filter(CustomerIdentity.customer_id == cust.id)
        .order_by(CustomerIdentity.match_confidence.desc(), CustomerIdentity.id.asc())
        .all()
    )

    orders = (
        db.query(Order)
        .filter(Order.customer_id == cust.id)
        .order_by(Order.order_date.desc())
        .limit(50)
        .all()
    )

    consent = db.query(Consent).filter(Consent.customer_id == cust.id).first()

    cats = Counter(o.category for o in orders if o.category)
    stores = Counter(o.store_id for o in orders if o.store_id)

    return {
        "id": cust.id,
        "master_customer_id": cust.master_customer_id,
        "full_name": cust.full_name,
        "first_name": cust.first_name,
        "last_name": cust.last_name,
        "primary_email": cust.primary_email,
        "primary_phone": cust.primary_phone,
        "city": cust.city,
        "loyalty_tier": cust.loyalty_tier,
        "lifetime_value": cust.lifetime_value,
        "total_orders": cust.total_orders,
        "last_order_at": cust.last_order_at.isoformat() if cust.last_order_at else None,
        "identities": [
            {
                "id": i.id,
                "source_system": i.source_system,
                "source_record_id": i.source_record_id,
                "raw_name": i.raw_name,
                "raw_phone": i.raw_phone,
                "raw_email": i.raw_email,
                "normalized_phone": i.normalized_phone,
                "normalized_email": i.normalized_email,
                "match_confidence": i.match_confidence,
                "match_reasoning": i.match_reasoning,
            }
            for i in identities
        ],
        "orders": [
            {
                "id": o.id,
                "source_system": o.source_system,
                "source_order_id": o.source_order_id,
                "order_date": o.order_date.isoformat() if o.order_date else None,
                "amount": o.amount,
                "items_count": o.items_count,
                "category": o.category,
                "store_id": o.store_id,
            }
            for o in orders
        ],
        "top_categories": [{"category": c, "count": n} for c, n in cats.most_common(5)],
        "top_stores": [{"store": s, "count": n} for s, n in stores.most_common(5)],
        "consent": _consent_dict(consent),
    }


class AIIngestIn(BaseModel):
    prompt: str = Field(..., min_length=3, max_length=2000)
    confirm: bool = False  # if false, just parse + preview; if true, also persist


@router.post("/ai-ingest")
def ai_ingest(payload: AIIngestIn, db: Session = Depends(get_db)) -> dict:
    """Natural-language customer ingestion.

    With `confirm=false`: AI parses the prompt, returns the structured preview.
    With `confirm=true`: also persists Customer + CustomerIdentity + Consent rows."""
    brand = get_or_create_demo_brand(db)
    run, parsed = parse_customers(db, payload.prompt)

    response: dict = {
        "ai_run_id": run.id,
        "provider": run.provider,
        "model": run.model,
        "latency_ms": run.latency_ms,
        "validation_status": run.validation_status,
        "rationale": parsed.rationale,
        "parsed_customers": [c.model_dump() for c in parsed.customers],
        "persisted": False,
    }

    if payload.confirm:
        created = persist_customers(db, brand.id, parsed.customers, run.id)
        response["persisted"] = True
        response["created"] = [
            {
                "id": c.id,
                "master_customer_id": c.master_customer_id,
                "full_name": c.full_name,
                "primary_phone": c.primary_phone,
                "primary_email": c.primary_email,
                "city": c.city,
                "loyalty_tier": c.loyalty_tier,
            }
            for c in created
        ]
    return response


@router.post("/{customer_id}/explain-merge")
def explain_customer_merge(customer_id: int, db: Session = Depends(get_db)) -> dict:
    """Use the configured LLM to write a plain-English explanation of why this
    customer's source rows were merged. Logs to `ai_runs`. Falls back to a
    deterministic explanation if the LLM call or validation fails."""
    brand = get_or_create_demo_brand(db)
    cust = db.query(Customer).filter(Customer.id == customer_id, Customer.brand_id == brand.id).first()
    if not cust:
        raise HTTPException(status_code=404, detail="customer not found")
    identities = db.query(CustomerIdentity).filter(CustomerIdentity.customer_id == cust.id).all()
    if not identities:
        raise HTTPException(status_code=400, detail="no identities to explain")

    run, parsed = explain_merge(db, cust, identities)
    return {
        "ai_run_id": run.id,
        "explanation": parsed.explanation,
        "recommendation": parsed.recommendation,
        "confidence_assessment": parsed.confidence_assessment,
        "validation_status": run.validation_status,
        "provider": run.provider,
        "model": run.model,
        "latency_ms": run.latency_ms,
    }


@router.get("/{customer_id}/related-keys")
def related_keys(customer_id: int, db: Session = Depends(get_db)) -> dict:
    """Return phone + email lookups so the UI can show 'why these merged'."""
    cust = db.get(Customer, customer_id)
    if not cust:
        raise HTTPException(status_code=404, detail="customer not found")
    identities = db.query(CustomerIdentity).filter(CustomerIdentity.customer_id == cust.id).all()
    phones = sorted({i.normalized_phone for i in identities if i.normalized_phone})
    emails = sorted({i.normalized_email for i in identities if i.normalized_email})
    return {"phones": phones, "emails": emails, "raw_names": [i.raw_name for i in identities if i.raw_name]}
