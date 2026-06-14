"""Deterministic identity resolution across staged_records.

The matching rule chain in priority order — each rule produces a different
confidence band and reasoning string we can show in the UI:

  R1  Exact normalized phone match                  conf=1.00  reasoning=phone_exact
  R2  Exact normalized email match                  conf=0.95  reasoning=email_exact
  R3  Phone last-8 + fuzzy name (>=85) + same city  conf=0.85  reasoning=phone8_name_city
  R4  Fuzzy name (>=92) + same city                 conf=0.70  reasoning=name_city_only  (FLAGGED)

Design choices and the reasons behind them:

- **Union-find over staged_records.** Each staged_record is a node. Rules emit edges
  (with confidence). We compute connected components — each component becomes one
  canonical Customer. This handles transitive matches correctly: if A~B by phone
  and B~C by email, then A, B, C all unify even though A~C had no direct rule.

- **Confidence per identity, not per pair.** When a component is collapsed into a
  canonical customer, each contributing staged_record becomes a CustomerIdentity row
  with its source_system, raw values, and the *strongest* edge that pulled it into
  the component. That's the value shown in the UI as "why we believe this is the
  same person."

- **Flagged matches.** Rules with confidence < 0.85 are still merged automatically
  for the demo (since reviewers want to see the unified result), but they're tagged
  in the reasoning so the UI can highlight them and the AI explainer can be invoked.

- **Idempotency.** We delete existing customer/identity/consent/orders rows for the
  brand before resolving. That's intentional — resolution is a transformation over
  staged_records, not an incremental upsert. Phase 2 keeps it simple; production
  would do incremental merge with a versioned identity graph.

- **Why not ML?** Explainability, auditability, low false-positive cost. A marketer
  needs to see *why* two records were merged; "the model said so" doesn't survive a
  conversation with a customer team. ML adds opacity without accuracy gain at this
  scale.
"""
from __future__ import annotations

import re
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

from rapidfuzz import fuzz
from sqlalchemy import delete
from sqlalchemy.orm import Session

from app.models import (
    Consent,
    Customer,
    CustomerIdentity,
    ImportBatch,
    Order,
    StagedRecord,
)
from app.services.normalize import name_tokens

# Rules and labels
RULE_PHONE_EXACT = "phone_exact"
RULE_EMAIL_EXACT = "email_exact"
RULE_PHONE8_NAME_CITY = "phone8_name_city"
RULE_NAME_CITY_ONLY = "name_city_only"

CONFIDENCE = {
    RULE_PHONE_EXACT: 1.00,
    RULE_EMAIL_EXACT: 0.95,
    RULE_PHONE8_NAME_CITY: 0.85,
    RULE_NAME_CITY_ONLY: 0.70,
}

REASONING_TEXT = {
    RULE_PHONE_EXACT: "Exact match on normalized phone (last 10 digits).",
    RULE_EMAIL_EXACT: "Exact match on normalized email.",
    RULE_PHONE8_NAME_CITY: "Last 8 digits of phone match + fuzzy name >= 85 + same city.",
    RULE_NAME_CITY_ONLY: "Fuzzy name >= 92 + same city. No phone or email match available.",
}

FLAGGED_RULES = {RULE_NAME_CITY_ONLY}


@dataclass
class StagedView:
    """In-memory view of a staged_record for fast matching."""
    id: int
    source: str
    source_record_id: str
    phone: Optional[str]
    email: Optional[str]
    name: Optional[str]
    name_tokens: list[str]
    city: Optional[str]
    loyalty_tier: Optional[str]
    raw: dict
    normalized: dict


class UnionFind:
    def __init__(self) -> None:
        self.parent: dict[int, int] = {}
        # Strongest rule used to pull each node into its current component
        self.best_rule: dict[int, str] = {}

    def add(self, x: int) -> None:
        if x not in self.parent:
            self.parent[x] = x

    def find(self, x: int) -> int:
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, a: int, b: int, rule: str) -> None:
        ra, rb = self.find(a), self.find(b)
        # Promote the strongest rule for both endpoints so each node's
        # "why I'm in this component" is the strongest reason we have for it.
        for n in (a, b):
            prev = self.best_rule.get(n)
            if prev is None or CONFIDENCE[rule] > CONFIDENCE[prev]:
                self.best_rule[n] = rule
        if ra != rb:
            self.parent[ra] = rb


