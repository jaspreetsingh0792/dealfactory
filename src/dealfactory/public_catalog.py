"""Find current product links in the retailer's stroller-footmuff department."""
from html.parser import HTMLParser
import json
import re
from urllib.parse import urljoin, urlsplit

from .fetch import JSONLD_RE, _iter_nodes

CATEGORY = "https://www.babycare.nl/en/strollers/stroller-accessories/footmuffs.html"


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
    departments = (
        ("https://koeka.com/nl/collections/buggy-voetenzakken", "Koeka",
         r"/nl/products/(?:buggy|kinderwagen)-voetenzak-[a-z0-9-]+"),
        (CATEGORY, "Babycare", r"/en/[a-z0-9-]*(?:footmuff|voetenzak)[a-z0-9-]*\.html"),
        ("https://jollein.nl/collections/voetenzakken", "Jollein",
         r"/products/voetenzak-[a-z0-9-]*(?:buggy|kinderwagen)[a-z0-9-]*"),
    )
    candidates = []
    for category, retailer, pattern in departments:
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
        if re.search(r"footmuff|voetenzak", name, re.I):
            return name[:180]
    return None
