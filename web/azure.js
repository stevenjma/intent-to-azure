/**
 * azure.js — Azure sign-in (MSAL PKCE) + real ARM REST deploy for the SPA.
 *
 * Entra is SPA-native and ARM sends CORS headers, so everything here is 100%
 * client-side: no backend, no secret. Sign-in is two steps: an identity-only
 * loginPopup (so personal accounts aren't blocked by ARM resource discovery),
 * then an ARM token acquisition (https://management.azure.com/user_impersonation)
 * that drives resource-group ensure → what-if (always, as a gate) → deployment
 * create over fetch. The token lives in MSAL's in-memory cache only.
 *
 * MSAL is loaded from a CDN as an ES module (see the CSP in index.html).
 */

import { PublicClientApplication } from "https://esm.sh/@azure/msal-browser@3.28.1";

const ARM = "https://management.azure.com";
const ARM_SCOPE = "https://management.azure.com/user_impersonation";
const RG_API = "2021-04-01";
const DEPLOY_API = "2021-04-01";

/**
 * Well-known tenant id of the Microsoft consumer (personal-account) directory.
 * Any account whose home tenant is this GUID is a pure personal Microsoft
 * account with no Azure AD directory — Azure Resource Manager does not exist for
 * it, so it can never mint an ARM token no matter what we request.
 */
const MSA_CONSUMER_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad";

/** Identity-only scopes: pure OIDC, no Azure resource, so Entra never runs
 * resource-based home-realm-discovery and never blocks a personal account
 * inside the popup. We resolve ARM access as a separate, catchable step. */
const LOGIN_SCOPES = ["openid", "profile"];

/** Where to send an account that has no Azure subscription yet. */
export const AZURE_SIGNUP_URL = "https://azure.microsoft.com/free/";

let msal = null;
let account = null;

/** Lazily construct the MSAL app from runtime config. */
async function ensureMsal(config) {
  if (msal) return msal;
  if (!config.azureClientId) throw new Error("Azure not configured (azureClientId).");
  msal = new PublicClientApplication({
    auth: {
      clientId: config.azureClientId,
      authority: `https://login.microsoftonline.com/${config.azureTenant || "common"}`,
      redirectUri: window.location.origin + window.location.pathname,
    },
    cache: { cacheLocation: "memoryStorage" }, // never persist tokens
  });
  await msal.initialize();
  return msal;
}

export function azureAccount() {
  return account;
}
export function azureSignedIn() {
  return account != null;
}

/**
 * Build the Entra admin-consent deep link for this app. When a tenant gates the
 * (unverified) app behind admin approval, an admin opens this once and grants
 * consent for the whole tenant. We target /organizations (admin consent is an
 * org-only concept; personal accounts can't grant it) and let the admin's home
 * tenant resolve on sign-in. All inputs here are our own PUBLIC client id and
 * origin — no secret, no user-controlled data.
 */
export function adminConsentUrl(config) {
  const redirectUri = window.location.origin + window.location.pathname;
  const params = new URLSearchParams({
    client_id: config.azureClientId,
    redirect_uri: redirectUri,
  });
  return `https://login.microsoftonline.com/organizations/adminconsent?${params.toString()}`;
}

/**
 * Heuristic: does this MSAL sign-in error mean the tenant requires an admin to
 * consent before the app can be used? Keyed on the specific AADSTS admin-consent
 * codes and the "admin approval/consent" wording so plain user cancellations
 * (e.g. AADSTS65004 "user declined") don't trigger the admin-consent UX.
 */
function isAdminConsentError(err) {
  const text = `${err?.errorCode || ""} ${err?.errorMessage || ""} ${err?.message || ""}`;
  if (/AADSTS90094|AADSTS65001|AADSTS90095/.test(text)) return true;
  return /admin[^.]*\b(consent|approval)/i.test(text);
}

