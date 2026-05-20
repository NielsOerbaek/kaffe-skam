import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";

describe("loadConfig", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kaffe-"));
    // Ensure process.env doesn't leak between tests
    delete process.env.EVERSYS_TOKEN;
    delete process.env.EVERSYS_MACHINES;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.EVERSYS_TOKEN;
    delete process.env.EVERSYS_MACHINES;
  });

  const minimalConfig = {
    co2: { beansFactorGPerG: 1.24, milkFactorGPerMl: 1.4, coffeeBaselineG: 8.68 },
    beansDefaultsG: { ESPRESSO: 7, _default: 7 },
    calibration: { minBrewsBetweenCalibrations: 50, maxScaleDelta: 0.5 },
    polling: { brewsIntervalMs: 5000, countersIntervalMs: 60000, splashWindowMs: 300000, backoffMs: [5000, 10000] },
    server: { port: 8080, stateRefreshMs: 3000 },
    api: { baseUrl: "https://api.eversys-telemetry.com" },
  };

  const writeFiles = (cfg: object, envBody: string | null) => {
    writeFileSync(join(dir, "config.json"), JSON.stringify(cfg));
    if (envBody !== null) writeFileSync(join(dir, ".env"), envBody);
  };

  const okEnv = [
    "EVERSYS_TOKEN=tok-abc",
    "EVERSYS_MACHINES=28199:2. sal,19708:3. sal",
  ].join("\n");

  it("loads valid config + .env (token + machines)", () => {
    writeFiles(minimalConfig, okEnv);
    const c = loadConfig(dir);
    expect(c.co2.beansFactorGPerG).toBe(1.24);
    expect(c.token).toBe("tok-abc");
    expect(c.machines).toEqual([
      { id: 28199, floor: "2. sal" },
      { id: 19708, floor: "3. sal" },
    ]);
  });

  it("process.env takes precedence over .env file", () => {
    writeFiles(minimalConfig, okEnv);
    process.env.EVERSYS_TOKEN = "from-process-env";
    const c = loadConfig(dir);
    expect(c.token).toBe("from-process-env");
  });

  it("works with only process.env (no .env file present)", () => {
    writeFiles(minimalConfig, null);
    process.env.EVERSYS_TOKEN = "tok-process";
    process.env.EVERSYS_MACHINES = "1:Ground floor";
    const c = loadConfig(dir);
    expect(c.token).toBe("tok-process");
    expect(c.machines).toEqual([{ id: 1, floor: "Ground floor" }]);
  });

  it("throws when EVERSYS_TOKEN is missing", () => {
    writeFiles(minimalConfig, "EVERSYS_MACHINES=1:floor\n");
    expect(() => loadConfig(dir)).toThrow(/EVERSYS_TOKEN/);
  });

  it("throws when EVERSYS_MACHINES is missing", () => {
    writeFiles(minimalConfig, "EVERSYS_TOKEN=tok\n");
    expect(() => loadConfig(dir)).toThrow(/EVERSYS_MACHINES/);
  });

  it("throws on malformed EVERSYS_MACHINES entry (no colon)", () => {
    writeFiles(minimalConfig, "EVERSYS_TOKEN=tok\nEVERSYS_MACHINES=28199\n");
    expect(() => loadConfig(dir)).toThrow(/id:floor/);
  });

  it("throws on non-integer machine id", () => {
    writeFiles(minimalConfig, "EVERSYS_TOKEN=tok\nEVERSYS_MACHINES=abc:floor\n");
    expect(() => loadConfig(dir)).toThrow(/id must be integer/);
  });

  it("throws on malformed config.json", () => {
    writeFileSync(join(dir, "config.json"), "{not json");
    writeFileSync(join(dir, ".env"), okEnv);
    expect(() => loadConfig(dir)).toThrow();
  });

  it("throws on missing required field in config.json", () => {
    const broken: any = JSON.parse(JSON.stringify(minimalConfig));
    delete broken.co2;
    writeFiles(broken, okEnv);
    expect(() => loadConfig(dir)).toThrow(/co2/);
  });

  it("ignores comments and blank lines in .env", () => {
    const body = [
      "# this is a comment",
      "",
      "  # indented comment",
      "EVERSYS_TOKEN=quoted-ok",
      "EVERSYS_MACHINES=1:floor",
    ].join("\n");
    writeFiles(minimalConfig, body);
    const c = loadConfig(dir);
    expect(c.token).toBe("quoted-ok");
  });
});
