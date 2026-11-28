import importlib.util
import json
from decimal import Decimal
from pathlib import Path
import re
import xml.etree.ElementTree as ET

SITEMAP_NS = {"map": "http://www.sitemaps.org/schemas/sitemap/0.9"}
spec = importlib.util.spec_from_file_location(
    "build_public", Path(__file__).resolve().parents[1] / "ops" / "build_public.py"
)
public = importlib.util.module_from_spec(spec)
spec.loader.exec_module(public)


def product_page(**overrides):
    offer = {
        "@type": "Offer", "price": "89,95", "priceCurrency": "EUR",
        "availability": "https://schema.org/InStock",
    }
    data = {"@type": "Product", "offers": {**offer, **overrides}}
    return '<script type="application/ld+json">' + json.dumps(data) + "</script>"


CHECKED = "https://www.coolblue.nl/product/983933/tado-bedrade-slimme-thermostaat-x-startpakket-2e-generatie.html"


def test_builder_ships_only_public_files_with_checked_prices(tmp_path):
    class Fetcher:
        def get(self, url):
            return (200, product_page()) if url == CHECKED else None

    output = tmp_path / "public"
    assert public.build(output, "https://example.com", Fetcher(), "public-example") == 1
    assert not (output / "tests").exists()
    assert not (output / "private").exists()
    assert not (output / public.GUIDE / "index.html").exists()
    redirects = (output / "_redirects").read_text()
    assert "/guides/stroller-footmuffs/ /deals/ 301" in redirects
    home = (output / "index.html").read_text()
    assert 'id="memory-title"' in home and 'href="/advisor/#setup"' in home
    assert '"@type": "WebSite"' in home and '"@type": "SoftwareApplication"' in home
    assert 'href="/guides/stroller-footmuffs/"' not in home
    assert 'href="/guides/smart-home-compatibility/"' in home
    assert "/media/home-setup.png" in home
    assert "winter-walk.webp" not in home
    assert '"@type": "FAQPage"' in home
    assert "static.cloudflareinsights.com" in home
    assert 'rel="icon"' in home and "favicon.svg" in home
    assert (output / "media/favicon.svg").is_file()
    assert 'name="twitter:card"' in home and "summary_large_image" in home
    assert "og:image" in home
    deals = (output / public.DEALS / "index.html").read_text()
    assert "€89,95" in deals and 'id="cover-title"' in deals
    assert "data-offers-checked=" in deals and "hidden data-offers-checked" not in deals
    assert "Fits: OpenTherm, Matter" in deals
    assert 'data-protocol="Matter"' in deals and 'data-protocol="OpenTherm"' in deals
    assert "Price before delivery. Confirm it at the shop." in deals
    assert "Open shop" in deals
    assert "Total with delivery" not in deals
    assert "Delivery €" not in deals
    product_slug = "tado-bedrade-slimme-thermostaat-x-startpakket-2e-generatie"
    product = (output / "deals" / product_slug / "index.html").read_text()
    assert f"<title>tado Bedrade Slimme Thermostaat X Startpakket 2e Generatie: checked price and fit | DealFactory</title>" in product
    assert "Good for" in product and "Not for" in product
    assert "tado V3+" in product
    assert "What it works with" in product
    assert '"@type": "Offer"' in product and "AggregateOffer" not in product
    assert 'rel="canonical" href="https://example.com/deals/' + product_slug + '/"' in product
    assert '"@type": "BreadcrumbList"' in product
    assert "Fit and compatibility" in product
    assert f'href="/deals/{product_slug}/"' in deals
    assert "winter-walk.webp" not in deals.split("<body", 1)[-1]
    assert "static.cloudflareinsights.com" in deals
    assert '"@type": "ItemList"' in deals and '"@type": "BreadcrumbList"' in deals
    smarthome = (output / public.SMARTHOME_GUIDE / "index.html").read_text()
    assert 'id="sh-title"' in smarthome and "OpenTherm" in smarthome
    assert '"@type": "FAQPage"' in smarthome
    assert '"@type": "TechArticle"' in smarthome and '"@type": "BreadcrumbList"' in smarthome
    assert 'id="share-guide"' in smarthome and "/advisor/?need=" in smarthome
    for page in ("about/index.html", "terms/index.html", "404.html"):
        assert "<h1>" in (output / page).read_text()
    headers = (output / "_headers").read_text()
    assert "Strict-Transport-Security:" in headers
    assert "Permissions-Policy:" in headers
    assert "X-Frame-Options: DENY" in headers
    assert "/config.js\n  Cache-Control: no-store" in headers
    assert "/app.js\n  Cache-Control: no-store" in headers
    assert "/lib/*\n  Cache-Control: no-store" in headers
    assert "/oauth\n  X-Robots-Tag: noindex\n  Cache-Control: no-store" in headers
    assert "/oauth.html\n  X-Robots-Tag: noindex\n  Cache-Control: no-store" in headers
    assert 'http-equiv="Content-Security-Policy"' in home
    assert 'http-equiv="Content-Security-Policy"' in smarthome
    assert 'name="robots" content="noindex"' in (output / "404.html").read_text()
    advisor = (output / "advisor/index.html").read_text()
    assert "<title>Shopping advisor: what fits your home | DealFactory</title>" in advisor
    assert "Tell DealFactory what you own" in advisor
    assert 'rel="canonical" href="https://example.com/advisor/"' in advisor
    assert '"@type": "WebApplication"' in advisor and '"@type": "BreadcrumbList"' in advisor
    assert advisor.split("<title>", 1)[1].split("</title>", 1)[0] != home.split("<title>", 1)[1].split("</title>", 1)[0]
    assert not (output / "advisor.html").exists()
    assert (output / "privacy/index.html").is_file()
    assert not (output / "privacy.html").exists()
    assert "your home." in advisor
    assert 'href="/guides/smart-home-compatibility/"' in advisor
    assert 'href="/deals/"' in advisor
    assert "data-preset=\"apple-opentherm\"" in advisor
    assert "/lib/guide-events.js" in advisor
    assert re.search(r'src="/app\.js\?v=[0-9a-f]{12}"', advisor)
    assert re.search(r'from "\./lib/llm\.js\?v=[0-9a-f]{12}"', (output / "app.js").read_text())
    assert "?v=" not in (output / "_worker.js/web/lib/location.js").read_text()
    assert "static.cloudflareinsights.com" in advisor
    privacy = (output / "privacy/index.html").read_text()
    assert "/lib/guide-events.js" in privacy
    assert "cookieless beacon" in privacy and "deals@agentsealteam.com" not in privacy
    assert "/lib/guide-events.js" in (output / "about/index.html").read_text()
    assert "/lib/guide-events.js" in (output / "terms/index.html").read_text()
    sitemap = ET.parse(output / "sitemap.xml")
    assert sitemap.find(".//map:loc[.='https://example.com/advisor/']", SITEMAP_NS) is not None
    assert sitemap.find(".//map:loc[.='https://example.com/privacy/']", SITEMAP_NS) is not None
    assert sitemap.find(".//map:lastmod", SITEMAP_NS) is not None
    assert sitemap.find(f".//map:loc[.='https://example.com/{public.SMARTHOME_GUIDE}']", SITEMAP_NS) is not None
    assert sitemap.find(f".//map:loc[.='https://example.com/{public.GUIDE}']", SITEMAP_NS) is None
    assert "stroller-footmuffs" not in (output / "sitemap.xml").read_text()
    assert sitemap.find(f".//map:loc[.='https://example.com/{public.DEALS}']", SITEMAP_NS) is not None
    dutch_home = (output / "nl/index.html").read_text()
    assert 'lang="nl"' in dutch_home and "past bij jouw huis" in dutch_home
    assert 'hreflang="nl"' in home and 'hreflang="x-default"' in home
    assert 'hreflang="en"' in dutch_home and "pricewatch" not in dutch_home.lower()
    dutch_deals = (output / "nl/deals/index.html").read_text()
    assert "passen bij jouw huis" in dutch_deals and "Open de winkel" in dutch_deals
    dutch_guide = (output / "nl/guides/smart-home-compatibility/index.html").read_text()
    assert 'id="sh-title"' in dutch_guide and "past bij jouw huis" in dutch_guide
    dutch_advisor = (output / "nl/advisor/index.html").read_text()
    assert 'lang="nl"' in dutch_advisor and "past bij jouw huis" in dutch_advisor
    assert "<title>Adviseur: wat past bij jouw huis | DealFactory</title>" in dutch_advisor
    assert sitemap.find(".//map:loc[.='https://example.com/nl/']", SITEMAP_NS) is not None
    assert sitemap.find(".//map:loc[.='https://example.com/nl/deals/']", SITEMAP_NS) is not None
    assert sitemap.find(".//map:loc[.='https://example.com/deals/tado-bedrade-slimme-thermostaat-x-startpakket-2e-generatie/']", SITEMAP_NS) is not None


