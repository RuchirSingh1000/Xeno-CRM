"""Ingest orders.csv into the orders table, joined to canonical customers.

Orders ride on the same identity graph that resolution built. For each order row we
try normalized_phone -> normalized_email lookup against CustomerIdentity. Orphan
orders (no matching customer) are still stored with customer_id=NULL — Phase 6
analytics surfaces these as "unattributed revenue" so the FDE can show the value
of better identity resolution.

Idempotent: orders unique on (source_system, source_order_id). Re-runs upsert
nothing new on the same input.
"""
from __future__ import annotations

import csv
import io
from typing import Optional

from sqlalchemy import delete
from sqlalchemy.orm import Session

from app.models import Customer, CustomerIdentity, Order
from app.services.normalize import normalize_email, normalize_phone, parse_amount, parse_date


def ingest_orders_csv(db: Session, brand_id: int, content: bytes) -> dict:
    """Parse the orders CSV and write rows, joining each to a canonical customer."""
    # Clear existing orders for this brand. Resolution should be re-run before this.
    db.execute(delete(Order).where(Order.brand_id == brand_id))
    db.commit()

    # Build lookup indexes from CustomerIdentity for the brand.
    rows = (
        db.query(Customer.id, CustomerIdentity.normalized_phone, CustomerIdentity.normalized_email)
        .join(CustomerIdentity, CustomerIdentity.customer_id == Customer.id)
        .filter(Customer.brand_id == brand_id)
        .all()
    )
    phone_idx: dict[str, int] = {}
    email_idx: dict[str, int] = {}
    for cid, p, e in rows:
        if p and p not in phone_idx:
            phone_idx[p] = cid
        if e and e not in email_idx:
            email_idx[e] = cid

    text = content.decode("utf-8")
    reader = csv.DictReader(io.StringIO(text))

    matched = 0
    unmatched = 0
    by_source: dict[str, int] = {}
    customer_totals: dict[int, dict] = {}

    for row in reader:
        source = (row.get("source_system") or "").strip()
        src_order_id = row.get("source_order_id") or ""
        phone_n = normalize_phone(row.get("customer_mobile"))
        email_n = normalize_email(row.get("customer_email"))
        order_date = parse_date(row.get("order_date"))
        amount = parse_amount(row.get("amount_inr")) or 0.0

        customer_id: Optional[int] = None
        if phone_n and phone_n in phone_idx:
            customer_id = phone_idx[phone_n]
        elif email_n and email_n in email_idx:
            customer_id = email_idx[email_n]

        if customer_id:
            matched += 1
        else:
            unmatched += 1

        by_source[source] = by_source.get(source, 0) + 1

        try:
            items = int(row.get("items_count") or 1)
        except ValueError:
            items = 1

        if order_date is None:
            # Skip undated rows rather than poison the orders table.
            continue

        db.add(Order(
            brand_id=brand_id,
            customer_id=customer_id,
            source_system=source,
            source_order_id=src_order_id,
            order_date=order_date,
            amount=amount,
            items_count=items,
            category=row.get("category"),
            store_id=row.get("store_id"),
            status="completed",
        ))

        if customer_id:
            ct = customer_totals.setdefault(customer_id, {"total": 0.0, "count": 0, "last": order_date})
            ct["total"] += amount
            ct["count"] += 1
            if order_date > ct["last"]:
                ct["last"] = order_date

    db.commit()

    # Roll up LTV + first/last seen onto customers
    for cid, agg in customer_totals.items():
        cust = db.get(Customer, cid)
        if cust:
            cust.lifetime_value = round(agg["total"], 2)
            cust.total_orders = agg["count"]
            cust.last_order_at = agg["last"]
            if not cust.first_seen_at or agg["last"] < cust.first_seen_at:
                cust.first_seen_at = agg["last"]
    db.commit()

    return {
        "orders_ingested": matched + unmatched,
        "matched_to_customer": matched,
        "unattributed": unmatched,
        "by_source": by_source,
        "match_rate": round(matched / max(1, matched + unmatched), 3),
    }
