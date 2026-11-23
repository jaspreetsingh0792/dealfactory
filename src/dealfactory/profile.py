"""Load private/environment.yaml into an EnvironmentProfile.

YAML is meant to be hand-edited, so any leaf can be written two ways:

    home:
      size_m2: 72                      # plain value -> stated, confirmed, confidence 1
      floor_types:
        value: [laminate, tiles]
        source: inferred               # stated | email | receipt | inferred | example
        confidence: 0.6
        status: unconfirmed            # confirmed | unconfirmed | rejected
        note: "guessed from the vacuum need"
        private: true                  # never shown on the public site

Nested sections become dotted fact ids: `home.floor_types`.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import yaml

from .models import EnvironmentProfile, OwnedProduct, ProfileFact, now_utc

LEAF_KEYS = {"value", "source", "confidence", "status", "note", "private"}
# Facts that are private by default even when not marked.
DEFAULT_PRIVATE_PREFIXES = ("location.postcode", "location.address", "location.street", "household.names")


def _is_leaf(node: Any) -> bool:
    return isinstance(node, dict) and "value" in node and set(node) <= LEAF_KEYS


def _with_defaults(d: dict) -> dict:
    """Example/inferred values default to low confidence and unconfirmed."""
    d = dict(d)
    src = d.get("source", "stated")
    if src in ("example", "inferred"):
        d.setdefault("status", "unconfirmed")
        d.setdefault("confidence", 0.0 if src == "example" else 0.5)
    return d


def _walk(node: Any, prefix: str, out: list[ProfileFact]) -> None:
    if _is_leaf(node):
        out.append(ProfileFact(id=prefix, **_with_defaults(node)))
        return
    if isinstance(node, dict):
        for key, child in node.items():
            _walk(child, f"{prefix}.{key}" if prefix else str(key), out)
        return
    if isinstance(node, list):
        node = [str(x) for x in node]
    out.append(ProfileFact(id=prefix, value=node))


def load_profile(path: Path, user_id: str = "me") -> EnvironmentProfile:
    if not path.exists():
        raise SystemExit(
            f"No profile at {path}. Copy examples/environment.example.yaml to private/environment.yaml and edit it."
        )
    raw = yaml.safe_load(path.read_text()) or {}
    owned_raw = raw.pop("owned_products", []) or []
    raw.pop("user_id", None)
    facts: list[ProfileFact] = []
    _walk(raw, "", facts)
    for f in facts:
        if f.id.startswith(DEFAULT_PRIVATE_PREFIXES):
            f.private = True
    owned = [OwnedProduct(user_id=user_id, **_with_defaults(p)) for p in owned_raw]
    return EnvironmentProfile(user_id=user_id, version=profile_version(facts, owned), loaded_at=now_utc(),
                              facts=facts, owned_products=owned)


def profile_version(facts: list[ProfileFact], owned: list[OwnedProduct]) -> str:
    return hashlib.sha256(
        json.dumps(
            {"f": [f.model_dump() for f in facts], "o": [p.model_dump() for p in owned]},
            sort_keys=True, default=str,
        ).encode()
    ).hexdigest()[:12]


def profile_for_prompt(profile: EnvironmentProfile) -> str:
    """Compact, model-readable profile. Rejected facts are left out; unconfirmed ones are labelled."""
    lines = ["PROFILE FACTS (id = value [source, confidence, status])"]
    for f in profile.usable_facts():
        val = ", ".join(f.value) if isinstance(f.value, list) else f.value
        tag = f"{f.source}, {f.confidence:.1f}, {f.status}"
        lines.append(f"- {f.id} = {val} [{tag}]" + (f"  note: {f.note}" if f.note else ""))
    lines.append("\nOWNED PRODUCTS (id: brand model variant ...)")
    for p in profile.owned_products:
        if p.status == "rejected":
            continue
        bits = [p.brand, p.model, p.variant or ""]
        extra = []
        if p.year:
            extra.append(f"year {p.year}")
        if p.room:
            extra.append(f"room {p.room}")
        if p.aliases:
            extra.append("called: " + "; ".join(p.aliases))
        if p.notes:
            extra.append(p.notes)
        lines.append(
            f"- {p.id}: [{p.category}] {' '.join(b for b in bits if b)}"
            + (f" ({'; '.join(extra)})" if extra else "")
            + f" [{p.source}, {p.confidence:.1f}, {p.status}]"
        )
    return "\n".join(lines)


def known_ref_ids(profile: EnvironmentProfile) -> set[str]:
    return {f.id for f in profile.facts} | {p.id for p in profile.owned_products}


def public_profile_view(profile: EnvironmentProfile) -> EnvironmentProfile:
    """Copy without private facts - for anything that could end up on a public page."""
    return profile.model_copy(update={"facts": [f for f in profile.facts if not f.private]})
