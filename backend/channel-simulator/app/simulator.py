"""Per-channel event generator + HMAC-signed webhook callbacks.

Each accepted /send produces a deterministic-but-staggered sequence of webhook
events back to the CRM. Distributions roughly mirror real provider behaviour
for an Indian D2C audience:

  WhatsApp  delivered 92% (1-5s) → read 60% of delivered (30s-5min) → clicked 25% of read (1-10min) → converted 8% of clicked (5-60min)
  SMS       delivered 95% (1-3s) → clicked 12% (5-30min) → converted 5%
  Email     delivered 88% (5-30s) → opened 40% (1min-2hr) → clicked 15% → converted 4%
  RCS       delivered 90% (1-5s) → read 55% → clicked 20% → converted 6%

  ~5% bounce with realistic reasons: invalid_number, provider_timeout,
  rate_limited, recipient_unsubscribed.

We deliberately add a small jitter (~150ms) between scheduled events so two
events for the same communication can arrive out-of-order — this stresses the
CRM receiver's sequence-based state derivation and demonstrates the
out-of-order-safe design in the demo.
"""
from __future__ import annotations

import json
import logging
import random
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx

from app.config import settings
from app.hmac_sign import sign

logger = logging.getLogger("simulator")
logger.setLevel(logging.INFO)


# Channel-specific event distributions
PROFILES: dict[str, dict[str, Any]] = {
    "whatsapp": {
        "delivered_p": 0.92,
        "delivered_delay": (1, 5),
        "read_p": 0.60,
        "read_delay": (30, 300),
        "clicked_p": 0.25,
        "clicked_delay": (60, 600),
        "converted_p": 0.08,
        "converted_delay": (300, 3600),
        "supports_read": True,
    },
    "sms": {
        "delivered_p": 0.95,
        "delivered_delay": (1, 3),
        "read_p": 0,
        "clicked_p": 0.12,
        "clicked_delay": (300, 1800),
        "converted_p": 0.05,
        "converted_delay": (300, 3600),
        "supports_read": False,
    },
    "email": {
        "delivered_p": 0.88,
        "delivered_delay": (5, 30),
        "read_p": 0.40,
        "read_delay": (60, 7200),
        "clicked_p": 0.15,
        "clicked_delay": (300, 1800),
        "converted_p": 0.04,
        "converted_delay": (300, 3600),
        "supports_read": True,
    },
    "rcs": {
        "delivered_p": 0.90,
        "delivered_delay": (1, 5),
        "read_p": 0.55,
        "read_delay": (60, 600),
        "clicked_p": 0.20,
        "clicked_delay": (60, 900),
        "converted_p": 0.06,
        "converted_delay": (300, 3600),
        "supports_read": True,
    },
}

FAILURE_REASONS = ["invalid_number", "provider_timeout", "rate_limited", "recipient_unsubscribed"]

# Speed knob for demos. 1.0 = realistic delays; 0.05 = events arrive ~20x faster
# so you don't wait 5 minutes in a recording.
DEMO_TIMESCALE = 0.02


@dataclass
class SendRequest:
    communication_id: int
    campaign_id: int | None
    channel: str
    recipient: str
    rendered_message: str
    provider_message_id: str
    metadata: dict[str, Any]


def new_provider_message_id() -> str:
    return f"msg_{uuid.uuid4().hex[:16]}"


def new_event_id() -> str:
    return f"evt_{uuid.uuid4().hex[:24]}"


