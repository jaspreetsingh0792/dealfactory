"""Offline end-to-end and unit tests. No network, no API key."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest
import yaml

from dealfactory.config import load_settings
from dealfactory.fetch import extract_jsonld_offer, price_in_text
from dealfactory.llm import SourceRegistry, harvest_sources
from dealfactory.models import Offer, Recommendation
from dealfactory.pipeline import load_needs, run_need
from dealfactory.profile import load_profile
from dealfactory.publish import build_site
from dealfactory.stages._common import ground_value
from dealfactory.store import Store

from .fake_claude import BOL, FakeAnthropic

REPO = Path(__file__).resolve().parents[1]


@pytest.fixture
def project(tmp_path: Path) -> Path:
    cfg = yaml.safe_load((REPO / "config.yaml").read_text())
    cfg["direct_fetch"] = False
    (tmp_path / "config.yaml").write_text(yaml.safe_dump(cfg))
    (tmp_path / "private").mkdir()
    shutil.copy(REPO / "tests" / "fixtures" / "environment.yaml", tmp_path / "private" / "environment.yaml")
    (tmp_path / "private" / "needs.yaml").write_text(yaml.safe_dump({"needs": [
        {"id": "stroller-footmuff", "text": "fleece footmuff for my Cybex Balios S Lux", "budget_max": 120,
         "retailers": ["babydump.nl", "bol.com", "amazon.nl"]},
        {"id": "robot-vacuum", "text": "robot vacuum for my apartment", "status": "paused"},
    ]}))
    return tmp_path


def test_full_pipeline_offline(project: Path, monkeypatch):
    monkeypatch.chdir(project)
    s = load_settings(project)
    store = Store(s.db_path)
    need = load_needs(s.needs_path)[0]
    fake = FakeAnthropic()
    run_dir = run_need(s, need, store, llm_client=fake)

    for stage in ["intake", "research", "candidates", "fit", "matrix", "offers", "recommendation"]:
        assert (run_dir / f"{stage}.json").exists(), stage
    intake = json.loads((run_dir / "intake.json").read_text())
    refs = {r["phrase"]: r for r in intake["parsed"]["resolved_references"]}
    assert refs["my Cybex Balios S Lux"]["ref_id"] == "stroller-cybex-balios-s-lux"
    assert refs["the car"]["kind"] == "unresolved"  # unknown id rejected
    assert intake["parsed"]["must_work_with"] == ["stroller-cybex-balios-s-lux"]
    assert intake["parsed"]["category"] == "stroller-footmuff"

    research = json.loads((run_dir / "research.json").read_text())
    assert [f["key"] for f in research["features"]] == ["tog_rating", "harness_slots", "washable"]
    assert research["features"][2]["sources"] == []  # S99 does not exist
    assert [p["text"] for p in research["pitfalls"]] == ["Cheap models pill"]  # unsourced dropped
    premium = next(t for t in research["price_tiers"] if t["tier"] == "premium")
    assert premium["min_price"] is None  # unsourced numbers dropped

    cands = json.loads((run_dir / "candidates.json").read_text())
    assert [c["id"] for c in cands] == ["acme-footmuff-x"]  # Ghost had no real availability source
    specs = cands[0]["specs"]
    assert specs["tog_rating"]["status"] == "known" and specs["tog_rating"]["verification"] == "quote_verified"
    assert specs["harness_slots"]["status"] == "unknown"  # quote not on the page
    assert specs["washable"]["status"] == "unknown"  # unknown source id
    assert len(cands[0]["review_notes"]) == 1

    fit = json.loads((run_dir / "fit.json").read_text())[0]
    assert fit["dimensions"][1]["score"] == 10  # clamped
    assert fit["dimensions"][0]["profile_fact_ids"] == ["stroller-cybex-balios-s-lux"]
    assert fit["overall_score"] == 90.0

    offers = [Offer.model_validate(o) for o in json.loads((run_dir / "offers.json").read_text())]
    assert len(offers) == 1  # amazon.nl offer pointed at a non-amazon page
    o = offers[0]
    assert o.retailer == "bol.com" and o.url == BOL
    assert o.price_amount == 89.99 and o.price.verification == "quote_verified"
    assert o.in_stock.value == "yes"

    rec = Recommendation.model_validate_json((run_dir / "recommendation.json").read_text())
    assert [p.role for p in rec.picks] == ["top", "if_you_care"]  # ghost pick dropped
    assert any("€50" in w for w in rec.warnings)  # price not backed by an offer
    assert not any("89.99" in w for w in rec.warnings)

    log = (run_dir / "llm_log.jsonl").read_text().splitlines()
    assert len(log) == len(fake.beta.messages.calls)
    first = json.loads(log[0])
    assert first["request"]["system"] and first["response"]["content"]
    for call in fake.beta.messages.calls:
        assert call["fallbacks"] == "default" and call["model"] == "claude-opus-5-5"
    offer_call = next(c for c in fake.beta.messages.calls if c["kind"] == "stream" and "Search ONLY" in c["system"])
    assert offer_call["tools"][0]["allowed_domains"] == ["babydump.nl", "bol.com", "amazon.nl"]

    # Re-run one stage on the same run
    run_need(s, need, store, only="matrix", llm_client=fake)
    assert (s.runs_dir / need.id / "LATEST").read_text() == run_dir.name

    # Site: private build has the environment page, public build does not
    out = build_site(s, store)
    assert (out / "private" / "environment.html").exists()
    page = (out / "needs" / "stroller-footmuff.html").read_text()
    assert "Acme Footmuff X" in page and "€89,99" in page and "unknown" in page
    assert "llm_log.jsonl" in page
    env_page = (out / "private" / "environment.html").read_text()
    assert "postcode_area" in env_page

    out = build_site(s, store, public=True)
    assert not (out / "private").exists()
    page = (out / "needs" / "stroller-footmuff.html").read_text()
    assert "llm_log.jsonl" not in page and "postcode" not in page
    assert "Not run yet" in (out / "index.html").read_text()  # paused vacuum need
    store.close()


def test_research_cache_hit(project: Path, monkeypatch):
    monkeypatch.chdir(project)
    s = load_settings(project)
    store = Store(s.db_path)
    need = load_needs(s.needs_path)[0]
    run_need(s, need, store, llm_client=FakeAnthropic())
    fake2 = FakeAnthropic()
    run_need(s, need, store, llm_client=fake2)
    research_calls = [c for c in fake2.beta.messages.calls if "research a product category" in c["system"]]
    assert research_calls == []
    assert len(store.price_history(s.user_id, need.id)) == 2


def test_profile_provenance_defaults():
    p = load_profile(REPO / "tests" / "fixtures" / "environment.yaml")
    f = p.fact("home.size_m2")
    assert f.source == "example" and f.status == "unconfirmed" and f.confidence == 0
    assert p.fact("location.postcode_area").private
    assert p.fact("location.country").status == "confirmed"
    tv = next(x for x in p.owned_products if x.id == "tv-tcl")
    assert tv.status == "unconfirmed"


@pytest.mark.parametrize("price,text,ok", [
    (89.99, "Prijs € 89,99", True), (1299.0, "€ 1.299,-", True), (299.0, "299,-", True),
    (1299.0, "EUR 1,299.00", True), (89.99, "€ 99,99", False), (89.99, None, False),
])
def test_price_in_text(price, text, ok):
    assert price_in_text(price, text) is ok


def test_jsonld_offer():
    html = """<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product",
      "name":"Robo 9","offers":{"@type":"Offer","price":"449.00","priceCurrency":"EUR",
      "availability":"https://schema.org/InStock"}}</script>"""
    got = extract_jsonld_offer(html)
    assert got == {"name": "Robo 9", "price": 449.0, "currency": "EUR", "in_stock": True, "availability": "InStock"}
    assert extract_jsonld_offer("<html></html>") is None


def test_ground_value_rules():
    reg = SourceRegistry()
    harvest_sources([{"type": "web_fetch_result", "url": "https://a.example/p",
                      "content": {"type": "document", "source": {"type": "text", "data": "Suction: 5000 Pa"}}},
                     {"type": "web_search_result", "url": "https://b.example/q", "title": "B"}], reg)
    assert ground_value(reg, "5000", "Pa", "S1", "Suction: 5000 Pa").verification == "quote_verified"
    assert ground_value(reg, "6000", "Pa", "S1", "Suction: 5000 Pa").status == "unknown"  # value not in quote
    assert ground_value(reg, "5000", "Pa", "S1", "Suction 9000").status == "unknown"  # quote not on page
    assert ground_value(reg, "5000", "Pa", "S2", "x").verification == "cited"  # search hit only
    assert ground_value(reg, "5000", "Pa", "S9", "x").status == "unknown"
    assert ground_value(reg, None, "Pa", "S1", None).status == "unknown"
