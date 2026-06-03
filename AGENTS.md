# AGENTS

## Project conventions

- Runtime: Node.js + TypeScript
- CLI entrypoint: `src/cli.ts`
- Strategy engine code lives in `src/backtest/`
- Data adapters live in `src/data/`

## Git workflow

### Branches

Use short, kebab-case branch names prefixed by type:

```
feat/multi-symbol-support
fix/time-axis-alignment
chore/update-deps
docs/update-readme
```

### Conventional commits

All commit messages must follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<optional scope>): <short description>

<optional body>
```

Common types: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `style`, `perf`.

Examples:

```
feat(cli): add --symbol flag for multi-stock backtests
fix(graph): align time axis with chart plot area
docs: update README with multi-threshold examples
chore: bump vitest to v3
```

When a commit touches multiple things, use very concise bullet points in the body:

```
feat: add Delta row and update docs

- Delta is 3rd row in perf table (Final Equity, Total Return, CAGR)
- N/A fields show -
- Fix hybrid provider order in README
- Add output structure section to AGENTS.md
```

## Quality gates

- Format: Prettier
- Lint: ESLint
- Tests: Vitest
- Pre-commit hook runs `lint-staged`

## Backtest assumptions (v1)

- Signals are generated from daily Fear & Greed values.
- **Symbols mode is the default** (defaults to `MSFT` when no `--symbols` given). Trading212 portfolio mode is opt-in via `--portfolio` (mutually exclusive with `--symbols`).
- Threshold optimization always runs (there is no `--optimize` flag).
- Always buy on backtest day 1.
- Multiple buy and sell thresholds are supported (comma-separated via CLI).
- Buy only on strict upward threshold crossing: `previous < threshold` and `current > threshold` (evaluated for each buy threshold).
- Sell only on strict downward threshold crossing: `previous > threshold` and `current < threshold` (evaluated for each sell threshold).
- Equality does not trigger (`== threshold` => hold).
- Crossing signal on day `t` executes on day `t+1` to avoid lookahead bias.
- Always sell on the final backtest day if still invested.
- No fees/slippage modeling in v1.

## Output structure

Terminal output is rendered in this order:

1. **Symbol table** — ticker, name, exchange, price range, allocated capital, weight % (omitted in portfolio mode with a single implicit symbol)
2. **Mode / date range** — `Mode: symbols | portfolio` and `Date range: YYYY-MM-DD -> YYYY-MM-DD (N trading days)`
3. **Equity curve chart** — ASCII line chart at fixed 30-line height, terminal-width adaptive; three series:
   - Fear & Greed Index (grey)
   - Manual strategy equity (yellow)
   - Buy & Hold equity (cyan)
4. **Legend** — directly below the chart; label text is rendered in its series color; buy/sell marker glyphs (▲/▼) colored green/red
5. **Performance table** — one unified table. Columns: Scenario, Buy, Sell, Start Equity, Final Equity, Total Return, CAGR, Max Drawdown, Trades, Win Rate. Rows:
   - `Buy & Hold` (baseline, always pinned to the top; Buy/Sell shown as `-`)
   - `Manual strategy` (uses the given CLI/default thresholds)
   - One row per objective (always shown): `Max Return`, `Return / Drawdown`, `Return x Win Rate`, `Return / DD x Win Rate`, each showing its best Buy/Sell thresholds and metrics
   - All rows **except `Buy & Hold`** (i.e. `Manual strategy` + the optimizer rows) are sorted by **Total Return, descending**
6. **CAGR note** — `CAGR = Compound Annual Growth Rate.` directly below the table
7. **Optimizer note** — directly below the CAGR note; explains optimizer rows show the best buy/sell pair per objective and don't change the featured run

## Threshold optimization

Implemented in `src/backtest/optimize.ts`. Runs on every backtest.

- Searches **sets of 1–3 buy thresholds × 1–3 sell thresholds** (including asymmetric counts, e.g. 1 buy + 3 sell) by reusing `runBacktest` with multi-element, canonical (sorted-ascending, unique) threshold arrays.
- The search space is huge (full integer 1–3 subsets ≈ 29.5B backtests), so the method is selectable via `--optimizer-strategy <greedy|coarse|single-expand|full>` (default **greedy**):
  - **greedy** (default): evaluate the full single buy × single sell integer grid (10,201 combos) to anchor each objective's best single, then iteratively add a buy OR sell threshold (whichever improves the objective most) until no improvement or both sides reach size 3.
  - **single-expand**: same single-grid anchor, then a single ordered pass — add up to 2 more buy thresholds (full 0–100 scan each), then up to 2 more sell thresholds; anchor fixed.
  - **coarse**: restrict thresholds to steps of 5 (levels 0,5,…,100 = 21 values) and brute-force ALL size-1..3 buy subsets × size-1..3 sell subsets (≈ 1,561 × 1,561 ≈ 2.44M runs).
  - **full**: integer resolution (0–100), ALL size-1..3 subsets both sides (≈ 29.5B). Implemented faithfully with a prominent verbose warning; uncapped (will not finish in practice — exists for completeness).
- Reuses the existing timeline, mode, initial cash, and symbol weights; only thresholds vary.
- Selects the best combo for four objectives via parameter-free, ratio-based scoring:
  1. `Max Return` — `totalReturnPct`
  2. `Return / Drawdown` — `totalReturnPct / maxDrawdownPct` (∞ when drawdown is 0)
  3. `Return × Win Rate` — `totalReturnPct × (winRatePct / 100)`
  4. `Return / DD × Win Rate` — combination of 2 and 3
- **Gating:** when `totalReturnPct <= 0`, the score is the raw return, so the optimizer picks the "least bad" combo instead of a misleading ratio.
- **Shared comparator:** a single `isBetter(candidate, current, objective)` (score `>`, or score `===` with tie-break) is reused in `BestTracker.update`/`merge` and in greedy/single-expand expansion, so parallel and sync produce identical results regardless of encounter order.
- **Tie-break (array-aware):** higher total return, then lower drawdown, then higher CAGR, then fewer buy thresholds, then lexicographic buy array, then fewer sell thresholds, then lexicographic sell array.
- **Floor guarantee:** trackers seed from the best single combo and replace only when `isBetter`, so greedy/single-expand can never finish worse than the single-threshold winner.
- **Heuristic note:** greedy/single-expand are heuristics (adding a threshold changes the signal-fraction denominator and can dilute signals), not guaranteed global optima; `coarse` is the broad-search alternative. The optimizer rows render the comma-joined threshold sets in their Buy/Sell cells.
- The featured chart + performance table use the **given** (CLI/default) buy/sell thresholds. The four objective winners are always appended as extra rows in that same performance table (alongside the Manual strategy row) — informational, they do not change the featured run.
- **Multi-threaded:** Cross-platform and any-CPU safe:
  - greedy / single-expand split the 10,201-combo single grid across all CPU cores via `optimizeWorker.ts`; the (small) expansion then runs synchronously on the main thread.
  - coarse / full partition the buy-subset list across cores via `optimizeSubsetWorker.ts`; each worker streams subsets into a local `BestTracker` and returns serialized per-objective bests + a count, which the main thread merges via the shared comparator.
  - Worker → main messages use **structured clone** of plain objects (never JSON — `Infinity` scores would be corrupted to `null`).
  - Core count from `os.availableParallelism()` (container-aware) with `os.cpus().length` fallback, clamped to ≥ 1; workers loaded via a `file://` URL object resolving `.ts` (tsx dev) vs `.js` (dist).
  - Falls back to the synchronous path (`runOptimizationSync`) on a single core, a tiny grid, or any worker failure — results are identical regardless of core count.

