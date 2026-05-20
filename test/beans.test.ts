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
      summedBeansGSinceAnchor: 420,
      actualGramsDelta: 462,
      currentK: 1.0,
    }, cfg);
    expect(r).toBeCloseTo(1.1, 4);
  });

  it("clamps to maxScaleDelta", () => {
    const r = recalibrate({
      brewsSinceAnchor: 60,
      summedBeansGSinceAnchor: 100,
      actualGramsDelta: 1000,
      currentK: 1.0,
    }, cfg);
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
