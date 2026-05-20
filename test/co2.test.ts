import { describe, it, expect } from "vitest";
import { co2ForBrew, humanizeType, deltaVsCoffee } from "../src/co2.ts";

const C = {
  beansFactorGPerG: 1.24,
  milkFactorGPerMl: 1.4,
  coffeeBaselineG: 8.68,
};

describe("co2ForBrew", () => {
  it("computes beans + milk only (no water/electricity)", () => {
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
