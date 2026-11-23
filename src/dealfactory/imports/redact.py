"""Best-effort removal of personal details before a document is sent to Claude.

Purchase extraction only needs shop, date, product lines and prices. Everything that
identifies the user (email addresses, phone numbers, delivery address, IBAN, card digits,
order/tracking numbers and links that carry tokens) is replaced with a placeholder first.
This is a safety net, not a guarantee: the extracted fields are what gets stored, never the text.
"""

from __future__ import annotations

import re

MAX_CHARS = 12000

EMAIL = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
URL = re.compile(r"(?:https?://|www\.)\S+", re.I)
PHONE = re.compile(r"(?<![\w€])(?:\+|00)\d{1,3}[\s-]?\(?\d\)?(?:[\s-]?\d){7,10}(?!\d)|(?<![\w€,.])0\d(?:[\s-]?\d){8}(?!\d)")
IBAN = re.compile(r"\b[A-Z]{2}\d{2}\s?[A-Z]{4}(?:\s?\d){10}\b")
CARD = re.compile(r"(?:\*{2,}|x{4,}|•{2,})\s?\d{4}\b|(?:eindigend op|ending in|ending with)\s+\d{4}", re.I)
# "Bestelnummer: 123-4567890-1234567", "Order #A1B2C3", "Track & Trace: 3SABCD123"
REF_LABEL = re.compile(
    r"((?:order|bestel|factuur|invoice|klant|customer|account|track(?:ing)?|zending|pakket|transactie|"
    r"referentie|reference|bon|receipt)[\w &-]{0,20}?(?:nummer|number|nr|no|id|code|#)?\.?\s*[:#]\s*)([A-Z0-9][\w-]{3,})",
    re.I,
)
LONG_NUMBER = re.compile(r"\b\d{9,}\b|\b\d{3}-\d{7}-\d{7}\b")
GREETING = re.compile(r"^(\s*(?:beste|hallo|hoi|hi|hello|dear|geachte|goedemiddag|goedemorgen|goedenavond)\s+)([^\n,!]{1,40})",
                      re.I | re.M)
ADDRESS_HEADER = re.compile(
    r"^\s*(?:bezorg|aflever|verzend|factuur|lever|post)?(?:adres|address)\b.*$|"
    r"^\s*(?:shipping|delivery|billing|invoice|ship to|deliver to|bill to)\b.*$", re.I)
POSTCODE_CITY = re.compile(r"^\s*\d{4}\s?[A-Z]{2}\b[\s,]+[A-Za-zÀ-ÿ' .-]{2,40}$")
STREET = re.compile(r"^\s*[A-Za-zÀ-ÿ' .-]{3,40}\s\d{1,5}\s?[a-zA-Z]?(?:[-/ ]\d{1,4}[a-zA-Z]?)?\s*$")


def _redact_address_blocks(lines: list[str]) -> list[str]:
    out = list(lines)
    # 1. Up to 4 non-empty lines after an "address" heading.
    for i, line in enumerate(lines):
        if ADDRESS_HEADER.match(line) and len(line) < 60:
            taken, j = 0, i + 1
            while j < len(lines) and taken < 4:
                if lines[j].strip():
                    out[j] = "[address]"
                    taken += 1
                elif taken:
                    break
                j += 1
    # 2. "1234 AB City" lines, plus the street and name lines just above them.
    for i, line in enumerate(lines):
        if POSTCODE_CITY.match(line):
            out[i] = "[address]"
            for k in (i - 1, i - 2):
                if k >= 0 and (STREET.match(lines[k]) or (k == i - 2 and STREET.match(lines[i - 1]) and
                                                         len(lines[k].split()) <= 4 and not re.search(r"\d", lines[k]))):
                    out[k] = "[address]"
    return out


def redact(text: str, extra_terms: list[str] | None = None) -> str:
    """Return `text` with personal details replaced. `extra_terms` (e.g. the user's name) are removed too."""
    t = text.replace("\r\n", "\n").replace("\r", "\n")
    for term in extra_terms or []:
        if term and len(term) >= 3:
            t = re.sub(re.escape(term), "[name]", t, flags=re.I)
    t = EMAIL.sub("[email]", t)
    t = URL.sub("[link]", t)
    t = IBAN.sub("[iban]", t)
    t = CARD.sub("[card]", t)
    t = REF_LABEL.sub(lambda m: m.group(1) + "[ref]", t)
    t = LONG_NUMBER.sub("[number]", t)
    t = PHONE.sub("[phone]", t)
    t = GREETING.sub(lambda m: m.group(1) + "[name]", t)
    t = "\n".join(_redact_address_blocks(t.split("\n")))
    t = re.sub(r"\n{3,}", "\n\n", t)
    t = re.sub(r"[ \t]{2,}", " ", t)
    return t[:MAX_CHARS]


PRICE_HINT = re.compile(r"€|\bEUR\b|\bUSD\b|\$|£|\b\d+,\d{2}\b|\b\d+,-")


def looks_like_it_has_prices(text: str) -> bool:
    """Cheap local gate: documents without any price are skipped and never sent to Claude."""
    return bool(PRICE_HINT.search(text))
