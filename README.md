# DealFactory

Open-source shopping advisor: **deals near you that fit what you already own.** You say what you need
("fleece footmuff for my stroller"). DealFactory finds products sold where you live and checks them
against your home and your things, with a source for every price. Anything it can't verify is shown as
unknown.

The public site is ad-free. Honest labelled affiliate links stay off until a shop ID is set, and they never change ranking or recommendations.

It has three parts. All of them use **your own AI** and keep **your data on your side**:

| Part | For | Where |
|---|---|---|
| **Web app** (`web/`) | Anyone. Your country is detected automatically (or you type a city), you bring a Claude, OpenAI or local model key, and everything is stored in your browser | static files, no server |
| **Shopping Context** (`spec/`) | An open JSON format for "what I own and want to buy", usable with ChatGPT, Claude, Gemini or any tool | [spec](spec/shopping-context.md) |
| **CLI + MCP server** (`src/`) | Power users: a deeper research pipeline, Gmail and receipt import, a private dashboard, and an MCP server so your assistant can read your context | Python 3.12 |

License: MIT.

## Web app

```bash
uv run dealfactory web        # http://127.0.0.1:8766  (or: python3 -m http.server -d web)
node --test web/tests         # offline tests: grounding, context format, location
```

To host it, put the `web/` folder on any static host (GitHub Pages, Cloudflare Pages, Netlify). There's
no build step and no backend.

- **Location.** The country is guessed on the device from your time zone and language, with no network
  call. If you type a city or tap "Use my location", OpenStreetMap Nominatim is asked. Coordinates are
  rounded to about 1 km first, and only country, region and city are kept.
- **Your AI.**
  - Claude: web search plus page reading. This gives the strongest checks, because quotes are matched
    against the page text.
  - OpenAI: web search with citations only. Its prices are marked `*`.
  - Any OpenAI-compatible endpoint (Ollama, LM Studio, OpenRouter): no web search, so you get a buying
    checklist and search links, never invented products or prices.

  Your key goes straight from the browser to your provider.
- **Grounding** is the same as in the Python pipeline. The AI researches first, then lists picks that
  may cite only pages it actually saw. Then `web/lib/ground.js` checks every quote, price and
  compatibility claim. A product with no source page is dropped.
- **Bring your context.** You can copy a prompt containing your context into any chat, ask your
  assistant to fill in your context from its memory (it comes in *unconfirmed*), or import and export
  the JSON file.
- **Privacy.** There are no accounts, cookies or analytics. A strict Content Security Policy is set.
  "Delete everything" wipes local storage.

## MCP server

```bash
uv run dealfactory mcp                                     # your private profile + imports + needs
uv run dealfactory mcp --context ~/Downloads/shopping-context.json   # a file exported from the web app
uv run dealfactory context export -o shopping-context.json # profile -> open format (private facts left out)
```

The tools are `get_shopping_context`, `find_owned`, `list_needs` and `add_need`. The first three are
read-only. The assistant does its own searching. DealFactory provides what it can't know (what you own,
your home and your needs) plus the honesty rules. Claude Desktop config:

```json
{"mcpServers": {"dealfactory": {"command": "dealfactory", "args": ["mcp", "--context", "/path/to/shopping-context.json"]}}}
```

## CLI pipeline (self-hosted, private)

## How it works

```
 private/needs.yaml ─┐          private/environment.yaml ──► profile (facts + provenance) ──► SQLite mirror
             ▼                         │
 ┌───────────────────────────────────────────────────────────────────────────────────────────────┐
 │ intake ─► research ─► candidates ─► fit ─► matrix ─► offers ─► recommend ─► publish            │
 │  LLM      LLM+web     LLM+web       LLM    code      LLM+web   LLM          Jinja → site/       │
 │           (cached     (shortlist +         (no LLM)  (retailer                                  │
 │            per         specs per                      domains   each stage writes               │
 │            category)   candidate)                     only)     runs/<need>/<run>/<stage>.json  │
 └───────────────────────────────────────────────────────────────────────────────────────────────┘
             │ every Claude call → runs/<need>/<run>/llm_log.jsonl (prompt, inputs, full response)
             ▼
 offers ─► SQLite price history          site/index.html · site/needs/<id>.html · site/private/environment.html
```

**Facts never come from the model's memory.** Every web step is two Claude calls:

1. **Research.** Claude uses the server-side `web_search` and `web_fetch` tools and writes notes. The code
   collects every URL it actually searched or fetched (with page text and a timestamp) and numbers them
   S1, S2 and so on.