/**
 * Heuristic: does this sign-in error mean the account simply has no Azure to
 * manage — i.e. Azure Resource Manager isn't available for it? This is the
 * personal-Microsoft-account case: the consumer tenant has no ARM resource, so
 * requesting the ARM scope returns invalid_scope ("...management.azure.com...
 * does not exist"). Also covers the "resource principal not found in tenant"
 * and "user account doesn't exist in tenant" variants. These accounts can't
 * deploy until they sign up for Azure (which provisions a directory for them).
 */
function isNoAzureAccessError(err) {
  const text = `${err?.errorCode || ""} ${err?.errorMessage || ""} ${err?.message || ""}`;
  if (/invalid_scope/i.test(text) && /management\.azure\.com/i.test(text)) return true;
  return /AADSTS500011|AADSTS650052|AADSTS50020/.test(text);
}

/**
 * Is this signed-in account a pure personal Microsoft account (living in the
 * well-known consumer tenant)? Such accounts have no Azure AD directory, so ARM
 * is unreachable for them. We detect this from the id-token claims BEFORE
 * requesting any ARM scope — requesting ARM for a personal account triggers
 * Entra's "you can't sign in here with a personal account" wall inside the
 * popup, which our code can't catch. Detecting up front lets us show friendly
 * signup guidance instead.
 */
function isConsumerAccount(acct) {
  const tid = `${acct?.tenantId || acct?.idTokenClaims?.tid || ""}`.toLowerCase();
  return tid === MSA_CONSUMER_TENANT;
}

/**
 * Interactive sign-in; resolves the signed-in account and proves ARM is
 * reachable. Two steps on purpose:
 *   1. loginPopup with identity-only scopes — no Azure resource, so a personal
 *      account authenticates cleanly instead of hitting the Microsoft wall.
 *   2. If the account is a personal (consumer) account, surface friendly Azure
 *      signup guidance without ever requesting ARM. Otherwise acquire an ARM
 *      token now so real deploy calls have one and any no-Azure / admin-consent
 *      problem surfaces here with our catchable handling.
 */
export async function azureSignIn(config) {
  const app = await ensureMsal(config);
  let res;
  try {
    res = await app.loginPopup({ scopes: LOGIN_SCOPES });
  } catch (err) {
    if (isAdminConsentError(err)) err.adminConsent = { url: adminConsentUrl(config) };
    else if (isNoAzureAccessError(err)) err.needsAzureSignup = { signupUrl: AZURE_SIGNUP_URL };
    throw err;
  }
  account = res.account;
  app.setActiveAccount(account);

  if (isConsumerAccount(account)) {
    account = null;
    const err = new Error(
      "This personal Microsoft account has no Azure subscription to deploy to.",
    );
    err.needsAzureSignup = { signupUrl: AZURE_SIGNUP_URL };
    throw err;
  }

  try {
    await armToken();
  } catch (err) {
    account = null;
    if (isNoAzureAccessError(err)) err.needsAzureSignup = { signupUrl: AZURE_SIGNUP_URL };
    else if (isAdminConsentError(err)) err.adminConsent = { url: adminConsentUrl(config) };
    throw err;
  }
  return account;
}

export function azureSignOut() {
  account = null;
}

/** Acquire an ARM access token, silently when possible. */
async function armToken() {
  if (!msal || !account) throw new Error("Sign in with Azure first.");
  try {
    const r = await msal.acquireTokenSilent({ scopes: [ARM_SCOPE], account });
    return r.accessToken;
  } catch {
    const r = await msal.acquireTokenPopup({ scopes: [ARM_SCOPE] });
    return r.accessToken;
  }
}

