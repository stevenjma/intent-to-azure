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

## Configure (three public values)

Copy `config.example.js` to `config.js` and fill in:

| Value | What it is | Where |
|---|---|---|
| `azureClientId` | Entra **App Registration** (type: *Single-page application*). Add redirect URI = your Pages URL; grant delegated **Azure Service Management / user_impersonation**. | Entra portal → App registrations |
| `githubClientId` | **GitHub OAuth App** client id. Callback URL = the Worker's `/callback`. | GitHub → Settings → Developer settings → OAuth Apps |
| `githubWorkerUrl` | Base URL of the deployed token-exchange Worker. | See [worker/README.md](./worker/README.md) |

All three are public identifiers, safe in the browser. The only real secret is the
GitHub OAuth **client secret**, which lives only in the Worker (`wrangler secret`).
`config.js` is gitignored so your ids never get committed.

## Deploy to GitHub Pages

1. **Enable Pages**: repo Settings → Pages → Source = **GitHub Actions**.
2. Push to `main`. The [`pages.yml`](../.github/workflows/pages.yml) workflow runs
   `npm run build:web` (compiles the engine → `web/engine/`) and publishes `web/`.
3. Deploy the [Worker](./worker/README.md) and fill in `config.js` (commit it to a
   private fork, or inject it in the workflow — it holds only public ids).

The Entra redirect URI and the GitHub OAuth callback must match your final Pages URL.

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
  only from `self` + `esm.sh` (MSAL), `connect-src` pinned to Azure/GitHub + the Worker.
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