2. **Structure.** A second call with a strict JSON schema turns the notes into data. It can cite only
   those source ids and must copy a verbatim quote.

The code then grounds each value:

| Situation | Result |
|---|---|
| Quote is on the fetched page and contains the value | `known`, verification `quote_verified` |
| Source was only a search hit (no page text to check) | `known`, verification `cited`, shown with `*` |
| Quote not on the page, unknown source id, no source | `unknown` |
| Price in the retailer page's schema.org JSON-LD (polite direct fetch) | `known`, verification `jsonld` |

The recommendation is judgement and is labelled that way. It may only pick shortlisted candidates and
existing offers. Any euro amount in its text that doesn't match a real offer or your budget is flagged.

## Quick start

```bash
cd ~/Projects/dealfactory
cp .env.example .env                       # add ANTHROPIC_API_KEY
cp examples/environment.example.yaml private/environment.yaml   # then edit it to match your home
cp examples/needs.example.yaml private/needs.yaml
uv run dealfactory doctor                  # checks setup
uv run dealfactory profile                 # shows facts that still need confirming
uv run dealfactory run --all               # runs both test needs and builds the site
uv run dealfactory serve                   # http://127.0.0.1:8765
```

Other commands:

```bash
uv run dealfactory run robot-vacuum                 # one need (new run)
uv run dealfactory run robot-vacuum --stage offers  # re-run one stage on the latest run
uv run dealfactory run robot-vacuum --from fit      # re-run fit → recommend (e.g. after editing your profile)
uv run dealfactory run stroller-footmuff --fresh-research
uv run dealfactory publish [--public]               # rebuild the site; --public drops private pages and facts
uv run dealfactory schemas                          # regenerate schemas/*.json
uv run dealfactory export | forget --yes            # see or delete everything stored about you
uv run pytest                                       # offline tests (fake Claude, no network)
```

## Repo layout

```
config.yaml                 model, effort per stage, retailers, rate limits (committed)
examples/                   environment.example.yaml, needs.example.yaml (copy to private/)
private/environment.yaml    YOUR profile (git-ignored)
private/needs.yaml          YOUR needs (git-ignored)
web/                        the public web app (static) + node tests
spec/                       Shopping Context v1 spec + JSON Schema
.env                        ANTHROPIC_API_KEY (git-ignored)
schemas/                    JSON schemas generated from the models
src/dealfactory/
  models.py                 all data models (stored models + LLM draft models)
  profile.py                YAML → facts with provenance; private-fact handling
  store.py                  SQLite: profile mirror, needs, offer observations, runs, recommendations
  llm.py                    Claude client, SourceRegistry, audit log
  fetch.py                  polite fetcher (robots.txt, rate limit, cache) + JSON-LD offer parser
  pipeline.py               RunContext, stage order, run bookkeeping
  stages/                   intake, research, candidates, fit, matrix, offers, recommend
  publish.py, templates/    static site
data/                       dealfactory.sqlite, research cache, HTTP cache (git-ignored)
runs/<need>/<run_id>/       stage JSON, llm_log.jsonl, usage.json (git-ignored)
site/                       generated site (git-ignored)
tests/                      offline end-to-end test with a fake Claude client
```

## Schemas

`schemas/` holds `environment_profile`, `owned_product`, `need`, `category_research`, `candidate`,
`fit_assessment`, `feature_matrix`, `offer` and `recommendation`, generated from `src/dealfactory/models.py`.
The main ideas:

- **Profile fact:** `{id: "home.floor_types", value, source: stated|email|receipt|inferred|example,
  confidence, status: confirmed|unconfirmed|rejected, private}`. Rejected facts are never used.
  Unconfirmed ones are used but labelled.
- **SourcedValue** (every spec, price, stock, shipping and returns field): `{value, unit,
  status: known|unknown, source_url, retrieved_at, quote, verification}`.
- **Recommendation pick:** `{role: top|budget|premium|if_you_care, candidate_id, offer_id, why_fits_you,
  tradeoffs, would_change_if, profile_fact_ids, spec_keys}`.
- Everything is scoped by `user_id`, which is `me` for now, so the profile and needs can become
  multi-user later.

## Editing your profile

