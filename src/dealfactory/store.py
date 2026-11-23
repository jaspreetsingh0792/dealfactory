"""SQLite store: profile mirror, needs, offers + price history, runs.

private/environment.yaml stays the source of truth for the profile in Phase 1;
it is mirrored here so later phases (Gmail import, feedback) can write facts
with provenance and the user can see/edit/delete everything in one place.
Every table is scoped by user_id so the system can go multi-user later.
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from datetime import date

from .models import EnvironmentProfile, Need, Offer, Purchase, Recommendation, now_utc
from .llm import _norm

SCHEMA = """
CREATE TABLE IF NOT EXISTS profile_facts (
  user_id TEXT NOT NULL, id TEXT NOT NULL, value_json TEXT, source TEXT, confidence REAL,
  status TEXT, note TEXT, private INTEGER, updated_at TEXT, PRIMARY KEY (user_id, id));
CREATE TABLE IF NOT EXISTS owned_products (
  user_id TEXT NOT NULL, id TEXT NOT NULL, data_json TEXT NOT NULL, source TEXT, status TEXT,
  updated_at TEXT, PRIMARY KEY (user_id, id));
CREATE TABLE IF NOT EXISTS needs (
  user_id TEXT NOT NULL, id TEXT NOT NULL, text TEXT, status TEXT, data_json TEXT,
  updated_at TEXT, PRIMARY KEY (user_id, id));
CREATE TABLE IF NOT EXISTS offer_observations (
  user_id TEXT NOT NULL, need_id TEXT, candidate_id TEXT, retailer TEXT, url TEXT,
  price REAL, currency TEXT, in_stock TEXT, verification TEXT, observed_at TEXT, run_id TEXT);
CREATE INDEX IF NOT EXISTS ix_obs ON offer_observations (user_id, need_id, candidate_id, retailer, observed_at);
CREATE TABLE IF NOT EXISTS runs (
  user_id TEXT NOT NULL, run_id TEXT NOT NULL, need_id TEXT, profile_version TEXT,
  started_at TEXT, finished_at TEXT, status TEXT, usage_json TEXT, PRIMARY KEY (user_id, run_id));
CREATE TABLE IF NOT EXISTS recommendations (
  user_id TEXT NOT NULL, need_id TEXT, run_id TEXT, top_candidate_id TEXT, data_json TEXT, created_at TEXT);
-- Phase 2: extracted purchase fields only (never email bodies or files)
CREATE TABLE IF NOT EXISTS purchases (
  user_id TEXT NOT NULL, id TEXT NOT NULL, source_kind TEXT, source_ref TEXT, doc_type TEXT, merchant TEXT,
  order_date TEXT, product_name TEXT, brand TEXT, model TEXT, variant TEXT, category TEXT, kind TEXT,
  quantity INTEGER, unit_price REAL, currency TEXT, price_verified INTEGER, status TEXT, user_edited INTEGER,
  extracted_at TEXT, PRIMARY KEY (user_id, id));
CREATE TABLE IF NOT EXISTS import_log (
  user_id TEXT NOT NULL, source_ref TEXT NOT NULL, source_kind TEXT, sender_domain TEXT, doc_date TEXT,
  processed_at TEXT, result TEXT, n_items INTEGER, PRIMARY KEY (user_id, source_ref));
