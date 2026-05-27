import { describe, it, expect, beforeEach } from "vitest";
import { Store } from "../src/store.ts";
import { Poller } from "../src/poller.ts";
import type { Config } from "../src/config.ts";
import type { EversysClient } from "../src/api.ts";
import type { ProductHistory } from "../src/types.ts";

const M2 = 28199;
const M3 = 19708;

// A fake EversysClient. Brews + counters per machine id.
class FakeApi {
  brewQueue: ProductHistory[][] = [];
  countersResp: any = { beans: { totalQuantity: 0 }, water: { totalQuantity: 0 }, lastReset: "2026-01-01T00:00:00" };
  async fetchBrewsAfter(_after: number | null, _limit: number) {
    return this.brewQueue.shift() ?? [];
  }
  async fetchCounters() { return this.countersResp; }
}

const baseConfig: Config = {
  co2: { beansFactorGPerG: 1.24, milkFactorGPerMl: 1.4, coffeeBaselineG: 8.68 },
  beansDefaultsG: { ESPRESSO: 7, CAPPUCCINO: 7, _default: 7 },
  beansByProduct: {},
  milkByProduct: {},
  milkUnitMl: 1, // test uses raw consumption as ml
  zeroMilkProducts: [],
  productNameOverrides: {},
  calibration: { minBrewsBetweenCalibrations: 2, maxScaleDelta: 0.5 },
  polling: { brewsIntervalMs: 5000, countersIntervalMs: 60000, splashWindowMs: 300000, backoffMs: [5000] },
  server: { port: 8080, stateRefreshMs: 3000 },
  api: { baseUrl: "" },
  machines: [
    { id: M2, floor: "2. sal" },
    { id: M3, floor: "3. sal" },
  ],
  clientId: "tok",
  clientSecret: "tok",
  authUrl: "https://auth.x/token",
  locationName: "Test Office",
};

function singleMachinePoller(s: Store, api: FakeApi, machineId = M2) {
  return new Poller({
    machines: [{ client: api as unknown as EversysClient, machineId, floor: "2. sal" }],
    store: s,
    config: baseConfig,
  });
}

function dualMachinePoller(s: Store, apiA: FakeApi, apiB: FakeApi) {
  return new Poller({
    machines: [
      { client: apiA as unknown as EversysClient, machineId: M2, floor: "2. sal" },
      { client: apiB as unknown as EversysClient, machineId: M3, floor: "3. sal" },
    ],
    store: s,
    config: baseConfig,
  });
}

