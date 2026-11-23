"""Settings: config.yaml (committed) + .env (secrets, never committed)."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

import yaml
from dotenv import load_dotenv


@dataclass
class Retailer:
    domain: str
    name: str
    country: str = "NL"
    categories: list[str] = field(default_factory=list)  # empty = all categories


@dataclass
class Settings:
    root: Path
    model: str = "claude-opus-5-5"
    effort: dict[str, str] = field(default_factory=dict)
    max_candidates: int = 5
    web_search_max_uses: int = 6
    web_fetch_max_uses: int = 6
    research_cache_days: int = 30
    default_retailers: list[str] = field(default_factory=list)
    retailers: dict[str, Retailer] = field(default_factory=dict)
    direct_fetch: bool = True
    min_seconds_between_requests: float = 4.0
    user_agent: str = "DealFactory/0.1 (personal shopping assistant; low-volume)"
    user_id: str = "me"
    gmail: dict = field(default_factory=dict)   # query, since, max_messages

    @property
    def private_dir(self) -> Path:
        return self.profile_path.parent

    @property
    def profile_path(self) -> Path:
        return Path(os.environ.get("DEALFACTORY_PROFILE", self.root / "private" / "environment.yaml"))

    @property
    def needs_path(self) -> Path:
        return Path(os.environ.get("DEALFACTORY_NEEDS", self.root / "private" / "needs.yaml"))

    @property
    def db_path(self) -> Path:
        return self.root / "data" / "dealfactory.sqlite"

    @property
    def cache_dir(self) -> Path:
        return self.root / "data" / "cache"

    @property
    def runs_dir(self) -> Path:
        return self.root / "runs"

    @property
    def site_dir(self) -> Path:
        return self.root / "site"

    def effort_for(self, stage: str) -> str:
        return self.effort.get(stage, self.effort.get("default", "medium"))


def find_root(start: Path | None = None) -> Path:
    p = (start or Path.cwd()).resolve()
    for candidate in [p, *p.parents]:
        if (candidate / "config.yaml").exists():
            return candidate
    raise SystemExit("config.yaml not found - run dealfactory from the project folder")


def load_settings(root: Path | None = None) -> Settings:
    root = root or find_root()
    load_dotenv(root / ".env")
    raw = yaml.safe_load((root / "config.yaml").read_text()) or {}
    retailers = {
        r["domain"]: Retailer(
            domain=r["domain"], name=r.get("name", r["domain"]), country=r.get("country", "NL"),
            categories=r.get("categories", []),
        )
        for r in raw.get("retailers", [])
    }
    s = Settings(
        root=root,
        model=os.environ.get("DEALFACTORY_MODEL", raw.get("model", "claude-opus-5-5")),
        effort=raw.get("effort", {}),
        max_candidates=raw.get("max_candidates", 5),
        web_search_max_uses=raw.get("web_search_max_uses", 6),
        web_fetch_max_uses=raw.get("web_fetch_max_uses", 6),
        research_cache_days=raw.get("research_cache_days", 30),
        default_retailers=raw.get("default_retailers", list(retailers)[:3]),
        retailers=retailers,
        direct_fetch=raw.get("direct_fetch", True),
        min_seconds_between_requests=raw.get("min_seconds_between_requests", 4.0),
        user_agent=raw.get("user_agent", Settings.user_agent),
        user_id=raw.get("user_id", "me"),
        gmail=raw.get("gmail", {}) or {},
    )
    return s
