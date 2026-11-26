"""Local web server for `dealfactory web`: serves web/ and adds Sign in with ChatGPT.

OpenAI's "Sign in with ChatGPT" (plan usage) is for open-source and locally hosted apps. Its rules:
the sign-in returns to http://127.0.0.1:<port>/auth/callback, and tokens stay out of the browser.
So this server does the sign-in, keeps the tokens in an owner-only file, and relays the web app's
model requests to the Responses API (store=false, streamed).

Safety:
* Binds 127.0.0.1 only. The Host header must be 127.0.0.1/localhost (blocks DNS rebinding).
* API routes accept only same-origin JSON requests (Origin check). Other websites can't use your plan.
* Tokens: ~/.config/dealfactory/chatgpt.json, mode 0600. Never sent to the browser, never logged.
"""

from __future__ import annotations

import base64
import hashlib
import http.server
import json
import os
import secrets
import threading
import time
import uuid
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlparse

import httpx

ISSUER = "https://auth.openai.com"
AUTHORIZE = f"{ISSUER}/api/accounts/authorize"
TOKEN = f"{ISSUER}/api/accounts/oauth/token"
API = "https://api.openai.com/v1"
SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct"
DYNAMIC_CLIENT = "dynamic_agent_client"
APP_NAME = "DealFactory"


def config_dir() -> Path:
    base = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")
    return base / "dealfactory"


def _b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _jwt_claims(token: str) -> dict:
    try:
        part = token.split(".")[1]
        return json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))
    except Exception:  # noqa: BLE001
        return {}


