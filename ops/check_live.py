"""Verify the deployed release through the public site, allowing for edge propagation."""
import json
from html import unescape
import re
from pathlib import Path
import sys
import time
from urllib.request import urlopen

root = Path(sys.argv[1])
origin = sys.argv[2].rstrip("/")
expected = json.loads((root / "offer-history.json").read_text())
guide_file = root / "guides/stroller-footmuffs/index.html"
expected_title = unescape(re.search(r"<title>([^<]+)</title>", guide_file.read_text()).group(1))
for attempt in range(8):
    try:
        with urlopen(origin + "/offer-history.json", timeout=15) as response:
            if json.load(response) != expected:
                raise ValueError("Offer history differs from this release")
        with urlopen(origin + "/guides/stroller-footmuffs/", timeout=15) as response:
            guide = response.read().decode()
        if 'id="share-guide"' not in guide or origin + "/guides/stroller-footmuffs/" not in guide:
            raise ValueError("Guide assets or canonical URL differ from this release")
        live_title = re.search(r"<title>([^<]+)</title>", guide)
        if not live_title or unescape(live_title.group(1)) != expected_title:
            raise ValueError("Live title differs from the editorial release")
        with urlopen(origin + "/offers.xml", timeout=15) as response:
            if response.read() != (root / "offers.xml").read_bytes():
                raise ValueError("Live offer feed differs from this release")
        print(f"Public release verified at {origin}. Live title: {expected_title}")
        break
    except (OSError, ValueError):
        if attempt == 7:
            raise
        time.sleep(5)
