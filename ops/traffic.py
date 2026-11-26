"""Prepare the first-party daily counters and read a seven-day growth report."""
import json
import os
from datetime import date, timedelta
from pathlib import Path
from urllib.parse import quote

from configure_pages import request

DATABASE = "dealfactory-traffic"
CREATE_TABLE = """CREATE TABLE IF NOT EXISTS daily_events (
    day TEXT NOT NULL, event TEXT NOT NULL, page TEXT NOT NULL, total INTEGER NOT NULL,
    PRIMARY KEY (day, event, page))"""


def prepare(account, token):
    base = f"https://api.cloudflare.com/client/v4/accounts/{account}/d1/database"
    databases = request(f"{base}?name={quote(DATABASE)}", token)
    db = next((item for item in databases if item["name"] == DATABASE), None)
    if db is None:
        db = request(base, token, {"name": DATABASE})
    query = f"{base}/{db['uuid']}/query"
    request(query, token, {"sql": CREATE_TABLE})
    start = (date.today() - timedelta(days=7)).isoformat()
    end = date.today().isoformat()
    rows = request(query, token, {
        "sql": "SELECT page,event,SUM(total) AS n FROM daily_events WHERE day>=? AND day<? GROUP BY page,event",
        "params": [start, end],
    })[0]["results"]
    totals = {}
    for row in rows:
        # Older releases counted the plain event name. New ones append the arrival channel.
        key = (row["page"], row["event"].split("/", 1)[0])
        totals[key] = totals.get(key, 0) + int(row["n"])
    return db["uuid"], [{"page": page, "event": event, "n": n} for (page, event), n in totals.items()]


def main():
    bundle = json.loads(os.environ.get("PAGES_CREDENTIALS") or "{}")
    account = bundle.get("account_id") or os.environ["CLOUDFLARE_ACCOUNT_ID"]
    token = bundle.get("api_token") or os.environ["CLOUDFLARE_API_TOKEN"]
    try:
        db, rows = prepare(account, token)
    except RuntimeError as error:
        if str(error) not in {"Cloudflare Pages API returned HTTP 403", "Cloudflare Pages API returned HTTP 401"}:
            raise
        print("::warning::Traffic counters require D1 Edit on the Cloudflare deployment token.")
        return
    with Path(os.environ["GITHUB_OUTPUT"]).open("a") as out:
        print(f"database={db}", file=out)
    with Path(os.environ["GITHUB_STEP_SUMMARY"]).open("a") as summary:
        print("Aggregate traffic reporting is active. Seven complete UTC days were evaluated.", file=summary)
    Path(os.environ["RUNNER_TEMP"], "dealfactory-traffic.json").write_text(json.dumps(rows))


if __name__ == "__main__":
    main()