def _row_source_id(source: str, raw: dict) -> str:
    """Stable source-side identifier per row. Used for idempotent identity rows."""
    if source == "loyalty" and raw.get("member_id"):
        return str(raw["member_id"])
    if source == "ecommerce" and raw.get("email"):
        return str(raw["email"]).strip().lower()
    if source == "pos":
        # POS has no stable id; build one from phone + store + last_visit_date
        return f"{raw.get('customer_mobile', '')}|{raw.get('store_id', '')}|{raw.get('last_visit_date', '')}"
    return str(raw)


def _load_views(db: Session, brand_id: int) -> list[StagedView]:
    rows: list[tuple[StagedRecord, ImportBatch]] = (
        db.query(StagedRecord, ImportBatch)
        .join(ImportBatch, StagedRecord.import_batch_id == ImportBatch.id)
        .filter(ImportBatch.brand_id == brand_id, ImportBatch.status == "completed")
        .all()
    )
    views: list[StagedView] = []
    for sr, batch in rows:
        norm = sr.normalized or {}
        raw = sr.raw_data or {}
        name = norm.get("name_normalized") or raw.get("customer_name") or raw.get("full_name") or raw.get("member_name")
        city = raw.get("city")
        views.append(StagedView(
            id=sr.id,
            source=batch.source_type,
            source_record_id=_row_source_id(batch.source_type, raw),
            phone=norm.get("phone_normalized"),
            email=norm.get("email_normalized"),
            name=name,
            name_tokens=name_tokens(name),
            city=city,
            loyalty_tier=norm.get("loyalty_tier") or raw.get("tier"),
            raw=raw,
            normalized=norm,
        ))
    return views


def _fuzzy_name_score(a: list[str], b: list[str]) -> int:
    if not a or not b:
        return 0
    return int(fuzz.token_sort_ratio(" ".join(a), " ".join(b)))


def _apply_rules(views: list[StagedView]) -> UnionFind:
    uf = UnionFind()
    for v in views:
        uf.add(v.id)

    # R1: phone exact
    phone_idx: dict[str, list[StagedView]] = defaultdict(list)
    for v in views:
        if v.phone:
            phone_idx[v.phone].append(v)
    for group in phone_idx.values():
        if len(group) > 1:
            anchor = group[0]
            for v in group[1:]:
                uf.union(anchor.id, v.id, RULE_PHONE_EXACT)

    # R2: email exact
    email_idx: dict[str, list[StagedView]] = defaultdict(list)
    for v in views:
        if v.email:
            email_idx[v.email].append(v)
    for group in email_idx.values():
        if len(group) > 1:
            anchor = group[0]
            for v in group[1:]:
                uf.union(anchor.id, v.id, RULE_EMAIL_EXACT)

    # R3: phone last-8 + fuzzy name + same city
    # Build phone8 buckets (skipping rows already united by R1)
    phone8_idx: dict[str, list[StagedView]] = defaultdict(list)
    for v in views:
        if v.phone:
            phone8_idx[v.phone[-8:]].append(v)
    for bucket in phone8_idx.values():
        if len(bucket) < 2:
            continue
        for i in range(len(bucket)):
            for j in range(i + 1, len(bucket)):
                a, b = bucket[i], bucket[j]
                if uf.find(a.id) == uf.find(b.id):
                    continue
                if a.city and b.city and a.city != b.city:
                    continue
                score = _fuzzy_name_score(a.name_tokens, b.name_tokens)
                if score >= 85:
                    uf.union(a.id, b.id, RULE_PHONE8_NAME_CITY)

    # R4: fuzzy name + same city (only when no phone/email anchored the components)
    # Bucket by city to keep this O(n^2 per city) instead of O(n^2 global).
    by_city: dict[str, list[StagedView]] = defaultdict(list)
    for v in views:
        if v.city:
            by_city[v.city].append(v)
    for city_views in by_city.values():
        for i in range(len(city_views)):
            for j in range(i + 1, len(city_views)):
                a, b = city_views[i], city_views[j]
                if uf.find(a.id) == uf.find(b.id):
                    continue
                # Skip if either side has a phone or email — those rules already had
                # priority. R4 only applies when stronger identifiers are absent.
                if (a.phone and b.phone) or (a.email and b.email):
                    continue
                score = _fuzzy_name_score(a.name_tokens, b.name_tokens)
                if score >= 92:
                    uf.union(a.id, b.id, RULE_NAME_CITY_ONLY)

    return uf