class ChatGPTAuth:
    """Sign in with ChatGPT for one local app install. Thread-safe."""

    def __init__(self, directory: Path | None = None, client: httpx.Client | None = None):
        self.dir = directory or config_dir()
        self.path = self.dir / "chatgpt.json"
        self.http = client or httpx.Client(timeout=60)
        self.lock = threading.Lock()
        self.flows: dict[str, dict] = {}

    # ---------------------------------------------------------------- storage
    def _read(self) -> dict:
        try:
            return json.loads(self.path.read_text())
        except (OSError, ValueError):
            return {}

    def _write(self, data: dict) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump(data, f)
        os.replace(tmp, self.path)
        os.chmod(self.path, 0o600)

    def host_id(self) -> str:
        data = self._read()
        if not data.get("ext_agent_host_id"):
            data["ext_agent_host_id"] = f"urn:uuid:{uuid.uuid4()}"
            self._write(data)
        return data["ext_agent_host_id"]

    def status(self) -> dict:
        d = self._read()
        return {"signed_in": bool(d.get("refresh_token") or d.get("access_token")), "email": d.get("email")}

    # ---------------------------------------------------------------- sign-in
    def start(self, redirect_uri: str) -> str:
        verifier = _b64url(secrets.token_bytes(48))
        state, nonce = secrets.token_urlsafe(24), secrets.token_urlsafe(24)
        d = self._read()
        client_id = d.get("client_id") or DYNAMIC_CLIENT
        params = {
            "client_id": client_id, "ext_agent_host_id": self.host_id(), "response_type": "code",
            "redirect_uri": redirect_uri, "scope": SCOPES, "resource": API, "state": state, "nonce": nonce,
            "code_challenge": _b64url(hashlib.sha256(verifier.encode()).digest()), "code_challenge_method": "S256",
        }
        if client_id == DYNAMIC_CLIENT:
            params["agent_name_hint"] = APP_NAME
        elif d.get("id_token"):
            params["id_token_hint"] = d["id_token"]
        with self.lock:
            self.flows = {k: v for k, v in self.flows.items() if v["at"] > time.time() - 600}
            self.flows[state] = {"verifier": verifier, "nonce": nonce, "client_id": client_id,
                                 "redirect_uri": redirect_uri, "at": time.time()}
        return f"{AUTHORIZE}?{urlencode(params)}"

    def finish(self, query: dict[str, str]) -> None:
        if query.get("error"):
            raise PermissionError("ChatGPT sign-in was cancelled." if query["error"] == "access_denied"
                                  else f"ChatGPT sign-in failed: {query['error']}")
        with self.lock:
            flow = self.flows.pop(query.get("state", ""), None)
        if not flow:
            raise PermissionError("Sign-in response didn't match a sign-in started here. Try again.")
        client_id = query.get("client_id") or flow["client_id"]
        if client_id == DYNAMIC_CLIENT:
            raise PermissionError("OpenAI didn't issue a client ID for this app.")
        r = self.http.post(TOKEN, data={
            "grant_type": "authorization_code", "client_id": client_id, "code": query.get("code", ""),
            "code_verifier": flow["verifier"], "redirect_uri": flow["redirect_uri"], "resource": API})
        if r.status_code != 200:
            raise PermissionError(f"OpenAI token exchange failed ({r.status_code}).")
        tok = r.json()
        # The ID token comes straight from the token endpoint over TLS (OIDC Core 3.1.3.7), so we check its
        # claims; the access token is what OpenAI's API itself validates.
        claims = _jwt_claims(tok.get("id_token", ""))
        aud = claims.get("aud")
        if claims.get("iss", "").rstrip("/") != ISSUER or (client_id not in (aud if isinstance(aud, list) else [aud])) \
                or claims.get("nonce") != flow["nonce"] or claims.get("exp", 0) < time.time():
            raise PermissionError("OpenAI's ID token didn't pass checks; not saved.")
        granted = set((tok.get("scope") or "").split())
        if "chatgpt.tokens.use.direct" not in granted:
            raise PermissionError("Plan usage wasn't granted for this account.")
        data = self._read()
        data.update(client_id=client_id, email=claims.get("email"), subject=claims.get("sub"), issuer=ISSUER,
                    id_token=tok.get("id_token"), access_token=tok.get("access_token"),
                    refresh_token=tok.get("refresh_token"), token_type=tok.get("token_type"),
                    expires_in=tok.get("expires_in", 3600), scopes=sorted(granted), saved_at=time.time())
        self._write(data)

    def access_token(self) -> str:
        with self.lock:
            d = self._read()
            if not d.get("access_token"):
                raise PermissionError("Not signed in with ChatGPT.")
            if d.get("saved_at", 0) + d.get("expires_in", 3600) - 120 > time.time():
                return d["access_token"]
            if not d.get("refresh_token"):
                raise PermissionError("ChatGPT sign-in expired. Sign in again.")
            r = self.http.post(TOKEN, data={"grant_type": "refresh_token", "client_id": d["client_id"],
                                            "refresh_token": d["refresh_token"], "resource": API})
            if r.status_code != 200:
                for k in ("access_token", "refresh_token", "id_token"):
                    d.pop(k, None)
                self._write(d)
                raise PermissionError("ChatGPT sign-in expired. Sign in again.")
            tok = r.json()
            d.update(access_token=tok["access_token"], refresh_token=tok.get("refresh_token", d["refresh_token"]),
                     id_token=tok.get("id_token", d.get("id_token")), expires_in=tok.get("expires_in", 3600),
                     saved_at=time.time())
            self._write(d)
            return d["access_token"]

    def sign_out(self) -> None:
        d = self._read()
        if d.get("refresh_token"):
            try:
                conf = self.http.get(f"{ISSUER}/.well-known/openid-configuration").json()
                if conf.get("revocation_endpoint"):
                    self.http.post(conf["revocation_endpoint"], data={
                        "token": d["refresh_token"], "token_type_hint": "refresh_token", "client_id": d["client_id"]})
            except (httpx.HTTPError, ValueError):
                pass
        keep = {k: d[k] for k in ("client_id", "ext_agent_host_id") if k in d}
        self._write(keep)

    # ---------------------------------------------------------------- model calls
    def models(self) -> list[dict]:
        r = self.http.get(f"{API}/models", headers={"authorization": f"Bearer {self.access_token()}"})
        r.raise_for_status()
        data = r.json()
        rows = data.get("models") or data.get("data") or []
        return [{"id": m.get("slug") or m.get("id"), "name": m.get("display_name") or m.get("slug") or m.get("id")}
                for m in rows if m.get("visibility", "list") == "list" and (m.get("slug") or m.get("id"))]

    def respond(self, body: dict) -> tuple[int, dict]:
        """Run one Responses API call on the user's plan. Returns (status, final response or error)."""
        body = {**body, "store": False, "stream": True}
        headers = {"authorization": f"Bearer {self.access_token()}", "content-type": "application/json"}
        final, error = None, None
        with self.http.stream("POST", f"{API}/responses", json=body, headers=headers, timeout=300) as r:
            if r.status_code != 200:
                r.read()
                try:
                    msg = r.json().get("error", {}).get("message")
                except ValueError:
                    msg = r.text[:300]
                return r.status_code, {"error": {"message": msg or f"OpenAI said {r.status_code}"}}
            for line in r.iter_lines():
                if not line.startswith("data:"):
                    continue
                payload = line[5:].strip()
                if payload == "[DONE]":
                    break
                try:
                    ev = json.loads(payload)
                except ValueError:
                    continue
                if ev.get("type") == "response.completed":
                    final = ev.get("response")
                elif ev.get("type") in ("response.failed", "error"):
                    err = (ev.get("response") or {}).get("error") or ev.get("error") or {}
                    error = err.get("message") or err.get("code") or "The request failed."
                    if err.get("code") == "subscription_sharing_usage_limit_exceeded":
                        error = "You've reached the usage limit you set for this app in ChatGPT settings."
        if final:
            return 200, final
        return 502, {"error": {"message": error or "No response from OpenAI."}}


