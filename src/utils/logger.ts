export interface Logger {
  verbose(message: string, error?: unknown): void;
  warn(message: string): void;
  error(message: string, error?: unknown): void;
}

export function createLogger(verbose: boolean): Logger {
  const useColors = process.env.NO_COLOR === undefined;
  const warnLabel = useColors ? "\u001B[93m[WARN]\u001B[0m" : "[WARN]";

  return {
    verbose(message: string, error?: unknown) {
      if (verbose) {
        if (error instanceof Error) {
          process.stderr.write(`[VERBOSE] ${message}: ${error.message}\n`);
          if (error.stack) {
            process.stderr.write(`${error.stack}\n`);
          }
        } else if (error !== undefined) {
          process.stderr.write(`[VERBOSE] ${message}: ${JSON.stringify(error)}\n`);
        } else {
          process.stderr.write(`[VERBOSE] ${message}\n`);
        }
      }
    },
    warn(message: string) {
      process.stderr.write(`${warnLabel} ${message}\n`);
    },
    error(message: string, error?: unknown) {
      if (error instanceof Error) {
        process.stderr.write(`[ERROR] ${message}: ${error.message}\n`);
      } else if (error !== undefined) {
        process.stderr.write(`[ERROR] ${message}: ${JSON.stringify(error)}\n`);
      } else {
        process.stderr.write(`[ERROR] ${message}\n`);
      }
    }
  };
}
