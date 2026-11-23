"""Turn emails, PDFs and text files into plain-text Documents, in memory only."""

from __future__ import annotations

import email
import email.policy
import hashlib
import html
import io
import mailbox
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from email.utils import parseaddr, parsedate_to_datetime
from html.parser import HTMLParser
from pathlib import Path
from typing import Iterator

MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024


@dataclass
class Document:
    kind: str                     # "email" | "receipt"
    ref: str                      # sha256 of the Gmail id / file bytes - never the content
    text: str
    date: str | None = None       # YYYY-MM-DD
    sender_domain: str | None = None
    subject: str | None = None    # used in the prompt only, never stored
    attachments: list[str] = field(default_factory=list)  # extracted text of PDF attachments

    @property
    def full_text(self) -> str:
        parts = [self.text] + [f"--- attached PDF ---\n{a}" for a in self.attachments]
        return "\n\n".join(p for p in parts if p.strip())


def sha(data: bytes | str) -> str:
    return hashlib.sha256(data.encode() if isinstance(data, str) else data).hexdigest()


class _TextExtractor(HTMLParser):
    BLOCK = {"p", "div", "br", "tr", "li", "h1", "h2", "h3", "h4", "table", "section", "td", "th"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style", "head", "title"):
            self._skip += 1
        elif tag in self.BLOCK:
            self.parts.append("\n" if tag != "td" and tag != "th" else " | ")

    def handle_endtag(self, tag):
        if tag in ("script", "style", "head", "title") and self._skip:
            self._skip -= 1
        elif tag in ("p", "div", "tr", "table", "li"):
            self.parts.append("\n")

    def handle_data(self, data):
        if not self._skip:
            self.parts.append(data)


def html_to_text(markup: str) -> str:
    p = _TextExtractor()
    p.feed(markup)
    text = html.unescape("".join(p.parts)).replace("\xa0", " ")
    lines = [re.sub(r"[ \t]+", " ", ln).strip(" |") for ln in text.split("\n")]
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


def pdf_text(data: bytes) -> str:
    from pypdf import PdfReader

    try:
        reader = PdfReader(io.BytesIO(data))
        return "\n".join((page.extract_text() or "") for page in reader.pages[:10]).strip()
    except Exception:  # damaged or encrypted PDF
        return ""


def domain_of(address: str | None) -> str | None:
    _, addr = parseaddr(address or "")
    if "@" not in addr:
        return None
    dom = addr.rsplit("@", 1)[1].lower()
    # mail.bol.com, email.coolblue.nl -> keep the registrable-looking tail
    bits = dom.split(".")
    return ".".join(bits[-3:]) if len(bits) > 2 and bits[-2] in ("co", "com") else ".".join(bits[-2:])


def _date(value) -> str | None:
    try:
        d = parsedate_to_datetime(value) if isinstance(value, str) else value
        return d.astimezone(timezone.utc).date().isoformat()
    except Exception:
        return None


def from_email_message(msg: email.message.Message, ref: str) -> Document:
    """Body text (plain preferred, else HTML) plus text of PDF attachments."""
    plain, htmls, pdfs = [], [], []
    for part in msg.walk():
        if part.is_multipart():
            continue
        ctype = part.get_content_type()
        fname = (part.get_filename() or "").lower()
        payload = part.get_payload(decode=True) or b""
        if ctype == "application/pdf" or fname.endswith(".pdf"):
            if len(payload) <= MAX_ATTACHMENT_BYTES:
                pdfs.append(pdf_text(payload))
            continue
        if part.get_content_disposition() == "attachment":
            continue
        charset = part.get_content_charset() or "utf-8"
        text = payload.decode(charset, errors="replace")
        (plain if ctype == "text/plain" else htmls if ctype == "text/html" else []).append(text)
    body = "\n".join(plain).strip() if plain and len("".join(plain).strip()) > 200 else ""
    if not body and htmls:
        body = html_to_text("\n".join(htmls))
    if not body:
        body = "\n".join(plain)
    return Document(kind="email", ref=ref, text=body, date=_date(msg.get("Date")),
                    sender_domain=domain_of(msg.get("From")), subject=str(msg.get("Subject") or "")[:200],
                    attachments=[p for p in pdfs if p])


def load_files(paths: list[Path]) -> Iterator[Document]:
    """.eml / .mbox (e.g. Google Takeout) / .pdf receipts / .txt / .html."""
    for path in paths:
        if path.is_dir():
            yield from load_files(sorted(p for p in path.rglob("*") if p.is_file()))
            continue
        suffix = path.suffix.lower()
        if suffix == ".mbox":
            for i, msg in enumerate(mailbox.mbox(path)):
                mid = msg.get("Message-ID") or f"{path.name}:{i}"
                yield from_email_message(msg, sha("mbox:" + mid))
            continue
        data = path.read_bytes()
        if suffix == ".eml":
            msg = email.message_from_bytes(data, policy=email.policy.default)
            yield from_email_message(msg, sha(data))
        elif suffix == ".pdf":
            mtime = datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).date().isoformat()
            yield Document(kind="receipt", ref=sha(data), text=pdf_text(data), date=mtime)
        elif suffix in (".txt", ".html", ".htm"):
            text = data.decode("utf-8", errors="replace")
            mtime = datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).date().isoformat()
            yield Document(kind="receipt", ref=sha(data),
                           text=html_to_text(text) if suffix != ".txt" else text, date=mtime)
