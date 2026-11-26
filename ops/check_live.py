"""Verify the deployed release through the public site, allowing for edge propagation."""
import json
from pathlib import Path
import sys
import time
from urllib.request import urlopen

root = Path(sys.argv[1])
origin = sys.argv[2].rstrip("/")
expected = json.loads((root / "offer-history.json").read_text())
for attempt in range(8):
    try:
        with urlopen(origin + "/offer-history.json", timeout=15) as response:
            if json.load(response) != expected:
                raise ValueError("Offer history differs from this release")
        with urlopen(origin + "/guides/stroller-footmuffs/", timeout=15) as response:
            guide = response.read().decode()
        if 'id="share-guide"' not in guide or origin + "/guides/stroller-footmuffs/" not in guide:
            raise ValueError("Guide assets or canonical URL differ from this release")
        print("Public release verified at", origin)
        break
    except (OSError, ValueError):
        if attempt == 7:
            raise
        time.sleep(5)
