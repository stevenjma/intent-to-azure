/**
 * azx web — deployment configuration.
 *
 * Copy this file to `web/config.js` and fill in the three values below. `config.js`
 * is gitignored so your client IDs never get committed. All three are PUBLIC
 * identifiers (safe to expose in a browser) — the only real secret is the GitHub
 * OAuth *client secret*, which lives ONLY in the token-exchange Worker, never here.
 *
 * See web/README.md for how to provision each of these.
 */
window.AZX_CONFIG = {
  /**
   * Entra (Azure AD) App Registration — type "Single-page application (SPA)".
   * Redirect URI must be the exact Pages URL, e.g.
   *   https://<user>.github.io/<repo>/
   * Grant delegated permission "Azure Service Management / user_impersonation".
   */
  azureClientId: "",

  /**
   * Entra tenant. Use "common" to let any work/school/personal account sign in,
   * or a specific tenant GUID / domain to restrict it.
   */
  azureTenant: "common",

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
};
