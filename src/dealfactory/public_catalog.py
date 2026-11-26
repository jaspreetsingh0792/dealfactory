"""Find current smart-home and appliance links in retailer departments."""
from html.parser import HTMLParser
import json
import re
from urllib.parse import urljoin, urlsplit

from .fetch import JSONLD_RE, _iter_nodes

DEPARTMENTS = (
    ("https://www.coolblue.nl/thermostaten/tado/tado-x", "Coolblue",
     r"/product/\d+/tado-[a-z0-9-]+\.html"),
    ("https://www.coolblue.nl/bridges/philips-hue", "Coolblue",
     r"/product/\d+/philips-hue-[a-z0-9-]+\.html"),
    ("https://eu.aqara.com/en-eu/collections/all", "Aqara",
     r"/en-eu/products/[a-z0-9-]+"),
)
CATEGORY = DEPARTMENTS[0][0]
BABY_GEAR = re.compile(r"footmuff|voetenzak|stroller|buggy|kinderwagen", re.I)


class ProductLinks(HTMLParser):
    def __init__(self, category, pattern):
        super().__init__()
        self.category = category
        self.pattern = pattern
        self.urls = []

    def handle_starttag(self, tag, attrs):
        href = dict(attrs).get("href")
        if tag != "a" or not href:
            return
        url = urlsplit(urljoin(self.category, href))
        if (url.scheme == "https" and url.netloc == urlsplit(self.category).netloc and
                re.fullmatch(self.pattern, url.path)):
            clean = url._replace(query="", fragment="").geturl()
            if clean not in self.urls:
                self.urls.append(clean)


def discover(fetcher, known):
    candidates = []
    for category, retailer, pattern in DEPARTMENTS:
        result = fetcher.get(category)
        if not result or result[0] != 200:
            continue
        parser = ProductLinks(category, pattern)
        parser.feed(result[1])
        urls = [url for url in parser.urls if url not in known][:6]
        candidates.extend({"url": url, "retailer": retailer, "discovered": True} for url in urls)
    return candidates


def product_name(html):
    names = set()
    for raw in JSONLD_RE.findall(html):
        try:
            data = json.loads(raw)
        except (ValueError, RecursionError):
            continue
        for node in _iter_nodes(data):
            kind = node.get("@type")
            if kind == "Product" or isinstance(kind, list) and "Product" in kind:
                name = node.get("name")
                if isinstance(name, str) and name.strip():
                    names.add(name.strip())
    if len(names) == 1:
        name = names.pop()
        if not BABY_GEAR.search(name):
            return name[:180]
    return None
