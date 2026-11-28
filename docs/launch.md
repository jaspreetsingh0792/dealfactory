# Launch checklist

Target: public launch before 30 November 2026 (Europe/Amsterdam). Cost cap stays €0/month.

## Done on main

- Manual device entry is the first path. Gmail import is labeled a limited beta (at most 100 test users while Google’s restricted-scope review is pending). Merged in #29 and published. No email addresses are collected. A stored waitlist was not added, because a durable counter needs D1 Edit.
- Live mobile Lighthouse on 28 Nov 2026, after the fit-note publish: `/` 99/100/92/100, `/deals/` 99/100/92/100, `/advisor/` 99/100/92/100, `/deals/shelly-plug-s-mtr-gen3/` 99/100/92/100, `/nl/` 99/100/92/100 (performance, accessibility, best practices, SEO). Every category is at least 90. Earlier local runs were 100/100/96/100, and the live homepage on 27 Nov 2026 was 99/100/92/100.
- Live mobile Lighthouse on 28 Nov 2026, after the affiliate publish, on the pages that copy changed: `/` 99/100/93/100, `/privacy/` 99/100/93/100, `/terms/` 99/100/93/100, `/nl/privacy/` 99/100/93/100, `/nl/terms/` 99/100/93/100 (performance, accessibility, best practices, SEO). Every category is at least 90.
- The 404 page is noindex, so Lighthouse SEO on that URL is lower on purpose.
- The sitemap lists the English pages, the Dutch home, deals, guide and advisor, and one URL per in-stock product. Each URL has `lastmod`. `robots.txt` points at the sitemap. The old stroller guide is not in it.
- Cloudflare Web Analytics is already wired behind `CLOUDFLARE_WEB_ANALYTICS_TOKEN`. The snippet is omitted when the variable is empty. CSP allows `https://cloudflareinsights.com` and `https://static.cloudflareinsights.com` only when the beacon is injected into `script-src`.
- Read-only production smoke: `node ops/test_live_smoke.cjs`.
- Published on 27 Nov 2026 and still live: Dutch home, deals, guide and advisor under `/nl/`; a page for each checked offer; protocol filters on `/deals/`; the FAQ; the advisor title, canonical and WebApplication data. `/guides/stroller-footmuffs/` is a 301 to `/deals/` and is not in the sitemap.
- On 27 Nov 2026 Philips Hue Bridge Pro at Coolblue was out of stock and was taken out of the curated list. On 28 Nov 2026 the same retailer page had one in-stock euro price, so it is in `ops/offer-sources.json` again with the Matter and Philips Hue tags already recorded. A product page is built only while that stock check succeeds. Out-of-stock offers are left out of the sitemap.
- Product pages now include what the product works with, the specs DealFactory already recorded, and a good-for / not-for note. The words come from `ops/product-notes.json` and the compatibility guide, not from another site's reviews.

## Held until you confirm

- #28 adds Google and GitHub sign-in, the free Workers AI model, opt-in setup sync, and a coming-soon page when those secrets or bindings are missing. Do not merge it until the owner steps below are done, or merge it only when you accept that sign-in will say “coming soon” until then. Bring-your-own AI keeps working either way.

## Still owner-only

- Google sign-in client, scopes `openid`, `email`, `profile` only. Redirects: `https://deals.agentsealteam.com/auth/callback/google` and `http://127.0.0.1:8788/auth/callback/google`. Secrets `GOOGLE_AUTH_CLIENT_ID` and `GOOGLE_AUTH_CLIENT_SECRET`.
- GitHub OAuth App. Callback `https://deals.agentsealteam.com/auth/callback/github`. Secrets `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`.
- D1 database `dealfactory-accounts`, apply `ops/d1/0001_accounts.sql` and `ops/d1/0002_user_state.sql`, set `DEALFACTORY_AUTH_DATABASE_ID`. The deployment token needs D1 Edit. Bind `AUTH` and Workers AI `AI`.
- Finish Google’s restricted-scope verification if Gmail import should leave the 100-user testing mode.
- Public Cloudflare Web Analytics token in `CLOUDFLARE_WEB_ANALYTICS_TOKEN`, if visitor stats should turn on. The token is not a secret, but only the owner can create it in the Cloudflare dashboard.
- Cloudflare 301 from `dealfactory-3uu.pages.dev/*` to `https://deals.agentsealteam.com/$1`.
- Search Console verification and sitemap submit.
- Do not publish `deals@agentsealteam.com` until the contact address is confirmed.
- Affiliate shop IDs, only if Jaspreet joins a program himself. Names and wrappers are in `docs/affiliates.md`. Leave them unset and every shop link stays the plain retailer URL. Do not put real IDs in the repository.

Do not post on social networks, send email, or submit forms as part of this launch work.

## Later, not in this launch

These stay notes until the pieces they need exist. They use only prices DealFactory has checked itself.

- Price history from repeated checks of the same retailer page. The daily check already writes `offer-history.json` for a short window. A longer history is a later page, not a copy of anyone else's chart.
- Price-drop alerts after #28 and D1 are available. No alert mail is sent before then, and no address is collected for it.
- One card that lists the same product at more than one shop, only when DealFactory has verified each of those shops.
