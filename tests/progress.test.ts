import { describe, expect, it } from "vitest";
import { createProgressReporter } from "../src/progress.js";

function fakeStream(isTTY: boolean): {
  isTTY: boolean;
  writes: string[];
  write: (s: string) => boolean;
} {
  const writes: string[] = [];
  return {
    isTTY,
    writes,
    write(s: string) {
      writes.push(s);
      return true;
    }
  };
}

describe("createProgressReporter", () => {
  it("is a silent no-op on a non-TTY stream", () => {
    const stream = fakeStream(false);
    const reporter = createProgressReporter({
      stream: stream as unknown as NodeJS.WriteStream
    });
    reporter.stage("Downloading Fear & Greed Index");
    reporter.percent(42);
    reporter.stop();
    expect(stream.writes).toHaveLength(0);
  });

  it("is a no-op when explicitly disabled even on a TTY", () => {
    const stream = fakeStream(true);
    const reporter = createProgressReporter({
      stream: stream as unknown as NodeJS.WriteStream,
      enabled: false
    });
    reporter.stage("Optimizing");
    reporter.percent(10);
    reporter.stop();
    expect(stream.writes).toHaveLength(0);
  });

  it("renders to the stream when enabled and stop is idempotent", () => {
    const stream = fakeStream(true);
    const reporter = createProgressReporter({
      stream: stream as unknown as NodeJS.WriteStream,
      enabled: true
    });
    reporter.stage("Optimizing");
    reporter.percent(50);
    expect(stream.writes.length).toBeGreaterThan(0);
    expect(stream.writes.some((w) => w.includes("Optimizing"))).toBe(true);
    reporter.stop();
    const afterStop = stream.writes.length;
    reporter.stop();
    expect(stream.writes.length).toBe(afterStop);
  });

  it("does not throw when percent is called before any stage", () => {
    const stream = fakeStream(true);
    const reporter = createProgressReporter({
      stream: stream as unknown as NodeJS.WriteStream,
      enabled: true
    });
    expect(() => {
      reporter.percent(5);
      reporter.stop();
    }).not.toThrow();
  });
});
