"""Claude calls, source tracking and the audit log.

Every LLM step is two calls, on purpose:

1. `research()` - Claude uses the server-side web_search / web_fetch tools and
   writes notes. We harvest every URL it actually searched or fetched (plus page
   text and citation snippets) into a SourceRegistry, giving each an id S1, S2...
2. `structured()` - a second call with a JSON schema (structured outputs) that
   turns the notes into data. It may only cite source ids from the registry.

Code then maps ids back to URLs and checks quotes against fetched page text, so
a made-up URL or a number that isn't on the page never reaches the site.
"""

from __future__ import annotations

import json
import re
import threading
import unicodedata
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, TypeVar

import anthropic
from pydantic import BaseModel

from .models import Source, now_utc

T = TypeVar("T", bound=BaseModel)

FALLBACK_BETA = "server-side-fallback-2026-07-01"
MAX_PAUSE_RESUMES = 6


class LLMError(RuntimeError):
    pass


# ---------------------------------------------------------------------------
# Sources
# ---------------------------------------------------------------------------


def _norm(text: str) -> str:
    text = unicodedata.normalize("NFKC", text).lower()
    text = text.replace(" ", " ")
    return re.sub(r"\s+", " ", text).strip()


def _canon_url(url: str) -> str:
    return url.split("#")[0].rstrip("/")


@dataclass
class SourceRegistry:
    sources: dict[str, Source] = field(default_factory=dict)  # id -> Source
    _by_url: dict[str, str] = field(default_factory=dict)
    _evidence: dict[str, list[str]] = field(default_factory=dict)  # id -> page text / cited snippets

    def add(self, url: str, kind: str, title: str | None = None, text: str | None = None,
            retrieved_at: datetime | None = None) -> Source:
        key = _canon_url(url)
        sid = self._by_url.get(key)
        if sid is None:
            sid = f"S{len(self.sources) + 1}"
            self._by_url[key] = sid
            self.sources[sid] = Source(id=sid, url=url, title=title, kind=kind, retrieved_at=retrieved_at or now_utc())
            self._evidence[sid] = []
        src = self.sources[sid]
        # Upgrade: a fetched page beats a bare search hit.
        if kind == "fetched_page" and src.kind != "fetched_page":
            src.kind = "fetched_page"
            src.retrieved_at = retrieved_at or now_utc()
        if title and not src.title:
            src.title = title
        if text:
            self._evidence[sid].append(text)
        return src

    def get(self, sid: str | None) -> Source | None:
        if not sid:
            return None
        return self.sources.get(sid.strip().upper())

    def by_url(self, url: str) -> Source | None:
        sid = self._by_url.get(_canon_url(url))
        return self.sources.get(sid) if sid else None

    def evidence_text(self, sid: str) -> str:
        return "\n".join(self._evidence.get(sid, []))

    def has_page_text(self, sid: str) -> bool:
        return bool(self._evidence.get(sid))

    def quote_on_page(self, sid: str, quote: str | None) -> bool:
        if not quote:
            return False
        hay = _norm(self.evidence_text(sid))
        needle = _norm(quote).strip(" .…\"'“”")
        return bool(needle) and needle in hay

    def render(self) -> str:
        if not self.sources:
            return "(no sources)"
        return "\n".join(
            f"[{s.id}] {s.title or ''} <{s.url}> ({s.kind})" for s in self.sources.values()
        )

    def merge(self, other: "SourceRegistry") -> None:
        for sid, s in other.sources.items():
            new = self.add(s.url, s.kind, s.title, retrieved_at=s.retrieved_at)
            for t in other._evidence.get(sid, []):
                self._evidence[new.id].append(t)


def harvest_sources(content: Any, registry: SourceRegistry) -> None:
    """Walk response content (as dicts) and record every searched/fetched URL."""
    if isinstance(content, list):
        for item in content:
            harvest_sources(item, registry)
        return
    if not isinstance(content, dict):
        return
    t = content.get("type")
    if t == "web_search_result" and content.get("url"):
        registry.add(content["url"], "search_result", content.get("title"))
    elif t == "web_fetch_result" and content.get("url"):
        doc = content.get("content") or {}
        src = doc.get("source") or {}
        text = src.get("data") if src.get("type") == "text" else None
        ts = content.get("retrieved_at")
        registry.add(
            content["url"], "fetched_page", doc.get("title"), text,
            retrieved_at=datetime.fromisoformat(ts.replace("Z", "+00:00")) if ts else None,
        )
    elif t == "text":
        for c in content.get("citations") or []:
            if c.get("url"):
                registry.add(c["url"], "citation", c.get("title"), c.get("cited_text"))
    for v in content.values():
        if isinstance(v, (list, dict)):
            harvest_sources(v, registry)


# ---------------------------------------------------------------------------
# Client
# ---------------------------------------------------------------------------


@dataclass
class Usage:
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_input_tokens: int = 0
    web_search_requests: int = 0
    web_fetch_requests: int = 0
    calls: int = 0

    def add(self, u: dict | None) -> None:
        if not u:
            return
        self.calls += 1
        self.input_tokens += u.get("input_tokens") or 0
        self.output_tokens += u.get("output_tokens") or 0
        self.cache_read_input_tokens += u.get("cache_read_input_tokens") or 0
        stu = u.get("server_tool_use") or {}
        self.web_search_requests += stu.get("web_search_requests") or 0
        self.web_fetch_requests += stu.get("web_fetch_requests") or 0


