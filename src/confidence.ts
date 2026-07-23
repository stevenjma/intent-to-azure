/**
 * The confidence model.
 *
 *   high   = 2+ independent signals agree (distinct signal kinds, at least one strong)
 *   medium = a single signal          → surface a confirm card
 *   low    = only a weak hint          → ask once
 *
 * "Independent" means the signals come from different {@link SignalKind}s — e.g.
 * a dependency AND a migration AND an env var all pointing at the same capability
 * are three independent witnesses, whereas three dependencies are one kind.
 */

import type { CapabilityName, Confidence, Signal } from "./types.js";

/** Derive a capability's confidence from the signals that point at it. */
export function deriveConfidence(signals: Signal[]): Confidence {
  const distinctKinds = new Set(signals.map((s) => s.kind));
  const hasStrong = signals.some((s) => !s.weak);

  if (distinctKinds.size >= 2 && hasStrong) return "high";
  if (distinctKinds.size >= 1 && hasStrong) return "medium";
  // Only weak signals remain.
  if (distinctKinds.size >= 2) return "medium";
  return "low";
}

/** Group signals by capability (dropping signals with no capability). */
export function groupByCapability(signals: Signal[]): Map<CapabilityName, Signal[]> {
  const groups = new Map<CapabilityName, Signal[]>();
  for (const s of signals) {
    if (!s.capability) continue;
    const list = groups.get(s.capability) ?? [];
    list.push(s);
    groups.set(s.capability, list);
  }
  return groups;
}

/** Map of capability → derived confidence, for rendering the signals table. */
export function deriveConfidences(signals: Signal[]): Map<CapabilityName, Confidence> {
  const out = new Map<CapabilityName, Confidence>();
  for (const [cap, list] of groupByCapability(signals)) {
    out.set(cap, deriveConfidence(list));
  }
  return out;
}
