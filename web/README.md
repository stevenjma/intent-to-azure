# azx web — App Intent → Azure, from your browser

A static single-page app that runs the azx engine **in the browser**. Point it at a
GitHub repo to infer the Azure infrastructure the app needs, review the plan and
Bicep, then create a new infrastructure repo with a pull request.

The pull request is the hosted product's end state. The site does not request Azure
credentials, open Azure Portal or Cloud Shell, or deploy resources. The generated
repo contains the one-time Azure OIDC setup and a what-if-gated deployment workflow.

## Customer flow

1. Sign in with GitHub and analyze a repository.
2. Resolve any low-confidence planning decisions.
3. Review the generated plan, Bicep, and repo scaffold.
4. Create the infrastructure repo and pull request.
5. While the pull request is open, follow its README to run
   `scripts/setup-azure-oidc.sh` once from the PR branch.
6. Merge the pull request to run ARM what-if.
7. Inspect the preview, then manually run the workflow for the real deployment.

Nothing deploys merely because the pull request was created or merged. Until OIDC
setup is complete, the workflow skips safely.

## How it works

```text
GitHub repo ──REST──▶ file map ──▶ scan → intent → plan → Bicep / scaffold (browser)
GitHub      ◀──REST── create repo + push branch + open pull request      (OAuth Worker)
Azure      ◀──OIDC── what-if → production approval → deployment       (generated repo)
```

- **Browser analysis** uses the same TypeScript engine as the `azx` CLI, compiled
  to static ES modules.
- **GitHub** OAuth needs one small [token-exchange Worker](./worker/README.md)
  because the code-to-token exchange requires the client secret. Reading the source
  repo and creating the generated repo and PR use GitHub REST directly.
- **Azure** access exists only in the generated repo. Its setup script creates a
  federated identity, grants Contributor at the target resource-group scope, and
  writes the required GitHub repository variables. No Azure client secret is stored.

## Operator setup

1. Enable GitHub Pages with **GitHub Actions** as the source.
2. Deploy the token-exchange [Worker](./worker/README.md), with `ALLOWED_ORIGIN`
   set to the Pages origin and the GitHub OAuth client secret stored as a Worker
   secret.
3. Create a GitHub OAuth App whose callback URL is the Worker's `/callback`.
4. Set repository Actions variables:
   - `GH_OAUTH_CLIENT_ID`
   - `GH_WORKER_URL`
   - `GH_SCOPES` (optional; default `repo workflow read:user`)
   - `APPLICATIONINSIGHTS_CONNECTION_STRING` (optional; enables anonymous POC telemetry)
5. Push to `main`. [`pages.yml`](../.github/workflows/pages.yml) builds the engine
   and generates `web/config.js`.

If required configuration is missing, the site names the missing values in a setup
banner rather than failing after a customer begins the flow.

## Local development

Copy `config.example.js` to `config.js`, fill in the GitHub values, then:

```bash
npm run build:web
npx http-server web -p 8080
```

Open `http://localhost:8080`. The OAuth App and Worker must allow that application
URL for GitHub sign-in.

## Security model

The page may hold a live GitHub token, so XSS is the primary browser risk.

- The CSP allows application scripts from `self`; Azure/MSAL and ARM endpoints are
  not in the hosted runtime surface. When telemetry is configured, the page loads
  the Microsoft Application Insights SDK from `js.monitor.azure.com` with a pinned
  Subresource Integrity hash and connects only to Azure Monitor ingestion.
- The GitHub token is memory-only. Bootstrap validates OAuth state and removes the
  URL fragment before loading application modules, so reload requires sign-in again.
- OAuth return URLs are pinned to the exact configured application origin and path.
- Source repositories are untrusted input; the engine retains its validation and
  deployment-confirmation guards in-browser.
- The Worker sees the GitHub token only during exchange and must not store, log, or
  forward it. Its client secret stays in Worker secret storage.

## POC telemetry

Optional telemetry uses workspace-based Application Insights and Log Analytics. Deploy
[`infra/telemetry/main.bicep`](../infra/telemetry/main.bicep), then set its public
`connectionString` output as the `APPLICATIONINSIGHTS_CONNECTION_STRING` repository
variable. The Pages workflow injects it into `web/config.js`.

The custom event payload contains only funnel stages, durations, coarse
framework/hosting categories, resource and confirmation counts, failure codes, a
random browser identifier, a per-tab session identifier, and the release SHA. It does
not send GitHub identity, repository names or URLs, source content, intent evidence,
access tokens, or error messages. Cookies, automatic page views, dependency tracking,
route tracking, and exception collection are disabled. Azure Monitor may add its
standard browser/device and coarse location context; IP masking remains enabled.

The footer provides an opt-out stored in the browser and deletes the pseudonymous
identifiers when collection is disabled. `Do Not Track` disables collection
automatically. The deployment defaults to 30-day retention and caps ingestion at
1 GB/day because the public connection string is an ingestion identifier rather than
an authentication credential. Use
[`infra/telemetry/queries.kql`](../infra/telemetry/queries.kql) for the initial funnel,
reliability, repeat-browser, and planning-quality views.

### Clickjacking headers

The meta CSP in `index.html` cannot enforce `frame-ancestors`. GitHub Pages cannot
set repository-defined response headers. On a configurable host, set:

```text
Content-Security-Policy: default-src 'none'; script-src 'self' https://js.monitor.azure.com; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://api.github.com https://github.com https://*.in.applicationinsights.azure.com https://dc.services.visualstudio.com; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; upgrade-insecure-requests
```

`X-Frame-Options: DENY` is an appropriate legacy fallback. These must be real HTTP
headers; adding either directive to a meta tag does not protect against framing.
