"""Data models for every pipeline stage.

These Pydantic models are the single source of truth for the JSON schemas in
`schemas/` (regenerate with `dealfactory schemas`). Two families live here:

* Stored models (EnvironmentProfile, Need, Candidate, Offer, ...) - what each
  stage writes to disk and SQLite. Every factual value carries a source URL and
  a retrieved_at timestamp, or is explicitly `unknown`.
* LLM draft models (*Draft) - what Claude returns through structured outputs.
  Drafts cite sources by short id ("S3") from a list the code built from real
  web_search / web_fetch results, so Claude cannot invent a URL: the code maps
  ids back to URLs and drops anything that does not resolve.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal

from pydantic import BaseModel, Field


def now_utc() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


# ---------------------------------------------------------------------------
# Shared building blocks
# ---------------------------------------------------------------------------

Provenance = Literal["stated", "email", "receipt", "inferred", "example"]
FactStatus = Literal["confirmed", "unconfirmed", "rejected"]
ValueStatus = Literal["known", "unknown"]
Verification = Literal["quote_verified", "jsonld", "cited", "unverified"]


class Money(BaseModel):
    amount: float
    currency: str = "EUR"


class Source(BaseModel):
    """A web page Claude actually searched or fetched during a run."""

    id: str = Field(description="Short id used in prompts, e.g. S3")
    url: str
    title: str | None = None
    kind: Literal["search_result", "fetched_page", "citation", "direct_fetch"]
    retrieved_at: datetime
    page_text: str | None = Field(
        default=None, exclude=True, description="Fetched text, kept in memory for quote checks only"
    )


class SourcedValue(BaseModel):
    """A factual value. Either known (with a source) or explicitly unknown."""

    value: str | None
    unit: str | None = None
    status: ValueStatus
    source_url: str | None = None
    retrieved_at: datetime | None = None
    quote: str | None = Field(default=None, description="Text on the source page that supports the value")
    verification: Verification = "unverified"


# ---------------------------------------------------------------------------
# environment_profile + owned_product
# ---------------------------------------------------------------------------


class ProfileFact(BaseModel):
    """One fact about the user's environment, with provenance.

    ids are dotted paths, e.g. `location.country`, `home.floor_types`,
    `ecosystems.smart_home`, `household.children`.
    """

    id: str
    value: str | int | float | bool | list[str] | None
    source: Provenance = "stated"
    confidence: float = Field(1.0, ge=0, le=1)
    status: FactStatus = "confirmed"
    note: str | None = None
    private: bool = Field(False, description="Never rendered on the public site (e.g. postcode)")


class OwnedProduct(BaseModel):
    id: str = Field(description="Stable slug, e.g. stroller-cybex-balios-s-lux")
    user_id: str = "me"
    category: str
    brand: str
    model: str
    variant: str | None = None
    year: int | None = None
    purchase_date: str | None = None
    retailer: str | None = None
    price: Money | None = None
    room: str | None = None
    aliases: list[str] = Field(default_factory=list, description='Ways the user refers to it, e.g. "my stroller"')
    notes: str | None = None
    source: Provenance = "stated"
    confidence: float = Field(1.0, ge=0, le=1)
    status: FactStatus = "confirmed"


class EnvironmentProfile(BaseModel):
    user_id: str = "me"
    version: str = Field(description="Content hash; recommendations record which version they used")
    loaded_at: datetime
    facts: list[ProfileFact]
    owned_products: list[OwnedProduct]

    def fact(self, fact_id: str) -> ProfileFact | None:
        return next((f for f in self.facts if f.id == fact_id), None)

    def usable_facts(self) -> list[ProfileFact]:
        return [f for f in self.facts if f.status != "rejected"]

    def unconfirmed(self) -> list[ProfileFact | OwnedProduct]:
        return [f for f in self.facts if f.status == "unconfirmed"] + [
            p for p in self.owned_products if p.status == "unconfirmed"
        ]


# ---------------------------------------------------------------------------
# need
# ---------------------------------------------------------------------------


class NeedSpec(BaseModel):
    """A row in needs.yaml."""

    id: str
    text: str
    status: Literal["active", "paused", "closed"] = "active"
    budget_max: float | None = None
    target_price: float | None = None
    deadline: str | None = None
    notes: str | None = None
    retailers: list[str] | None = Field(None, description="Override the default retailer list for this need")


class ResolvedReference(BaseModel):
    phrase: str = Field(description='The words in the request, e.g. "my stroller"')
    kind: Literal["owned_product", "profile_fact", "unresolved"]
    ref_id: str | None = Field(None, description="OwnedProduct.id or ProfileFact.id")
    explanation: str


class NeedDraft(BaseModel):
    """Claude's structured reading of a free-text need."""

    category: str = Field(description="Lowercase kebab-case product category, e.g. robot-vacuum, stroller-footmuff")
    category_label: str = Field(description="Human label, e.g. Robot vacuum")
    search_query: str = Field(description="What a shopper would type into a retailer search box, in the user's language")
    resolved_references: list[ResolvedReference]
    requirements: list[str] = Field(description="Concrete requirements implied by the request and the profile")
    must_work_with: list[str] = Field(description="OwnedProduct ids or ecosystem fact ids the product must be compatible with")
    open_questions: list[str] = Field(description="Things that would change the answer and are not in the profile")


