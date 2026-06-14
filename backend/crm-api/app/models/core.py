"""Core SQLAlchemy models for the Retail Activation Console.

Schema design notes:
- All tables scope to `brand_id` for future multi-tenancy (one brand seeded for the demo).
- `customer_identities` is separate from `customers` — one canonical customer can have
  multiple source identities (POS row, Shopify row, loyalty row) with provenance and a
  confidence score from identity resolution.
- `communication_events` is append-only; `communications.current_status` is a derived
  materialization recomputed on event ingest. State derived from max(sequence), so the
  system is safe under out-of-order webhook delivery.
- `webhook_deliveries` tracks every incoming webhook attempt (including dedup'd ones and
  failures) so we can show idempotency in the UI and replay failed deliveries.
- `ai_runs` is the audit log for every LLM call: prompt version, raw output, validation
  status. Lets us defend "where did this AI decision come from."
"""
from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.session import Base


def _ts() -> Mapped[datetime]:
    return mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


# ---------- Brand (demo tenant) ----------

class Brand(Base):
    __tablename__ = "brands"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    industry: Mapped[str] = mapped_column(String(100), default="retail")
    country: Mapped[str] = mapped_column(String(8), default="IN")
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = _ts()


# ---------- Ingestion: import_batches + staged_records ----------

class ImportBatch(Base):
    __tablename__ = "import_batches"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    brand_id: Mapped[int] = mapped_column(ForeignKey("brands.id"), index=True, nullable=False)
    source_type: Mapped[str] = mapped_column(String(32), nullable=False)  # pos | ecommerce | loyalty
    filename: Mapped[str] = mapped_column(String(255), nullable=False)
    row_count: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String(32), default="pending")  # pending | processing | completed | failed
    mapping_json: Mapped[Optional[dict[str, Any]]] = mapped_column(JSON, nullable=True)
    error: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    started_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = _ts()


class StagedRecord(Base):
    __tablename__ = "staged_records"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    import_batch_id: Mapped[int] = mapped_column(ForeignKey("import_batches.id"), index=True, nullable=False)
    row_index: Mapped[int] = mapped_column(Integer, nullable=False)
    raw_data: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
    normalized: Mapped[Optional[dict[str, Any]]] = mapped_column(JSON, nullable=True)
    processed: Mapped[bool] = mapped_column(Boolean, default=False)
    error: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = _ts()


# ---------- Canonical customers + identity resolution ----------

class Customer(Base):
    __tablename__ = "customers"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    brand_id: Mapped[int] = mapped_column(ForeignKey("brands.id"), index=True, nullable=False)
    master_customer_id: Mapped[str] = mapped_column(String(64), index=True, nullable=False)
    first_name: Mapped[Optional[str]] = mapped_column(String(120), nullable=True)
    last_name: Mapped[Optional[str]] = mapped_column(String(120), nullable=True)
    full_name: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    primary_email: Mapped[Optional[str]] = mapped_column(String(255), nullable=True, index=True)
    primary_phone: Mapped[Optional[str]] = mapped_column(String(32), nullable=True, index=True)
    city: Mapped[Optional[str]] = mapped_column(String(120), nullable=True)
    state: Mapped[Optional[str]] = mapped_column(String(120), nullable=True)
    country: Mapped[str] = mapped_column(String(8), default="IN")
    loyalty_tier: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    lifetime_value: Mapped[float] = mapped_column(Float, default=0.0)
    total_orders: Mapped[int] = mapped_column(Integer, default=0)
    first_seen_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    last_order_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = _ts()

    identities: Mapped[list["CustomerIdentity"]] = relationship(back_populates="customer", cascade="all, delete-orphan")
    consent: Mapped[Optional["Consent"]] = relationship(back_populates="customer", uselist=False, cascade="all, delete-orphan")
    orders: Mapped[list["Order"]] = relationship(back_populates="customer")


