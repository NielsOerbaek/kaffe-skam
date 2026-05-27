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
    delete process.env.EVERSYS_CLIENT_ID;
    delete process.env.EVERSYS_CLIENT_SECRET;
    delete process.env.EVERSYS_AUTH_URL;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.EVERSYS_TOKEN;
    delete process.env.EVERSYS_MACHINES;
    delete process.env.EVERSYS_CLIENT_ID;
    delete process.env.EVERSYS_CLIENT_SECRET;
    delete process.env.EVERSYS_AUTH_URL;
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
    "EVERSYS_CLIENT_ID=cid-abc",
    "EVERSYS_CLIENT_SECRET=csec-abc",
    "EVERSYS_MACHINES=28199:2. sal,19708:3. sal",
  ].join("\n");

  it("loads valid config + .env (client creds + machines)", () => {
    writeFiles(minimalConfig, okEnv);
    const c = loadConfig(dir);
    expect(c.co2.beansFactorGPerG).toBe(1.24);
    expect(c.clientId).toBe("cid-abc");
    expect(c.clientSecret).toBe("csec-abc");
    expect(c.authUrl).toBe("https://auth.eversys-telemetry.com/oauth/token");
    expect(c.machines).toEqual([
      { id: 28199, floor: "2. sal" },
      { id: 19708, floor: "3. sal" },
    ]);
  });

  it("EVERSYS_AUTH_URL overrides the default auth URL", () => {
    writeFiles(minimalConfig, okEnv + "\nEVERSYS_AUTH_URL=https://auth.example/token");
    const c = loadConfig(dir);
    expect(c.authUrl).toBe("https://auth.example/token");
  });

  it("process.env takes precedence over .env file", () => {
    writeFiles(minimalConfig, okEnv);
    process.env.EVERSYS_CLIENT_ID = "from-process-env";
    const c = loadConfig(dir);
    expect(c.clientId).toBe("from-process-env");
  });

  it("works with only process.env (no .env file present)", () => {
    writeFiles(minimalConfig, null);
    process.env.EVERSYS_CLIENT_ID = "cid-process";
    process.env.EVERSYS_CLIENT_SECRET = "csec-process";
    process.env.EVERSYS_MACHINES = "1:Ground floor";
    const c = loadConfig(dir);
    expect(c.clientId).toBe("cid-process");
    expect(c.machines).toEqual([{ id: 1, floor: "Ground floor" }]);
  });

  it("does NOT require EVERSYS_TOKEN", () => {
    writeFiles(minimalConfig, okEnv);
    expect(() => loadConfig(dir)).not.toThrow();
  });

  it("throws when EVERSYS_CLIENT_ID is missing", () => {
    writeFiles(minimalConfig, "EVERSYS_CLIENT_SECRET=csec\nEVERSYS_MACHINES=1:floor\n");
    expect(() => loadConfig(dir)).toThrow(/EVERSYS_CLIENT_ID/);
  });

  it("throws when EVERSYS_CLIENT_SECRET is missing", () => {
    writeFiles(minimalConfig, "EVERSYS_CLIENT_ID=cid\nEVERSYS_MACHINES=1:floor\n");
    expect(() => loadConfig(dir)).toThrow(/EVERSYS_CLIENT_SECRET/);
  });

  it("throws when EVERSYS_MACHINES is missing", () => {
    writeFiles(minimalConfig, "EVERSYS_CLIENT_ID=cid\nEVERSYS_CLIENT_SECRET=csec\n");
    expect(() => loadConfig(dir)).toThrow(/EVERSYS_MACHINES/);
  });

  it("throws on malformed EVERSYS_MACHINES entry (no colon)", () => {
    writeFiles(minimalConfig, "EVERSYS_CLIENT_ID=cid\nEVERSYS_CLIENT_SECRET=csec\nEVERSYS_MACHINES=28199\n");
    expect(() => loadConfig(dir)).toThrow(/id:floor/);
  });

  it("throws on non-integer machine id", () => {
    writeFiles(minimalConfig, "EVERSYS_CLIENT_ID=cid\nEVERSYS_CLIENT_SECRET=csec\nEVERSYS_MACHINES=abc:floor\n");
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
      "EVERSYS_CLIENT_ID=quoted-ok",
      "EVERSYS_CLIENT_SECRET=csec",
      "EVERSYS_MACHINES=1:floor",
    ].join("\n");
    writeFiles(minimalConfig, body);
    const c = loadConfig(dir);
    expect(c.clientId).toBe("quoted-ok");
  });
});