Any value in `private/environment.yaml` can be plain (meaning you stated it and it's confirmed) or a block:

```yaml
home:
  floor_types: {value: [laminate, tiles], source: inferred, confidence: 0.6, status: unconfirmed}
```

Entries marked `source: example` are placeholders. Replace them, or reject them with `status: rejected`.
The profile has a version hash, and every recommendation records the version it used. After changing the
profile, run `dealfactory run <need> --from fit` (or the whole need) to recompute.

## Privacy

- `private/`, `data/`, `runs/`, `site/` and `.env` are git-ignored.
- Postcode and address facts are always private, and any fact can be marked `private: true`. A
  `--public` build drops the "my environment" page, private facts and audit paths. Every page is
  `noindex`, and `site/robots.txt` disallows all crawlers.
- Web searches sent to Anthropic include only your country (`user_location`), never your city or postcode.
- `dealfactory export` shows everything in the database; `dealfactory forget --yes` deletes it.

## Retailer access (Phase 1)

Offers are found by Claude's web search, restricted to the need's retailer domains. Product pages are
read by Claude's `web_fetch`. If `direct_fetch: true`, DealFactory also fetches each product page once to
read the schema.org price. That fetch honours robots.txt, waits 4 s between requests to the same host,
sends an honest User-Agent and caches for 6 h. If a retailer blocks automated access, we accept that.
There's no scraping of search pages, no evasion and no retries against blocks. Official feeds (bol.com
Partner API, Amazon PA-API) can replace this when you have the accounts.

## Cost and models

Defaults: `claude-opus-5-5`, with effort set per stage in `config.yaml`. One need with five candidates
is about 20 Claude calls and a few dozen searches and fetches. Category research is cached for 30 days.
Real token usage is printed after each run and saved to `runs/.../usage.json`. Every request uses the
server-side refusal fallback (`fallbacks: "default"`), so a rare safety decline is retried on another
model instead of failing.

## Purchase import (Phase 2)

```bash
# Gmail (read-only). Once: Google Cloud Console → enable Gmail API → OAuth client "Desktop app" →
# download JSON to private/google_client_secret.json
uv run dealfactory gmail auth                # browser consent; token in private/ (mode 600)
uv run dealfactory import gmail --dry-run    # how many purchase emails match; nothing read or sent
uv run dealfactory import gmail              # default: last 2 years, max 150 messages per run
uv run dealfactory import files ~/Receipts   # PDF receipts, .eml, .mbox (Google Takeout), .txt/.html
uv run dealfactory inventory                 # see everything imported
uv run dealfactory inventory confirm ID | reject ID | delete ID | edit ID --model "..."
uv run dealfactory inventory forget --yes    # delete all imported data
uv run dealfactory gmail disconnect          # delete the token (also revoke at myaccount.google.com/permissions)
```

How privacy is handled:

- **Read-only Gmail.** The token may only have the `gmail.readonly` scope; a token with any other scope is
  refused. Only messages matching a purchase filter are listed (order, invoice, receipt, shipping and
  return emails, minus promotions and social).
- **Nothing raw is stored.** Emails and files are parsed in memory. The database keeps only the extracted
  fields (shop, date, product, brand, model, category, price), plus a sha256 of the message id so a
  message is never read twice.
- **Personal details are removed before Claude sees anything.** Email addresses, phone numbers, delivery
  address blocks, IBAN and card digits, order and tracking numbers, links and your name are replaced.
  Emails without any price are skipped and never sent.
- **The audit log has no email text.** Prompts are logged as `<document omitted for privacy ...>`, and
  the model's reasoning is dropped. Only the extracted JSON is kept.
- **The same grounding rule applies.** An item is kept only if its quoted line is in the document.
  Brand, model and price are kept only if they're written there; otherwise they're unknown.

What happens with the result:

- Durable items and accessories become **unconfirmed owned products** (source `email`/`receipt`).
- If an item matches a product already in `environment.yaml`, it adds the purchase date, shop and price
  to that product instead of creating a duplicate.
- Returned items are left out. A shipping notice and order confirmation for the same order count as one
  purchase.
- Consumables become habit facts, `habits.shops_at` and `habits.repeat_purchases` ("diapers: about every
  28 days").
- `environment.yaml` always wins: write a habit there to confirm or override it.
- The private site has a **Purchases** page listing every imported item.

## Phases

1. **Phase 1 (done):** hand-written profile + needs → research → candidates → fit → matrix → offers
   (3 retailers per need) → recommendation → local site.
2. **Phase 2 (done):** Gmail (read-only, purchase emails only) + PDF receipts → inventory and habits, as unconfirmed facts.
3. **Open source (done):** public web app (any country, your own AI, browser-only data), Shopping Context
   format, MCP server.
4. Scheduled runs (GitHub Actions), price history charts, Telegram alerts, hosting the web app.
5. Feedback loop, second-hand (Marktplaats, opt-in), community retailer lists per country.
