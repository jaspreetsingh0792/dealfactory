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
SMARTHOME_GUIDE = "guides/smart-home-compatibility/"
DEALS = "deals/"
SITEMAP = ("/", "/advisor/", f"/{SMARTHOME_GUIDE}", f"/{DEALS}", f"/{GUIDE}", "/about/", "/privacy/", "/terms/")
ANALYTICS_SCRIPT = "https://static.cloudflareinsights.com/beacon.min.js"


_IN_STOCK = {"https://schema.org/InStock", "http://schema.org/InStock", "InStock"}
_AMOUNT = re.compile(
    r"(?:[0-9]{1,3}(?:\.[0-9]{3})+(?:,[0-9]{1,2})?"
    r"|[0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]{1,2})?"
    r"|[0-9]{1,7}(?:,[0-9]{1,2})?"
    r"|[0-9]{1,7}(?:\.[0-9]{1,2})?)"
)


def parse_euro_amount(raw) -> Decimal | None:
    """Read a schema.org price, including EU thousands such as 1.299,00."""
    text = str(raw).strip().replace(" ", "").replace("\u00a0", "")
    if not _AMOUNT.fullmatch(text):
        return None
    if "," in text and "." in text:
        text = text.replace(".", "").replace(",", ".") if text.rfind(",") > text.rfind(".") else text.replace(",", "")
    elif "," in text:
        text = text.replace(",", ".")
    elif re.fullmatch(r"[0-9]{1,3}(?:\.[0-9]{3})+", text):
        text = text.replace(".", "")
    try:
        price = Decimal(text)
    except InvalidOperation:
        return None
    return price if price > 0 else None


def _schema_types(node: dict) -> set[str]:
    kind = node.get("@type")
    if isinstance(kind, list):
        return {str(item) for item in kind}
    return {str(kind)} if kind else set()


def _price_and_currency(offer: dict) -> tuple[object, str | None]:
    raw = offer.get("price")
    currency = offer.get("priceCurrency")
    spec = offer.get("priceSpecification")
    specs = spec if isinstance(spec, list) else [spec] if isinstance(spec, dict) else []
    for item in specs:
        if isinstance(item, dict) and item.get("price") not in (None, ""):
            if raw in (None, ""):
                raw = item.get("price")
            currency = currency or item.get("priceCurrency")
            break
    return raw, currency


def _in_stock_eur(offer: dict) -> Decimal | None:
    if not isinstance(offer, dict) or offer.get("availability") not in _IN_STOCK:
        return None
    raw, currency = _price_and_currency(offer)
    if currency != "EUR" or raw in (None, ""):
        return None
    return parse_euro_amount(raw)


def _prices_on_product(product: dict) -> set[Decimal]:
    offers = product.get("offers")
    offers = [offers] if isinstance(offers, dict) else offers if isinstance(offers, list) else []
    found: list[tuple[str | None, Decimal]] = []
    for offer in offers:
        if not isinstance(offer, dict):
            continue
        types = _schema_types(offer)
        if "AggregateOffer" in types:
            nested = offer.get("offers")
            nested = nested if isinstance(nested, list) else [nested] if isinstance(nested, dict) else []
            children = [
                (child.get("sku"), amount)
                for child in nested
                if isinstance(child, dict) and "Offer" in _schema_types(child)
                and (amount := _in_stock_eur(child)) is not None
            ]
            if children:
                found.extend(children)
                continue
            amount = _in_stock_eur(offer)
            low, high = parse_euro_amount(offer.get("lowPrice")), parse_euro_amount(offer.get("highPrice"))
            if amount is None and low is not None and (high is None or high == low):
                amount = _in_stock_eur({**offer, "price": offer.get("lowPrice")})
            if amount is not None and (high is None or high == amount):
                found.append((offer.get("sku"), amount))
        elif "Offer" in types:
            amount = _in_stock_eur(offer)
            if amount is not None:
                found.append((offer.get("sku"), amount))
    prices = {price for _, price in found}
    if len(prices) <= 1:
        return prices
    matched = {price for sku, price in found if product.get("sku") and sku == product.get("sku")}
    return matched if len(matched) == 1 else set()


def exact_stock_price(html: str) -> Decimal | None:
    """Require one explicit in-stock euro price attached to a product.

    AggregateOffer, priceSpecification.price, EU thousands (1.299,00) and a
    multi-variant page are accepted only when they collapse to a single price.
    A variant page uses the offer whose sku matches the product sku.
    """
    prices: set[Decimal] = set()
    for script in JSONLD_RE.findall(html):
        try:
            data = json.loads(script)
        except (json.JSONDecodeError, RecursionError):
            continue
        for product in _iter_nodes(data):
            if "Product" not in _schema_types(product):
                continue
            prices.update(_prices_on_product(product))
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


