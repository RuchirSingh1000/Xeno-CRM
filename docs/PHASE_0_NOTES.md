# Phase 0 — Foundation

**Goal:** prove the three-service architecture works end-to-end locally before building any feature.

## What exists now

- `backend/crm-api/` — FastAPI service on `:8000` with `/health` checking DB + LLM provider config.
- `backend/channel-simulator/` — separate FastAPI service on `:8001` with `/health`.
- `frontend/` — Next.js 15 + TypeScript + Tailwind, single page showing live health of both backends + build phase tracker.
- `backend/crm-api/app/ai/client.py` — provider-agnostic LLM client. Supports Anthropic, OpenAI, or deterministic stub. Defaults to stub so the app boots without API keys.
- `backend/crm-api/app/db/session.py` — SQLAlchemy engine + session, defaults to SQLite locally, switches to Postgres via `DATABASE_URL` env var in prod.
- Both backends share an HMAC secret (`WEBHOOK_HMAC_SECRET`) — wired in Phase 4.

## What's deliberately NOT in Phase 0

- No database tables. Phase 1 introduces Alembic migrations and the full schema.
- No real LLM calls. Stub returns realistic-shape JSON so the rest of the app can be built without burning tokens.
- No deployment. Local first; Vercel + Render in Phase 7 (or earlier if time permits).

## Defense notes

- **Why FastAPI not Express/Nest?** Pydantic gives us typed validation for both API contracts and LLM structured outputs in one library. Saves time on Phase 5.
- **Why provider-agnostic LLM layer with stub fallback?** Demo recording day risk: if the API key is rate-limited or down, the stub keeps the demo working. Also lets the eval harness in Phase 6 run without spending money.
- **Why a single venv for both backend services in dev?** Local DX. In production they deploy as two separate services with their own `requirements.txt` and `pip install`.
