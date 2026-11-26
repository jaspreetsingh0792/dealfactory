"""Polite direct fetching, used only to double-check offer prices.

Rules: robots.txt is honoured, one request per host every few seconds,
an honest User-Agent, responses cached on disk, and nothing is retried
aggressively. If a retailer blocks automated access (403, captcha) we
accept that and fall back to what Claude's web_fetch read from the page.
"""

from __future__ import annotations

import hashlib
import json
import re
import time
import urllib.robotparser
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlparse

import httpx

JSONLD_RE = re.compile(r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>', re.S | re.I)


@dataclass
class PoliteFetcher:
    cache_dir: Path
    user_agent: str
    min_interval: float = 4.0
    cache_seconds: int = 6 * 3600
    _last: dict[str, float] = field(default_factory=dict)
    _robots: dict[str, urllib.robotparser.RobotFileParser | None] = field(default_factory=dict)

    def _client(self) -> httpx.Client:
        return httpx.Client(
            headers={"User-Agent": self.user_agent, "Accept-Language": "nl-NL,nl;q=0.9,en;q=0.8"},
            timeout=20, follow_redirects=True,
        )

    def _wait(self, host: str) -> None:
        last = self._last.get(host)
        if last is not None:
            delta = time.monotonic() - last
            if delta < self.min_interval:
                time.sleep(self.min_interval - delta)
        self._last[host] = time.monotonic()

    def allowed(self, url: str) -> bool:
        parts = urlparse(url)
        host = f"{parts.scheme}://{parts.netloc}"
        if host not in self._robots:
            rp = urllib.robotparser.RobotFileParser()
            try:
                self._wait(parts.netloc)
                with self._client() as c:
                    r = c.get(f"{host}/robots.txt")
                if r.status_code >= 400:
                    # An absent file permits crawling. Back off on transient errors and access denials.
                    rp.parse([] if r.status_code in (404, 410) else ["User-agent: *", "Disallow: /"])
                else:
                    rp.parse(r.text.splitlines())
                self._robots[host] = rp
            except httpx.HTTPError:
                self._robots[host] = None
        rp = self._robots[host]
        return bool(rp and rp.can_fetch(self.user_agent, url))

    def get(self, url: str) -> tuple[int, str] | None:
        """Return (status, html) or None if robots.txt forbids it / network failed."""
        key = hashlib.sha256(url.encode()).hexdigest()[:24]
        path = self.cache_dir / "http" / f"{key}.json"
        if path.exists() and time.time() - path.stat().st_mtime < self.cache_seconds:
            data = json.loads(path.read_text())
            return data["status"], data["body"]
        if not self.allowed(url):
            return None
        self._wait(urlparse(url).netloc)
        try:
            with self._client() as c:
                r = c.get(url)
        except httpx.HTTPError:
            return None
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"url": url, "status": r.status_code, "body": r.text[:2_000_000]}))
        return r.status_code, r.text


def _iter_nodes(obj):
    if isinstance(obj, list):
        for x in obj:
            yield from _iter_nodes(x)
    elif isinstance(obj, dict):
        yield obj
        for k in ("@graph", "offers", "itemOffered", "mainEntity"):
            if k in obj:
                yield from _iter_nodes(obj[k])


def _types(node: dict) -> set[str]:
    t = node.get("@type")
    return set(t) if isinstance(t, list) else {t} if t else set()


def extract_jsonld_offer(html: str) -> dict | None:
    """Find a schema.org Product/Offer in the page. Returns name, price, currency, availability."""
    for raw in JSONLD_RE.findall(html):
        try:
            data = json.loads(raw.strip())
        except json.JSONDecodeError:
            continue
        name = None
        for node in _iter_nodes(data):
            types = _types(node)
            if "Product" in types:
                name = node.get("name") or name
            if types & {"Offer", "AggregateOffer"}:
                price = node.get("price", node.get("lowPrice"))
                if price is None and isinstance(node.get("priceSpecification"), dict):
                    price = node["priceSpecification"].get("price")
                if price is None:
                    continue
                try:
                    price_f = float(str(price).replace(",", "."))
                except ValueError:
                    continue
                avail = str(node.get("availability") or "")
                return {
                    "name": name,
                    "price": price_f,
                    "currency": node.get("priceCurrency") or "EUR",
                    "in_stock": None if not avail else ("InStock" in avail or "LimitedAvailability" in avail),
                    "availability": avail.rsplit("/", 1)[-1] or None,
                }
    return None


PRICE_TOKEN = re.compile(r"\d[\d.,\s]*")


def price_in_text(price: float, text: str | None) -> bool:
    """True if `price` is visibly written in `text` (handles 1.299,00 / 1299 / 299,- / 299.99)."""
    if not text:
        return False
    for token in PRICE_TOKEN.findall(text):
        t = token.strip().replace(" ", "")
        candidates = set()
        if "," in t:  # Dutch: 1.299,00 or 299,-
            candidates.add(t.replace(".", "").replace(",", "."))
        candidates.add(t.replace(",", ""))
        for c in candidates:
            c = c.rstrip(".")
            try:
                if abs(float(c) - price) < 0.005:
                    return True
            except ValueError:
                continue
    return False
