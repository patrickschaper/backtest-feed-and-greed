import { describe, expect, it } from "vitest";
import { convertSeriesToBase, normalizeCurrency } from "../src/data/fxProvider.js";
import type { DailyPricePoint } from "../src/types.js";

describe("normalizeCurrency", () => {
  it("returns a plain 3-letter major code with scale 1", () => {
    expect(normalizeCurrency("USD")).toEqual({ code: "USD", scale: 1 });
    expect(normalizeCurrency("eur")).toEqual({ code: "EUR", scale: 1 });
    expect(normalizeCurrency(" gbp ")).toEqual({ code: "GBP", scale: 1 });
  });

  it("maps pence (GBp/GBX) to GBP with scale 100", () => {
    expect(normalizeCurrency("GBp")).toEqual({ code: "GBP", scale: 100 });
    expect(normalizeCurrency("GBX")).toEqual({ code: "GBP", scale: 100 });
  });

  it("maps other known minor units to their major code with scale 100", () => {
    expect(normalizeCurrency("ZAc")).toEqual({ code: "ZAR", scale: 100 });
    expect(normalizeCurrency("ILa")).toEqual({ code: "ILS", scale: 100 });
  });

  it("returns undefined for missing or unusable codes", () => {
    expect(normalizeCurrency(undefined)).toBeUndefined();
    expect(normalizeCurrency("")).toBeUndefined();
    expect(normalizeCurrency("—")).toBeUndefined();
    expect(normalizeCurrency("US")).toBeUndefined();
    expect(normalizeCurrency("DOLLAR")).toBeUndefined();
  });
});

describe("convertSeriesToBase", () => {
  const prices: DailyPricePoint[] = [
    { date: "2024-01-02", close: 100 },
    { date: "2024-01-03", close: 110 },
    { date: "2024-01-04", close: 120 }
  ];

  it("returns prices unchanged when no FX and scale 1 (same currency)", () => {
    expect(convertSeriesToBase(prices, null, 1)).toEqual(prices);
  });

  it("applies a daily FX rate (base per native)", () => {
    const fx: DailyPricePoint[] = [
      { date: "2024-01-02", close: 0.9 },
      { date: "2024-01-03", close: 0.8 },
      { date: "2024-01-04", close: 0.85 }
    ];
    expect(convertSeriesToBase(prices, fx, 1)).toEqual([
      { date: "2024-01-02", close: 90 },
      { date: "2024-01-03", close: 88 },
      { date: "2024-01-04", close: 102 }
    ]);
  });

  it("forward-fills the most recent rate on/before each date", () => {
    const fx: DailyPricePoint[] = [
      { date: "2024-01-01", close: 0.5 },
      { date: "2024-01-03", close: 0.6 }
    ];
    // 01-02 has no exact rate -> uses 01-01 (0.5); 01-04 -> uses 01-03 (0.6)
    expect(convertSeriesToBase(prices, fx, 1)).toEqual([
      { date: "2024-01-02", close: 50 },
      { date: "2024-01-03", close: 66 },
      { date: "2024-01-04", close: 72 }
    ]);
  });

  it("drops leading points with no prior FX rate (no future backfill)", () => {
    const fx: DailyPricePoint[] = [{ date: "2024-01-03", close: 0.7 }];
    // 01-02 has no rate on/before it and is dropped; later points use 0.7
    expect(convertSeriesToBase(prices, fx, 1)).toEqual([
      { date: "2024-01-03", close: 77 },
      { date: "2024-01-04", close: 84 }
    ]);
  });

  it("divides by scale for minor units before applying FX", () => {
    // pence: scale 100, rate 1.2 (GBP->base) => (100/100)*1.2 = 1.2
    const fx: DailyPricePoint[] = [
      { date: "2024-01-02", close: 1.2 },
      { date: "2024-01-03", close: 1.2 },
      { date: "2024-01-04", close: 1.2 }
    ];
    expect(convertSeriesToBase(prices, fx, 100)).toEqual([
      { date: "2024-01-02", close: 1.2 },
      { date: "2024-01-03", close: 1.32 },
      { date: "2024-01-04", close: 1.44 }
    ]);
  });

  it("applies scale even when FX is null (minor unit, same major currency as base)", () => {
    expect(convertSeriesToBase(prices, null, 100)).toEqual([
      { date: "2024-01-02", close: 1 },
      { date: "2024-01-03", close: 1.1 },
      { date: "2024-01-04", close: 1.2 }
    ]);
  });
});
