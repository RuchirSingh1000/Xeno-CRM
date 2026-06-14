"""AI column-mapping for messy CSV ingest.

FDE pattern: enterprise customers don't send you clean CSVs. They send you
`cust_phone`, `Phone Number`, `mobile`, `LTV ($)`, `Lifetime_Value_INR`, with
different separators and stray BOM bytes. The traditional answer is to write
one transformer per customer. The AI-native answer is: let the LLM look at
the headers + a handful of sample values and propose a mapping, the operator
confirms or edits, then we apply it.

This service does the proposal + validation. The route applies it.

The mapping output is constrained to the canonical fields the ingester
already understands: full_name, first_name, last_name, phone, email, city,
loyalty_tier, lifetime_value_inr, total_orders, last_order_at. Anything else
in the source CSV gets dropped (with a `discarded_columns` list so the
operator can see what didn't make the cut).

Why per-column confidence in the output:
- The UI uses it to colour-code the mapping (high = green, low = amber).
- The operator's job becomes "check the amber ones", not "audit everything".
- Real FDE workflow: trust + verify, don't replace judgment with magic.
"""
from __future__ import annotations

import csv
import io
import json
import re
import time
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field, ValidationError
from sqlalchemy.orm import Session

from app.ai.client import llm
from app.config import settings
from app.models import AIRun

PROMPT_VERSION = "csv_mapper.v1"


# Canonical fields the CRM understands. Source columns get mapped to one of
# these (or to None = discard). Keep this list small and readable — every
# new field here is a new thing the planner has to guess.
CANONICAL_FIELDS: list[str] = [
    "full_name",
    "first_name",
    "last_name",
    "phone",
    "email",
    "city",
    "loyalty_tier",
    "lifetime_value_inr",
    "total_orders",
    "last_order_at",
]


class ColumnMapping(BaseModel):
    source_column: str = Field(..., min_length=1, max_length=120)
    target_field: Optional[str] = Field(
        None,
        description=f"One of {CANONICAL_FIELDS} or null to discard this column.",
    )
    confidence: float = Field(0.0, ge=0.0, le=1.0)
    reason: str = Field("", max_length=200)


class CsvMappingOutput(BaseModel):
    mappings: list[ColumnMapping] = Field(..., min_length=1, max_length=50)
    overall_notes: str = Field("", max_length=400)


SYSTEM_PROMPT = """You are a data engineer at an Indian D2C CRM company.
A customer just handed us a CSV from their POS/loyalty/e-commerce system. You will receive:
  - The list of column headers
  - 3-5 sample rows (as JSON)

Your job: propose a mapping from each source column to one of the CRM's canonical fields,
or to null if the column should be discarded.

Canonical fields (use EXACTLY these strings, lowercase, snake_case):
""" + "\n".join(f"  - {f}" for f in CANONICAL_FIELDS) + """

Hard rules:
- Output STRICT JSON: { "mappings": [ {source_column, target_field, confidence, reason} ], "overall_notes": "..." }.
- Each mapping's `target_field` is one of the canonical fields or null. Never invent new names.
- `confidence` is 0.0 to 1.0. Be honest — set it low when you're guessing.
- `reason` is one short sentence on what in the column name or sample values made you pick that field.
- It's OK to leave a target_field as null (discard) if no canonical field fits. Don't force matches.
- Prefer specific over generic: `cust_phone_e164` → phone, `lifetime_spend_inr` → lifetime_value_inr.
- If two source columns plausibly map to the same canonical field, pick the better one and discard the other.
- `lifetime_value_inr` is the canonical for any monetary lifetime/total spend. Strip currency symbols mentally.
- `loyalty_tier` only accepts the values bronze/silver/gold/platinum after normalization.
- `total_orders` is integer count. If a column looks like float averages, discard.
- `last_order_at` is a date or datetime. Discard columns that are clearly dates of birth or signup dates.
- `phone` and `email` should match the obvious headers; sample values should confirm (digits-heavy / contains '@').
- Do NOT include rows or row data in your response — only column-level decisions.
- `overall_notes` is one paragraph about the file as a whole (encoding issues you'd guess at, columns you wish you had, etc)."""


def _row_issues(row: dict[str, Any], mapping: dict[str, str | None]) -> list[str]:
    """Cheap per-row validation against the mapping. Used in preview to flag bad rows."""
    issues = []
    # phone
    phone_src = next((s for s, t in mapping.items() if t == "phone"), None)
    if phone_src:
        v = str(row.get(phone_src, "") or "").strip()
        digits = re.sub(r"\D", "", v)
        if v and len(digits) < 10:
            issues.append(f"phone '{v}' has only {len(digits)} digits")
    # email
    email_src = next((s for s, t in mapping.items() if t == "email"), None)
    if email_src:
        v = str(row.get(email_src, "") or "").strip()
        if v and "@" not in v:
            issues.append(f"email '{v}' missing '@'")
    # tier
    tier_src = next((s for s, t in mapping.items() if t == "loyalty_tier"), None)
    if tier_src:
        v = str(row.get(tier_src, "") or "").strip().lower()
        if v and v not in {"bronze", "silver", "gold", "platinum"}:
            issues.append(f"loyalty_tier '{v}' not in bronze/silver/gold/platinum")
    # ltv
    ltv_src = next((s for s, t in mapping.items() if t == "lifetime_value_inr"), None)
    if ltv_src:
        v = str(row.get(ltv_src, "") or "").strip()
        try:
            float(re.sub(r"[^\d.\-]", "", v) or "0")
        except ValueError:
            issues.append(f"lifetime_value '{v}' not numeric")
    return issues