async function arm(path, { method = "GET", body, apiVersion } = {}) {
  const token = await armToken();
  const url = new URL(path.startsWith("http") ? path : ARM + path);
  if (apiVersion && !url.searchParams.has("api-version")) {
    url.searchParams.set("api-version", apiVersion);
  }
  const res = await fetch(url.toString(), {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res;
}

async function armJson(path, opts) {
  const res = await arm(path, opts);
  if (!res.ok) {
    let detail = "";
    try {
      detail = JSON.stringify(await res.json());
    } catch {
      detail = await res.text().catch(() => "");
    }
    throw new Error(`ARM ${opts?.method || "GET"} ${path} → ${res.status}: ${detail}`);
  }
  return res.status === 204 ? null : res.json();
}

/** List subscriptions the signed-in user can see. */
export async function listSubscriptions() {
  const data = await armJson("/subscriptions", { apiVersion: "2020-01-01" });
  return (data.value || []).map((s) => ({
    subscriptionId: s.subscriptionId,
    displayName: s.displayName,
    state: s.state,
  }));
}

/** Ensure a resource group exists (idempotent PUT). */
export async function ensureResourceGroup(subscriptionId, resourceGroup, region) {
  return armJson(
    `/subscriptions/${subscriptionId}/resourcegroups/${encodeURIComponent(resourceGroup)}`,
    { method: "PUT", apiVersion: RG_API, body: { location: region } },
  );
}

/** Poll an async ARM operation (202 + Location / Azure-AsyncOperation) to completion. */
async function pollAsync(res, { onLog } = {}) {
  let current = res;
  for (let i = 0; i < 120; i++) {
    const asyncUrl =
      current.headers.get("azure-asyncoperation") || current.headers.get("location");
    if (current.status !== 202 && current.status !== 201) {
      return current.status === 204 ? null : current.json();
    }
    if (!asyncUrl) return current.status === 204 ? null : current.json().catch(() => null);
    const retryAfter = Number(current.headers.get("retry-after") || "5");
    onLog?.(`  … in progress (waiting ${retryAfter}s)`);
    await sleep(retryAfter * 1000);
    current = await arm(asyncUrl);
    if (!current.ok && current.status >= 400) {
      const detail = await current.text().catch(() => "");
      throw new Error(`ARM async op failed → ${current.status}: ${detail}`);
    }
  }
  throw new Error("ARM async operation timed out.");
}

/**
 * Run an ARM what-if for a template against a resource group. Returns the parsed
 * what-if result (resource-level change predictions). Never mutates Azure.
 */
export async function whatIf(subscriptionId, resourceGroup, deploymentName, template, parameters, opts = {}) {
  const path =
    `/subscriptions/${subscriptionId}/resourcegroups/${encodeURIComponent(resourceGroup)}` +
    `/providers/Microsoft.Resources/deployments/${encodeURIComponent(deploymentName)}/whatIf`;
  const body = {
    properties: { mode: "Incremental", template, parameters: toArmParams(parameters) },
  };
  const res = await arm(path, { method: "POST", apiVersion: DEPLOY_API, body });
  if (!res.ok && res.status !== 202) {
    const detail = await res.text().catch(() => "");
    throw new Error(`ARM what-if → ${res.status}: ${detail}`);
  }
  return pollAsync(res, opts);
}

/**
 * Create a deployment (real resources). Poll to a terminal provisioning state.
 * Callers MUST run + surface what-if first — this is the mutating step.
 */
export async function deploy(subscriptionId, resourceGroup, deploymentName, template, parameters, opts = {}) {
  const path =
    `/subscriptions/${subscriptionId}/resourcegroups/${encodeURIComponent(resourceGroup)}` +
    `/providers/Microsoft.Resources/deployments/${encodeURIComponent(deploymentName)}`;
  const body = {
    properties: { mode: "Incremental", template, parameters: toArmParams(parameters) },
  };
  const res = await arm(path, { method: "PUT", apiVersion: DEPLOY_API, body });
  if (!res.ok && res.status !== 201 && res.status !== 202) {
    const detail = await res.text().catch(() => "");
    throw new Error(`ARM deploy → ${res.status}: ${detail}`);
  }
  await pollAsync(res, opts);
  // Fetch the final deployment record for outputs / provisioning state.
  const final = await armJson(path, { apiVersion: DEPLOY_API });
  return final;
}

/** Shape a flat { name: value } map into ARM's { name: { value } } parameter form. */
function toArmParams(parameters) {
  const out = {};
  for (const [k, v] of Object.entries(parameters || {})) out[k] = { value: v };
  return out;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
