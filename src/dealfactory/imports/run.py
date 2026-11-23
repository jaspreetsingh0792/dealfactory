"""Import orchestration: documents -> redact -> Claude extraction -> grounding -> purchases table."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Iterable

from ..config import Settings
from ..llm import LLM
from ..models import ProfileFact, Purchase
from ..profile import load_profile
from ..store import Store
from .documents import Document
from .extract import extract
from .redact import looks_like_it_has_prices


@dataclass
class ImportReport:
    seen: int = 0
    already_imported: int = 0
    skipped_no_price: int = 0
    not_purchase: int = 0
    with_items: int = 0
    items_added: int = 0
    duplicates: int = 0
    errors: list[str] = field(default_factory=list)
    log_path: str | None = None

    def lines(self) -> list[str]:
        return [
            f"documents seen: {self.seen}",
            f"  already imported (skipped): {self.already_imported}",
            f"  no prices, not sent to Claude: {self.skipped_no_price}",
            f"  not a purchase: {self.not_purchase}",
            f"  purchases: {self.with_items} documents -> {self.items_added} new items"
            + (f" ({self.duplicates} duplicates of earlier emails merged)" if self.duplicates else ""),
        ] + [f"  error: {e}" for e in self.errors]


def private_terms(settings: Settings) -> list[str]:
    """Names from the profile, removed from documents before they are sent."""
    try:
        profile = load_profile(settings.profile_path, settings.user_id)
    except SystemExit:
        return []
    terms: list[str] = []
    for f in profile.facts:
        if isinstance(f, ProfileFact) and f.id.startswith(("household.names", "user.name", "location.street",
                                                           "location.address")):
            vals = f.value if isinstance(f.value, list) else [f.value]
            terms += [str(v) for v in vals if v]
    return terms


def import_documents(settings: Settings, store: Store, docs: Iterable[Document], *, llm_client=None,
                     workers: int = 3) -> ImportReport:
    from ..pipeline import new_run_id

    rep = ImportReport()
    done = store.imported_refs(settings.user_id)
    log_path = settings.runs_dir / "_imports" / new_run_id() / "llm_log.jsonl"
    llm = LLM(settings.model, log_path, client=llm_client)
    terms = private_terms(settings)
    todo: list[Document] = []
    for doc in docs:
        rep.seen += 1
        if doc.ref in done:
            rep.already_imported += 1
            continue
        done.add(doc.ref)
        if not doc.full_text.strip() or not looks_like_it_has_prices(doc.full_text):
            rep.skipped_no_price += 1
            store.log_import(settings.user_id, doc.ref, doc.kind, doc.sender_domain, doc.date, "skipped_no_price", 0)
            continue
        todo.append(doc)

    def work(doc: Document) -> tuple[Document, list[Purchase] | Exception]:
        try:
            return doc, extract(doc, llm, settings.user_id, settings.effort_for("import"), terms)
        except Exception as e:  # one bad document must not stop the import
            return doc, e

    with ThreadPoolExecutor(max_workers=workers) as pool:
        for doc, result in pool.map(work, todo):
            where = f"{doc.kind} from {doc.sender_domain or 'file'} {doc.date or ''}".strip()
            if isinstance(result, Exception):
                rep.errors.append(f"{where}: {result}")  # not logged as imported, so the next run retries it
                continue
            if not result:
                rep.not_purchase += 1
                store.log_import(settings.user_id, doc.ref, doc.kind, doc.sender_domain, doc.date, "not_purchase", 0)
                continue
            added, dupes = store.add_purchases(result)
            rep.with_items += 1
            rep.items_added += added
            rep.duplicates += dupes
            store.log_import(settings.user_id, doc.ref, doc.kind, doc.sender_domain, doc.date, "purchase", added)
    rep.log_path = str(log_path) if log_path.exists() else None
    return rep
