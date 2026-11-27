"""Submit changed public pages after their production content checks pass."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import secrets
import subprocess
from urllib.parse import urlsplit


def fingerprints(release):
    paths = {
        "/": release / "index.html",
        "/advisor/": release / "advisor/index.html",
        "/guides/smart-home-compatibility/": release / "guides/smart-home-compatibility/index.html",
        "/deals/": release / "deals/index.html",
        "/about/": release / "about/index.html",
        "/privacy/": release / "privacy/index.html",
        "/terms/": release / "terms/index.html",
    }
    result = {}
    for route, path in paths.items():
        content = re.sub(r"\d{4}-\d\d-\d\dT\d\d:\d\dZ", "CHECKED", path.read_text())
        result[route] = hashlib.sha256(content.encode()).hexdigest()
    return result


def run(mode, release, state, origin):
    state.mkdir(parents=True, exist_ok=True)
    previous = state / "accepted.json"
    key_file = state / "ownership-key"
    if mode == "prepare":
        if not key_file.exists():
            key_file.write_text(secrets.token_hex(20))
        key = key_file.read_text().strip()
        (release / f"{key}.txt").write_text(key)
        return
    key = key_file.read_text().strip()
    current = fingerprints(release)
    accepted = json.loads(previous.read_text()) if previous.exists() else {}
    changed = [origin + route for route, value in current.items() if accepted.get(origin + route) != value]
    if not changed:
        print("Search submission: no changed pages.")
        return
    data = {"host": urlsplit(origin).hostname, "key": key, "urlList": changed}
    response = subprocess.run([
        "curl", "-sS", "--max-time", "20", "--output", "/dev/null", "--write-out", "%{http_code}",
        "--header", "Content-Type: application/json", "--data-binary", "@-",
        "https://api.indexnow.org/indexnow",
    ], input=json.dumps(data), text=True, capture_output=True, check=True)
    if response.stdout not in {"200", "202"}:
        raise RuntimeError(f"IndexNow returned HTTP {response.stdout}; will retry at the next release")
    previous.write_text(json.dumps({origin + k: v for k, v in current.items()}))
    print(f"IndexNow accepted {len(changed)} changed URLs (HTTP {response.stdout}).")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("prepare", "submit"))
    parser.add_argument("release", type=Path)
    parser.add_argument("state", type=Path)
    parser.add_argument("origin")
    args = parser.parse_args()
    run(args.mode, args.release, args.state, args.origin.rstrip("/"))
