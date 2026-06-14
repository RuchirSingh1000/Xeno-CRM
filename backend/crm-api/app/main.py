import anyio
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.routes import ai_runs, analytics, campaigns, copilot, customers, data_sources, evals, health, identities, ingest, segments, webhooks

app = FastAPI(title="Xeno Retail Activation Console — CRM API", version="0.1.0")


@app.on_event("startup")
async def _on_startup() -> None:
    # Bump the sync-handler threadpool so concurrent webhooks don't queue past
    # the simulator's read timeout.
    anyio.to_thread.current_default_thread_limiter().total_tokens = 200

    # Auto-create schema on boot. Idempotent — if tables already exist,
    # this is a no-op. Necessary on Render's ephemeral free-tier disk,
    # which starts every deploy with an empty SQLite file.
    from app.db.session import Base, engine
    from app import models  # noqa: F401 — ensure all model classes are registered
    Base.metadata.create_all(bind=engine)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router)
app.include_router(data_sources.router)
app.include_router(ingest.router)
app.include_router(customers.router)
app.include_router(identities.router)
app.include_router(ai_runs.router)
app.include_router(segments.router)
app.include_router(campaigns.router)
app.include_router(webhooks.router)
app.include_router(analytics.router)
app.include_router(copilot.router)
app.include_router(evals.router)


@app.get("/")
def root():
    return {"service": "crm-api", "docs": "/docs", "health": "/health"}
