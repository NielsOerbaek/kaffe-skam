import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface MachineConfig {
  id: number;
  floor: string;
}

export interface Config {
  co2: { beansFactorGPerG: number; milkFactorGPerMl: number; coffeeBaselineG: number };
  beansDefaultsG: Record<string, number>;       // by API drink_type ENUM — fallback only
  beansByProduct: Record<string, number>;       // by machine button name — primary
  milkUnitMl: number;                            // ml per unit of API's milk.consumption (calibrated ≈ 12.5)
  milkByProduct: Record<string, number>;        // by machine button name; overrides the multiplier when the API value isn't trusted
  zeroMilkProducts: string[];                   // legacy list — entries here force milkMl=0 if no milkByProduct match
  productNameOverrides: Record<string, string>; // keyId (as string) → human name; for slots the API can't name
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
  clientId: string;
  clientSecret: string;
  authUrl: string;                               // Eversys OAuth token endpoint
  locationName: string;                          // brand label shown in the top-left corner
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
  const clientId = readVar(env, "EVERSYS_CLIENT_ID");
  if (!clientId) throw new Error(`Missing EVERSYS_CLIENT_ID (set in .env or process environment)`);
  const clientSecret = readVar(env, "EVERSYS_CLIENT_SECRET");
  if (!clientSecret) throw new Error(`Missing EVERSYS_CLIENT_SECRET (set in .env or process environment)`);
  const authUrl = readVar(env, "EVERSYS_AUTH_URL") ?? "https://auth.eversys-telemetry.com/oauth/token";
  const machinesRaw = readVar(env, "EVERSYS_MACHINES");
  if (!machinesRaw) throw new Error(`Missing EVERSYS_MACHINES (set in .env or process environment)`);
  const machines = parseMachines(machinesRaw);
  const locationName = readVar(env, "LOCATION_NAME") ?? "Kaffeskam";

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

  // Optional fields default to empty if absent in config.json
  const beansByProduct = (raw && typeof raw === "object" && (raw as any).beansByProduct) || {};
  const milkByProduct = (raw && typeof raw === "object" && (raw as any).milkByProduct) || {};
  const zeroMilkProducts = Array.isArray((raw as any).zeroMilkProducts) ? (raw as any).zeroMilkProducts : [];
  const productNameOverrides = (raw && typeof raw === "object" && (raw as any).productNameOverrides) || {};
  const milkUnitMl = typeof (raw as any).milkUnitMl === "number" ? (raw as any).milkUnitMl : 12.5;

  return {
    ...raw,
    beansByProduct,
    milkByProduct,
    milkUnitMl,
    zeroMilkProducts,
    productNameOverrides,
    machines,
    clientId,
    clientSecret,
    authUrl,
    locationName,
  };
}
