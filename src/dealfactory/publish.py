"""PUBLISH: render the static site from the latest run of every need.

`dealfactory publish` builds the full local site, including the private
"my environment" page under site/private/. `--public` leaves out that page,
private profile facts and the audit-log paths, for hosting (behind Cloudflare
Access in Phase 3).
"""

from __future__ import annotations

import shutil
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from jinja2 import Environment, PackageLoader, select_autoescape
from pydantic import TypeAdapter

from .config import Settings
from .models import (
    Candidate, CategoryResearch, EnvironmentProfile, FeatureMatrix, FitAssessment, Need, NeedSpec, Offer,
    Recommendation, Source,
)
from .pipeline import latest_run_dir, load_needs
from .profile import load_profile, public_profile_view
from .store import Store

ROLE_LABEL = {"top": "Top pick", "budget": "Budget pick", "premium": "Premium pick", "if_you_care": "If you care about"}
VERIFY_LABEL = {
    "jsonld": "Read from the retailer's structured product data",
    "quote_verified": "Quote found on the fetched page",
    "cited": "From a search result; quote not checked against the full page",
    "unverified": "Not verified",
}


def _read(run_dir: Path, name: str, typ):
    p = run_dir / f"{name}.json"
    return TypeAdapter(typ).validate_json(p.read_text()) if p.exists() else None


@dataclass
class NeedView:
    spec: NeedSpec
    run_id: str | None = None
    run_dir: Path | None = None
    need: Need | None = None
    research: CategoryResearch | None = None
    candidates: list[Candidate] | None = None
    fit: list[FitAssessment] | None = None
    matrix: FeatureMatrix | None = None
    offers: list[Offer] | None = None
    rec: Recommendation | None = None
    history: list[dict] | None = None

    @property
    def cand_by_id(self) -> dict[str, Candidate]:
        return {c.id: c for c in self.candidates or []}

    @property
    def fit_by_id(self) -> dict[str, FitAssessment]:
        return {a.candidate_id: a for a in self.fit or []}

    def offers_for(self, cid: str) -> list[Offer]:
        return [o for o in self.offers or [] if o.candidate_id == cid]

    def best_offer(self, cid: str) -> Offer | None:
        priced = [o for o in self.offers_for(cid) if o.price_amount is not None]
        return min(priced, key=lambda o: o.price_amount) if priced else None

    def offer(self, oid: str | None) -> Offer | None:
        return next((o for o in self.offers or [] if o.id == oid), None)

    @property
    def top(self):
        return next((p for p in (self.rec.picks if self.rec else []) if p.role == "top"), None)

    @property
    def all_sources(self) -> list[Source]:
        seen: dict[str, Source] = {}
        for s in (self.research.sources if self.research else []):
            seen.setdefault(s.url, s)
        for c in self.candidates or []:
            for s in c.sources:
                seen.setdefault(s.url, s)
        return sorted(seen.values(), key=lambda s: s.url)

    def history_series(self) -> list[dict]:
        groups: dict[tuple, list] = defaultdict(list)
        for row in self.history or []:
            groups[(row["candidate_id"], row["retailer"])].append(row)
        out = []
        for (cid, retailer), rows in groups.items():
            prices = [r["price"] for r in rows]
            out.append({"candidate_id": cid, "retailer": retailer, "rows": rows, "min": min(prices),
                        "max": max(prices), "last": prices[-1], "first": prices[0],
                        "spark": sparkline(prices)})
        return sorted(out, key=lambda s: (s["candidate_id"], s["last"]))


def sparkline(values: list[float], w: int = 120, h: int = 28) -> str | None:
    if len(values) < 2:
        return None
    lo, hi = min(values), max(values)
    span = (hi - lo) or 1
    step = w / (len(values) - 1)
    pts = " ".join(f"{i * step:.1f},{h - 3 - (v - lo) / span * (h - 6):.1f}" for i, v in enumerate(values))
    return (f'<svg class="spark" viewBox="0 0 {w} {h}" width="{w}" height="{h}" aria-hidden="true">'
            f'<polyline fill="none" stroke="currentColor" stroke-width="1.6" points="{pts}"/></svg>')


def money(v, currency="EUR") -> str:
    if v is None:
        return "unknown"
    sym = "€" if currency == "EUR" else currency + " "
    s = f"{float(v):,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")
    return f"{sym}{s}"


def dt(v) -> str:
    if v is None:
        return "–"
    if isinstance(v, str):
        try:
            v = datetime.fromisoformat(v)
        except ValueError:
            return v
    return v.strftime("%d %b %Y %H:%M UTC")


def host(url: str) -> str:
    from urllib.parse import urlparse
    return urlparse(url).netloc.removeprefix("www.")


def build_site(settings: Settings, store: Store, public: bool = False) -> Path:
    from .inventory import with_imports
    profile: EnvironmentProfile = with_imports(load_profile(settings.profile_path, settings.user_id), store)
    purchases = [] if public else store.purchases(settings.user_id)
    import_summary = {} if public else store.import_summary(settings.user_id)
    if public:
        profile = public_profile_view(profile)
    views: list[NeedView] = []
    for spec in load_needs(settings.needs_path):
        v = NeedView(spec=spec)
        rd = latest_run_dir(settings, spec.id)
        if rd:
            v.run_id, v.run_dir = rd.name, rd
            v.need = _read(rd, "intake", Need)
            v.research = _read(rd, "research", CategoryResearch)
            v.candidates = _read(rd, "candidates", list[Candidate])
            v.fit = _read(rd, "fit", list[FitAssessment])
            v.matrix = _read(rd, "matrix", FeatureMatrix)
            v.offers = _read(rd, "offers", list[Offer])
            v.rec = _read(rd, "recommendation", Recommendation)
        v.history = store.price_history(settings.user_id, spec.id)
        views.append(v)

    env = Environment(loader=PackageLoader("dealfactory", "templates"), autoescape=select_autoescape())
    env.filters.update(money=money, dt=dt, host=host)
    common = dict(public=public, profile=profile, ROLE_LABEL=ROLE_LABEL, VERIFY_LABEL=VERIFY_LABEL,
                  generated=datetime.now().astimezone().strftime("%d %b %Y %H:%M"), settings=settings)

    out = settings.site_dir
    if out.exists():
        shutil.rmtree(out)
    (out / "needs").mkdir(parents=True)
    (out / "assets").mkdir()
    shutil.copy(Path(__file__).parent / "templates" / "style.css", out / "assets" / "style.css")

    (out / "index.html").write_text(env.get_template("index.html.j2").render(views=views, root="", **common))
    for v in views:
        (out / "needs" / f"{v.spec.id}.html").write_text(
            env.get_template("need.html.j2").render(v=v, root="../", **common))
    if not public:
        (out / "private").mkdir()
        fact_groups: dict[str, list] = defaultdict(list)
        for f in profile.facts:
            fact_groups[f.id.split(".")[0]].append(f)
        (out / "private" / "environment.html").write_text(env.get_template("environment.html.j2").render(
            groups=dict(fact_groups), unconfirmed=profile.unconfirmed(), root="../", **common))
        (out / "private" / "inventory.html").write_text(env.get_template("inventory.html.j2").render(
            purchases=purchases, summary=import_summary, root="../", **common))
    (out / "robots.txt").write_text("User-agent: *\nDisallow: /\n")
    return out