"""

USER_TABLES = ["profile_facts", "owned_products", "needs", "offer_observations", "runs", "recommendations",
               "purchases", "import_log"]
PURCHASE_COLS = ["user_id", "id", "source_kind", "source_ref", "doc_type", "merchant", "order_date", "product_name",
                 "brand", "model", "variant", "category", "kind", "quantity", "unit_price", "currency",
                 "price_verified", "status", "user_edited", "extracted_at"]
EDITABLE = {"product_name", "brand", "model", "variant", "category", "kind", "merchant", "order_date", "quantity",
            "unit_price"}


class Store:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path)
        self.db.row_factory = sqlite3.Row
        self.db.executescript(SCHEMA)

    def close(self) -> None:
        self.db.close()

    # profile -------------------------------------------------------------
    def sync_profile(self, profile: EnvironmentProfile) -> None:
        u, ts = profile.user_id, profile.loaded_at.isoformat()
        with self.db:
            self.db.execute("DELETE FROM profile_facts WHERE user_id=?", (u,))
            self.db.execute("DELETE FROM owned_products WHERE user_id=?", (u,))
            self.db.executemany(
                "INSERT INTO profile_facts VALUES (?,?,?,?,?,?,?,?,?)",
                [(u, f.id, json.dumps(f.value), f.source, f.confidence, f.status, f.note, int(f.private), ts)
                 for f in profile.facts],
            )
            self.db.executemany(
                "INSERT INTO owned_products VALUES (?,?,?,?,?,?)",
                [(u, p.id, p.model_dump_json(), p.source, p.status, ts) for p in profile.owned_products],
            )

    # needs -----------------------------------------------------------------
    def upsert_need(self, need: Need) -> None:
        with self.db:
            self.db.execute(
                "INSERT OR REPLACE INTO needs VALUES (?,?,?,?,?,?)",
                (need.user_id, need.id, need.text, need.status, need.model_dump_json(), need.created_at.isoformat()),
            )

    # offers + price history ------------------------------------------------
    def record_offers(self, user_id: str, run_id: str, offers: list[Offer]) -> None:
        with self.db:
            self.db.executemany(
                "INSERT INTO offer_observations VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                [(user_id, o.need_id, o.candidate_id, o.retailer, o.url, o.price_amount, o.currency,
                  o.in_stock.value, o.price.verification, o.retrieved_at.isoformat(), run_id) for o in offers],
            )

    def price_history(self, user_id: str, need_id: str) -> list[dict]:
        rows = self.db.execute(
            "SELECT candidate_id, retailer, price, currency, observed_at, verification FROM offer_observations "
            "WHERE user_id=? AND need_id=? AND price IS NOT NULL ORDER BY observed_at",
            (user_id, need_id),
        ).fetchall()
        return [dict(r) for r in rows]

    # runs ------------------------------------------------------------------
    def start_run(self, user_id: str, run_id: str, need_id: str, profile_version: str, started_at: str) -> None:
        with self.db:
            self.db.execute(
                "INSERT OR REPLACE INTO runs VALUES (?,?,?,?,?,?,?,?)",
                (user_id, run_id, need_id, profile_version, started_at, None, "running", None),
            )

    def finish_run(self, user_id: str, run_id: str, finished_at: str, status: str, usage: dict) -> None:
        with self.db:
            self.db.execute(
                "UPDATE runs SET finished_at=?, status=?, usage_json=? WHERE user_id=? AND run_id=?",
                (finished_at, status, json.dumps(usage), user_id, run_id),
            )

    def record_recommendation(self, rec: Recommendation) -> None:
        top = next((p.candidate_id for p in rec.picks if p.role == "top"), None)
        with self.db:
            self.db.execute(
                "INSERT INTO recommendations VALUES (?,?,?,?,?,?)",
                (rec.user_id, rec.need_id, rec.run_id, top, rec.model_dump_json(), rec.generated_at.isoformat()),
            )

    def previous_top_pick(self, user_id: str, need_id: str, before_run: str) -> str | None:
        row = self.db.execute(
            "SELECT top_candidate_id FROM recommendations WHERE user_id=? AND need_id=? AND run_id<>? "
            "ORDER BY created_at DESC LIMIT 1",
            (user_id, need_id, before_run),
        ).fetchone()
        return row[0] if row else None

    # purchases (Phase 2) -----------------------------------------------------
    def imported_refs(self, user_id: str) -> set[str]:
        return {r[0] for r in self.db.execute("SELECT source_ref FROM import_log WHERE user_id=?", (user_id,))}

    def log_import(self, user_id: str, ref: str, kind: str, sender_domain: str | None, doc_date: str | None,
                   result: str, n_items: int) -> None:
        with self.db:
            self.db.execute("INSERT OR REPLACE INTO import_log VALUES (?,?,?,?,?,?,?,?)",
                            (user_id, ref, kind, sender_domain, doc_date, now_utc().isoformat(), result, n_items))

    def import_summary(self, user_id: str) -> dict[str, int]:
        rows = self.db.execute("SELECT result, COUNT(*) FROM import_log WHERE user_id=? GROUP BY result", (user_id,))
        return {r[0]: r[1] for r in rows}

    def _duplicate_of(self, p: Purchase) -> str | None:
        """Order confirmation + shipping notice + invoice for the same item -> one purchase."""
        rows = self.db.execute(
            "SELECT id, product_name, order_date, doc_type FROM purchases WHERE user_id=? AND merchant IS ? "
            "AND source_ref<>?", (p.user_id, p.merchant, p.source_ref)).fetchall()
        is_return = p.doc_type in ("return", "cancellation")
        for r in rows:
            if (r["doc_type"] in ("return", "cancellation")) != is_return or _norm(r["product_name"]) != _norm(p.product_name):
                continue
            if not (r["order_date"] and p.order_date):
                return r["id"]
            if abs((date.fromisoformat(r["order_date"]) - date.fromisoformat(p.order_date)).days) <= 21:
                return r["id"]
        return None

    def add_purchases(self, items: list[Purchase]) -> tuple[int, int]:
        added = dupes = 0
        with self.db:
            for p in items:
                if self._duplicate_of(p):
                    dupes += 1
                    continue
                row = p.model_dump()
                row["extracted_at"] = p.extracted_at.isoformat()
                row["price_verified"], row["user_edited"] = int(p.price_verified), int(p.user_edited)
                self.db.execute(f"INSERT OR IGNORE INTO purchases VALUES ({','.join('?' * len(PURCHASE_COLS))})",
                                [row[c] for c in PURCHASE_COLS])
                added += 1
        return added, dupes

    def purchases(self, user_id: str) -> list[Purchase]:
        rows = self.db.execute("SELECT * FROM purchases WHERE user_id=? ORDER BY order_date DESC, id", (user_id,))
        return [Purchase(**{**dict(r), "price_verified": bool(r["price_verified"]), "user_edited": bool(r["user_edited"])})
                for r in rows]

    def _ids_exist(self, user_id: str, ids: list[str]) -> list[str]:
        have = {r[0] for r in self.db.execute("SELECT id FROM purchases WHERE user_id=?", (user_id,))}
        missing = [i for i in ids if i not in have]
        if missing:
            raise KeyError(f"No imported item with id: {', '.join(missing)}")
        return ids

    def set_purchase_status(self, user_id: str, ids: list[str], status: str) -> None:
        self._ids_exist(user_id, ids)
        with self.db:
            self.db.executemany("UPDATE purchases SET status=? WHERE user_id=? AND id=?",
                                [(status, user_id, i) for i in ids])

    def edit_purchase(self, user_id: str, pid: str, fields: dict) -> None:
        self._ids_exist(user_id, [pid])
        bad = set(fields) - EDITABLE
        if bad:
            raise KeyError(f"Not editable: {', '.join(sorted(bad))}")
        if not fields:
            return
        sets = ", ".join(f"{k}=?" for k in fields)
        with self.db:
            self.db.execute(f"UPDATE purchases SET {sets}, user_edited=1, status='confirmed' WHERE user_id=? AND id=?",
                            [*fields.values(), user_id, pid])

    def delete_purchases(self, user_id: str, ids: list[str]) -> None:
        self._ids_exist(user_id, ids)
        with self.db:
            self.db.executemany("DELETE FROM purchases WHERE user_id=? AND id=?", [(user_id, i) for i in ids])

    def forget_imports(self, user_id: str) -> None:
        with self.db:
            self.db.execute("DELETE FROM purchases WHERE user_id=?", (user_id,))
            self.db.execute("DELETE FROM import_log WHERE user_id=?", (user_id,))

    # privacy: see and delete -------------------------------------------------
    def export_user(self, user_id: str) -> dict:
        return {t: [dict(r) for r in self.db.execute(f"SELECT * FROM {t} WHERE user_id=?", (user_id,))]
                for t in USER_TABLES}

    def delete_user(self, user_id: str) -> None:
        with self.db:
            for table in USER_TABLES:
                self.db.execute(f"DELETE FROM {table} WHERE user_id=?", (user_id,))
