from pathlib import Path
from datetime import UTC, datetime, timedelta
import json
import sqlite3
import sys

from dealfactory.public_catalog import CATEGORY

OPS = Path(__file__).resolve().parents[1] / "ops"
sys.path.insert(0, str(OPS))
from build_public import build
from traffic import CREATE_TABLE


def test_discover_check_and_compare(tmp_path):
    url = "https://www.coolblue.nl/product/999001/tado-example-thermostat.html"
    class Fetcher:
        def get(self, requested):
            if requested == CATEGORY:
                return 200, f'<a href="{url}?ref=sale">Product</a><a href="https://other.example/footmuff.html">Other</a>'
            if requested == url:
                info = {"@type": "Product", "name": "Example thermostat", "offers": {
                    "@type": "Offer", "availability": "InStock", "priceCurrency": "EUR", "price": "20"}}
                return 200, '<script type="application/ld+json">' + json.dumps(info) + "</script>"
            return None

    yesterday = (datetime.now(UTC).date() - timedelta(days=1)).isoformat()
    output = tmp_path / "release"
    assert build(output, "https://example.com", Fetcher(), history={url: {yesterday: "23.00"}},
                 traffic=[{"page": "footmuffs", "event": "view", "n": 50}], collect_traffic=True) == 1
    deals = (output / "deals/index.html").read_text()
    assert "previously €23,00" in deals and "Example thermostat" in deals
    assert not (output / "guides/stroller-footmuffs/index.html").exists()
    assert "/guides/stroller-footmuffs/ /deals/ 301" in (output / "_redirects").read_text()
    assert (output / "_worker.js").exists()
    assert json.loads((output / "_routes.json").read_text())["include"] == ["/mcp", "/auth/*", "/api/*", "/events"]


def test_atomic_counts():
    db = sqlite3.connect(":memory:")
    db.execute(CREATE_TABLE)
    for _ in range(2):
        db.execute("INSERT INTO daily_events VALUES('2026-11-26','view','home',1) "
                   "ON CONFLICT(day,event,page) DO UPDATE SET total=total+1")
    assert db.execute("SELECT total FROM daily_events").fetchone() == (2,)
