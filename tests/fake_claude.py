"""A stand-in for anthropic.Anthropic used by the offline tests.

It returns canned web_search / web_fetch result blocks for three fictional pages
and canned structured drafts. Products are fictional ("Acme"), so nothing here
can leak into a real site. Some drafts deliberately break the rules (invented
quote, unknown source id, wrong retailer domain, price not on any offer) so the
tests can check that the code catches them.
"""

from __future__ import annotations

from dealfactory import models as m

GUIDE = "https://reviews.example/footmuff-guide"
ACME = "https://acme.example/footmuff-x"
BOL = "https://www.bol.com/nl/p/acme-footmuff-x/9300000001"

PAGES = {
    GUIDE: ("Footmuff buying guide", "A good footmuff has a TOG rating of 2.5 or more for Dutch winters. "
            "Check that the harness slots match your stroller. Cheap models pill after washing."),
    ACME: ("Acme Footmuff X", "Acme Footmuff X. TOG rating: 2.5. Harness slots: 5-point. Machine washable at 30 °C."),
    BOL: ("Acme Footmuff X | bol", "Acme Footmuff X voetenzak. Prijs € 89,99. Op voorraad. Gratis verzending. "
          "30 dagen bedenktijd."),
}


def _research_content() -> list[dict]:
    content: list[dict] = [
        {"type": "server_tool_use", "id": "srv_1", "name": "web_search", "input": {"query": "q"}},
        {"type": "web_search_tool_result", "tool_use_id": "srv_1", "content": [
            {"type": "web_search_result", "url": u, "title": t, "encrypted_content": "x"}
            for u, (t, _) in PAGES.items()
        ]},
    ]
    for i, (url, (title, text)) in enumerate(PAGES.items()):
        content.append({"type": "web_fetch_tool_result", "tool_use_id": f"srv_f{i}", "content": {
            "type": "web_fetch_result", "url": url, "retrieved_at": "2026-11-22T10:00:00Z",
            "content": {"type": "document", "title": title,
                        "source": {"type": "text", "media_type": "text/plain", "data": text}}}})
    content.append({"type": "text", "text": "Notes: see the pages above."})
    return content