class LLM:
    def __init__(self, model: str, log_path: Path, country: str = "NL",
                 search_max_uses: int = 6, fetch_max_uses: int = 6, client: Any | None = None):
        self.model = model
        self.log_path = log_path
        self.country = country
        self.search_max_uses = search_max_uses
        self.fetch_max_uses = fetch_max_uses
        self.usage = Usage()
        self._client = client
        self._lock = threading.Lock()

    @property
    def client(self) -> Any:
        if self._client is None:
            try:
                self._client = anthropic.Anthropic()
            except anthropic.AnthropicError as e:  # no credentials
                raise LLMError(
                    "No Anthropic credentials. Put ANTHROPIC_API_KEY in .env (see .env.example)."
                ) from e
        return self._client

    # -- logging -----------------------------------------------------------
    def _log(self, record: dict) -> None:
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        with self._lock, self.log_path.open("a") as fh:
            fh.write(json.dumps(record, default=str) + "\n")

    def _check(self, stage: str, msg: dict) -> None:
        reason = msg.get("stop_reason")
        if reason == "refusal":
            details = msg.get("stop_details") or {}
            raise LLMError(f"[{stage}] Claude declined (category={details.get('category')}).")
        if reason == "max_tokens":
            raise LLMError(f"[{stage}] output hit max_tokens; raise it in llm.py or narrow the request.")

    def _tools(self, allowed_domains: list[str] | None) -> list[dict]:
        search: dict = {
            "type": "web_search_20260209", "name": "web_search", "max_uses": self.search_max_uses,
            "user_location": {"type": "approximate", "country": self.country},
        }
        fetch: dict = {
            "type": "web_fetch_20260209", "name": "web_fetch", "max_uses": self.fetch_max_uses,
            "citations": {"enabled": True},
        }
        if allowed_domains:
            search["allowed_domains"] = allowed_domains
            fetch["allowed_domains"] = allowed_domains
        return [search, fetch]

    # -- step 1: research with web tools -------------------------------------
    def research(self, stage: str, system: str, prompt: str, registry: SourceRegistry, *,
                 effort: str = "medium", allowed_domains: list[str] | None = None) -> str:
        messages: list[dict] = [{"role": "user", "content": prompt}]
        tools = self._tools(allowed_domains)
        texts: list[str] = []
        for attempt in range(MAX_PAUSE_RESUMES + 1):
            started = now_utc()
            with self.client.beta.messages.stream(
                model=self.model,
                max_tokens=32000,
                system=system,
                messages=messages,
                tools=tools,
                thinking={"type": "adaptive"},
                output_config={"effort": effort},
                betas=[FALLBACK_BETA],
                fallbacks="default",
            ) as stream:
                final = stream.get_final_message()
            msg = final.to_dict()
            with self._lock:
                self.usage.add(msg.get("usage"))
            self._log({
                "ts": started, "stage": stage, "kind": "research", "attempt": attempt, "model": self.model,
                "request": {"system": system, "messages": messages, "tools": tools, "effort": effort},
                "response": msg, "request_id": getattr(final, "_request_id", None),
            })
            harvest_sources(msg.get("content"), registry)
            texts += [b["text"] for b in msg.get("content", []) if b.get("type") == "text"]
            if msg.get("stop_reason") == "pause_turn":
                messages = messages + [{"role": "assistant", "content": msg["content"]}]
                continue
            self._check(stage, msg)
            break
        return "\n".join(texts).strip()

    # -- step 2: structured output ------------------------------------------
    def structured(self, stage: str, system: str, prompt: str, schema: type[T], *,
                   effort: str = "medium", max_tokens: int = 16000, audit_prompt: str | None = None) -> T:
        """audit_prompt replaces the prompt in the log (used for private documents such as emails)."""
        started = now_utc()
        resp = self.client.beta.messages.parse(
            model=self.model,
            max_tokens=max_tokens,
            system=system,
            messages=[{"role": "user", "content": prompt}],
            output_format=schema,
            thinking={"type": "adaptive"},
            output_config={"effort": effort},
            betas=[FALLBACK_BETA],
            fallbacks="default",
        )
        msg = resp.to_dict()
        with self._lock:
            self.usage.add(msg.get("usage"))
        logged = msg
        if audit_prompt is not None:  # private document: keep extracted output, drop reasoning that may quote it
            logged = {**msg, "content": [b for b in msg.get("content", []) if b.get("type") == "text"]}
        self._log({
            "ts": started, "stage": stage, "kind": "structured", "model": self.model, "schema": schema.__name__,
            "request": {"system": system, "prompt": prompt if audit_prompt is None else audit_prompt,
                        "effort": effort},
            "response": logged, "request_id": getattr(resp, "_request_id", None),
        })
        self._check(stage, msg)
        parsed = getattr(resp, "parsed_output", None)
        if parsed is None:
            text = next((b["text"] for b in msg.get("content", []) if b.get("type") == "text"), "")
            parsed = schema.model_validate_json(text)
        return parsed