class Need(BaseModel):
    id: str
    user_id: str = "me"
    text: str
    status: Literal["active", "paused", "closed"]
    budget_max: Money | None = None
    target_price: Money | None = None
    deadline: str | None = None
    notes: str | None = None
    retailers: list[str]
    parsed: NeedDraft
    profile_version: str
    created_at: datetime


# ---------------------------------------------------------------------------
# category research (cached per category)
# ---------------------------------------------------------------------------


class FeatureDraft(BaseModel):
    key: str = Field(description="snake_case key, e.g. suction_pa, battery_minutes, tog_rating")
    label: str
    unit: str | None = Field(description="Unit for values, or null")
    why_it_matters: str
    source_ids: list[str] = Field(description="Ids of sources (S1, S2...) supporting why it matters")


class PitfallDraft(BaseModel):
    text: str
    source_ids: list[str]


class PriceTierDraft(BaseModel):
    tier: Literal["budget", "mid", "premium"]
    min_price: float | None
    max_price: float | None
    currency: str
    typical: str = Field(description="What you get at this tier")
    source_ids: list[str]


class CategoryResearchDraft(BaseModel):
    features: list[FeatureDraft] = Field(description="6-12 features that actually matter, most important first")
    pitfalls: list[PitfallDraft]
    price_tiers: list[PriceTierDraft]


class Feature(BaseModel):
    key: str
    label: str
    unit: str | None = None
    why_it_matters: str
    sources: list[str] = Field(default_factory=list, description="Source URLs")


class Pitfall(BaseModel):
    text: str
    sources: list[str]


class PriceTier(BaseModel):
    tier: Literal["budget", "mid", "premium"]
    min_price: float | None
    max_price: float | None
    currency: str
    typical: str
    sources: list[str]


class CategoryResearch(BaseModel):
    category: str
    country: str
    generated_at: datetime
    features: list[Feature]
    pitfalls: list[Pitfall]
    price_tiers: list[PriceTier]
    sources: list[Source]


# ---------------------------------------------------------------------------
# candidate
# ---------------------------------------------------------------------------


class ShortlistItemDraft(BaseModel):
    brand: str
    model: str
    variant: str | None
    why_shortlisted: str
    availability_source_ids: list[str] = Field(description="Sources showing it is sold in the user's country")
    official_page_source_id: str | None = Field(description="Manufacturer page source id, if found")


class ShortlistDraft(BaseModel):
    candidates: list[ShortlistItemDraft]


class SpecDraft(BaseModel):
    feature_key: str
    value: str | None = Field(description="Value as written on the source, or null if not found")
    unit: str | None
    source_id: str | None = Field(description="Source id the value came from; null if unknown")
    quote: str | None = Field(description="Short verbatim snippet from that source containing the value")


