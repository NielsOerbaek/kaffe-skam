import type { DrinkType } from "./types.ts";

export type BeansDefaults = Record<string, number>;

export function defaultBeansG(type: DrinkType, isDouble: 0 | 1, defaults: BeansDefaults): number {
  const base = defaults[type] ?? defaults._default ?? 7;
  return isDouble === 1 ? base * 2 : base;
}

// Primary lookup: by machine product name (e.g. "Dbl. Latte" → 14 g).
// Falls back to the API drink_type table when no product name match.
// Product names like "Dbl. Cortado" / "2× Cortado" already encode doubling,
// so we don't multiply by 2 again on isDouble.
export function beansGForBrew(opts: {
  productName: string | null;
  type: DrinkType;
  isDouble: 0 | 1;
  byProduct: BeansDefaults;
  byType: BeansDefaults;
}): number {
  if (opts.productName && opts.byProduct[opts.productName] != null) {
    return opts.byProduct[opts.productName]!;
  }
  return defaultBeansG(opts.type, opts.isDouble, opts.byType);
}

export function applyCalibration(beansG: number, k: number): number {
  return beansG * k;
}

export interface CalibrationInput {
  brewsSinceAnchor: number;
  summedBeansGSinceAnchor: number;
  actualGramsDelta: number;
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
  const target = input.currentK * rawScale;

  const min = input.currentK - cfg.maxScaleDelta;
  const max = input.currentK + cfg.maxScaleDelta;
  return Math.max(min, Math.min(max, target));
}
