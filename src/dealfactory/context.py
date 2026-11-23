"""Shopping Context v1: the open, portable format for "what I have and what I want to buy".

One JSON document that any assistant or tool can read: location (country/city only), facts about the
home and household with provenance, owned products, and needs. The DealFactory web app, the CLI
(`dealfactory context export`) and the MCP server (`dealfactory mcp`) all speak it.
Spec: spec/shopping-context.md; schema: spec/shopping-context.v1.schema.json (generated from these models).
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from .models import EnvironmentProfile, FactStatus, NeedSpec, Provenance, now_utc


class _Strict(BaseModel):
    model_config = ConfigDict(extra="ignore")


class CtxLocation(_Strict):
    country: str | None = Field(None, description="ISO 3166-1 alpha-2, e.g. NL")
    city: str | None = None
    region: str | None = None
    currency: str | None = Field(None, description="ISO 4217, e.g. EUR")
    language: str | None = Field(None, description="BCP 47, e.g. nl")


class CtxFact(_Strict):
    id: str = Field(description="Dotted path, e.g. home.floor_types, ecosystems.smart_home, household.pets")
    value: str | int | float | bool | list[str] | None
    source: Provenance = "stated"
    confidence: float | None = Field(None, ge=0, le=1)
    status: FactStatus = "confirmed"
    note: str | None = None


class CtxOwned(_Strict):
    id: str
    category: str
    brand: str
    model: str
    variant: str | None = None
    year: int | None = None
    room: str | None = None
    aliases: list[str] = Field(default_factory=list)
    purchase_date: str | None = None
    notes: str | None = None
    source: Provenance = "stated"
    status: FactStatus = "confirmed"
    confidence: float | None = Field(None, ge=0, le=1)


class CtxNeed(_Strict):
    id: str
    text: str = Field(description='In the user\'s words, e.g. "fleece footmuff for my stroller"')
    status: Literal["active", "paused", "closed"] = "active"
    budget_max: float | None = None
    currency: str | None = None
    deadline: str | None = None
    notes: str | None = None


class ShoppingContext(_Strict):
    format: Literal["shopping-context"] = "shopping-context"
    version: Literal[1] = 1
    updated_at: str
    generator: str | None = Field(None, description="Tool that wrote this document")
    location: CtxLocation = Field(default_factory=CtxLocation)
    facts: list[CtxFact] = Field(default_factory=list)
    owned: list[CtxOwned] = Field(default_factory=list)
    needs: list[CtxNeed] = Field(default_factory=list)


LOCATION_KEYS = {"location.country": "country", "location.city": "city", "location.region": "region",
                 "location.currency": "currency", "location.language": "language"}


def export_context(profile: EnvironmentProfile, needs: list[NeedSpec], include_private: bool = False) -> ShoppingContext:
    """Profile (incl. imported inventory) -> Shopping Context. Private and rejected facts are left out."""
    loc: dict[str, str] = {}
    facts: list[CtxFact] = []
    for f in profile.facts:
        if f.status == "rejected" or (f.private and not include_private):
            continue
        if f.id in LOCATION_KEYS and isinstance(f.value, str):
            if f.source != "example":
                loc[LOCATION_KEYS[f.id]] = f.value
            continue
        if f.source == "example":
            continue  # placeholders are not facts
        facts.append(CtxFact(id=f.id, value=f.value, source=f.source, confidence=f.confidence, status=f.status,
                             note=f.note))
    owned = [CtxOwned(id=p.id, category=p.category, brand=p.brand, model=p.model, variant=p.variant, year=p.year,
                      room=p.room, aliases=p.aliases, purchase_date=p.purchase_date, notes=p.notes,
                      source=p.source, status=p.status, confidence=p.confidence)
             for p in profile.owned_products if p.status != "rejected" and p.source != "example"]
    cur = loc.get("currency")
    ctx_needs = [CtxNeed(id=n.id, text=n.text, status=n.status, budget_max=n.budget_max,
                         currency=cur if n.budget_max else None, deadline=n.deadline, notes=n.notes) for n in needs]
    return ShoppingContext(updated_at=now_utc().isoformat(), generator="dealfactory-cli",
                           location=CtxLocation(**loc), facts=facts, owned=owned, needs=ctx_needs)


GUIDE = """\
How to use this shopping context (for AI assistants):
- Recommend products that work with what the user already owns (`owned`) and fit their home and
  household (`facts`). Say explicitly which owned item a product is compatible with, and how you know.
- Facts with status `unconfirmed` or source `inferred` may be wrong: use them, but say so.
- Never invent products, specs, prices or links. Every price and spec needs a source page you actually
  read, with the date. If you could not verify something, say "unknown".
- Keep sourced facts separate from your own judgement, and label the judgement.
- Search shops that deliver to `location` and quote prices in the local currency.
"""
