# backtest-feed-and-greed

TypeScript Node.js CLI for backtesting a stock strategy driven by the CNN Fear & Greed index.

## Features

- Portfolio backtest by default (all Trading212 holdings); automatically switches to single-symbol mode when `--symbol` is provided
- Daily signal strategy with configurable thresholds
  - Default buy threshold: `55`
  - Default sell threshold: `45`
- Backtest time range with flexible format (e.g., `365`, `7d`, `52w`, `2m`, `2y`; default: 1 year, calendar-based)
- Selectable price provider: `hybrid` (default), `yahoo`, `tradingview`
- ESLint + Prettier + pre-commit hook support
- Result table comparing strategy vs buy-and-hold baseline
- Combined ASCII equity graph (strategy + buy-and-hold) above the table, fixed 30-line height and terminal-width adaptive rendering

## Setup

```bash
npm install
cp .env.example .env
```

Set your credentials in `.env`. Trading212 is required for portfolio mode; TradingView cookies are optional but can increase rate limits:

```bash
TRADING212_API_TOKEN=API_KEY:API_SECRET

# Optional — TradingView session cookies for higher data access
# Get these from browser DevTools → Application → Cookies on tradingview.com
# TRADINGVIEW_SESSION=your-sessionid-cookie
# TRADINGVIEW_SIGNATURE=your-tradingviewui_sign-cookie
```

## API Permissions

This application uses **read-only access** to the Trading212 API. No trade execution or account modification permissions are required.

### Required Permissions

- ✅ View portfolio positions (GET `/equity/account/portfolio/positions`)

### What This App Does NOT Access

- ❌ Account balance or cash
- ❌ Trade history
- ❌ Execute trades or place orders
- ❌ Modify account settings
- ❌ Personal account information

### Generating Your API Token

1. Visit [Trading212 API Docs](https://www.trading212.com/api-docs)
2. Navigate to the API token section in your account settings
3. Generate an API key and API secret pair (read-only scopes are enough for this app)
4. Paste them into `.env` as `TRADING212_API_TOKEN=API_KEY:API_SECRET`

These credentials are used for Basic authentication and grant read-only access to your portfolio data, making them safe to use in this backtesting flow.

## Usage

Run help:

```bash
npm run dev -- --help
```

Examples:

```bash
# Default 1-year portfolio backtest (backtests all open positions)
npm run dev --

# Portfolio backtest with custom thresholds
npm run dev -- --time 3y --buy-threshold 60 --sell-threshold 40

# Portfolio backtest for calendar 2 months
npm run dev -- --time 2m

# Force Yahoo-only pricing
npm run dev -- --price-provider yahoo

# Single stock backtest
npm run dev -- --symbol AAPL --time 52w
```

## Strategy Logic

The strategy is deterministic and runs in this order:

1. **Initial entry (day 1):** the strategy always buys on the first backtest day using the configured symbol weights.
2. **Crossing-based signals (middle of test):**
   - **Buy trigger:** only when Fear & Greed crosses the buy threshold strictly upward (`previous < buyThreshold` and `current > buyThreshold`).
   - **Sell trigger:** only when Fear & Greed crosses the sell threshold strictly downward (`previous > sellThreshold` and `current < sellThreshold`).
   - Touching a threshold value alone (e.g. `== 55` or `== 45`) does **not** trigger a trade.
3. **Final exit (last day):** if still invested, the strategy always sells on the final backtest day.

This means the strategy is guaranteed to have a defined start and end state for every run.

## Price Providers

| Provider      | Option             | Auth Required                                     | Notes                                                                              |
| ------------- | ------------------ | ------------------------------------------------- | ---------------------------------------------------------------------------------- |
| TradingView   | `tradingview`      | None (optional session cookies for higher limits) | Unofficial WebSocket API — may violate TradingView ToS; fragile but broad coverage |
| Yahoo Finance | `yahoo`            | None                                              | Free, reliable for US/major exchanges                                              |
| Hybrid        | `hybrid` (default) | _(all of the above optional)_                     | Tries TradingView first, Yahoo as fallback                                         |

**Hybrid mode** (`--price-provider hybrid`, default) tries providers in this chain per symbol:
`yahoo → tradingview`

A provider is disabled for the entire run if it returns a provider-wide error (e.g. WebSocket init failure, network outage). A one-time warning is logged and the next provider is tried.

In **single-provider mode**, there is no fallback — the run fails fast with a clear error message.

> **⚠️ TradingView disclaimer:** The TradingView provider uses an unofficial WebSocket protocol and may violate TradingView's Terms of Service. Use it at your own risk. It may break at any time if TradingView changes their internal API.

## Notes

- Fear & Greed data is pulled from a historical CSV source derived from CNN index history.
- Price history is pulled from the selected provider (default: hybrid — Yahoo first, TradingView as fallback).
- All single-provider modes are strict — no fallback. Only `hybrid` falls back through the chain.
- **Price cache:** fetched results are cached to `~/.cache/backtest-feed-and-greed/prices/YYYY-MM-DD/` and reused for the remainder of that calendar day. Old cache directories are automatically pruned on each run.
- Output includes a benchmark row: buy-and-hold from day 1 with no further trades.
- `Compound Annual Growth Rate (CAGR)` is annualized return over the backtest period.