def test_missing_ambiguous_or_unavailable_prices_are_omitted():
    for page in (
        product_page(priceCurrency=None),
        product_page(availability="https://schema.org/OutOfStock"),
        product_page(price="NaN"),
        product_page() + product_page(price="99.50"),
    ):
        assert public.exact_stock_price(page) is None


def test_exact_stock_price_reads_aggregate_specification_and_variants():
    assert public.exact_stock_price(product_page(**{"@type": "AggregateOffer"})) == Decimal("89.95")
    spec = {"@type": "Product", "offers": {
        "@type": "Offer", "priceCurrency": "EUR", "availability": "https://schema.org/InStock",
        "priceSpecification": {"@type": "UnitPriceSpecification", "price": "1.299,00", "priceCurrency": "EUR"},
    }}
    assert public.exact_stock_price(script(spec)) == Decimal("1299.00")
    variant = {"@type": "Product", "sku": "A", "offers": [
        {"@type": "Offer", "sku": "B", "price": "20.00", "priceCurrency": "EUR", "availability": "InStock"},
        {"@type": "Offer", "sku": "A", "price": "10.00", "priceCurrency": "EUR", "availability": "InStock"},
    ]}
    assert public.exact_stock_price(script(variant)) == Decimal("10.00")
    ambiguous = {"@type": "Product", "offers": {
        "@type": "AggregateOffer", "lowPrice": "10.00", "highPrice": "20.00",
        "priceCurrency": "EUR", "availability": "InStock",
    }}
    assert public.exact_stock_price(script(ambiguous)) is None