### Progress spinner

`src/progress.ts` provides a hand-rolled `ProgressReporter` (no new dependency) that writes a live, stage-labeled spinner to **stderr** — active **only** when `process.stderr.isTTY` and `--verbose` is off (verbose narrates stages via the logger; non-TTY/pipes/tests get a silent no-op so stdout stays clean). `run()` drives `stage(...)` through each phase (`Fetching Trading212 portfolio`, `Downloading Fear & Greed Index`, `Downloading prices: <SYMBOL>`, `Optimizing NN%`, `Fetching symbol metadata`) and maps optimizer `onProgress(done, total)` to `reporter.percent(...)`. The spinner is stopped before the result table is written to stdout and in a `finally` so it never lingers on error.

## Trading212 API Integration

### Authentication

- Uses Trading212's v0 API with Basic Authentication
- Requires both **API Key** and **API Secret** (not a single token)
- Format in `.env`: `TRADING212_API_TOKEN=API_KEY:API_SECRET`
- The PortfolioClient automatically base64-encodes credentials for the Basic auth header

### Useful Resources

- **Official Docs**: https://docs.trading212.com/api
- **API Key Generation**: https://www.trading212.com/api-docs
- **Account Support**: Check your Trading212 account settings for API credentials

### Current Endpoints Used

- `GET /positions` — Fetches all open portfolio positions for backtesting

## Price Provider System

Price providers live in `src/data/providers/`. The orchestrator is `src/data/priceProvider.ts`.

### Providers

| Provider    | Module                              | Auth                            | Notes                                                 |
| ----------- | ----------------------------------- | ------------------------------- | ----------------------------------------------------- |
| TradingView | `src/data/providers/tradingview.ts` | None (optional session cookies) | Unofficial WebSocket API; may violate TradingView ToS |
| Yahoo       | `src/data/providers/yahoo.ts`       | None                            | Free, reliable for major exchanges                    |

### Provider chain (hybrid mode)

`yahoo → tradingview`

- **Hybrid** is the default. Each symbol tries providers in order until one succeeds.
- A provider is disabled for the whole run on `ProviderGlobalError` (init failure, network outage).
- **Single-provider mode** never falls back — fails fast on any error.

### Price cache

Fetched results are stored in `~/.cache/backtest-feed-and-greed/prices/YYYY-MM-DD/` (one JSON file per symbol + date-range key). The cache is valid for the entire current calendar day. Old date directories are automatically pruned at startup.

### Error classification

- `ProviderGlobalError` — WebSocket init failure or search API outage: disables the provider for the entire run.
- Plain `Error` — symbol not found or no data: only skips that symbol for that provider (hybrid tries next).

### TradingView auth (optional)

Set browser cookies in `.env` to increase access limits:

```
TRADINGVIEW_SESSION=your-sessionid-cookie
TRADINGVIEW_SIGNATURE=your-tradingviewui_sign-cookie
```

Retrieve these from browser DevTools → Application → Cookies on `tradingview.com`.

### Environment variables

| Var                     | Required for                             |
| ----------------------- | ---------------------------------------- |
| `TRADING212_API_TOKEN`  | Portfolio position fetch (always)        |
| `TRADINGVIEW_SESSION`   | Optional: TradingView higher-rate access |
| `TRADINGVIEW_SIGNATURE` | Optional: TradingView higher-rate access |
