# azx web — App Intent → Azure, from your browser

A static single-page app that runs the azx engine **in the browser**: point it at a
GitHub repo, and it infers the Azure the app needs, previews the Bicep + ARM, and can
do a **real** what-if-gated deploy to your subscription and push a codified pipeline
repo — all with two buttons: **Sign in with Azure** and **Sign in with GitHub**.

No binary install. The engine is the same TypeScript that powers the `azx` CLI,
compiled to ES modules and served as static assets.

## How it works

```
GitHub repo ──REST──▶ file map ──▶ scan → intent → plan → Bicep / ARM / scaffold   (in-browser)
Azure  ◀── ARM REST ── what-if (gate) → deployment create        (MSAL PKCE, no backend)
GitHub ◀── git-data ── create repo + push scaffold               (OAuth via tiny Worker)
```

- **Azure**: `@azure/msal-browser` (PKCE) → ARM token → ARM REST. 100% client-side;
  Entra is SPA-native and ARM sends CORS. No secret, no backend.
- **GitHub**: OAuth needs one tiny [token-exchange Worker](./worker/README.md) (the
  code→token step needs the client secret and is CORS-blocked). Everything else —
  reading the repo, creating the repo, pushing the scaffold — is direct REST.
- **Deploy safety**: the app always runs an ARM **what-if** and shows the predicted
  changes; the Deploy button stays disabled until you've reviewed a successful what-if.

## Deployment model: hosted multi-tenant