def _component_groups(views: list[StagedView], uf: UnionFind) -> dict[int, list[StagedView]]:
    groups: dict[int, list[StagedView]] = defaultdict(list)
    for v in views:
        groups[uf.find(v.id)].append(v)
    return groups


def _choose_canonical(group: list[StagedView]) -> dict:
    """Pick the canonical representation across a group, preferring richer sources."""
    # Source preference: loyalty > ecommerce > pos. Loyalty has tier + DOB; ecom has email.
    rank = {"loyalty": 0, "ecommerce": 1, "pos": 2}
    sorted_group = sorted(group, key=lambda v: rank.get(v.source, 99))

    canonical = {
        "first_name": None,
        "last_name": None,
        "full_name": None,
        "email": None,
        "phone": None,
        "city": None,
        "state": None,
        "loyalty_tier": None,
    }
    for v in sorted_group:
        if not canonical["full_name"] and v.name:
            canonical["full_name"] = v.name
            parts = v.name.split()
            if parts:
                canonical["first_name"] = parts[0]
                canonical["last_name"] = parts[-1] if len(parts) > 1 else None
        if not canonical["email"] and v.email:
            canonical["email"] = v.email
        if not canonical["phone"] and v.phone:
            canonical["phone"] = v.phone
        if not canonical["city"] and v.city:
            canonical["city"] = v.city
        if not canonical["loyalty_tier"] and v.loyalty_tier:
            canonical["loyalty_tier"] = v.loyalty_tier
    return canonical


def _master_id(canonical: dict, component_id: int) -> str:
    """Stable master id per canonical customer. Format: BH-CUST-NNNNNN."""
    return f"BH-CUST-{component_id:06d}"


def _consent_for(canonical: dict, sources: set[str], rng_seed: int) -> dict:
    """Derive consent flags. Source coverage signals likely opt-in patterns:

    - Loyalty member  → high WhatsApp + Email opt-in (they signed up)
    - Ecommerce only  → Email opt-in, lower WhatsApp
    - POS only        → SMS opt-in (in-store interaction default)

    Deterministic from a per-customer seed so the demo is reproducible.
    """
    import random
    rng = random.Random(rng_seed)
    dnd = rng.random() < 0.05  # ~5% TRAI DND registry hit
    if dnd:
        return dict(whatsapp_opted_in=False, sms_opted_in=False,
                    email_opted_in=False, rcs_opted_in=False, dnd_status=True)
    has_loyalty = "loyalty" in sources
    has_ecom = "ecommerce" in sources
    has_pos = "pos" in sources
    return dict(
        whatsapp_opted_in=rng.random() < (0.80 if has_loyalty else 0.55 if has_ecom else 0.45),
        sms_opted_in=rng.random() < (0.92 if has_pos else 0.85),
        email_opted_in=rng.random() < (0.90 if (has_loyalty or has_ecom) else 0.30),
        rcs_opted_in=rng.random() < 0.22,
        dnd_status=False,
    )


def _strip_country(raw_phone: Optional[str]) -> str:
    if not raw_phone:
        return ""
    return re.sub(r"\D+", "", raw_phone)


