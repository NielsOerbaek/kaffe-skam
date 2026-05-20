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

// Read a tiny KEY=VALUE .env file. Lines starting with # are comments.
// Values may be optionally wrapped in single or double quotes.
function loadEnvFile(dir: string): Record<string, string> {
  const path = join(dir, ".env");
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

// process.env overrides .env so systemd/docker can inject secrets without touching files.
function readVar(env: Record<string, string>, key: string): string | undefined {
  return process.env[key] ?? env[key];
}

// "id:floor,id:floor" → MachineConfig[]
function parseMachines(raw: string): MachineConfig[] {
  const out: MachineConfig[] = [];
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(":");
    if (colon < 0) throw new Error(`EVERSYS_MACHINES entry "${trimmed}" must be id:floor`);
    const id = Number(trimmed.slice(0, colon).trim());
    const floor = trimmed.slice(colon + 1).trim();
    if (!Number.isInteger(id) || !floor) {
      throw new Error(`EVERSYS_MACHINES entry "${trimmed}" malformed (id must be integer, floor non-empty)`);
    }
    out.push({ id, floor });
  }
  if (out.length === 0) throw new Error(`EVERSYS_MACHINES must list at least one machine`);
  return out;
}

export function loadConfig(dir: string): Config {
  const configPath = join(dir, "config.json");
  if (!existsSync(configPath)) throw new Error(`Missing config.json at ${configPath}`);

  const env = loadEnvFile(dir);
  const token = readVar(env, "EVERSYS_TOKEN");
  if (!token) throw new Error(`Missing EVERSYS_TOKEN (set in .env or process environment)`);
  const machinesRaw = readVar(env, "EVERSYS_MACHINES");
  if (!machinesRaw) throw new Error(`Missing EVERSYS_MACHINES (set in .env or process environment)`);
  const machines = parseMachines(machinesRaw);

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

  return { ...raw, machines, token };
}
