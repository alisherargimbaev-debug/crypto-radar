# Apex Algo Fund — Architecture & Runbook

*Last updated: June 1, 2026*

This document describes how the Apex Algo Fund bot works internally. Use it as a reference when debugging, onboarding partners, or returning to the project after a break.

---

## 1. High-Level Overview

Apex Algo Fund is an automated crypto futures trading bot running on Bybit Demo. It consists of three main components:

1. **Signal engine** — scans markets, generates trading signals
2. **Filter pipeline** — scores signals and decides which to act on
3. **Execution layer (AutoExec)** — opens/closes positions on Bybit and records them

All three run inside a single Node.js process (`index.js`) on a VPS, with a Telegram bot and web dashboard exposing the data.

---

## 2. Infrastructure

| Component | Detail |
|---|---|
| **Hosting** | DigitalOcean VPS, Singapore region |
| **IP** | 157.230.250.73 |
| **OS** | Ubuntu Linux |
| **Process manager** | PM2 (autostart enabled) |
| **Runtime** | Node.js + native dependencies |
| **Database** | Supabase (PostgreSQL) |
| **Exchange** | Bybit Demo (mainnet API for klines, demo API for orders) |
| **Domain** | apexalgofund.com (Cloudflare DNS, Let's Encrypt SSL) |
| **Source control** | github.com/alisherargimbaev-debug/crypto-radar |
| **Cost** | ~$27/month total |

---

## 3. Code Organization

The codebase is currently a monolith with these files:

| File | Lines | Purpose |
|---|---|---|
| `index.js` | ~8730 | Main process: signals, filters, HTTP server, Telegram bot, database |
| `autoexec.js` | ~705 | Position lifecycle on Bybit: open, track, close, save |
| `copytrader.js` | ~? | Copy trading module (not active) |
| `footprint.js` | ~? | Order flow analysis |
| `regime.js` | ~? | Market regime detection (ADX, ATR) |
| `bybit-client.js` | ~? | Bybit API wrapper |
| `unified_dashboard.html` | ~3000 | Web dashboard (Live, Paper, Metrics, Readiness, etc.) |

**Note:** This monolithic structure is a known technical debt. Plan to refactor into modules after 100+ live trades and stable strategies (Phase 2 of roadmap).

---

## 4. Signal Lifecycle (Single Trade Journey)

This is the most important section. Understanding this flow makes debugging much easier.

### Step 1 — Coin scanning (every minute via cron)

The bot iterates through ~50 watched crypto pairs (BTC, ETH, ZEC, ORDI, etc.) and pulls live data:
- OHLCV candles (5m, 15m, 1h, 4h, 1D timeframes) from Bybit klines
- Open interest, funding rate, order book imbalance
- Options flow (Deribit, BTC/ETH only)
- Footprint data (per-coin order flow)

### Step 2 — Strategy evaluation

For each coin, every active strategy gets a chance to produce a raw signal:

**Active in LIVE mode:**
- **S1 Volume Spike (15m)** — volume surge with directional move
- **S10 4H Range Breakout (5m)** — breakouts from 4-hour consolidation ranges

**Active in OBSERVE/PAPER mode (data collection):**
- S2 Liquidity Bounce
- S3 Early Entry
- S5 RSI Divergence
- S6 Funding Rate Extreme
- S7 Absorption
- S9 Pullback in Trend
- S13 Order Block Reversal
- S16 VWAP Deviation
- S18 News/Listing
- S19 Value Area Reversal

**Removed/disabled (do not modify):**
- S4 MA20/MA50+RSI (WR 0% — removed)
- S8 Basis Farming (no data)
- S11 Elliott+Fib (too complex)
- S12 Liquidity Sweep (duplicate of S1)
- S14 Whale Follow (WR 0% — removed)
- S15 Liquidation Hunt (API unavailable)
- S17 BB Squeeze (WR 24% — removed)

Each strategy outputs a raw signal with: symbol, direction (long/short), entry price, suggested SL/TP, and initial confidence score (0-100).

### Step 3 — Filter pipeline (the heart of the system)

Every signal passes through a 3-level structured pipeline with ±30% cap on confidence adjustments.

**Level 1 — Hard gates** (signal is rejected if these fail):
- Confidence < 60 → blocked entirely
- Tuesday UTC → −25% confidence (historically bad day)
- Asian night hours → −10%
- Delta + POC combined gate (if order flow opposes price-of-control)

**Level 2 — Market context** (capped at ±15% total):
- FVG (Fair Value Gap) presence
- Weekly POC and Monthly POC alignment
- BTC GEX (global, applied to all coins)
- Funding Rate filter

**Level 3 — Technical** (capped at ±15% total):
- Absorption (large orders absorbed without price movement)
- Open Interest change (5m)
- Order Book Imbalance (OKX REST)
- Footprint delta and POC
- MA200 alignment (soft penalty, not hard gate)

**Special handling:**
- S1 (Volume Spike) is partially exempt from some Level 1 gates because it's itself a reaction signal
- Rolling Sharpe-based risk reduction kicks in when recent performance is poor

### Step 4 — Threshold check

After all filters, final confidence must clear:
- **S1**: ≥70% (based on historical paper analysis showing performance drops below this)
- **S10**: ≥65%
- **Others (observe)**: 65%

In **observe mode**, all signals are logged but not traded.

### Step 5 — AutoExec position opening

If signal passes, `autoexec.js` takes over:

1. **Position sizing** using leverage-independent formula:
   ```
   qty = riskAmount / (price × slPct / 100)
   ```
   Risk per trade is currently $43 (0.5% of $9000 base).

2. **Risk caps:**
   - Max 15% of balance as position value
   - Max 2 open positions in prop mode (unlimited in live mode)
   - Daily loss limit check before opening

3. **Place market order on Bybit Demo:**
   - Order placed at current market price
   - SL and TP placed as separate exchange orders (closing logic delegated to Bybit)

4. **Track position in memory** in `activePositions` Map keyed by symbol.

### Step 6 — Position monitoring (every 30 seconds)

For each open position:
- Query Bybit for current price and unrealized PnL
- Check if 50% of TP1 distance reached → move SL to breakeven, activate trailing stop
- Track high-water mark for trailing stop trigger
- Detect if position was closed by exchange (SL hit, TP hit, manual)

### Step 7 — Position close & save

When position closes:
1. Detect close (either by AutoExec command or by exchange auto-close)
2. Calculate final PnL (with retry x2 for Bybit API delays — first attempt sometimes returns stale data)
3. Save to Supabase `trades` table via `saveTrade()` in `autoexec.js`
4. Remove from `activePositions`
5. Send Telegram notification with result

**Saved fields in `trades` table:**
- `ts` (open timestamp, bigint ms)
- `inst_id` (e.g., "BTC-USDT-SWAP")
- `symbol` (e.g., "BTCUSDT")
- `strategy` (e.g., "AutoExec")
- `direction` ("Buy" or "Sell" — raw from Bybit API)
- `price` (entry price)
- `close_price`
- `sl`, `tp1`, `tp2` (target levels at open)
- `confidence` (final score 0-100)
- `outcome` ("tp1", "sl", or "unknown")
- `pnl` (final realized P&L in USD)
- `closed_at` (close timestamp, bigint ms)
- `created_at` (database insert time, timestamptz)

---

## 5. Database Schema

Two main tables:

### `trades` (live data ONLY)
Contains real positions executed by AutoExec on Bybit Demo. Written exclusively by `autoexec.js → saveTrade()`. This is the source of truth for live performance metrics.

### `paper_trades` (simulation data ONLY)
Contains paper-trading signals from in-memory simulation. Used for strategy research, never for live performance reporting.

**Critical invariant:** these tables must never be mixed. We had bugs in May 2026 where live trades leaked into paper_trades and vice versa. All such code paths have been removed.

### `open_trades`
Persists currently-open paper positions across bot restarts (state recovery on startup).

### Other tables
- `subscriptions` (Telegram bot user preferences)
- `settings` (bot configuration)

---

## 6. HTTP API Endpoints

All exposed by Express server in `index.js`:

| Endpoint | Returns |
|---|---|
| `GET /` | Main dashboard HTML |
| `GET /api/trades` | Live trades (from `trades` table, merged with in-memory open positions) |
| `GET /api/paper` | Paper signals |
| `GET /api/backtest` | Backtest results (legacy, may be removed) |
| `GET /api/radar` | Current scan radar (top opportunities) |
| `GET /api/news` | Crypto news feed |
| `GET /api/regime` | BTC market regime classification |
| `GET /api/flashcrash` | Flash crash detector status |
| `GET /api/whales` | Whale activity |
| `GET /api/cot` | Commitment of Traders |
| `GET /api/rss` | RSS feed |

**Important:** `/api/trades` filters in-memory data by `source === 'bybit_real'` strictly. Paper signals without source are excluded. This was a bug fix in June 2026.

---

## 7. Telegram Channels

Two distinct channels with very different purposes:

### Public channel (@ApexAlgoFund)
- Broadcasts "best signal of the day" at 16:00 ALM
- Daily summary at 20:00 ALM
- Morning report at 12:00 ALM
- **All in English**, marketing/transparency oriented
- Signals shown here are not always executed by the bot — they go through all filters first

### Private bot
- Sends notifications about REAL positions opened/closed by AutoExec
- Sends bot health alerts, drawdown warnings
- Only for the bot operator

**Important distinction:** A signal in the public channel does NOT mean the bot took the trade. Always check `trades` table for what was actually executed.

---

## 8. Trading Modes

Bot has three operational modes set via state flags:

| Mode | Behavior |
|---|---|
| **Live** | Full execution, all active strategies, unlimited position count |
| **Prop** | Restricted to S1+S10, max 2 open positions, stricter risk controls |
| **Observe** | Signals generated and logged, but NO position opening on Bybit |

Currently running in **Live mode**.

To switch modes: edit state in Supabase `settings` table or use Telegram bot commands.

---

## 9. Risk Management

Current implementation:
- **Per-trade risk:** 0.5% of balance (~$43 at $9000)
- **Daily loss limit:** triggers warning if exceeded
- **Position cap:** 15% of balance as max position value
- **Rolling Sharpe auto-reduce:** if recent Sharpe drops, position size shrinks
- **Position count limits:** 2 in prop mode, unlimited in live

**Known limitations (to address later):**
- No correlation-aware sizing (3 alt-coin shorts treated as 3 independent risks; in reality they correlate ~0.9)
- No regime-aware sizing (same risk in high vs low volatility)
- No drawdown recovery mode (after -5% should auto-reduce risk ×0.5 until recovery)

---

## 10. Deployment Workflow

**Standard deploy (from local machine):**
```bash
cp ~/Downloads/index.js ~/crypto-radar/index.js && \
cd ~/crypto-radar && git add . && \
git commit -m "your message" && \
git push origin main && \
ssh root@157.230.250.73 "cd /root/crypto-radar && git pull && pm2 restart apex-bot"
```

**Direct edit on VPS (no GitHub roundtrip):**
1. SSH in: `ssh root@157.230.250.73`
2. Edit file in place (use Node.js scripts for emoji-safe replacements, NOT sed)
3. Validate syntax: `node --check /root/crypto-radar/index.js`
4. Commit on VPS: `git -C /root/crypto-radar commit -am "msg"`
5. Sync to GitHub from local: `git pull` on the VPS commit, then push from local
6. Restart: `pm2 restart apex-bot`

**Important:** Always make backups before VPS edits:
```bash
cp /root/crypto-radar/index.js /root/crypto-radar/index.js.backup_$(date +%Y%m%d_%H%M%S)
```

---

## 11. Runbook (Common Problems → Actions)

### Problem: Bot is offline
```bash
ssh root@157.230.250.73 "pm2 status"
```
If status is `errored` or `stopped`:
```bash
ssh root@157.230.250.73 "pm2 restart apex-bot && pm2 logs apex-bot --lines 50 --nostream"
```
Check the last 50 log lines for the crash reason. Common causes: out-of-memory, Bybit API outage, Supabase connection lost.

### Problem: Trades not being saved to database
1. Check logs for `Supabase insert error`:
   ```bash
   ssh root@157.230.250.73 "pm2 logs apex-bot --lines 200 --nostream | grep -iE 'supabase|insert error|save'"
   ```
2. Look for schema mismatches (e.g., field name doesn't match column name).
3. Look for type mismatches (e.g., ISO string in bigint column).
4. Verify env vars are loaded: `pm2 env 0 | grep SUPABASE`

### Problem: Dashboard shows wrong numbers
- Check `/api/trades` directly: it should only return rows where `source='bybit_real'`
- In-memory data takes priority over DB for current session; if stale data persists, restart bot.

### Problem: Same trade appears twice in DB
- This was a known issue (paper-sim was writing to `trades` table). Fixed June 2026.
- If recurring, grep for all `from('trades').insert` calls. There should be exactly ONE in `autoexec.js`.

### Problem: BTC Bot is taking unexpected trades
- Check current mode: live / prop / observe
- Review last 30 minutes of logs for which filters fired/passed
- Check if a removed strategy was accidentally re-enabled (S4/S14/S17 should never fire)

### Problem: PnL doesn't match Bybit
- AutoExec uses Bybit's `closedPnl` field with retry x2 (3s then 6s delay) because the first call sometimes returns 0 due to API lag
- If still mismatched after retry, status is set to `"UNKNOWN (API delay)"` rather than misreporting as profit
- Compare timestamps in DB vs Bybit; ensure both are in the same timezone

### Problem: Telegram messages not arriving
- Check for 403 errors in logs (bot was blocked/removed from chat)
- Verify chat_id in env vars
- Test with `/start` from the bot

---

## 12. Health Check (Daily 30-second routine)

```bash
ssh root@157.230.250.73 "pm2 status"
```

What to look for:
- ✅ Status: `online`
- ✅ Memory: <500MB
- ✅ Restart count not increasing rapidly (>5 in an hour is bad)
- ⚠️ Uptime suddenly very short → check logs for crash

For deeper check:
```bash
ssh root@157.230.250.73 "pm2 logs apex-bot --lines 100 --nostream --err"
```

---

## 13. Key Files & Their Roles

```
/root/crypto-radar/
├── index.js                    # main process (signals, filters, server, telegram)
├── autoexec.js                 # bybit execution and trade saving
├── copytrader.js              # copy trading (not active)
├── footprint.js               # order flow analysis
├── regime.js                   # market regime classification
├── bybit-client.js            # bybit api wrapper
├── unified_dashboard.html      # web dashboard
├── analysis/
│   └── mae_mfe.js             # MAE/MFE analysis script (run manually)
├── .env                        # environment variables (SUPABASE_URL, etc.)
├── package.json
└── *.backup_YYYYMMDD_HHMMSS   # automatic backups before risky edits
```

---

## 14. Versioning Strategy

- All commits go to GitHub `main` branch
- Backup files are timestamped and kept on VPS for at least 30 days
- Major changes get descriptive commit messages
- For experimental changes, use feature branches (e.g., `feature/partial-close`)

---

## 15. Things That Will Bite You Later (Known Tech Debt)

1. **Monolithic index.js (8700+ lines)** — refactor into modules planned for Phase 2
2. **No unit tests** — critical math (position sizing, PnL) is untested
3. **No backtest framework v1** — currently in planning, top priority for June-July 2026
4. **Walk-forward validation never done** — all strategies need this before serious capital deployment
5. **Strategy proliferation** — too many half-active strategies (S2, S5, S7, S13, S16, S18, S19 in paper); decide which to keep
6. **Russian/English code comments mixed** — should standardize to English for industry norm
7. **Limited observability** — no structured logging, no system metrics dashboard

---

## 16. Useful Commands Cheat Sheet

```bash
# Status
ssh root@157.230.250.73 "pm2 status"

# Live logs
ssh root@157.230.250.73 "pm2 logs apex-bot"

# Recent logs (no stream)
ssh root@157.230.250.73 "pm2 logs apex-bot --lines 100 --nostream"

# Restart
ssh root@157.230.250.73 "pm2 restart apex-bot"

# Clear log files (logs accumulate over time)
ssh root@157.230.250.73 "pm2 flush apex-bot"

# Query trades
ssh root@157.230.250.73 "cd /root/crypto-radar && node -e \"
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
sb.from('trades').select('*', { count: 'exact', head: true })
  .then(({ count }) => console.log('trades count:', count));
\""

# Run MAE/MFE analysis
ssh root@157.230.250.73 "cd /root/crypto-radar && node analysis/mae_mfe.js"
```

---

## 17. Glossary

| Term | Meaning |
|---|---|
| **MFE** | Max Favorable Excursion — highest unrealized profit reached during trade |
| **MAE** | Max Adverse Excursion — deepest unrealized loss reached during trade |
| **R:R** | Risk-to-Reward ratio (avg win ÷ avg loss) |
| **Expectancy** | Expected profit per trade: (WR × AvgWin) − ((1−WR) × AvgLoss) |
| **Sharpe** | Risk-adjusted return; >1.0 is good, >2.0 is excellent |
| **Calmar** | Annual return ÷ max drawdown; measures DD-adjusted performance |
| **Walk-forward** | Validation technique: train on past, test on future, slide window |
| **FVG** | Fair Value Gap — price imbalance left by aggressive movement |
| **POC** | Point of Control — price with highest volume in a period |
| **GEX** | Gamma Exposure — options market positioning indicator |
| **AutoExec** | The execution module that opens/closes positions on Bybit |

---

*This document should be updated whenever the architecture changes significantly. The current state reflects June 1, 2026.*
