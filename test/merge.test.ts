import { describe, it, expect } from "vitest";
import { mergeStep } from "../src/merge.ts";
import type { ProductHistory, PendingBrew } from "../src/types.ts";

const SPLASH_WINDOW_MS = 5 * 60 * 1000;

const ph = (over: Partial<ProductHistory>): ProductHistory => ({
  id: 1, machineTimestamp: "2026-05-20T10:00:00", type: "ESPRESSO", isDouble: 0,
  milk: { consumption: 0 }, ...over,
});

const pending = (over: Partial<PendingBrew>): PendingBrew => ({
  id: 1, machineTs: "2026-05-20T10:00:00",
  localDate: "2026-05-20", localMonth: "2026-05",
  drinkType: "ESPRESSO", isDouble: 0,
  beansG: 7, milkMl: 0, co2G: 8.68,
  splashIds: [], rawJson: "{}",
  expiresAt: "2026-05-20T10:05:00",
  ...over,
});

describe("mergeStep", () => {
  it("first brew with no pending → new pending, no commit", () => {
    const r = mergeStep(ph({ id: 1 }), null, SPLASH_WINDOW_MS);
    expect(r.commit).toBeNull();
    expect(r.newPending?.id).toBe(1);
    expect(r.mergedSplash).toBe(false);
  });

  it("non-splash arrives while pending exists → flush pending, new pending", () => {
    const r = mergeStep(
      ph({ id: 2, type: "ESPRESSO", machineTimestamp: "2026-05-20T10:01:00" }),
      pending({ id: 1 }),
      SPLASH_WINDOW_MS,
    );
    expect(r.commit?.id).toBe(1);
    expect(r.newPending?.id).toBe(2);
  });

  it("MILK splash within window → merge into pending", () => {
    const r = mergeStep(
      ph({ id: 2, type: "MILK", machineTimestamp: "2026-05-20T10:02:00", milk: { consumption: 30 } }),
      pending({ id: 1 }),
      SPLASH_WINDOW_MS,
    );
    expect(r.commit).toBeNull();
    expect(r.newPending?.id).toBe(1);
    expect(r.newPending?.milkMl).toBe(30);
    expect(r.newPending?.splashIds).toEqual([2]);
    expect(r.mergedSplash).toBe(true);
  });

  it("MILK_FOAM splash counts too", () => {
    const r = mergeStep(
      ph({ id: 2, type: "MILK_FOAM", machineTimestamp: "2026-05-20T10:02:00", milk: { consumption: 20 } }),
      pending({ id: 1, milkMl: 100, splashIds: [] }),
      SPLASH_WINDOW_MS,
    );
    expect(r.mergedSplash).toBe(true);
    expect(r.newPending?.milkMl).toBe(120);
  });

  it("HOT_WATER_WITH_MILK splash counts too", () => {
    const r = mergeStep(
      ph({ id: 2, type: "HOT_WATER_WITH_MILK", machineTimestamp: "2026-05-20T10:02:00", milk: { consumption: 15 } }),
      pending({ id: 1, milkMl: 0 }),
      SPLASH_WINDOW_MS,
    );
    expect(r.mergedSplash).toBe(true);
  });

  it("MILK arriving AFTER window expired → flush pending, new pending (own)", () => {
    const r = mergeStep(
      ph({ id: 2, type: "MILK", machineTimestamp: "2026-05-20T10:06:00", milk: { consumption: 30 } }),
      pending({ id: 1 }),
      SPLASH_WINDOW_MS,
    );
    expect(r.commit?.id).toBe(1);
    expect(r.newPending?.id).toBe(2);
    expect(r.newPending?.drinkType).toBe("MILK");
  });

  it("MILK with no pending → becomes its own pending brew", () => {
    const r = mergeStep(
      ph({ id: 1, type: "MILK", milk: { consumption: 30 } }),
      null,
      SPLASH_WINDOW_MS,
    );
    expect(r.commit).toBeNull();
    expect(r.newPending?.drinkType).toBe("MILK");
    expect(r.mergedSplash).toBe(false);
  });

  it("Second splash extends the window from its own timestamp", () => {
    const r = mergeStep(
      ph({ id: 3, type: "MILK", machineTimestamp: "2026-05-20T10:04:30", milk: { consumption: 15 } }),
      pending({ id: 1, milkMl: 30, splashIds: [2], expiresAt: "2026-05-20T10:05:00" }),
      SPLASH_WINDOW_MS,
    );
    expect(r.newPending?.milkMl).toBe(45);
    expect(r.newPending?.splashIds).toEqual([2, 3]);
    expect(r.newPending?.expiresAt).toBe("2026-05-20T10:09:30");
  });
});