describe("Poller", () => {
  let s: Store;
  beforeEach(() => { s = new Store(":memory:"); });

  it("bootstrap stores per-machine last_seen_id from latest brew", async () => {
    const api = new FakeApi();
    api.brewQueue.push([{ id: 999, machineTimestamp: "2026-05-20T10:00:00", type: "ESPRESSO", isDouble: 0 }]);
    const p = singleMachinePoller(s, api);
    await p.bootstrap();
    expect(s.getMeta(`last_seen_id_${M2}`)).toBe("999");
    expect(s.getMeta(`beans_calibration_k_${M2}`)).toBe("1.0");
  });

  it("bootstrap initialises every configured machine independently", async () => {
    const apiA = new FakeApi();
    const apiB = new FakeApi();
    apiA.brewQueue.push([{ id: 100, machineTimestamp: "2026-05-20T10:00:00", type: "ESPRESSO", isDouble: 0 }]);
    apiB.brewQueue.push([{ id: 200, machineTimestamp: "2026-05-20T10:00:00", type: "ESPRESSO", isDouble: 0 }]);
    const p = dualMachinePoller(s, apiA, apiB);
    await p.bootstrap();
    expect(s.getMeta(`last_seen_id_${M2}`)).toBe("100");
    expect(s.getMeta(`last_seen_id_${M3}`)).toBe("200");
  });

  it("processes a single espresso brew → pending, no commit yet", async () => {
    const api = new FakeApi();
    api.brewQueue.push([]);
    const p = singleMachinePoller(s, api);
    await p.bootstrap();
    api.brewQueue.push([{ id: 1, machineTimestamp: "2026-05-20T10:00:00", type: "ESPRESSO", isDouble: 0 }]);
    await p.tickBrews();
    expect(s.getPending(M2)?.id).toBe(1);
    expect(s.getRecentBrews(1)[0]?.id).toBe(1);
  });

  it("milk splash on machine A does NOT merge into pending on machine B", async () => {
    const apiA = new FakeApi();
    const apiB = new FakeApi();
    apiA.brewQueue.push([]); apiB.brewQueue.push([]);
    const p = dualMachinePoller(s, apiA, apiB);
    await p.bootstrap();

    // A: espresso → pending
    apiA.brewQueue.push([{ id: 1, machineTimestamp: "2026-05-20T10:00:00", type: "ESPRESSO", isDouble: 0 }]);
    // B: milk-only brew right after → must NOT merge into A's pending
    apiB.brewQueue.push([{ id: 1, machineTimestamp: "2026-05-20T10:01:00", type: "MILK", isDouble: 0, milk: { consumption: 30 } }]);
    await p.tickBrews();

    expect(s.getPending(M2)?.id).toBe(1);
    expect(s.getPending(M2)?.milkMl).toBe(0);
    expect(s.getPending(M2)?.splashIds).toEqual([]);
    expect(s.getPending(M3)?.id).toBe(1);
    expect(s.getPending(M3)?.drinkType).toBe("MILK");
  });

  it("espresso + milk splash on the SAME machine within 5 min → merged", async () => {
    const api = new FakeApi();
    api.brewQueue.push([]);
    const p = singleMachinePoller(s, api);
    await p.bootstrap();
    api.brewQueue.push([
      { id: 1, machineTimestamp: "2026-05-20T10:00:00", type: "ESPRESSO", isDouble: 0, milk: { consumption: 0 } },
      { id: 2, machineTimestamp: "2026-05-20T10:02:00", type: "MILK", isDouble: 0, milk: { consumption: 30 } },
    ]);
    await p.tickBrews();
    const pending = s.getPending(M2);
    expect(pending?.id).toBe(1);
    expect(pending?.milkMl).toBe(30);
    expect(pending?.splashIds).toEqual([2]);
    // Splash-merged brews must recompute CO₂ from the new milk total:
    // 7g beans × 1.24 + 30ml × 1.4 = 8.68 + 42 = 50.68
    expect(pending?.co2G).toBeCloseTo(50.68, 2);
  });

  it("computes co2 with config factors and tags the brew with machineId", async () => {
    const api = new FakeApi();
    api.brewQueue.push([]);
    const p = singleMachinePoller(s, api);
    await p.bootstrap();
    api.brewQueue.push([
      { id: 1, machineTimestamp: "2026-05-20T10:00:00", type: "CAPPUCCINO", isDouble: 0, milk: { consumption: 120 } },
    ]);
    await p.tickBrews();
    const last = s.getRecentBrews(1)[0]!;
    expect(last.co2G).toBeCloseTo(176.68, 2);
    expect(last.machineId).toBe(M2);
  });

  it("flushes pending when window expires on next tick (no new brews)", async () => {
    const api = new FakeApi();
    api.brewQueue.push([]);
    const p = singleMachinePoller(s, api);
    await p.bootstrap();
    api.brewQueue.push([{ id: 1, machineTimestamp: "2026-05-20T10:00:00", type: "ESPRESSO", isDouble: 0 }]);
    await p.tickBrews();
    expect(s.getPending(M2)?.id).toBe(1);

    await p.tickBrews(new Date("2026-05-20T10:06:00").getTime());
    expect(s.getPending(M2)).toBeNull();
    expect(s.getRecentBrews(1)[0]?.id).toBe(1);
  });

  it("tickCounters updates per-machine calibration k independently", async () => {
    const apiA = new FakeApi();
    const apiB = new FakeApi();
    apiA.brewQueue.push([]); apiB.brewQueue.push([]);
    const p = dualMachinePoller(s, apiA, apiB);
    await p.bootstrap();

    // Three espressos on machine A only
    apiA.brewQueue.push([
      { id: 1, machineTimestamp: "2026-05-20T10:00:00", type: "ESPRESSO", isDouble: 0 },
      { id: 2, machineTimestamp: "2026-05-20T10:01:00", type: "ESPRESSO", isDouble: 0 },
      { id: 3, machineTimestamp: "2026-05-20T10:10:00", type: "ESPRESSO", isDouble: 0 },
    ]);
    apiB.brewQueue.push([]);
    await p.tickBrews();

    apiA.countersResp = { beans: { totalQuantity: 0.0231 }, water: { totalQuantity: 0 }, lastReset: "2026-01-01T00:00:00" };
    apiB.countersResp = { beans: { totalQuantity: 0 }, water: { totalQuantity: 0 }, lastReset: "2026-01-01T00:00:00" };
    await p.tickCounters();

    const kA = Number(s.getMeta(`beans_calibration_k_${M2}`));
    const kB = Number(s.getMeta(`beans_calibration_k_${M3}`));
    expect(kA).toBeCloseTo(23.1 / 21, 4);
    expect(kB).toBe(1.0); // B saw no brews, k unchanged
  });
});
