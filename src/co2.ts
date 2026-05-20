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
