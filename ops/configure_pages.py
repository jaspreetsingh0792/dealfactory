"""Resolve or create the DealFactory Pages project using account-scoped credentials."""

import json
import os
from pathlib import Path
import re
from urllib.error import HTTPError
from urllib.request import Request, urlopen


def request(url, api_token, data=None):
    body = json.dumps(data).encode() if data is not None else None
    req = Request(url, data=body, headers={
        "Authorization": f"Bearer {api_token}",
        "Content-Type": "application/json",
    })
    try:
        with urlopen(req, timeout=20) as response:
            payload = json.load(response)
    except HTTPError as error:
        if error.code == 404 and data is None:
            return None
        raise RuntimeError(f"Cloudflare Pages API returned HTTP {error.code}") from None
    if not payload.get("success"):
        raise RuntimeError("Cloudflare Pages API did not complete the request")
    return payload["result"]


def resolve_project(account_id, api_token, project_name, api=request):
    if not re.fullmatch(r"[a-f0-9]{32}", account_id):
        raise ValueError("Expected a Cloudflare account ID")
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", project_name):
        raise ValueError("Expected a Cloudflare Pages project name")
    projects = f"https://api.cloudflare.com/client/v4/accounts/{account_id}/pages/projects"
    project = api(f"{projects}/{project_name}", api_token)
    if project is None:
        project = api(projects, api_token, {"name": project_name, "production_branch": "main"})
    if project["production_branch"] != "main":
        raise RuntimeError("This Pages project must use main as its production branch")
    subdomain = project["subdomain"]
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]*\.pages\.dev", subdomain):
        raise RuntimeError("Cloudflare did not return a valid Pages subdomain")
    return f"https://{subdomain}"


def main():
    credentials = json.loads(os.environ.get("PAGES_CREDENTIALS") or "{}")
    account = credentials.get("account_id") or os.environ.get("CLOUDFLARE_ACCOUNT_ID")
    token = credentials.get("api_token") or os.environ.get("CLOUDFLARE_API_TOKEN")
    if not token:
        print("Set CLOUDFLARE_PAGES_DEPLOY in GitHub Actions secrets to enable publishing.")
        return
    if not re.fullmatch(r"[A-Za-z0-9_-]+", token):
        raise ValueError("Expected a Cloudflare API token")
    print(f"::add-mask::{token}")
    name = os.environ.get("PAGES_PROJECT") or "dealfactory"
    url = resolve_project(account or "", token, name)
    custom = os.environ.get("CUSTOM_DOMAIN")
    if custom:
        if not re.fullmatch(r"[a-z0-9.-]+", custom):
            raise ValueError("Expected a hostname for CUSTOM_DOMAIN")
        endpoint = f"https://api.cloudflare.com/client/v4/accounts/{account}/pages/projects/{name}/domains"
        domains = request(endpoint, token)
        domain = next((item for item in domains if item["name"] == custom), None)
        if domain is None:
            domain = request(endpoint, token, {"name": custom})
        print(f"Custom domain {custom}: {domain['status']}")
        if domain["status"] == "active":
            url = f"https://{custom}"
        else:
            print(f"DNS target for {custom}: {url.removeprefix('https://')}")
    with Path(os.environ["GITHUB_OUTPUT"]).open("a", encoding="utf-8") as output:
        print("ready=true", f"project={name}", f"url={url}", sep="\n", file=output)
    print(f"Cloudflare Pages project is ready at {url}")


if __name__ == "__main__":
    main()
