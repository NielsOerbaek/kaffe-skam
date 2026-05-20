import type { ProductHistory, PendingBrew, DrinkType } from "./types.ts";

const SPLASH_TYPES: ReadonlySet<DrinkType> = new Set([
  "MILK", "MILK_FOAM", "HOT_WATER_WITH_MILK",
]);

/** Format a Date as a local-time ISO string (no Z, no fractional seconds). */
function toLocalISOString(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

export interface MergeStepResult {
  commit: PendingBrew | null;
  newPending: PendingBrew | null;
  mergedSplash: boolean;
}

export interface MergeDeps {
  toPending: (ph: ProductHistory, splashWindowMs: number) => PendingBrew;
  // Optional: how to fold a splash into the existing pending brew. The caller
  // (poller) provides one that applies the milk-unit multiplier and re-computes
  // CO₂. Default is a naive add (used by tests).
  applySplash?: (pending: PendingBrew, splash: ProductHistory) => PendingBrew;
}

// Default raw add — used by tests; production injects an applySplash that
// applies the milk-unit multiplier and recomputes CO₂.
const defaultApplySplash = (pending: PendingBrew, splash: ProductHistory): PendingBrew => ({
  ...pending,
  milkMl: pending.milkMl + (splash.milk?.consumption ?? 0),
  splashIds: [...pending.splashIds, splash.id],
});

// Default builder used when callers don't inject `toPending`. The result has
// `machineId = 0` and zeroed beansG/co2G — the poller always overrides this
// with its own builder that knows the real machineId and the calibration k.
// Tests for mergeStep itself don't care about these fields.
const defaultToPending = (ph: ProductHistory, splashWindowMs: number): PendingBrew => {
  const machineTs = ph.machineTimestamp;
  return {
    id: ph.id,
    machineId: 0,
    productKey: typeof ph.keyId === "number" ? ph.keyId : null,
    machineTs,
    localDate: machineTs.slice(0, 10),
    localMonth: machineTs.slice(0, 7),
    drinkType: ph.type,
    isDouble: ph.isDouble,
    beansG: 0,
    milkMl: ph.milk?.consumption ?? 0,
    co2G: 0,
    splashIds: [],
    rawJson: JSON.stringify(ph),
    expiresAt: toLocalISOString(new Date(new Date(machineTs).getTime() + splashWindowMs)),
  };
};

export function mergeStep(
  incoming: ProductHistory,
  pending: PendingBrew | null,
  splashWindowMs: number,
  deps: MergeDeps = { toPending: defaultToPending },
): MergeStepResult {
  const isSplash = SPLASH_TYPES.has(incoming.type);
  const incomingMs = new Date(incoming.machineTimestamp).getTime();

  if (pending == null) {
    return { commit: null, newPending: deps.toPending(incoming, splashWindowMs), mergedSplash: false };
  }

  const expiresMs = new Date(pending.expiresAt).getTime();
  const withinWindow = incomingMs <= expiresMs;

  if (isSplash && withinWindow) {
    const newExpires = toLocalISOString(new Date(incomingMs + splashWindowMs));
    const applied = (deps.applySplash ?? defaultApplySplash)(pending, incoming);
    return {
      commit: null,
      newPending: { ...applied, expiresAt: newExpires },
      mergedSplash: true,
    };
  }

  return {
    commit: pending,
    newPending: deps.toPending(incoming, splashWindowMs),
    mergedSplash: false,
  };
}
