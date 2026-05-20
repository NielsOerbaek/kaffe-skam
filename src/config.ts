import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface MachineConfig {
  id: number;
  floor: string;
}

export interface Config {
  co2: { beansFactorGPerG: number; milkFactorGPerMl: number; coffeeBaselineG: number };
  beansDefaultsG: Record<string, number>;
  calibration: { minBrewsBetweenCalibrations: number; maxScaleDelta: number };
  polling: {
    brewsIntervalMs: number;
    countersIntervalMs: number;
    splashWindowMs: number;
    backoffMs: number[];
  };
  server: { port: number; stateRefreshMs: number };
  api: { baseUrl: string };
  machines: MachineConfig[];
  token: string;
}

const requireField = (obj: unknown, path: string): unknown => {
  const parts = path.split(".");
  let cur: any = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object" || !(p in cur)) {
      throw new Error(`config.json: missing required field "${path}"`);
    }
    cur = cur[p];
  }
  return cur;
};

function validateMachines(raw: unknown): MachineConfig[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`config.json: "machines" must be a non-empty array`);
  }
  const out: MachineConfig[] = [];
  for (const m of raw) {
    if (m == null || typeof m !== "object" || typeof (m as any).id !== "number" || typeof (m as any).floor !== "string") {
      throw new Error(`config.json: each machine must be { id: number, floor: string }`);
    }
    if (!Number.isInteger((m as any).id)) {
      throw new Error(`config.json: machine id must be an integer, got ${(m as any).id}`);
    }
    out.push({ id: (m as any).id, floor: (m as any).floor });
  }
  return out;
}

export function loadConfig(dir: string): Config {
  const configPath = join(dir, "config.json");
  const tokenPath = join(dir, ".token");

  if (!existsSync(tokenPath)) throw new Error(`Missing .token at ${tokenPath}`);
  if (!existsSync(configPath)) throw new Error(`Missing config.json at ${configPath}`);

  const raw = JSON.parse(readFileSync(configPath, "utf8"));

  requireField(raw, "co2.beansFactorGPerG");
  requireField(raw, "co2.milkFactorGPerMl");
  requireField(raw, "co2.coffeeBaselineG");
  requireField(raw, "beansDefaultsG");
  requireField(raw, "calibration.minBrewsBetweenCalibrations");
  requireField(raw, "calibration.maxScaleDelta");
  requireField(raw, "polling.brewsIntervalMs");
  requireField(raw, "polling.countersIntervalMs");
  requireField(raw, "polling.splashWindowMs");
  requireField(raw, "polling.backoffMs");
  requireField(raw, "server.port");
  requireField(raw, "server.stateRefreshMs");
  requireField(raw, "api.baseUrl");
  requireField(raw, "machines");

  const machines = validateMachines((raw as any).machines);
  const token = readFileSync(tokenPath, "utf8").trim();

  return { ...raw, machines, token };
}