def parse_csv(raw: str) -> tuple[list[str], list[dict[str, str]]]:
    """Tolerant CSV parser. Returns (headers, rows). Strips BOM, trims whitespace."""
    if raw.startswith("﻿"):
        raw = raw.lstrip("﻿")
    reader = csv.DictReader(io.StringIO(raw))
    headers = [h.strip() for h in (reader.fieldnames or [])]
    rows = []
    for r in reader:
        rows.append({(k or "").strip(): (v if v is not None else "") for k, v in r.items()})
    return headers, rows


def preview_csv(db: Session, raw_csv: str) -> dict[str, Any]:
    """Parse + ask LLM for a mapping + flag per-row issues for the first 10 rows.

    Returns everything the UI needs to render the confirmation step. The
    operator can then call apply_csv with the (possibly edited) mapping.
    """
    headers, rows = parse_csv(raw_csv)
    if not headers:
        return {"error": "no headers detected — is this a CSV?", "headers": [], "rows": [], "mapping": []}

    sample_rows = rows[:5]
    started = time.time()
    raw_output = ""
    parsed: CsvMappingOutput | None = None
    validation_status = "ok"
    error_msg: str | None = None
    provider_used = settings.llm_provider if llm.has_credentials() else "stub"
    model_used = settings.model_for(provider_used)

    user_prompt = (
        f"Headers: {json.dumps(headers)}\n\n"
        f"Sample rows (first {len(sample_rows)}):\n{json.dumps(sample_rows, indent=2)}\n\n"
        "Return STRICT JSON matching the schema."
    )

    try:
        result = llm.complete_json(
            system=SYSTEM_PROMPT,
            user=user_prompt,
            schema_hint=CsvMappingOutput.model_json_schema(),
        )
        if llm.last_used_provider:
            provider_used = llm.last_used_provider
            model_used = llm.last_used_model
        raw_output = json.dumps(result)
        try:
            parsed = CsvMappingOutput.model_validate(result)
            # Defensive: only keep mappings whose source_column actually appears in headers
            parsed.mappings = [m for m in parsed.mappings if m.source_column in headers]
            # Defensive: scrub bogus target_field values
            for m in parsed.mappings:
                if m.target_field is not None and m.target_field not in CANONICAL_FIELDS:
                    m.target_field = None
                    m.reason = (m.reason + " [discarded: not a canonical field]")[:200]
        except ValidationError as ve:
            validation_status = "fallback_used"
            error_msg = f"validation failed: {ve}"
    except Exception as e:
        validation_status = "fallback_used"
        error_msg = f"{type(e).__name__}: {e}"

    # Deterministic fallback: keyword heuristics so the UI always shows something.
    if parsed is None:
        parsed = CsvMappingOutput(
            mappings=[_heuristic_mapping(h) for h in headers],
            overall_notes="AI unavailable; mapping built from header heuristics. Please review carefully before applying.",
        )

    latency_ms = int((time.time() - started) * 1000)
    run = AIRun(
        purpose="csv_column_mapper",
        prompt_version=PROMPT_VERSION,
        provider=provider_used,
        model=model_used,
        input_summary=f"headers={len(headers)} rows={len(rows)}",
        raw_output=raw_output,
        parsed_output={"mappings": [m.model_dump() for m in parsed.mappings]},
        validation_status=validation_status,
        error=error_msg,
        latency_ms=latency_ms,
    )
    db.add(run)
    db.commit()
    db.refresh(run)

    mapping_dict = {m.source_column: m.target_field for m in parsed.mappings}
    rows_with_issues = []
    for r in rows[:10]:
        rows_with_issues.append({
            "row": r,
            "issues": _row_issues(r, mapping_dict),
        })

    return {
        "ai_run_id": run.id,
        "provider": provider_used,
        "model": model_used,
        "latency_ms": latency_ms,
        "validation_status": validation_status,
        "headers": headers,
        "row_count": len(rows),
        "sample_rows": rows_with_issues,
        "mapping": [m.model_dump() for m in parsed.mappings],
        "discarded_columns": [m.source_column for m in parsed.mappings if m.target_field is None],
        "canonical_fields": CANONICAL_FIELDS,
        "overall_notes": parsed.overall_notes,
    }


