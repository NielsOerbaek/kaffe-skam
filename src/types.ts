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
  id: number;             // Eversys id of the primary brew (unique within one machine)
  machineId: number;      // which machine produced this brew
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
  displayName: string;
  floor: string;          // human label from config (e.g., "2. sal")
  machineTs: string;
  beansG: number;
  milkMl: number;
  co2G: number;
  splashCount: number;
  deltaVsCoffee: number;
}

// /api/state JSON shape.
export interface ApiState {
  today:   { cups: number; co2_g: number };
  month:   { cups: number; co2_g: number };
  lastBrews: BrewView[]; // up to 3, newest first; empty array if none
  stale: boolean;
  lastPollOkAt: string | null;
}
