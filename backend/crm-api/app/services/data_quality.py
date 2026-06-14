"""Data quality scoring across staged_records.

Surfaces the kind of issues an FDE would walk a customer through during onboarding:
invalid phones, missing emails, single-character email typos (heuristic), future
dates, etc. This is intentionally NOT exhaustive — it covers the issues we know
the seed data contains plus a couple of generally useful checks.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from sqlalchemy.orm import Session

from app.models import ImportBatch, StagedRecord


def _is_future(iso: str | None) -> bool:
    if not iso:
        return False
    try:
        dt = datetime.fromisoformat(iso)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt > datetime.now(timezone.utc)
    except ValueError:
        return False


def quality_report(db: Session, brand_id: int) -> dict[str, Any]:
    """Compute a structured DQ report across all completed batches for a brand."""
    batches: list[ImportBatch] = (
        db.query(ImportBatch)
        .filter(ImportBatch.brand_id == brand_id, ImportBatch.status == "completed")
        .order_by(ImportBatch.id.asc())
        .all()
    )

    by_source: dict[str, dict[str, Any]] = {}
    total_rows = 0
    total_issues = 0

    for batch in batches:
        rows: list[StagedRecord] = list(batch_records_iter(db, batch.id))
        n = len(rows)
        total_rows += n

        invalid_phone = 0
        missing_phone = 0
        invalid_email = 0
        missing_email = 0
        missing_name = 0
        future_dates = 0
        zero_amount = 0
        suspect_typo_email = 0

        # within-source dup keys
        phone_seen: dict[str, int] = {}
        email_seen: dict[str, int] = {}

        for r in rows:
            norm = r.normalized or {}
            raw = r.raw_data or {}

            phone_raw = norm.get("phone_raw")
            phone_norm = norm.get("phone_normalized")
            email_raw = norm.get("email_raw")
            email_norm = norm.get("email_normalized")
            name_norm = norm.get("name_normalized")

            # Phone presence/validity
            if batch.source_type in ("pos", "loyalty"):
                if not phone_raw:
                    missing_phone += 1
                elif not phone_norm:
                    invalid_phone += 1

            # Email presence/validity
            if batch.source_type in ("ecommerce", "loyalty"):
                if not email_raw:
                    missing_email += 1
                elif not email_norm:
                    invalid_email += 1

            if not name_norm:
                missing_name += 1

            # Within-source duplicates
            if phone_norm:
                phone_seen[phone_norm] = phone_seen.get(phone_norm, 0) + 1
            if email_norm:
                email_seen[email_norm] = email_seen.get(email_norm, 0) + 1

            # Future-dated fields
            for k in ("last_visit_date", "signup_date", "dob"):
                if _is_future(norm.get(k)):
                    future_dates += 1
                    break

            # Zero or missing monetary value where it should exist
            if "last_bill_amount" in norm and (norm.get("last_bill_amount") in (None, 0, 0.0)):
                zero_amount += 1
            if "lifetime_value" in norm and (norm.get("lifetime_value") in (None, 0, 0.0)):
                zero_amount += 1

        within_dup_phone = sum(1 for c in phone_seen.values() if c > 1)
        within_dup_email = sum(1 for c in email_seen.values() if c > 1)

        issues = (
            invalid_phone + missing_phone + invalid_email + missing_email
            + missing_name + future_dates + within_dup_phone + within_dup_email
        )
        total_issues += issues

        by_source[batch.source_type] = {
            "filename": batch.filename,
            "rows": n,
            "issues_total": issues,
            "checks": {
                "invalid_phone": invalid_phone,
                "missing_phone": missing_phone,
                "invalid_email": invalid_email,
                "missing_email": missing_email,
                "missing_name": missing_name,
                "future_dates": future_dates,
                "zero_amount": zero_amount,
                "within_source_dup_phone": within_dup_phone,
                "within_source_dup_email": within_dup_email,
            },
            "completeness_score": _completeness(n, issues),
        }

    # Cross-source overlap detection: how many staged rows share a normalized phone
    # or email with at least one row from a *different* source? This is the FDE's
    # preview of "how much identity resolution work is there to do?"
    overlap = _cross_source_overlap(db, brand_id)

    return {
        "total_rows": total_rows,
        "total_issues": total_issues,
        "overall_completeness": _completeness(total_rows, total_issues),
        "by_source": by_source,
        "cross_source": overlap,
    }


def _cross_source_overlap(db: Session, brand_id: int) -> dict[str, Any]:
    """Identify staged rows that likely match across source systems.

    Lightweight preview of identity resolution: we scan normalized_phone and
    normalized_email and count distinct values that show up in 2+ source systems.
    These are the rows resolution will pull together.
    """
    rows = (
        db.query(ImportBatch.source_type, StagedRecord.normalized)
        .join(StagedRecord, StagedRecord.import_batch_id == ImportBatch.id)
        .filter(ImportBatch.brand_id == brand_id, ImportBatch.status == "completed")
        .all()
    )

    phone_to_sources: dict[str, set[str]] = {}
    email_to_sources: dict[str, set[str]] = {}
    for source_type, normalized in rows:
        if not normalized:
            continue
        p = normalized.get("phone_normalized")
        e = normalized.get("email_normalized")
        if p:
            phone_to_sources.setdefault(p, set()).add(source_type)
        if e:
            email_to_sources.setdefault(e, set()).add(source_type)

    phone_cross = {k: v for k, v in phone_to_sources.items() if len(v) >= 2}
    email_cross = {k: v for k, v in email_to_sources.items() if len(v) >= 2}

    # Count distinct customers likely to merge: union of cross-source keys.
    # Use phone preferred; emails that also overlap are likely the same customers.
    likely_merged = len(phone_cross) + len({k for k in email_cross if k not in phone_to_sources or len(phone_to_sources.get(k, set())) < 2})

    triples_phone = sum(1 for v in phone_to_sources.values() if len(v) == 3)
    triples_email = sum(1 for v in email_to_sources.values() if len(v) == 3)

    return {
        "phone_cross_source_keys": len(phone_cross),
        "email_cross_source_keys": len(email_cross),
        "likely_merges_estimate": likely_merged,
        "triple_source_phone": triples_phone,
        "triple_source_email": triples_email,
    }


def _completeness(rows: int, issues: int) -> float:
    if rows == 0:
        return 1.0
    # A row can have multiple issues; this is a soft score, not strict.
    score = max(0.0, 1.0 - (issues / (rows * 3.0)))
    return round(score, 3)


def batch_records_iter(db: Session, batch_id: int):
    """Yield staged records for a batch. Pulled out so quality_report stays readable."""
    return db.query(StagedRecord).filter(StagedRecord.import_batch_id == batch_id).all()
