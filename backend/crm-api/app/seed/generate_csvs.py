"""Generate three intentionally-conflicting CSVs for the demo brand "Brewhouse Co."

Why this is designed the way it is:
- Real Indian D2C brands run POS + ecommerce + loyalty as three separate systems
  with three separate teams. The same customer appears differently in each.
- Identity resolution is the single most FDE-shaped problem in the whole app, so the
  seed data is shaped to *require* resolution to work correctly.
- We seed 1500 unique underlying customers. Each is assigned to a subset of sources:
  - ~30% appear in exactly one source
  - ~40% appear in two sources
  - ~30% appear in all three
- Then each CSV represents that source's view of the customer with realistic noise:
  POS uses phone-only with `+91-XXXXX-XXXXX` format and abbreviated names.
  Shopify uses email-first with full names.
  Loyalty uses 10-digit phone (no country code) + email + tier + DOB.
- Noise patterns applied to duplicates:
  - Name spelling drift: "Rohit Sharma" / "Rohit S." / "rohit sharma"
  - Phone format variance: "+91-98765-43210" / "9876543210" / "919876543210"
  - One in ~12 duplicates gets a single-character email typo.
- ~5000 orders distributed across customers, with date ranges that support a
  "lapsed > 60 days" segment for the demo.
"""
from __future__ import annotations

import csv
import json
import random
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from app.seed.indian_data import (
    CATEGORIES,
    CITIES,
    FIRST_NAMES,
    LAST_NAMES,
    LOYALTY_TIERS,
    STORE_IDS,
)

SEED = 20260609  # reproducible
TOTAL_CUSTOMERS = 1500
TARGET_ORDERS = 5000
TODAY = datetime(2026, 6, 9, 12, 0, 0)
ORDER_WINDOW_START = TODAY - timedelta(days=540)  # ~18 months of order history


def _rng() -> random.Random:
    return random.Random(SEED)


def _phone_10(rng: random.Random) -> str:
    return f"{rng.randint(7, 9)}{rng.randint(0, 9)}{''.join(str(rng.randint(0, 9)) for _ in range(8))}"