class ReviewNoteDraft(BaseModel):
    text: str
    sentiment: Literal["positive", "negative", "neutral"]
    source_id: str


class CandidateSpecsDraft(BaseModel):
    specs: list[SpecDraft]
    review_notes: list[ReviewNoteDraft]


class ReviewNote(BaseModel):
    text: str
    sentiment: Literal["positive", "negative", "neutral"]
    source_url: str


class Candidate(BaseModel):
    id: str
    brand: str
    model: str
    variant: str | None = None
    why_shortlisted: str
    official_url: str | None = None
    availability_evidence: list[str] = Field(default_factory=list)
    specs: dict[str, SourcedValue] = Field(default_factory=dict, description="feature_key -> value")
    review_notes: list[ReviewNote] = Field(default_factory=list)
    sources: list[Source] = Field(default_factory=list)

    @property
    def name(self) -> str:
        return " ".join(x for x in [self.brand, self.model, self.variant] if x)


# ---------------------------------------------------------------------------
# environment fit
# ---------------------------------------------------------------------------


class FitDimensionDraft(BaseModel):
    dimension: Literal[
        "compatibility", "physical_fit", "household", "climate", "brand_and_price_habits", "requirements", "other"
    ]
    score: int = Field(description="0-10")
    rationale: str
    profile_fact_ids: list[str] = Field(description="ProfileFact.id / OwnedProduct.id values this judgement relies on")
    spec_keys: list[str] = Field(description="feature_keys this judgement relies on")


class DealbreakerDraft(BaseModel):
    text: str
    profile_fact_ids: list[str]
    spec_keys: list[str]


class CandidateFitDraft(BaseModel):
    candidate_id: str
    dimensions: list[FitDimensionDraft]
    dealbreakers: list[DealbreakerDraft]
    cautions: list[str]


class FitDraft(BaseModel):
    assessments: list[CandidateFitDraft]


class FitAssessment(CandidateFitDraft):
    overall_score: float = Field(description="0-100, computed in code from dimension scores; 0 if any dealbreaker")


# ---------------------------------------------------------------------------
# feature_matrix
# ---------------------------------------------------------------------------


class MatrixCell(SourcedValue):
    candidate_id: str
    feature_key: str


class FeatureMatrix(BaseModel):
    need_id: str
    generated_at: datetime
    features: list[Feature]
    candidate_ids: list[str]
    cells: list[MatrixCell]

    def cell(self, candidate_id: str, feature_key: str) -> MatrixCell | None:
        return next(
            (c for c in self.cells if c.candidate_id == candidate_id and c.feature_key == feature_key), None
        )


# ---------------------------------------------------------------------------
# offer
# ---------------------------------------------------------------------------


class OfferDraft(BaseModel):
    retailer: str = Field(description="Retailer domain, e.g. coolblue.nl")
    page_source_id: str | None = Field(description="Source id of the product page; null if not found at this retailer")
    title_on_page: str | None
    price: float | None
    price_quote: str | None = Field(description="Verbatim text on the page showing the price")
    currency: str | None
    in_stock: bool | None
    stock_quote: str | None
    shipping: str | None
    delivery: str | None
    returns: str | None
    pickup: str | None
    condition: Literal["new", "used", "refurbished", "unknown"]
    matches_candidate: bool = Field(description="True only if the page is the exact model (and variant) of the candidate")


class OffersDraft(BaseModel):
    offers: list[OfferDraft]


class Offer(BaseModel):
    id: str
    need_id: str
    candidate_id: str
    retailer: str
    url: str
    title_on_page: str | None = None
    price: SourcedValue
    currency: str = "EUR"
    in_stock: SourcedValue
    shipping: SourcedValue
    delivery: SourcedValue
    returns: SourcedValue
    pickup: SourcedValue
    condition: Literal["new", "used", "refurbished", "unknown"] = "new"
    retrieved_at: datetime

    @property
    def price_amount(self) -> float | None:
        if self.price.status != "known" or self.price.value is None:
            return None
        try:
            return float(self.price.value)
        except ValueError:
            return None


