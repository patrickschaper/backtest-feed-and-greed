#!/usr/bin/env node
import { run } from "./app.js";

const isVerbose = process.argv.includes("-v") || process.argv.includes("--verbose");

run(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  process.stderr.write(`Error: ${message}\n`);
  if (isVerbose && error instanceof Error && error.stack) {
    process.stderr.write(`\nStack trace:\n${error.stack}\n`);
  }
  process.exitCode = 1;
});
