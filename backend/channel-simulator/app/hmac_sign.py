"""HMAC-SHA256 signing of outbound webhook payloads.

Shared with the CRM receiver via the WEBHOOK_HMAC_SECRET env var. The signature
covers the request body verbatim, so any tampering — including reordering JSON
fields — fails verification on the receiving side.
"""
from __future__ import annotations

import hashlib
import hmac


def sign(body: bytes, secret: str) -> str:
    return hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()


def verify(body: bytes, secret: str, signature: str) -> bool:
    expected = sign(body, secret)
    # Constant-time compare to avoid timing oracles.
    return hmac.compare_digest(expected, signature or "")
