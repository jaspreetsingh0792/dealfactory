# Launch checklist

Target: public launch before 30 November 2026 (Europe/Amsterdam). Cost cap stays €0/month.

## Done on main

- Manual device entry is the first path. Gmail import is labeled a limited beta (at most 100 test users while Google’s restricted-scope review is pending). Merged in #29 and published. No email addresses are collected. A stored waitlist was not added, because a durable counter needs D1 Edit.
- Homepage, advisor and deals: local mobile Lighthouse was 100 performance, 100 accessibility, 100 SEO, 96 best practices. Live homepage on 27 Nov 2026: performance 99, accessibility 100, best practices 92, SEO 100.
- The 404 page is noindex, so Lighthouse SEO on that URL is lower on purpose.
- Sitemap has eight URLs, each with `lastmod`. `robots.txt` points at the sitemap.
- Cloudflare Web Analytics is already wired behind `CLOUDFLARE_WEB_ANALYTICS_TOKEN`. The snippet is omitted when the variable is empty. CSP allows `https://cloudflareinsights.com` and `https://static.cloudflareinsights.com` only when the beacon is injected into `script-src`.
- Read-only production smoke: `node ops/test_live_smoke.cjs`.
- On 27 Nov 2026 the curated offer pages were fetched again. Eleven were still in stock in euros. Philips Hue Bridge Pro at Coolblue was `OutOfStock` and was removed from `ops/offer-sources.json`. The homepage and deals page do not link to the archived stroller footmuff guide. That guide remains at its old URL and in the sitemap.

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

Do not post on social networks, send email, or submit forms as part of this launch work.
