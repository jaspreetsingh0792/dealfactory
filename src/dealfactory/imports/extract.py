"""Extract purchased items from one document with Claude, then ground them in the document text."""

from __future__ import annotations

import re
from datetime import date

from ..fetch import price_in_text
from ..llm import LLM, _norm
from ..models import Purchase, PurchaseDraft, now_utc
from ..stages._common import slugify
from .documents import Document, sha
from .redact import redact

SYSTEM = """\
You read one shopping document (an order confirmation, shipping notice, invoice, return confirmation or a
shop receipt) and list the products in it, for the user's private inventory of things they own and buy.

Rules:
- Use only what is written in the document. Never guess a brand, model or price that is not written.
- product_name and quote are copied verbatim from the document; quote is the line naming the product.
- brand / model / variant: fill only if those exact words are in the document, otherwise null.
- unit_price: the price per item exactly as shown (as a number, e.g. 1299.0); null if no price is shown.
- category: short generic English slug (robot-vacuum, stroller, footmuff, diapers, tv, phone-case ...).
- kind: durable (appliances, electronics, furniture, strollers, tools), accessory (for something owned:
  cases, footmuffs, filters, cables), consumable (food, diapers, cleaning products, cosmetics), clothing,
  service (subscriptions, delivery fees, warranties), gift_card, other. Skip shipping/payment fee lines.
- is_purchase=false for marketing, newsletters, price alerts, wishlists, abandoned carts, review requests
  and anything that is not about a concrete order. Then return no items.
- For returns and cancellations, set doc_type accordingly and list the returned/cancelled items.
- Placeholders like [address], [email], [ref], [name] hide personal data; ignore them.
"""


def build_prompt(doc: Document, text: str) -> str:
    meta = [f"Document kind: {doc.kind}"]
    if doc.sender_domain:
        meta.append(f"Sender domain: {doc.sender_domain}")
    if doc.date:
        meta.append(f"Received: {doc.date}")
    if doc.subject:
        meta.append(f"Subject: {redact(doc.subject)}")
    return "\n".join(meta) + "\n\nDOCUMENT\n" + text


def _in(needle: str | None, haystack_norm: str) -> bool:
    return bool(needle) and _norm(needle) in haystack_norm


def _plausible_date(value: str | None, fallback: str | None) -> str | None:
    if value and re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        try:
            d = date.fromisoformat(value)
        except ValueError:
            return fallback
        if fallback:
            if abs((date.fromisoformat(fallback) - d).days) <= 90:
                return value
            return fallback
        if date(2000, 1, 1) <= d <= date.today():
            return value
    return fallback


def ground(draft: PurchaseDraft, doc: Document, text: str, user_id: str) -> list[Purchase]:
    """Keep only items whose quote is in the (redacted) text; drop brand/model/price not found there."""
    if not draft.is_purchase or draft.doc_type == "other":
        return []
    tn = _norm(text)
    merchant = draft.merchant if _in(draft.merchant, tn) else None
    merchant = merchant or doc.sender_domain or (draft.merchant if doc.kind == "receipt" else None)
    order_date = _plausible_date(draft.order_date, doc.date)
    out: list[Purchase] = []
    for i, it in enumerate(draft.items):
        if not _in(it.quote, tn):
            continue  # not in the document: invented or paraphrased
        name = it.product_name if _in(it.product_name, tn) else it.quote.strip()
        verified = it.unit_price is not None and price_in_text(it.unit_price, it.quote) or (
            it.unit_price is not None and price_in_text(it.unit_price, text))
        out.append(Purchase(
            id=f"{slugify(merchant or 'shop', name)[:50]}-{sha(doc.ref + str(i))[:6]}",
            user_id=user_id, source_kind="receipt" if doc.kind == "receipt" else "email", source_ref=doc.ref,
            doc_type=draft.doc_type, merchant=merchant, order_date=order_date, product_name=name[:200],
            brand=it.brand if _in(it.brand, tn) else None,
            model=it.model if _in(it.model, tn) else None,
            variant=it.variant if _in(it.variant, tn) else None,
            category=slugify(it.category) or "other", kind=it.kind, quantity=max(1, it.quantity),
            unit_price=it.unit_price if verified else None,
            currency=(draft.currency or "EUR") if verified else None,
            price_verified=bool(verified), extracted_at=now_utc(),
        ))
    return out


def extract(doc: Document, llm: LLM, user_id: str, effort: str = "low",
            extra_terms: list[str] | None = None) -> list[Purchase]:
    text = redact(doc.full_text, extra_terms)
    audit = (f"<document omitted for privacy: {doc.kind} from {doc.sender_domain or 'file'} "
             f"{doc.date or ''}, {len(text)} chars after redaction, ref {doc.ref[:12]}>")
    draft = llm.structured("import", SYSTEM, build_prompt(doc, text), PurchaseDraft, effort=effort,
                           max_tokens=8000, audit_prompt=audit)
    return ground(draft, doc, text, user_id)
