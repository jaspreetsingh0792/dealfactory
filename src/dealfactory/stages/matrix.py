"""FEATURE MATRIX: deterministic assembly of sourced specs. No LLM, no guessing."""

from __future__ import annotations

from ..models import Candidate, CategoryResearch, FeatureMatrix, MatrixCell, Need, now_utc
from ..pipeline import RunContext


def build(need_id: str, research: CategoryResearch, cands: list[Candidate]) -> FeatureMatrix:
    cells = []
    for c in cands:
        for f in research.features:
            v = c.specs.get(f.key)
            data = v.model_dump() if v else {"value": None, "unit": f.unit, "status": "unknown"}
            cells.append(MatrixCell(candidate_id=c.id, feature_key=f.key, **data))
    return FeatureMatrix(need_id=need_id, generated_at=now_utc(), features=research.features,
                         candidate_ids=[c.id for c in cands], cells=cells)


def run(ctx: RunContext) -> FeatureMatrix:
    need = ctx.read("intake", Need)
    m = build(need.id, ctx.read("research", CategoryResearch), ctx.read("candidates", list[Candidate]))
    ctx.write("matrix", m)
    return m
