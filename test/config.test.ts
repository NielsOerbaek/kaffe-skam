import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";

describe("loadConfig", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "kaffe-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const writeAll = (cfg: object, token = "tok-abc", id = "123") => {
    writeFileSync(join(dir, "config.json"), JSON.stringify(cfg));
    writeFileSync(join(dir, ".token"), token);
    writeFileSync(join(dir, ".machine_id"), id);
  };

  const minimal = {
    co2: { beansFactorGPerG: 1.24, milkFactorGPerMl: 1.4, coffeeBaselineG: 8.68 },
    beansDefaultsG: { ESPRESSO: 7, _default: 7 },
    calibration: { minBrewsBetweenCalibrations: 50, maxScaleDelta: 0.5 },
    polling: { brewsIntervalMs: 5000, countersIntervalMs: 60000, splashWindowMs: 300000, backoffMs: [5000, 10000] },
    server: { port: 8080, stateRefreshMs: 3000 },
    api: { baseUrl: "https://api.eversys-telemetry.com" },
  };

  it("loads valid config + token + machine id", () => {
    writeAll(minimal);
    const c = loadConfig(dir);
    expect(c.co2.beansFactorGPerG).toBe(1.24);
    expect(c.token).toBe("tok-abc");
    expect(c.machineId).toBe(123);
  });

  it("throws on missing token", () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify(minimal));
    writeFileSync(join(dir, ".machine_id"), "123");
    expect(() => loadConfig(dir)).toThrow(/\.token/);
  });

  it("throws on non-numeric machine id", () => {
    writeAll(minimal, "tok", "abc");
    expect(() => loadConfig(dir)).toThrow(/machine_id/);
  });

  it("throws on malformed config.json", () => {
    writeFileSync(join(dir, "config.json"), "{not json");
    writeFileSync(join(dir, ".token"), "tok");
    writeFileSync(join(dir, ".machine_id"), "1");
    expect(() => loadConfig(dir)).toThrow();
  });

  it("throws on missing required field", () => {
    const broken: any = JSON.parse(JSON.stringify(minimal));
    delete broken.co2;
    writeAll(broken);
    expect(() => loadConfig(dir)).toThrow(/co2/);
  });
});
