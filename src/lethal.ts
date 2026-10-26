// "Dødelig dosis" — the thought experiment behind the progress bar on the
// live page: how much CO₂ would it take to make the air in the building
// unbreathable, and how far into the current fill is this year's coffee?
//
// This is deliberately a *hypothetical*. The CO₂ we count is lifecycle
// CO₂eq — emitted on farms, in trucks and by cows, almost none of it inside
// Thoravej 29 — and the building is ventilated, so nothing accumulates.
// The bar converts an abstract tonnage into a room-sized unit; /metode says
// so in plain words.
import type { BuildingConfig } from "./config.ts";

export interface LethalFill {
  volumeM3: number;      // sealed air volume of the building
  doseG: number;         // grams of CO₂ to take that volume from ambient to the lethal fraction
  fillsCompleted: number; // whole buildings filled within the window
  progress: number;       // 0..1 into the current (unfinished) fill
}

// Floor area × ceiling height. Crude on purpose: interior walls, shafts and
// furniture all shave a few percent off, and a few percent does not change
// the story.
export function airVolumeM3(b: BuildingConfig): number {
  return Math.max(0, b.floorAreaM2 * b.ceilingHeightM);
}

// Mass of CO₂ needed to raise a sealed volume from the ambient fraction to
// the lethal fraction:  V × Δfraction × ρ(CO₂).
export function lethalDoseG(b: BuildingConfig): number {
  const delta = b.lethalFractionCo2 - b.ambientFractionCo2;
  if (delta <= 0) return 0;
  return airVolumeM3(b) * delta * b.co2DensityKgPerM3 * 1000;
}

// Split a window's CO₂ into whole buildings filled + progress into the next.
export function lethalFill(co2G: number, b: BuildingConfig): LethalFill {
  const doseG = lethalDoseG(b);
  const volumeM3 = airVolumeM3(b);
  if (doseG <= 0 || !Number.isFinite(co2G) || co2G <= 0) {
    return { volumeM3, doseG, fillsCompleted: 0, progress: 0 };
  }
  const fills = co2G / doseG;
  return {
    volumeM3,
    doseG,
    fillsCompleted: Math.floor(fills),
    progress: fills - Math.floor(fills),
  };
}

// Days until the current fill completes, at the window's average daily rate.
// null when there's no rate to extrapolate from.
export function daysToNextFill(fill: LethalFill, gPerDay: number): number | null {
  if (!(gPerDay > 0) || fill.doseG <= 0) return null;
  return (fill.doseG * (1 - fill.progress)) / gPerDay;
}
