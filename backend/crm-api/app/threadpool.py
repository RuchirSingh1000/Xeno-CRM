"""Increase the anyio threadpool capacity for the sync DB endpoints.

FastAPI runs sync route handlers in a threadpool. The default cap is 40, which
is too small when a campaign of 200 customers fires 200 concurrent webhooks
back to the CRM. Bumping this to 200 lets the receiver actually accept the
burst without queueing them past the simulator's 10s read timeout.

In production we'd convert the receiver to fully async with an async session;
here a larger pool + SQLite WAL is enough.
"""
from __future__ import annotations

import anyio


def configure() -> None:
    try:
        limiter = anyio.to_thread.current_default_thread_limiter()
        limiter.total_tokens = 200
    except Exception:
        # current_default_thread_limiter() is only available inside a running
        # event loop; we configure it from the startup hook instead.
        pass
