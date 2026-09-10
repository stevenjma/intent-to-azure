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
 *   SPA       → GET /login?state=&scope=   → 302 to github.com/login/oauth/authorize
 *   GitHub    → GET /callback?code=&state= → exchange code→token, then redirect
 *               to the exact APP_URL with the token in the URL fragment.
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

    if (url.pathname === "/health") {
      if (request.method !== "GET") {
        return new Response(null, {
          status: 405,
          headers: { Allow: "GET", "Cache-Control": "no-store" },
        });
      }
      return Response.json(
        { status: "ok" },
        {
          headers: {
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          },
        },
      );
    }

    if (url.pathname === "/login") {
      const state = url.searchParams.get("state") || "";
      if (!isAllowedRedirectState(state, env)) {
        return new Response("invalid OAuth state", { status: 400 });
      }
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
      if (!isAllowedRedirectState(state, env)) {
        return new Response("invalid OAuth state", { status: 400 });
      }
      if (!code) return redirectBack(env, { error: "missing_code", state });

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
        return redirectBack(env, { error: data.error || "exchange_failed", state });
      }
      return redirectBack(env, { token: data.access_token, state });
    }

    return new Response("azx github oauth worker", { status: 200 });
  },
};

/**
 * The SPA encodes the flow in the OAuth `state` (the only value GitHub round-trips):
 *   `<csrf>.r.<base64url(returnUrl)>` → redirect flow (302 back with token in fragment)
 * csrf is a UUID (no dots) and the base64url segment has no dots, so a plain split
 * is unambiguous.
 */
function isAllowedRedirectState(state, env) {
  const parts = state.split(".");
  if (parts.length !== 3 || parts[1] !== "r" || !/^[0-9a-f-]{36}$/i.test(parts[0])) return false;
  const app = validatedAppUrl(env);
  return isAllowedReturnUrl(decodeReturnUrl(state), app);
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

/**
 * Redirect-flow return: 302 back to the SPA with the token/error in the URL
 * FRAGMENT (never sent to a server, not in the Referer header). The SPA reads it
 * on load and immediately strips it from history. The destination is the SPA's
 * own return URL. Both its parsed origin and path must exactly match APP_URL
 * (or ALLOWED_ORIGIN when APP_URL is unset).
 */
function redirectBack(env, payload) {
  const fallback = validatedAppUrl(env);
  const candidate = decodeReturnUrl(payload.state);
  const dest = isAllowedReturnUrl(candidate, fallback) ? new URL(candidate).href : fallback.href;
  const frag = new URLSearchParams();
  if (payload.token) frag.set("azx_gh_token", payload.token);
  if (payload.error) frag.set("azx_gh_error", payload.error);
  if (payload.state) frag.set("state", payload.state);
  const target = new URL(dest);
  target.hash = frag.toString();
  return Response.redirect(target.href, 302);
}

function validatedAppUrl(env) {
  const allowedOrigin = new URL(env.ALLOWED_ORIGIN);
  if (allowedOrigin.origin !== env.ALLOWED_ORIGIN || allowedOrigin.pathname !== "/") {
    throw new Error("ALLOWED_ORIGIN must be an exact origin with no path.");
  }
  const app = new URL(env.APP_URL || env.ALLOWED_ORIGIN);
  if (app.origin !== allowedOrigin.origin) {
    throw new Error("APP_URL must use ALLOWED_ORIGIN.");
  }
  app.hash = "";
  app.search = "";
  return app;
}

/** Return URLs may vary only by query; origin and application path are pinned. */
export function isAllowedReturnUrl(candidate, configuredAppUrl) {
  if (!candidate) return false;
  try {
    const parsed = new URL(candidate);
    return (
      parsed.origin === configuredAppUrl.origin &&
      parsed.pathname === configuredAppUrl.pathname &&
      !parsed.username &&
      !parsed.password
    );
  } catch {
    return false;
  }
}
