# DealFactory production

This deployment uses Cloudflare Pages Direct Upload and GitHub Actions. Only the generated public site is uploaded. The first UK-English guide serves Netherlands shoppers and can show checked offers without an AI key.

## Connect production

1. In Cloudflare Workers & Pages, create a Pages Direct Upload project and use `main` as the production branch. The project name determines its free `pages.dev` address. Keep the generated address until a custom domain is ready.
2. Create a Cloudflare API token restricted to the account, with Cloudflare Pages Edit permission. Save it as the GitHub Actions secret `CLOUDFLARE_API_TOKEN`. Set these GitHub Actions variables:

   | Variable | Value |
   | --- | --- |
   | `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID |
   | `CLOUDFLARE_PAGES_PROJECT` | Pages project name |
   | `SITE_URL` | Production HTTPS origin, without a path |
   | `CLOUDFLARE_WEB_ANALYTICS_TOKEN` | Optional public beacon token from a manually configured Cloudflare Web Analytics site |

   Use manual Web Analytics setup for this deployment so the build can manage the beacon. The beacon token is public by design. Keep the API token in Actions secrets.
3. Run **DealFactory site** on `main`. The workflow runs on pushes and once a day. Its summary reports how many offers passed verification and which production routes responded.
4. Open the homepage and the guide on mobile and desktop. Check the shopping brief, private data controls, guide links, and retailer prices. If Cloudflare Web Analytics is enabled, check that it receives page views. Verify the site in Google Search Console and submit `/sitemap.xml`.

Cloudflare documents [CI uploads](https://developers.cloudflare.com/pages/how-to/use-direct-upload-with-continuous-integration/) and [manual Web Analytics](https://developers.cloudflare.com/web-analytics/get-started/).

## Daily operations

- The public price check uses curated product pages in `ops/offer-sources.json`. Each run checks retailer access and includes only unambiguous, explicitly in-stock euro offers. If a source gives no verifiable price, the guide still links to it. A visitor's browser hides prices older than 36 hours.
- Use **DealFactory site** run summaries to diagnose verification or deployment failures. If a source goes quiet, compare the retailer's visible page to its structured offer data and update the source list through a pull request.
- Use Cloudflare Web Analytics for views and referrers and Search Console for search queries, clicks, and impressions. Check the guide weekly. Prioritize pages with search impressions and weak click-through or guides where the model compatibility question is still unanswered.
- For site improvements, keep changes in pull requests so the web and Python suites run before deployment. Cloudflare retains versions for rollback. When rolling back, the guide still hides prices past the freshness window.
- Keep initial promotion organic. Use the guide as the landing page and assess actual retailer intent before buying ads. Paid campaigns require a conversion event, an approved budget, and an ad account.

## Local release build

```sh
node --test web/tests/
uv run --locked pytest -q
uv run --locked python ops/build_public.py /tmp/dealfactory-public --site-url https://dealfactory.example
```

Build into a new output directory. Add `--refresh` to check retailers. Pass a real production HTTPS origin for a release.
