"""Ingestion service: parse a source CSV into `staged_records`.

Each source type has its own column mapping. The mapping is captured on the
ImportBatch row so a downstream debugger can answer "what did we think column X meant?"
without re-deriving it from code.

This is deliberately a thin layer — it does NOT make matching decisions. It just
normalizes obvious things (phone, email, names, dates, amounts) so identity
resolution can run on clean inputs.
"""
from __future__ import annotations

import csv
import io
from datetime import datetime, timezone
from typing import Any

from sqlalchemy.orm import Session

from app.models import ImportBatch, StagedRecord
from app.services.normalize import (
    normalize_email,
    normalize_name,
    normalize_phone,
    parse_amount,
    parse_date,
)


# Per-source mapping: source_field -> canonical_field
SOURCE_MAPPINGS: dict[str, dict[str, str]] = {
    "pos": {
        "customer_mobile": "phone",
        "customer_name": "name",
        "store_id": "store_id",
        "store_visits": "store_visits",
        "last_visit_date": "last_visit_date",
        "last_bill_amount": "last_bill_amount",
        "city": "city",
    },
    "ecommerce": {
        "email": "email",
        "full_name": "name",
        "total_orders": "total_orders",
        "total_spent_inr": "lifetime_value",
        "signup_date": "signup_date",
        "city": "city",
        "accepts_marketing": "marketing_consent",
    },
    "loyalty": {
        "member_id": "member_id",
        "member_name": "name",
        "phone": "phone",
        "email_id": "email",
        "tier": "loyalty_tier",
        "points_balance": "points_balance",
        "dob": "dob",
        "joined_on": "signup_date",
    },
}


def _normalize_row(source_type: str, raw: dict[str, str]) -> dict[str, Any]:
    """Apply source mapping + value normalization to one row."""
    mapping = SOURCE_MAPPINGS[source_type]
    out: dict[str, Any] = {}
    for src, canon in mapping.items():
        val = raw.get(src)
        if canon == "phone":
            out["phone_raw"] = val
            out["phone_normalized"] = normalize_phone(val)
        elif canon == "email":
            out["email_raw"] = val
            out["email_normalized"] = normalize_email(val)
        elif canon == "name":
            out["name_raw"] = val
            out["name_normalized"] = normalize_name(val)
        elif canon in ("last_visit_date", "signup_date", "dob"):
            d = parse_date(val)
            out[canon] = d.isoformat() if d else None
        elif canon in ("last_bill_amount", "lifetime_value"):
            out[canon] = parse_amount(val)
        elif canon in ("store_visits", "total_orders", "points_balance"):
            try:
                out[canon] = int(val) if val not in (None, "") else 0
            except ValueError:
                out[canon] = 0
        else:
            out[canon] = val
    return out


def ingest_csv(
    db: Session,
    brand_id: int,
    source_type: str,
    filename: str,
    content: bytes,
) -> ImportBatch:
    """Parse CSV bytes into staged_records under a new ImportBatch.

    Idempotent at the source_record_id level: when identity resolution runs, the
    unique constraint on (source_system, source_record_id) on customer_identities
    prevents duplicates. Re-importing the same CSV is safe.
    """
    if source_type not in SOURCE_MAPPINGS:
        raise ValueError(f"unknown source_type: {source_type}")

    batch = ImportBatch(
        brand_id=brand_id,
        source_type=source_type,
        filename=filename,
        status="processing",
        mapping_json=SOURCE_MAPPINGS[source_type],
        started_at=datetime.now(timezone.utc),
    )
    db.add(batch)
    db.flush()

    text = content.decode("utf-8")
    reader = csv.DictReader(io.StringIO(text))
    n = 0
    for i, row in enumerate(reader):
        normalized = _normalize_row(source_type, row)
        db.add(StagedRecord(
            import_batch_id=batch.id,
            row_index=i,
            raw_data=row,
            normalized=normalized,
            processed=False,
        ))
        n += 1

    batch.row_count = n
    batch.status = "completed"
    batch.completed_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(batch)
    return batch
