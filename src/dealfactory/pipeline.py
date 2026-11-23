"""Run context and stage orchestration.

Each stage reads the JSON written by earlier stages from
runs/<need_id>/<run_id>/ and writes its own <stage>.json there, so any stage
can be re-run on its own (`dealfactory run <need> --stage fit`).
"""

from __future__ import annotations

import json
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, TypeVar

import yaml
from pydantic import BaseModel, TypeAdapter

from .config import Settings
from .fetch import PoliteFetcher
from .llm import LLM
from .models import EnvironmentProfile, NeedSpec, now_utc
from .profile import load_profile
from .store import Store

T = TypeVar("T")

STAGES = ["intake", "research", "candidates", "fit", "matrix", "offers", "recommend"]


@dataclass
class RunContext:
    settings: Settings
    profile: EnvironmentProfile
    need_spec: NeedSpec
    store: Store
    llm: LLM
    fetcher: PoliteFetcher
    run_id: str
    run_dir: Path
    fresh_research: bool = False
    log: Callable[[str], None] = print
    lock: threading.Lock = field(default_factory=threading.Lock)

    @property
    def country(self) -> str:
        f = self.profile.fact("location.country")
        return str(f.value) if f and f.value else "NL"

    @property
    def currency(self) -> str:
        f = self.profile.fact("location.currency")
        return str(f.value) if f and f.value else "EUR"

    @property
    def language(self) -> str:
        f = self.profile.fact("location.language")
        return str(f.value) if f and f.value else "nl"

    def effort(self, stage: str) -> str:
        return self.settings.effort_for(stage)

    def write(self, stage: str, data: BaseModel | list) -> Path:
        path = self.run_dir / f"{stage}.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(data, BaseModel):
            text = data.model_dump_json(indent=2)
        else:
            text = json.dumps([d.model_dump(mode="json") for d in data], indent=2)
        path.write_text(text)
        return path

    def read(self, stage: str, typ: type[T]) -> T:
        path = self.run_dir / f"{stage}.json"
        if not path.exists():
            raise SystemExit(f"{path} missing - run the '{stage}' stage first.")
        return TypeAdapter(typ).validate_json(path.read_text())


def load_needs(path: Path) -> list[NeedSpec]:
    raw = yaml.safe_load(path.read_text()) or {}
    return [NeedSpec(**n) for n in raw.get("needs", [])]


def new_run_id() -> str:
    return now_utc().strftime("%Y%m%dT%H%M%SZ")


def latest_run_dir(settings: Settings, need_id: str) -> Path | None:
    marker = settings.runs_dir / need_id / "LATEST"
    if marker.exists():
        d = settings.runs_dir / need_id / marker.read_text().strip()
        if d.exists():
            return d
    return None


def make_context(settings: Settings, need: NeedSpec, run_id: str, store: Store,
                 profile: EnvironmentProfile | None = None, llm_client=None) -> RunContext:
    if profile is None:
        from .inventory import with_imports
        profile = with_imports(load_profile(settings.profile_path, settings.user_id), store)
    run_dir = settings.runs_dir / need.id / run_id
    country_fact = profile.fact("location.country")
    llm = LLM(
        settings.model, run_dir / "llm_log.jsonl",
        country=str(country_fact.value) if country_fact else "NL",
        search_max_uses=settings.web_search_max_uses, fetch_max_uses=settings.web_fetch_max_uses,
        client=llm_client,
    )
    fetcher = PoliteFetcher(settings.cache_dir, settings.user_agent, settings.min_seconds_between_requests)
    return RunContext(settings, profile, need, store, llm, fetcher, run_id, run_dir)


def stage_functions() -> dict[str, Callable[[RunContext], object]]:
    from .stages import candidates, fit, intake, matrix, offers, recommend, research

    return {
        "intake": intake.run,
        "research": research.run,
        "candidates": candidates.run,
        "fit": fit.run,
        "matrix": matrix.run,
        "offers": offers.run,
        "recommend": recommend.run,
    }


def run_need(settings: Settings, need: NeedSpec, store: Store, *, only: str | None = None,
             start_from: str | None = None, fresh_research: bool = False, llm_client=None) -> Path:
    if only or start_from:
        run_dir = latest_run_dir(settings, need.id)
        if run_dir is None:
            raise SystemExit(f"No previous run for {need.id}; run the whole pipeline first.")
        run_id = run_dir.name
    else:
        run_id = new_run_id()
    ctx = make_context(settings, need, run_id, store, llm_client=llm_client)
    ctx.fresh_research = fresh_research
    store.sync_profile(ctx.profile)
    store.start_run(settings.user_id, run_id, need.id, ctx.profile.version, now_utc().isoformat())

    fns = stage_functions()
    if only:
        todo = [only]
    elif start_from:
        todo = STAGES[STAGES.index(start_from):]
    else:
        todo = STAGES
    status = "ok"
    try:
        for stage in todo:
            ctx.log(f"  [{need.id}] {stage} ...")
            fns[stage](ctx)
    except Exception:
        status = "failed"
        raise
    finally:
        u = ctx.llm.usage
        store.finish_run(settings.user_id, run_id, now_utc().isoformat(), status, u.__dict__)
        (ctx.run_dir).mkdir(parents=True, exist_ok=True)
        (ctx.run_dir / "usage.json").write_text(json.dumps(u.__dict__, indent=2))
        if status == "ok":
            (settings.runs_dir / need.id / "LATEST").write_text(run_id)
        ctx.log(
            f"  [{need.id}] {status}: {u.calls} Claude calls, {u.input_tokens:,} in / {u.output_tokens:,} out tokens, "
            f"{u.web_search_requests} searches, {u.web_fetch_requests} fetches"
        )
    return ctx.run_dir
