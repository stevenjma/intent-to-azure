/**
 * azx web — deployment configuration (SELF-HOST TEMPLATE).
 *
 * azx is a fork-to-self-host template: each operator runs their OWN instance with
 * their OWN identities. Copy this file to `web/config.js` and fill in the values
 * below — every one is a PUBLIC identifier (safe to expose in a browser). The only
 * real secret is the GitHub OAuth *client secret*, which lives ONLY in the
 * token-exchange Worker, never here. `config.js` is gitignored so your ids never
 * get committed. This is NOT a shared hosted service: do not point your deployment
 * at someone else's Entra app or Worker.
 *
 * See web/README.md for the full per-operator setup checklist.
 */
window.AZX_CONFIG = {
  /**
   * Entra (Azure AD) App Registration — type "Single-page application (SPA)",
   * registered in YOUR tenant. Redirect URI must be the exact Pages URL, e.g.
   *   https://<user>.github.io/<repo>/
   * Grant delegated permission "Azure Service Management / user_impersonation".
   */
  azureClientId: "",

  /**
   * Entra tenant for YOUR app. Use your tenant GUID/domain to restrict sign-in to
   * your org, "organizations" for any work/school tenant, or "common" to also admit
   * personal Microsoft accounts. Because you register the app in your own tenant,
   * user consent is trivial (no unverified-publisher admin-consent wall).
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
