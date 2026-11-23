"""CANDIDATES: shortlist current models sold in the user's country, then gather sourced specs."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

from ..llm import SourceRegistry
from ..models import (
    Candidate, CandidateSpecsDraft, CategoryResearch, Need, ReviewNote, ShortlistDraft, SourcedValue,
)
from ..pipeline import RunContext
from ._common import CITE_RULES, GROUNDING_RULES, ground_value, slugify, urls_for

SHORTLIST_SYSTEM = """You build a shortlist of products for one shopper in {country}. Use web_search and
web_fetch. Only include models that are currently sold new in {country} - confirm each on a {country}
retailer or the brand's {country} site - and that exist as exact, named models (brand + model, and the
variant/colour when it matters). Cover budget, mid and premium options when they exist.
{rules}
Write notes listing each model, why it is a reasonable fit for THIS request, and the URLs that show it
is sold in {country}."""

SHORTLIST_STRUCT = """Extract the shortlist from the notes. At most {n} candidates, best fits first, no
duplicates of the same model. availability_source_ids must point to pages that show the model on sale
in {country}. {cite}"""

SPECS_SYSTEM = """You collect specifications for one exact product for DealFactory. Use web_fetch on the
manufacturer's product or spec page, and web_search + web_fetch for one or two independent expert
reviews or tests. Report each requested value exactly as a page states it, with the URL, and copy the
sentence or table cell it appears in. Also note concrete strengths and weaknesses that reviewers report.
{rules}"""

SPECS_STRUCT = """Extract the requested specs for the product from the notes. Return one entry per
requested feature_key (use the keys exactly). value is null when no source states it. The quote must be
copied verbatim from the cited source and contain the value. Review notes need a source id. {cite}"""


def _context_lines(ctx: RunContext, need: Need) -> str:
    ids = set(need.parsed.must_work_with) | {r.ref_id for r in need.parsed.resolved_references if r.ref_id}
    lines = []
    for p in ctx.profile.owned_products:
        if p.id in ids:
            lines.append(f"- must work with: {p.brand} {p.model} {p.variant or ''} ({p.category})".rstrip())
    for f in ctx.profile.facts:
        if f.id in ids:
            lines.append(f"- {f.id} = {f.value}")
    return "\n".join(lines) or "- (no specific owned products referenced)"


def _shortlist(ctx: RunContext, need: Need, research: CategoryResearch) -> tuple[ShortlistDraft, SourceRegistry]:
    reg = SourceRegistry()
    domains = ", ".join(need.retailers)
    system = SHORTLIST_SYSTEM.format(country=ctx.country, rules=GROUNDING_RULES)
    budget = f"{need.budget_max.amount} {need.budget_max.currency}" if need.budget_max else "not set"
    prompt = (
        f"Request: {need.text}\nCategory: {need.parsed.category_label}\n"
        f"Requirements: {'; '.join(need.parsed.requirements)}\n{_context_lines(ctx, need)}\n"
        f"Budget max: {budget}\nUseful retailers to check: {domains}\n"
        f"What matters in this category: {', '.join(f.label for f in research.features)}\n"
        f"Find up to {ctx.settings.max_candidates + 2} candidates."
    )
    notes = ctx.llm.research("candidates.shortlist", system, prompt, reg, effort=ctx.effort("candidates"))
    draft = ctx.llm.structured(
        "candidates.shortlist.structure",
        SHORTLIST_STRUCT.format(n=ctx.settings.max_candidates, country=ctx.country, cite=CITE_RULES),
        f"SOURCES:\n{reg.render()}\n\nNOTES:\n{notes}", ShortlistDraft, effort=ctx.effort("structure"),
    )
    return draft, reg


def _specs(ctx: RunContext, cand: Candidate, research: CategoryResearch) -> Candidate:
    reg = SourceRegistry()
    wanted = "\n".join(f"- {f.key}: {f.label}" + (f" ({f.unit})" if f.unit else "") for f in research.features)
    prompt = (
        f"Product: {cand.name}\n"
        + (f"Manufacturer page (fetch it): {cand.official_url}\n" if cand.official_url else "")
        + f"Requested features:\n{wanted}"
    )
    notes = ctx.llm.research(f"candidates.specs.{cand.id}", SPECS_SYSTEM.format(rules=GROUNDING_RULES),
                             prompt, reg, effort=ctx.effort("candidates"))
    draft = ctx.llm.structured(
        f"candidates.specs.{cand.id}.structure", SPECS_STRUCT.format(cite=CITE_RULES),
        f"PRODUCT: {cand.name}\nREQUESTED KEYS: {', '.join(f.key for f in research.features)}\n\n"
        f"SOURCES:\n{reg.render()}\n\nNOTES:\n{notes}",
        CandidateSpecsDraft, effort=ctx.effort("structure"),
    )
    keys = {f.key: f for f in research.features}
    specs: dict[str, SourcedValue] = {k: SourcedValue(value=None, unit=f.unit, status="unknown") for k, f in keys.items()}
    for s in draft.specs:
        if s.feature_key in keys:
            sv = ground_value(reg, s.value, s.unit or keys[s.feature_key].unit, s.source_id, s.quote)
            if sv.status == "known" or specs[s.feature_key].status == "unknown":
                specs[s.feature_key] = sv
    notes_out = []
    for n in draft.review_notes:
        src = reg.get(n.source_id)
        if src:
            notes_out.append(ReviewNote(text=n.text, sentiment=n.sentiment, source_url=src.url))
    return cand.model_copy(update={"specs": specs, "review_notes": notes_out,
                                   "sources": cand.sources + list(reg.sources.values())})


def run(ctx: RunContext) -> list[Candidate]:
    need = ctx.read("intake", Need)
    research = ctx.read("research", CategoryResearch)
    draft, reg = _shortlist(ctx, need, research)

    cands: list[Candidate] = []
    for item in draft.candidates:
        evidence = urls_for(reg, item.availability_source_ids)
        if not evidence:
            ctx.log(f"    dropped {item.brand} {item.model}: no source shows it on sale in {ctx.country}")
            continue
        cid = slugify(item.brand, item.model, item.variant)
        if any(c.id == cid for c in cands):
            continue
        official = reg.get(item.official_page_source_id)
        cands.append(Candidate(
            id=cid, brand=item.brand, model=item.model, variant=item.variant,
            why_shortlisted=item.why_shortlisted, official_url=official.url if official else None,
            availability_evidence=evidence,
            sources=[s for s in reg.sources.values() if s.url in evidence or (official and s.url == official.url)],
        ))
        if len(cands) >= ctx.settings.max_candidates:
            break
    if not cands:
        raise RuntimeError("No candidates could be verified as on sale; see llm_log.jsonl")

    with ThreadPoolExecutor(max_workers=3) as pool:
        cands = list(pool.map(lambda c: _specs(ctx, c, research), cands))
    ctx.write("candidates", cands)
    return cands
