"""Read-only Gmail access, filtered to purchase emails.

* OAuth scope is `gmail.readonly` only; a token with any other scope is refused.
* The search query (config.yaml -> gmail.query) limits which messages are listed at all.
* Messages are parsed in memory; only extracted purchase fields are stored.

Setup (once): create a Google Cloud OAuth client of type "Desktop app", enable the Gmail API,
download the JSON to private/google_client_secret.json, then run `dealfactory gmail auth`.
"""

from __future__ import annotations

import base64
import email
import email.policy
import json
import os
from pathlib import Path
from typing import Iterator

import httpx

from .documents import Document, from_email_message, sha

SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"]
API = "https://gmail.googleapis.com/gmail/v1/users/me"

DEFAULT_QUERY = (
    '(category:purchases OR subject:(bestelling OR bestelbevestiging OR orderbevestiging OR factuur OR '
    'kassabon OR "je order" OR "uw order" OR "your order" OR "order confirmation" OR invoice OR receipt OR '
    'verzonden OR shipped OR retour OR return)) -category:promotions -category:social -in:chats -in:spam'
)


class GmailError(RuntimeError):
    pass


def _paths(private_dir: Path) -> tuple[Path, Path]:
    return private_dir / "google_client_secret.json", private_dir / "gmail_token.json"


def authorize(private_dir: Path) -> Path:
    """Run the browser OAuth flow and store a read-only token in private/ (mode 600)."""
    from google_auth_oauthlib.flow import InstalledAppFlow

    client, token = _paths(private_dir)
    if not client.exists():
        raise GmailError(
            f"Missing {client}. In Google Cloud Console: enable the Gmail API, create an OAuth client of type "
            "'Desktop app', download its JSON to that path, then run this again."
        )
    flow = InstalledAppFlow.from_client_secrets_file(str(client), SCOPES)
    creds = flow.run_local_server(port=0, open_browser=True, prompt="consent")
    _check_scopes(creds.scopes)
    token.write_text(creds.to_json())
    os.chmod(token, 0o600)
    return token


def _check_scopes(scopes) -> None:
    extra = set(scopes or []) - set(SCOPES)
    if extra:
        raise GmailError(f"Refusing a Gmail token with extra scopes {sorted(extra)}; only gmail.readonly is allowed.")


def load_credentials(private_dir: Path):
    from google.auth.transport.requests import Request
    from google.oauth2.credentials import Credentials

    _, token = _paths(private_dir)
    if not token.exists():
        raise GmailError("Not connected to Gmail yet. Run `dealfactory gmail auth` first.")
    info = json.loads(token.read_text())
    _check_scopes(info.get("scopes"))
    creds = Credentials.from_authorized_user_info(info, SCOPES)
    if not creds.valid:
        if creds.expired and creds.refresh_token:
            creds.refresh(Request())
            token.write_text(creds.to_json())
            os.chmod(token, 0o600)
        else:
            raise GmailError("Gmail token is no longer valid. Run `dealfactory gmail auth` again.")
    return creds


def disconnect(private_dir: Path) -> bool:
    """Delete the local token. (Also revoke access at myaccount.google.com/permissions.)"""
    _, token = _paths(private_dir)
    if token.exists():
        token.unlink()
        return True
    return False


class GmailReader:
    def __init__(self, access_token: str | None = None, http: httpx.Client | None = None):
        self.http = http or httpx.Client(timeout=30, headers={"Authorization": f"Bearer {access_token}"})

    def list_ids(self, query: str, max_messages: int) -> list[str]:
        ids: list[str] = []
        page = None
        while len(ids) < max_messages:
            params = {"q": query, "maxResults": min(100, max_messages - len(ids))}
            if page:
                params["pageToken"] = page
            r = self.http.get(f"{API}/messages", params=params)
            if r.status_code != 200:
                raise GmailError(f"Gmail list failed: HTTP {r.status_code}")
            data = r.json()
            ids += [m["id"] for m in data.get("messages", [])]
            page = data.get("nextPageToken")
            if not page:
                break
        return ids[:max_messages]

    def get(self, message_id: str) -> Document:
        r = self.http.get(f"{API}/messages/{message_id}", params={"format": "raw"})
        if r.status_code != 200:
            raise GmailError(f"Gmail get failed: HTTP {r.status_code}")
        raw = base64.urlsafe_b64decode(r.json()["raw"] + "==")
        msg = email.message_from_bytes(raw, policy=email.policy.default)
        return from_email_message(msg, gmail_ref(message_id))

    def documents(self, query: str, max_messages: int, skip_refs: set[str] = frozenset()) -> Iterator[Document]:
        for mid in self.list_ids(query, max_messages):
            if gmail_ref(mid) in skip_refs:
                continue
            yield self.get(mid)


def gmail_ref(message_id: str) -> str:
    return sha("gmail:" + message_id)


def build_query(base: str | None, since: str | None) -> str:
    q = base or DEFAULT_QUERY
    return f"{q} newer_than:{since}" if since else q
