# Kaffe-skam Coffee CO2 Dashboard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Node + TypeScript service that polls the Eversys Telemetry API, persists per-brew CO2 estimates to SQLite, and serves a landscape dashboard at `http://<pi>:8080/`.

**Architecture:** One Node process with internal modules (config, api, store, merge, beans, co2, poller, server). The HTTP boundary at `GET /api/state` is the contract the future ESP32 client will reuse unchanged. SQLite (`better-sqlite3`) is the only persistence. No frontend build step — vanilla HTML/JS/CSS in `public/`.

**Tech Stack:**
- Node.js 20+ with TypeScript 5+, ESM
- `better-sqlite3` for SQLite (synchronous API; perfect for a single-process service)
- `vitest` for testing
- Native `fetch` (Node 20+); no axios
- `http.createServer` from Node stdlib (no Express)

**Source of truth:** `docs/superpowers/specs/2026-05-20-kaffe-co2-dashboard-design.md`

---

## File map

| File | Purpose |
|---|---|
| `package.json` | deps, scripts |
| `tsconfig.json` | TS compiler options |
| `vitest.config.ts` | test runner |
| `config.json` | CO2 factors, bean defaults, polling intervals, port |
| `src/types.ts` | shared TS types (`Brew`, `PendingBrew`, `ApiState`, `ProductHistory`) |
| `src/config.ts` | load + validate `config.json`, `.token`, `.machine_id` |
| `src/co2.ts` | pure CO2 math, drink-type humanizer |
| `src/beans.ts` | per-brew bean-gram estimation + calibration |
| `src/merge.ts` | splash-merge state machine (pure function) |
| `src/api.ts` | Eversys HTTP client + backoff |
| `src/store.ts` | SQLite schema + query surface |
| `src/poller.ts` | brews-poller and counters-poller loops |
| `src/server.ts` | HTTP server, `/api/state`, static |
| `src/index.ts` | entrypoint, wires modules together |
| `public/index.html` | dashboard markup |
| `public/style.css` | dark, e-ink-friendly styling |
| `public/app.js` | poll `/api/state`, render |
| `test/fixtures/*.json` | recorded Eversys responses |
| `test/*.test.ts` | unit + integration tests |
| `systemd/kaffe-skam.service` | systemd unit for the Pi |
| `README.md` | install + run instructions |

---

