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
