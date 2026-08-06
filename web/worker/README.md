# azx GitHub OAuth token-exchange Worker

The SPA is otherwise 100% static. This ~90-line Cloudflare Worker does the **one**
step a static page cannot: exchange a GitHub OAuth `code` for a user access token
(the GitHub token endpoint needs the client *secret* and is not CORS-accessible).

Azure needs **no** worker — Entra + ARM are SPA-native (MSAL PKCE, no secret).

## What it does

```
SPA popup ──GET /login?state=&scope=──▶ Worker ──302──▶ github.com/login/oauth/authorize
GitHub ────GET /callback?code=&state=─▶ Worker ──exchange code→token──▶
   returns an HTML page that postMessages { type:"azx-github-token", token, state }
   to the SPA at ALLOWED_ORIGIN, then closes the popup.
```

The client secret lives only in the Worker's env. The token is posted to the SPA's
exact origin (never `*`) and held in memory there — never persisted.

## Deploy (Cloudflare Workers)

1. Create a **GitHub OAuth App** (Settings → Developer settings → OAuth Apps):
   - **Homepage URL**: your Pages URL, e.g. `https://YOUR_USER.github.io/intent-to-azure/`
   - **Authorization callback URL**: `https://azx-gh-oauth.YOUR_SUBDOMAIN.workers.dev/callback`
   - Note the **Client ID** and generate a **Client secret**.

2. Edit `wrangler.toml`:
   - `ALLOWED_ORIGIN` = your Pages **origin** (scheme + host only), e.g. `https://YOUR_USER.github.io`
   - `GITHUB_CLIENT_ID` = the OAuth App client id

3. Deploy and set the secret:
   ```bash
   npm i -g wrangler
   wrangler login
   wrangler secret put GITHUB_CLIENT_SECRET   # paste the client secret
   wrangler deploy
   ```

4. Put the Worker URL (e.g. `https://azx-gh-oauth.YOUR_SUBDOMAIN.workers.dev`) into
   `web/config.js` as `githubWorkerUrl`, and the client id as `githubClientId`.

## Azure Functions alternative

Any tiny HTTP function works — replicate the two routes (`/login`, `/callback`) and
the same env vars. Cloudflare is used here only because the free tier + `wrangler`
make it a two-command deploy. If you host elsewhere, add that origin to the SPA's
`connect-src` CSP in `web/index.html` (the default allows `*.workers.dev` and
`*.azurewebsites.net`).

## Security notes

- The secret is never sent to the browser and never committed (`wrangler secret`).
- `postMessage` targetOrigin is pinned to `ALLOWED_ORIGIN`; a malicious page can't
  receive the token.
- The callback page's CSP blocks framing and external scripts.
- Consider restricting the Worker route to your Pages origin via a `Referer`/origin
  check if you want defense-in-depth against unsolicited `/login` hits.
