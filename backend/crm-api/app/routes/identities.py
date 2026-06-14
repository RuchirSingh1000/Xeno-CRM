"""Identity resolution dashboard endpoints.

Returns aggregate stats about the resolution: how many staged rows collapsed into
how many canonical customers, the rule-mix that drove the merges, and a list of
flagged components that used lower-confidence rules.
"""
from __future__ import annotations

from collections import Counter, defaultdict

from fastapi import APIRouter, Depends
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.models import (
    Customer,
    CustomerIdentity,
    ImportBatch,
    StagedRecord,
)
from app.services.brand import get_or_create_demo_brand

router = APIRouter(prefix="/identities", tags=["identities"])


@router.get("/dashboard")
def dashboard(db: Session = Depends(get_db)) -> dict:
    brand = get_or_create_demo_brand(db)

    staged_total = (
        db.query(func.count(StagedRecord.id))
        .join(ImportBatch, ImportBatch.id == StagedRecord.import_batch_id)
        .filter(ImportBatch.brand_id == brand.id)
        .scalar() or 0
    )
    staged_by_source = dict(
        db.query(ImportBatch.source_type, func.count(StagedRecord.id))
        .join(StagedRecord, StagedRecord.import_batch_id == ImportBatch.id)
        .filter(ImportBatch.brand_id == brand.id)
        .group_by(ImportBatch.source_type)
        .all()
    )

    canonical_total = (
        db.query(func.count(Customer.id))
        .filter(Customer.brand_id == brand.id)
        .scalar() or 0
    )

    # Rule mix: parse the match_reasoning prefix "[rule_name] ..."
    identities = db.query(CustomerIdentity.match_reasoning).all()
    rule_counter: Counter = Counter()
    for (r,) in identities:
        if not r:
            continue
        if r.startswith("["):
            end = r.find("]")
            if end > 0:
                rule_counter[r[1:end]] += 1

    # Source coverage hist: 1 / 2 / 3 sources per customer
    coverage_rows = (
        db.query(CustomerIdentity.customer_id, func.count(CustomerIdentity.id))
        .group_by(CustomerIdentity.customer_id)
        .all()
    )
    coverage_hist: dict[int, int] = defaultdict(int)
    for _, c in coverage_rows:
        coverage_hist[c] += 1

    # Flagged components: at least one identity matched via name_city_only
    flagged_customer_ids = set(
        r[0] for r in
        db.query(CustomerIdentity.customer_id)
        .filter(CustomerIdentity.match_reasoning.like("[name_city_only]%"))
        .all()
    )
    flagged_count = len(flagged_customer_ids)

    dedup_rate = round(1 - canonical_total / max(1, staged_total), 3)

    return {
        "staged_total": staged_total,
        "staged_by_source": staged_by_source,
        "canonical_total": canonical_total,
        "deduplication_rate": dedup_rate,
        "rule_mix": dict(rule_counter),
        "source_coverage": [
            {"sources": k, "count": v} for k, v in sorted(coverage_hist.items())
        ],
        "flagged_count": flagged_count,
    }


@router.get("/flagged")
def flagged(db: Session = Depends(get_db), limit: int = 25) -> dict:
    """Customers where resolution used a flagged (low-confidence) rule."""
    customer_ids = [
        r[0] for r in
        db.query(CustomerIdentity.customer_id)
        .filter(CustomerIdentity.match_reasoning.like("[name_city_only]%"))
        .group_by(CustomerIdentity.customer_id)
        .limit(limit)
        .all()
    ]
    if not customer_ids:
        return {"customers": []}
    customers = db.query(Customer).filter(Customer.id.in_(customer_ids)).all()
    return {
        "customers": [
            {
                "id": c.id,
                "master_customer_id": c.master_customer_id,
                "full_name": c.full_name,
                "city": c.city,
                "primary_phone": c.primary_phone,
                "primary_email": c.primary_email,
            }
            for c in customers
        ]
    }


@router.post("/flagged/{customer_id}/confirm")
def confirm_flagged(customer_id: int, db: Session = Depends(get_db)) -> dict:
    """Operator confirms a flagged merge is correct. Lifts the merge confidence
    on its weak identities to 1.0 and rewrites the reasoning so it no longer
    matches the flagged filter."""
    weak = (
        db.query(CustomerIdentity)
        .filter(
            CustomerIdentity.customer_id == customer_id,
            CustomerIdentity.match_reasoning.like("[name_city_only]%"),
        )
        .all()
    )
    if not weak:
        return {"updated": 0, "note": "no flagged identities found for this customer"}
    for ident in weak:
        ident.match_confidence = 1.0
        ident.match_reasoning = "[operator_confirmed] " + (ident.match_reasoning or "")
    db.commit()
    return {"updated": len(weak), "customer_id": customer_id, "action": "confirmed"}


@router.post("/flagged/{customer_id}/reject")
def reject_flagged(customer_id: int, db: Session = Depends(get_db)) -> dict:
    """Operator rejects the flagged merge. Detaches the weak identities from
    the canonical customer. If the customer is left with no identities, the
    customer row is deleted too (it was held together only by the weak rule)."""
    customer = db.get(Customer, customer_id)
    if not customer:
        return {"deleted": 0, "note": "customer not found"}
    weak_ids = (
        db.query(CustomerIdentity)
        .filter(
            CustomerIdentity.customer_id == customer_id,
            CustomerIdentity.match_reasoning.like("[name_city_only]%"),
        )
        .all()
    )
    deleted = len(weak_ids)
    for ident in weak_ids:
        db.delete(ident)
    db.flush()
    remaining = (
        db.query(CustomerIdentity)
        .filter(CustomerIdentity.customer_id == customer_id)
        .count()
    )
    customer_removed = False
    if remaining == 0:
        db.delete(customer)
        customer_removed = True
    db.commit()
    return {
        "deleted_identities": deleted,
        "customer_removed": customer_removed,
        "customer_id": customer_id,
        "action": "rejected",
    }