# ---------------------------------------------------------------------------
# recommendation
# ---------------------------------------------------------------------------


class PickDraft(BaseModel):
    role: Literal["top", "budget", "premium", "if_you_care"]
    care_about: str | None = Field(description='For role if_you_care: the thing, e.g. "quiet operation"; else null')
    candidate_id: str
    offer_id: str | None = Field(description="Best offer id for this pick, or null if none known")
    headline: str
    why_fits_you: str = Field(description="Plain language, second person, tied to the user's setup")
    tradeoffs: list[str]
    would_change_if: list[str]
    profile_fact_ids: list[str]
    spec_keys: list[str]


class RecommendationDraft(BaseModel):
    summary: str
    picks: list[PickDraft]
    not_recommended: list[str] = Field(description='"candidate_id: reason" lines for clear rejects')
    caveats: list[str]


class Recommendation(BaseModel):
    need_id: str
    user_id: str = "me"
    generated_at: datetime
    profile_version: str
    run_id: str
    summary: str
    picks: list[PickDraft]
    not_recommended: list[str]
    caveats: list[str]
    warnings: list[str] = Field(default_factory=list, description="Problems found by code validation")


# Names used for schemas/*.json
# ---------------------------------------------------------------------------
# Phase 2: purchases imported from Gmail / receipts
# ---------------------------------------------------------------------------

ItemKind = Literal["durable", "accessory", "consumable", "clothing", "service", "gift_card", "other"]
DocType = Literal["order_confirmation", "shipping", "invoice", "receipt", "return", "cancellation", "other"]


class PurchaseItemDraft(BaseModel):
    product_name: str = Field(description="Product name exactly as written in the document")
    quote: str = Field(description="The line of the document that names this product, copied verbatim")
    brand: str | None = Field(None, description="Only if written in the document; otherwise null")
    model: str | None = Field(None, description="Model name/number only if written in the document")
    variant: str | None = Field(None, description="Colour/size/edition if written")
    category: str = Field(description="Short generic category, e.g. robot-vacuum, stroller, footmuff, diapers, tv")
    kind: ItemKind
    quantity: int = 1
    unit_price: float | None = Field(None, description="Price per item as written in the document; null if not shown")


class PurchaseDraft(BaseModel):
    is_purchase: bool = Field(description="True only if this document confirms that the user bought, was shipped, "
                                          "returned or was invoiced for products")
    doc_type: DocType
    merchant: str | None = Field(None, description="Shop name or domain as written in the document")
    order_date: str | None = Field(None, description="YYYY-MM-DD if a date is written in the document")
    currency: str | None = None
    items: list[PurchaseItemDraft] = Field(default_factory=list)


class Purchase(BaseModel):
    """One purchased item. Extracted fields only - the email or receipt itself is never stored."""

    id: str
    user_id: str = "me"
    source_kind: Literal["email", "receipt"]
    source_ref: str = Field(description="sha256 of the Gmail message id or file contents; for de-duplication only")
    doc_type: DocType
    merchant: str | None = None
    order_date: str | None = None
    product_name: str
    brand: str | None = None
    model: str | None = None
    variant: str | None = None
    category: str
    kind: ItemKind
    quantity: int = 1
    unit_price: float | None = None
    currency: str | None = None
    price_verified: bool = Field(False, description="The price was found in the document text by code")
    status: FactStatus = "unconfirmed"
    user_edited: bool = False
    extracted_at: datetime


SCHEMA_MODELS: dict[str, type[BaseModel]] = {
    "environment_profile": EnvironmentProfile,
    "owned_product": OwnedProduct,
    "need": Need,
    "category_research": CategoryResearch,
    "candidate": Candidate,
    "fit_assessment": FitAssessment,
    "feature_matrix": FeatureMatrix,
    "offer": Offer,
    "recommendation": Recommendation,
    "purchase": Purchase,
}
