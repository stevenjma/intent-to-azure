/**
 * azx web — deployment configuration (HOSTED MULTI-TENANT).
 *
 * azx runs as ONE hosted instance (the operator's) that MANY customers use
 * directly. Each customer brings their OWN Azure subscription and OWN GitHub
 * account; the operator provides a single GitHub OAuth app + token-exchange
 * Worker + Pages origin. Copy this file to
 * `web/config.js` and fill in the values below — every one is a PUBLIC identifier
 * (safe to expose in a browser). The only real secret is the GitHub OAuth *client
 * secret*, which lives ONLY in the Worker, never here. `config.js` is gitignored.
 *
 * See web/README.md for the full operator setup checklist + trust contract.
 */
window.AZX_CONFIG = {
  /**
   * GitHub OAuth App client ID (Settings → Developer settings → OAuth Apps).
   * The matching client *secret* goes in the Worker only — NOT here.
   * Authorization callback URL must be the Worker's /callback (see worker/README.md).
   */
  githubClientId: "",

  /**
   * Base URL of the deployed token-exchange Worker (Cloudflare Worker / Azure
   * Function). It performs the one step a static page cannot: exchanging the GitHub
   * OAuth `code` for a user token, holding the client secret server-side.
   * e.g. "https://azx-gh-oauth.<you>.workers.dev"
   */
  githubWorkerUrl: "",

  /**
   * OAuth scopes requested from GitHub. `repo` is needed to create + push a repo;
   * `workflow` is required to write the generated `.github/workflows/deploy.yml`
   * pipeline (GitHub rejects workflow-file writes without it).
   */
  githubScopes: "repo workflow read:user",

  /**
   * Public workspace-based Application Insights connection string. This is an
   * ingestion identifier, not a credential. Leave empty to disable telemetry.
   */
  applicationInsightsConnectionString: "",

  /** Exact deployed commit, injected by the Pages workflow. */
  releaseSha: "",
};
