const OAUTH_STATE_KEY = "azx.gh.oauth_state";
const LEGACY_SESSION_KEY = "azx.gh.session";

const hash = window.location.hash || "";
let oauthResult = null;
if (/azx_gh_(token|error)=/.test(hash)) {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const state = params.get("state");
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
  let expected = null;
  try {
    expected = sessionStorage.getItem(OAUTH_STATE_KEY);
    sessionStorage.removeItem(OAUTH_STATE_KEY);
  } catch {
    oauthResult = { error: "GitHub sign-in requires sessionStorage for OAuth state validation." };
  }

  if (!oauthResult && (!expected || state !== expected)) {
    oauthResult = { error: "GitHub OAuth state mismatch — aborting." };
  } else if (!oauthResult) {
    oauthResult = {
      token: params.get("azx_gh_token"),
      error: params.get("azx_gh_error"),
    };
  }
}

// Remove sessions created by older releases before any third-party module loads.
try {
  sessionStorage.removeItem(LEGACY_SESSION_KEY);
} catch {
  /* storage may be unavailable outside an OAuth return */
}

const { boot } = await import("./app.js?v=20260910b");
boot(oauthResult);
