import { describe, it, expect, beforeEach } from "vitest";
import { Store } from "../src/store.ts";
import { Poller } from "../src/poller.ts";
import type { Config } from "../src/config.ts";
import type { EversysClient } from "../src/api.ts";
import type { ProductHistory } from "../src/types.ts";

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
  calibration: { minBrewsBetweenCalibrations: 2, maxScaleDelta: 0.5 },
  polling: { brewsIntervalMs: 5000, countersIntervalMs: 60000, splashWindowMs: 300000, backoffMs: [5000] },
  server: { port: 8080, stateRefreshMs: 3000 },
  api: { baseUrl: "" },
  token: "tok",
  machineId: 123,
};

describe("Poller", () => {
  let s: Store;
  beforeEach(() => { s = new Store(":memory:"); });

  it("bootstrap stores last_seen_id from latest brew on first run", async () => {
    const api = new FakeApi();
    api.brewQueue.push([{ id: 999, machineTimestamp: "2026-05-20T10:00:00", type: "ESPRESSO", isDouble: 0 }]);
    const p = new Poller({ api: api as unknown as EversysClient, store: s, config: baseConfig });
    await p.bootstrap();
    expect(s.getMeta("last_seen_id")).toBe("999");
  });

  it("processes a single espresso brew → pending, no commit yet", async () => {
    const api = new FakeApi();
    api.brewQueue.push([]);
    const p = new Poller({ api: api as unknown as EversysClient, store: s, config: baseConfig });
    await p.bootstrap();
    api.brewQueue.push([{ id: 1, machineTimestamp: "2026-05-20T10:00:00", type: "ESPRESSO", isDouble: 0 }]);
    await p.tickBrews();
    expect(s.getPending()?.id).toBe(1);
    expect(s.getLastBrew()?.id).toBe(1);
  });

  it("espresso + milk splash within 5 min → merged into one pending brew", async () => {
    const api = new FakeApi();
    api.brewQueue.push([]);
    const p = new Poller({ api: api as unknown as EversysClient, store: s, config: baseConfig });
    await p.bootstrap();
    api.brewQueue.push([
      { id: 1, machineTimestamp: "2026-05-20T10:00:00", type: "ESPRESSO", isDouble: 0, milk: { consumption: 0 } },
      { id: 2, machineTimestamp: "2026-05-20T10:02:00", type: "MILK", isDouble: 0, milk: { consumption: 30 } },
    ]);
    await p.tickBrews();
    const pending = s.getPending();
    expect(pending?.id).toBe(1);
    expect(pending?.milkMl).toBe(30);
    expect(pending?.splashIds).toEqual([2]);
  });

  it("computes co2 with config factors", async () => {
    const api = new FakeApi();
    api.brewQueue.push([]);
    const p = new Poller({ api: api as unknown as EversysClient, store: s, config: baseConfig });
    await p.bootstrap();
    api.brewQueue.push([
      { id: 1, machineTimestamp: "2026-05-20T10:00:00", type: "CAPPUCCINO", isDouble: 0, milk: { consumption: 120 } },
    ]);
    await p.tickBrews();
    const last = s.getLastBrew()!;
    expect(last.co2G).toBeCloseTo(176.68, 2);
  });

  it("flushes pending when window expires on next tick (no new brews)", async () => {
    const api = new FakeApi();
    api.brewQueue.push([]);
    const p = new Poller({ api: api as unknown as EversysClient, store: s, config: baseConfig });
    await p.bootstrap();
    api.brewQueue.push([{ id: 1, machineTimestamp: "2026-05-20T10:00:00", type: "ESPRESSO", isDouble: 0 }]);
    await p.tickBrews();
    expect(s.getPending()?.id).toBe(1);

    await p.tickBrews(new Date("2026-05-20T10:06:00").getTime());
    expect(s.getPending()).toBeNull();
    expect(s.getLastBrew()?.id).toBe(1);
  });

  it("tickCounters updates calibration k after enough brews", async () => {
    const api = new FakeApi();
    api.brewQueue.push([]);
    const p = new Poller({ api: api as unknown as EversysClient, store: s, config: baseConfig });
    await p.bootstrap();
    api.brewQueue.push([
      { id: 1, machineTimestamp: "2026-05-20T10:00:00", type: "ESPRESSO", isDouble: 0 },
      { id: 2, machineTimestamp: "2026-05-20T10:01:00", type: "ESPRESSO", isDouble: 0 },
      { id: 3, machineTimestamp: "2026-05-20T10:10:00", type: "ESPRESSO", isDouble: 0 },
    ]);
    await p.tickBrews();
    api.countersResp = { beans: { totalQuantity: 0.0231 }, water: { totalQuantity: 0 }, lastReset: "2026-01-01T00:00:00" };
    await p.tickCounters();
    const k = Number(s.getMeta("beans_calibration_k"));
    expect(k).toBeCloseTo(23.1 / 21, 4);
  });
});
