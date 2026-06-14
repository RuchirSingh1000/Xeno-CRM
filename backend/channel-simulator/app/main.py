"""Channel Simulator service — separate FastAPI process on :8001.

Why a separate service:
- Mirrors how real channel providers (WhatsApp BSP, Twilio, SendGrid, etc.)
  actually behave: external boundary, async callbacks, signed payloads, retries.
- Forces the CRM to deal with async webhook ingestion correctly.
- Demonstrates the integration boundary an FDE would build at a real customer.
"""
from __future__ import annotations

import asyncio
import logging
from collections import deque
from datetime import datetime, timezone
from typing import Any

from fastapi import BackgroundTasks, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from app.config import settings
from app.simulator import (
    DEMO_TIMESCALE,
    SendRequest,
    build_event_schedule,
    close_webhook_client,
    new_provider_message_id,
    post_webhook,
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("channel-simulator")

app = FastAPI(title="Xeno Channel Simulator", version="0.2.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# In-memory dispatch log for the dashboard. Capped at 500 entries.
DISPATCH_LOG: deque[dict[str, Any]] = deque(maxlen=500)
WEBHOOK_LOG: deque[dict[str, Any]] = deque(maxlen=1000)


class SendPayload(BaseModel):
    communication_id: int
    campaign_id: int | None = None
    channel: str = Field(..., pattern="^(whatsapp|sms|email|rcs)$")
    recipient: str
    rendered_message: str
    # CRM-side caller may pre-assign the provider_message_id so its
    # Communication row is committed with the id BEFORE webhooks start arriving.
    # If absent, we mint one server-side.
    provider_message_id: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


@app.on_event("shutdown")
async def _shutdown() -> None:
    await close_webhook_client()


@app.get("/")
def root():
    return {"service": "channel-simulator", "docs": "/docs", "health": "/health"}


@app.get("/health")
def health():
    return {
        "service": "channel-simulator",
        "status": "ok",
        "env": settings.app_env,
        "crm_webhook_url": settings.crm_webhook_url,
        "demo_timescale": DEMO_TIMESCALE,
    }


@app.post("/send")
async def send(payload: SendPayload, background: BackgroundTasks) -> dict:
    """Accept a send, return a provider_message_id, schedule async events.

    Modeled after how real BSPs work: synchronous accept, async delivery
    callbacks. The CRM gets an immediate `accepted` response and then
    receives one or more webhooks as the message progresses.
    """
    pmid = payload.provider_message_id or new_provider_message_id()
    req = SendRequest(
        communication_id=payload.communication_id,
        campaign_id=payload.campaign_id,
        channel=payload.channel,
        recipient=payload.recipient,
        rendered_message=payload.rendered_message,
        provider_message_id=pmid,
        metadata=payload.metadata,
    )
    schedule = build_event_schedule(req)
    accepted_at = datetime.now(timezone.utc).isoformat()
    DISPATCH_LOG.append({
        "provider_message_id": pmid,
        "channel": payload.channel,
        "communication_id": payload.communication_id,
        "campaign_id": payload.campaign_id,
        "recipient_masked": _mask(payload.recipient),
        "scheduled_events": len(schedule),
        "accepted_at": accepted_at,
    })
    background.add_task(_run_schedule, schedule)
    return {
        "provider_message_id": pmid,
        "accepted": True,
        "accepted_at": accepted_at,
        "scheduled_events": len(schedule),
        "demo_timescale": DEMO_TIMESCALE,
    }


@app.get("/dispatch-log")
def dispatch_log(limit: int = 100) -> dict:
    items = list(DISPATCH_LOG)[-limit:]
    return {"items": items, "total": len(DISPATCH_LOG)}


@app.get("/webhook-log")
def webhook_log(limit: int = 100) -> dict:
    items = list(WEBHOOK_LOG)[-limit:]
    return {"items": items, "total": len(WEBHOOK_LOG)}


@app.post("/replay/{provider_message_id}")
async def replay(provider_message_id: str) -> dict:
    """Re-run the full event schedule for a provider_message_id.

    Used by the CRM's webhook replay UI as a way to demonstrate idempotency:
    the receiver dedups by event_id, so replay produces new events but each
    one is independently dedup'd if it was already delivered.
    """
    raise HTTPException(status_code=501, detail="Replay by message id requires CRM context; use the per-event replay button instead.")


async def _run_schedule(schedule: list[tuple[float, dict[str, Any]]]) -> None:
    """Wait the configured delay for each event, then POST it to the CRM.

    Errors are logged but don't halt subsequent events — production providers
    keep firing even when one delivery fails.
    """
    # Sort by delay so we don't drift on the event loop
    schedule.sort(key=lambda x: x[0])
    start = asyncio.get_event_loop().time()
    for delay, payload in schedule:
        target = start + delay
        sleep_for = max(0.0, target - asyncio.get_event_loop().time())
        await asyncio.sleep(sleep_for)
        result = await post_webhook(payload)
        WEBHOOK_LOG.append({
            "event_id": payload["event_id"],
            "status": payload["status"],
            "provider_message_id": payload["provider_message_id"],
            "occurred_at": payload["occurred_at"],
            "delivery_status": result.get("status"),
            "delivery_ok": result.get("ok"),
            "latency_ms": result.get("latency_ms"),
            "error": result.get("error"),
        })


def _mask(recipient: str) -> str:
    if not recipient:
        return ""
    if "@" in recipient:
        local, domain = recipient.split("@", 1)
        return f"{local[:2]}***@{domain}"
    return recipient[:3] + "***" + recipient[-2:]
