"""Build only the public frontend and its curated Netherlands buying guide."""

import argparse
from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation
from html import escape
import json
from pathlib import Path
import re
import shutil
from urllib.parse import urlsplit

from jinja2 import Environment, FileSystemLoader, select_autoescape

from dealfactory.fetch import JSONLD_RE, PoliteFetcher, _iter_nodes

ROOT = Path(__file__).resolve().parents[1]
GUIDE = "guides/stroller-footmuffs/"
ANALYTICS_SCRIPT = "https://static.cloudflareinsights.com/beacon.min.js"


def exact_stock_price(html: str) -> Decimal | None:
    """Require an explicit euro price and in-stock offer attached to a product."""
    prices = set()
    for script in JSONLD_RE.findall(html):
        try:
            data = json.loads(script)
        except (json.JSONDecodeError, RecursionError):
            continue
        for product in _iter_nodes(data):
            product_type = product.get("@type")
            if product_type != "Product" and not (
                isinstance(product_type, list) and "Product" in product_type
            ):
                continue
            offers = product.get("offers")
            if isinstance(offers, dict):
                offers = [offers]
            if not isinstance(offers, list):
                continue
            for offer in offers:
                if not isinstance(offer, dict) or offer.get("@type") != "Offer":
                    continue
                if offer.get("priceCurrency") != "EUR" or offer.get("availability") not in (
                    "https://schema.org/InStock", "http://schema.org/InStock", "InStock"
                ):
                    continue
                price_text = str(offer.get("price", ""))
                if not re.fullmatch(r"[0-9]{1,7}(?:[.,][0-9]{1,2})?", price_text):
                    continue
                try:
                    price = Decimal(price_text.replace(",", "."))
                except InvalidOperation:
                    continue
                if price > 0:
                    prices.add(price)
    return next(iter(prices)) if len(prices) == 1 else None


def collect_offers(sources, fetcher):
    offers = []
    for source in sources:
        response = fetcher.get(source["url"])
        price = exact_stock_price(response[1]) if response and response[0] == 200 else None
        if price is not None:
            offers.append((price, source))
    return [
        {**source, "price": f"{price:.2f}".replace(".", ",")}
        for price, source in sorted(offers, key=lambda pair: pair[0])
    ]


def build(output: Path, site_url: str, fetcher=None, analytics_token: str = "") -> int:
    site_url = site_url.rstrip("/")
    parsed = urlsplit(site_url)
    if not re.fullmatch(r"https://[a-zA-Z0-9.-]+", site_url) or not parsed.hostname:
        raise ValueError("SITE_URL must be an HTTPS origin without a path")
    if analytics_token and not re.fullmatch(r"[A-Za-z0-9_-]+", analytics_token):
        raise ValueError("Invalid public Web Analytics beacon token")

    sources = json.loads((ROOT / "ops/offer-sources.json").read_text())
    offers = collect_offers(sources, fetcher) if fetcher else []
    templates = Environment(
        loader=FileSystemLoader(ROOT / "ops"), autoescape=select_autoescape(default=True)
    )
    web = ROOT / "web"
    output.mkdir(parents=True, exist_ok=False)
    for pattern in ("*.html", "*.css", "*.js", "lib/*.js", "spec/*.json"):
        for path in web.glob(pattern):
            target = output / path.relative_to(web)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, target)

    guide = output / GUIDE
    guide.mkdir(parents=True)
    (guide / "index.html").write_text(templates.get_template("footmuffs.html.j2").render(
        site_url=site_url, offers=offers, sources=sources,
        checked_at=datetime.now(UTC).isoformat(timespec="minutes").replace("+00:00", "Z"),
    ), encoding="utf-8")

    homepage = output / "index.html"
    html = homepage.read_text(encoding="utf-8")
    html = html.replace("</head>", f'<link rel="canonical" href="{site_url}/">\n</head>', 1)
    html = html.replace("</main>", f'<p class="wrap"><a href="{GUIDE}">Stroller footmuffs in the Netherlands</a></p>\n</main>', 1)
    homepage.write_text(html, encoding="utf-8")

    if analytics_token:
        beacon = (
            f'<script defer src="{ANALYTICS_SCRIPT}" '
            f'data-cf-beacon=\'{{"token":"{analytics_token}"}}\'></script>'
        )
        for page in (homepage, guide / "index.html"):
            html = page.read_text(encoding="utf-8")
            html = html.replace("script-src 'self';", f"script-src 'self' {ANALYTICS_SCRIPT};")
            page.write_text(html.replace("</body>", f"{beacon}\n</body>", 1), encoding="utf-8")

    (output / "_headers").write_text(
        "/*\n  Content-Security-Policy: frame-ancestors 'none'\n"
        "  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n"
        "/oauth\n  X-Robots-Tag: noindex\n/oauth.html\n  X-Robots-Tag: noindex\n",
        encoding="utf-8",
    )
    (output / "robots.txt").write_text(f"User-agent: *\nSitemap: {site_url}/sitemap.xml\n")
    (output / "sitemap.xml").write_text(
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
        + "".join(f"<url><loc>{escape(site_url + path)}</loc></url>" for path in ("/", f"/{GUIDE}"))
        + "</urlset>\n", encoding="utf-8"
    )
    return len(offers)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    parser.add_argument("--site-url", required=True)
    parser.add_argument("--refresh", action="store_true")
    parser.add_argument("--analytics-token", default="")
    args = parser.parse_args()
    import tempfile

    with tempfile.TemporaryDirectory() as cache:
        fetcher = PoliteFetcher(Path(cache), "DealFactoryOfferCheck/1.0") if args.refresh else None
        count = build(args.output, args.site_url, fetcher, args.analytics_token)
    print(f"Verified in-stock offers: {count}")


if __name__ == "__main__":
    main()
