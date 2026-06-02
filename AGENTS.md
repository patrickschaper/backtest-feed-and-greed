# AGENTS

## Project conventions

- Runtime: Node.js + TypeScript
- CLI entrypoint: `src/cli.ts`
- Strategy engine code lives in `src/backtest/`
- Data adapters live in `src/data/`

## Quality gates

- Format: Prettier
- Lint: ESLint
- Tests: Vitest
- Pre-commit hook runs `lint-staged`

## Backtest assumptions (v1)

- Signals are generated from daily Fear & Greed values.
- Always buy on backtest day 1.
- Buy only on strict upward threshold crossing: `previous < buyThreshold` and `current > buyThreshold`.
- Sell only on strict downward threshold crossing: `previous > sellThreshold` and `current < sellThreshold`.
- Equality does not trigger (`== buyThreshold` / `== sellThreshold` => hold).
- Crossing signal on day `t` executes on day `t+1` to avoid lookahead bias.
- Always sell on the final backtest day if still invested.
- No fees/slippage modeling in v1.

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
