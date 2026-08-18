/**
 * azx GitHub OAuth token-exchange Worker (Cloudflare Workers, module syntax).
 *
 * This is the ONLY server-side piece azx needs, and it does exactly one thing a
 * static page cannot: exchange a GitHub OAuth `code` for a user access token. The
 * GitHub token endpoint requires the client *secret* and is not CORS-accessible,
 * so it must run off-browser. The secret lives only in this Worker's env — never
 * in the SPA, never in the repo.
 *
 * Flow:
 *   SPA popup → GET /login?state=&scope=   → 302 to github.com/login/oauth/authorize
 *   GitHub    → GET /callback?code=&state= → exchange code→token, then EITHER:
 *     • popup mode (state `<csrf>.p`): return an HTML page that postMessages
 *       { type:"azx-github-token", token, state } to the opener (SPA) and closes.
 *     • redirect mode (state `<csrf>.r.<b64url(returnUrl)>`): 302 back to the SPA
 *       with the token in the URL fragment. Used when the SPA's popup was blocked
 *       (embedded browsers, strict blockers). The return URL is validated against
 *       ALLOWED_ORIGIN to prevent open redirects.
 *
 * Required env (wrangler secrets / vars):
 *   GITHUB_CLIENT_ID      – OAuth App client id (public)
 *   GITHUB_CLIENT_SECRET  – OAuth App client secret (SECRET)
 *   ALLOWED_ORIGIN        – exact Pages origin, e.g. https://you.github.io
 *   APP_URL               – optional; fallback return URL for redirect mode when
 *                           the state-encoded return URL is missing/invalid.
 *                           Defaults to ALLOWED_ORIGIN. Set to the full app URL
 *                           for project sites, e.g. https://you.github.io/app/.
 *   ALLOW_SIGNUP          – optional; "true" (default) lets users without a
 *                           GitHub account sign up mid-flow. Set "false" to keep
 *                           the OAuth screen sign-in-only for a closed audience.
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/login") {
      const state = url.searchParams.get("state") || "";
      const scope = url.searchParams.get("scope") || "repo workflow read:user";
      const redirectUri = `${url.origin}/callback`;
      const gh = new URL("https://github.com/login/oauth/authorize");
      gh.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
      gh.searchParams.set("redirect_uri", redirectUri);
      gh.searchParams.set("scope", scope);
      gh.searchParams.set("state", state);
      // Public hosted SaaS: default to allowing account sign-up so new GitHub
      // users aren't dead-ended. Operators can set ALLOW_SIGNUP="false" to lock
      // the flow to existing accounts.
      const allowSignup = (env.ALLOW_SIGNUP ?? "true").toLowerCase() === "true";
      gh.searchParams.set("allow_signup", allowSignup ? "true" : "false");
      return Response.redirect(gh.toString(), 302);
    }

    if (url.pathname === "/callback") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state") || "";
      const redirectMode = isRedirectState(state);
      if (!code) return finish(env, redirectMode, { error: "missing_code", state });

      const res = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          client_id: env.GITHUB_CLIENT_ID,
          client_secret: env.GITHUB_CLIENT_SECRET,
          code,
          redirect_uri: `${url.origin}/callback`,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!data.access_token) {
        return finish(env, redirectMode, { error: data.error || "exchange_failed", state });
      }
      return finish(env, redirectMode, { token: data.access_token, state });
    }

    return new Response("azx github oauth worker", { status: 200 });
  },
};

/**
 * The SPA encodes the flow in the OAuth `state` (the only value GitHub round-trips):
 *   `<csrf>.p`                       → popup flow (postMessage back to opener)
 *   `<csrf>.r.<base64url(returnUrl)>` → redirect flow (302 back with token in fragment)
 * csrf is a UUID (no dots) and the base64url segment has no dots, so a plain split
 * is unambiguous.
 */
function isRedirectState(state) {
  return state.split(".")[1] === "r";
}

/** Decode the SPA's return URL from a redirect-mode state, or null. */
function decodeReturnUrl(state) {
  const parts = state.split(".");
  if (parts[1] !== "r" || !parts[2]) return null;
  try {
    const b64 = parts[2].replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 ? b64 + "=".repeat(4 - (b64.length % 4)) : b64;
    return atob(pad);
  } catch {
    return null;
  }
}

/** Send the result to the SPA via the flow it asked for. */
function finish(env, redirectMode, payload) {
  return redirectMode ? redirectBack(env, payload) : htmlMessage(env, payload);
}

/**
 * Redirect-flow return: 302 back to the SPA with the token/error in the URL
 * FRAGMENT (never sent to a server, not in the Referer header). The SPA reads it
 * on load and immediately strips it from history. The destination is the SPA's
 * own return URL, but we accept it ONLY if it starts with our configured
 * ALLOWED_ORIGIN — otherwise we fall back to APP_URL/ALLOWED_ORIGIN — so a forged
 * state can't turn this into an open redirect.
 */
function redirectBack(env, payload) {
  const allowed = env.ALLOWED_ORIGIN;
  let dest = decodeReturnUrl(payload.state);
  if (!dest || !dest.startsWith(allowed)) dest = env.APP_URL || allowed;
  const frag = new URLSearchParams();
  if (payload.token) frag.set("azx_gh_token", payload.token);
  if (payload.error) frag.set("azx_gh_error", payload.error);
  if (payload.state) frag.set("state", payload.state);
  return Response.redirect(`${dest}#${frag.toString()}`, 302);
}

/**
 * Return an HTML page that posts the result to the opener and closes. The payload
 * is JSON-embedded server-side (from a trusted token exchange), and targetOrigin is
 * pinned to ALLOWED_ORIGIN so no other page can receive the token.
 *
 * SECURITY: `payload` includes the request-supplied `state`, which is
 * attacker-controlled and reflected here. `JSON.stringify` does NOT escape `<`, `>`
 * or `/`, so a raw `</script>` in `state` would break out of this inline <script>
 * and (under `script-src 'unsafe-inline'`) execute injected markup — a reflected
 * XSS. We run every JSON literal embedded in the script through `safeJsonForScript`,
 * which escapes those characters as `\uXXXX` so the value stays inert data.
 */
function htmlMessage(env, payload) {
  const body = safeJsonForScript(JSON.stringify({ type: "azx-github-token", ...payload }));
  const origin = env.ALLOWED_ORIGIN;
  const html = `<!DOCTYPE html><html><body><script>
    (function () {
      var payload = ${body};
      var target = ${safeJsonForScript(JSON.stringify(origin))};
      if (window.opener) window.opener.postMessage(payload, target);
      document.body.textContent = payload.error ? ("Sign-in failed: " + payload.error) : "Signed in — you can close this window.";
      window.close();
    })();
  </script></body></html>`;
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // This page must not be framed and runs only its own inline bootstrap.
      "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; frame-ancestors 'none'",
    },
  });
}

/**
 * Escape a JSON string for safe inlining inside an HTML <script> element. JSON is
 * valid JS, but the HTML parser sees `</script>` (and `<!--`) regardless of JS
 * string context, so we escape the characters that could terminate the element or
 * be misparsed: `<`, `>`, `&`, and the U+2028/U+2029 line terminators (which are
 * literal newlines in JS and would break the expression).
 */
function safeJsonForScript(json) {
  return json
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
