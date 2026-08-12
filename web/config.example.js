/**
 * azx web — deployment configuration (HOSTED MULTI-TENANT).
 *
 * azx runs as ONE hosted instance (the operator's) that MANY customers use
 * directly. Each customer brings their OWN Azure subscription and OWN GitHub
 * account; the operator provides a single Entra app + single GitHub OAuth app +
 * single token-exchange Worker + single Pages origin. Copy this file to
 * `web/config.js` and fill in the values below — every one is a PUBLIC identifier
 * (safe to expose in a browser). The only real secret is the GitHub OAuth *client
 * secret*, which lives ONLY in the Worker, never here. `config.js` is gitignored.
 *
 * Because customers sign in from OTHER tenants, an unverified Entra app can hit an
 * admin-consent wall in locked-down tenants; the app surfaces a one-click
 * admin-consent link to clear it, and Publisher Verification (see web/README.md)
 * removes the "unverified" warning entirely.
 *
 * See web/README.md for the full operator setup checklist + trust contract.
 */
window.AZX_CONFIG = {
  /**
   * Entra (Azure AD) App Registration — type "Single-page application (SPA)".
   * Register it MULTI-TENANT so customers in other tenants can sign in
   * (signInAudience "AzureADandPersonalMicrosoftAccount" to also admit personal
   * accounts). Redirect URI must be the exact Pages URL, e.g.
   *   https://<user>.github.io/<repo>/
   * Grant delegated permission "Azure Service Management / user_impersonation".
   */
  azureClientId: "",

  /**
   * Sign-in authority for the hosted app. Use "common" to admit any work/school
   * OR personal Microsoft account, "organizations" for work/school tenants only,
   * or a specific tenant GUID/domain to restrict to a single org. Hosted mode
   * wants "common" for the widest reach.
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
