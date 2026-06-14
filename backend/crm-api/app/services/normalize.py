"""Normalization helpers for messy customer data.

These are deterministic and rules-based. They sit *before* identity resolution and
make matching tractable. They are also the source of truth for "what does a 'valid'
phone or email mean in this app" — keeping that decision in one place avoids drift.
"""
from __future__ import annotations

import re
from datetime import datetime
from typing import Optional


PHONE_DIGITS = re.compile(r"\D+")
EMAIL_RE = re.compile(r"^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$")


def normalize_phone(raw: Optional[str]) -> Optional[str]:
    """Return last 10 digits if a valid Indian mobile, else None.

    Accepts any of: "+91-98765-43210", "+91 98765 43210", "+919876543210",
    "9876543210", "919876543210". Indian mobiles must start with 6/7/8/9.
    """
    if not raw:
        return None
    digits = PHONE_DIGITS.sub("", str(raw))
    if not digits:
        return None
    # Drop country code variants
    if len(digits) == 12 and digits.startswith("91"):
        digits = digits[2:]
    elif len(digits) == 11 and digits.startswith("0"):
        digits = digits[1:]
    if len(digits) != 10:
        return None
    if digits[0] not in "6789":
        return None
    return digits


def normalize_email(raw: Optional[str]) -> Optional[str]:
    """Lowercase + strip. Returns None if obviously invalid."""
    if not raw:
        return None
    s = str(raw).strip().lower()
    if not EMAIL_RE.match(s):
        return None
    return s


def normalize_name(raw: Optional[str]) -> Optional[str]:
    """Strip + collapse whitespace. Preserve original casing for display."""
    if not raw:
        return None
    s = " ".join(str(raw).strip().split())
    return s or None


def name_tokens(name: Optional[str]) -> list[str]:
    """Lowercase tokens, stripping single-char tokens (e.g., "Rohit S." -> ["rohit", "s"])."""
    if not name:
        return []
    return [t.strip(".").lower() for t in name.split() if t.strip(".")]


def parse_date(raw: Optional[str]) -> Optional[datetime]:
    """Best-effort date parsing for the seed formats we know we generated:
    "%d-%m-%Y", "%Y-%m-%d", "%d/%m/%Y", "%Y-%m-%d %H:%M:%S"."""
    if not raw:
        return None
    s = str(raw).strip()
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d", "%d-%m-%Y", "%d/%m/%Y"):
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    return None


def parse_amount(raw: Optional[str]) -> Optional[float]:
    if raw is None or raw == "":
        return None
    try:
        v = float(str(raw).replace(",", ""))
        return v if v >= 0 else None
    except ValueError:
        return None
