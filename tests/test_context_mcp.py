"""Shopping Context export + MCP server (offline)."""

from __future__ import annotations

import asyncio
import json
import shutil
from pathlib import Path

import yaml

from dealfactory.config import load_settings
from dealfactory.context import ShoppingContext, export_context
from dealfactory.mcp_server import ContextSource, build_server
from dealfactory.pipeline import load_needs
from dealfactory.profile import load_profile

REPO = Path(__file__).resolve().parents[1]


def _project(tmp_path: Path) -> Path:
    shutil.copy(REPO / "config.yaml", tmp_path / "config.yaml")
    (tmp_path / "private").mkdir()
    shutil.copy(REPO / "tests" / "fixtures" / "environment.yaml", tmp_path / "private" / "environment.yaml")
    (tmp_path / "private" / "needs.yaml").write_text(yaml.safe_dump({"needs": [{"id": "robot-vacuum", "text": "robot vacuum", "budget_max": 600}]}))
    return tmp_path


def _result(res) -> object:
    sc = getattr(res, "structuredContent", None) or getattr(res, "structured_content", None)
    if sc is not None:
        return sc.get("result", sc) if isinstance(sc, dict) else sc
    return json.loads(res.content[0].text)


def test_export_leaves_out_private_example_and_rejected(tmp_path: Path):
    s = load_settings(_project(tmp_path))
    ctx = export_context(load_profile(s.profile_path), load_needs(s.needs_path))
    ids = {f.id for f in ctx.facts}
    assert "location.postcode_area" not in ids and "location.city" not in ids  # private / example
    assert not any(f.source == "example" for f in ctx.facts)
    assert ctx.location.country == "NL" and ctx.location.currency == "EUR"
    owned = {o.id: o for o in ctx.owned}
    assert set(owned) == {"stroller-cybex-balios-s-lux", "tv-tcl"}
    assert owned["tv-tcl"].status == "unconfirmed" and owned["tv-tcl"].source == "inferred"  # labelled, not hidden
    assert ctx.needs[0].budget_max == 600 and ctx.needs[0].currency == "EUR"
    ShoppingContext.model_validate_json(ctx.model_dump_json())                 # round-trips
    schema = json.loads((REPO / "spec" / "shopping-context.v1.schema.json").read_text())
    assert schema["properties"]["format"]["const"] == "shopping-context"


def test_mcp_tools_on_context_file(tmp_path: Path):
    s = load_settings(_project(tmp_path))
    path = tmp_path / "shopping-context.json"
    path.write_text(export_context(load_profile(s.profile_path), load_needs(s.needs_path)).model_dump_json())
    server = build_server(ContextSource(None, path))

    async def go():
        tools = {t.name: t for t in await server.list_tools()}
        assert set(tools) == {"get_shopping_context", "find_owned", "list_needs", "add_need"}
        assert tools["get_shopping_context"].annotations.read_only_hint is True
        ctx = _result(await server.call_tool("get_shopping_context", {}))
        assert "Never invent" in ctx["guide"] and ctx["context"]["location"]["country"] == "NL"
        found = _result(await server.call_tool("find_owned", {"query": "my buggy"}))
        assert [o["id"] for o in found] == ["stroller-cybex-balios-s-lux"]
        assert _result(await server.call_tool("find_owned", {"query": "dishwasher"})) == []
        saved = _result(await server.call_tool("add_need", {"text": "Robot vacuum", "budget_max": 400}))
        assert saved["saved"]["id"] == "robot-vacuum-2"
        needs = _result(await server.call_tool("list_needs", {"status": "all"}))
        assert [n["id"] for n in needs] == ["robot-vacuum", "robot-vacuum-2"]

    asyncio.run(go())
    assert len(ShoppingContext.model_validate_json(path.read_text()).needs) == 2


def test_mcp_add_need_appends_to_private_needs(tmp_path: Path):
    s = load_settings(_project(tmp_path))
    server = build_server(ContextSource(s, None))
    asyncio.run(server.call_tool("add_need", {"text": "winter footmuff", "notes": "for walks"}))
    needs = load_needs(s.needs_path)
    assert [n.id for n in needs] == ["robot-vacuum", "winter-footmuff"] and needs[1].notes == "for walks"
