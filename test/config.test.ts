import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";

describe("loadConfig", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "kaffe-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const writeAll = (cfg: object, token = "tok-abc") => {
    writeFileSync(join(dir, "config.json"), JSON.stringify(cfg));
    writeFileSync(join(dir, ".token"), token);
  };

  const minimal = {
    co2: { beansFactorGPerG: 1.24, milkFactorGPerMl: 1.4, coffeeBaselineG: 8.68 },
    beansDefaultsG: { ESPRESSO: 7, _default: 7 },
    calibration: { minBrewsBetweenCalibrations: 50, maxScaleDelta: 0.5 },
    polling: { brewsIntervalMs: 5000, countersIntervalMs: 60000, splashWindowMs: 300000, backoffMs: [5000, 10000] },
    server: { port: 8080, stateRefreshMs: 3000 },
    api: { baseUrl: "https://api.eversys-telemetry.com" },
    machines: [
      { id: 28199, floor: "2. sal" },
      { id: 19708, floor: "3. sal" },
    ],
  };

  it("loads valid config + token + machines list", () => {
    writeAll(minimal);
    const c = loadConfig(dir);
    expect(c.co2.beansFactorGPerG).toBe(1.24);
    expect(c.token).toBe("tok-abc");
    expect(c.machines).toHaveLength(2);
    expect(c.machines[0]).toEqual({ id: 28199, floor: "2. sal" });
    expect(c.machines[1]).toEqual({ id: 19708, floor: "3. sal" });
  });

  it("throws on missing token", () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify(minimal));
    expect(() => loadConfig(dir)).toThrow(/\.token/);
  });

  it("throws on missing machines", () => {
    const broken: any = JSON.parse(JSON.stringify(minimal));
    delete broken.machines;
    writeAll(broken);
    expect(() => loadConfig(dir)).toThrow(/machines/);
  });

  it("throws on empty machines array", () => {
    const broken: any = JSON.parse(JSON.stringify(minimal));
    broken.machines = [];
    writeAll(broken);
    expect(() => loadConfig(dir)).toThrow(/machines/);
  });

  it("throws on malformed machine entry", () => {
    const broken: any = JSON.parse(JSON.stringify(minimal));
    broken.machines = [{ id: "not-an-int", floor: "x" }];
    writeAll(broken);
    expect(() => loadConfig(dir)).toThrow(/machine/);
  });

  it("throws on malformed config.json", () => {
    writeFileSync(join(dir, "config.json"), "{not json");
    writeFileSync(join(dir, ".token"), "tok");
    expect(() => loadConfig(dir)).toThrow();
  });

  it("throws on missing required field", () => {
    const broken: any = JSON.parse(JSON.stringify(minimal));
    delete broken.co2;
    writeAll(broken);
    expect(() => loadConfig(dir)).toThrow(/co2/);
  });
});
