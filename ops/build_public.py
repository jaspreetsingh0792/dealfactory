"""Build only the public frontend and its curated Netherlands buying guide."""

import argparse
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal, InvalidOperation
from html import escape
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import shutil
import subprocess
import xml.etree.ElementTree as ET
from email.utils import format_datetime
from urllib.parse import urljoin, urlsplit

from jinja2 import Environment, FileSystemLoader, select_autoescape

from dealfactory.fetch import JSONLD_RE, PoliteFetcher, _iter_nodes

from dealfactory.public_catalog import discover, product_name

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


class ProductImage(HTMLParser):
    """Use the retailer's own product preview image for the verified listing."""

    def __init__(self):
        super().__init__()
        self.urls = {}

    def handle_starttag(self, tag, attrs):
        if tag != "meta":
            return
        data = dict(attrs)
        prop = data.get("property") or data.get("name")
        if prop in {"og:image", "og:image:secure_url", "twitter:image"} and data.get("content"):
            self.urls.setdefault(prop, data["content"])


def secure_image_url(raw, page_url):
    if isinstance(raw, str) and raw.strip():
        try:
            parts = urlsplit(urljoin(page_url, raw.strip()))
            if parts.scheme in {"http", "https"} and parts.hostname and not parts.username and not parts.password:
                return parts._replace(scheme="https").geturl()
        except ValueError:
            pass
    return None


def listing_image(html, page_url):
    parser = ProductImage()
    parser.feed(html)
    for prop in ("og:image:secure_url", "og:image", "twitter:image"):
        url = secure_image_url(parser.urls.get(prop), page_url)
        if url:
            return url
    for script in JSONLD_RE.findall(html):
        try:
            data = json.loads(script)
        except (ValueError, RecursionError):
            continue
        for node in _iter_nodes(data):
            kind = node.get("@type")
            if kind != "Product" and not (isinstance(kind, list) and "Product" in kind):
                continue
            images = node.get("image")
            for raw in images if isinstance(images, list) else [images]:
                if isinstance(raw, dict):
                    raw = raw.get("contentUrl") or raw.get("url")
                url = secure_image_url(raw, page_url)
                if url:
                    return url
    return None


def collect_offers(sources, fetcher):
    offers = []
    for source in sources:
        response = fetcher.get(source["url"])
        price = exact_stock_price(response[1]) if response and response[0] == 200 else None
        if price is None:
            continue
        if source.get("discovered"):
            name = product_name(response[1])
            if not name:
                continue
            source = {**source, "name": name}
        offers.append((price, {**source, "image": listing_image(response[1], source["url"])}))
    return [
        {**source, "price": f"{price:.2f}".replace(".", ",")}
        for price, source in sorted(offers, key=lambda pair: pair[0])
    ]


