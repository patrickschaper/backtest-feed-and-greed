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
   - Strategy equity (yellow)
   - Buy & Hold equity (cyan)
4. **Legend** — directly below the chart; label text is rendered in its series color; buy/sell marker glyphs (▲/▼) colored green/red
5. **Performance table** — one unified table. Columns: Scenario, Buy, Sell, Start Equity, Final Equity, Total Return, CAGR, Max Drawdown, Trades, Win Rate. Rows:
   - `Buy & Hold` (baseline, always pinned to the top; Buy/Sell shown as `-`)
   - `Manual strategy` (uses the given CLI/default thresholds; appends an inline delta vs Buy & Hold — ` (Δ±X)` with neutral-colored brackets, a leading delta sign (Δ), and a +/- sign + number colored green (positive) / red (negative) / neutral (zero) — on Final Equity, Total Return, and CAGR)
   - With `--optimize`: one row per objective (`Max Return`, `Return / Drawdown`, `Return x Win Rate`, `Return / DD x Win Rate`), each showing its best Buy/Sell thresholds and metrics with the same inline ` (Δ±X)` deltas vs Buy & Hold on Final Equity, Total Return, and CAGR
   - All rows **except `Buy & Hold`** (i.e. `Manual strategy` + any optimizer rows) are sorted by **Total Return, descending**
6. **CAGR note** — `CAGR = Compound Annual Growth Rate.` directly below the table
7. **Optimizer note** (only with `--optimize`) — directly below the CAGR note; explains optimizer rows show the best buy/sell pair per objective and don't change the featured run

## Threshold optimization (`--optimize`)

Implemented in `src/backtest/optimize.ts`.

- Exhaustively backtests every integer buy/sell threshold pair (buy 0–100, sell 0–100 = 10,201 combos) by reusing `runBacktest` with single-element threshold arrays.
- Reuses the existing timeline, mode, initial cash, and symbol weights; only thresholds vary.
- Selects the best combo for four objectives via parameter-free, ratio-based scoring:
  1. `Max Return` — `totalReturnPct`
  2. `Return / Drawdown` — `totalReturnPct / maxDrawdownPct` (∞ when drawdown is 0)
  3. `Return × Win Rate` — `totalReturnPct × (winRatePct / 100)`
  4. `Return / DD × Win Rate` — combination of 2 and 3
- **Gating:** when `totalReturnPct <= 0`, the score is the raw return, so the optimizer picks the "least bad" combo instead of a misleading ratio.
- **Tie-break:** higher total return, then lower drawdown, then higher CAGR, then lower buy, then lower sell.
- The featured chart + performance table use the **given** (CLI/default) buy/sell thresholds. With `--optimize`, the four objective winners are appended as extra rows in that same performance table (alongside the Manual strategy row) — informational, they do not change the featured run.
- **Multi-threaded:** the 10,201-combo grid is split across all CPU cores via `node:worker_threads` (`src/backtest/optimizeWorker.ts`), giving a large speedup on multi-core machines. Cross-platform and any-CPU safe:
  - Core count from `os.availableParallelism()` (container-aware) with `os.cpus().length` fallback, clamped to ≥ 1.
  - The worker is loaded via a `file://` URL object (not a path string) so it resolves on Windows/macOS/Linux, in both `tsx` dev (`.ts`) and built `dist` (`.js`).
  - Falls back to the synchronous path (`runOptimizationSync`) on a single core, a tiny grid, or any worker failure — results are identical regardless of core count (deterministic selection; slices merged in buy order).

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
