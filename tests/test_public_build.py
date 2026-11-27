import importlib.util
import json
from decimal import Decimal
from pathlib import Path
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
    html = (output / public.GUIDE / "index.html").read_text()
    assert "€89,95" not in html
    assert "stroller" in html.lower()
    home = (output / "index.html").read_text()
    assert 'id="memory-title"' in home and 'href="/advisor.html#setup"' in home
    assert 'href="/guides/stroller-footmuffs/"' in home
    assert '"@type": "FAQPage"' in home
    assert "static.cloudflareinsights.com" in home
    deals = (output / public.DEALS / "index.html").read_text()
    assert "€89,95" in deals and 'id="cover-title"' in deals
    assert "data-offers-checked=" in deals and "hidden data-offers-checked" not in deals
    assert "Fits: OpenTherm, Matter" in deals
    assert "winter-walk.webp" not in deals.split("<body", 1)[-1]
    assert "static.cloudflareinsights.com" in deals
    smarthome = (output / public.SMARTHOME_GUIDE / "index.html").read_text()
    assert 'id="sh-title"' in smarthome and "OpenTherm" in smarthome
    assert '"@type": "FAQPage"' in smarthome
    for page in ("about/index.html", "terms/index.html", "404.html"):
        assert "<h1>" in (output / page).read_text()
    headers = (output / "_headers").read_text()
    assert "Strict-Transport-Security:" in headers
    assert "Permissions-Policy:" in headers
    assert "X-Frame-Options: DENY" in headers
    assert "/config.js\n  Cache-Control: no-cache" in headers
    assert 'http-equiv="Content-Security-Policy"' in home
    assert 'http-equiv="Content-Security-Policy"' in smarthome
    assert 'name="robots" content="noindex"' in (output / "404.html").read_text()
    assert "your home." in (output / "advisor.html").read_text()
    sitemap = ET.parse(output / "sitemap.xml")
    assert sitemap.find(f".//map:loc[.='https://example.com/{public.SMARTHOME_GUIDE}']", SITEMAP_NS) is not None
    assert sitemap.find(f".//map:loc[.='https://example.com/{public.GUIDE}']", SITEMAP_NS) is not None
    assert sitemap.find(f".//map:loc[.='https://example.com/{public.DEALS}']", SITEMAP_NS) is not None


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


def test_listing_image_prefers_product_image():
    html = (
        '<meta property="og:image" content="https://cdn.example/og.jpg">'
        '<script type="application/ld+json">'
        + json.dumps({"@type": "Product", "image": "https://cdn.example/product.jpg"})
        + "</script>"
    )
    assert public.listing_image(html, "https://shop.example/p") == "https://cdn.example/product.jpg"
