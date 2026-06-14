"""Ingestion + identity resolution + orders endpoints."""
from __future__ import annotations

from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import delete
from sqlalchemy.orm import Session

from app.config import settings
from app.db.session import get_db
from app.models import (
    Communication,
    CommunicationEvent,
    Consent,
    Customer,
    CustomerIdentity,
    ImportBatch,
    Order,
    StagedRecord,
    WebhookDelivery,
)
from app.services.brand import get_or_create_demo_brand
from app.services.data_quality import quality_report
from app.services.identity_resolution import resolve
from app.services.ingestion import SOURCE_MAPPINGS, ingest_csv
from app.services.orders_ingestion import ingest_orders_csv
from app.services.ai_csv_mapper import apply_csv as csv_apply, preview_csv as csv_preview

router = APIRouter(prefix="/ingest", tags=["ingest"])

SEED_FILES = {
    "pos": "brewhouse_pos_export.csv",
    "ecommerce": "brewhouse_shopify_export.csv",
    "loyalty": "brewhouse_loyalty_export.csv",
    "orders": "brewhouse_orders.csv",
}


def _data_dir() -> Path:
    p = Path(settings.data_dir)
    if not p.is_absolute():
        p = (Path(__file__).resolve().parents[3] / p).resolve()
    return p


@router.get("/batches")
def list_batches(db: Session = Depends(get_db)) -> dict:
    brand = get_or_create_demo_brand(db)
    batches = (
        db.query(ImportBatch)
        .filter(ImportBatch.brand_id == brand.id)
        .order_by(ImportBatch.id.desc())
        .all()
    )
    return {
        "batches": [
            {
                "id": b.id,
                "source_type": b.source_type,
                "filename": b.filename,
                "row_count": b.row_count,
                "status": b.status,
                "started_at": b.started_at.isoformat() if b.started_at else None,
                "completed_at": b.completed_at.isoformat() if b.completed_at else None,
            }
            for b in batches
        ]
    }


@router.post("/source/{source_type}")
async def ingest_source(
    source_type: str,
    file: Optional[UploadFile] = File(None),
    db: Session = Depends(get_db),
) -> dict:
    """Upload a CSV for a source, or pass no file to use the seed CSV from disk."""
    if source_type not in SOURCE_MAPPINGS:
        raise HTTPException(status_code=400, detail=f"unknown source_type: {source_type}")
    brand = get_or_create_demo_brand(db)

    if file is not None:
        content = await file.read()
        filename = file.filename or f"{source_type}.csv"
    else:
        seed_path = _data_dir() / SEED_FILES[source_type]
        if not seed_path.exists():
            raise HTTPException(status_code=404, detail=f"seed file missing: {seed_path.name}")
        content = seed_path.read_bytes()
        filename = seed_path.name

    batch = ingest_csv(db, brand.id, source_type, filename, content)
    return {
        "batch_id": batch.id,
        "source_type": batch.source_type,
        "filename": batch.filename,
        "row_count": batch.row_count,
        "status": batch.status,
    }


@router.post("/seed/all")
def ingest_all_seed(db: Session = Depends(get_db)) -> dict:
    """Convenience: ingest pos + ecommerce + loyalty in one call.

    Wipes any prior staged_records for this brand first so the demo is reproducible.
    Does NOT run resolution — call /ingest/resolve next.
    """
    brand = get_or_create_demo_brand(db)
    # Wipe prior staged + batches for a clean seed
    db.query(StagedRecord).delete()
    db.query(ImportBatch).filter(ImportBatch.brand_id == brand.id).delete()
    db.commit()

    results = []
    for source_type in ("pos", "ecommerce", "loyalty"):
        seed_path = _data_dir() / SEED_FILES[source_type]
        batch = ingest_csv(db, brand.id, source_type, seed_path.name, seed_path.read_bytes())
        results.append({
            "source_type": source_type,
            "row_count": batch.row_count,
            "batch_id": batch.id,
        })
    return {"ingested": results}


@router.get("/data-quality")
def get_data_quality(db: Session = Depends(get_db)) -> dict:
    brand = get_or_create_demo_brand(db)
    return quality_report(db, brand.id)


@router.post("/resolve")
def run_resolution(db: Session = Depends(get_db)) -> dict:
    """Run identity resolution across all staged records and then ingest orders."""
    brand = get_or_create_demo_brand(db)
    summary = resolve(db, brand.id)

    # Auto-ingest orders against the freshly-resolved customers
    orders_path = _data_dir() / SEED_FILES["orders"]
    if orders_path.exists():
        orders_summary = ingest_orders_csv(db, brand.id, orders_path.read_bytes())
        summary["orders"] = orders_summary

    return summary


class CsvPreviewIn(BaseModel):
    csv_text: str = Field(..., min_length=10, max_length=2_000_000)


class CsvApplyIn(BaseModel):
    csv_text: str = Field(..., min_length=10, max_length=2_000_000)
    mapping: dict[str, str | None] = Field(...)


@router.post("/csv/preview")
def csv_preview_route(payload: CsvPreviewIn, db: Session = Depends(get_db)) -> dict:
    """Messy-CSV ingest step 1: AI proposes a column → canonical mapping.
    Returns the headers, sample rows with per-row issues, the mapping, and
    discarded columns for operator review."""
    return csv_preview(db, payload.csv_text)


@router.post("/csv/apply")
def csv_apply_route(payload: CsvApplyIn, db: Session = Depends(get_db)) -> dict:
    """Messy-CSV ingest step 2: confirmed mapping is applied — creates Customers,
    Identities (source_system='csv_upload'), and default Consents."""
    brand = get_or_create_demo_brand(db)
    return csv_apply(db, brand.id, payload.csv_text, payload.mapping)


@router.post("/reset")
def reset_all(db: Session = Depends(get_db)) -> dict:
    """Wipe ingestion + canonical state. Use to redo the demo from scratch.

    SQLite doesn't enforce ON DELETE CASCADE and bulk `delete()` bypasses
    SQLAlchemy ORM cascades, so we have to walk the dependency graph manually
    or we leave orphan identity/consent/communication rows. Order matters:
    children before parents.
    """
    brand = get_or_create_demo_brand(db)
    # Children of Communication
    db.query(WebhookDelivery).delete(synchronize_session=False)
    db.query(CommunicationEvent).delete(synchronize_session=False)
    # Children of Customer
    db.query(Communication).delete(synchronize_session=False)
    db.query(Order).filter(Order.brand_id == brand.id).delete(synchronize_session=False)
    db.query(Consent).delete(synchronize_session=False)
    db.query(CustomerIdentity).delete(synchronize_session=False)
    # Parents
    db.query(Customer).filter(Customer.brand_id == brand.id).delete(synchronize_session=False)
    db.query(StagedRecord).delete(synchronize_session=False)
    db.query(ImportBatch).filter(ImportBatch.brand_id == brand.id).delete(synchronize_session=False)
    db.commit()
    return {"reset": True}