azx runs as **one hosted instance** (the operator's) that **many customers use
directly** in the browser. There's exactly one Entra app, one GitHub OAuth App, one
token-exchange Worker, and one Pages origin — all owned by the operator. Each customer
brings their **own** Azure subscription and **own** GitHub account; their tokens are
held only in their browser tab (and pass transiently through the Worker for the GitHub
`code`→token exchange). Customers never configure anything.

Because customers sign in from **other** tenants, an **unverified** Entra app can hit an
admin-consent wall in locked-down tenants. Two things soften this:

- The app detects the admin-consent failure and shows a **one-click admin-consent link**;
  a tenant admin approves once for their whole org, then their users sign in normally.
- Completing **Publisher Verification** (see below) removes the "unverified" warning
  entirely and lets more tenants self-consent.

Tenants that allow user consent work immediately with no admin step.

## Operator setup checklist

Do these once, in order. All the IDs below are **public** (safe in the browser); the
only secret is the GitHub OAuth **client secret**, which lives only in the Worker.

1. **Enable Pages**: Settings → Pages → Source = **GitHub Actions**. Note your Pages
   URL: `https://<you>.github.io/<repo>/`.
2. **Register an Entra SPA app** (Azure portal → App registrations):
   - Platform **Single-page application**, Redirect URI = your exact Pages URL.
   - **Supported account types = multitenant** (add personal accounts too for the
     widest reach → `signInAudience` `AzureADandPersonalMicrosoftAccount`, which
     requires the app's access-token version = 2).
   - API permissions → delegated **Azure Service Management / user_impersonation**.
   - Copy the **Application (client) ID** → `AZURE_CLIENT_ID`.
3. **Create a GitHub OAuth App** (Settings → Developer settings → OAuth Apps):
   - Authorization callback URL = your Worker's `/callback` (from step 4).
   - Copy the **client ID** → `GH_OAUTH_CLIENT_ID`; keep the **client secret** for step 4.
4. **Deploy the token-exchange [Worker](./worker/README.md)** with `ALLOWED_ORIGIN` =
   your Pages origin and the GitHub client secret as a `wrangler secret`. Note its base
   URL → `GH_WORKER_URL`. `ALLOW_SIGNUP` defaults to `true` (new GitHub users can sign
   up mid-flow); set `false` for a closed audience. A custom domain works with no CSP change.
5. **Set repo Actions Variables** (Settings → Secrets and variables → Actions →
   **Variables**): `AZURE_CLIENT_ID`, `GH_OAUTH_CLIENT_ID`, `GH_WORKER_URL`, and
   optionally `AZURE_TENANT` (default `common` — admits any work/school **or** personal
   account) and `GH_SCOPES` (default `repo workflow read:user`). Push to `main` —
   [`pages.yml`](../.github/workflows/pages.yml) builds the engine and generates
   `web/config.js` from these Variables.
6. **(Recommended) Complete Publisher Verification** to drop the "unverified" banner —
   see [Publisher Verification](#publisher-verification-optional-but-recommended).

If any Variable is missing the site shows a **setup banner naming exactly what's
unset**, so partial configs fail loudly rather than at click time.

## Configure (reference)

`web/config.js` (gitignored) is generated in CI, or you can copy `config.example.js`
locally and fill in:

| Value | What it is |
|---|---|
| `azureClientId` | Entra SPA app **client ID** (your tenant). Redirect URI = your Pages URL. |
| `azureTenant` | `common` (default) / `organizations` / your tenant GUID. |
| `githubClientId` | Your **GitHub OAuth App** client ID. Callback = the Worker's `/callback`. |
| `githubWorkerUrl` | Base URL of your deployed token-exchange Worker. |
| `githubScopes` | OAuth scopes (default `repo workflow read:user`). Canonical value is guarded by `test/oauth-scopes-consistent.test.ts`. |

## Run locally

```bash
npm run build:web           # tsc + copy node-free engine modules into web/engine/
npx http-server web -p 8080 # or: python -m http.server 8080 --directory web
# open http://localhost:8080
```

The offline preview (analyze a public repo → intent/plan/Bicep/scaffold) works with no
config. Azure/GitHub sign-in and deploy need `config.js` + the Worker, and redirect
URIs registered for `http://localhost:8080` during local testing.

## Security / threat model

The browser threat model is the **inverse** of the CLI's. There's no shell, so the
CLI's argv/command-injection surface disappears — but the page holds a live **ARM
token** and a **GitHub token** in memory, so **XSS is the crown-jewel risk**. Mitigations:

- **Strict CSP** (in `index.html`): `default-src 'none'`, no inline scripts, scripts
  only from `self` + `esm.sh` (MSAL), `connect-src` pinned to Azure ARM + the GitHub
  API + esm.sh. The Worker isn't in `connect-src` because the SPA never fetches it —
  it's reached via `window.open` + `postMessage`.
- **Tokens are never persisted** — MSAL uses `memoryStorage`; the GitHub token is a
  module-scoped variable. A refresh signs you out.
- **OAuth token delivery is origin-pinned**: the Worker `postMessage`s to your exact
  Pages origin, never `*`.
- The engine treats the scanned repo as **untrusted data** (same validation as the
  CLI): the ledger/scaffold regexes and `isDeployLedger` guard run unchanged in-browser.

### Left to CI on purpose

The OIDC **bootstrap** (`az ad app create` + role assignment) is *not* in the browser —
it needs privileged Microsoft Graph consent. The pushed repo's `setup-azure-oidc.sh`
handles it, exactly as the CLI flow documents.

### Worker trust contract

In hosted mode the operator's Worker is the **one** server-side component every
customer's GitHub `code`→token exchange passes through. What this does and does not mean:

- The Worker sees each customer's GitHub token **transiently**, only long enough to
  `postMessage` it to that customer's tab at `ALLOWED_ORIGIN`. It does not store tokens,
  log them, or forward them anywhere else. Keep it that way — do not add logging that
  captures the token or the exchange response body.
- The Worker never sees **Azure** tokens: MSAL runs entirely in the customer's browser
  against Entra + ARM (both CORS-enabled), so ARM credentials never touch the operator.
- The GitHub OAuth **client secret** lives only as a `wrangler secret` in the Worker;
  it is never in the SPA, the repo, or `config.js`.
- `ALLOWED_ORIGIN` is the trust anchor for token delivery — it must be the exact Pages
  origin and nothing wildcard. This is a boundary, not a knob: do not loosen it.

Customers are trusting the operator to run this Worker honestly. That's the price of a
zero-config hosted experience; a customer who prefers zero third-party trust can still
fork and run their own instance.

### Secret rotation

- **GitHub OAuth client secret**: rotate in the OAuth App (Developer settings → OAuth
  Apps → Generate a new client secret), then `wrangler secret put GITHUB_CLIENT_SECRET`
  and redeploy the Worker. Old in-flight logins fail closed; users just retry. Revoke
  the old secret once the new one is live.
- **Compromise response**: revoke the OAuth client secret immediately (invalidates the
  exchange path for everyone), rotate as above. Entra has no secret in this flow (SPA +
  PKCE), so there's nothing to rotate on the Azure side.

## Publisher Verification (optional but recommended)

Publisher Verification adds the blue "verified" badge to the Entra consent screen and
lets more tenants self-consent, shrinking how often the admin-consent link is needed.
It is **not required** to run hosted azx — unverified simply means locked-down tenants
see the "needs admin approval" screen (which the in-app admin-consent link resolves).

To complete it later:

1. Enroll in the **Microsoft AI Cloud Partner Program** (formerly MPN) in Partner
   Center and note your **Partner (MPN) ID**.
2. Verify a **branded domain** you own in the partner account.
3. In Entra → App registrations → your app → **Branding & properties**, set the
   **Publisher domain** to a verified domain, then **Add MPN ID to verify publisher**.

Until then, the app's admin-consent link is the working bridge for gated tenants.
