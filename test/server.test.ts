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
  splashProducts: [],
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
  building: {
    label: "Testhuset",
    floorAreaM2: 1000,
    ceilingHeightM: 2.5,
    lethalFractionCo2: 0.10,
    ambientFractionCo2: 0.00042,
    co2DensityKgPerM3: 1.83,
  },
};

// One full fill of CFG.building: 2500 m³ × 0.09958 × 1.83 kg/m³ ≈ 455.6 kg.
const DOSE_G = 1000 * 2.5 * (0.10 - 0.00042) * 1.83 * 1000;

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

  it("includes rolling 30d and 365d windows with cups + co2_g", async () => {
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
    expect(j.rolling30d).toEqual({ cups: 1, co2_g: 8.68 });
    expect(j.rolling365d).toEqual({ cups: 1, co2_g: 8.68 });
  });

  // ─── "dødelig dosis" bar ──────────────────────────────────────────
  const insertToday = (id: number, co2G: number) => {
    const today = new Date().toISOString().slice(0, 10);
    s.insertBrew({
      id, machineId: M2, productKey: null, machineTs: `${today}T10:00:00`,
      localDate: today, localMonth: today.slice(0, 7),
      drinkType: "CAPPUCCINO", isDouble: 0,
      beansG: 7, milkMl: 0, co2G,
      splashIds: [], rawJson: "{}",
    });
  };

  it("describes the lethal dose even with no brews", async () => {
    const j = await (await fetch(`${url}/api/state`)).json();
    expect(j.lethal.label).toBe("Testhuset");
    expect(j.lethal.window).toBe(String(new Date().getFullYear()));
    expect(j.lethal.volumeM3).toBeCloseTo(2500, 6);
    expect(j.lethal.fractionCo2).toBe(0.10);
    expect(j.lethal.doseG).toBeCloseTo(DOSE_G, 3);
    expect(j.lethal.fillsCompleted).toBe(0);
    expect(j.lethal.progress).toBe(0);
    expect(j.lethal.daysToNextFill).toBeNull();
  });

  it("reports progress into the current fill for the calendar year", async () => {
    insertToday(1, DOSE_G / 4);
    const j = await (await fetch(`${url}/api/state`)).json();
    expect(j.year.year).toBe(new Date().getFullYear());
    expect(j.year.cups).toBe(1);
    expect(j.year.co2_g).toBeCloseTo(DOSE_G / 4, 3);
    expect(j.lethal.fillsCompleted).toBe(0);
    expect(j.lethal.progress).toBeCloseTo(0.25, 6);
    // A quarter dose over the days elapsed so far → a positive daily rate
    // and a finite projection for the rest of the fill.
    expect(j.lethal.gPerDay).toBeGreaterThan(0);
    expect(j.lethal.daysToNextFill).toBeGreaterThan(0);
  });

  it("laps once past a whole fill", async () => {
    insertToday(1, DOSE_G);
    insertToday(2, DOSE_G / 2);
    const j = await (await fetch(`${url}/api/state`)).json();
    expect(j.lethal.fillsCompleted).toBe(1);
    expect(j.lethal.progress).toBeCloseTo(0.5, 6);
  });

  it("excludes brews from previous calendar years", async () => {
    const lastYear = new Date().getFullYear() - 1;
    s.insertBrew({
      id: 99, machineId: M2, productKey: null, machineTs: `${lastYear}-12-31T10:00:00`,
      localDate: `${lastYear}-12-31`, localMonth: `${lastYear}-12`,
      drinkType: "CAPPUCCINO", isDouble: 0,
      beansG: 7, milkMl: 0, co2G: DOSE_G,
      splashIds: [], rawJson: "{}",
    });
    const j = await (await fetch(`${url}/api/state`)).json();
    expect(j.year.cups).toBe(0);
    expect(j.lethal.fillsCompleted).toBe(0);
    expect(j.lethal.progress).toBe(0);
  });
});
