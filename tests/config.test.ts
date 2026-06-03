import { describe, expect, it } from "vitest";
import { parseCliConfig } from "../src/config.js";

describe("parseCliConfig", () => {
  const referenceDate = new Date("2026-03-31T12:00:00Z");
  const parse = (argv: string[]) => parseCliConfig(argv, referenceDate);

  it("defaults to 1 year and threshold defaults", () => {
    const config = parse(["node", "cli"]);
    expect(config.periodDays).toBe(365);
    expect(config.buyThresholds).toEqual([55]);
    expect(config.sellThresholds).toEqual([45]);
  });

  it("parses a single threshold value", () => {
    const config = parse(["node", "cli", "--buy-threshold", "40", "--sell-threshold", "60"]);
    expect(config.buyThresholds).toEqual([40]);
    expect(config.sellThresholds).toEqual([60]);
  });

  it("parses comma-separated buy thresholds", () => {
    const config = parse(["node", "cli", "--buy-threshold", "30,45,55"]);
    expect(config.buyThresholds).toEqual([30, 45, 55]);
  });

  it("parses comma-separated sell thresholds", () => {
    const config = parse(["node", "cli", "--sell-threshold", "70,60,50"]);
    expect(config.sellThresholds).toEqual([70, 60, 50]);
  });

  it("rejects out-of-range buy threshold", () => {
    expect(() => parse(["node", "cli", "--buy-threshold", "101"])).toThrow(
      "--buy-threshold values must be between 0 and 100"
    );
  });

  it("rejects out-of-range sell threshold in multi-value list", () => {
    expect(() => parse(["node", "cli", "--sell-threshold", "50,-5"])).toThrow(
      "--sell-threshold values must be between 0 and 100"
    );
  });

  it("switches to symbols mode when symbols is provided", () => {
    const config = parse(["node", "cli", "--symbols", "aapl"]);
    expect(config.mode).toBe("symbols");
    expect(config.symbols).toEqual(["AAPL"]);
  });

  it("parses comma-separated symbols", () => {
    const config = parse(["node", "cli", "--symbols", "aapl,msft,tsla"]);
    expect(config.mode).toBe("symbols");
    expect(config.symbols).toEqual(["AAPL", "MSFT", "TSLA"]);
  });

  it("trims whitespace in symbol list", () => {
    const config = parse(["node", "cli", "--symbols", " aapl , msft "]);
    expect(config.symbols).toEqual(["AAPL", "MSFT"]);
  });

  it("parses verbose flag", () => {
    const config = parse(["node", "cli", "--verbose"]);
    expect(config.verbose).toBe(true);
  });

  it("defaults verbose to false", () => {
    const config = parse(["node", "cli"]);
    expect(config.verbose).toBe(false);
  });

  it("parses short verbose flag -v", () => {
    const config = parse(["node", "cli", "-v"]);
    expect(config.verbose).toBe(true);
  });

  it("defaults price provider to hybrid", () => {
    const config = parse(["node", "cli"]);
    expect(config.priceProvider).toBe("hybrid");
  });

  it("accepts price provider option", () => {
    const config = parse(["node", "cli", "--price-provider", "yahoo"]);
    expect(config.priceProvider).toBe("yahoo");
  });

  it("rejects invalid price provider", () => {
    expect(() => parse(["node", "cli", "--price-provider", "invalid"])).toThrow(
      "--price-provider must be one of: yahoo, tradingview, hybrid"
    );
  });

  it("accepts all valid price providers", () => {
    for (const provider of ["yahoo", "tradingview", "hybrid"]) {
      const config = parse(["node", "cli", "--price-provider", provider]);
      expect(config.priceProvider).toBe(provider);
    }
  });

  it("defaults optimizer strategy to greedy", () => {
    const config = parse(["node", "cli"]);
    expect(config.optimizerStrategy).toBe("greedy");
  });

  it("accepts all valid optimizer strategies", () => {
    for (const strategy of ["greedy", "coarse", "single-expand", "full"]) {
      const config = parse(["node", "cli", "--optimizer-strategy", strategy]);
      expect(config.optimizerStrategy).toBe(strategy);
    }
  });

  it("rejects invalid optimizer strategy", () => {
    expect(() => parse(["node", "cli", "--optimizer-strategy", "bogus"])).toThrow(
      "--optimizer-strategy must be one of: greedy, coarse, single-expand, full"
    );
  });

  it("defaults max thresholds to 2", () => {
    const config = parse(["node", "cli"]);
    expect(config.maxThresholds).toBe(2);
  });

  it("accepts max thresholds of 1, 2 and 3", () => {
    expect(parse(["node", "cli", "--max-thresholds", "1"]).maxThresholds).toBe(1);
    expect(parse(["node", "cli", "--max-thresholds", "2"]).maxThresholds).toBe(2);
    expect(parse(["node", "cli", "--max-thresholds", "3"]).maxThresholds).toBe(3);
  });

  it("rejects max thresholds outside 1..3", () => {
    for (const value of ["0", "4", "5", "1.5"]) {
      expect(() => parse(["node", "cli", "--max-thresholds", value])).toThrow(
        "--max-thresholds must be an integer between 1 and 3"
      );
    }
  });

  it("rejects non-numeric max thresholds", () => {
    expect(() => parse(["node", "cli", "--max-thresholds", "abc"])).toThrow(
      "--max-thresholds must be a number"
    );
  });

  // Time format tests
  it("parses time format: plain number as days", () => {
    const config = parse(["node", "cli", "--time", "365"]);
    expect(config.periodDays).toBe(365);
  });

  it("parses time format: days (d)", () => {
    const config = parse(["node", "cli", "--time", "7d"]);
    expect(config.periodDays).toBe(7);
  });

  it("parses time format: weeks (w)", () => {
    const config = parse(["node", "cli", "--time", "52w"]);
    expect(config.periodDays).toBe(364);
  });

  it("parses time format: years (y)", () => {
    const config = parse(["node", "cli", "--time", "2y"]);
    expect(config.periodDays).toBe(730);
  });

  it("parses time format: months (m)", () => {
    const config = parse(["node", "cli", "--time", "2m"]);
    expect(config.periodDays).toBe(59);
  });

  it("parses time format: case insensitive (uppercase D)", () => {
    const config = parse(["node", "cli", "--time", "7D"]);
    expect(config.periodDays).toBe(7);
  });

  it("parses time format: case insensitive (uppercase W)", () => {
    const config = parse(["node", "cli", "--time", "52W"]);
    expect(config.periodDays).toBe(364);
  });

  it("parses time format: case insensitive (uppercase Y)", () => {
    const config = parse(["node", "cli", "--time", "2Y"]);
    expect(config.periodDays).toBe(730);
  });

  it("parses time format: case insensitive (uppercase M)", () => {
    const config = parse(["node", "cli", "--time", "2M"]);
    expect(config.periodDays).toBe(59);
  });

  it("uses calendar logic for leap year transitions", () => {
    const leapDate = new Date("2024-02-29T00:00:00Z");
    const config = parseCliConfig(["node", "cli", "--time", "1y"], leapDate);
    expect(config.periodDays).toBe(366);
  });

  it("rejects invalid time format", () => {
    expect(() => parse(["node", "cli", "--time", "7x"])).toThrow("Invalid time format");
  });

  it("rejects invalid time format: negative number", () => {
    expect(() => parse(["node", "cli", "--time", "-5d"])).toThrow("Invalid time format");
  });

  it("rejects invalid time format: no number", () => {
    expect(() => parse(["node", "cli", "--time", "abc"])).toThrow("Invalid time format");
  });

  it("defaults to symbols mode with MSFT when nothing is provided", () => {
    const config = parse(["node", "cli"]);
    expect(config.mode).toBe("symbols");
    expect(config.symbols).toEqual(["MSFT"]);
  });

  it("switches to portfolio mode with --portfolio", () => {
    const config = parse(["node", "cli", "--portfolio"]);
    expect(config.mode).toBe("portfolio");
    expect(config.symbols).toBeUndefined();
  });

  it("rejects combining --portfolio with --symbols", () => {
    expect(() => parse(["node", "cli", "--portfolio", "--symbols", "AAPL"])).toThrow(
      "cannot combine --portfolio with --symbols"
    );
  });
});
