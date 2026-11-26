# Connections: what each one needs

| Connection | Works on the public site | Works locally (`uv run dealfactory web`) | Who pays for the AI | One-time setup by the site owner |
|---|---|---|---|---|
| Sign in with OpenRouter | yes | yes | visitor's OpenRouter credits | none |
| Open in Claude / Open in ChatGPT | yes | yes | visitor's Claude or ChatGPT plan | none |
| Claude.ai connector | yes | yes | visitor's Claude plan | included at `/mcp` in the Pages deployment |
| Sign in with ChatGPT (plan usage) | local-server flow only | yes | visitor's ChatGPT plan | none |
| API key (Claude, OpenAI) or local model | yes | yes | visitor's key | none |
| Gmail purchase import | yes, up to 100 test users until Google verifies the app | yes | visitor's AI reads the emails | Google OAuth client (below) |

Claude subscribers can use **Open in Claude** or install the MCP connector inside Claude.

## Gmail on the hosted advisor

1. Enable the Gmail API in the DealFactory Google Cloud project. Configure an external OAuth consent screen with the support contact and read-only Gmail scope, `https://www.googleapis.com/auth/gmail.readonly`.
2. Create a Web application client. Register `https://dealfactory-3uu.pages.dev` as the authorized JavaScript origin and `https://dealfactory-3uu.pages.dev/oauth/callback/` as the exact redirect URI. Register each additional production hostname with the same callback path before using it.
3. Add testers in Google Auth Platform while the app is in Testing. Public access to this restricted scope requires Google's verification. [Gmail scope documentation](https://developers.google.com/workspace/gmail/api/auth/scopes)
4. Save the public OAuth client ID as the GitHub Actions repository variable `DEALFACTORY_GOOGLE_CLIENT_ID` and run the DealFactory site workflow. The public config is generated on each deployment. The client secret is unnecessary.

For a local installation, configure `googleClientId` in `web/config.js` and register `http://127.0.0.1:8766` and `http://127.0.0.1:8766/oauth.html`. Visitors choose their own AI provider. The browser sends redacted receipt text to the selected provider to extract purchases.

## Claude.ai connector

The Pages deployment includes a stateless MCP endpoint at `https://dealfactory-3uu.pages.dev/mcp`. Add that URL in Claude's custom connector settings. It exposes shopping rules and a public retailer price and quote check. The **Open in Claude** and **Open in ChatGPT** buttons send the visitor's shopping brief to their chosen chat. **Sign in with OpenRouter** connects a visitor-owned model account to the advisor.

## Sign in with ChatGPT (local only)

Run `uv run dealfactory web` and click **Sign in with ChatGPT**. OpenAI registers this install the first
time. The tokens go to `~/.config/dealfactory/chatgpt.json` (owner-only) and never reach the browser.
Requests run on your ChatGPT plan with `store: false`. You can set a weekly cap for the app in ChatGPT
settings. OpenAI's terms say plan usage is for open-source and locally hosted apps. A hosted version would
need OpenAI's approval through their interest form.