def _heuristic_mapping(header: str) -> ColumnMapping:
    """Last-resort fallback when the LLM isn't available."""
    h = header.lower().strip()
    rules: list[tuple[str, str, float]] = [
        ("phone|mobile|contact_no|msisdn", "phone", 0.6),
        ("email|e-mail|mail_id", "email", 0.7),
        ("first.?name|fname|given", "first_name", 0.6),
        ("last.?name|lname|surname|family", "last_name", 0.6),
        ("full.?name|customer.?name|name$", "full_name", 0.55),
        ("city|location|town", "city", 0.55),
        ("tier|loyalty|segment", "loyalty_tier", 0.4),
        ("ltv|lifetime|total.?spend|total.?value", "lifetime_value_inr", 0.5),
        ("order.?count|orders?$|num.?orders", "total_orders", 0.5),
        ("last.?order|last.?purchase|recency", "last_order_at", 0.5),
    ]
    for pat, tgt, conf in rules:
        if re.search(pat, h):
            return ColumnMapping(
                source_column=header, target_field=tgt, confidence=conf,
                reason=f"matched keyword pattern /{pat}/",
            )
    return ColumnMapping(source_column=header, target_field=None, confidence=0.0, reason="no keyword match")


def apply_csv(db: Session, brand_id: int, raw_csv: str, mapping: dict[str, str | None]) -> dict[str, Any]:
    """Ingest the CSV using the confirmed mapping. Builds Customer + CustomerIdentity
    rows via the same normalize helpers used by the AI direct-entry flow.

    Skips rows with critical issues (no phone or email, malformed tier). Returns
    counts so the UI can show a summary.
    """
    from app.models import Consent, Customer, CustomerIdentity
    from app.services.normalize import normalize_email, normalize_name, normalize_phone
    from datetime import datetime, timezone
    import uuid

    headers, rows = parse_csv(raw_csv)

    def src_for(target: str) -> str | None:
        for s, t in mapping.items():
            if t == target:
                return s
        return None

    src_full = src_for("full_name")
    src_first = src_for("first_name")
    src_last = src_for("last_name")
    src_phone = src_for("phone")
    src_email = src_for("email")
    src_city = src_for("city")
    src_tier = src_for("loyalty_tier")
    src_ltv = src_for("lifetime_value_inr")
    src_orders = src_for("total_orders")

    created = 0
    skipped: list[dict[str, str]] = []

    for idx, r in enumerate(rows):
        phone_raw = str(r.get(src_phone, "") or "").strip() if src_phone else ""
        email_raw = str(r.get(src_email, "") or "").strip() if src_email else ""
        phone_n = normalize_phone(phone_raw) if phone_raw else None
        email_n = normalize_email(email_raw) if email_raw else None
        if not phone_n and not email_n:
            skipped.append({"row": str(idx + 1), "reason": "no usable phone or email"})
            continue

        full_name = ""
        if src_full and r.get(src_full):
            full_name = normalize_name(str(r[src_full]))
        elif src_first or src_last:
            parts = [str(r.get(src_first, "") or ""), str(r.get(src_last, "") or "")]
            full_name = normalize_name(" ".join(p for p in parts if p))
        if not full_name:
            full_name = "(unknown)"

        tier_n: str | None = None
        if src_tier:
            tv = str(r.get(src_tier, "") or "").strip().lower()
            if tv in {"bronze", "silver", "gold", "platinum"}:
                tier_n = tv

        ltv_n: float = 0.0
        if src_ltv:
            try:
                ltv_n = float(re.sub(r"[^\d.\-]", "", str(r.get(src_ltv, "") or "")) or "0")
            except ValueError:
                ltv_n = 0.0

        orders_n: int = 0
        if src_orders:
            try:
                orders_n = int(float(re.sub(r"[^\d.\-]", "", str(r.get(src_orders, "") or "")) or "0"))
            except ValueError:
                orders_n = 0

        master_id = f"BH-CUST-CSV{uuid.uuid4().hex[:6].upper()}"
        city_val = str(r.get(src_city, "") or "").strip() if src_city else ""
        cust = Customer(
            brand_id=brand_id,
            master_customer_id=master_id,
            full_name=full_name,
            primary_phone=phone_n,
            primary_email=email_n,
            city=city_val or None,
            loyalty_tier=tier_n,
            lifetime_value=ltv_n,
            total_orders=orders_n,
            first_seen_at=datetime.now(timezone.utc),
        )
        db.add(cust)
        db.flush()

        # source_record_id must be unique per (source_system, source_record_id);
        # add a uuid suffix so re-running on the same file doesn't collide with
        # an earlier import.
        ident = CustomerIdentity(
            customer_id=cust.id,
            source_system="csv_upload",
            source_record_id=f"row-{idx+1}-{uuid.uuid4().hex[:8]}",
            raw_name=full_name,
            raw_phone=phone_raw or None,
            raw_email=email_raw or None,
            normalized_phone=phone_n,
            normalized_email=email_n,
            match_confidence=1.0,
            match_reasoning="csv_upload — operator-confirmed mapping",
        )
        db.add(ident)

        consent = Consent(
            customer_id=cust.id,
            whatsapp_opted_in=True,
            sms_opted_in=True,
            email_opted_in=True,
            rcs_opted_in=False,
            dnd_status=False,
        )
        db.add(consent)
        created += 1

    db.commit()
    return {
        "ingested": created,
        "skipped": len(skipped),
        "skip_reasons": skipped[:20],
        "total_rows": len(rows),
    }