def product_images(html, page_url):
    found = []
    for script in JSONLD_RE.findall(html):
        try:
            data = json.loads(script)
        except (ValueError, RecursionError):
            continue
        for node in _iter_nodes(data):
            if "Product" not in _schema_types(node):
                continue
            images = node.get("image")
            for raw in images if isinstance(images, list) else [images]:
                if isinstance(raw, dict):
                    raw = raw.get("contentUrl") or raw.get("url")
                url = secure_image_url(raw, page_url)
                if url and url not in found:
                    found.append(url)
    return found


def listing_image(html, page_url):
    images = product_images(html, page_url)
    if images:
        return images[0]
    parser = ProductImage()
    parser.feed(html)
    for prop in ("og:image:secure_url", "og:image", "twitter:image"):
        url = secure_image_url(parser.urls.get(prop), page_url)
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
          history=None, traffic=None, collect_traffic=False, google_client_id="") -> int:
    site_url = site_url.rstrip("/")
    parsed = urlsplit(site_url)
    if not re.fullmatch(r"https://[a-zA-Z0-9.-]+", site_url) or not parsed.hostname:
        raise ValueError("SITE_URL must be an HTTPS origin without a path")
    if analytics_token and not re.fullmatch(r"[A-Za-z0-9_-]+", analytics_token):
        raise ValueError("Invalid public Web Analytics beacon token")
    if google_client_id and not re.fullmatch(r"[A-Za-z0-9_-]+\.apps\.googleusercontent\.com", google_client_id):
        raise ValueError("Expected a public Google web OAuth client ID")

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

    public_config = {"callbackPath": "/oauth/callback/", "googleClientId": google_client_id, "connectorUrl": "/mcp"}
    (output / "config.js").write_text("export const CONFIG = " + json.dumps(public_config) + ";\n")
    callback = output / "oauth/callback"
    callback.mkdir(parents=True)
    callback_html = (web / "oauth.html").read_text().replace('src="oauth.js"', 'src="/oauth.js"').replace('href="style.css"', 'href="/style.css"')
    (callback / "index.html").write_text(callback_html)

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
    ET.SubElement(channel, "title").text = "DealFactory | Smart home and appliance deals"
    ET.SubElement(channel, "link").text = site_url + "/" + DEALS
    ET.SubElement(channel, "description").text = "Current retailer offers verified by DealFactory."
    ET.SubElement(channel, "lastBuildDate").text = format_datetime(datetime.now(UTC))
    for offer in offers:
        item = ET.SubElement(channel, "item")
        ET.SubElement(item, "title").text = f"{offer['name']} at {offer['retailer']} · €{offer['price']}"
        ET.SubElement(item, "link").text = site_url + "/" + DEALS + "?utm_source=rss&utm_medium=feed"
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
    archived = {**context, "offers": [], "sources": []}
    (guide / "index.html").write_text(templates.get_template("footmuffs.html.j2").render(**archived), encoding="utf-8")
    homepage = output / "index.html"
    advisor = output / "advisor" / "index.html"
    advisor.parent.mkdir(parents=True, exist_ok=True)
    original = homepage.read_text(encoding="utf-8")
    if 'href="/storefront.css"' not in original and 'href="storefront.css"' not in original:
        original = original.replace("</head>", '<link rel="stylesheet" href="/storefront.css">\n</head>', 1)
    if 'class="df-advisor"' not in original:
        original = original.replace("<body>", '<body class="df-advisor">', 1)
    if "your home." not in original:
        brand = templates.get_template("storefront.html.j2").module.wordmark()
        original = original.replace('<a class="brand" href="#top">DealFactory</a>', str(brand), 1)
        original = re.sub(r"<h1>[^<]+</h1>", '<h1>Buy what fits<br><em>your home.</em></h1>', original, count=1)
    advisor.write_text(original, encoding="utf-8")
    privacy_file = output / "privacy.html"
    if privacy_file.exists():
        privacy_dir = output / "privacy"
        privacy_dir.mkdir(parents=True, exist_ok=True)
        privacy_file.replace(privacy_dir / "index.html")
    homepage.write_text(templates.get_template("home.html.j2").render(**context), encoding="utf-8")
    smarthome = output / SMARTHOME_GUIDE / "index.html"
    smarthome.parent.mkdir(parents=True)
    smarthome.write_text(templates.get_template("smarthome.html.j2").render(**context), encoding="utf-8")
    deals = output / DEALS / "index.html"
    deals.parent.mkdir(parents=True)
    deals.write_text(templates.get_template("storefront.html.j2").render(deals=True, **context), encoding="utf-8")
    for page in ("about", "terms"):
        target = output / page / "index.html"
        target.parent.mkdir(parents=True)
        target.write_text(templates.get_template("pages.html.j2").render(page=page, **context), encoding="utf-8")
    (output / "404.html").write_text(templates.get_template("pages.html.j2").render(page="404", **context), encoding="utf-8")
    public_pages = (homepage, smarthome, deals, guide / "index.html")
    measured_pages = (
        *public_pages,
        advisor,
        output / "about/index.html",
        output / "terms/index.html",
        output / "privacy/index.html",
    )

    for page_path in public_pages:
        markup = page_path.read_text(encoding="utf-8")
        script = '<script type="module" src="/lib/guide-events.js"></script>'
        script += '<link rel="alternate" type="application/rss+xml" title="Checked offers" href="/offers.xml">'
        if collect_traffic:
            script += '<meta name="dealfactory-counts" content="aggregate">'
            markup = markup.replace("</main>", '<p class="small muted">DealFactory counts page views, guide shares, and retailer clicks in aggregate. These counters use no cookies.</p>\n</main>', 1)
        page_path.write_text(markup.replace("</head>", script + "\n</head>", 1), encoding="utf-8")
    for page_path in measured_pages:
        if page_path in public_pages:
            continue
        markup = page_path.read_text(encoding="utf-8")
        extra = '<script type="module" src="/lib/guide-events.js"></script>'
        if collect_traffic:
            extra += '<meta name="dealfactory-counts" content="aggregate">'
        page_path.write_text(markup.replace("</head>", extra + "\n</head>", 1), encoding="utf-8")
    worker = output / "_worker.js"
    worker.mkdir()
    shutil.copyfile(ROOT / "ops/pages-worker.js", worker / "index.js")
    for module in ("ops/events-worker.js", "connector/src/index.js", "web/lib/context.js", "web/lib/ground.js",
                   "web/lib/location.js", "web/lib/tz.js"):
        target = worker / module
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / module, target)
    routes = ["/mcp", "/events"] if collect_traffic else ["/mcp"]
    (output / "_routes.json").write_text(json.dumps({"version": 1, "include": routes, "exclude": []}))
    if analytics_token:
        beacon = (
            f'<script defer src="{ANALYTICS_SCRIPT}" '
            f'data-cf-beacon=\'{{"token":"{analytics_token}"}}\'></script>'
        )
        for page in measured_pages:
            html = page.read_text(encoding="utf-8")
            html = html.replace("script-src 'self';", f"script-src 'self' {ANALYTICS_SCRIPT};")
            page.write_text(html.replace("</body>", f"{beacon}\n</body>", 1), encoding="utf-8")

    (output / "_headers").write_text(
        "/*\n"
        "  Content-Security-Policy: frame-ancestors 'none'; object-src 'none'; base-uri 'none'\n"
        "  Strict-Transport-Security: max-age=31536000; includeSubDomains\n"
        "  X-Frame-Options: DENY\n"
        "  X-Content-Type-Options: nosniff\n"
        "  Referrer-Policy: strict-origin-when-cross-origin\n"
        "  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()\n"
        "/config.js\n  Cache-Control: no-store\n"
        "/oauth\n  X-Robots-Tag: noindex\n/oauth.html\n  X-Robots-Tag: noindex\n"
        "/oauth/callback/*\n  X-Robots-Tag: noindex\n  Cache-Control: no-store\n  Referrer-Policy: no-referrer\n",
        encoding="utf-8",
    )
    (output / "_redirects").write_text(
        "/advisor.html /advisor/ 301\n/privacy.html /privacy/ 301\n/advisor /advisor/ 301\n/privacy /privacy/ 301\n",
        encoding="utf-8",
    )
    (output / "robots.txt").write_text(f"User-agent: *\nSitemap: {site_url}/sitemap.xml\n")
    lastmod = today.isoformat()
    (output / "sitemap.xml").write_text(
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
        + "".join(
            f"<url><loc>{escape(site_url + path)}</loc><lastmod>{lastmod}</lastmod></url>" for path in SITEMAP
        )
        + "</urlset>\n", encoding="utf-8"
    )
    print(f"Retailer pages checked: {len(candidates)}. New product links found: {len(candidates) - len(sources)}.")
    print(f"Guide layout: {'prices first' if show_offers_first else 'compatibility first'}.")
    if offers:
        print(f"Organic campaign draft: Compare {len(offers)} checked smart-home and appliance "
              f"{'offer' if len(offers) == 1 else 'offers'} for shoppers in the Netherlands and EU. "
              f"{site_url}/{DEALS}?utm_source=campaign&utm_medium=organic")
    return len(offers)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    parser.add_argument("--site-url", required=True)
    parser.add_argument("--refresh", action="store_true")
    parser.add_argument("--analytics-token", default="")
    parser.add_argument("--google-client-id", default="")
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
                      history=history, traffic=traffic, collect_traffic=bool(args.traffic_file), google_client_id=args.google_client_id)
    print(f"Verified in-stock offers: {count}")


if __name__ == "__main__":
    main()