# Source ids are assigned in harvest order: S1 = GUIDE, S2 = ACME, S3 = BOL.
DRAFTS = {
    m.NeedDraft: m.NeedDraft(
        category="Stroller Footmuff", category_label="Stroller footmuff", search_query="voetenzak cybex balios",
        resolved_references=[
            m.ResolvedReference(phrase="my Cybex Balios S Lux", kind="owned_product",
                                ref_id="stroller-cybex-balios-s-lux", explanation="owned stroller"),
            m.ResolvedReference(phrase="the car", kind="owned_product", ref_id="car-made-up", explanation="bogus"),
        ],
        requirements=["fleece lined", "fits a 5-point harness"],
        must_work_with=["stroller-cybex-balios-s-lux", "not-a-real-id"], open_questions=["child's age?"],
    ),
    m.CategoryResearchDraft: m.CategoryResearchDraft(
        features=[
            m.FeatureDraft(key="tog_rating", label="TOG rating", unit="TOG", why_it_matters="warmth", source_ids=["S1"]),
            m.FeatureDraft(key="harness slots", label="Harness slots", unit=None, why_it_matters="fit", source_ids=["S1"]),
            m.FeatureDraft(key="washable", label="Washable", unit=None, why_it_matters="hygiene", source_ids=["S99"]),
        ],
        pitfalls=[m.PitfallDraft(text="Cheap models pill", source_ids=["S1"]),
                  m.PitfallDraft(text="Unsourced claim", source_ids=[])],
        price_tiers=[m.PriceTierDraft(tier="mid", min_price=60, max_price=120, currency="EUR", typical="fleece", source_ids=["S1"]),
                     m.PriceTierDraft(tier="premium", min_price=150, max_price=250, currency="EUR", typical="down", source_ids=[])],
    ),
    m.ShortlistDraft: m.ShortlistDraft(candidates=[
        m.ShortlistItemDraft(brand="Acme", model="Footmuff X", variant=None, why_shortlisted="fits",
                             availability_source_ids=["S3"], official_page_source_id="S2"),
        m.ShortlistItemDraft(brand="Ghost", model="Phantom", variant=None, why_shortlisted="invented",
                             availability_source_ids=["S42"], official_page_source_id=None),
    ]),
    m.CandidateSpecsDraft: m.CandidateSpecsDraft(
        specs=[
            m.SpecDraft(feature_key="tog_rating", value="2.5", unit="TOG", source_id="S2", quote="TOG rating: 2.5"),
            m.SpecDraft(feature_key="harness_slots", value="5-point", unit=None, source_id="S2", quote="fits every stroller ever"),
            m.SpecDraft(feature_key="washable", value="yes", unit=None, source_id="S77", quote="washable"),
        ],
        review_notes=[m.ReviewNoteDraft(text="warm", sentiment="positive", source_id="S1"),
                      m.ReviewNoteDraft(text="made up", sentiment="negative", source_id="S50")],
    ),
    m.FitDraft: m.FitDraft(assessments=[m.CandidateFitDraft(
        candidate_id="acme-footmuff-x",
        dimensions=[m.FitDimensionDraft(dimension="compatibility", score=8, rationale="5-point harness",
                                        profile_fact_ids=["stroller-cybex-balios-s-lux", "bogus.fact"], spec_keys=["harness_slots"]),
                    m.FitDimensionDraft(dimension="climate", score=12, rationale="warm", profile_fact_ids=["location.climate"],
                                        spec_keys=["tog_rating"])],
        dealbreakers=[], cautions=["harness slot fit unverified"])]),
    m.OffersDraft: m.OffersDraft(offers=[
        m.OfferDraft(retailer="bol.com", page_source_id="S3", title_on_page="Acme Footmuff X", price=89.99,
                     price_quote="Prijs € 89,99", currency="EUR", in_stock=True, stock_quote="Op voorraad",
                     shipping="Gratis verzending", delivery=None, returns="30 dagen bedenktijd", pickup=None,
                     condition="new", matches_candidate=True),
        m.OfferDraft(retailer="amazon.nl", page_source_id="S2", title_on_page="wrong domain", price=10.0,
                     price_quote="€ 10", currency="EUR", in_stock=True, stock_quote=None, shipping=None, delivery=None,
                     returns=None, pickup=None, condition="new", matches_candidate=True),
    ]),
    m.RecommendationDraft: m.RecommendationDraft(
        summary="Acme Footmuff X is the pick.",
        picks=[
            m.PickDraft(role="top", care_about=None, candidate_id="acme-footmuff-x", offer_id="acme-footmuff-x-bol-com",
                        headline="Warm and fits", why_fits_you="Fits your Cybex Balios S Lux; €89,99 at bol.",
                        tradeoffs=["harness fit unverified"], would_change_if=["you want down fill"],
                        profile_fact_ids=["stroller-cybex-balios-s-lux"], spec_keys=["tog_rating"]),
            m.PickDraft(role="budget", care_about=None, candidate_id="ghost-phantom", offer_id=None, headline="x",
                        why_fits_you="x", tradeoffs=[], would_change_if=[], profile_fact_ids=[], spec_keys=[]),
            m.PickDraft(role="if_you_care", care_about="price", candidate_id="acme-footmuff-x", offer_id=None,
                        headline="cheap", why_fits_you="Often €50 on sale.", tradeoffs=[], would_change_if=[],
                        profile_fact_ids=[], spec_keys=[]),
        ],
        not_recommended=[], caveats=["check harness"],
    ),
}


class _Final:
    def __init__(self, content):
        self._d = {"id": "msg_fake", "type": "message", "role": "assistant", "content": content,
                   "stop_reason": "end_turn", "usage": {"input_tokens": 100, "output_tokens": 20,
                   "server_tool_use": {"web_search_requests": 1, "web_fetch_requests": 3}}}
        self._request_id = "req_fake"

    def to_dict(self):
        return self._d


class _Stream:
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def get_final_message(self):
        return _Final(_research_content())


class _Parsed(_Final):
    def __init__(self, obj):
        super().__init__([{"type": "text", "text": obj.model_dump_json()}])
        self.parsed_output = obj


class _Messages:
    def __init__(self):
        self.calls: list[dict] = []

    def stream(self, **kw):
        self.calls.append({"kind": "stream", **kw})
        return _Stream()

    def parse(self, **kw):
        self.calls.append({"kind": "parse", **kw})
        return _Parsed(DRAFTS[kw["output_format"]].model_copy(deep=True))


class _Beta:
    def __init__(self):
        self.messages = _Messages()


class FakeAnthropic:
    def __init__(self):
        self.beta = _Beta()
