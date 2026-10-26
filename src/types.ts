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
  keyId?: number | null;    // product/button id on the machine; maps to ProductParameters.productId
  milk?: { consumption?: number } | null; // ml
  // raw_json keeps the full payload; this is just what merge/co2 use
}

// What we commit to the brews table.
export interface Brew {
  id: number;             // Eversys id of the primary brew (unique within one machine)
  machineId: number;      // which machine produced this brew
  productKey: number | null; // machine's button/product id; resolves to a human name via the products table
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

// Per-brew view used in /api/state. Includes the friendly floor label.
export interface BrewView {
  type: DrinkType;
  displayName: string;    // resolved from the products table when available, else humanizeType
  productName: string | null; // resolved from products table; null if unknown
  floor: string;          // human label from config (e.g., "2. sal")
  machineTs: string;
  beansG: number;
  milkMl: number;
  co2G: number;
  splashCount: number;
  deltaVsCoffee: number;
}

// The "dødelig dosis" block in /api/state — how far this calendar year's
// coffee has gone toward filling the building with unbreathable air.
// Hypothetical by construction; see src/lethal.ts.
export interface LethalView {
  label: string;                 // building label, e.g. "Thoravej 29"
  window: string;                // the window being counted, e.g. "2026"
  co2_g: number;                 // CO₂ in that window
  volumeM3: number;              // sealed air volume
  fractionCo2: number;           // concentration counted as lethal (0.10 = 10 %)
  doseG: number;                 // CO₂ needed for one full fill
  fillsCompleted: number;        // whole fills so far this window
  progress: number;              // 0..1 into the current fill
  gPerDay: number;               // average daily rate across the window so far
  daysToNextFill: number | null; // at that rate; null when there is no rate
}

// /api/state JSON shape.
export interface ApiState {
  locationName: string;
  today:   { cups: number; co2_g: number };
  month:   { cups: number; co2_g: number };
  rolling30d:  { cups: number; co2_g: number }; // last 30 days (rolling)
  rolling365d: { cups: number; co2_g: number }; // last 365 days (rolling)
  year:    { year: number; cups: number; co2_g: number }; // calendar year to date
  lethal: LethalView;
  baselineG: number;        // current calibrated CO₂ for one plain Coffee
  lastBrews: BrewView[]; // up to 3, newest first; empty array if none
  stale: boolean;
  lastPollOkAt: string | null;
}
