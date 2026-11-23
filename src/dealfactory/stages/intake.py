"""INTAKE: free text -> structured Need, resolving 'my stroller' against the profile."""

from __future__ import annotations

from ..models import Money, Need, NeedDraft, ResolvedReference, now_utc
from ..pipeline import RunContext
from ..profile import known_ref_ids, profile_for_prompt
from ._common import slugify

SYSTEM = """You are the intake step of DealFactory, a personal shopping advisor. You turn one shopping
request into a structured need. Resolve references to the user's own things ("my stroller",
"the living room", "our dog") against the PROFILE, using only ids that appear there. If a reference
cannot be matched, mark it unresolved. Do not invent facts about the user; list anything that would
change the recommendation and is missing from the profile as an open question."""


def run(ctx: RunContext) -> Need:
    spec = ctx.need_spec
    extras = []
    if spec.budget_max:
        extras.append(f"Budget max: {spec.budget_max} {ctx.currency}")
    if spec.deadline:
        extras.append(f"Deadline: {spec.deadline}")
    if spec.notes:
        extras.append(f"Notes: {spec.notes}")
    prompt = (
        f"{profile_for_prompt(ctx.profile)}\n\nREQUEST: {spec.text}\n" + "\n".join(extras)
        + f"\n\nWrite search_query in the user's language ({ctx.language})."
    )
    draft = ctx.llm.structured("intake", SYSTEM, prompt, NeedDraft, effort=ctx.effort("intake"))

    valid = known_ref_ids(ctx.profile)
    fixed = []
    for ref in draft.resolved_references:
        if ref.kind != "unresolved" and ref.ref_id not in valid:
            ref = ResolvedReference(phrase=ref.phrase, kind="unresolved", ref_id=None,
                                    explanation=f"(model proposed unknown id {ref.ref_id!r}) {ref.explanation}")
        fixed.append(ref)
    draft.resolved_references = fixed
    draft.must_work_with = [x for x in draft.must_work_with if x in valid]
    draft.category = slugify(draft.category) or slugify(spec.id)

    retailers = spec.retailers or ctx.settings.default_retailers
    need = Need(
        id=spec.id, user_id=ctx.settings.user_id, text=spec.text, status=spec.status,
        budget_max=Money(amount=spec.budget_max, currency=ctx.currency) if spec.budget_max else None,
        target_price=Money(amount=spec.target_price, currency=ctx.currency) if spec.target_price else None,
        deadline=spec.deadline, notes=spec.notes, retailers=retailers, parsed=draft,
        profile_version=ctx.profile.version, created_at=now_utc(),
    )
    ctx.write("intake", need)
    ctx.store.upsert_need(need)
    return need
