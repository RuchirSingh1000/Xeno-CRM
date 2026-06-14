"""Message template rendering for campaign drafts.

Supports `{{variable}}` substitution with a fixed allow-list. Unknown variables
are surfaced as validation errors at draft time so the marketer can't ship a
campaign with `{{misspelled_field}}` rendered literally to a real customer.

Channel-aware length feedback:
- SMS: 160 GSM-7 chars (we approximate; concatenated SMS is 153 chars per segment).
- WhatsApp: 4096 chars hard cap; we warn at 1024 (most templates fit easily).
- Email: no inline limit, but we warn at 600 chars for "preview pane" guidance.
- RCS: 2500 chars hard cap.
"""
from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any

from app.models import Customer

VARIABLE_RE = re.compile(r"\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}")

ALLOWED_VARIABLES = {
    "first_name": "Customer first name (canonical)",
    "last_name": "Customer last name (canonical)",
    "full_name": "Customer full name (canonical)",
    "city": "City",
    "loyalty_tier": "Loyalty tier (bronze/silver/gold/platinum)",
    "total_orders": "Total order count",
    "lifetime_value": "Lifetime value in INR (no symbol)",
    "lifetime_value_inr": "Lifetime value with ₹ prefix",
    "last_order_days": "Days since last order (integer)",
    "brand_name": "Brand name (Brewhouse Co.)",
}

CHANNEL_LIMITS = {
    "sms": {"hard": 160, "soft": 140, "concatenation_size": 153},
    "whatsapp": {"hard": 4096, "soft": 1024},
    "email": {"hard": 100000, "soft": 600},
    "rcs": {"hard": 2500, "soft": 1500},
}


def extract_variables(template: str) -> list[str]:
    return list({m.group(1) for m in VARIABLE_RE.finditer(template or "")})


def validate_template(template: str) -> dict[str, Any]:
    """Return a structured report on template validity."""
    vars_used = extract_variables(template)
    unknown = sorted([v for v in vars_used if v not in ALLOWED_VARIABLES])
    return {
        "variables_used": sorted(vars_used),
        "unknown_variables": unknown,
        "valid": len(unknown) == 0 and bool(template and template.strip()),
        "char_count": len(template or ""),
    }


def build_context(customer: Customer, brand_name: str) -> dict[str, str]:
    last_days: str = "—"
    if customer.last_order_at:
        last_at = customer.last_order_at
        if last_at.tzinfo is None:
            last_at = last_at.replace(tzinfo=timezone.utc)
        last_days = str((datetime.now(timezone.utc) - last_at).days)

    ltv = int(customer.lifetime_value or 0)
    return {
        "first_name": customer.first_name or (customer.full_name or "there").split()[0],
        "last_name": customer.last_name or "",
        "full_name": customer.full_name or "Customer",
        "city": customer.city or "your city",
        "loyalty_tier": customer.loyalty_tier or "member",
        "total_orders": str(customer.total_orders),
        "lifetime_value": str(ltv),
        "lifetime_value_inr": f"₹{ltv:,}",
        "last_order_days": last_days,
        "brand_name": brand_name,
    }


def render(template: str, context: dict[str, str]) -> str:
    def sub(m: re.Match) -> str:
        key = m.group(1)
        return context.get(key, m.group(0))
    return VARIABLE_RE.sub(sub, template or "")


def length_feedback(rendered: str, channel: str) -> dict[str, Any]:
    """Channel-specific length feedback for the UI."""
    limits = CHANNEL_LIMITS.get(channel)
    if not limits:
        return {"length": len(rendered), "status": "unknown_channel"}
    n = len(rendered)
    status = "ok"
    note: str | None = None
    if n > limits["hard"]:
        status = "over_limit"
        note = f"Exceeds the {channel.upper()} hard cap of {limits['hard']} characters."
    elif n > limits["soft"]:
        status = "warning"
        if channel == "sms":
            segments = (n + limits["concatenation_size"] - 1) // limits["concatenation_size"]
            note = f"Will be sent as {segments} concatenated SMS segments."
        else:
            note = f"Exceeds the {channel.upper()} soft guidance of {limits['soft']} characters."
    return {
        "length": n,
        "limit_hard": limits["hard"],
        "limit_soft": limits["soft"],
        "status": status,
        "note": note,
    }
