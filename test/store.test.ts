import { describe, it, expect, beforeEach } from "vitest";
import { Store } from "../src/store.ts";
import type { Brew, PendingBrew } from "../src/types.ts";

const makeBrew = (over: Partial<Brew> = {}): Brew => ({
  id: 1, machineTs: "2026-05-20T10:00:00",
  localDate: "2026-05-20", localMonth: "2026-05",
  drinkType: "ESPRESSO", isDouble: 0,
  beansG: 7, milkMl: 0, co2G: 8.68,
  splashIds: [], rawJson: "{}",
  ...over,
});

const makePending = (over: Partial<PendingBrew> = {}): PendingBrew => ({
  ...makeBrew(over), expiresAt: "2026-05-20T10:05:00",
  ...over,
});

describe("Store", () => {
  let s: Store;
  beforeEach(() => { s = new Store(":memory:"); });

  it("creates schema on construction", () => {
    expect(s.getMeta("schema_version")).toBe("1");
  });

  it("inserts and reads back a brew", () => {
    s.insertBrew(makeBrew({ id: 1 }));
    s.insertBrew(makeBrew({ id: 2, co2G: 50, drinkType: "CAPPUCCINO" }));
    const last = s.getLastBrew();
    expect(last?.id).toBe(2);
    expect(last?.drinkType).toBe("CAPPUCCINO");
  });

  it("getTodayTotals counts cups + sums co2 for today only", () => {
    s.insertBrew(makeBrew({ id: 1, localDate: "2026-05-20", co2G: 10 }));
    s.insertBrew(makeBrew({ id: 2, localDate: "2026-05-20", co2G: 20 }));
    s.insertBrew(makeBrew({ id: 3, localDate: "2026-05-19", co2G: 99 }));
    const t = s.getTodayTotals("2026-05-20");
    expect(t).toEqual({ cups: 2, co2_g: 30 });
  });

  it("getMonthTotals counts cups + sums co2 for the month", () => {
    s.insertBrew(makeBrew({ id: 1, localMonth: "2026-05", co2G: 10 }));
    s.insertBrew(makeBrew({ id: 2, localMonth: "2026-05", co2G: 20 }));
    s.insertBrew(makeBrew({ id: 3, localMonth: "2026-04", co2G: 99 }));
    const m = s.getMonthTotals("2026-05");
    expect(m).toEqual({ cups: 2, co2_g: 30 });
  });

  it("pending brew counts toward today totals when localDate matches", () => {
    s.insertBrew(makeBrew({ id: 1, localDate: "2026-05-20", co2G: 10 }));
    s.setPending(makePending({ id: 99, localDate: "2026-05-20", co2G: 50 }));
    const t = s.getTodayTotals("2026-05-20");
    expect(t.cups).toBe(2);
    expect(t.co2_g).toBe(60);
  });

  it("pending does not count when localDate differs", () => {
    s.insertBrew(makeBrew({ id: 1, localDate: "2026-05-20", co2G: 10 }));
    s.setPending(makePending({ id: 99, localDate: "2026-05-19" }));
    const t = s.getTodayTotals("2026-05-20");
    expect(t.cups).toBe(1);
  });

  it("getLastBrew returns pending if newer than committed", () => {
    s.insertBrew(makeBrew({ id: 1, machineTs: "2026-05-20T10:00:00" }));
    s.setPending(makePending({ id: 99, machineTs: "2026-05-20T10:01:00" }));
    expect(s.getLastBrew()?.id).toBe(99);
  });

  it("getLastBrew returns committed when no pending", () => {
    s.insertBrew(makeBrew({ id: 1 }));
    expect(s.getLastBrew()?.id).toBe(1);
  });

  it("clearPending removes the pending brew", () => {
    s.setPending(makePending({ id: 99 }));
    s.clearPending();
    expect(s.getPending()).toBeNull();
  });

  it("meta key/value round-trips", () => {
    s.setMeta("last_seen_id", "42");
    expect(s.getMeta("last_seen_id")).toBe("42");
    s.setMeta("last_seen_id", "43");
    expect(s.getMeta("last_seen_id")).toBe("43");
  });

  it("inserting same id twice is a no-op (idempotent)", () => {
    s.insertBrew(makeBrew({ id: 1, co2G: 10 }));
    s.insertBrew(makeBrew({ id: 1, co2G: 999 }));
    const t = s.getTodayTotals("2026-05-20");
    expect(t.cups).toBe(1);
    expect(t.co2_g).toBe(10);
  });

  it("splashIds round-trip as JSON array", () => {
    s.insertBrew(makeBrew({ id: 1, splashIds: [2, 3] }));
    expect(s.getLastBrew()?.splashIds).toEqual([2, 3]);
  });
});
