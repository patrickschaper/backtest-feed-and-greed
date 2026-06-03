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
5. **Performance table** — three rows: `Strategy`, `Buy & Hold`, `Delta`; columns: Scenario, Start Equity, Final Equity, Total Return, CAGR, Max Drawdown, Trades, Win Rate
6. **CAGR note** — `CAGR = Compound Annual Growth Rate.` directly below the table

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