class CustomerIdentity(Base):
    __tablename__ = "customer_identities"
    __table_args__ = (
        UniqueConstraint("source_system", "source_record_id", name="uq_identity_source"),
        Index("ix_identity_norm_phone", "normalized_phone"),
        Index("ix_identity_norm_email", "normalized_email"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    customer_id: Mapped[int] = mapped_column(ForeignKey("customers.id"), index=True, nullable=False)
    source_system: Mapped[str] = mapped_column(String(32), nullable=False)  # pos | ecommerce | loyalty
    source_record_id: Mapped[str] = mapped_column(String(120), nullable=False)
    raw_name: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    raw_phone: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    raw_email: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    normalized_phone: Mapped[Optional[str]] = mapped_column(String(16), nullable=True)
    normalized_email: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    match_confidence: Mapped[float] = mapped_column(Float, default=1.0)
    match_reasoning: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = _ts()

    customer: Mapped["Customer"] = relationship(back_populates="identities")


# ---------- Consent (TRAI/DND-aware) ----------

class Consent(Base):
    __tablename__ = "consent"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    customer_id: Mapped[int] = mapped_column(ForeignKey("customers.id"), unique=True, nullable=False)
    whatsapp_opted_in: Mapped[bool] = mapped_column(Boolean, default=False)
    sms_opted_in: Mapped[bool] = mapped_column(Boolean, default=False)
    email_opted_in: Mapped[bool] = mapped_column(Boolean, default=False)
    rcs_opted_in: Mapped[bool] = mapped_column(Boolean, default=False)
    dnd_status: Mapped[bool] = mapped_column(Boolean, default=False)  # TRAI DND registry flag
    last_consent_update: Mapped[datetime] = _ts()

    customer: Mapped["Customer"] = relationship(back_populates="consent")


# ---------- Orders ----------

class Order(Base):
    __tablename__ = "orders"
    __table_args__ = (
        UniqueConstraint("source_system", "source_order_id", name="uq_order_source"),
        Index("ix_order_customer_date", "customer_id", "order_date"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    brand_id: Mapped[int] = mapped_column(ForeignKey("brands.id"), index=True, nullable=False)
    customer_id: Mapped[Optional[int]] = mapped_column(ForeignKey("customers.id"), nullable=True, index=True)
    source_system: Mapped[str] = mapped_column(String(32), nullable=False)
    source_order_id: Mapped[str] = mapped_column(String(120), nullable=False)
    order_date: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    amount: Mapped[float] = mapped_column(Float, nullable=False)
    items_count: Mapped[int] = mapped_column(Integer, default=1)
    category: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    store_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    status: Mapped[str] = mapped_column(String(32), default="completed")
    created_at: Mapped[datetime] = _ts()

    customer: Mapped[Optional["Customer"]] = relationship(back_populates="orders")


# ---------- Segments + Campaigns ----------

class Segment(Base):
    __tablename__ = "segments"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    brand_id: Mapped[int] = mapped_column(ForeignKey("brands.id"), index=True, nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    definition_json: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
    preview_count: Mapped[int] = mapped_column(Integer, default=0)
    created_by_ai: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = _ts()


class Campaign(Base):
    __tablename__ = "campaigns"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    brand_id: Mapped[int] = mapped_column(ForeignKey("brands.id"), index=True, nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    goal: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    segment_id: Mapped[Optional[int]] = mapped_column(ForeignKey("segments.id"), nullable=True)
    channel_policy_json: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    message_template: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    ai_plan_json: Mapped[Optional[dict[str, Any]]] = mapped_column(JSON, nullable=True)
    status: Mapped[str] = mapped_column(String(32), default="draft")  # draft | launching | running | completed | failed
    total_targeted: Mapped[int] = mapped_column(Integer, default=0)
    total_skipped: Mapped[int] = mapped_column(Integer, default=0)
    ai_insight: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = _ts()
    launched_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)


# ---------- Communications + Events (append-only) ----------

class Communication(Base):
    __tablename__ = "communications"
    __table_args__ = (
        Index("ix_comm_campaign_status", "campaign_id", "current_status"),
        Index("ix_comm_provider_msg", "provider_message_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    campaign_id: Mapped[int] = mapped_column(ForeignKey("campaigns.id"), index=True, nullable=False)
    customer_id: Mapped[int] = mapped_column(ForeignKey("customers.id"), index=True, nullable=False)
    resolved_channel: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    routing_reason: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    provider_message_id: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    recipient: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    rendered_message: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    current_status: Mapped[str] = mapped_column(String(32), default="queued")
    last_sequence: Mapped[int] = mapped_column(Integer, default=0)
    queued_at: Mapped[datetime] = _ts()
    last_event_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)


class CommunicationEvent(Base):
    __tablename__ = "communication_events"
    __table_args__ = (
        UniqueConstraint("event_id", name="uq_event_id"),
        Index("ix_event_comm_seq", "communication_id", "sequence"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    event_id: Mapped[str] = mapped_column(String(64), nullable=False)
    communication_id: Mapped[int] = mapped_column(ForeignKey("communications.id"), index=True, nullable=False)
    event_type: Mapped[str] = mapped_column(String(32), nullable=False)  # sent|delivered|failed|opened|read|clicked|converted
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    sequence: Mapped[int] = mapped_column(Integer, default=0)
    failure_reason: Mapped[Optional[str]] = mapped_column(String(120), nullable=True)
    raw_payload: Mapped[Optional[dict[str, Any]]] = mapped_column(JSON, nullable=True)
    received_at: Mapped[datetime] = _ts()


class WebhookDelivery(Base):
    __tablename__ = "webhook_deliveries"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    provider_event_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True, index=True)
    status: Mapped[str] = mapped_column(String(32), nullable=False)  # received | processed | duplicate | invalid_signature | failed
    retry_count: Mapped[int] = mapped_column(Integer, default=0)
    last_error: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    raw_payload: Mapped[Optional[dict[str, Any]]] = mapped_column(JSON, nullable=True)
    received_at: Mapped[datetime] = _ts()
    processed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)


# ---------- AI run audit log ----------

class AIRun(Base):
    __tablename__ = "ai_runs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    purpose: Mapped[str] = mapped_column(String(64), nullable=False)  # campaign_plan | data_quality | segment_explain | merge_explain | post_campaign
    prompt_version: Mapped[str] = mapped_column(String(32), default="v1")
    provider: Mapped[str] = mapped_column(String(32), nullable=False)
    model: Mapped[str] = mapped_column(String(64), nullable=False)
    input_summary: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    raw_output: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    parsed_output: Mapped[Optional[dict[str, Any]]] = mapped_column(JSON, nullable=True)
    validation_status: Mapped[str] = mapped_column(String(32), default="ok")  # ok | retry_used | fallback_used | invalid
    error: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    latency_ms: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = _ts()
