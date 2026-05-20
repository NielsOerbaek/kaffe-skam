import { describe, it, expect, beforeEach } from "vitest";
import { Store } from "../src/store.ts";
import type { Brew, PendingBrew } from "../src/types.ts";

const M2 = 28199; // 2. sal
const M3 = 19708; // 3. sal

const makeBrew = (over: Partial<Brew> = {}): Brew => ({
  id: 1, machineId: M2, productKey: null, machineTs: "2026-05-20T10:00:00",
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
    expect(s.getMeta("schema_version")).toBe("3");
  });

  it("inserts and reads back brews via getRecentBrews", () => {
    s.insertBrew(makeBrew({ id: 1, machineId: M2 }));
    s.insertBrew(makeBrew({ id: 2, machineId: M2, machineTs: "2026-05-20T10:01:00", co2G: 50, drinkType: "CAPPUCCINO" }));
    const recent = s.getRecentBrews(2);
    expect(recent[0]?.id).toBe(2);
    expect(recent[0]?.drinkType).toBe("CAPPUCCINO");
    expect(recent[1]?.id).toBe(1);
  });

  it("getTodayTotals counts cups + sums co2 for today only (across machines)", () => {
    s.insertBrew(makeBrew({ id: 1, machineId: M2, localDate: "2026-05-20", co2G: 10 }));
    s.insertBrew(makeBrew({ id: 2, machineId: M3, localDate: "2026-05-20", co2G: 20 }));
    s.insertBrew(makeBrew({ id: 3, machineId: M2, localDate: "2026-05-19", co2G: 99 }));
    const t = s.getTodayTotals("2026-05-20");
    expect(t).toEqual({ cups: 2, co2_g: 30 });
  });

  it("getMonthTotals counts cups + sums co2 for the month (across machines)", () => {
    s.insertBrew(makeBrew({ id: 1, machineId: M2, localMonth: "2026-05", co2G: 10 }));
    s.insertBrew(makeBrew({ id: 2, machineId: M3, localMonth: "2026-05", co2G: 20 }));
    s.insertBrew(makeBrew({ id: 3, machineId: M2, localMonth: "2026-04", co2G: 99 }));
    const m = s.getMonthTotals("2026-05");
    expect(m).toEqual({ cups: 2, co2_g: 30 });
  });

  it("pending brews from BOTH machines contribute to today totals", () => {
    s.insertBrew(makeBrew({ id: 1, machineId: M2, localDate: "2026-05-20", co2G: 10 }));
    s.setPending(makePending({ id: 99, machineId: M2, localDate: "2026-05-20", co2G: 50 }));
    s.setPending(makePending({ id: 88, machineId: M3, localDate: "2026-05-20", co2G: 30 }));
    const t = s.getTodayTotals("2026-05-20");
    expect(t.cups).toBe(3);
    expect(t.co2_g).toBe(90);
  });

  it("pending does not count when localDate differs", () => {
    s.insertBrew(makeBrew({ id: 1, machineId: M2, localDate: "2026-05-20", co2G: 10 }));
    s.setPending(makePending({ id: 99, machineId: M2, localDate: "2026-05-19" }));
    const t = s.getTodayTotals("2026-05-20");
    expect(t.cups).toBe(1);
  });

  it("each machine has its own pending row", () => {
    s.setPending(makePending({ id: 100, machineId: M2 }));
    s.setPending(makePending({ id: 200, machineId: M3 }));
    expect(s.getPending(M2)?.id).toBe(100);
    expect(s.getPending(M3)?.id).toBe(200);
    expect(s.getAllPending()).toHaveLength(2);
  });

  it("clearPending only clears the requested machine", () => {
    s.setPending(makePending({ id: 100, machineId: M2 }));
    s.setPending(makePending({ id: 200, machineId: M3 }));
    s.clearPending(M2);
    expect(s.getPending(M2)).toBeNull();
    expect(s.getPending(M3)?.id).toBe(200);
  });

  it("getRecentBrews merges committed + pending across machines, newest first", () => {
    s.insertBrew(makeBrew({ id: 1, machineId: M2, machineTs: "2026-05-20T10:00:00", co2G: 10 }));
    s.insertBrew(makeBrew({ id: 2, machineId: M3, machineTs: "2026-05-20T10:05:00", co2G: 20 }));
    s.setPending(makePending({ id: 3, machineId: M2, machineTs: "2026-05-20T10:10:00", co2G: 30 }));
    s.setPending(makePending({ id: 4, machineId: M3, machineTs: "2026-05-20T09:55:00", co2G: 40 }));

    const r = s.getRecentBrews(3);
    expect(r.map(b => b.id)).toEqual([3, 2, 1]);
  });

  it("getRecentBrews respects limit", () => {
    for (let i = 1; i <= 5; i++) {
      s.insertBrew(makeBrew({ id: i, machineId: M2, machineTs: `2026-05-20T10:0${i}:00` }));
    }
    expect(s.getRecentBrews(2)).toHaveLength(2);
    expect(s.getRecentBrews(10)).toHaveLength(5);
  });

  it("meta key/value round-trips", () => {
    s.setMeta("last_seen_id_28199", "42");
    expect(s.getMeta("last_seen_id_28199")).toBe("42");
    s.setMeta("last_seen_id_28199", "43");
    expect(s.getMeta("last_seen_id_28199")).toBe("43");
  });

  it("inserting same (machine_id, id) twice is a no-op (idempotent)", () => {
    s.insertBrew(makeBrew({ id: 1, machineId: M2, co2G: 10 }));
    s.insertBrew(makeBrew({ id: 1, machineId: M2, co2G: 999 }));
    const t = s.getTodayTotals("2026-05-20");
    expect(t.cups).toBe(1);
    expect(t.co2_g).toBe(10);
  });

  it("same id from DIFFERENT machines are separate rows", () => {
    s.insertBrew(makeBrew({ id: 1, machineId: M2, co2G: 10 }));
    s.insertBrew(makeBrew({ id: 1, machineId: M3, co2G: 20 }));
    const t = s.getTodayTotals("2026-05-20");
    expect(t.cups).toBe(2);
    expect(t.co2_g).toBe(30);
  });

  it("splashIds round-trip as JSON array", () => {
    s.insertBrew(makeBrew({ id: 1, machineId: M2, splashIds: [2, 3] }));
    const recent = s.getRecentBrews(1);
    expect(recent[0]?.splashIds).toEqual([2, 3]);
  });
});