## Task 1: Project bootstrap

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `config.json`
- Create: `src/.gitkeep`, `public/.gitkeep`, `test/fixtures/.gitkeep`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "kaffe-skam",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "start": "node --import tsx/esm src/index.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "better-sqlite3": "^11.0.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.10",
    "@types/node": "^20.0.0",
    "tsx": "^4.7.0",
    "typescript": "^5.4.0",
    "vitest": "^1.6.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "allowImportingTsExtensions": true,
    "noEmit": true
  },
  "include": ["src/**/*", "test/**/*"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
```

- [ ] **Step 4: Create `config.json`** (matches spec defaults)

```json
{
  "co2": {
    "beansFactorGPerG": 1.24,
    "milkFactorGPerMl": 1.4,
    "coffeeBaselineG": 8.68
  },
  "beansDefaultsG": {
    "RISTRETTO": 8, "ESPRESSO": 7, "COFFEE": 7,
    "AMERICANO": 7, "MILK_COFFEE": 7, "CAPPUCCINO": 7,
    "ESPRESSO_MACCHIATO": 7, "LATTE_MACCHIATO": 7,
    "WHITE_AMERICANO": 7, "FILTER_COFFEE": 10,
    "COFFEE_POT": 14, "FILTER_COFFEE_POT": 20,
    "_default": 7
  },
  "calibration": {
    "minBrewsBetweenCalibrations": 50,
    "maxScaleDelta": 0.5
  },
  "polling": {
    "brewsIntervalMs": 5000,
    "countersIntervalMs": 60000,
    "splashWindowMs": 300000,
    "backoffMs": [5000, 10000, 30000, 60000]
  },
  "server": {
    "port": 8080,
    "stateRefreshMs": 3000
  },
  "api": {
    "baseUrl": "https://api.eversys-telemetry.com"
  }
}
```

- [ ] **Step 5: Create empty directories with `.gitkeep`**

```bash
mkdir -p src public test/fixtures systemd
touch src/.gitkeep public/.gitkeep test/fixtures/.gitkeep
```

- [ ] **Step 6: Install dependencies**

Run: `npm install`
Expected: completes without errors, creates `node_modules/` and `package-lock.json`.

- [ ] **Step 7: Verify scripts work**

Run: `npm run typecheck`
Expected: PASS (no errors, no files yet).

Run: `npm test`
Expected: PASS with "No test files found" or 0 tests (vitest is OK with that).

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts config.json src/ public/ test/ systemd/
git commit -m "chore: bootstrap node + ts + vitest project"
```

---

## Task 2: Shared types

**Files:**
- Create: `src/types.ts`

- [ ] **Step 1: Write `src/types.ts`**

```ts
// Eversys API — subset of ProductHistoryModelNew we actually use.
// Field names match the API exactly; unknown fields are ignored.
export type DrinkType =
  | "NONE" | "RISTRETTO" | "ESPRESSO" | "COFFEE" | "FILTER_COFFEE"
  | "AMERICANO" | "COFFEE_POT" | "FILTER_COFFEE_POT" | "HOT_WATER"
  | "MANUAL_STEAM" | "AUTO_STEAM" | "EVERFOAM" | "MILK_COFFEE"
  | "CAPPUCCINO" | "ESPRESSO_MACCHIATO" | "LATTE_MACCHIATO"
  | "MILK" | "MILK_FOAM" | "POWDER" | "WHITE_AMERICANO"
  | "HOT_WATER_WITH_MILK" | "UNRESOLVED";

export interface ProductHistory {
  id: number;
  machineTimestamp: string; // ISO 8601 (machine local time)
  type: DrinkType;
  isDouble: 0 | 1;
  milk?: { consumption?: number } | null; // ml
  // raw_json keeps the full payload; this is just what merge/co2 use
}

// What we commit to the brews table.
export interface Brew {
  id: number;             // Eversys id of the primary brew
  machineTs: string;
  localDate: string;      // YYYY-MM-DD (Pi local time)
  localMonth: string;     // YYYY-MM
  drinkType: DrinkType;
  isDouble: 0 | 1;
  beansG: number;
  milkMl: number;
  co2G: number;
  splashIds: number[];    // empty array if none
  rawJson: string;        // serialized primary ProductHistory
}

// Pending brew (not yet committed, waiting for a possible splash).
export interface PendingBrew extends Brew {
  expiresAt: string;      // machineTs + splashWindowMs, ISO 8601
}

// /api/state JSON shape.
export interface ApiState {
  today:   { cups: number; co2_g: number };
  month:   { cups: number; co2_g: number };
  lastBrew: {
    type: DrinkType;
    displayName: string;
    machineTs: string;
    beansG: number;
    milkMl: number;
    co2G: number;
    splashCount: number;
    deltaVsCoffee: number;
  } | null;
  stale: boolean;
  lastPollOkAt: string | null;
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat: shared TS types for brews + API state"
```

---

## Task 3: Config loader (TDD)

**Files:**
- Create: `src/config.ts`, `test/config.test.ts`

- [ ] **Step 1: Write failing test `test/config.test.ts`**

```ts
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
```

- [ ] **Step 2: Run the test, see it fail**

Run: `npm test -- config`
Expected: FAIL (`loadConfig` not exported).

- [ ] **Step 3: Implement `src/config.ts`**

```ts
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

  // Validate required structure (throws on first missing field)
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
```

- [ ] **Step 4: Run tests, see them pass**

Run: `npm test -- config`
Expected: 5/5 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts test/config.test.ts
git commit -m "feat(config): load + validate config.json, .token, .machine_id"
```

---

## Task 4: CO2 pure functions (TDD)

**Files:**
- Create: `src/co2.ts`, `test/co2.test.ts`

- [ ] **Step 1: Write failing test `test/co2.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { co2ForBrew, humanizeType, deltaVsCoffee } from "../src/co2.ts";

const C = {
  beansFactorGPerG: 1.24,
  milkFactorGPerMl: 1.4,
  coffeeBaselineG: 8.68,
};

describe("co2ForBrew", () => {
  it("computes beans + milk only (no water/electricity)", () => {
    // 7g beans * 1.24 + 120ml milk * 1.4 = 8.68 + 168 = 176.68
    expect(co2ForBrew(7, 120, C)).toBeCloseTo(176.68, 2);
  });

  it("handles zero milk", () => {
    expect(co2ForBrew(7, 0, C)).toBeCloseTo(8.68, 2);
  });

  it("handles zero beans", () => {
    expect(co2ForBrew(0, 100, C)).toBeCloseTo(140, 2);
  });
});

describe("humanizeType", () => {
  it("title-cases single words", () => {
    expect(humanizeType("ESPRESSO")).toBe("Espresso");
  });
  it("title-cases multi-word enums", () => {
    expect(humanizeType("LATTE_MACCHIATO")).toBe("Latte Macchiato");
    expect(humanizeType("HOT_WATER_WITH_MILK")).toBe("Hot Water With Milk");
  });
  it("falls through for unknown", () => {
    expect(humanizeType("UNRESOLVED")).toBe("Unresolved");
  });
});

describe("deltaVsCoffee", () => {
  it("positive when brew is heavier than baseline", () => {
    expect(deltaVsCoffee(176.68, C)).toBeCloseTo(168.00, 2);
  });
  it("negative when lighter", () => {
    expect(deltaVsCoffee(5, C)).toBeCloseTo(-3.68, 2);
  });
});
```

- [ ] **Step 2: Run test, see it fail**

Run: `npm test -- co2`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/co2.ts`**

```ts
import type { DrinkType } from "./types.ts";

export interface Co2Factors {
  beansFactorGPerG: number;
  milkFactorGPerMl: number;
  coffeeBaselineG: number;
}

export function co2ForBrew(beansG: number, milkMl: number, c: Co2Factors): number {
  return beansG * c.beansFactorGPerG + milkMl * c.milkFactorGPerMl;
}

export function deltaVsCoffee(co2G: number, c: Co2Factors): number {
  return co2G - c.coffeeBaselineG;
}

export function humanizeType(t: DrinkType | string): string {
  return t
    .toLowerCase()
    .split("_")
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
```

- [ ] **Step 4: Run tests, see them pass**

Run: `npm test -- co2`
Expected: 7/7 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/co2.ts test/co2.test.ts
git commit -m "feat(co2): pure CO2 math + drink-type humanizer"
```

---

## Task 5: Bean-gram estimation + calibration (TDD)

**Files:**
- Create: `src/beans.ts`, `test/beans.test.ts`

- [ ] **Step 1: Write failing test `test/beans.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { defaultBeansG, applyCalibration, recalibrate } from "../src/beans.ts";

const DEFAULTS = { ESPRESSO: 7, COFFEE: 7, RISTRETTO: 8, _default: 7 };

describe("defaultBeansG", () => {
  it("returns mapped value for known type", () => {
    expect(defaultBeansG("ESPRESSO", 0, DEFAULTS)).toBe(7);
    expect(defaultBeansG("RISTRETTO", 0, DEFAULTS)).toBe(8);
  });
  it("doubles when isDouble=1", () => {
    expect(defaultBeansG("ESPRESSO", 1, DEFAULTS)).toBe(14);
  });
  it("falls back to _default for unknown type", () => {
    expect(defaultBeansG("UNRESOLVED" as any, 0, DEFAULTS)).toBe(7);
  });
});

describe("applyCalibration", () => {
  it("multiplies by k", () => {
    expect(applyCalibration(7, 1.1)).toBeCloseTo(7.7, 4);
  });
  it("returns input when k=1", () => {
    expect(applyCalibration(7, 1.0)).toBe(7);
  });
});

describe("recalibrate", () => {
  const cfg = { minBrewsBetweenCalibrations: 50, maxScaleDelta: 0.5 };

  it("returns null when fewer than min brews since anchor", () => {
    expect(recalibrate({
      brewsSinceAnchor: 10,
      summedBeansGSinceAnchor: 70,
      actualGramsDelta: 80,
      currentK: 1.0,
    }, cfg)).toBeNull();
  });

  it("returns new k when calibration triggers", () => {
    const r = recalibrate({
      brewsSinceAnchor: 60,
      summedBeansGSinceAnchor: 420,   // we estimated 420g
      actualGramsDelta: 462,          // actual was 462g
      currentK: 1.0,
    }, cfg);
    // raw scale = 462/420 = 1.1; applied to current k=1 → 1.1
    expect(r).toBeCloseTo(1.1, 4);
  });

  it("clamps to maxScaleDelta", () => {
    const r = recalibrate({
      brewsSinceAnchor: 60,
      summedBeansGSinceAnchor: 100,
      actualGramsDelta: 1000,         // raw scale 10x — must clamp
      currentK: 1.0,
    }, cfg);
    // clamped to currentK ± maxScaleDelta = 1 + 0.5 = 1.5
    expect(r).toBeCloseTo(1.5, 4);
  });

  it("returns null when actualGramsDelta is zero or negative (counter reset)", () => {
    expect(recalibrate({
      brewsSinceAnchor: 60,
      summedBeansGSinceAnchor: 420,
      actualGramsDelta: 0,
      currentK: 1.0,
    }, cfg)).toBeNull();
    expect(recalibrate({
      brewsSinceAnchor: 60,
      summedBeansGSinceAnchor: 420,
      actualGramsDelta: -10,
      currentK: 1.0,
    }, cfg)).toBeNull();
  });

  it("returns null when summed estimate is zero", () => {
    expect(recalibrate({
      brewsSinceAnchor: 60,
      summedBeansGSinceAnchor: 0,
      actualGramsDelta: 500,
      currentK: 1.0,
    }, cfg)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test, see it fail**

Run: `npm test -- beans`
Expected: FAIL.

- [ ] **Step 3: Implement `src/beans.ts`**

```ts
import type { DrinkType } from "./types.ts";

export type BeansDefaults = Record<string, number>;

export function defaultBeansG(type: DrinkType, isDouble: 0 | 1, defaults: BeansDefaults): number {
  const base = defaults[type] ?? defaults._default ?? 7;
  return isDouble === 1 ? base * 2 : base;
}

export function applyCalibration(beansG: number, k: number): number {
  return beansG * k;
}

export interface CalibrationInput {
  brewsSinceAnchor: number;
  summedBeansGSinceAnchor: number; // sum of beansG we estimated and stored
  actualGramsDelta: number;        // (counter_kg_now - counter_kg_at_anchor) * 1000
  currentK: number;
}

export interface CalibrationConfig {
  minBrewsBetweenCalibrations: number;
  maxScaleDelta: number;
}

export function recalibrate(input: CalibrationInput, cfg: CalibrationConfig): number | null {
  if (input.brewsSinceAnchor < cfg.minBrewsBetweenCalibrations) return null;
  if (input.summedBeansGSinceAnchor <= 0) return null;
  if (input.actualGramsDelta <= 0) return null;

  const rawScale = input.actualGramsDelta / input.summedBeansGSinceAnchor;
  // Treat rawScale as the multiplier we *should* be applying overall, then
  // re-derive a new k by combining with what we've already been applying.
  // Since summedBeansGSinceAnchor already had currentK baked in, the corrected
  // k is simply currentK * rawScale.
  const target = input.currentK * rawScale;

  const min = input.currentK - cfg.maxScaleDelta;
  const max = input.currentK + cfg.maxScaleDelta;
  return Math.max(min, Math.min(max, target));
}
```

- [ ] **Step 4: Run tests, see them pass**

Run: `npm test -- beans`
Expected: 9/9 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/beans.ts test/beans.test.ts
git commit -m "feat(beans): default per-drink grams + calibration logic"
```

---

## Task 6: Splash-merge state machine (TDD)

**Files:**
- Create: `src/merge.ts`, `test/merge.test.ts`

- [ ] **Step 1: Write failing test `test/merge.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { mergeStep } from "../src/merge.ts";
import type { ProductHistory, PendingBrew } from "../src/types.ts";

const SPLASH_WINDOW_MS = 5 * 60 * 1000;

const ph = (over: Partial<ProductHistory>): ProductHistory => ({
  id: 1, machineTimestamp: "2026-05-20T10:00:00", type: "ESPRESSO", isDouble: 0,
  milk: { consumption: 0 }, ...over,
});

const pending = (over: Partial<PendingBrew>): PendingBrew => ({
  id: 1, machineTs: "2026-05-20T10:00:00",
  localDate: "2026-05-20", localMonth: "2026-05",
  drinkType: "ESPRESSO", isDouble: 0,
  beansG: 7, milkMl: 0, co2G: 8.68,
  splashIds: [], rawJson: "{}",
  expiresAt: "2026-05-20T10:05:00",
  ...over,
});

describe("mergeStep", () => {
  it("first brew with no pending → new pending, no commit", () => {
    const r = mergeStep(ph({ id: 1 }), null, SPLASH_WINDOW_MS);
    expect(r.commit).toBeNull();
    expect(r.newPending?.id).toBe(1);
    expect(r.mergedSplash).toBe(false);
  });

  it("non-splash arrives while pending exists → flush pending, new pending", () => {
    const r = mergeStep(
      ph({ id: 2, type: "ESPRESSO", machineTimestamp: "2026-05-20T10:01:00" }),
      pending({ id: 1 }),
      SPLASH_WINDOW_MS,
    );
    expect(r.commit?.id).toBe(1);
    expect(r.newPending?.id).toBe(2);
  });

  it("MILK splash within window → merge into pending", () => {
    const r = mergeStep(
      ph({ id: 2, type: "MILK", machineTimestamp: "2026-05-20T10:02:00", milk: { consumption: 30 } }),
      pending({ id: 1 }),
      SPLASH_WINDOW_MS,
    );
    expect(r.commit).toBeNull();
    expect(r.newPending?.id).toBe(1);
    expect(r.newPending?.milkMl).toBe(30);
    expect(r.newPending?.splashIds).toEqual([2]);
    expect(r.mergedSplash).toBe(true);
  });

  it("MILK_FOAM splash counts too", () => {
    const r = mergeStep(
      ph({ id: 2, type: "MILK_FOAM", machineTimestamp: "2026-05-20T10:02:00", milk: { consumption: 20 } }),
      pending({ id: 1, milkMl: 100, splashIds: [] }),
      SPLASH_WINDOW_MS,
    );
    expect(r.mergedSplash).toBe(true);
    expect(r.newPending?.milkMl).toBe(120);
  });

  it("HOT_WATER_WITH_MILK splash counts too", () => {
    const r = mergeStep(
      ph({ id: 2, type: "HOT_WATER_WITH_MILK", machineTimestamp: "2026-05-20T10:02:00", milk: { consumption: 15 } }),
      pending({ id: 1, milkMl: 0 }),
      SPLASH_WINDOW_MS,
    );
    expect(r.mergedSplash).toBe(true);
  });

  it("MILK arriving AFTER window expired → flush pending, new pending (own)", () => {
    const r = mergeStep(
      ph({ id: 2, type: "MILK", machineTimestamp: "2026-05-20T10:06:00", milk: { consumption: 30 } }),
      pending({ id: 1 }), // expiresAt = 10:05:00
      SPLASH_WINDOW_MS,
    );
    expect(r.commit?.id).toBe(1);
    expect(r.newPending?.id).toBe(2);
    expect(r.newPending?.drinkType).toBe("MILK");
  });

  it("MILK with no pending → becomes its own pending brew", () => {
    const r = mergeStep(
      ph({ id: 1, type: "MILK", milk: { consumption: 30 } }),
      null,
      SPLASH_WINDOW_MS,
    );
    expect(r.commit).toBeNull();
    expect(r.newPending?.drinkType).toBe("MILK");
    expect(r.mergedSplash).toBe(false);
  });

  it("Second splash extends the window from its own timestamp", () => {
    const r = mergeStep(
      ph({ id: 3, type: "MILK", machineTimestamp: "2026-05-20T10:04:30", milk: { consumption: 15 } }),
      pending({ id: 1, milkMl: 30, splashIds: [2], expiresAt: "2026-05-20T10:05:00" }),
      SPLASH_WINDOW_MS,
    );
    expect(r.newPending?.milkMl).toBe(45);
    expect(r.newPending?.splashIds).toEqual([2, 3]);
    expect(r.newPending?.expiresAt).toBe("2026-05-20T10:09:30");
  });
});
```

- [ ] **Step 2: Run test, see it fail**

Run: `npm test -- merge`
Expected: FAIL.

- [ ] **Step 3: Implement `src/merge.ts`**

```ts
import type { ProductHistory, PendingBrew, DrinkType } from "./types.ts";

const SPLASH_TYPES: ReadonlySet<DrinkType> = new Set([
  "MILK", "MILK_FOAM", "HOT_WATER_WITH_MILK",
]);

export interface MergeStepResult {
  commit: PendingBrew | null;     // existing pending to flush, if any
  newPending: PendingBrew | null; // new pending state (may be the same id as before, if merged)
  mergedSplash: boolean;
}

export interface MergeDeps {
  // For making a fresh PendingBrew from a ProductHistory.
  // Injected so we don't recompute CO2/beansG here.
  toPending: (ph: ProductHistory, splashWindowMs: number) => PendingBrew;
}

// Default toPending built outside this module (in poller). For tests we pass
// a minimal builder via overload; the implementation accepts an optional dep
// object and falls back to a trivial default that copies values verbatim.
const defaultToPending = (ph: ProductHistory, splashWindowMs: number): PendingBrew => {
  const machineTs = ph.machineTimestamp;
  return {
    id: ph.id,
    machineTs,
    localDate: machineTs.slice(0, 10),
    localMonth: machineTs.slice(0, 7),
    drinkType: ph.type,
    isDouble: ph.isDouble,
    beansG: 0,
    milkMl: ph.milk?.consumption ?? 0,
    co2G: 0,
    splashIds: [],
    rawJson: JSON.stringify(ph),
    expiresAt: new Date(new Date(machineTs).getTime() + splashWindowMs).toISOString().replace(/\.\d+Z$/, ""),
  };
};

export function mergeStep(
  incoming: ProductHistory,
  pending: PendingBrew | null,
  splashWindowMs: number,
  deps: MergeDeps = { toPending: defaultToPending },
): MergeStepResult {
  const isSplash = SPLASH_TYPES.has(incoming.type);
  const incomingMs = new Date(incoming.machineTimestamp).getTime();

  if (pending == null) {
    return { commit: null, newPending: deps.toPending(incoming, splashWindowMs), mergedSplash: false };
  }

  const expiresMs = new Date(pending.expiresAt).getTime();
  const withinWindow = incomingMs <= expiresMs;

  if (isSplash && withinWindow) {
    const splashMilk = incoming.milk?.consumption ?? 0;
    const newExpires = new Date(incomingMs + splashWindowMs).toISOString().replace(/\.\d+Z$/, "");
    return {
      commit: null,
      newPending: {
        ...pending,
        milkMl: pending.milkMl + splashMilk,
        splashIds: [...pending.splashIds, incoming.id],
        expiresAt: newExpires,
      },
      mergedSplash: true,
    };
  }

  // Not a splash, or window expired: flush pending, start a new one
  return {
    commit: pending,
    newPending: deps.toPending(incoming, splashWindowMs),
    mergedSplash: false,
  };
}
```

- [ ] **Step 4: Run tests, see them pass**

Run: `npm test -- merge`
Expected: 8/8 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/merge.ts test/merge.test.ts
git commit -m "feat(merge): splash-merge state machine"
```

---

## Task 7: SQLite store (TDD)

**Files:**
- Create: `src/store.ts`, `test/store.test.ts`

- [ ] **Step 1: Write failing test `test/store.test.ts`**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { Store } from "../src/store.ts";
import type { Brew, PendingBrew } from "../src/types.ts";

const makeBrew = (over: Partial<Brew> = {}): Brew => ({
  id: 1, machineTs: "2026-05-20T10:00:00",
  localDate: "2026-05-20", localMonth: "2026-05",
  drinkType: "ESPRESSO", isDouble: 0,
  beansG: 7, milkMl: 0, co2G: 8.68,
  splashIds: [], rawJson: "{}",
  ...over,
});

const makePending = (over: Partial<PendingBrew> = {}): PendingBrew => ({
  ...makeBrew(over), expiresAt: "2026-05-20T10:05:00",
  ...over,
});

describe("Store", () => {
  let s: Store;
  beforeEach(() => { s = new Store(":memory:"); });

  it("creates schema on construction", () => {
    expect(s.getMeta("schema_version")).toBe("1");
  });

  it("inserts and reads back a brew", () => {
    s.insertBrew(makeBrew({ id: 1 }));
    s.insertBrew(makeBrew({ id: 2, co2G: 50, drinkType: "CAPPUCCINO" }));
    const last = s.getLastBrew();
    expect(last?.id).toBe(2);
    expect(last?.drinkType).toBe("CAPPUCCINO");
  });

  it("getTodayTotals counts cups + sums co2 for today only", () => {
    s.insertBrew(makeBrew({ id: 1, localDate: "2026-05-20", co2G: 10 }));
    s.insertBrew(makeBrew({ id: 2, localDate: "2026-05-20", co2G: 20 }));
    s.insertBrew(makeBrew({ id: 3, localDate: "2026-05-19", co2G: 99 }));
    const t = s.getTodayTotals("2026-05-20");
    expect(t).toEqual({ cups: 2, co2_g: 30 });
  });

  it("getMonthTotals counts cups + sums co2 for the month", () => {
    s.insertBrew(makeBrew({ id: 1, localMonth: "2026-05", co2G: 10 }));
    s.insertBrew(makeBrew({ id: 2, localMonth: "2026-05", co2G: 20 }));
    s.insertBrew(makeBrew({ id: 3, localMonth: "2026-04", co2G: 99 }));
    const m = s.getMonthTotals("2026-05");
    expect(m).toEqual({ cups: 2, co2_g: 30 });
  });

  it("pending brew counts toward today totals when localDate matches", () => {
    s.insertBrew(makeBrew({ id: 1, localDate: "2026-05-20", co2G: 10 }));
    s.setPending(makePending({ id: 99, localDate: "2026-05-20", co2G: 50 }));
    const t = s.getTodayTotals("2026-05-20");
    expect(t.cups).toBe(2);
    expect(t.co2_g).toBe(60);
  });

  it("pending does not count when localDate differs", () => {
    s.insertBrew(makeBrew({ id: 1, localDate: "2026-05-20", co2G: 10 }));
    s.setPending(makePending({ id: 99, localDate: "2026-05-19" }));
    const t = s.getTodayTotals("2026-05-20");
    expect(t.cups).toBe(1);
  });

  it("getLastBrew returns pending if newer than committed", () => {
    s.insertBrew(makeBrew({ id: 1, machineTs: "2026-05-20T10:00:00" }));
    s.setPending(makePending({ id: 99, machineTs: "2026-05-20T10:01:00" }));
    expect(s.getLastBrew()?.id).toBe(99);
  });

  it("getLastBrew returns committed when no pending", () => {
    s.insertBrew(makeBrew({ id: 1 }));
    expect(s.getLastBrew()?.id).toBe(1);
  });

  it("clearPending removes the pending brew", () => {
    s.setPending(makePending({ id: 99 }));
    s.clearPending();
    expect(s.getPending()).toBeNull();
  });

  it("meta key/value round-trips", () => {
    s.setMeta("last_seen_id", "42");
    expect(s.getMeta("last_seen_id")).toBe("42");
    s.setMeta("last_seen_id", "43");
    expect(s.getMeta("last_seen_id")).toBe("43");
  });

  it("inserting same id twice is a no-op (idempotent)", () => {
    s.insertBrew(makeBrew({ id: 1, co2G: 10 }));
    s.insertBrew(makeBrew({ id: 1, co2G: 999 }));
    const t = s.getTodayTotals("2026-05-20");
    expect(t.cups).toBe(1);
    expect(t.co2_g).toBe(10);
  });

  it("splashIds round-trip as JSON array", () => {
    s.insertBrew(makeBrew({ id: 1, splashIds: [2, 3] }));
    expect(s.getLastBrew()?.splashIds).toEqual([2, 3]);
  });
});
```

- [ ] **Step 2: Run test, see it fail**

Run: `npm test -- store`
Expected: FAIL.

- [ ] **Step 3: Implement `src/store.ts`**

```ts
import Database from "better-sqlite3";
import type { Brew, PendingBrew } from "./types.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS brews (
  id              INTEGER PRIMARY KEY,
  machine_ts      TEXT NOT NULL,
  local_date      TEXT NOT NULL,
  local_month     TEXT NOT NULL,
  drink_type      TEXT NOT NULL,
  is_double       INTEGER NOT NULL,
  beans_g         REAL NOT NULL,
  milk_ml         REAL NOT NULL,
  co2_g           REAL NOT NULL,
  splash_ids      TEXT,
  raw_json        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_brews_local_date  ON brews(local_date);
CREATE INDEX IF NOT EXISTS idx_brews_local_month ON brews(local_month);

CREATE TABLE IF NOT EXISTS pending_brew (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  brew_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`;

export interface Totals { cups: number; co2_g: number }

export class Store {
  private db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
    if (this.getMeta("schema_version") == null) {
      this.setMeta("schema_version", "1");
    }
  }

  close() { this.db.close(); }

  insertBrew(b: Brew): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO brews
        (id, machine_ts, local_date, local_month, drink_type, is_double,
         beans_g, milk_ml, co2_g, splash_ids, raw_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      b.id, b.machineTs, b.localDate, b.localMonth, b.drinkType, b.isDouble,
      b.beansG, b.milkMl, b.co2G,
      b.splashIds.length ? JSON.stringify(b.splashIds) : null,
      b.rawJson,
    );
  }

  getLastBrew(): Brew | PendingBrew | null {
    const pending = this.getPending();
    const row = this.db.prepare(`SELECT * FROM brews ORDER BY machine_ts DESC LIMIT 1`).get() as any;
    const committed = row ? this.rowToBrew(row) : null;
    if (pending && committed) {
      return new Date(pending.machineTs) > new Date(committed.machineTs) ? pending : committed;
    }
    return pending ?? committed;
  }

  getTodayTotals(localDate: string): Totals {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS cups, COALESCE(SUM(co2_g), 0) AS co2_g
      FROM brews WHERE local_date = ?
    `).get(localDate) as { cups: number; co2_g: number };
    return this.addPendingIfMatches(row, p => p.localDate === localDate);
  }

  getMonthTotals(localMonth: string): Totals {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS cups, COALESCE(SUM(co2_g), 0) AS co2_g
      FROM brews WHERE local_month = ?
    `).get(localMonth) as { cups: number; co2_g: number };
    return this.addPendingIfMatches(row, p => p.localMonth === localMonth);
  }

  private addPendingIfMatches(row: Totals, predicate: (p: PendingBrew) => boolean): Totals {
    const p = this.getPending();
    if (p && predicate(p)) return { cups: row.cups + 1, co2_g: row.co2_g + p.co2G };
    return row;
  }

  setPending(p: PendingBrew): void {
    this.db.prepare(`
      INSERT INTO pending_brew (id, brew_json) VALUES (1, ?)
      ON CONFLICT(id) DO UPDATE SET brew_json = excluded.brew_json
    `).run(JSON.stringify(p));
  }

  getPending(): PendingBrew | null {
    const row = this.db.prepare(`SELECT brew_json FROM pending_brew WHERE id = 1`).get() as { brew_json: string } | undefined;
    return row ? JSON.parse(row.brew_json) as PendingBrew : null;
  }

  clearPending(): void {
    this.db.prepare(`DELETE FROM pending_brew WHERE id = 1`).run();
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare(`
      INSERT INTO meta (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  }

  private rowToBrew(r: any): Brew {
    return {
      id: r.id,
      machineTs: r.machine_ts,
      localDate: r.local_date,
      localMonth: r.local_month,
      drinkType: r.drink_type,
      isDouble: r.is_double as 0 | 1,
      beansG: r.beans_g,
      milkMl: r.milk_ml,
      co2G: r.co2_g,
      splashIds: r.splash_ids ? JSON.parse(r.splash_ids) : [],
      rawJson: r.raw_json,
    };
  }
}
```

- [ ] **Step 4: Run tests, see them pass**

Run: `npm test -- store`
Expected: 12/12 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store.ts test/store.test.ts
git commit -m "feat(store): SQLite schema + brew/pending/meta queries"
```

---

## Task 8: Eversys API client (TDD)

**Files:**
- Create: `src/api.ts`, `test/api.test.ts`, `test/fixtures/products-page.json`, `test/fixtures/counters.json`

- [ ] **Step 1: Create fixtures `test/fixtures/products-page.json`**

```json
[
  {
    "id": 1001,
    "machineTimestamp": "2026-05-20T10:00:00",
    "type": "ESPRESSO",
    "isDouble": 0,
    "milk": { "consumption": 0 }
  },
  {
    "id": 1002,
    "machineTimestamp": "2026-05-20T10:01:30",
    "type": "CAPPUCCINO",
    "isDouble": 0,
    "milk": { "consumption": 120 }
  },
  {
    "id": 1003,
    "machineTimestamp": "2026-05-20T10:02:00",
    "type": "MILK",
    "isDouble": 0,
    "milk": { "consumption": 20 }
  }
]
```

- [ ] **Step 2: Create fixture `test/fixtures/counters.json`**

```json
{
  "machineId": 123,
  "machineTimestamp": "2026-05-20T10:00:00",
  "serverTimestamp": "2026-05-20T08:00:00Z",
  "lastReset": "2026-01-01T00:00:00",
  "beans": { "totalQuantity": 12.345 },
  "water": { "totalQuantity": 456.7 }
}
```

- [ ] **Step 3: Write failing test `test/api.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EversysClient } from "../src/api.ts";

const productsFixture = JSON.parse(readFileSync(join(__dirname, "fixtures/products-page.json"), "utf8"));
const countersFixture = JSON.parse(readFileSync(join(__dirname, "fixtures/counters.json"), "utf8"));

const mkResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("EversysClient", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("fetchBrewsAfter calls correct URL + auth header", async () => {
    const fetchMock = vi.fn(async () => mkResponse(productsFixture));
    const client = new EversysClient({ baseUrl: "https://api.x", token: "tok", machineId: 123, fetchFn: fetchMock });
    const r = await client.fetchBrewsAfter(1000, 100);
    expect(r).toHaveLength(3);
    expect(r[0].id).toBe(1001);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.x/v3/machines/123/products?afterId=1000&sortOrder=ASC&limit=100");
    expect((init as any).headers.Authorization).toBe("Bearer tok");
  });

  it("fetchBrewsAfter without afterId omits the query param", async () => {
    const fetchMock = vi.fn(async () => mkResponse([]));
    const client = new EversysClient({ baseUrl: "https://api.x", token: "tok", machineId: 123, fetchFn: fetchMock });
    await client.fetchBrewsAfter(null, 1);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.x/v3/machines/123/products?sortOrder=DESC&limit=1");
  });

  it("fetchCounters returns parsed counter model", async () => {
    const fetchMock = vi.fn(async () => mkResponse(countersFixture));
    const client = new EversysClient({ baseUrl: "https://api.x", token: "tok", machineId: 123, fetchFn: fetchMock });
    const c = await client.fetchCounters();
    expect(c.beans.totalQuantity).toBeCloseTo(12.345);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.x/v3/machines/machine-counters/123");
  });

  it("throws ApiRateLimitError on 429", async () => {
    const fetchMock = vi.fn(async () => mkResponse({ error: "x" }, 429));
    const client = new EversysClient({ baseUrl: "https://api.x", token: "tok", machineId: 123, fetchFn: fetchMock });
    await expect(client.fetchBrewsAfter(0, 1)).rejects.toMatchObject({ name: "ApiRateLimitError" });
  });

  it("throws ApiError on non-2xx (not 429)", async () => {
    const fetchMock = vi.fn(async () => mkResponse({ error: "x" }, 500));
    const client = new EversysClient({ baseUrl: "https://api.x", token: "tok", machineId: 123, fetchFn: fetchMock });
    await expect(client.fetchBrewsAfter(0, 1)).rejects.toMatchObject({ name: "ApiError", status: 500 });
  });
});
```

- [ ] **Step 4: Run test, see it fail**

Run: `npm test -- api`
Expected: FAIL.

- [ ] **Step 5: Implement `src/api.ts`**

```ts
import type { ProductHistory } from "./types.ts";

export interface EversysClientOpts {
  baseUrl: string;
  token: string;
  machineId: number;
  fetchFn?: typeof fetch;
}

export interface CountersResponse {
  machineId: number;
  machineTimestamp: string;
  serverTimestamp: string;
  lastReset: string;
  beans: { totalQuantity: number };
  water: { totalQuantity: number };
}

export class ApiError extends Error {
  override readonly name = "ApiError";
  constructor(message: string, public readonly status: number) { super(message); }
}

export class ApiRateLimitError extends ApiError {
  override readonly name = "ApiRateLimitError";
  constructor() { super("rate limited", 429); }
}

export class EversysClient {
  private readonly fetchFn: typeof fetch;

  constructor(private readonly opts: EversysClientOpts) {
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  private async req<T>(path: string): Promise<T> {
    const url = `${this.opts.baseUrl}${path}`;
    const r = await this.fetchFn(url, {
      headers: { Authorization: `Bearer ${this.opts.token}` },
    });
    if (r.status === 429) throw new ApiRateLimitError();
    if (!r.ok) throw new ApiError(`HTTP ${r.status} for ${url}`, r.status);
    return r.json() as Promise<T>;
  }

  fetchBrewsAfter(afterId: number | null, limit: number): Promise<ProductHistory[]> {
    if (afterId == null) {
      const qs = new URLSearchParams({ sortOrder: "DESC", limit: String(limit) });
      return this.req(`/v3/machines/${this.opts.machineId}/products?${qs}`);
    }
    const qs = new URLSearchParams({ afterId: String(afterId), sortOrder: "ASC", limit: String(limit) });
    return this.req(`/v3/machines/${this.opts.machineId}/products?${qs}`);
  }

  fetchCounters(): Promise<CountersResponse> {
    return this.req(`/v3/machines/machine-counters/${this.opts.machineId}`);
  }
}
```

- [ ] **Step 6: Run tests, see them pass**

Run: `npm test -- api`
Expected: 5/5 PASS.

- [ ] **Step 7: Commit**

```bash
git add src/api.ts test/api.test.ts test/fixtures/products-page.json test/fixtures/counters.json
git commit -m "feat(api): typed Eversys client with rate-limit error class"
```

---

## Task 9: Poller orchestration (TDD)

The poller wires together API + merge + beans + store, runs the brews loop, and triggers calibration on the counters loop. Tests use a fake clock and a stub API.

**Files:**
- Create: `src/poller.ts`, `test/poller.test.ts`

- [ ] **Step 1: Write failing test `test/poller.test.ts`**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { Store } from "../src/store.ts";
import { Poller } from "../src/poller.ts";
import type { Config } from "../src/config.ts";
import type { EversysClient } from "../src/api.ts";
import type { ProductHistory } from "../src/types.ts";

class FakeApi {
  brewQueue: ProductHistory[][] = [];
  countersResp: any = { beans: { totalQuantity: 0 }, water: { totalQuantity: 0 }, lastReset: "2026-01-01T00:00:00" };
  async fetchBrewsAfter(_after: number | null, _limit: number) {
    return this.brewQueue.shift() ?? [];
  }
  async fetchCounters() { return this.countersResp; }
}

const baseConfig: Config = {
  co2: { beansFactorGPerG: 1.24, milkFactorGPerMl: 1.4, coffeeBaselineG: 8.68 },
  beansDefaultsG: { ESPRESSO: 7, CAPPUCCINO: 7, _default: 7 },
  calibration: { minBrewsBetweenCalibrations: 2, maxScaleDelta: 0.5 },
  polling: { brewsIntervalMs: 5000, countersIntervalMs: 60000, splashWindowMs: 300000, backoffMs: [5000] },
  server: { port: 8080, stateRefreshMs: 3000 },
  api: { baseUrl: "" },
  token: "tok",
  machineId: 123,
};

describe("Poller", () => {
  let s: Store;
  beforeEach(() => { s = new Store(":memory:"); });

  it("bootstrap stores last_seen_id from latest brew on first run", async () => {
    const api = new FakeApi();
    api.brewQueue.push([{ id: 999, machineTimestamp: "2026-05-20T10:00:00", type: "ESPRESSO", isDouble: 0 }]);
    const p = new Poller({ api: api as unknown as EversysClient, store: s, config: baseConfig });
    await p.bootstrap();
    expect(s.getMeta("last_seen_id")).toBe("999");
  });

  it("processes a single espresso brew → pending, no commit yet", async () => {
    const api = new FakeApi();
    api.brewQueue.push([]); // bootstrap returns empty → start at last_seen_id=0
    const p = new Poller({ api: api as unknown as EversysClient, store: s, config: baseConfig });
    await p.bootstrap();
    api.brewQueue.push([{ id: 1, machineTimestamp: "2026-05-20T10:00:00", type: "ESPRESSO", isDouble: 0 }]);
    await p.tickBrews();
    expect(s.getPending()?.id).toBe(1);
    expect(s.getLastBrew()?.id).toBe(1);
  });

  it("espresso + milk splash within 5 min → merged into one pending brew", async () => {
    const api = new FakeApi();
    api.brewQueue.push([]);
    const p = new Poller({ api: api as unknown as EversysClient, store: s, config: baseConfig });
    await p.bootstrap();
    api.brewQueue.push([
      { id: 1, machineTimestamp: "2026-05-20T10:00:00", type: "ESPRESSO", isDouble: 0, milk: { consumption: 0 } },
      { id: 2, machineTimestamp: "2026-05-20T10:02:00", type: "MILK", isDouble: 0, milk: { consumption: 30 } },
    ]);
    await p.tickBrews();
    const pending = s.getPending();
    expect(pending?.id).toBe(1);
    expect(pending?.milkMl).toBe(30);
    expect(pending?.splashIds).toEqual([2]);
  });

  it("computes co2 with config factors", async () => {
    const api = new FakeApi();
    api.brewQueue.push([]);
    const p = new Poller({ api: api as unknown as EversysClient, store: s, config: baseConfig });
    await p.bootstrap();
    api.brewQueue.push([
      { id: 1, machineTimestamp: "2026-05-20T10:00:00", type: "CAPPUCCINO", isDouble: 0, milk: { consumption: 120 } },
    ]);
    await p.tickBrews();
    const last = s.getLastBrew()!;
    // 7g * 1.24 + 120ml * 1.4 = 8.68 + 168 = 176.68
    expect(last.co2G).toBeCloseTo(176.68, 2);
  });

  it("flushes pending when window expires on next tick (no new brews)", async () => {
    const api = new FakeApi();
    api.brewQueue.push([]);
    const p = new Poller({ api: api as unknown as EversysClient, store: s, config: baseConfig });
    await p.bootstrap();
    api.brewQueue.push([{ id: 1, machineTimestamp: "2026-05-20T10:00:00", type: "ESPRESSO", isDouble: 0 }]);
    await p.tickBrews();
    expect(s.getPending()?.id).toBe(1);

    // Simulate later wall-clock by passing a "now" override
    await p.tickBrews(new Date("2026-05-20T10:06:00").getTime());
    expect(s.getPending()).toBeNull();
    expect(s.getLastBrew()?.id).toBe(1); // still queryable as committed
  });

  it("tickCounters updates calibration k after enough brews", async () => {
    const api = new FakeApi();
    api.brewQueue.push([]);
    const p = new Poller({ api: api as unknown as EversysClient, store: s, config: baseConfig });
    await p.bootstrap();
    // Insert 3 brews directly via tickBrews
    api.brewQueue.push([
      { id: 1, machineTimestamp: "2026-05-20T10:00:00", type: "ESPRESSO", isDouble: 0 },
      { id: 2, machineTimestamp: "2026-05-20T10:01:00", type: "ESPRESSO", isDouble: 0 },
      { id: 3, machineTimestamp: "2026-05-20T10:10:00", type: "ESPRESSO", isDouble: 0 }, // flushes pending
    ]);
    await p.tickBrews();
    // anchor at 0kg, now 0.0231kg actual → actualGramsDelta=23.1; summed=21 (3 brews × 7g)
    api.countersResp = { beans: { totalQuantity: 0.0231 }, water: { totalQuantity: 0 }, lastReset: "2026-01-01T00:00:00" };
    await p.tickCounters();
    const k = Number(s.getMeta("beans_calibration_k"));
    expect(k).toBeCloseTo(23.1 / 21, 4);
  });
});
```

- [ ] **Step 2: Run test, see it fail**

Run: `npm test -- poller`
Expected: FAIL.

- [ ] **Step 3: Implement `src/poller.ts`**

```ts
import type { EversysClient } from "./api.ts";
import type { Store } from "./store.ts";
import type { Config } from "./config.ts";
import type { ProductHistory, PendingBrew, Brew } from "./types.ts";
import { mergeStep } from "./merge.ts";
import { defaultBeansG, applyCalibration, recalibrate } from "./beans.ts";
import { co2ForBrew } from "./co2.ts";

export interface PollerOpts {
  api: EversysClient;
  store: Store;
  config: Config;
}

export class Poller {
  private readonly api: EversysClient;
  private readonly store: Store;
  private readonly cfg: Config;

  constructor(opts: PollerOpts) {
    this.api = opts.api;
    this.store = opts.store;
    this.cfg = opts.config;
  }

  async bootstrap(): Promise<void> {
    if (this.store.getMeta("last_seen_id") != null) return;
    const recent = await this.api.fetchBrewsAfter(null, 1);
    const id = recent[0]?.id ?? 0;
    this.store.setMeta("last_seen_id", String(id));
    this.store.setMeta("beans_calibration_k", "1.0");
  }

  async tickBrews(nowMs: number = Date.now()): Promise<void> {
    const lastSeen = Number(this.store.getMeta("last_seen_id") ?? "0");
    const k = Number(this.store.getMeta("beans_calibration_k") ?? "1.0");
    const brews = await this.api.fetchBrewsAfter(lastSeen, 100);

    let pending = this.store.getPending();
    let newLastSeen = lastSeen;

    for (const ph of brews) {
      const r = mergeStep(ph, pending, this.cfg.polling.splashWindowMs, {
        toPending: (raw) => this.toPending(raw, k),
      });
      if (r.commit) this.store.insertBrew(r.commit);
      pending = r.newPending;
      newLastSeen = ph.id;
    }

    // Even if no new brews, expire pending if its window has passed
    if (pending && new Date(pending.expiresAt).getTime() <= nowMs) {
      this.store.insertBrew(pending);
      pending = null;
    }

    if (pending) this.store.setPending(pending);
    else this.store.clearPending();

    if (newLastSeen !== lastSeen) this.store.setMeta("last_seen_id", String(newLastSeen));
    this.store.setMeta("last_poll_ok_at", new Date(nowMs).toISOString());
  }

  async tickCounters(): Promise<void> {
    const c = await this.api.fetchCounters();
    this.store.setMeta("last_counter_check_at", new Date().toISOString());

    const counterKg = c.beans.totalQuantity;
    const anchorKg = Number(this.store.getMeta("beans_calibration_anchor_kg") ?? "");
    const anchorSummed = Number(this.store.getMeta("beans_calibration_anchor_summed_g") ?? "");
    const summedNow = this.summedBeansGSinceEpoch();

    if (!Number.isFinite(anchorKg) || !Number.isFinite(anchorSummed)) {
      // First time — just anchor
      this.store.setMeta("beans_calibration_anchor_kg", String(counterKg));
      this.store.setMeta("beans_calibration_anchor_summed_g", String(summedNow));
      this.store.setMeta("beans_calibration_anchor_brew_count", String(this.brewCountTotal()));
      return;
    }

    const brewsSinceAnchor = this.brewCountTotal() - Number(this.store.getMeta("beans_calibration_anchor_brew_count") ?? "0");
    const summedSinceAnchor = summedNow - anchorSummed;
    const actualGramsDelta = (counterKg - anchorKg) * 1000;
    const currentK = Number(this.store.getMeta("beans_calibration_k") ?? "1.0");

    const newK = recalibrate(
      { brewsSinceAnchor, summedBeansGSinceAnchor: summedSinceAnchor, actualGramsDelta, currentK },
      this.cfg.calibration,
    );

    if (newK != null) {
      this.store.setMeta("beans_calibration_k", String(newK));
      // re-anchor
      this.store.setMeta("beans_calibration_anchor_kg", String(counterKg));
      this.store.setMeta("beans_calibration_anchor_summed_g", String(summedNow));
      this.store.setMeta("beans_calibration_anchor_brew_count", String(this.brewCountTotal()));
    }
  }

  private toPending(ph: ProductHistory, k: number): PendingBrew {
    const machineTs = ph.machineTimestamp;
    const base = defaultBeansG(ph.type, ph.isDouble, this.cfg.beansDefaultsG);
    const beansG = applyCalibration(base, k);
    const milkMl = ph.milk?.consumption ?? 0;
    const co2G = co2ForBrew(beansG, milkMl, this.cfg.co2);
    const expiresAt = new Date(new Date(machineTs).getTime() + this.cfg.polling.splashWindowMs)
      .toISOString().replace(/\.\d+Z$/, "");
    return {
      id: ph.id,
      machineTs,
      localDate: machineTs.slice(0, 10),
      localMonth: machineTs.slice(0, 7),
      drinkType: ph.type,
      isDouble: ph.isDouble,
      beansG,
      milkMl,
      co2G,
      splashIds: [],
      rawJson: JSON.stringify(ph),
      expiresAt,
    };
  }

  private summedBeansGSinceEpoch(): number {
    // Sum of beans_g across all committed brews.
    // (Store doesn't expose this directly; tiny private helper via getMeta surface
    //  would be over-engineering — use a one-off query.)
    const db = (this.store as any).db;
    const r = db.prepare(`SELECT COALESCE(SUM(beans_g), 0) AS total FROM brews`).get();
    return r.total as number;
  }

  private brewCountTotal(): number {
    const db = (this.store as any).db;
    const r = db.prepare(`SELECT COUNT(*) AS n FROM brews`).get();
    return r.n as number;
  }
}
```

- [ ] **Step 4: Run tests, see them pass**

Run: `npm test -- poller`
Expected: 6/6 PASS.

If the calibration test fails, double-check the FakeApi's `countersResp` value matches the expected arithmetic.

- [ ] **Step 5: Commit**

```bash
git add src/poller.ts test/poller.test.ts
git commit -m "feat(poller): brews + counters loops with calibration"
```

---

## Task 10: HTTP server `/api/state` (TDD)

**Files:**
- Create: `src/server.ts`, `test/server.test.ts`

- [ ] **Step 1: Write failing test `test/server.test.ts`**

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Store } from "../src/store.ts";
import { createServer } from "../src/server.ts";
import type { Config } from "../src/config.ts";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

const CFG: Config = {
  co2: { beansFactorGPerG: 1.24, milkFactorGPerMl: 1.4, coffeeBaselineG: 8.68 },
  beansDefaultsG: { ESPRESSO: 7, _default: 7 },
  calibration: { minBrewsBetweenCalibrations: 50, maxScaleDelta: 0.5 },
  polling: { brewsIntervalMs: 5000, countersIntervalMs: 60000, splashWindowMs: 300000, backoffMs: [5000] },
  server: { port: 0, stateRefreshMs: 3000 },
  api: { baseUrl: "" },
  token: "tok",
  machineId: 123,
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
    expect(j.lastBrew).toBeNull();
  });

  it("returns today + last brew shape", async () => {
    s.insertBrew({
      id: 1, machineTs: "2026-05-20T10:00:00",
      localDate: "2026-05-20", localMonth: "2026-05",
      drinkType: "CAPPUCCINO", isDouble: 0,
      beansG: 7, milkMl: 120, co2G: 176.68,
      splashIds: [2], rawJson: "{}",
    });
    s.setMeta("last_poll_ok_at", new Date().toISOString());

    const r = await fetch(`${url}/api/state`);
    const j = await r.json();
    expect(j.lastBrew.type).toBe("CAPPUCCINO");
    expect(j.lastBrew.displayName).toBe("Cappuccino");
    expect(j.lastBrew.splashCount).toBe(1);
    expect(j.lastBrew.deltaVsCoffee).toBeCloseTo(176.68 - 8.68, 2);
    expect(j.stale).toBe(false);
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
      id: 1, machineTs: `${today}T10:00:00`,
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
```

- [ ] **Step 2: Run test, see it fail**

Run: `npm test -- server`
Expected: FAIL.

- [ ] **Step 3: Implement `src/server.ts`**

```ts
import { createServer as nodeCreateServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname, normalize } from "node:path";
import type { Store } from "./store.ts";
import type { Config } from "./config.ts";
import type { ApiState } from "./types.ts";
import { humanizeType, deltaVsCoffee } from "./co2.ts";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js":   "text/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg":  "image/svg+xml",
};

export interface ServerOpts {
  store: Store;
  config: Config;
  publicDir: string;
}

export function createServer(opts: ServerOpts): Server {
  return nodeCreateServer((req, res) => handleRequest(req, res, opts));
}

function handleRequest(req: IncomingMessage, res: ServerResponse, opts: ServerOpts) {
  const url = req.url ?? "/";

  if (url === "/api/state") return sendState(res, opts);
  if (url === "/") return serveStatic(res, opts.publicDir, "index.html");
  if (url.startsWith("/static/")) {
    const rel = url.slice("/static/".length);
    return serveStatic(res, opts.publicDir, rel);
  }
  res.statusCode = 404; res.end("not found");
}

function sendState(res: ServerResponse, opts: ServerOpts) {
  const now = new Date();
  const localDate = now.toISOString().slice(0, 10);
  const localMonth = now.toISOString().slice(0, 7);

  const today = opts.store.getTodayTotals(localDate);
  const month = opts.store.getMonthTotals(localMonth);
  const last = opts.store.getLastBrew();

  const lastPollOkAt = opts.store.getMeta("last_poll_ok_at");
  const stale = lastPollOkAt
    ? (Date.now() - new Date(lastPollOkAt).getTime()) > 60_000
    : false;

  const state: ApiState = {
    today: { cups: today.cups, co2_g: today.co2_g },
    month: { cups: month.cups, co2_g: month.co2_g },
    lastBrew: last ? {
      type: last.drinkType,
      displayName: humanizeType(last.drinkType),
      machineTs: last.machineTs,
      beansG: last.beansG,
      milkMl: last.milkMl,
      co2G: last.co2G,
      splashCount: last.splashIds.length,
      deltaVsCoffee: deltaVsCoffee(last.co2G, opts.config.co2),
    } : null,
    stale,
    lastPollOkAt,
  };
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(state));
}

function serveStatic(res: ServerResponse, publicDir: string, rel: string) {
  if (!publicDir) { res.statusCode = 404; res.end("not found"); return; }
  const safe = normalize(rel).replace(/^([./\\])+/, "");
  const full = join(publicDir, safe);
  if (!full.startsWith(publicDir) || !existsSync(full)) {
    res.statusCode = 404; res.end("not found"); return;
  }
  const mime = MIME[extname(full)] ?? "application/octet-stream";
  res.setHeader("Content-Type", mime);
  res.end(readFileSync(full));
}
```

- [ ] **Step 4: Run tests, see them pass**

Run: `npm test -- server`
Expected: 4/4 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts test/server.test.ts
git commit -m "feat(server): /api/state + static file handler"
```

---

## Task 11: Frontend (manual verification)

**Files:**
- Create: `public/index.html`, `public/style.css`, `public/app.js`

- [ ] **Step 1: Create `public/index.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Kaffe-skam</title>
  <link rel="stylesheet" href="/static/style.css">
</head>
<body>
  <main class="landscape" id="root">
    <section class="pane left">
      <div class="label">Today's coffee CO₂eq</div>
      <div class="hero" id="today-co2">—</div>
      <div class="sub" id="today-equiv">&nbsp;</div>
      <div class="meta">
        <div><div class="label">Cups</div><div class="n" id="today-cups">—</div></div>
        <div><div class="label">This month</div><div class="n" id="month-co2">—</div></div>
      </div>
    </section>
    <div class="divider"></div>
    <section class="pane right" id="last-brew-pane">
      <div class="label" id="last-label">Last brew</div>
      <div class="drink-name" id="drink-name">—</div>
      <div class="composition" id="composition">&nbsp;</div>
      <div class="delta-row">
        <div class="delta" id="delta">—</div>
        <div class="vs" id="vs">&nbsp;</div>
      </div>
      <div class="bar-comparison">
        <div class="bc-row">
          <div class="bc-name">Coffee</div>
          <div class="bc-barwrap"><div class="bc-barfill" id="coffee-bar"></div></div>
          <div class="bc-v" id="coffee-v">—</div>
        </div>
        <div class="bc-row current">
          <div class="bc-name">This brew</div>
          <div class="bc-barwrap"><div class="bc-barfill" id="brew-bar"></div></div>
          <div class="bc-v" id="brew-v">—</div>
        </div>
      </div>
      <div class="stale-badge" id="stale-badge" hidden>data stale</div>
    </section>
  </main>
  <script src="/static/app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create `public/style.css`**

```css
:root {
  --bg: #1c1c1f;
  --fg: #e8e6df;
  --muted: #888;
  --divider: #333;
  --accent: #d2a96c;
  --up: #e88a5c;
  --down: #93c47d;
  --bar-bg: #2a2a2d;
  --bar-default: #555;
}

* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; height: 100%; background: var(--bg); color: var(--fg);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }

.landscape {
  height: 100vh;
  padding: 4vh 4vw;
  display: grid;
  grid-template-columns: 1fr 1px 1.2fr;
  gap: 4vw;
}
.divider { background: var(--divider); }

.pane { display: flex; flex-direction: column; gap: 1.5vh; }
.label { font-size: 1.4vh; letter-spacing: 0.14em; text-transform: uppercase; color: var(--muted); }

.left .hero { font-size: 16vh; font-weight: 700; line-height: 1; letter-spacing: -0.04em; color: var(--accent); }
.left .sub  { font-size: 2.2vh; color: #b0aea9; }
.left .meta { margin-top: auto; display: flex; gap: 4vw; }
.left .meta .n { font-size: 4vh; font-weight: 600; }

.right .drink-name { font-size: 6vh; font-weight: 600; letter-spacing: -0.02em; }
.right .composition { color: #b0aea9; font-size: 1.8vh; }
.right .delta-row { display: flex; align-items: baseline; gap: 1.4vw; margin-top: 1vh; }
.right .delta { font-size: 8vh; font-weight: 700; }
.right .delta.up   { color: var(--up); }
.right .delta.down { color: var(--down); }
.right .vs { font-size: 1.8vh; color: var(--muted); }

.bar-comparison { margin-top: auto; display: flex; flex-direction: column; gap: 1.4vh; }
.bc-row { display: grid; grid-template-columns: 12vw 1fr 8vw; align-items: center; gap: 1.5vw; font-size: 1.8vh; color: #b0aea9; }
.bc-barwrap { height: 1.6vh; background: var(--bar-bg); border-radius: 0.8vh; overflow: hidden; }
.bc-barfill { height: 100%; background: var(--bar-default); transition: width 600ms ease; }
.bc-row.current .bc-barfill { background: var(--accent); }
.bc-v { text-align: right; }

.stale-badge {
  position: absolute; top: 2vh; right: 3vw;
  background: #5c1f1f; color: #fff;
  padding: 0.6vh 1vw; border-radius: 0.8vh;
  font-size: 1.4vh; letter-spacing: 0.05em; text-transform: uppercase;
}
```

- [ ] **Step 3: Create `public/app.js`**

```js
const $ = (id) => document.getElementById(id);
const REFRESH_MS = 3000;

function fmtG(g) {
  if (g == null) return "—";
  if (g >= 1000) return (g / 1000).toFixed(1) + " kg";
  return Math.round(g) + " g";
}
function fmtDriveKm(co2_g) {
  // Rough: 200 g CO2eq per km driven (European average car)
  const km = co2_g / 200;
  return km >= 0.1 ? `≈ ${km.toFixed(1)} km drive` : "≈ tiny drive";
}

async function refresh() {
  try {
    const r = await fetch("/api/state", { cache: "no-store" });
    if (!r.ok) throw new Error("status " + r.status);
    const s = await r.json();
    render(s);
  } catch (e) {
    // keep last render; flag staleness
    $("stale-badge").hidden = false;
  }
}

function render(s) {
  $("today-co2").textContent = fmtG(s.today.co2_g);
  $("today-equiv").textContent = fmtDriveKm(s.today.co2_g);
  $("today-cups").textContent = s.today.cups;
  $("month-co2").textContent = fmtG(s.month.co2_g);

  $("stale-badge").hidden = !s.stale;

  if (!s.lastBrew) {
    $("drink-name").textContent = "Waiting for first brew…";
    $("composition").innerHTML = "&nbsp;";
    $("delta").textContent = "—";
    $("vs").textContent = "";
    $("coffee-bar").style.width = "0%";
    $("brew-bar").style.width = "0%";
    $("coffee-v").textContent = "—";
    $("brew-v").textContent = "—";
    return;
  }

  const b = s.lastBrew;
  const ts = b.machineTs.replace("T", " ").slice(0, 16);
  $("last-label").textContent = "Last brew · " + ts;
  $("drink-name").textContent = b.displayName;
  const parts = [`${b.beansG.toFixed(1)} g beans`];
  if (b.milkMl > 0) parts.push(`${Math.round(b.milkMl)} ml milk`);
  if (b.splashCount > 0) parts.push(`+${b.splashCount} splash`);
  $("composition").textContent = parts.join(" · ");

  const d = b.deltaVsCoffee;
  $("delta").textContent = (d >= 0 ? "+" : "") + fmtG(Math.abs(d));
  $("delta").classList.toggle("up", d >= 0);
  $("delta").classList.toggle("down", d < 0);

  const baseline = b.co2G - d;        // = coffee baseline grams
  $("coffee-v").textContent = fmtG(baseline);
  $("brew-v").textContent   = fmtG(b.co2G);
  const max = Math.max(baseline, b.co2G, 1);
  $("coffee-bar").style.width = `${(baseline / max) * 100}%`;
  $("brew-bar").style.width   = `${(b.co2G / max) * 100}%`;

  $("vs").textContent = `vs plain Coffee (${fmtG(baseline)})`;
}

refresh();
setInterval(refresh, REFRESH_MS);
```

- [ ] **Step 4: Manual smoke test (no automation)**

In one terminal: `npm run dev`
In another terminal: `curl -s localhost:8080/api/state | head`
Expected: JSON with `today.cups: 0`, `lastBrew: null` (or whatever state the DB has).

Open `http://localhost:8080/` in a browser.
Expected: landscape split renders, "Waiting for first brew…" in right pane.

(Skip the live API call for now — `npm run dev` will need real credentials and will fail to reach Eversys; that's fine — frontend should still render with empty state.)

- [ ] **Step 5: Commit**

```bash
git add public/
git commit -m "feat(frontend): landscape dashboard, polls /api/state every 3s"
```

---

## Task 12: Entrypoint + lifecycle (`index.ts`)

**Files:**
- Create: `src/index.ts`

- [ ] **Step 1: Write `src/index.ts`**

```ts
import { loadConfig } from "./config.ts";
import { Store } from "./store.ts";
import { EversysClient, ApiError, ApiRateLimitError } from "./api.ts";
import { Poller } from "./poller.ts";
import { createServer } from "./server.ts";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

async function main() {
  const cfg = loadConfig(ROOT);
  mkdirSync(join(ROOT, "data"), { recursive: true });

  const store = new Store(join(ROOT, "data", "kaffe.sqlite"));
  const api = new EversysClient({
    baseUrl: cfg.api.baseUrl, token: cfg.token, machineId: cfg.machineId,
  });
  const poller = new Poller({ api, store, config: cfg });
  const server = createServer({ store, config: cfg, publicDir: join(ROOT, "public") });

  await poller.bootstrap();

  let backoffIdx = 0;
  const runBrewLoop = async () => {
    try {
      await poller.tickBrews();
      backoffIdx = 0;
    } catch (e: unknown) {
      if (e instanceof ApiRateLimitError || e instanceof ApiError) {
        backoffIdx = Math.min(backoffIdx + 1, cfg.polling.backoffMs.length - 1);
        console.warn(`api error (${e.message}), backing off to ${cfg.polling.backoffMs[backoffIdx]}ms`);
      } else {
        console.error("poller.tickBrews failed:", e);
      }
    }
    const wait = backoffIdx > 0 ? cfg.polling.backoffMs[backoffIdx]! : cfg.polling.brewsIntervalMs;
    setTimeout(runBrewLoop, wait);
  };

  const runCountersLoop = async () => {
    try { await poller.tickCounters(); }
    catch (e) { console.warn("poller.tickCounters failed:", e); }
    setTimeout(runCountersLoop, cfg.polling.countersIntervalMs);
  };

  runBrewLoop();
  runCountersLoop();

  server.listen(cfg.server.port, () => {
    console.log(`kaffe-skam listening on http://0.0.0.0:${cfg.server.port}`);
  });

  process.on("SIGTERM", () => { server.close(); store.close(); process.exit(0); });
  process.on("SIGINT",  () => { server.close(); store.close(); process.exit(0); });
}

main().catch(e => {
  console.error("fatal:", e);
  process.exit(1);
});
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Smoke test (no real API)**

Temporarily set `.machine_id` to `0` and `.token` to `dummy` IF needed — but if the user's real ones are present, just run it.

Run: `npm run dev`
Expected:
- Console: "kaffe-skam listening on http://0.0.0.0:8080"
- API errors logged each 5s (backoff) — that's fine, we don't have a real connection to verify in CI.
- `curl http://localhost:8080/api/state` returns valid JSON.
- Stop with Ctrl-C; clean shutdown.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat(index): entrypoint, lifecycle, brew+counters loops with backoff"
```

---

## Task 13: README + systemd unit

**Files:**
- Create: `README.md`, `systemd/kaffe-skam.service`

- [ ] **Step 1: Write `README.md`**

````markdown
# kaffe-skam

CO2 dashboard for the Os & Data office coffee machine. Polls the Eversys
Telemetry API, estimates per-brew CO2 from real ingredient data, and serves
a landscape dashboard at `:8080/`.

## Prerequisites

- Node.js ≥ 20
- An Eversys API token + machine id in `.token` and `.machine_id` (not committed)

## Install

```bash
npm install
```

## Configure

Edit `config.json` for CO2 factors, polling intervals, etc.
See `docs/superpowers/specs/2026-05-20-kaffe-co2-dashboard-design.md` for details.

## Run (dev)

```bash
npm run dev
```

## Run (production on a Pi)

```bash
sudo cp systemd/kaffe-skam.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now kaffe-skam
sudo journalctl -fu kaffe-skam
```

## Tests

```bash
npm test
```

## Endpoints

- `GET /` — dashboard
- `GET /api/state` — JSON state (also the contract for the future ESP32 client)

## Architecture

See [docs/superpowers/specs/2026-05-20-kaffe-co2-dashboard-design.md](docs/superpowers/specs/2026-05-20-kaffe-co2-dashboard-design.md).
````

- [ ] **Step 2: Write `systemd/kaffe-skam.service`**

```ini
[Unit]
Description=Kaffe-skam coffee CO2 dashboard
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/kaffe-skam
ExecStart=/usr/bin/node --import tsx/esm src/index.ts
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
User=kaffe
Group=kaffe
# Hardening
NoNewPrivileges=yes
ProtectSystem=strict
ReadWritePaths=/opt/kaffe-skam/data
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 3: Commit**

```bash
git add README.md systemd/
git commit -m "docs: README + systemd unit"
```

---

## Self-review (done after writing)

- Spec coverage: every spec section ↔ task table

  | Spec section | Implementing task(s) |
  |---|---|
  | Purpose / Scope | Whole plan |
  | CO2 model + beans estimation | T4 (co2), T5 (beans) |
  | Architecture | T9 + T10 + T12 |
  | Modules (poller / merge / store / co2 / server / config / index) | T3, T4, T5, T6, T7, T8, T9, T10, T12 |
  | API contract `/api/state` | T10 |
  | Data flow (bootstrap, steady state, calibration loop) | T9 |
  | Frontend layout | T11 |
  | Error handling | T8 (api errors), T12 (backoff + crash-restart) |
  | Testing | T3–T10 |
  | Repo layout | T1 |
  | Configuration | T1 (config.json), T3 (loader) |
  | ESP32 path (informational) | covered by T10 contract |
  | systemd | T13 |
- Placeholder scan: no "TBD" / "implement later" / "add appropriate" in this doc.
- Type consistency: `Brew`, `PendingBrew`, `ApiState`, `Config`, `Store`, `EversysClient`, `Poller` — names match throughout.
- One known sharp edge: the poller reaches into `(store as any).db` for two sum/count queries (`summedBeansGSinceEpoch`, `brewCountTotal`). Acceptable for a prototype; if we later want a cleaner boundary, add explicit methods to `Store`.