def _normalize_email(first: str, last: str, idx: int, rng: random.Random) -> str:
    sep = rng.choice(["", ".", "_"])
    domain = rng.choice(["gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "rediffmail.com"])
    return f"{first.lower()}{sep}{last.lower()}{idx}@{domain}"


def _name_drift(full_name: str, rng: random.Random) -> str:
    """Realistic name spelling drift for the same person across sources."""
    parts = full_name.split()
    first, last = parts[0], parts[-1]
    style = rng.choice(["abbrev_last", "lower", "title", "mid_initial"])
    if style == "abbrev_last":
        return f"{first} {last[0]}."
    if style == "lower":
        return full_name.lower()
    if style == "title":
        return full_name.title()
    return f"{first[0]}. {last}"


def _typo(s: str, rng: random.Random) -> str:
    if len(s) < 4:
        return s
    i = rng.randint(1, len(s) - 2)
    # swap two adjacent chars
    return s[:i] + s[i + 1] + s[i] + s[i + 2:]


def build_master_pool(rng: random.Random) -> list[dict[str, Any]]:
    """Build the underlying truth: 1500 unique customers and which sources they belong to."""
    pool: list[dict[str, Any]] = []
    for i in range(TOTAL_CUSTOMERS):
        first = rng.choice(FIRST_NAMES)
        last = rng.choice(LAST_NAMES)
        full = f"{first} {last}"
        city, state = rng.choice(CITIES)
        phone10 = _phone_10(rng)
        email = _normalize_email(first, last, i, rng)
        signup_offset_days = rng.randint(30, 720)
        signup = TODAY - timedelta(days=signup_offset_days)

        # Source membership: tweak distribution to ~30% one source, ~40% two, ~30% three
        r = rng.random()
        if r < 0.30:
            sources = [rng.choice(["pos", "ecommerce", "loyalty"])]
        elif r < 0.70:
            sources = rng.sample(["pos", "ecommerce", "loyalty"], 2)
        else:
            sources = ["pos", "ecommerce", "loyalty"]

        tier = rng.choices(LOYALTY_TIERS, weights=[50, 30, 15, 5])[0]
        dob = TODAY - timedelta(days=rng.randint(18, 65) * 365 + rng.randint(0, 364))

        pool.append({
            "id": i,
            "first_name": first,
            "last_name": last,
            "full_name": full,
            "phone10": phone10,
            "email": email,
            "city": city,
            "state": state,
            "signup_at": signup,
            "tier": tier,
            "dob": dob,
            "sources": sources,
            "order_propensity": rng.random(),  # used to skew order distribution
            # consent (will be applied at ingestion time but we encode in master truth)
            "whatsapp_opted_in": rng.random() < 0.62,
            "sms_opted_in": rng.random() < 0.88,
            "email_opted_in": rng.random() < 0.75,
            "rcs_opted_in": rng.random() < 0.22,
            "dnd": rng.random() < 0.05,
        })
    return pool


def write_pos_csv(pool: list[dict[str, Any]], rng: random.Random, out: Path) -> int:
    """POS export: phone-first, abbreviated names, store visits, last visit/amount."""
    rows: list[dict[str, str]] = []
    for c in pool:
        if "pos" not in c["sources"]:
            continue
        # phone in +91-XXXXX-XXXXX format with occasional drift
        p = c["phone10"]
        fmt = rng.choice(["+91-XXXXX-XXXXX", "+91 XXXXX XXXXX", "+91XXXXXXXXXX"])
        phone = (
            f"+91-{p[:5]}-{p[5:]}"
            if fmt == "+91-XXXXX-XXXXX"
            else f"+91 {p[:5]} {p[5:]}"
            if fmt == "+91 XXXXX XXXXX"
            else f"+91{p}"
        )
        name = c["full_name"] if rng.random() < 0.5 else _name_drift(c["full_name"], rng)
        visits = rng.randint(1, 40)
        last_visit_days = rng.randint(1, 200)
        last_visit = TODAY - timedelta(days=last_visit_days)
        last_amount = round(rng.uniform(150, 1800), 2)
        store = rng.choice([s for s in STORE_IDS if s != "online"])
        rows.append({
            "customer_mobile": phone,
            "customer_name": name,
            "store_id": store,
            "store_visits": str(visits),
            "last_visit_date": last_visit.strftime("%d-%m-%Y"),
            "last_bill_amount": str(last_amount),
            "city": c["city"],
        })

    with out.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=[
            "customer_mobile", "customer_name", "store_id", "store_visits",
            "last_visit_date", "last_bill_amount", "city",
        ])
        writer.writeheader()
        writer.writerows(rows)
    return len(rows)


def write_shopify_csv(pool: list[dict[str, Any]], rng: random.Random, out: Path) -> int:
    """Ecommerce (Shopify-style) export: email-first, full names, total_orders, LTV."""
    rows: list[dict[str, str]] = []
    for c in pool:
        if "ecommerce" not in c["sources"]:
            continue
        email = c["email"]
        # ~8% of duplicates get a single-character typo
        if len([s for s in c["sources"] if s != "ecommerce"]) > 0 and rng.random() < 0.08:
            local, domain = email.split("@", 1)
            email = f"{_typo(local, rng)}@{domain}"
        name = c["full_name"] if rng.random() < 0.7 else _name_drift(c["full_name"], rng)
        total_orders = max(0, int(rng.gauss(6, 4) * c["order_propensity"] * 2))
        ltv = round(total_orders * rng.uniform(280, 720), 2)
        signup = c["signup_at"]
        accepts_marketing = "yes" if rng.random() < 0.78 else "no"
        rows.append({
            "email": email,
            "full_name": name,
            "total_orders": str(total_orders),
            "total_spent_inr": str(ltv),
            "signup_date": signup.strftime("%Y-%m-%d"),
            "city": c["city"],
            "accepts_marketing": accepts_marketing,
        })

    with out.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=[
            "email", "full_name", "total_orders", "total_spent_inr",
            "signup_date", "city", "accepts_marketing",
        ])
        writer.writeheader()
        writer.writerows(rows)
    return len(rows)


def write_loyalty_csv(pool: list[dict[str, Any]], rng: random.Random, out: Path) -> int:
    """Loyalty program export: 10-digit phone, email_id, tier, points, DOB."""
    rows: list[dict[str, str]] = []
    for c in pool:
        if "loyalty" not in c["sources"]:
            continue
        name = c["full_name"] if rng.random() < 0.6 else _name_drift(c["full_name"], rng)
        member_id = f"BH-{100000 + c['id']:06d}"
        points = int(rng.uniform(0, 5000) * c["order_propensity"])
        email = c["email"]
        if rng.random() < 0.06:
            local, domain = email.split("@", 1)
            email = f"{_typo(local, rng)}@{domain}"
        rows.append({
            "member_id": member_id,
            "member_name": name,
            "phone": c["phone10"],  # 10-digit, no country code
            "email_id": email,
            "tier": c["tier"],
            "points_balance": str(points),
            "dob": c["dob"].strftime("%d/%m/%Y"),
            "joined_on": c["signup_at"].strftime("%Y-%m-%d"),
        })

    with out.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=[
            "member_id", "member_name", "phone", "email_id", "tier",
            "points_balance", "dob", "joined_on",
        ])
        writer.writeheader()
        writer.writerows(rows)
    return len(rows)


