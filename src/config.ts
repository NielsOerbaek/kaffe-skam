import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

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
  token: string;
  machineId: number;
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

export function loadConfig(dir: string): Config {
  const configPath = join(dir, "config.json");
  const tokenPath = join(dir, ".token");
  const machineIdPath = join(dir, ".machine_id");

  if (!existsSync(tokenPath)) throw new Error(`Missing .token at ${tokenPath}`);
  if (!existsSync(machineIdPath)) throw new Error(`Missing .machine_id at ${machineIdPath}`);
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

  const token = readFileSync(tokenPath, "utf8").trim();
  const machineIdRaw = readFileSync(machineIdPath, "utf8").trim();
  const machineId = Number(machineIdRaw);
  if (!Number.isInteger(machineId)) {
    throw new Error(`.machine_id must contain an integer, got "${machineIdRaw}"`);
  }

  return { ...raw, token, machineId };
}
