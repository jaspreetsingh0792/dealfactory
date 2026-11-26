"""Sign in with ChatGPT on the local server (OpenAI faked with httpx.MockTransport)."""

from __future__ import annotations

import base64
import json
import socket
import stat
import threading
import time
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import httpx

from dealfactory.webserver import ChatGPTAuth, make_handler


def _jwt(claims: dict) -> str:
    enc = lambda d: base64.urlsafe_b64encode(json.dumps(d).encode()).rstrip(b"=").decode()  # noqa: E731
    return f"{enc({'alg': 'none'})}.{enc(claims)}.sig"


class FakeOpenAI:
    def __init__(self):
        self.nonce = None
        self.calls: list[httpx.Request] = []

    def __call__(self, req: httpx.Request) -> httpx.Response:
        self.calls.append(req)
        if req.url.path == "/api/accounts/oauth/token":
            form = parse_qs(req.content.decode())
            if form["grant_type"] == ["refresh_token"]:
                return httpx.Response(200, json={"access_token": "at2", "refresh_token": "rt2", "expires_in": 3600})
            assert form["client_id"] == ["oaiapp_123"] and form["code"] == ["c0de"] and form["code_verifier"][0]
            return httpx.Response(200, json={
                "access_token": "at1", "refresh_token": "rt1", "expires_in": 3600, "token_type": "Bearer",
                "scope": "openid email offline_access resource.invoke chatgpt.tokens.use.direct",
                "id_token": _jwt({"iss": "https://auth.openai.com", "aud": "oaiapp_123", "nonce": self.nonce,
                                  "exp": time.time() + 600, "email": "me@example.com", "sub": "u1"})})
        if req.url.path == "/v1/responses":
            body = json.loads(req.content)
            assert body["store"] is False and body["stream"] is True
            assert req.headers["authorization"] in ("Bearer at1", "Bearer at2")
            sse = ('data: {"type":"response.created"}\n\n'
                   'data: {"type":"response.completed","response":{"output":[{"type":"message","content":'
                   '[{"type":"output_text","text":"{\\"ok\\":true}"}]}]}}\n\n')
            return httpx.Response(200, text=sse, headers={"content-type": "text/event-stream"})
        if req.url.path == "/v1/models":
            return httpx.Response(200, json={"models": [{"slug": "gpt-6.2-sol", "display_name": "GPT", "visibility": "list"},
                                                        {"slug": "hidden", "visibility": "hide"}]})
        return httpx.Response(404)


def _signed_in(tmp_path: Path) -> tuple[ChatGPTAuth, FakeOpenAI]:
    fake = FakeOpenAI()
    auth = ChatGPTAuth(tmp_path, httpx.Client(transport=httpx.MockTransport(fake)))
    url = urlparse(auth.start("http://127.0.0.1:8766/auth/callback"))
    q = {k: v[0] for k, v in parse_qs(url.query).items()}
    assert q["client_id"] == "dynamic_agent_client" and q["agent_name_hint"] == "DealFactory"
    assert q["redirect_uri"] == "http://127.0.0.1:8766/auth/callback" and q["code_challenge_method"] == "S256"
    assert "chatgpt.tokens.use.direct" in q["scope"] and q["resource"] == "https://api.openai.com/v1"
    fake.nonce = q["nonce"]
    auth.finish({"code": "c0de", "state": q["state"], "client_id": "oaiapp_123"})
    return auth, fake


def test_sign_in_stores_tokens_privately_and_relays(tmp_path: Path):
    auth, fake = _signed_in(tmp_path)
    saved = json.loads((tmp_path / "chatgpt.json").read_text())
    assert saved["client_id"] == "oaiapp_123" and saved["email"] == "me@example.com"
    assert stat.S_IMODE((tmp_path / "chatgpt.json").stat().st_mode) == 0o600
    status, data = auth.respond({"model": "gpt-6.2-sol", "input": "hi", "store": True})
    assert status == 200 and data["output"][0]["content"][0]["text"] == '{"ok":true}'
    assert [m["id"] for m in auth.models()] == ["gpt-6.2-sol"]
    # expiry -> refresh with the issued client id
    saved["saved_at"] = 0
    (tmp_path / "chatgpt.json").write_text(json.dumps(saved))
    assert auth.access_token() == "at2"
    # a second sign-in reuses the issued client id
    q = parse_qs(urlparse(auth.start("http://127.0.0.1:8766/auth/callback")).query)
    assert q["client_id"] == ["oaiapp_123"] and "agent_name_hint" not in q


def test_bad_state_or_nonce_is_refused(tmp_path: Path):
    fake = FakeOpenAI()
    auth = ChatGPTAuth(tmp_path, httpx.Client(transport=httpx.MockTransport(fake)))
    try:
        auth.finish({"code": "x", "state": "forged", "client_id": "oaiapp_123"})
        raise AssertionError("forged state accepted")
    except PermissionError:
        pass
    q = {k: v[0] for k, v in parse_qs(urlparse(auth.start("http://127.0.0.1:1/auth/callback")).query).items()}
    fake.nonce = "wrong"
    try:
        auth.finish({"code": "c0de", "state": q["state"], "client_id": "oaiapp_123"})
        raise AssertionError("wrong nonce accepted")
    except PermissionError:
        pass
    assert not (tmp_path / "chatgpt.json").exists() or "access_token" not in (tmp_path / "chatgpt.json").read_text()


def test_http_routes_only_answer_this_page(tmp_path: Path):
    auth, _ = _signed_in(tmp_path)
    web = tmp_path / "web"
    web.mkdir()
    (web / "index.html").write_text("<p>hi</p>")
    with socket.socket() as sk:
        sk.bind(("127.0.0.1", 0))
        port = sk.getsockname()[1]
    srv = ThreadingHTTPServer(("127.0.0.1", port), make_handler(web, auth, port))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{port}"
    try:
        with httpx.Client() as c:
            assert c.get(f"{base}/").text == "<p>hi</p>"
            assert c.get(f"{base}/api/local").json() == {"local": True, "chatgpt": {"signed_in": True, "email": "me@example.com"}}
            body = {"model": "m", "input": "hi"}
            assert c.post(f"{base}/api/chatgpt/responses", json=body, headers={"origin": "https://evil.example"}).status_code == 403
            assert c.post(f"{base}/api/chatgpt/responses", json=body).status_code == 403  # no Origin
            ok = c.post(f"{base}/api/chatgpt/responses", json=body, headers={"origin": base})
            assert ok.status_code == 200 and "access_token" not in ok.text
            assert c.get(f"{base}/api/local", headers={"host": "evil.example"}).status_code == 421
            r = c.get(f"{base}/auth/chatgpt/start")
            assert r.status_code == 302 and r.headers["location"].startswith("https://auth.openai.com/api/accounts/authorize?")
    finally:
        srv.shutdown()
