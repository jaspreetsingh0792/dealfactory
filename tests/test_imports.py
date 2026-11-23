"""Phase 2: offline tests for purchase import (no network, no API key)."""

from __future__ import annotations

import base64
import json
import shutil
from email.message import EmailMessage
from pathlib import Path

import httpx
import pytest
import yaml

from dealfactory import models as m
from dealfactory.config import load_settings
from dealfactory.imports import gmail
from dealfactory.imports.documents import Document, from_email_message, load_files, sha
from dealfactory.imports.redact import redact
from dealfactory.imports.run import import_documents
from dealfactory.inventory import with_imports
from dealfactory.profile import load_profile
from dealfactory.publish import build_site
from dealfactory.store import Store

REPO = Path(__file__).resolve().parents[1]


def make_pdf(lines: list[str]) -> bytes:
    content = "BT /F1 12 Tf 50 750 Td 16 TL " + " ".join(f"({ln}) Tj T*" for ln in lines) + " ET"
    objs = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R "
            "/Resources << /Font << /F1 5 0 R >> >> >>",
            f"<< /Length {len(content)} >>\nstream\n{content}\nendstream",
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    out, offsets = "%PDF-1.4\n", []
    for i, o in enumerate(objs, 1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n{o}\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n" + "".join(f"{o:010d} 00000 n \n" for o in offsets)
    out += f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n"
    return out.encode("latin-1")


def doc(ref: str, text: str, date: str, sender: str = "bol.com") -> Document:
    return Document(kind="email", ref=sha(ref), text=text, date=date, sender_domain=sender, subject="Je bestelling")


ROBO = """Beste Sanne,
Bedankt voor je bestelling bij bol.com. Bestelnummer: 4012345678
Roborock Q7 Max+ robotstofzuiger - Wit   1 x € 299,00
Bezorgadres
S. de Vries
Keizersgracht 12
1015 CS Amsterdam
Vragen? Mail klantenservice@bol.com of bel 020-1234567"""
SHIP = "Je pakket is onderweg! Roborock Q7 Max+ robotstofzuiger - Wit € 299,00 Track & Trace: 3SBOL123456"
NEWS_NOPRICE = "Nieuwsbrief: ontdek onze nieuwe collectie!"
NEWS_PRICE = "Black Friday! Alles nu vanaf €9,99"
BUGGY = "Cybex Balios S Lux kinderwagen Deep Black € 649,00 besteld op 2025-03-02"
RETURN = "Retour ontvangen: Philips Airfryer XXL HD9650 € 199,00"
AIRFRYER = "Philips Airfryer XXL HD9650 € 199,00"
DIAPER = "Pampers Baby-Dry maat 4 (82 stuks) € 24,99"


def item(name, quote, kind, cat, price=None, brand=None, model=None):
    return m.PurchaseItemDraft(product_name=name, quote=quote, brand=brand, model=model, category=cat, kind=kind,
                               unit_price=price)


def draft_for(prompt: str) -> m.PurchaseDraft:
    P = m.PurchaseDraft
    if "Bedankt voor je bestelling" in prompt:
        return P(is_purchase=True, doc_type="order_confirmation", merchant="bol.com", order_date="2026-10-01",
                 items=[item("Roborock Q7 Max+ robotstofzuiger - Wit", "Roborock Q7 Max+ robotstofzuiger - Wit",
                             "durable", "robot-vacuum", 299.0, "Roborock", "Q7 Max+"),
                        item("Ghost Mop 3000", "Ghost Mop 3000 € 49,00", "durable", "mop", 49.0, "Ghost", "3000")])
    if "onderweg" in prompt:
        return P(is_purchase=True, doc_type="shipping", merchant="bol.com",
                 items=[item("Roborock Q7 Max+ robotstofzuiger - Wit", "Roborock Q7 Max+ robotstofzuiger - Wit",
                             "durable", "robot-vacuum", 299.0, "Roborock", "Q7 Max+")])
    if "Black Friday" in prompt:
        return P(is_purchase=False, doc_type="other")
    if "Cybex" in prompt:
        return P(is_purchase=True, doc_type="order_confirmation", merchant="babydump.nl", order_date="2025-03-02",
                 items=[item("Cybex Balios S Lux kinderwagen Deep Black", "Cybex Balios S Lux kinderwagen Deep Black",
                             "durable", "stroller", 649.0, "Cybex", "Balios S Lux")])
    if "Retour" in prompt:
        return P(is_purchase=True, doc_type="return", merchant="coolblue.nl",
                 items=[item("Philips Airfryer XXL HD9650", "Philips Airfryer XXL HD9650", "durable", "airfryer",
                             199.0, "Philips", "HD9650")])
    if "Airfryer" in prompt:
        return P(is_purchase=True, doc_type="order_confirmation", merchant="coolblue.nl",
                 items=[item("Philips Airfryer XXL HD9650", "Philips Airfryer XXL HD9650", "durable", "airfryer",
                             199.0, "Philips", "HD9650")])
    if "Pampers" in prompt:
        # price claimed wrong on purpose -> must be dropped; brand "Huggies" not in text -> nulled
        return P(is_purchase=True, doc_type="receipt", merchant="kruidvat.nl",
                 items=[item("Pampers Baby-Dry maat 4 (82 stuks)", "Pampers Baby-Dry maat 4 (82 stuks)",
                             "consumable", "diapers", 19.99, "Huggies")])
    raise AssertionError("unexpected document")


class _Resp:
    def __init__(self, obj):
        self.parsed_output = obj
        self._request_id = "req_fake"
        self._d = {"content": [{"type": "thinking", "thinking": "SECRET-THOUGHT about the email"},
                               {"type": "text", "text": obj.model_dump_json()}],
                   "stop_reason": "end_turn", "usage": {"input_tokens": 50, "output_tokens": 10}}

    def to_dict(self):
        return self._d


class FakeImportClient:
    def __init__(self):
        self.prompts: list[str] = []
        outer = self

        class _M:
            def parse(self, **kw):
                prompt = kw["messages"][0]["content"]
                outer.prompts.append(prompt)
                return _Resp(draft_for(prompt))

        class _B:
            messages = _M()

        self.beta = _B()


@pytest.fixture
def project(tmp_path: Path) -> Path:
    shutil.copy(REPO / "config.yaml", tmp_path / "config.yaml")
    (tmp_path / "private").mkdir()
    shutil.copy(REPO / "tests" / "fixtures" / "environment.yaml", tmp_path / "private" / "environment.yaml")
    (tmp_path / "private" / "needs.yaml").write_text(yaml.safe_dump({"needs": [{"id": "robot-vacuum", "text": "robot vacuum"}]}))
    return tmp_path


def test_redact_removes_personal_details_but_keeps_products():
    r = redact(ROBO + "\nIBAN NL91ABNA0417164300, betaald met kaart **** 1234\nhttps://bol.com/track?t=abc")
    for secret in ["Sanne", "de Vries", "Keizersgracht", "1015 CS", "klantenservice@bol.com", "020-1234567", "4012345678",
                   "NL91ABNA", "1234\n", "track?t="]:
        assert secret not in r, secret
    assert "Roborock Q7 Max+ robotstofzuiger - Wit" in r and "299,00" in r


def test_import_grounds_dedupes_and_keeps_emails_out_of_logs(project: Path):
    s = load_settings(project)
    store = Store(s.db_path)
    docs = [doc("1", ROBO, "2026-10-01"), doc("2", SHIP, "2026-10-02"), doc("3", NEWS_NOPRICE, "2026-10-03"),
            doc("4", NEWS_PRICE, "2026-10-04"), doc("5", BUGGY, "2025-03-02", "babydump.nl"),
            doc("6", AIRFRYER, "2026-01-05", "coolblue.nl"), doc("7", RETURN, "2026-01-20", "coolblue.nl")]
    docs += [doc(f"d{i}", DIAPER, d, "kruidvat.nl") for i, d in enumerate(["2026-08-01", "2026-08-29", "2026-09-26"])]
    fake = FakeImportClient()
    rep = import_documents(s, store, docs, llm_client=fake, workers=1)

    assert rep.skipped_no_price == 1 and len(fake.prompts) == 9   # newsletter without prices never sent
    assert rep.not_purchase == 1 and rep.duplicates == 1 and not rep.errors
    for p in fake.prompts:                                        # redacted before sending
        assert "Sanne" not in p and "Keizersgracht" not in p and "@bol.com" not in p

    items = {p.product_name: p for p in store.purchases(s.user_id)}
    assert "Ghost Mop 3000" not in items                          # quote not in document -> dropped
    robo = items["Roborock Q7 Max+ robotstofzuiger - Wit"]
    assert robo.price_verified and robo.unit_price == 299.0 and robo.brand == "Roborock"
    diaper = next(p for p in items.values() if p.category == "diapers")
    assert diaper.unit_price is None and not diaper.price_verified and diaper.brand is None

    log = Path(rep.log_path).read_text()
    assert "Bedankt" not in log and "Keizersgracht" not in log and "SECRET-THOUGHT" not in log
    assert "document omitted for privacy" in log

    profile = with_imports(load_profile(s.profile_path, s.user_id), store)
    owned = {p.id: p for p in profile.owned_products}
    assert "imp-roborock-q7-max" in owned and owned["imp-roborock-q7-max"].status == "unconfirmed"
    assert owned["stroller-cybex-balios-s-lux"].purchase_date == "2025-03-02"   # linked, not duplicated
    assert not any("cybex" in i for i in owned if i.startswith("imp-"))
    assert not any("airfryer" in i or "hd9650" in i for i in owned)           # returned
    habits = {f.id: f for f in profile.facts if f.id.startswith("habits.")}
    assert habits["habits.repeat_purchases"].value == ["diapers: about every 28 days (3 orders, last 2026-09-26)"]
    assert habits["habits.shops_at"].status == "unconfirmed"

    # re-import is free: nothing sent again
    rep2 = import_documents(s, store, docs, llm_client=fake, workers=1)
    assert rep2.already_imported == len(docs) and len(fake.prompts) == 9

    # see / edit / reject / delete
    store.edit_purchase(s.user_id, robo.id, {"model": "Q7 Max+ (2024)"})
    store.set_purchase_status(s.user_id, [diaper.id], "rejected")
    p2 = with_imports(load_profile(s.profile_path, s.user_id), store)
    assert next(p for p in p2.owned_products if p.id.startswith("imp-roborock")).status == "confirmed"
    with pytest.raises(KeyError):
        store.delete_purchases(s.user_id, ["nope"])

    out = build_site(s, store)
    page = (out / "private" / "inventory.html").read_text()
    assert "Roborock" in page and "Bedankt" not in page
    build_site(s, store, public=True)
    assert not (out / "private").exists()
    store.forget_imports(s.user_id)
    assert store.purchases(s.user_id) == [] and store.imported_refs(s.user_id) == set()


def test_yaml_wins_over_imported_habits(project: Path):
    s = load_settings(project)
    y = yaml.safe_load(s.profile_path.read_text())
    y["habits"] = {"shops_at": ["coolblue.nl"]}
    s.profile_path.write_text(yaml.safe_dump(y))
    store = Store(s.db_path)
    import_documents(s, store, [doc("1", ROBO, "2026-10-01")], llm_client=FakeImportClient(), workers=1)
    profile = with_imports(load_profile(s.profile_path, s.user_id), store)
    assert profile.fact("habits.shops_at").value == ["coolblue.nl"]


def test_files_eml_and_pdf(tmp_path: Path):
    msg = EmailMessage()
    msg["From"] = "Coolblue <noreply@mail.coolblue.nl>"
    msg["Subject"] = "Je bestelling"
    msg["Date"] = "Mon, 05 Jan 2026 10:00:00 +0100"
    msg.set_content("<p>Philips Airfryer XXL HD9650</p><p>&euro; 199,00</p>", subtype="html")
    msg.add_attachment(make_pdf(["Factuur", "Philips Airfryer XXL HD9650 EUR 199,00"]), maintype="application",
                       subtype="pdf", filename="factuur.pdf")
    (tmp_path / "a.eml").write_bytes(msg.as_bytes())
    (tmp_path / "bon.pdf").write_bytes(make_pdf(["Kruidvat", "Pampers Baby-Dry maat 4 EUR 24,99"]))
    docs = {d.kind: d for d in load_files([tmp_path])}
    e = docs["email"]
    assert e.sender_domain == "coolblue.nl" and e.date == "2026-01-05"
    assert "€ 199,00" in e.text and "HD9650 EUR 199,00" in e.attachments[0]
    assert "Pampers Baby-Dry" in docs["receipt"].text


def test_gmail_reader_lists_pages_and_parses_raw():
    msg = EmailMessage()
    msg["From"] = "bol.com <service@bol.com>"
    msg["Date"] = "Wed, 01 Oct 2026 09:00:00 +0200"
    msg.set_content("Roborock Q7 Max+ € 299,00")
    raw = base64.urlsafe_b64encode(msg.as_bytes()).decode().rstrip("=")
    seen = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append(req)
        if req.url.path.endswith("/messages"):
            if "pageToken" not in req.url.params:
                return httpx.Response(200, json={"messages": [{"id": "a"}], "nextPageToken": "p2"})
            return httpx.Response(200, json={"messages": [{"id": "b"}]})
        return httpx.Response(200, json={"raw": raw})

    r = gmail.GmailReader(http=httpx.Client(transport=httpx.MockTransport(handler)))
    docs = list(r.documents("category:purchases", 10, skip_refs={gmail.gmail_ref("a")}))
    assert len(docs) == 1 and docs[0].ref == gmail.gmail_ref("b") and docs[0].sender_domain == "bol.com"
    assert all(req.method == "GET" for req in seen)
    assert "newer_than:1y" in gmail.build_query(None, "1y")
    with pytest.raises(gmail.GmailError):
        gmail._check_scopes(["https://www.googleapis.com/auth/gmail.readonly",
                             "https://www.googleapis.com/auth/gmail.modify"])