def make_handler(web_dir: Path, auth: ChatGPTAuth, port: int):
    allowed_hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
    origin = f"http://127.0.0.1:{port}"
    redirect_uri = f"{origin}/auth/callback"

    class Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=str(web_dir), **kw)

        def log_message(self, fmt, *args):  # never log query strings (codes, tokens)
            print(f"{self.command} {urlparse(self.path).path} {args[1] if len(args) > 1 else ''}")

        def _json(self, status: int, data) -> None:
            body = json.dumps(data).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("cache-control", "no-store")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _redirect(self, url: str) -> None:
            self.send_response(302)
            self.send_header("location", url)
            self.send_header("cache-control", "no-store")
            self.end_headers()

        def _host_ok(self) -> bool:
            if self.headers.get("host") not in allowed_hosts:
                self.send_error(421, "Use http://127.0.0.1")
                return False
            return True

        def _same_origin(self) -> bool:
            if self.headers.get("origin") not in (origin, f"http://localhost:{port}") or \
                    "application/json" not in (self.headers.get("content-type") or ""):
                self._json(403, {"error": {"message": "Only the DealFactory page on this computer can call this."}})
                return False
            return True

        def end_headers(self):
            self.send_header("x-frame-options", "DENY")
            self.send_header("content-security-policy", "frame-ancestors 'none'")
            super().end_headers()

        def do_GET(self):
            if not self._host_ok():
                return
            url = urlparse(self.path)
            if url.path == "/api/local":
                return self._json(200, {"local": True, "chatgpt": auth.status()})
            if url.path == "/auth/chatgpt/start":
                if self.headers.get("host") != f"127.0.0.1:{port}":
                    return self._redirect(f"{origin}/auth/chatgpt/start")  # OpenAI needs 127.0.0.1, not localhost
                return self._redirect(auth.start(redirect_uri))
            if url.path == "/auth/callback":
                q = {k: v[0] for k, v in parse_qs(url.query).items()}
                try:
                    auth.finish(q)
                    return self._redirect("/#connect")
                except PermissionError as e:
                    return self._redirect("/?" + urlencode({"chatgpt_error": str(e)}) + "#connect")
            if url.path == "/api/chatgpt/models":
                if self.headers.get("sec-fetch-site") not in (None, "same-origin"):
                    return self._json(403, {"error": {"message": "same-origin only"}})
                try:
                    return self._json(200, {"models": auth.models()})
                except PermissionError as e:
                    return self._json(401, {"error": {"message": str(e)}})
                except httpx.HTTPError as e:
                    return self._json(502, {"error": {"message": f"Could not list models: {e}"}})
            return super().do_GET()

        def do_POST(self):
            if not self._host_ok() or not self._same_origin():
                return
            url = urlparse(self.path)
            length = int(self.headers.get("content-length") or 0)
            raw = self.rfile.read(min(length, 2_000_000)) if length else b"{}"
            if url.path == "/auth/chatgpt/logout":
                auth.sign_out()
                return self._json(200, {"ok": True})
            if url.path == "/api/chatgpt/responses":
                try:
                    body = json.loads(raw)
                    if not isinstance(body, dict):
                        raise ValueError
                except ValueError:
                    return self._json(400, {"error": {"message": "Expected a JSON object."}})
                try:
                    status, data = auth.respond(body)
                except PermissionError as e:
                    return self._json(401, {"error": {"message": str(e)}})
                except httpx.HTTPError as e:
                    return self._json(502, {"error": {"message": f"Could not reach OpenAI: {e}"}})
                return self._json(status, data)
            self._json(404, {"error": {"message": "not found"}})

    return Handler


def serve(port: int = 8766, web_dir: Path | None = None) -> None:
    web_dir = web_dir or Path(__file__).resolve().parents[2] / "web"
    if not (web_dir / "index.html").exists():
        raise SystemExit(f"web app not found at {web_dir}. Run from a DealFactory checkout.")
    handler = make_handler(web_dir, ChatGPTAuth(), port)
    with http.server.ThreadingHTTPServer(("127.0.0.1", port), handler) as srv:
        print(f"DealFactory web app at http://127.0.0.1:{port}/  (Ctrl+C to stop)")
        print("Sign in with ChatGPT works here; tokens are kept in", config_dir() / "chatgpt.json")
        srv.serve_forever()