def build_event_schedule(req: SendRequest) -> list[tuple[float, dict[str, Any]]]:
    """Return a list of (delay_seconds, payload_dict) tuples for this send.

    The simulator scheduler treats `delay` as a relative offset from now.
    All payloads share the same provider_message_id so the CRM can join them
    to the communication.
    """
    rng = random.Random(req.provider_message_id)  # deterministic per send
    profile = PROFILES.get(req.channel, PROFILES["sms"])
    schedule: list[tuple[float, dict[str, Any]]] = []
    seq = 0

    def emit(event_type: str, delay: float, extra: dict[str, Any] | None = None) -> None:
        nonlocal seq
        seq += 1
        payload = {
            "event_id": new_event_id(),
            "provider_message_id": req.provider_message_id,
            "channel": req.channel,
            "status": event_type,
            "sequence": seq,
            "occurred_at": (datetime.now(timezone.utc) + timedelta(seconds=delay)).isoformat(),
            "recipient": req.recipient,
            "metadata": {
                "communication_id": req.communication_id,
                "campaign_id": req.campaign_id,
                **(extra or {}),
            },
        }
        schedule.append((delay * DEMO_TIMESCALE, payload))

    # Always emit a "sent" event almost immediately (provider accepted upstream)
    emit("sent", rng.uniform(0.5, 1.5))

    # Failure path
    if rng.random() > profile["delivered_p"]:
        reason = rng.choice(FAILURE_REASONS)
        dlo, dhi = profile["delivered_delay"]
        emit("failed", rng.uniform(dlo, dhi), {"failure_reason": reason})
        return schedule

    # Delivered
    dlo, dhi = profile["delivered_delay"]
    delivered_at = rng.uniform(dlo, dhi)
    emit("delivered", delivered_at)

    # Read / opened
    if profile["supports_read"] and rng.random() < profile["read_p"]:
        rlo, rhi = profile["read_delay"]
        read_at = delivered_at + rng.uniform(rlo, rhi)
        emit("opened" if req.channel == "email" else "read", read_at)
    else:
        read_at = None

    # Clicked (depends on having been "read", roughly)
    if rng.random() < profile["clicked_p"]:
        clo, chi = profile["clicked_delay"]
        base = read_at or delivered_at
        clicked_at = base + rng.uniform(clo, chi)
        emit("clicked", clicked_at, {"click_url": f"https://brewhouse.example/offer?cid={req.campaign_id}"})

        # Converted only if clicked
        if rng.random() < profile["converted_p"]:
            vlo, vhi = profile["converted_delay"]
            converted_at = clicked_at + rng.uniform(vlo, vhi)
            emit("converted", converted_at, {"conversion_value_inr": round(rng.uniform(180, 1800), 2)})

    # Add small jitter so adjacent events can swap arrival order
    schedule = [(max(0.0, d + rng.uniform(-0.15, 0.15)), p) for d, p in schedule]
    return schedule


# Module-level shared client. Reuses TCP connections across all callback POSTs
# so a 150-comm campaign launch doesn't exhaust Windows ephemeral ports by
# opening a fresh connection per webhook.
_LIMITS = httpx.Limits(max_connections=32, max_keepalive_connections=16)
_webhook_client: httpx.AsyncClient | None = None


def get_webhook_client() -> httpx.AsyncClient:
    global _webhook_client
    if _webhook_client is None:
        _webhook_client = httpx.AsyncClient(timeout=30.0, limits=_LIMITS)
    return _webhook_client


async def close_webhook_client() -> None:
    global _webhook_client
    if _webhook_client is not None:
        await _webhook_client.aclose()
        _webhook_client = None


async def post_webhook(payload: dict[str, Any]) -> dict[str, Any]:
    """POST one event to the CRM webhook URL with an HMAC signature."""
    body = json.dumps(payload, separators=(",", ":"), sort_keys=False).encode("utf-8")
    signature = sign(body, settings.webhook_hmac_secret)
    headers = {
        "Content-Type": "application/json",
        "X-Xeno-Signature": signature,
        "X-Xeno-Event-Id": payload["event_id"],
        "X-Xeno-Channel": payload.get("channel", ""),
    }
    started = time.time()
    client = get_webhook_client()
    # Bounded retry: under heavy load a single ConnectError can drop an event.
    # Two short retries with jitter close the gap without being a thundering herd.
    import asyncio as _asyncio
    import random as _r
    last_err: Exception | None = None
    for attempt in range(3):
        try:
            r = await client.post(settings.crm_webhook_url, content=body, headers=headers)
            return {
                "ok": 200 <= r.status_code < 300,
                "status": r.status_code,
                "latency_ms": int((time.time() - started) * 1000),
                "event_id": payload["event_id"],
                "attempts": attempt + 1,
            }
        except Exception as e:
            last_err = e
            if attempt < 2:
                await _asyncio.sleep(0.1 + _r.random() * 0.2)
    return {
        "ok": False,
        "status": 0,
        "latency_ms": int((time.time() - started) * 1000),
        "event_id": payload["event_id"],
        "error": f"{type(last_err).__name__ if last_err else 'Unknown'}: {last_err}",
        "attempts": 3,
    }
