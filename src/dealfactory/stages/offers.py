"""OFFERS: find the product at each retailer and read price, stock, shipping, returns, pickup.

Search and fetch are restricted to the need's retailer domains. A price only
counts as known if (a) the page's schema.org JSON-LD states it (fetched directly,
robots.txt respected), or (b) the price text Claude quotes is on the page Claude
fetched. Otherwise the offer is listed with price `unknown` and a link.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlparse

from ..fetch import extract_jsonld_offer, price_in_text
from ..llm import SourceRegistry
from ..models import Candidate, Need, Offer, OffersDraft, SourcedValue, now_utc
from ..pipeline import RunContext
from ._common import CITE_RULES, GROUNDING_RULES, slugify

SYSTEM = """You find where one exact product is sold, for a shopper in {country}. Search ONLY these
retailers: {domains}. For each retailer, use web_search to find the product page of the exact model
(and variant), then web_fetch that page and read: the current price, stock status, shipping cost,
delivery time, return policy and in-store pickup, as shown on the page. If a retailer does not sell
this exact model, say so - a similar or older model does not count.
{rules}
Write notes per retailer with the product page URL and verbatim snippets for price and stock."""

STRUCT = """Extract one offer per retailer from the notes ({domains}). page_source_id must be the
fetched product page. matches_candidate is true only for the exact model (and variant). price is a
number in the page's currency; price_quote is the verbatim price text from the page. Use null for
anything the page did not show. {cite}"""


def _host_matches(url: str, domain: str) -> bool:
    host = urlparse(url).netloc.lower().split(":")[0]
    return host == domain or host.endswith("." + domain)


def _offers_for(ctx: RunContext, need: Need, cand: Candidate) -> list[Offer]:
    reg = SourceRegistry()
    domains = need.retailers
    dlist = ", ".join(domains)
    notes = ctx.llm.research(
        f"offers.{cand.id}", SYSTEM.format(country=ctx.country, domains=dlist, rules=GROUNDING_RULES),
        f"Product: {cand.name}\nSearch query hint: {need.parsed.search_query} {cand.brand} {cand.model}",
        reg, effort=ctx.effort("offers"), allowed_domains=domains,
    )
    draft = ctx.llm.structured(
        f"offers.{cand.id}.structure", STRUCT.format(domains=dlist, cite=CITE_RULES),
        f"PRODUCT: {cand.name}\n\nSOURCES:\n{reg.render()}\n\nNOTES:\n{notes}",
        OffersDraft, effort=ctx.effort("structure"),
    )
    out: list[Offer] = []
    for d in draft.offers:
        src = reg.get(d.page_source_id)
        domain = next((x for x in domains if src and _host_matches(src.url, x)), None)
        if not src or not domain or not d.matches_candidate:
            continue
        has_text = reg.has_page_text(src.id)

        def page_claim(value: str | None, quote: str | None = None) -> SourcedValue:
            if value is None:
                return SourcedValue(value=None, status="unknown")
            if quote and has_text and reg.quote_on_page(src.id, quote):
                return SourcedValue(value=value, status="known", source_url=src.url,
                                    retrieved_at=src.retrieved_at, quote=quote, verification="quote_verified")
            if has_text and quote:  # quoted text is not on the page we have
                return SourcedValue(value=None, status="unknown")
            return SourcedValue(value=value, status="known", source_url=src.url,
                                retrieved_at=src.retrieved_at, quote=quote, verification="cited")

        price = SourcedValue(value=None, status="unknown")
        stock = SourcedValue(value=None, status="unknown")
        currency = d.currency or ctx.currency

        # (a) direct, polite fetch of JSON-LD
        if ctx.settings.direct_fetch:
            got = ctx.fetcher.get(src.url)
            if got and got[0] == 200:
                ld = extract_jsonld_offer(got[1])
                if ld:
                    ts = now_utc()
                    price = SourcedValue(value=f"{ld['price']:.2f}", unit=ld["currency"], status="known",
                                         source_url=src.url, retrieved_at=ts,
                                         quote=f"schema.org Offer price={ld['price']}", verification="jsonld")
                    currency = ld["currency"]
                    if ld["in_stock"] is not None:
                        stock = SourcedValue(value="yes" if ld["in_stock"] else "no", status="known",
                                             source_url=src.url, retrieved_at=ts,
                                             quote=f"availability={ld['availability']}", verification="jsonld")
        # (b) quote check against the page Claude fetched
        if price.status == "unknown" and d.price is not None and d.price_quote:
            if has_text and reg.quote_on_page(src.id, d.price_quote) and price_in_text(d.price, d.price_quote):
                price = SourcedValue(value=f"{d.price:.2f}", unit=currency, status="known", source_url=src.url,
                                     retrieved_at=src.retrieved_at, quote=d.price_quote,
                                     verification="quote_verified")
        if stock.status == "unknown" and d.in_stock is not None:
            stock = page_claim("yes" if d.in_stock else "no", d.stock_quote)

        out.append(Offer(
            id=slugify(cand.id, domain), need_id=need.id, candidate_id=cand.id, retailer=domain, url=src.url,
            title_on_page=d.title_on_page, price=price, currency=currency, in_stock=stock,
            shipping=page_claim(d.shipping), delivery=page_claim(d.delivery), returns=page_claim(d.returns),
            pickup=page_claim(d.pickup), condition=d.condition if d.condition != "unknown" else "new",
            retrieved_at=src.retrieved_at,
        ))
    return out


def run(ctx: RunContext) -> list[Offer]:
    need = ctx.read("intake", Need)
    cands = ctx.read("candidates", list[Candidate])
    with ThreadPoolExecutor(max_workers=3) as pool:
        results = list(pool.map(lambda c: _offers_for(ctx, need, c), cands))
    offers = [o for group in results for o in group]
    # de-duplicate by id (keep the one with a known price)
    best: dict[str, Offer] = {}
    for o in offers:
        if o.id not in best or (best[o.id].price_amount is None and o.price_amount is not None):
            best[o.id] = o
    offers = sorted(best.values(), key=lambda o: (o.candidate_id, o.price_amount or 1e12))
    ctx.write("offers", offers)
    ctx.store.record_offers(ctx.settings.user_id, ctx.run_id, offers)
    return offers
