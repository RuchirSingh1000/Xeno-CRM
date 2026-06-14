"""Cross-campaign analytics endpoints."""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.services import analytics as svc
from app.services.brand import get_or_create_demo_brand

router = APIRouter(prefix="/analytics", tags=["analytics"])


@router.get("/overview")
def overview(db: Session = Depends(get_db)) -> dict:
    brand = get_or_create_demo_brand(db)
    return svc.overview(db, brand.id)


@router.get("/channels")
def channels(db: Session = Depends(get_db)) -> dict:
    brand = get_or_create_demo_brand(db)
    return svc.channels(db, brand.id)


@router.get("/campaigns-leaderboard")
def campaigns_leaderboard(db: Session = Depends(get_db), limit: int = 20) -> dict:
    brand = get_or_create_demo_brand(db)
    return svc.campaigns_leaderboard(db, brand.id, limit)


@router.get("/failures")
def failures(db: Session = Depends(get_db)) -> dict:
    brand = get_or_create_demo_brand(db)
    return svc.failures(db, brand.id)


@router.get("/ai-usage")
def ai_usage(db: Session = Depends(get_db)) -> dict:
    return svc.ai_usage(db)


@router.get("/revenue-timeline")
def revenue_timeline(db: Session = Depends(get_db)) -> dict:
    brand = get_or_create_demo_brand(db)
    return svc.revenue_timeline(db, brand.id)


@router.get("/dashboard")
def dashboard(db: Session = Depends(get_db)) -> dict:
    """One-call dashboard payload: everything the /analytics page needs."""
    brand = get_or_create_demo_brand(db)
    return {
        "overview": svc.overview(db, brand.id),
        "channels": svc.channels(db, brand.id)["channels"],
        "campaigns": svc.campaigns_leaderboard(db, brand.id, 20)["campaigns"],
        "failures": svc.failures(db, brand.id),
        "ai_usage": svc.ai_usage(db),
        "revenue_timeline": svc.revenue_timeline(db, brand.id)["timeline"],
    }
