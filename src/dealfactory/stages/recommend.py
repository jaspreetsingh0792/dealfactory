"""AI RECOMMENDATION: top / budget / premium / if-you-care picks, explained against the profile."""

from __future__ import annotations

import re

from ..models import (
    Candidate, CategoryResearch, FitAssessment, Need, Offer, Recommendation, RecommendationDraft, now_utc,
)
from ..pipeline import RunContext
from ..profile import known_ref_ids, profile_for_prompt
from .fit import candidate_block

SYSTEM = """You are DealFactory's advisor. Recommend products for ONE household using only the data
given: sourced specs, the fit assessments and the offers. Rules:
- Exactly one pick with role "top". Add one "budget" and one "premium" pick when they are genuinely
  different candidates, and one or two "if_you_care" picks (set care_about, e.g. "lowest noise").
- A candidate with a dealbreaker can never be the top pick.
- why_fits_you speaks to the user ("your Cybex Balios S Lux", "your laminate floors") and cites the profile
  ids it relies on in profile_fact_ids. Keep it to 2-4 sentences.
- Mention a price only if it appears in the OFFERS list; never estimate prices or specs. If a spec is
  UNKNOWN, say it is unknown when it matters.
- tradeoffs: honest downsides. would_change_if: concrete changes in the profile, budget or prices
  that would change the pick.
- If no candidate is a good fit, say so in the summary and still choose the least-bad top pick."""

EURO = re.compile(r"€\s?(\d[\d.,]*)|(\d[\d.,]*)\s?(?:euro|EUR)\b", re.I)


def _offer_lines(offers: list[Offer]) -> str:
    lines = []
    for o in offers:
        price = f"{o.price.value} {o.currency}" if o.price_amount is not None else "price unknown"
        stock = {"yes": "in stock", "no": "out of stock"}.get(o.in_stock.value or "", "stock unknown")
        lines.append(f"- {o.id}: {o.candidate_id} at {o.retailer}: {price}, {stock}")
    return "\n".join(lines) or "- (no offers found)"


def _fit_lines(fit: list[FitAssessment]) -> str:
    out = []
    for a in fit:
        dims = "; ".join(f"{d.dimension} {d.score}/10: {d.rationale}" for d in a.dimensions)
        dbs = "; ".join(d.text for d in a.dealbreakers) or "none"
        out.append(f"- {a.candidate_id}: overall {a.overall_score}/100. Dealbreakers: {dbs}. {dims}")
    return "\n".join(out)


def _to_float(s: str) -> float | None:
    s = s.strip().rstrip(".,")
    if "," in s:
        s = s.replace(".", "").replace(",", ".")
    try:
        return float(s)
    except ValueError:
        return None


def validate(draft: RecommendationDraft, cands: list[Candidate], offers: list[Offer],
             fit: list[FitAssessment], valid_refs: set[str], budget: float | None) -> tuple[RecommendationDraft, list[str]]:
    warnings: list[str] = []
    ids = {c.id for c in cands}
    offer_by_id = {o.id: o for o in offers}
    dealbroken = {a.candidate_id for a in fit if a.dealbreakers}
    picks = []
    for p in draft.picks:
        if p.candidate_id not in ids:
            warnings.append(f"Dropped a pick for unknown candidate {p.candidate_id!r}.")
            continue
        if p.offer_id and (p.offer_id not in offer_by_id or offer_by_id[p.offer_id].candidate_id != p.candidate_id):
            warnings.append(f"Pick {p.candidate_id}: offer {p.offer_id!r} did not belong to it; removed.")
            p.offer_id = None
        if p.role == "top" and p.candidate_id in dealbroken:
            warnings.append(f"Top pick {p.candidate_id} has a dealbreaker - review before buying.")
        p.profile_fact_ids = [x for x in p.profile_fact_ids if x in valid_refs]
        picks.append(p)
    tops = [p for p in picks if p.role == "top"]
    if len(tops) != 1:
        warnings.append(f"Expected exactly one top pick, got {len(tops)}.")
    # Any euro amount in the prose must match a known offer price or the budget.
    known = [o.price_amount for o in offers if o.price_amount is not None] + ([budget] if budget else [])
    for p in picks:
        text = " ".join([p.headline, p.why_fits_you, *p.tradeoffs, *p.would_change_if])
        for m in EURO.finditer(text):
            amt = _to_float(m.group(1) or m.group(2))
            if amt is not None and not any(abs(amt - k) <= 1.0 for k in known):
                warnings.append(f"Pick {p.candidate_id} mentions €{amt:g}, which is not a known offer price.")
    draft.picks = picks
    return draft, warnings


def run(ctx: RunContext) -> Recommendation:
    need = ctx.read("intake", Need)
    research = ctx.read("research", CategoryResearch)
    cands = ctx.read("candidates", list[Candidate])
    fit = ctx.read("fit", list[FitAssessment])
    offers = ctx.read("offers", list[Offer])
    budget = need.budget_max.amount if need.budget_max else None
    prompt = (
        f"{profile_for_prompt(ctx.profile)}\n\nNEED: {need.text}\nBudget max: {budget or 'none stated'}\n"
        f"Requirements: {'; '.join(need.parsed.requirements)}\n"
        f"Open questions from intake: {'; '.join(need.parsed.open_questions) or '-'}\n\n"
        f"CATEGORY PITFALLS:\n" + "\n".join(f"- {p.text}" for p in research.pitfalls)
        + "\n\nCANDIDATES:\n" + "\n\n".join(candidate_block(c, research) for c in cands)
        + f"\n\nFIT ASSESSMENTS:\n{_fit_lines(fit)}\n\nOFFERS:\n{_offer_lines(offers)}"
    )
    draft = ctx.llm.structured("recommend", SYSTEM, prompt, RecommendationDraft, effort=ctx.effort("recommend"))
    draft, warnings = validate(draft, cands, offers, fit, known_ref_ids(ctx.profile), budget)

    prev = ctx.store.previous_top_pick(ctx.settings.user_id, need.id, ctx.run_id)
    rec = Recommendation(
        need_id=need.id, user_id=ctx.settings.user_id, generated_at=now_utc(), profile_version=ctx.profile.version,
        run_id=ctx.run_id, summary=draft.summary, picks=draft.picks, not_recommended=draft.not_recommended,
        caveats=draft.caveats, warnings=warnings,
    )
    top = next((p.candidate_id for p in rec.picks if p.role == "top"), None)
    if prev and top and prev != top:
        rec.warnings.append(f"Top pick changed since the last run (was {prev}).")
    ctx.write("recommendation", rec)
    ctx.store.record_recommendation(rec)
    return rec
