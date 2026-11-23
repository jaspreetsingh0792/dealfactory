"""CATEGORY RESEARCH: what matters, pitfalls, price tiers. Cached per category + country."""

from __future__ import annotations

from datetime import timedelta

from ..llm import SourceRegistry
from ..models import CategoryResearch, CategoryResearchDraft, Feature, Need, Pitfall, PriceTier, now_utc
from ..pipeline import RunContext
from ._common import CITE_RULES, GROUNDING_RULES, slugify, urls_for

RESEARCH_SYSTEM = """You research a product category for a shopper in {country} so that later steps know
which features and specs really matter. Use web_search and web_fetch: open at least two independent
expert sources (buying guides or tests, e.g. Tweakers, Consumentenbond, RTINGS, Which?) and at least
one manufacturer spec page, so their text is in the conversation.

{rules}
Write plain notes with three headings: FEATURES THAT MATTER (with how to compare them and units),
PITFALLS, PRICE TIERS (typical {currency} prices in {country} today). After every fact, put the URL
you got it from in brackets."""

STRUCT_SYSTEM = """You convert research notes into structured category knowledge for DealFactory.
Feature keys must be snake_case and stable (e.g. suction_pa, runtime_minutes, noise_db, tog_rating,
harness_slots, washable). Pick 6-12 features that actually change which product is best, ordered by
importance; prefer features that can be checked on a spec sheet. {cite}"""


def cache_path(ctx: RunContext, category: str):
    return ctx.settings.cache_dir / "research" / f"{slugify(category)}-{ctx.country.lower()}.json"


def run(ctx: RunContext) -> CategoryResearch:
    need = ctx.read("intake", Need)
    path = cache_path(ctx, need.parsed.category)
    if path.exists() and not ctx.fresh_research:
        cached = CategoryResearch.model_validate_json(path.read_text())
        if now_utc() - cached.generated_at < timedelta(days=ctx.settings.research_cache_days):
            ctx.log(f"    research: cache hit ({path.name}, {cached.generated_at:%Y-%m-%d})")
            ctx.write("research", cached)
            return cached

    reg = SourceRegistry()
    system = RESEARCH_SYSTEM.format(country=ctx.country, currency=ctx.currency, rules=GROUNDING_RULES)
    prompt = (
        f"Category: {need.parsed.category_label}\n"
        f"Typical shopper request: {need.text}\n"
        "Research the category in general (not one specific product). Note anything about compatibility "
        "with other products the buyer may already own."
    )
    notes = ctx.llm.research("research", system, prompt, reg, effort=ctx.effort("research"))
    draft = ctx.llm.structured(
        "research.structure", STRUCT_SYSTEM.format(cite=CITE_RULES),
        f"SOURCES:\n{reg.render()}\n\nNOTES:\n{notes}", CategoryResearchDraft, effort=ctx.effort("structure"),
    )

    features = []
    seen = set()
    for f in draft.features:
        key = slugify(f.key).replace("-", "_")
        if not key or key in seen:
            continue
        seen.add(key)
        features.append(Feature(key=key, label=f.label, unit=f.unit, why_it_matters=f.why_it_matters,
                                sources=urls_for(reg, f.source_ids)))
    pitfalls = [Pitfall(text=p.text, sources=urls_for(reg, p.source_ids)) for p in draft.pitfalls]
    pitfalls = [p for p in pitfalls if p.sources]  # unsourced pitfalls are dropped
    tiers = []
    for t in draft.price_tiers:
        srcs = urls_for(reg, t.source_ids)
        tiers.append(PriceTier(tier=t.tier, min_price=t.min_price if srcs else None,
                               max_price=t.max_price if srcs else None, currency=t.currency,
                               typical=t.typical, sources=srcs))

    research = CategoryResearch(
        category=need.parsed.category, country=ctx.country, generated_at=now_utc(),
        features=features, pitfalls=pitfalls, price_tiers=tiers, sources=list(reg.sources.values()),
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(research.model_dump_json(indent=2))
    ctx.write("research", research)
    return research
