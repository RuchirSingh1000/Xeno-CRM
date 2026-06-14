"""HMAC-SHA256 helpers — same code as the simulator side, kept local so
neither service depends on the other's package layout.
"""
from __future__ import annotations

import hashlib
import hmac


def sign_payload(body: bytes, secret: str) -> str:
    return hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()


def verify_signature(body: bytes, secret: str, signature: str) -> bool:
    expected = sign_payload(body, secret)
    return hmac.compare_digest(expected, signature or "")
