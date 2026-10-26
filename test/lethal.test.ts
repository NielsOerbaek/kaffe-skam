import { describe, it, expect } from "vitest";
import { airVolumeM3, lethalDoseG, lethalFill, daysToNextFill } from "../src/lethal.ts";
import type { BuildingConfig } from "../src/config.ts";

// Thoravej 29 as configured: 4515 m² × 2.8 m, 10 % CO₂ counted as lethal.
const T29: BuildingConfig = {
  label: "Thoravej 29",
  floorAreaM2: 4515,
  ceilingHeightM: 2.8,
  lethalFractionCo2: 0.10,
  ambientFractionCo2: 0.00042,
  co2DensityKgPerM3: 1.83,
};

describe("airVolumeM3", () => {
  it("is floor area × ceiling height", () => {
    expect(airVolumeM3(T29)).toBeCloseTo(12642, 0);
  });
});

describe("lethalDoseG", () => {
  it("computes ~2.3 tonnes for Thoravej 29 at 10 % CO₂", () => {
    const t = lethalDoseG(T29) / 1_000_000;
    expect(t).toBeGreaterThan(2.25);
    expect(t).toBeLessThan(2.35);
  });

  it("scales with the threshold — 4 % (NIOSH IDLH) is ~0.9 t", () => {
    const t = lethalDoseG({ ...T29, lethalFractionCo2: 0.04 }) / 1_000_000;
    expect(t).toBeCloseTo(0.92, 1);
  });

  it("subtracts the ambient background", () => {
    const withAmbient = lethalDoseG(T29);
    const withoutAmbient = lethalDoseG({ ...T29, ambientFractionCo2: 0 });
    expect(withAmbient).toBeLessThan(withoutAmbient);
  });

  it("returns 0 when the threshold is at or below ambient", () => {
    expect(lethalDoseG({ ...T29, lethalFractionCo2: 0.00042 })).toBe(0);
    expect(lethalDoseG({ ...T29, lethalFractionCo2: 0.0001 })).toBe(0);
  });
});

describe("lethalFill", () => {
  const dose = lethalDoseG(T29);

  it("reports no fills and no progress at zero CO₂", () => {
    const f = lethalFill(0, T29);
    expect(f.fillsCompleted).toBe(0);
    expect(f.progress).toBe(0);
    expect(f.doseG).toBeCloseTo(dose, 6);
  });

  it("is half way through the first fill at half a dose", () => {
    const f = lethalFill(dose / 2, T29);
    expect(f.fillsCompleted).toBe(0);
    expect(f.progress).toBeCloseTo(0.5, 6);
  });

  it("laps: one completed fill and a quarter into the next", () => {
    const f = lethalFill(dose * 1.25, T29);
    expect(f.fillsCompleted).toBe(1);
    expect(f.progress).toBeCloseTo(0.25, 6);
  });

  it("resets progress to 0 exactly on a whole fill", () => {
    const f = lethalFill(dose * 2, T29);
    expect(f.fillsCompleted).toBe(2);
    expect(f.progress).toBeCloseTo(0, 6);
  });

  it("degrades safely on a zero dose and on negative CO₂", () => {
    const broken = lethalFill(5_000_000, { ...T29, lethalFractionCo2: 0.0001 });
    expect(broken.doseG).toBe(0);
    expect(broken.fillsCompleted).toBe(0);
    expect(broken.progress).toBe(0);
    expect(lethalFill(-1, T29).progress).toBe(0);
  });
});

describe("daysToNextFill", () => {
  it("extrapolates the remainder at the given daily rate", () => {
    const fill = lethalFill(lethalDoseG(T29) * 1.5, T29); // half a dose to go
    const perDay = lethalDoseG(T29) / 100;                 // a full dose per 100 days
    expect(daysToNextFill(fill, perDay)).toBeCloseTo(50, 6);
  });

  it("is null without a rate", () => {
    const fill = lethalFill(1000, T29);
    expect(daysToNextFill(fill, 0)).toBeNull();
    expect(daysToNextFill(fill, -5)).toBeNull();
  });

  it("is null when there is no dose to reach", () => {
    const fill = lethalFill(1000, { ...T29, lethalFractionCo2: 0.0001 });
    expect(daysToNextFill(fill, 1000)).toBeNull();
  });
});