def resolve(db: Session, brand_id: int) -> dict:
    """Run identity resolution end-to-end. Returns a summary report."""
    # 1. Wipe prior canonical state for this brand. Resolution is a deterministic
    # transformation over staged_records — we recompute, not incrementally upsert.
    # SQLite doesn't enforce ON DELETE CASCADE and bulk delete() bypasses
    # SQLAlchemy ORM cascades, so we wipe children explicitly. Otherwise prior
    # identity/consent rows orphan and the customer table looks empty while the
    # graph still references gone parents.
    customer_ids_subq = db.query(Customer.id).filter(Customer.brand_id == brand_id).subquery()
    db.query(Consent).filter(Consent.customer_id.in_(customer_ids_subq)).delete(synchronize_session=False)
    db.query(CustomerIdentity).filter(CustomerIdentity.customer_id.in_(customer_ids_subq)).delete(synchronize_session=False)
    db.execute(delete(Order).where(Order.brand_id == brand_id))
    db.execute(delete(Customer).where(Customer.brand_id == brand_id))
    db.commit()

    # 2. Load staged views
    views = _load_views(db, brand_id)
    if not views:
        return {"customers_created": 0, "identities_created": 0, "groups": [], "rule_counts": {}}

    # 3. Apply rules
    uf = _apply_rules(views)

    # 4. Group by component → canonical customers
    groups = _component_groups(views, uf)
    rule_counts: dict[str, int] = defaultdict(int)
    component_size_distribution: dict[int, int] = defaultdict(int)
    flagged_components = 0
    customers_created = 0
    identities_created = 0

    component_ids = sorted(groups.keys())
    for cid_index, root in enumerate(component_ids):
        group = groups[root]
        canonical = _choose_canonical(group)
        master_id = _master_id(canonical, cid_index + 1)
        sources = {v.source for v in group}

        component_size_distribution[len(group)] += 1
        is_flagged = any(uf.best_rule.get(v.id) in FLAGGED_RULES for v in group)
        if is_flagged:
            flagged_components += 1

        customer = Customer(
            brand_id=brand_id,
            master_customer_id=master_id,
            first_name=canonical["first_name"],
            last_name=canonical["last_name"],
            full_name=canonical["full_name"],
            primary_email=canonical["email"],
            primary_phone=canonical["phone"],
            city=canonical["city"],
            loyalty_tier=canonical["loyalty_tier"],
        )
        db.add(customer)
        db.flush()
        customers_created += 1

        # 5. One CustomerIdentity per staged_record in the component
        for v in group:
            rule = uf.best_rule.get(v.id) or RULE_PHONE_EXACT  # singleton -> trivially self
            # For singletons (size 1) there was no rule — mark as such
            if len(group) == 1:
                rule_label = "singleton"
                conf = 1.0
                reasoning = "Single source; nothing to merge."
            else:
                rule_label = rule
                conf = CONFIDENCE[rule]
                reasoning = REASONING_TEXT[rule]
                rule_counts[rule] += 1

            db.add(CustomerIdentity(
                customer_id=customer.id,
                source_system=v.source,
                source_record_id=v.source_record_id,
                raw_name=v.raw.get("customer_name") or v.raw.get("full_name") or v.raw.get("member_name"),
                raw_phone=v.raw.get("customer_mobile") or v.raw.get("phone"),
                raw_email=v.raw.get("email") or v.raw.get("email_id"),
                normalized_phone=v.phone,
                normalized_email=v.email,
                match_confidence=conf,
                match_reasoning=f"[{rule_label}] {reasoning}",
            ))
            identities_created += 1

        # 6. Consent (deterministic per customer)
        consent_vals = _consent_for(canonical, sources, rng_seed=cid_index)
        db.add(Consent(customer_id=customer.id, **consent_vals))

    db.commit()

    # 7. Mark staged_records as processed (audit)
    db.query(StagedRecord).update({"processed": True})
    db.commit()

    return {
        "customers_created": customers_created,
        "identities_created": identities_created,
        "rule_counts": dict(rule_counts),
        "flagged_components": flagged_components,
        "component_size_distribution": dict(component_size_distribution),
        "staged_rows": len(views),
        "deduplication_rate": round(1 - customers_created / max(1, len(views)), 3),
    }
