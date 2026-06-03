export interface ProgressReporter {
  /** Sets the current stage label and clears any percentage. */
  stage(text: string): void;
  /** Sets a 0–100 percentage suffix for the current stage. */
  percent(value: number): void;
  /** Clears the spinner line and stops the frame timer. Idempotent. */
  stop(): void;
}

interface ProgressReporterOptions {
  stream?: NodeJS.WriteStream;
  enabled?: boolean;
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const NOOP_REPORTER: ProgressReporter = {
  stage() {},
  percent() {},
  stop() {}
};

/**
 * Creates a single-line stderr spinner. When disabled (non-TTY, piped output,
 * verbose mode, or tests) it returns a silent no-op so stdout stays clean.
 */
export function createProgressReporter(options: ProgressReporterOptions = {}): ProgressReporter {
  const stream = options.stream ?? process.stderr;
  const enabled = options.enabled ?? Boolean(stream.isTTY);
  if (!enabled) {
    return NOOP_REPORTER;
  }

  const useColor = process.env.NO_COLOR === undefined;
  let label = "";
  let pct: number | undefined;
  let frame = 0;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let lastRenderedPct: number | undefined;

  const render = (): void => {
    const glyph = FRAMES[frame % FRAMES.length] as string;
    frame += 1;
    const spinner = useColor ? `\u001b[36m${glyph}\u001b[0m` : glyph;
    const suffix = pct !== undefined ? ` ${pct}%` : "";
    stream.write(`\r\u001b[2K${spinner} ${label}${suffix}`);
    lastRenderedPct = pct;
  };

  const ensureTimer = (): void => {
    if (timer || stopped) {
      return;
    }
    timer = setInterval(render, 80);
    if (typeof timer.unref === "function") {
      timer.unref();
    }
    render();
  };

  return {
    stage(text: string) {
      label = text;
      pct = undefined;
      lastRenderedPct = undefined;
      ensureTimer();
      render();
    },
    percent(value: number) {
      pct = Math.max(0, Math.min(100, Math.floor(value)));
      ensureTimer();
      // Render directly (not just via the 80ms timer): heavy synchronous
      // optimization phases block the event loop and would otherwise starve the
      // timer, leaving the percentage stuck. onProgress runs on the same call
      // stack, so a direct render keeps the percentage advancing. Throttle to
      // whole-percent changes to avoid flooding the stream.
      if (pct !== lastRenderedPct) {
        render();
      }
    },
    stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
      stream.write("\r\u001b[2K");
    }
  };
}