def script(data):
    return '<script type="application/ld+json">' + json.dumps(data) + "</script>"


def test_fit_tokens_prefer_protocols_and_shipping_sort_is_conditional():
    tokens = public.fit_tokens([
        {"fits": "Philips Hue, Zigbee"},
        {"fits": "OpenTherm, Matter"},
    ])
    assert tokens == ["Matter", "Zigbee", "OpenTherm", "Philips Hue"]
    from jinja2 import Environment, FileSystemLoader, select_autoescape
    env = Environment(loader=FileSystemLoader(Path(__file__).resolve().parents[1] / "ops"), autoescape=select_autoescape(default=True))
    html = env.get_template("storefront.html.j2").render(
        deals=True, site_url="https://example.com", checked_at="2026-11-27T00:00Z", checked_label="27 Nov 2026",
        fit_tokens=["Matter"], shipping_known=True,
        offers=[{"name": "Example lock", "retailer": "Shop", "price": "10,00", "shipping": "4,95",
                 "slug": "example-lock", "url": "https://shop.example/lock", "fits": "Matter"}],
    )
    assert "Total with delivery" in html
    assert "Delivery €4,95" in html
    assert 'data-total="14.95"' in html
    assert "Price before delivery. Confirm it at the shop." in html


def test_unrecorded_fit_stays_honest():
    note = public.fit_note({"url": "https://shop.example/unknown", "fits": ""})
    assert "not recorded" in note["specs"][0].lower()
    assert "No fit tags" in note["not_for"]


def test_every_curated_offer_has_a_fit_note():
    sources = json.loads((Path(__file__).resolve().parents[1] / "ops/offer-sources.json").read_text())
    missing = [source["url"] for source in sources if source["url"] not in public.NOTES]
    assert missing == []


def test_aggregate_offer_requires_two_verified_shops():
    one = public.product_structured("https://example.com", "plug", [{
        "name": "Plug", "price": "10,00", "url": "https://a.example/plug", "retailer": "A",
    }])
    assert one["@graph"][0]["offers"]["@type"] == "Offer"
    two = public.product_structured("https://example.com", "plug", [
        {"name": "Plug", "price": "10,00", "url": "https://a.example/plug", "retailer": "A"},
        {"name": "Plug", "price": "12,00", "url": "https://b.example/plug", "retailer": "B"},
    ])
    assert two["@graph"][0]["offers"]["@type"] == "AggregateOffer"
    assert two["@graph"][0]["offers"]["offerCount"] == 2
    assert two["@graph"][0]["offers"]["lowPrice"] == "10.00"


def test_listing_image_prefers_product_image():
    html = (
        '<meta property="og:image" content="https://cdn.example/og.jpg">'
        '<script type="application/ld+json">'
        + json.dumps({"@type": "Product", "image": "https://cdn.example/product.jpg"})
        + "</script>"
    )
    assert public.listing_image(html, "https://shop.example/p") == "https://cdn.example/product.jpg"
