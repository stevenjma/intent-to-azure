const SUCCESS = new Set(["succeeded", "success", "completed"]);
const FAILURE = new Set(["failed", "canceled", "cancelled"]);
const PENDING = new Set([
  "accepted", "inprogress", "running", "creating", "updating", "deleting", "queued",
]);

function retryDelayMs(value, now) {
  let seconds = value == null || String(value).trim() === "" ? Number.NaN : Number(value);
  if (!Number.isFinite(seconds)) {
    const dateMs = Date.parse(value || "");
    seconds = Number.isFinite(dateMs) ? (dateMs - now()) / 1000 : 5;
  }
  return Math.max(1_000, Math.min(15_000, Math.ceil(seconds * 1000)));
}

/** Browser-independent ARM long-running-operation state machine. */
export async function pollArmOperation(
  initial,
  poll,
  {
    onLog,
    pollUrl,
    timeoutMs = 10 * 60 * 1000,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    now = Date.now,
  } = {},
) {
  let current = initial;
  let asyncUrl =
    current.headers.get("azure-asyncoperation") || current.headers.get("location") || pollUrl;
  const boundedTimeout = Math.max(1_000, Math.min(timeoutMs, 10 * 60 * 1000));
  const deadline = now() + boundedTimeout;

  for (let attempt = 0; attempt < 240 && now() < deadline; attempt++) {
    if (!current.ok) {
      const detail = await current.text().catch(() => "");
      throw new Error(`ARM async op failed → ${current.status}: ${detail}`);
    }
    if (current.status === 204) return null;
    const data = await current.json().catch(() => null);
    const state = String(data?.status || data?.properties?.provisioningState || "").toLowerCase();
    if (SUCCESS.has(state)) return data;
    if (FAILURE.has(state)) {
      const detail = data?.error?.message || data?.properties?.error?.message || JSON.stringify(data);
      throw new Error(`ARM async operation ${state}: ${detail}`);
    }
    const pending = current.status === 202 || current.status === 201 || PENDING.has(state);
    if (!pending) {
      throw new Error(
        `ARM async operation returned HTTP ${current.status} without a terminal success state` +
          (state ? ` (status: ${state})` : "."),
      );
    }
    asyncUrl =
      current.headers.get("azure-asyncoperation") || current.headers.get("location") || asyncUrl;
    if (!asyncUrl) throw new Error("ARM async operation did not provide a polling URL.");
    const waitMs = retryDelayMs(current.headers.get("retry-after"), now);
    onLog?.(`  … ${state || "in progress"} (waiting ${Math.ceil(waitMs / 1000)}s)`);
    await sleep(Math.min(waitMs, Math.max(0, deadline - now())));
    if (now() >= deadline) break;
    current = await poll(asyncUrl);
  }
  throw new Error(`ARM async operation timed out after ${Math.ceil(boundedTimeout / 1000)} seconds.`);
}
