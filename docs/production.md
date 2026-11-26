# DealFactory production

This deployment uses Cloudflare Pages Direct Upload and GitHub Actions. Only the generated public site is uploaded. The first UK-English guide serves Netherlands shoppers and can show checked offers without an AI key.

## Connect production

1. Create an account-scoped Cloudflare API token with **Cloudflare Pages → Edit**. Under GitHub Actions secrets, add `CLOUDFLARE_PAGES_DEPLOY` with this JSON value, replacing both placeholder values:

   ```json
   {"account_id":"your Cloudflare account ID","api_token":"your Cloudflare Pages Edit token"}
   ```

2. In the repository's Actions tab, run **DealFactory site** on `main`. It creates or reuses the `dealfactory` Pages project, uses its assigned `pages.dev` hostname, deploys, and checks the live routes. It also runs on pushes and once a day.
3. Check the homepage and guide on mobile and desktop. Verify the site in Google Search Console and submit `/sitemap.xml`.

Optional GitHub Actions variables:

| Variable | Value |
| --- | --- |
| `CLOUDFLARE_PAGES_PROJECT` | Override the default project name `dealfactory`. An existing project must use `main` as its production branch. |
| `SITE_URL` | Override the production HTTPS origin once a custom domain is active in Pages. |
| `CLOUDFLARE_WEB_ANALYTICS_TOKEN` | Public beacon token from a manually configured Cloudflare Web Analytics site. |

For an existing setup, `CLOUDFLARE_ACCOUNT_ID` and the `CLOUDFLARE_API_TOKEN` secret also remain supported.

Cloudflare documents [CI uploads](https://developers.cloudflare.com/pages/how-to/use-direct-upload-with-continuous-integration/) and [manual Web Analytics](https://developers.cloudflare.com/web-analytics/get-started/).

## Daily operations

- The public price check uses curated product pages in `ops/offer-sources.json`. Each run checks retailer access and includes only unambiguous, explicitly in-stock euro offers. If a source gives no verifiable price, the guide still links to it. A visitor's browser hides prices older than 36 hours.
- Use **DealFactory site** run summaries to diagnose verification or deployment failures. If a source goes quiet, compare the retailer's visible page to its structured offer data and update the source list through a pull request.
- Use Cloudflare Web Analytics for views and referrers and Search Console for search queries, clicks, and impressions. Check the guide weekly. Prioritize pages with search impressions and weak click-through or guides where the model compatibility question is still unanswered.
- For site improvements, keep changes in pull requests so the web and Python suites run before deployment. Cloudflare retains versions for rollback. When rolling back, the guide still hides prices past the freshness window.
- Keep initial promotion organic. Use the guide as the landing page and assess actual retailer intent before buying ads. Paid campaigns require a conversion event, an approved budget, and an ad account.

## Local release build

```sh
node --test web/tests/*.test.mjs
uv run --locked pytest -q
uv run --locked python ops/build_public.py /tmp/dealfactory-public --site-url https://dealfactory.example
```

Build into a new output directory. Add `--refresh` to check retailers. Pass a real production HTTPS origin for a release.

## Automated discovery, measurement and promotion

The daily release checks the Babycare, Koeka and Jollein footmuff departments for new product links, then verifies individual offers. The public offer history records checked prices for comparisons across the last seven days. The RSS feed at `/offers.xml` and the guide's share link distribute the latest offers. The build writes a suggested organic campaign to its Actions summary.

The workflow registers `deals.agentsealteam.com` on the owner's Pages project. Once the domain is active, releases use it in canonical URLs and the sitemap. If domain verification is waiting for DNS, add the `deals` CNAME at the authoritative DNS provider using the Pages hostname printed in the production log.

Traffic measurement uses a Cloudflare D1 database named `dealfactory-traffic`. The deployment token needs D1 Edit to create the database and read aggregate reports. With that permission, the workflow provisions the database, applies the table schema, and binds the counter to the site. The browser respects Do Not Track and Global Privacy Control. The counter stores only UTC day, page group, event type, and count. Outbound clicks are a measure of retailer interest. Confirmed sales require a participating retailer's conversion data.

The daily job evaluates page views and retailer clicks over seven complete UTC days. Read the underlying totals in Cloudflare's D1 console by grouping the daily_events table by page and event. Once the guide has at least 30 views in that period, a click-to-view ratio under 10% moves verified offers above the compatibility advice. This is a simple layout adjustment. The workflow has no advertising credentials or paid spend.

The editorial agent runs Qwen2.5-0.5B-Instruct locally on the standard Actions runner. It chooses among factual editorial angles using the current offer count, observed price drops and guide layout. Each eligible angle has a reviewed search title, description and social preview. A comparison needs multiple verified offers. A price-drop headline needs a recorded decrease. When model inference is unavailable, publishing still uses the guide's default copy. The workflow records the editorial result and campaign draft in its run summary.

After the public content checks pass, the workflow submits changed page URLs to IndexNow. It compares content fingerprints, excluding the check timestamp, with the last accepted submission. The sitemap remains available to other crawlers.
