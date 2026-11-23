"""MCP server: lets any MCP-capable assistant (Claude, ChatGPT, others) read your Shopping Context.

The assistant does its own searching; this server gives it what it can't know: what you own, your home,
your needs, and the ground rules (verify prices, say unknown, check compatibility with owned items).

    dealfactory mcp                               # uses private/environment.yaml + imports + private/needs.yaml
    dealfactory mcp --context shopping-context.json   # uses a file exported from the web app

Runs over stdio on your machine. Private facts (postcode, address) are never returned.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import yaml

from .context import GUIDE, CtxNeed, ShoppingContext, export_context
from .models import now_utc

INSTRUCTIONS = (
    "DealFactory holds the user's Shopping Context: where they live (country/city), what they own, facts "
    "about their home and household, and what they want to buy. Call get_shopping_context before giving "
    "any product or deal advice, and use find_owned to check compatibility with things they own.\n\n" + GUIDE
)


class ContextSource:
    """Either a shopping-context.json file, or the CLI's private profile."""

    def __init__(self, settings=None, context_path: Path | None = None):
        self.settings = settings
        self.path = context_path

    def load(self) -> ShoppingContext:
        if self.path:
            return ShoppingContext.model_validate_json(self.path.read_text())
        from .inventory import with_imports
        from .pipeline import load_needs
        from .profile import load_profile
        from .store import Store

        s = self.settings
        store = Store(s.db_path)
        try:
            profile = with_imports(load_profile(s.profile_path, s.user_id), store)
        finally:
            store.close()
        needs = load_needs(s.needs_path) if s.needs_path.exists() else []
        return export_context(profile, needs)

    def add_need(self, need: CtxNeed) -> None:
        if self.path:
            ctx = self.load()
            ctx.needs.append(need)
            ctx.updated_at = now_utc().isoformat()
            self.path.write_text(ctx.model_dump_json(indent=2, exclude_none=True))
            return
        path = self.settings.needs_path
        path.parent.mkdir(parents=True, exist_ok=True)
        if not path.exists():
            path.write_text("needs:\n")
        row = {k: v for k, v in need.model_dump().items() if v is not None and k != "currency"}
        block = yaml.safe_dump([row], sort_keys=False, allow_unicode=True)
        text = path.read_text()
        m = re.search(r"^( *)- ", text, re.M)  # match the file's existing list indentation (keeps comments)
        indent = m.group(1) if m else "  "
        sep = "" if text.endswith("\n") else "\n"
        path.write_text(text + sep + "".join(indent + ln + "\n" for ln in block.splitlines()))
        load = yaml.safe_load(path.read_text())
        if not any(n.get("id") == need.id for n in (load or {}).get("needs") or []):
            raise RuntimeError(f"Could not append to {path}; add the need by hand.")


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:50] or "need"


def build_server(source: ContextSource):
    from mcp.server.mcpserver import MCPServer
    from mcp.types import ToolAnnotations

    server = MCPServer("dealfactory", instructions=INSTRUCTIONS)
    ro = ToolAnnotations(readOnlyHint=True, openWorldHint=False)

    @server.tool(annotations=ro)
    def get_shopping_context() -> dict[str, Any]:
        """The user's full Shopping Context (location, facts with provenance, owned products, needs) plus
        the rules for giving advice. Call this first."""
        ctx = source.load()
        return {"guide": GUIDE, "context": json.loads(ctx.model_dump_json(exclude_none=True))}

    @server.tool(annotations=ro)
    def find_owned(query: str) -> list[dict[str, Any]]:
        """Owned products matching a word in category, brand, model or the user's own name for it
        (e.g. "stroller", "Cybex", "my buggy"). Use it to check compatibility before recommending."""
        words = [w for w in re.findall(r"\w+", query.lower()) if len(w) > 1 and w != "my"]
        out = []
        for p in source.load().owned:
            hay = " ".join([p.category, p.brand, p.model, p.variant or "", *p.aliases]).lower()
            if not words or any(w in hay for w in words):
                out.append(json.loads(p.model_dump_json(exclude_none=True)))
        return out

    @server.tool(annotations=ro)
    def list_needs(status: str = "active") -> list[dict[str, Any]]:
        """What the user wants to buy. status: active | paused | closed | all."""
        return [json.loads(n.model_dump_json(exclude_none=True)) for n in source.load().needs
                if status == "all" or n.status == status]

    @server.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False, openWorldHint=False))
    def add_need(text: str, budget_max: float | None = None, notes: str | None = None) -> dict[str, Any]:
        """Save something the user said they want to buy, in their own words, so DealFactory tracks it.
        Only call this when the user asks to save or track it."""
        ctx = source.load()
        base, n = _slug(text), 2
        nid = base
        while any(x.id == nid for x in ctx.needs):
            nid, n = f"{base}-{n}", n + 1
        need = CtxNeed(id=nid, text=text, budget_max=budget_max, notes=notes, currency=ctx.location.currency)
        source.add_need(need)
        return {"saved": json.loads(need.model_dump_json(exclude_none=True))}

    return server


def serve(settings, context_path: Path | None = None) -> None:
    build_server(ContextSource(settings, context_path)).run("stdio")