def write_orders_csv(pool: list[dict[str, Any]], rng: random.Random, out: Path) -> int:
    """Order history spanning all three sources, ~5000 rows."""
    # Weight customers by their order_propensity to make distribution realistic
    weights = [c["order_propensity"] for c in pool]
    customers = rng.choices(pool, weights=weights, k=TARGET_ORDERS)
    rows: list[dict[str, str]] = []
    for i, c in enumerate(customers):
        source = rng.choice(c["sources"])
        # POS orders skew toward in-store recent dates; ecom spreads more; loyalty uses online
        days_ago = max(1, int(rng.expovariate(1 / 90)))
        if days_ago > 540:
            days_ago = rng.randint(1, 540)
        order_date = TODAY - timedelta(days=days_ago, hours=rng.randint(0, 23))
        cat_name, lo, hi = rng.choice(CATEGORIES)
        items = rng.choices([1, 2, 3, 4], weights=[60, 25, 10, 5])[0]
        amount = round(rng.uniform(lo, hi) * items * rng.uniform(0.9, 1.1), 2)
        store = rng.choice([s for s in STORE_IDS if s != "online"]) if source == "pos" else "online"
        rows.append({
            "source_system": source,
            "source_order_id": f"{source.upper()[:3]}-{i:07d}",
            "customer_mobile": c["phone10"],
            "customer_email": c["email"],
            "customer_name": c["full_name"],
            "order_date": order_date.strftime("%Y-%m-%d %H:%M:%S"),
            "amount_inr": str(amount),
            "items_count": str(items),
            "category": cat_name,
            "store_id": store,
        })

    with out.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=[
            "source_system", "source_order_id", "customer_mobile", "customer_email",
            "customer_name", "order_date", "amount_inr", "items_count", "category", "store_id",
        ])
        writer.writeheader()
        writer.writerows(rows)
    return len(rows)


def generate_all(data_dir: Path) -> dict[str, Any]:
    """Generate all four CSVs and return a manifest."""
    data_dir.mkdir(parents=True, exist_ok=True)
    rng = _rng()
    pool = build_master_pool(rng)

    pos_path = data_dir / "brewhouse_pos_export.csv"
    shopify_path = data_dir / "brewhouse_shopify_export.csv"
    loyalty_path = data_dir / "brewhouse_loyalty_export.csv"
    orders_path = data_dir / "brewhouse_orders.csv"

    pos_n = write_pos_csv(pool, rng, pos_path)
    shopify_n = write_shopify_csv(pool, rng, shopify_path)
    loyalty_n = write_loyalty_csv(pool, rng, loyalty_path)
    orders_n = write_orders_csv(pool, rng, orders_path)

    # Compute truth-side overlap stats for the manifest (for demo narration)
    in_pos = sum(1 for c in pool if "pos" in c["sources"])
    in_ecom = sum(1 for c in pool if "ecommerce" in c["sources"])
    in_loy = sum(1 for c in pool if "loyalty" in c["sources"])
    in_two = sum(1 for c in pool if len(c["sources"]) == 2)
    in_three = sum(1 for c in pool if len(c["sources"]) == 3)
    in_one = sum(1 for c in pool if len(c["sources"]) == 1)

    manifest = {
        "brand": {
            "name": "Brewhouse Co.",
            "industry": "Coffee & QSR (D2C)",
            "country": "India",
            "description": "A mid-size Indian D2C coffee chain operating 25 retail locations across Bengaluru, Mumbai, Delhi, Pune, Hyderabad, and Chennai, plus a Shopify storefront and a loyalty program. Three separate systems, three separate teams, three separate views of the same customer.",
        },
        "underlying_customers": len(pool),
        "overlap": {
            "in_one_source_only": in_one,
            "in_two_sources": in_two,
            "in_all_three_sources": in_three,
        },
        "sources": [
            {
                "key": "pos",
                "label": "POS export",
                "system": "Retail point-of-sale",
                "filename": pos_path.name,
                "row_count": pos_n,
                "primary_identifier": "phone (+91 format)",
                "fields": ["customer_mobile", "customer_name", "store_id", "store_visits", "last_visit_date", "last_bill_amount", "city"],
                "quirks": [
                    "Phone in +91-XXXXX-XXXXX or +91 XXXXX XXXXX format",
                    "Names are inconsistent: full, initialled, or lowercase",
                    "No email captured",
                ],
            },
            {
                "key": "ecommerce",
                "label": "Shopify export",
                "system": "Ecommerce storefront",
                "filename": shopify_path.name,
                "row_count": shopify_n,
                "primary_identifier": "email",
                "fields": ["email", "full_name", "total_orders", "total_spent_inr", "signup_date", "city", "accepts_marketing"],
                "quirks": [
                    "Email-first, no phone",
                    "~8% of duplicate emails have single-character typos",
                    "Marketing consent only at coarse yes/no level",
                ],
            },
            {
                "key": "loyalty",
                "label": "Loyalty program export",
                "system": "Loyalty CRM",
                "filename": loyalty_path.name,
                "row_count": loyalty_n,
                "primary_identifier": "member_id + phone (10-digit) + email",
                "fields": ["member_id", "member_name", "phone", "email_id", "tier", "points_balance", "dob", "joined_on"],
                "quirks": [
                    "Phone is 10-digit only (no country code)",
                    "Tier and points enable VIP segmentation",
                    "DOB enables birthday campaigns",
                ],
            },
        ],
        "orders": {
            "filename": orders_path.name,
            "row_count": orders_n,
            "window_days": 540,
            "categories": [c[0] for c in CATEGORIES],
        },
    }

    manifest_path = data_dir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return manifest


if __name__ == "__main__":
    out = Path(__file__).resolve().parents[3].parent / "data"
    m = generate_all(out)
    print(json.dumps(m, indent=2))
