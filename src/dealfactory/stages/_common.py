"""Helpers shared by stages: grounding rules, slugging, value checks."""

from __future__ import annotations

import re
import unicodedata

from ..llm import SourceRegistry, _norm
from ..models import SourcedValue

GROUNDING_RULES = """\
Ground rules (DealFactory):
- Never invent products, model numbers, specs, prices or links. If you did not see it on a page in this
  conversation, it is unknown.
- Report values exactly as the page states them, in the page's unit.
- Separate facts (with the page they came from) from your own judgement, and label judgement as such.
- Prefer manufacturer spec pages and independent expert reviews (e.g. Tweakers, Consumentenbond, RTINGS,
  Which?, Kieskeurig reviews) over marketing copy and affiliate listicles.
"""

CITE_RULES = """\
Cite only source ids from the SOURCES list (S1, S2, ...). Never write URLs. If a value or claim is not
supported by one of those sources, set the value to null and the source id to null (or an empty list).
Quotes must be short verbatim snippets copied from the cited page."""


def slugify(*parts: str | None) -> str:
    text = " ".join(p for p in parts if p)
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:80]


NUM = re.compile(r"\d+(?:[.,]\d+)?")


def value_in_quote(value: str, quote: str) -> bool:
    """Numbers in the value must appear in the quote; for text values, accept any word overlap."""
    nums = NUM.findall(value)
    q = _norm(quote)
    if nums:
        qn = {n.replace(",", ".") for n in NUM.findall(q)}
        return all(n.replace(",", ".") in qn for n in nums)
    words = [w for w in re.findall(r"\w+", _norm(value)) if len(w) > 2]
    return not words or any(w in q for w in words)


def ground_value(registry: SourceRegistry, value: str | None, unit: str | None,
                 source_id: str | None, quote: str | None) -> SourcedValue:
    """Turn an LLM-claimed value into a SourcedValue, or `unknown` if it can't be grounded."""
    unknown = SourcedValue(value=None, unit=unit, status="unknown")
    if value is None or str(value).strip() == "":
        return unknown
    src = registry.get(source_id)
    if src is None:
        return unknown
    value = str(value).strip()
    base = dict(value=value, unit=unit, status="known", source_url=src.url,
                retrieved_at=src.retrieved_at, quote=quote)
    if registry.has_page_text(src.id):
        if quote and registry.quote_on_page(src.id, quote) and value_in_quote(value, quote):
            return SourcedValue(**base, verification="quote_verified")
        # We have the page and the claim is not on it: treat as unknown.
        return unknown
    # Only a search hit (no page text to check against): keep, flagged as weaker evidence.
    return SourcedValue(**base, verification="cited")


def urls_for(registry: SourceRegistry, ids: list[str]) -> list[str]:
    out = []
    for sid in ids:
        s = registry.get(sid)
        if s and s.url not in out:
            out.append(s.url)
    return out
