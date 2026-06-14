"""Natural language → new customers ingested directly into the CRM.

The marketer types something like:
  "Add Rohit Sharma, phone 9876543210, email rohit@example.com, from Bengaluru,
   loyalty gold. Also add Priya Mehta from Mumbai with phone 9988776655."

The model returns a structured list, each row gets normalized (phone last-10,
email lowercase), and is persisted as a canonical Customer + CustomerIdentity
(source_system="ai_direct") + Consent (sensible defaults: opted-in everywhere
unless prompt says otherwise, DND off).

This is a distinct flow from CSV ingestion — these are CRM-direct entries,
not source-system records. They get their own provenance tag so the audit
trail can show "added via AI prompt" vs "imported from POS/loyalty/etc."
"""
from __future__ import annotations

import json
import time
import uuid
from datetime import datetime, timezone
from typing import Literal, Optional

from pydantic import BaseModel, Field, ValidationError
from sqlalchemy.orm import Session

from app.ai.client import llm
from app.config import settings
from app.models import AIRun, Consent, Customer, CustomerIdentity
from app.services.normalize import normalize_email, normalize_name, normalize_phone

PROMPT_VERSION = "customer_ingester.v1"


class AIIngestedCustomer(BaseModel):
    full_name: str = Field(..., min_length=2, max_length=120)
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    phone: Optional[str] = Field(None, description="Any Indian phone format; will be normalized to last 10 digits")
    email: Optional[str] = None
    city: Optional[str] = None
    loyalty_tier: Optional[Literal["bronze", "silver", "gold", "platinum"]] = None
    consent_whatsapp: Optional[bool] = None
    consent_sms: Optional[bool] = None
    consent_email: Optional[bool] = None
    notes: Optional[str] = Field(None, max_length=300)


class AIIngestionOutput(BaseModel):
    customers: list[AIIngestedCustomer] = Field(..., min_length=1, max_length=50)
    rationale: str = Field(..., min_length=5, max_length=400)


SYSTEM_PROMPT = """You are a customer-data ingestion assistant for an Indian D2C retail CRM.

The marketer pastes free-form text describing one or more new customers. Your job:
parse it into a structured list, one row per customer.

Hard rules:
- Output STRICT JSON matching the schema. No prose, no comments.
- Indian phone numbers: extract digits only, no formatting. The CRM normalizes
  separately. If the prompt says "9876543210" or "+91-98765-43210" or
  "+91 98765 43210" — just pass the digits through; we'll normalize.
- Emails: lowercase.
- Cities (when mentioned): exact city name from the list — Bengaluru, Mumbai,
  Delhi, Pune, Hyderabad, Chennai, Kolkata, Ahmedabad, Jaipur, Indore, Chandigarh,
  Kochi, Surat, Gurugram, Noida. Omit `city` if not in the list.
- Loyalty tiers: bronze | silver | gold | platinum. Omit if not stated.
- Consent flags: leave as null (default to opted-in) unless the prompt EXPLICITLY
  says someone has opted OUT of a channel.
- Split first/last name from full_name when obvious.
- Reject names that look like placeholders ("test", "asdf", "lorem"). Skip them
  from the output rather than including them.

If the prompt is ambiguous (e.g., one phone number, no name), still produce a
best-effort row but flag it in `notes`."""


def _build_prompt(nl: str) -> str:
    schema = AIIngestionOutput.model_json_schema()
    return (
        f'Marketer input:\n"""\n{nl}\n"""\n\n'
        f"Return JSON matching this schema:\n{json.dumps(schema, indent=2)}"
    )


def _deterministic_fallback(nl: str) -> AIIngestionOutput:
    """If the LLM is unavailable, do a tiny best-effort parse so the user
    still gets something usable for a single-customer prompt."""
    import re
    name_match = re.search(r"(?:add|create)\s+([A-Z][a-z]+\s+[A-Z][a-z]+)", nl, re.IGNORECASE)
    name = name_match.group(1) if name_match else "Customer"
    phone_match = re.search(r"(\+?91[-\s]?)?(\d{10})", nl)
    phone = phone_match.group(2) if phone_match else None
    email_match = re.search(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}", nl)
    email = email_match.group(0) if email_match else None
    return AIIngestionOutput(
        customers=[
            AIIngestedCustomer(
                full_name=name,
                phone=phone,
                email=email,
            )
        ],
        rationale="LLM unavailable; parsed via fallback regex.",
    )


