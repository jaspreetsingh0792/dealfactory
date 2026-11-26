"""Select an evidence-supported editorial angle for the guide and its share card."""
import argparse
import json
from pathlib import Path
from urllib.request import Request, urlopen
from xml.etree import ElementTree as ET
from html import escape
from html.parser import HTMLParser

OPTIONS = {
    "fit": (
        "Which stroller footmuff fits? A Netherlands buying guide",
        "Check stroller model, harness openings and delivery terms before choosing a footmuff from a Dutch retailer.",
    ),
    "compare": (
        "Compare stroller footmuff prices in the Netherlands",
        "Compare checked euro prices for in-stock stroller footmuffs, then confirm the fit and delivery cost at the retailer.",
    ),
    "price_drop": (
        "Stroller footmuff price drops in the Netherlands",
        "See which checked stroller footmuff prices have fallen since an earlier observation, with links to the retailer.",
    ),
}


class GuideHead(HTMLParser):
    def __init__(self):
        super().__init__()
        self.description = None
        self.share_title = None
        self.share_description = None

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        if tag == "meta":
            if values.get("name") == "description":
                self.description = self.get_starttag_text()
            elif values.get("property") == "og:title":
                self.share_title = self.get_starttag_text()
            elif values.get("property") == "og:description":
                self.share_description = self.get_starttag_text()


def eligible_angles(offer_count, has_drop):
    angles = ["fit"]
    if offer_count >= 2:
        angles.append("compare")
    if offer_count and has_drop:
        angles.append("price_drop")
    return angles


def choose(angles, offer_count, layout):
    grammar = "root ::= " + " | ".join(json.dumps(value) for value in angles)
    prompt = (
        "<|im_start|>system\nYou are the shopping guide editor. Choose one useful editorial angle "
        "for today's Netherlands stroller footmuff guide and its promotional card. "
        "Prefer a real price drop when available. Compare multiple offers when prices are the focus. "
        "Use fit when compatibility is the most useful topic.<|im_end|>\n"
        f"<|im_start|>user\nVerified offers: {offer_count}. Layout: {layout}. "
        f"Available angles: {', '.join(angles)}.<|im_end|>\n<|im_start|>assistant\n"
    )
    payload = {"prompt": prompt, "grammar": grammar, "n_predict": 12, "temperature": 0, "seed": 1}
    req = Request("http://127.0.0.1:18082/completion", data=json.dumps(payload).encode(),
                  headers={"Content-Type": "application/json"})
    with urlopen(req, timeout=75) as response:
        choice = json.load(response)["content"].strip()
    if choice not in angles:
        raise ValueError("Editor returned an unsupported angle")
    return choice


def edit(output):
    guide = output / "guides/stroller-footmuffs/index.html"
    html = guide.read_text()
    feed = ET.parse(output / "offers.xml")
    count = len(feed.findall("./channel/item"))
    angles = eligible_angles(count, " · previously €" in html)
    layout = "offers first" if html.index("Checked retailer offers") < html.index("What to check") else "fit first"
    choice = choose(angles, count, layout)
    title, description = OPTIONS[choice]
    head = GuideHead()
    head.feed(html)
    if not all((head.description, head.share_title, head.share_description)):
        raise ValueError("Guide metadata is incomplete")
    title_with_brand = escape(title + " | DealFactory")
    start = html.index("<title>")
    end = html.index("</title>", start) + len("</title>")
    html = html[:start] + f"<title>{title_with_brand}</title>" + html[end:]
    html = html.replace(head.description, f'<meta name="description" content="{escape(description)}">', 1)
    html = html.replace(head.share_title, f'<meta property="og:title" content="{title_with_brand}">', 1)
    html = html.replace(head.share_description, f'<meta property="og:description" content="{escape(description)}">', 1)
    guide.write_text(html)
    print(f"Editorial agent applied the {choice} angle to the search title, description and social preview.")
    print(f"Campaign draft: {title}. {description} {feed.findtext('./channel/link')}?utm_source=campaign&utm_medium=organic")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("directory", type=Path)
    edit(parser.parse_args().directory)
