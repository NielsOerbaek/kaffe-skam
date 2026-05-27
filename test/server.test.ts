import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Store } from "../src/store.ts";
import { createServer } from "../src/server.ts";
import type { Config } from "../src/config.ts";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

const M2 = 28199;
const M3 = 19708;

const CFG: Config = {
  co2: { beansFactorGPerG: 1.24, milkFactorGPerMl: 1.4, coffeeBaselineG: 8.68 },
  beansDefaultsG: { ESPRESSO: 7, _default: 7 },
  beansByProduct: {},
  milkByProduct: {},
  milkUnitMl: 12.5,
  zeroMilkProducts: [],
  productNameOverrides: {},
  calibration: { minBrewsBetweenCalibrations: 50, maxScaleDelta: 0.5 },
  polling: { brewsIntervalMs: 5000, countersIntervalMs: 60000, splashWindowMs: 300000, backoffMs: [5000] },
  server: { port: 0, stateRefreshMs: 3000 },
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

describe("server /api/state", () => {
  let s: Store;
  let server: Server;
  let url: string;

  beforeEach(async () => {
    s = new Store(":memory:");
    server = createServer({ store: s, config: CFG, publicDir: "" });
    await new Promise<void>(r => server.listen(0, r));
    const { port } = server.address() as AddressInfo;
    url = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    s.close();
    await new Promise<void>(r => server.close(() => r()));
  });

  it("returns empty state when no brews", async () => {
    const r = await fetch(`${url}/api/state`);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.today.cups).toBe(0);
    expect(j.lastBrews).toEqual([]);
  });

  it("returns up to 3 most recent brews with floor labels", async () => {
    s.insertBrew({
      id: 1, machineId: M2, productKey: null, machineTs: "2026-05-20T10:00:00",
      localDate: "2026-05-20", localMonth: "2026-05",
      drinkType: "ESPRESSO", isDouble: 0,
      beansG: 7, milkMl: 0, co2G: 8.68,
      splashIds: [], rawJson: "{}",
    });
    s.insertBrew({
      id: 2, machineId: M3, productKey: null, machineTs: "2026-05-20T10:05:00",
      localDate: "2026-05-20", localMonth: "2026-05",
      drinkType: "CAPPUCCINO", isDouble: 0,
      beansG: 7, milkMl: 120, co2G: 176.68,
      splashIds: [99], rawJson: "{}",
    });
    s.setMeta("last_poll_ok_at", new Date().toISOString());

    const r = await fetch(`${url}/api/state`);
    const j = await r.json();
    expect(j.lastBrews).toHaveLength(2);
    expect(j.lastBrews[0].type).toBe("CAPPUCCINO");
    expect(j.lastBrews[0].displayName).toBe("Cappuccino");
    expect(j.lastBrews[0].floor).toBe("3. sal");
    expect(j.lastBrews[0].splashCount).toBe(1);
    expect(j.lastBrews[0].deltaVsCoffee).toBeCloseTo(176.68 - 8.68, 2);
    expect(j.lastBrews[1].floor).toBe("2. sal");
    expect(j.stale).toBe(false);
  });

  it("caps lastBrews at 6", async () => {
    for (let i = 1; i <= 9; i++) {
      s.insertBrew({
        id: i, machineId: M2, productKey: null, machineTs: `2026-05-20T10:0${i}:00`,
        localDate: "2026-05-20", localMonth: "2026-05",
        drinkType: "ESPRESSO", isDouble: 0,
        beansG: 7, milkMl: 0, co2G: 8.68,
        splashIds: [], rawJson: "{}",
      });
    }
    const r = await fetch(`${url}/api/state`);
    const j = await r.json();
    expect(j.lastBrews).toHaveLength(6);
    expect(j.lastBrews[0].machineTs).toBe("2026-05-20T10:09:00");
  });

  it("marks stale=true when last_poll_ok_at is older than 60s", async () => {
    s.setMeta("last_poll_ok_at", new Date(Date.now() - 120_000).toISOString());
    const r = await fetch(`${url}/api/state`);
    const j = await r.json();
    expect(j.stale).toBe(true);
  });

  it("uses Pi-local today (date computed at request time)", async () => {
    const today = new Date().toISOString().slice(0, 10);
    s.insertBrew({
      id: 1, machineId: M2, productKey: null, machineTs: `${today}T10:00:00`,
      localDate: today, localMonth: today.slice(0, 7),
      drinkType: "ESPRESSO", isDouble: 0,
      beansG: 7, milkMl: 0, co2G: 8.68,
      splashIds: [], rawJson: "{}",
    });
    const r = await fetch(`${url}/api/state`);
    const j = await r.json();
    expect(j.today.cups).toBe(1);
  });
});
