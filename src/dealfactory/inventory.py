"""Turn imported purchases into owned products and habit facts (all unconfirmed until you confirm them).

Rules:
* durable + accessory items become OwnedProducts; consumables, clothing, services and gift cards only feed habits.
* Returned or cancelled items are left out. Rejected purchases are ignored completely.
* An item that matches a product already in environment.yaml enriches it (date, shop, price) instead
  of adding a duplicate. Anything you wrote in environment.yaml wins over imported data.
"""

from __future__ import annotations

import re
import statistics
from collections import defaultdict
from datetime import date

from .llm import _norm
from .models import EnvironmentProfile, Money, OwnedProduct, ProfileFact, Purchase
from .profile import profile_version
from .stages._common import slugify
from .store import Store

INVENTORY_KINDS = {"durable", "accessory"}
HABIT_KINDS = {"consumable", "accessory", "clothing"}


def _tokens(*parts: str | None) -> set[str]:
    return set(re.findall(r"[a-z0-9]+", _norm(" ".join(p for p in parts if p))))


def _key(p: Purchase) -> str:
    return slugify(p.brand, p.model) if p.model else slugify(p.product_name)


def _active(purchases: list[Purchase]) -> list[Purchase]:
    """Not rejected, not a return document, and not later returned."""
    returned = {(p.merchant, _key(p)) for p in purchases if p.doc_type in ("return", "cancellation")}
    return [p for p in purchases if p.status != "rejected" and p.doc_type not in ("return", "cancellation")
            and (p.merchant, _key(p)) not in returned]


def _matches(existing: OwnedProduct, p: Purchase) -> bool:
    want = _tokens(existing.brand, existing.model) - {"model", "unknown"}
    have = _tokens(p.brand, p.model, p.product_name)
    if not want or not want <= have:
        return False
    return slugify(existing.category) == p.category or p.kind == "durable"


def owned_from_purchases(purchases: list[Purchase], existing: list[OwnedProduct]) -> tuple[list[OwnedProduct], list[OwnedProduct]]:
    """Return (enriched copies of existing products, new imported products)."""
    enriched = {e.id: e.model_copy() for e in existing}
    groups: dict[str, list[Purchase]] = defaultdict(list)
    for p in _active(purchases):
        if p.kind not in INVENTORY_KINDS:
            continue
        hit = next((e for e in existing if _matches(e, p)), None)
        if hit:
            e = enriched[hit.id]
            e.purchase_date = e.purchase_date or p.order_date
            e.retailer = e.retailer or p.merchant
            if e.price is None and p.price_verified and p.unit_price is not None:
                e.price = Money(amount=p.unit_price, currency=p.currency or "EUR")
            continue
        groups[_key(p)].append(p)

    new: list[OwnedProduct] = []
    for key, items in groups.items():
        items.sort(key=lambda p: p.order_date or "")
        first = items[0]
        confirmed = any(p.status == "confirmed" for p in items)
        priced = next((p for p in items if p.price_verified and p.unit_price is not None), None)
        new.append(OwnedProduct(
            id=f"imp-{key[:60]}", user_id=first.user_id, category=first.category,
            brand=first.brand or "(brand not stated)", model=first.model or first.product_name,
            variant=first.variant, purchase_date=first.order_date, retailer=first.merchant,
            price=Money(amount=priced.unit_price, currency=priced.currency or "EUR") if priced else None,
            notes=f"Imported from {len({p.source_ref for p in items})} document(s): \"{first.product_name}\""
                  + (" (accessory)" if first.kind == "accessory" else ""),
            source=first.source_kind, status="confirmed" if confirmed else "unconfirmed",
            confidence=0.9 if confirmed else (0.75 if first.brand and first.model else 0.6),
        ))
    return list(enriched.values()), new


def habit_facts(purchases: list[Purchase]) -> list[ProfileFact]:
    active = _active(purchases)
    if not active:
        return []
    source = "email" if any(p.source_kind == "email" for p in active) else "receipt"
    facts: list[ProfileFact] = []

    orders: dict[str, set[str]] = defaultdict(set)
    for p in active:
        if p.merchant:
            orders[p.merchant].add(p.source_ref)
    if orders:
        ranked = sorted(orders.items(), key=lambda kv: -len(kv[1]))[:6]
        facts.append(ProfileFact(
            id="habits.shops_at", value=[m for m, _ in ranked], source=source, confidence=0.6, status="unconfirmed",
            note="Orders seen: " + ", ".join(f"{m} {len(r)}" for m, r in ranked)))

    dates: dict[str, set[str]] = defaultdict(set)
    for p in active:
        if p.kind in HABIT_KINDS and p.order_date:
            dates[p.category].add(p.order_date)
    repeats = []
    for cat, ds in sorted(dates.items()):
        if len(ds) < 3:
            continue
        d = sorted(date.fromisoformat(x) for x in ds)
        gap = statistics.median((b - a).days for a, b in zip(d, d[1:]))
        repeats.append(f"{cat}: about every {round(gap)} days ({len(d)} orders, last {d[-1].isoformat()})")
    if repeats:
        facts.append(ProfileFact(id="habits.repeat_purchases", value=repeats, source=source, confidence=0.6,
                                 status="unconfirmed", note="Computed from imported purchase dates"))
    return facts


def with_imports(profile: EnvironmentProfile, store: Store) -> EnvironmentProfile:
    """The profile as the pipeline sees it: environment.yaml plus imported inventory and habits."""
    purchases = store.purchases(profile.user_id)
    if not purchases:
        return profile
    existing, new = owned_from_purchases(purchases, profile.owned_products)
    have_ids = {p.id for p in existing}
    owned = existing + [p for p in new if p.id not in have_ids]
    yaml_ids = {f.id for f in profile.facts}
    facts = profile.facts + [f for f in habit_facts(purchases) if f.id not in yaml_ids]
    return profile.model_copy(update={"facts": facts, "owned_products": owned,
                                      "version": profile_version(facts, owned)})
