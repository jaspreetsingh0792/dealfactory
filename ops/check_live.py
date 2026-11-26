"""Verify the deployed release through the public site, allowing for edge propagation."""
import json
from html import unescape
import re
from pathlib import Path
import sys
import time
import subprocess

root = Path(sys.argv[1])
origin = sys.argv[2].rstrip("/")
expected = json.loads((root / "offer-history.json").read_text())
guide_file = root / "guides/stroller-footmuffs/index.html"
expected_title = unescape(re.search(r"<title>([^<]+)</title>", guide_file.read_text()).group(1))
def read_route(path):
    return subprocess.check_output([
        "curl", "--fail", "--silent", "--show-error", "--location", "--max-time", "15",
        origin + path
    ])


for attempt in range(8):
    try:
        home = read_route("/").decode()
        if 'id="cover-title"' not in home or 'href="/advisor.html"' not in home:
            raise ValueError("The redesigned storefront or shopping advisor link is missing")
        advisor = read_route("/advisor.html")
        for marker in (b'need-form', b'or-signin', b'gm-connect', b'open-chatgpt', b'open-claude'):
            if b'id="' + marker + b'"' not in advisor:
                raise ValueError("The shopping advisor connection controls are missing")
        if b'src="/oauth.js"' not in read_route("/oauth/callback/"):
            raise ValueError("The OAuth callback is missing")
        if b"Gmail receipt import" not in read_route("/privacy"):
            raise ValueError("The advisor privacy information is missing")
        rpc = {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}
        response = subprocess.check_output(["curl", "-fsS", "--max-time", "15", "-H", "Content-Type: application/json",
                                            "-H", "Accept: application/json, text/event-stream", "--data", json.dumps(rpc), origin + "/mcp"])
        if {tool["name"] for tool in json.loads(response).get("result", {}).get("tools", [])} != {"verify_on_page", "get_shopping_rules"}:
            raise ValueError("The public MCP connector did not advertise its shopping tools")
        for asset in ("media/winter-walk.webp", "storefront.css", "lib/storefront.js", "config.js", "oauth.js", "app.js", "lib/oauth.js"):
            if read_route("/" + asset) != (root / asset).read_bytes():
                raise ValueError(f"The live storefront asset differs from this release: {asset}")
        if json.loads(read_route("/offer-history.json")) != expected:
            raise ValueError("Offer history differs from this release")
        guide = read_route("/guides/stroller-footmuffs/").decode()
        if 'id="share-guide"' not in guide or origin + "/guides/stroller-footmuffs/" not in guide:
            raise ValueError("Guide assets or canonical URL differ from this release")
        live_title = re.search(r"<title>([^<]+)</title>", guide)
        if not live_title or unescape(live_title.group(1)) != expected_title:
            raise ValueError("Live title differs from the editorial release")
        if read_route("/offers.xml") != (root / "offers.xml").read_bytes():
            raise ValueError("Live offer feed differs from this release")
        print(f"Public release verified at {origin}. Live title: {expected_title}")
        break
    except (OSError, ValueError, subprocess.CalledProcessError):
        if attempt == 7:
            raise
        time.sleep(5)
