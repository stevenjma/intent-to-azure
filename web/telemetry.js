const SDK_URL = "https://js.monitor.azure.com/scripts/b/ai.3.4.4.gbl.min.js";
const SDK_INTEGRITY = "sha384-StHgVQoR6nIJMQwVfWcIZjDF0yvNpPgoTVaSD2+oVWXwuXnHkuUvOkpd8dSTLJmB";
const DISABLED_KEY = "azx.telemetry.disabled";
const USER_KEY = "azx.telemetry.user";
const SESSION_KEY = "azx.telemetry.session";

const EVENTS = new Set([
  "page_loaded",
  "github_auth_succeeded",
  "github_auth_restored",
  "github_auth_failed",
  "analysis_started",
  "analysis_succeeded",
  "analysis_failed",
  "assumptions_confirmed",
  "codify_viewed",
  "pr_create_started",
  "pr_created",
  "pr_create_failed",
]);
const PROPERTY_KEYS = new Set(["stage", "framework", "hosting", "errorCode"]);
const MEASUREMENT_KEYS = new Set([
  "durationMs",
  "fileCount",
  "resourceCount",
  "confirmationCount",
]);

let configured = false;
let enabled = false;
let client = null;
let releaseSha = "unknown";
let loadPromise = null;
const pending = [];
const memoryIdentifiers = new Map();

export async function initializeTelemetry(config = {}) {
  configured = validConnectionString(config.applicationInsightsConnectionString);
  releaseSha = /^[0-9a-f]{40}$/i.test(config.releaseSha || "") ? config.releaseSha.toLowerCase() : "unknown";
  enabled = configured && !privacyDisabled();
  if (!enabled) return telemetryState();

  loadPromise ??= loadSdk().then(() => {
    const ApplicationInsights = window.Microsoft?.ApplicationInsights?.ApplicationInsights;
    if (!ApplicationInsights) throw new Error("Application Insights SDK did not initialize.");
    client = new ApplicationInsights({
      config: {
        connectionString: config.applicationInsightsConnectionString,
        disableCookiesUsage: true,
        disableAjaxTracking: true,
        disableFetchTracking: true,
        disableExceptionTracking: true,
        enableAutoRouteTracking: false,
        autoTrackPageVisitTime: false,
        enableCorsCorrelation: false,
      },
    });
    client.loadAppInsights();
    for (const event of pending.splice(0)) send(event);
  }).catch((error) => {
    enabled = false;
    pending.length = 0;
    console.warn("Anonymous telemetry unavailable:", error.message);
  });
  await loadPromise;
  return telemetryState();
}

export function trackEvent(name, properties = {}, measurements = {}) {
  if (!enabled || !EVENTS.has(name)) return;
  const event = {
    name,
    properties: {
      ...allowedValues(properties, PROPERTY_KEYS),
      anonymousUserId: identifier(USER_KEY),
      sessionId: identifier(SESSION_KEY, sessionStorage),
      releaseSha,
      schemaVersion: "1",
    },
    measurements: allowedMeasurements(measurements),
  };
  if (client) send(event);
  else pending.push(event);
}

export function telemetryState() {
  return {
    configured,
    enabled,
    doNotTrack: navigator.doNotTrack === "1" || window.doNotTrack === "1",
  };
}

export function setTelemetryEnabled(next) {
  try {
    if (next) localStorage.removeItem(DISABLED_KEY);
    else {
      localStorage.setItem(DISABLED_KEY, "true");
      localStorage.removeItem(USER_KEY);
      sessionStorage.removeItem(SESSION_KEY);
    }
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}

function privacyDisabled() {
  if (navigator.doNotTrack === "1" || window.doNotTrack === "1") return true;
  try {
    return localStorage.getItem(DISABLED_KEY) === "true";
  } catch {
    return true;
  }
}

function identifier(key, storage = localStorage) {
  try {
    let value = storage.getItem(key);
    if (!/^[0-9a-f-]{36}$/i.test(value || "")) {
      value = memoryIdentifiers.get(key) || crypto.randomUUID();
      memoryIdentifiers.set(key, value);
      storage.setItem(key, value);
    }
    return value;
  } catch {
    if (!memoryIdentifiers.has(key)) memoryIdentifiers.set(key, crypto.randomUUID());
    return memoryIdentifiers.get(key);
  }
}

function validConnectionString(value) {
  return typeof value === "string"
    && /(?:^|;)InstrumentationKey=[0-9a-f-]{36}(?:;|$)/i.test(value)
    && /(?:^|;)IngestionEndpoint=https:\/\/[^;]+(?:;|$)/i.test(value);
}

function allowedValues(values, allowed) {
  return Object.fromEntries(
    Object.entries(values)
      .filter(([key, value]) => allowed.has(key) && typeof value === "string")
      .map(([key, value]) => [key, value.replace(/[^a-z0-9_.-]/gi, "_").slice(0, 64)]),
  );
}

function allowedMeasurements(values) {
  return Object.fromEntries(
    Object.entries(values)
      .filter(([key, value]) => MEASUREMENT_KEYS.has(key) && Number.isFinite(value))
      .map(([key, value]) => [key, Math.max(0, Math.round(value))]),
  );
}

function loadSdk() {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SDK_URL;
    script.integrity = SDK_INTEGRITY;
    script.crossOrigin = "anonymous";
    script.referrerPolicy = "no-referrer";
    script.onload = resolve;
    script.onerror = () => reject(new Error("Microsoft SDK download failed integrity or availability checks."));
    document.head.appendChild(script);
  });
}

function send(event) {
  client.trackEvent({
    name: event.name,
    properties: event.properties,
    measurements: event.measurements,
  });
}
