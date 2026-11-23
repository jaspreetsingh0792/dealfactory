"""ENVIRONMENT FIT: score each candidate against the user's profile. Judgement, tied to fact ids."""

from __future__ import annotations

from ..models import Candidate, CategoryResearch, FitAssessment, FitDraft, Need
from ..pipeline import RunContext
from ..profile import known_ref_ids, profile_for_prompt

SYSTEM = """You judge how well each candidate product fits ONE specific household, for DealFactory.
Score each relevant dimension 0-10: compatibility (with owned products and ecosystems), physical_fit
(size, space, mounting, floor types, stairs), household (children, pets, accessibility), climate,
brand_and_price_habits (stated and learned preferences, budget), requirements (from the request).
Skip dimensions that don't apply. Every judgement must name the profile fact / owned product ids and the
spec keys it relies on. Treat a spec marked UNKNOWN as unknown - say what is uncertain instead of
assuming. A dealbreaker is something that makes the product unusable or clearly wrong for this household
(e.g. incompatible with the stroller they own, over the hard budget); list it only if supported by the
specs or clearly implied by the product type. Unconfirmed profile facts may be used, but say so."""


def candidate_block(c: Candidate, research: CategoryResearch) -> str:
    lines = [f"## {c.id}: {c.name}", f"why shortlisted: {c.why_shortlisted}"]
    for f in research.features:
        v = c.specs.get(f.key)
        if v and v.status == "known":
            lines.append(f"- {f.key}: {v.value}{' ' + v.unit if v.unit and v.unit not in v.value else ''}")
        else:
            lines.append(f"- {f.key}: UNKNOWN")
    for n in c.review_notes[:6]:
        lines.append(f"- review ({n.sentiment}): {n.text}")
    return "\n".join(lines)


def run(ctx: RunContext) -> list[FitAssessment]:
    need = ctx.read("intake", Need)
    research = ctx.read("research", CategoryResearch)
    cands = ctx.read("candidates", list[Candidate])
    budget = f"{need.budget_max.amount} {need.budget_max.currency}" if need.budget_max else "none stated"
    prompt = (
        f"{profile_for_prompt(ctx.profile)}\n\nNEED: {need.text}\nBudget max: {budget}\n"
        f"Requirements: {'; '.join(need.parsed.requirements)}\nMust work with: {', '.join(need.parsed.must_work_with) or '-'}\n\n"
        "CANDIDATES (sourced specs):\n" + "\n\n".join(candidate_block(c, research) for c in cands)
        + "\n\nReturn one assessment per candidate_id."
    )
    draft = ctx.llm.structured("fit", SYSTEM, prompt, FitDraft, effort=ctx.effort("fit"))

    valid_refs = known_ref_ids(ctx.profile)
    keys = {f.key for f in research.features}
    ids = {c.id for c in cands}
    out: list[FitAssessment] = []
    for a in draft.assessments:
        if a.candidate_id not in ids:
            continue
        for d in a.dimensions:
            d.score = max(0, min(10, d.score))
            d.profile_fact_ids = [x for x in d.profile_fact_ids if x in valid_refs]
            d.spec_keys = [x for x in d.spec_keys if x in keys]
        for db in a.dealbreakers:
            db.profile_fact_ids = [x for x in db.profile_fact_ids if x in valid_refs]
            db.spec_keys = [x for x in db.spec_keys if x in keys]
        scores = [d.score for d in a.dimensions]
        overall = 0.0 if a.dealbreakers else (round(sum(scores) / len(scores) * 10, 1) if scores else 0.0)
        out.append(FitAssessment(**a.model_dump(), overall_score=overall))
    missing = ids - {a.candidate_id for a in out}
    for cid in missing:
        ctx.log(f"    fit: no assessment returned for {cid}")
    out.sort(key=lambda a: a.overall_score, reverse=True)
    ctx.write("fit", out)
    return out
