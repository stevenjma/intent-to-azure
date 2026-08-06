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
 *   GitHub    → GET /callback?code=&state= → exchange code→token, return an HTML page
 *               that postMessages { type:"azx-github-token", token, state } to the
 *               opener (SPA) at ALLOWED_ORIGIN, then closes the popup.
 *
 * Required env (wrangler secrets / vars):
 *   GITHUB_CLIENT_ID      – OAuth App client id (public)
 *   GITHUB_CLIENT_SECRET  – OAuth App client secret (SECRET)
 *   ALLOWED_ORIGIN        – exact Pages origin, e.g. https://you.github.io
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/login") {
      const state = url.searchParams.get("state") || "";
      const scope = url.searchParams.get("scope") || "repo read:user";
      const redirectUri = `${url.origin}/callback`;
      const gh = new URL("https://github.com/login/oauth/authorize");
      gh.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
      gh.searchParams.set("redirect_uri", redirectUri);
      gh.searchParams.set("scope", scope);
      gh.searchParams.set("state", state);
      gh.searchParams.set("allow_signup", "false");
      return Response.redirect(gh.toString(), 302);
    }

    if (url.pathname === "/callback") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state") || "";
      if (!code) return htmlMessage(env, { error: "missing_code", state });

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
        return htmlMessage(env, { error: data.error || "exchange_failed", state });
      }
      return htmlMessage(env, { token: data.access_token, state });
    }

    return new Response("azx github oauth worker", { status: 200 });
  },
};

/**
 * Return an HTML page that posts the result to the opener and closes. The payload
 * is JSON-embedded server-side (from a trusted token exchange), and targetOrigin is
 * pinned to ALLOWED_ORIGIN so no other page can receive the token.
 */
function htmlMessage(env, payload) {
  const body = JSON.stringify({ type: "azx-github-token", ...payload });
  const origin = env.ALLOWED_ORIGIN;
  const html = `<!DOCTYPE html><html><body><script>
    (function () {
      var payload = ${body};
      var target = ${JSON.stringify(origin)};
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