def parse_customers(db: Session, nl_prompt: str) -> tuple[AIRun, AIIngestionOutput]:
    """Call the LLM, validate, log to ai_runs. Returns the parsed structured list."""
    started = time.time()
    parsed: AIIngestionOutput | None = None
    raw_output = ""
    validation_status = "ok"
    error_msg: str | None = None

    provider_used = settings.llm_provider if llm.has_credentials() else "stub"
    model_used = settings.model_for(provider_used)

    try:
        result = llm.complete_json(
            system=SYSTEM_PROMPT,
            user=_build_prompt(nl_prompt),
            schema_hint=AIIngestionOutput.model_json_schema(),
        )
        if llm.last_used_provider:
            provider_used = llm.last_used_provider
            model_used = llm.last_used_model
        raw_output = json.dumps(result)
        try:
            parsed = AIIngestionOutput.model_validate(result)
        except ValidationError as ve:
            retry_user = _build_prompt(nl_prompt) + (
                f"\n\nYour previous response failed validation:\n{ve}\n"
                "Return STRICT JSON matching the schema."
            )
            result2 = llm.complete_json(
                system=SYSTEM_PROMPT,
                user=retry_user,
                schema_hint=AIIngestionOutput.model_json_schema(),
                force_provider=settings.retry_provider,
            )
            if llm.last_used_provider:
                provider_used = llm.last_used_provider
                model_used = llm.last_used_model
            raw_output = json.dumps(result2)
            try:
                parsed = AIIngestionOutput.model_validate(result2)
                validation_status = "retry_used"
            except ValidationError as ve2:
                validation_status = "fallback_used"
                error_msg = f"validation failed twice: {ve2}"
                parsed = _deterministic_fallback(nl_prompt)
    except Exception as e:
        validation_status = "fallback_used"
        error_msg = f"{type(e).__name__}: {e}"
        parsed = _deterministic_fallback(nl_prompt)

    latency_ms = int((time.time() - started) * 1000)

    run = AIRun(
        purpose="customer_ingester",
        prompt_version=PROMPT_VERSION,
        provider=provider_used,
        model=model_used,
        input_summary=nl_prompt[:300],
        raw_output=raw_output,
        parsed_output=parsed.model_dump() if parsed else None,
        validation_status=validation_status,
        error=error_msg,
        latency_ms=latency_ms,
    )
    db.add(run)
    db.commit()
    db.refresh(run)
    return run, parsed or _deterministic_fallback(nl_prompt)


def persist_customers(
    db: Session,
    brand_id: int,
    ai_customers: list[AIIngestedCustomer],
    ai_run_id: int,
) -> list[Customer]:
    """Create Customer + CustomerIdentity + Consent rows for each AI-parsed entry."""
    created: list[Customer] = []
    for entry in ai_customers:
        full_name = normalize_name(entry.full_name) or "Customer"
        first_name = entry.first_name or (full_name.split()[0] if full_name else None)
        last_name = entry.last_name or (
            " ".join(full_name.split()[1:]) if full_name and len(full_name.split()) > 1 else None
        )
        phone_norm = normalize_phone(entry.phone) if entry.phone else None
        email_norm = normalize_email(entry.email) if entry.email else None

        master_id = f"BH-AI-{uuid.uuid4().hex[:8].upper()}"
        customer = Customer(
            brand_id=brand_id,
            master_customer_id=master_id,
            first_name=first_name,
            last_name=last_name,
            full_name=full_name,
            primary_email=email_norm,
            primary_phone=phone_norm,
            city=entry.city,
            loyalty_tier=entry.loyalty_tier,
            first_seen_at=datetime.now(timezone.utc),
        )
        db.add(customer)
        db.flush()

        # Provenance: tag the source as AI-direct so the audit story is clear
        identity = CustomerIdentity(
            customer_id=customer.id,
            source_system="ai_direct",
            source_record_id=f"ai_run_{ai_run_id}_{customer.id}",
            raw_name=entry.full_name,
            raw_phone=entry.phone,
            raw_email=entry.email,
            normalized_phone=phone_norm,
            normalized_email=email_norm,
            match_confidence=1.0,
            match_reasoning=f"[ai_direct] Added via AI prompt parsing (ai_run #{ai_run_id}). {entry.notes or ''}".strip(),
        )
        db.add(identity)

        # Consent: default opted-in across channels unless prompt explicitly says no
        consent = Consent(
            customer_id=customer.id,
            whatsapp_opted_in=entry.consent_whatsapp if entry.consent_whatsapp is not None else True,
            sms_opted_in=entry.consent_sms if entry.consent_sms is not None else True,
            email_opted_in=entry.consent_email if entry.consent_email is not None else True,
            rcs_opted_in=False,
            dnd_status=False,
        )
        db.add(consent)

        created.append(customer)

    db.commit()
    return created
