"""Single-brand bootstrap for the demo. Phase 7 wires real multi-tenant lookup."""
from __future__ import annotations

from sqlalchemy.orm import Session

from app.models import Brand

DEMO_BRAND_NAME = "Brewhouse Co."


def get_or_create_demo_brand(db: Session) -> Brand:
    brand = db.query(Brand).filter(Brand.name == DEMO_BRAND_NAME).first()
    if brand:
        return brand
    brand = Brand(
        name=DEMO_BRAND_NAME,
        industry="Coffee & QSR (D2C)",
        country="IN",
        description="Mid-size Indian D2C coffee chain operating 25 retail locations.",
    )
    db.add(brand)
    db.commit()
    db.refresh(brand)
    return brand
