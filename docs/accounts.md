# Accounts and the free built-in AI

Sign-in is optional. Google and GitHub are the first providers. Another provider can be added by copying the Google block in `ops/account.js` (authorize URL, token exchange, profile read) and giving it the same session table. Gmail import is not part of sign-in. It stays the existing browser consent for `gmail.readonly` only.

Do not commit client secrets. Set them as Worker secrets or Pages environment variables.

## Redirect URIs to register

Google (OAuth client, web application):

- `https://deals.agentsealteam.com/auth/callback/google`
- `http://127.0.0.1:8788/auth/callback/google` for `wrangler pages dev`

GitHub OAuth App (create one at GitHub → Settings → Developer settings → OAuth Apps):

- Homepage URL: `https://deals.agentsealteam.com`
- Authorization callback URL: `https://deals.agentsealteam.com/auth/callback/github`

## Google consent screen

Use a separate OAuth client from the public Gmail import client. Scopes for this client, and only these scopes: `openid`, `email`, `profile`. Do not add Gmail scopes to the sign-in client.

## Environment variables

| Name | Purpose |
|---|---|
| `GOOGLE_AUTH_CLIENT_ID` | Google sign-in client id |
| `GOOGLE_AUTH_CLIENT_SECRET` | Google sign-in client secret |
| `GITHUB_CLIENT_ID` | GitHub OAuth App client id |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth App client secret |
| `AI_DAILY_USER_LIMIT` | Optional. Free answers per signed-in person per UTC day. Default `20`. |
| `AI_DAILY_NEURON_CEILING` | Optional. Site-wide neurons reserved per UTC day. Default `8000`, under the 10,000 neuron free allocation. |
| `AI_NEURONS_PER_REQUEST` | Optional. Neurons reserved before each built-in answer. Default `20`. |

## Bindings

`ops/d1/0001_accounts.sql` creates `users`, `sessions`, `oauth_states`, `ai_usage`, and `ai_usage_global`.

```
npx wrangler d1 create dealfactory-accounts
npx wrangler d1 execute dealfactory-accounts --remote --file=ops/d1/0001_accounts.sql
```

Bind that database as `AUTH`. Bind Workers AI as `AI`. The model is `@cf/meta/llama-3.1-8b-instruct-fp8-fast`: an 8B instruct model on the free catalog, and the fp8-fast rates (about 4,119 neurons per million input tokens and 34,868 per million output tokens) keep a capped answer near 20 neurons. The Pages deploy adds these bindings when `DEALFACTORY_AUTH_DATABASE_ID` is set. The deployment token needs D1 Edit to create the database.

The built-in path calls only this site (`/api/ai`). `connect-src` still allows `https:` so an optional custom bring-your-own base URL can be any https origin.