def build(output: Path, site_url: str, fetcher=None, analytics_token: str = "", *,
          history=None, traffic=None, collect_traffic=False) -> int:
    site_url = site_url.rstrip("/")
    parsed = urlsplit(site_url)
    if not re.fullmatch(r"https://[a-zA-Z0-9.-]+", site_url) or not parsed.hostname:
        raise ValueError("SITE_URL must be an HTTPS origin without a path")
    if analytics_token and not re.fullmatch(r"[A-Za-z0-9_-]+", analytics_token):
        raise ValueError("Invalid public Web Analytics beacon token")

    sources = json.loads((ROOT / "ops/offer-sources.json").read_text())
    candidates = list(sources)
    if fetcher:
        candidates.extend(discover(fetcher, {source["url"] for source in sources}))
    offers = collect_offers(candidates, fetcher) if fetcher else []
    templates = Environment(
        loader=FileSystemLoader(ROOT / "ops"), autoescape=select_autoescape(default=True)
    )
    web = ROOT / "web"
    output.mkdir(parents=True, exist_ok=False)
    for pattern in ("*.html", "*.css", "*.js", "lib/*.js", "spec/*.json", "media/*.webp", "media/*.ttf", "media/*-OFL.txt"):
        for path in web.glob(pattern):
            target = output / path.relative_to(web)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, target)

    today = datetime.now(UTC).date()
    observations = {}
    for offer in offers:
        url = offer["url"]
        price = Decimal(offer["price"].replace(",", "."))
        prices = {}
        for day, old in (history or {}).get(url, {}).items():
            try:
                recent = today - timedelta(days=7) <= date.fromisoformat(day) < today
                if recent and re.fullmatch(r"[0-9]{1,7}\.[0-9]{2}", str(old)):
                    prices[day] = str(old)
            except ValueError:
                continue
        if prices:
            prior = Decimal(prices[max(prices)])
            if prior > price:
                offer["previous"] = f"{prior:.2f}".replace(".", ",")
                offer["previous_date"] = max(prices)
        prices[today.isoformat()] = f"{price:.2f}"
        observations[url] = prices
    (output / "offer-history.json").write_text(json.dumps(observations, ensure_ascii=False))
    feed = ET.Element("rss", version="2.0")
    channel = ET.SubElement(feed, "channel")
    ET.SubElement(channel, "title").text = "DealFactory | Dutch stroller footmuffs"
    ET.SubElement(channel, "link").text = site_url + "/" + GUIDE
    ET.SubElement(channel, "description").text = "Current retailer offers verified by DealFactory."
    ET.SubElement(channel, "lastBuildDate").text = format_datetime(datetime.now(UTC))
    for offer in offers:
        item = ET.SubElement(channel, "item")
        ET.SubElement(item, "title").text = f"{offer['name']} at {offer['retailer']} · €{offer['price']}"
        ET.SubElement(item, "link").text = site_url + "/" + GUIDE + "?utm_source=rss&utm_medium=feed"
        ET.SubElement(item, "guid", isPermaLink="false").text = offer["url"] + "#" + offer["price"]
        ET.SubElement(item, "description").text = f"Price checked on {today.isoformat()}. Confirm availability at the retailer."
    ET.ElementTree(feed).write(output / "offers.xml", encoding="utf-8", xml_declaration=True)
    counts = {(r["page"], r["event"]): int(r["n"]) for r in traffic or []}
    guide_views = counts.get(("footmuffs", "view"), 0)
    show_offers_first = guide_views >= 30 and counts.get(("footmuffs", "outbound"), 0) < guide_views / 10
    guide = output / GUIDE
    guide.mkdir(parents=True)
    checked = datetime.now(UTC)
    context = dict(
        site_url=site_url, offers=offers, sources=sources, offers_first=show_offers_first,
        checked_at=checked.isoformat(timespec="minutes").replace("+00:00", "Z"),
        checked_label=checked.strftime("%d %b %Y"),
    )
    (guide / "index.html").write_text(templates.get_template("footmuffs.html.j2").render(**context), encoding="utf-8")
    homepage = output / "index.html"
    advisor = output / "advisor.html"
    original = homepage.read_text(encoding="utf-8")
    original = original.replace("</head>", '<link rel="stylesheet" href="/storefront.css">\n</head>', 1)
    original = original.replace("<body>", '<body class="df-advisor">', 1)
    brand = templates.get_template("storefront.html.j2").module.wordmark()
    original = original.replace('<a class="brand" href="#top">DealFactory</a>', str(brand), 1)
    original = re.sub(r"<h1>[^<]+</h1>", '<h1>Deals that fit<br><em>your setup.</em></h1>', original, count=1)
    advisor.write_text(original, encoding="utf-8")
    homepage.write_text(templates.get_template("storefront.html.j2").render(home=True, **context), encoding="utf-8")

    for page_path in (homepage, guide / "index.html"):
        markup = page_path.read_text(encoding="utf-8")
        prefix = "./" if page_path == homepage else "../../"
        script = f'<script type="module" src="{prefix}lib/guide-events.js"></script>'
        script += '<link rel="alternate" type="application/rss+xml" title="Checked offers" href="/offers.xml">'
        if collect_traffic:
            script += '<meta name="dealfactory-counts" content="aggregate">'
            markup = markup.replace("</main>", '<p class="small muted">DealFactory counts page views, guide shares, and retailer clicks in aggregate. These counters use no cookies.</p>\n</main>', 1)
        page_path.write_text(markup.replace("</head>", script + "\n</head>", 1), encoding="utf-8")
    if collect_traffic:
        shutil.copyfile(ROOT / "ops/events-worker.js", output / "_worker.js")
        (output / "_routes.json").write_text(json.dumps({"version": 1, "include": ["/events"], "exclude": []}))
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
    print(f"Retailer pages checked: {len(candidates)}. New product links found: {len(candidates) - len(sources)}.")
    print(f"Guide layout: {'prices first' if show_offers_first else 'compatibility first'}.")
    if offers:
        print(f"Organic campaign draft: Compare {len(offers)} checked stroller footmuff "
              f"{'offer' if len(offers) == 1 else 'offers'} for shoppers in the Netherlands. "
              f"{site_url}/{GUIDE}?utm_source=campaign&utm_medium=organic")
    return len(offers)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    parser.add_argument("--site-url", required=True)
    parser.add_argument("--refresh", action="store_true")
    parser.add_argument("--analytics-token", default="")
    parser.add_argument("--history-url")
    parser.add_argument("--traffic-file", type=Path)
    args = parser.parse_args()
    history = {}
    if args.history_url:
        try:
            payload = subprocess.check_output(["curl", "-fsSL", "--max-time", "10", args.history_url])
            data = json.loads(payload)
            if isinstance(data, dict):
                history = {key: value for key, value in data.items() if isinstance(value, dict)}
        except (ValueError, OSError, subprocess.CalledProcessError):
            pass
    traffic = json.loads(args.traffic_file.read_text()) if args.traffic_file else []
    import tempfile

    with tempfile.TemporaryDirectory() as cache:
        fetcher = PoliteFetcher(Path(cache), "DealFactoryOfferCheck/1.0") if args.refresh else None
        count = build(args.output, args.site_url, fetcher, args.analytics_token,
                      history=history, traffic=traffic, collect_traffic=bool(args.traffic_file))
    print(f"Verified in-stock offers: {count}")


if __name__ == "__main__":
    main()
