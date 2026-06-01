#!/usr/bin/env node
/**
 * APEX ALGO FUND — Backtest v1.3 for S1 Volume Spike (15m)
 * ──────────────────────────────────────────────────────────
 * v1.3 — CLI date parameters for regime testing
 *   --start=YYYY-MM-DD   start date (default: 90 days ago)
 *   --end=YYYY-MM-DD     end date (default: today)
 *   --label=NAME         label for report file (e.g., "bear" or "bull")
 *
 * Examples:
 *   node analysis/backtest_s1.js
 *   node analysis/backtest_s1.js --start=2025-11-01 --end=2025-12-31 --label=bear
 *
 * v1.2 base — honest entry on next 1m open + slippage, no look-ahead bias.
 * Exact copy of the production S1 logic from index.js.
 * Tests on real Bybit historical 15-min candles over the past 3 months.
 *
 * Outputs:
 *   - analysis/reports/backtest_s1_YYYYMMDD.json   (raw trades + metadata)
 *   - analysis/reports/backtest_s1_YYYYMMDD.csv    (equity curve)
 *   - analysis/reports/backtest_s1_YYYYMMDD.html   (visual report)
 *
 * How to run:
 *   ssh root@157.230.250.73 "cd /root/crypto-radar && node analysis/backtest_s1.js"
 *
 * Safe: read-only on Bybit public API. Does not touch the bot.
 *
 * IMPORTANT v1 CAVEATS:
 *   - Tests S1 strategy logic only (no filter pipeline replay)
 *   - Does NOT simulate trailing stop or partial close (raw SL/TP)
 *   - Uses 1m candles for SL/TP detection within trade window
 *   - Account starts at $9000 (Bybit demo baseline)
 *   - Risk per trade: 0.5% ($45)
 *   - Fee: 0.055% taker (Bybit standard)
 *   - Slippage: 0.05% per side (entry + exit)
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');

// ─── CLI ARGS ────────────────────────────────────────────────
const args = process.argv.slice(2);
const argMap = {};
for (const a of args) {
  const m = a.match(/^--(\w+)=(.+)$/);
  if (m) argMap[m[1]] = m[2];
}

const ARG_START = argMap.start;   // YYYY-MM-DD
const ARG_END   = argMap.end;     // YYYY-MM-DD
const ARG_LABEL = argMap.label || '';

// ─── CONFIG ──────────────────────────────────────────────────
const COINS = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT',
  'DOGEUSDT', 'BNBUSDT', 'AVAXUSDT', 'LINKUSDT'
];
const DAYS_BACK     = 90;             // 3 months (default if no CLI args)
let PERIOD_DAYS     = DAYS_BACK;      // mutated by main() if CLI args used
const BYBIT_BASE    = 'https://api.bybit.com';
const REPORT_DIR    = path.join(__dirname, 'reports');
const RATE_LIMIT_MS = 100;

// Trading config (matches production)
const STARTING_BALANCE = 9000;
const RISK_PCT         = 0.5;          // 0.5% per trade
const FEE_PCT          = 0.055;        // Bybit taker fee
const SLIPPAGE_PCT     = 0.05;         // realistic on alts
const LEVERAGE         = 10;            // for position sizing reference only

// S1 thresholds (exact match with production threshold for live)
const S1_CONFIDENCE_THRESHOLD = 70;

// SL/TP rules (from calcSLTP in index.js)
const MIN_SL_PCT = 0.8;
const MAX_SL_PCT = 1.5;
const TP1_RR     = 2.0;
const TP2_RR     = 3.0;

// Trade duration cap (don't hold positions forever)
const MAX_HOLD_MINUTES = 180; // 3 hours

// ─── UTILITIES ───────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fmt(n, d = 2) { return n == null || isNaN(n) ? '—' : n.toFixed(d); }

// ─── BYBIT API ───────────────────────────────────────────────
async function fetchKlines(symbol, interval, startMs, endMs) {
  const all = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const url = `${BYBIT_BASE}/v5/market/kline?category=linear&symbol=${symbol}&interval=${interval}&start=${cursor}&end=${endMs}&limit=1000`;
    let res;
    try { res = await fetch(url); }
    catch (e) { console.warn(`  ⚠ Net error for ${symbol} ${interval}: ${e.message}`); return all; }
    if (!res.ok) { console.warn(`  ⚠ HTTP ${res.status} for ${symbol}`); return all; }
    const json = await res.json();
    if (json.retCode !== 0 || !json.result?.list?.length) return all;
    const candles = json.result.list
      .map((r) => ({ t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5], qv: +r[6] }))
      .sort((a, b) => a.t - b.t);
    all.push(...candles);
    if (candles.length < 1000) break;
    cursor = candles[candles.length - 1].t + 1;
    await sleep(RATE_LIMIT_MS);
  }
  // Deduplicate by timestamp
  const seen = new Set();
  return all.filter(c => seen.has(c.t) ? false : (seen.add(c.t), true));
}

// ─── INDICATORS (exact copy from index.js) ───────────────────
function calcATR(klines, period = 14) {
  if (klines.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < klines.length; i++) {
    const h = klines[i].h, l = klines[i].l, pc = klines[i - 1].c;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

// ─── STRATEGY S1 (exact copy from index.js line 4136) ────────
function checkS1Signal(k15m_window) {
  // window is the last 20 candles ending at signal generation time
  if (k15m_window.length < 15) return null;

  const last = k15m_window[k15m_window.length - 1];
  const prev = k15m_window[k15m_window.length - 2];
  const pc   = prev.c ? (last.c - prev.c) / prev.c * 100 : 0;
  const avgVol = k15m_window.slice(-11, -1).reduce((a, c) => a + (c.qv || 0), 0) / 10;
  const volSpike = (last.qv || 0) >= avgVol * 2.0;

  if (!volSpike || Math.abs(pc) < 1.0) return null;

  const dir = pc >= 1.0 ? 'long' : 'short';
  let conf = 65;
  if ((last.qv || 0) >= avgVol * 3.0) conf += 8;
  if (Math.abs(pc) >= 2.0) conf += 6;
  conf = Math.min(conf, 95);

  return { direction: dir, confidence: conf, volRatio: (last.qv || 0) / avgVol, priceChangePct: pc };
}

// ─── SL/TP CALCULATION (exact copy from index.js calcSLTP) ───
function calcSLTP(price, direction, atr) {
  let slPct;
  if (atr && atr > 0) {
    const atrPct = (atr / price) * 100 * 1.2;
    slPct = Math.max(MIN_SL_PCT, Math.min(atrPct, MAX_SL_PCT));
  } else {
    slPct = 1.2;
  }
  const slDist  = price * slPct / 100;
  const tp1Dist = slDist * TP1_RR;
  const tp2Dist = slDist * TP2_RR;
  return direction === 'long'
    ? { sl: price - slDist, tp1: price + tp1Dist, tp2: price + tp2Dist, slPct }
    : { sl: price + slDist, tp1: price - tp1Dist, tp2: price - tp2Dist, slPct };
}

// ─── TRADE SIMULATION (using 1m candles for exit detection) ──
function simulateTrade(entry, direction, sl, tp1, tp2, futureCandles1m) {
  for (const c of futureCandles1m) {
    if (direction === 'long') {
      // SL hits first if low touches it
      if (c.l <= sl)  return { outcome: 'sl',  exitPrice: sl,  exitTime: c.t };
      if (c.h >= tp2) return { outcome: 'tp2', exitPrice: tp2, exitTime: c.t };
      if (c.h >= tp1) return { outcome: 'tp1', exitPrice: tp1, exitTime: c.t };
    } else {
      if (c.h >= sl)  return { outcome: 'sl',  exitPrice: sl,  exitTime: c.t };
      if (c.l <= tp2) return { outcome: 'tp2', exitPrice: tp2, exitTime: c.t };
      if (c.l <= tp1) return { outcome: 'tp1', exitPrice: tp1, exitTime: c.t };
    }
  }
  // Expired — close at last candle close
  const last = futureCandles1m[futureCandles1m.length - 1];
  return { outcome: 'expired', exitPrice: last.c, exitTime: last.t };
}

// ─── PNL CALCULATION (with fees and slippage) ────────────────
function calcPnL(entry, exit, direction, qty) {
  // Apply slippage: entry worse, exit worse
  const realEntry = direction === 'long' ? entry * (1 + SLIPPAGE_PCT / 100) : entry * (1 - SLIPPAGE_PCT / 100);
  const realExit  = direction === 'long' ? exit  * (1 - SLIPPAGE_PCT / 100) : exit  * (1 + SLIPPAGE_PCT / 100);

  const priceDiff = direction === 'long' ? (realExit - realEntry) : (realEntry - realExit);
  const grossPnl  = priceDiff * qty;

  // Fee on entry + exit (taker)
  const entryFee = realEntry * qty * (FEE_PCT / 100);
  const exitFee  = realExit  * qty * (FEE_PCT / 100);
  const netPnl   = grossPnl - entryFee - exitFee;

  return { realEntry, realExit, grossPnl, fees: entryFee + exitFee, netPnl };
}

// ─── POSITION SIZING ─────────────────────────────────────────
function calcPositionSize(balance, price, slPct) {
  const riskAmount = balance * (RISK_PCT / 100);
  const qty = riskAmount / (price * slPct / 100);
  return { qty, riskAmount, value: qty * price };
}

// ─── MAIN BACKTEST ───────────────────────────────────────────
async function backtest() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  APEX ALGO FUND — S1 BACKTEST v1');
  console.log('═══════════════════════════════════════════════════════\n');

  const endMs   = ARG_END   ? new Date(ARG_END   + 'T23:59:59Z').getTime() : Date.now();
  const startMs = ARG_START ? new Date(ARG_START + 'T00:00:00Z').getTime() : (endMs - DAYS_BACK * 24 * 60 * 60 * 1000);
  const periodDays = Math.round((endMs - startMs) / 86400000);
  PERIOD_DAYS = periodDays;
  console.log(`Period: ${new Date(startMs).toISOString().slice(0, 10)} → ${new Date(endMs).toISOString().slice(0, 10)} (${periodDays} days)${ARG_LABEL ? ' [' + ARG_LABEL + ']' : ''}`);
  console.log(`Coins:  ${COINS.length} (${COINS.join(', ')})\n`);

  const allTrades = [];
  let balance = STARTING_BALANCE;
  let peakBalance = STARTING_BALANCE;
  let maxDrawdown = 0;
  const equityCurve = [{ t: startMs, balance: STARTING_BALANCE }];

  for (const symbol of COINS) {
    console.log(`\n─── ${symbol} ───`);
    console.log('  Fetching 15m klines...');
    const k15m = await fetchKlines(symbol, '15', startMs, endMs);
    if (k15m.length < 100) { console.log(`  ⚠ insufficient data (${k15m.length})`); continue; }
    console.log(`  ✓ ${k15m.length} 15m candles`);

    let signals = 0, executed = 0, cooldownUntil = 0;

    // Walk through 15m candles starting from index 20 (need history for indicators)
    for (let i = 20; i < k15m.length - 1; i++) {
      // Skip if in cooldown (don't open back-to-back trades on same symbol)
      if (k15m[i].t < cooldownUntil) continue;

      const window = k15m.slice(i - 19, i + 1); // last 20 candles ending at i
      const signal = checkS1Signal(window);
      if (!signal) continue;

      // Confidence threshold check (matches live)
      if (signal.confidence < S1_CONFIDENCE_THRESHOLD) continue;

      signals++;

      const signalClose = k15m[i].c;
      const signalTime  = k15m[i].t;
      const atr = calcATR(window, 14);

      // ─── v1.1: Fetch 1m candles for entry detection + trade simulation ──
      const tradeEndTime = signalTime + MAX_HOLD_MINUTES * 60 * 1000;
      const futureCandles = await fetchKlines(symbol, '1', signalTime + 60_000, tradeEndTime);
      if (futureCandles.length < 2) continue;

      // ─── v1.2: Entry on OPEN of next 1m candle ──
      // Bot in real life enters ~1-2 seconds after signal close.
      // We approximate this with: entry = open of next 1m candle.
      // This is a small overestimate (real bot enters slightly into the candle),
      // but it's the most honest approximation we can do without tick data.
      // NO look-ahead filter — bot does not see how candle closes.
      const firstCandle = futureCandles[0];
      const realEntryPrice = firstCandle.o;
      const entryTime = firstCandle.t;

      // ─── Calculate SL/TP based on REAL entry price (not signal close) ──
      const { sl, tp1, tp2, slPct } = calcSLTP(realEntryPrice, signal.direction, atr);

      // Position size from current balance
      const { qty, riskAmount, value } = calcPositionSize(balance, realEntryPrice, slPct);

      // ─── v1.1: Gap-through SL check on entry candle ──
      // If first candle already crosses SL → exit at worst of (open, sl)
      let sim;
      const slHitOnFirst = signal.direction === 'long'
        ? firstCandle.l <= sl
        : firstCandle.h >= sl;

      if (slHitOnFirst) {
        // Gap-through: we exit at SL price (filled at SL level via stop order)
        // OR worse if open already past SL
        const gapThroughExit = signal.direction === 'long'
          ? Math.min(realEntryPrice, sl) // can't get better than SL
          : Math.max(realEntryPrice, sl);
        const finalExit = signal.direction === 'long'
          ? Math.min(gapThroughExit, sl)
          : Math.max(gapThroughExit, sl);
        sim = { outcome: 'sl', exitPrice: finalExit, exitTime: firstCandle.t };
      } else {
        // Normal simulation on remaining 1m candles
        sim = simulateTrade(realEntryPrice, signal.direction, sl, tp1, tp2, futureCandles.slice(1));
      }

      const pnl = calcPnL(realEntryPrice, sim.exitPrice, signal.direction, qty);

      balance += pnl.netPnl;
      if (balance > peakBalance) peakBalance = balance;
      const dd = (peakBalance - balance) / peakBalance * 100;
      if (dd > maxDrawdown) maxDrawdown = dd;

      const trade = {
        symbol,
        direction: signal.direction,
        confidence: signal.confidence,
        volRatio: +signal.volRatio.toFixed(2),
        priceChangePct: +signal.priceChangePct.toFixed(3),
        signalTime,
        signalClose: +signalClose.toFixed(6),
        entryTime,
        entryPrice: +realEntryPrice.toFixed(6),
        entrySlippagePct: +(((realEntryPrice - signalClose) / signalClose) * 100).toFixed(3),
        sl: +sl.toFixed(6),
        tp1: +tp1.toFixed(6),
        tp2: +tp2.toFixed(6),
        slPct: +slPct.toFixed(3),
        qty: +qty.toFixed(4),
        value: +value.toFixed(2),
        riskAmount: +riskAmount.toFixed(2),
        atr: +(atr || 0).toFixed(6),
        outcome: sim.outcome,
        exitTime: sim.exitTime,
        exitPrice: +sim.exitPrice.toFixed(6),
        holdMinutes: Math.round((sim.exitTime - entryTime) / 60000),
        gapThroughExit: slHitOnFirst,
        grossPnl: +pnl.grossPnl.toFixed(4),
        fees: +pnl.fees.toFixed(4),
        netPnl: +pnl.netPnl.toFixed(4),
        balanceAfter: +balance.toFixed(2),
      };

      allTrades.push(trade);
      equityCurve.push({ t: sim.exitTime, balance: +balance.toFixed(2) });
      executed++;

      // Cooldown — 1 hour minimum between same-symbol trades
      cooldownUntil = sim.exitTime + 60 * 60 * 1000;
    }

    console.log(`  → ${signals} signals · ${executed} executed`);
  }

  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  RESULTS');
  console.log('═══════════════════════════════════════════════════════\n');

  const metrics = computeMetrics(allTrades, balance, maxDrawdown, equityCurve);
  printMetrics(metrics);

  // Save reports
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const suffix = ARG_LABEL ? `_${ARG_LABEL}` : '';
  const jsonPath = path.join(REPORT_DIR, `backtest_s1_${date}${suffix}.json`);
  const csvPath  = path.join(REPORT_DIR, `backtest_s1_${date}${suffix}.csv`);
  const htmlPath = path.join(REPORT_DIR, `backtest_s1_${date}${suffix}.html`);

  fs.writeFileSync(jsonPath, JSON.stringify({ metrics, trades: allTrades, equityCurve, config: {
    coins: COINS, daysBack: PERIOD_DAYS, label: ARG_LABEL, startingBalance: STARTING_BALANCE,
    riskPct: RISK_PCT, feePct: FEE_PCT, slippagePct: SLIPPAGE_PCT,
    confidenceThreshold: S1_CONFIDENCE_THRESHOLD,
  } }, null, 2));
  fs.writeFileSync(csvPath, equityCurveToCSV(equityCurve));
  fs.writeFileSync(htmlPath, buildHTMLReport(metrics, allTrades, equityCurve));

  console.log(`\n✓ JSON: ${jsonPath}`);
  console.log(`✓ CSV:  ${csvPath}`);
  console.log(`✓ HTML: ${htmlPath}`);
}

// ─── METRICS COMPUTATION ─────────────────────────────────────
function computeMetrics(trades, finalBalance, maxDD, equity) {
  const wins   = trades.filter(t => t.netPnl > 0);
  const losses = trades.filter(t => t.netPnl <= 0);
  const tp1Hits = trades.filter(t => t.outcome === 'tp1').length;
  const tp2Hits = trades.filter(t => t.outcome === 'tp2').length;
  const slHits  = trades.filter(t => t.outcome === 'sl').length;
  const expired = trades.filter(t => t.outcome === 'expired').length;

  const wr = trades.length ? (wins.length / trades.length) * 100 : 0;
  const avgWin  = wins.length ? wins.reduce((s, t) => s + t.netPnl, 0) / wins.length : 0;
  const avgLoss = losses.length ? Math.abs(losses.reduce((s, t) => s + t.netPnl, 0) / losses.length) : 0;
  const rr = avgLoss > 0 ? avgWin / avgLoss : 0;
  const expectancy = (wr / 100) * avgWin - ((100 - wr) / 100) * avgLoss;

  const totalPnl = finalBalance - STARTING_BALANCE;
  const totalPnlPct = (totalPnl / STARTING_BALANCE) * 100;

  // Sharpe (annualized, based on per-trade returns)
  const returns = trades.map(t => t.netPnl / STARTING_BALANCE * 100);
  let sharpe = 0;
  if (returns.length >= 5) {
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
    const std = Math.sqrt(variance);
    if (std > 0) {
      // Annualize: assuming ~1000 trades/year as a rough estimate
      const tradesPerYear = trades.length / (PERIOD_DAYS / 365);
      sharpe = (mean / std) * Math.sqrt(tradesPerYear);
    }
  }

  // Calmar (annualized return / max DD)
  const annualReturn = totalPnlPct * (365 / PERIOD_DAYS);
  const calmar = maxDD > 0 ? annualReturn / maxDD : 0;

  // Longest losing streak
  let curLoss = 0, maxLossStreak = 0;
  trades.forEach(t => {
    if (t.netPnl <= 0) { curLoss++; if (curLoss > maxLossStreak) maxLossStreak = curLoss; }
    else curLoss = 0;
  });

  // Per-symbol breakdown
  const perSymbol = {};
  for (const t of trades) {
    if (!perSymbol[t.symbol]) perSymbol[t.symbol] = { trades: 0, wins: 0, pnl: 0 };
    perSymbol[t.symbol].trades++;
    if (t.netPnl > 0) perSymbol[t.symbol].wins++;
    perSymbol[t.symbol].pnl += t.netPnl;
  }
  const perSymbolArr = Object.entries(perSymbol).map(([s, d]) => ({
    symbol: s, trades: d.trades, wr: (d.wins / d.trades) * 100, pnl: d.pnl,
  })).sort((a, b) => b.pnl - a.pnl);

  return {
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    tp1Hits, tp2Hits, slHits, expired,
    wr, avgWin, avgLoss, rr, expectancy,
    totalPnl, totalPnlPct,
    finalBalance,
    maxDrawdown: maxDD,
    sharpe, calmar, maxLossStreak,
    annualReturn,
    perSymbol: perSymbolArr,
  };
}

function printMetrics(m) {
  console.log(`Total Trades:    ${m.totalTrades}`);
  console.log(`Wins / Losses:   ${m.wins} / ${m.losses}`);
  console.log(`  TP1 hits:      ${m.tp1Hits}`);
  console.log(`  TP2 hits:      ${m.tp2Hits}`);
  console.log(`  SL hits:       ${m.slHits}`);
  console.log(`  Expired:       ${m.expired}`);
  console.log(``);
  console.log(`Win Rate:        ${fmt(m.wr)}%`);
  console.log(`Avg Win:         $${fmt(m.avgWin)}`);
  console.log(`Avg Loss:        $${fmt(m.avgLoss)}`);
  console.log(`R:R:             ${fmt(m.rr)}`);
  console.log(`Expectancy/trade: $${fmt(m.expectancy)}`);
  console.log(``);
  console.log(`Total PnL:       $${fmt(m.totalPnl)} (${fmt(m.totalPnlPct)}%)`);
  console.log(`Final Balance:   $${fmt(m.finalBalance)}`);
  console.log(`Max Drawdown:    ${fmt(m.maxDrawdown)}%`);
  console.log(`Max Loss Streak: ${m.maxLossStreak}`);
  console.log(``);
  console.log(`Sharpe:          ${fmt(m.sharpe)}`);
  console.log(`Calmar:          ${fmt(m.calmar)}`);
  console.log(`Annual Return:   ${fmt(m.annualReturn)}%`);
  console.log(``);
  console.log(`Per Symbol:`);
  for (const s of m.perSymbol) {
    console.log(`  ${s.symbol.padEnd(10)} ${s.trades.toString().padStart(3)} trades  WR ${fmt(s.wr).padStart(5)}%  PnL $${fmt(s.pnl).padStart(8)}`);
  }
}

function equityCurveToCSV(curve) {
  const rows = ['timestamp,iso_date,balance'];
  for (const p of curve) {
    rows.push(`${p.t},${new Date(p.t).toISOString()},${p.balance}`);
  }
  return rows.join('\n');
}

// ─── HTML REPORT ─────────────────────────────────────────────
function buildHTMLReport(m, trades, equity) {
  const equityPoints = equity.map(p => `[${p.t},${p.balance}]`).join(',');
  const verdict = m.expectancy > 0
    ? { color: '#22cc66', label: 'POSITIVE EXPECTANCY', text: 'Strategy shows profitable edge in backtest.' }
    : { color: '#ff4444', label: 'NEGATIVE EXPECTANCY', text: 'Strategy is losing money on this dataset. Needs revision.' };

  const wrColor   = m.wr >= 45 ? '#22cc66' : m.wr >= 35 ? '#e8a020' : '#ff4444';
  const pnlColor  = m.totalPnl >= 0 ? '#22cc66' : '#ff4444';
  const sharpeColor = m.sharpe >= 1.0 ? '#22cc66' : m.sharpe >= 0.5 ? '#e8a020' : '#ff4444';

  const tradesHtml = trades.slice(0, 50).map(t => `
    <tr>
      <td>${new Date(t.entryTime).toISOString().replace('T', ' ').slice(0, 16)}</td>
      <td>${t.symbol}</td>
      <td class="${t.direction === 'long' ? 'long' : 'short'}">${t.direction.toUpperCase()}</td>
      <td>${t.entryPrice}</td>
      <td>${t.exitPrice}</td>
      <td>${t.outcome.toUpperCase()}</td>
      <td>${t.holdMinutes}m</td>
      <td class="${t.netPnl >= 0 ? 'pos' : 'neg'}">${t.netPnl >= 0 ? '+' : ''}$${t.netPnl.toFixed(2)}</td>
    </tr>`).join('');

  const perSymbolHtml = m.perSymbol.map(s => `
    <tr>
      <td>${s.symbol}</td>
      <td>${s.trades}</td>
      <td class="${s.wr >= 45 ? 'pos' : 'neg'}">${s.wr.toFixed(1)}%</td>
      <td class="${s.pnl >= 0 ? 'pos' : 'neg'}">${s.pnl >= 0 ? '+' : ''}$${s.pnl.toFixed(2)}</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Apex Algo Fund — S1 Backtest Report</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3.0.0/dist/chartjs-adapter-date-fns.bundle.min.js"></script>
<style>
  :root {
    --bg: #0a0e0a; --panel: #0f1410; --border: #1f2a20;
    --text: #e5e7eb; --dim: #6b7280; --green: #22cc66; --red: #ff4444; --yellow: #e8a020;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: 'JetBrains Mono', monospace, sans-serif; padding: 24px; }
  .container { max-width: 1200px; margin: 0 auto; }
  .header { display: flex; justify-content: space-between; align-items: flex-end; margin-bottom: 32px; padding-bottom: 16px; border-bottom: 1px solid var(--border); }
  h1 { font-size: 1.8rem; letter-spacing: 1px; }
  .subtitle { font-size: 0.75rem; color: var(--dim); letter-spacing: 1.5px; margin-top: 4px; }
  .date { font-size: 0.7rem; color: var(--dim); letter-spacing: 1.2px; }
  .verdict { background: var(--panel); border: 1px solid var(--border); border-left: 4px solid ${verdict.color}; padding: 18px 22px; margin-bottom: 24px; }
  .verdict-label { font-size: 0.7rem; letter-spacing: 1.8px; color: ${verdict.color}; margin-bottom: 6px; }
  .verdict-text { font-size: 0.9rem; color: var(--text); }
  .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 24px; }
  .card { background: var(--panel); border: 1px solid var(--border); padding: 16px 18px; }
  .card-label { font-size: 0.6rem; letter-spacing: 1.5px; color: var(--dim); margin-bottom: 8px; text-transform: uppercase; }
  .card-value { font-size: 1.6rem; font-weight: 700; letter-spacing: 0.5px; }
  .card-sub { font-size: 0.65rem; color: var(--dim); margin-top: 4px; letter-spacing: 1px; }
  .green { color: var(--green); }
  .red { color: var(--red); }
  .yellow { color: var(--yellow); }
  .section { margin-bottom: 32px; }
  .section-title { font-size: 0.75rem; letter-spacing: 1.8px; color: var(--dim); margin-bottom: 14px; text-transform: uppercase; }
  .chart-wrap { background: var(--panel); border: 1px solid var(--border); padding: 18px; }
  table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--border); }
  th, td { padding: 10px 12px; text-align: left; font-size: 0.75rem; border-bottom: 1px solid var(--border); }
  th { background: rgba(255,255,255,0.02); font-weight: 600; color: var(--dim); letter-spacing: 1px; text-transform: uppercase; font-size: 0.65rem; }
  tr:last-child td { border-bottom: none; }
  .long { color: var(--green); }
  .short { color: var(--red); }
  .pos { color: var(--green); }
  .neg { color: var(--red); }
  .footer { text-align: center; color: var(--dim); font-size: 0.65rem; letter-spacing: 1.5px; margin-top: 40px; padding-top: 20px; border-top: 1px solid var(--border); }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <div>
      <h1>APEX ALGO FUND</h1>
      <div class="subtitle">S1 VOLUME SPIKE · BACKTEST REPORT v1</div>
    </div>
    <div class="date">${new Date().toISOString().slice(0, 10)} · ${PERIOD_DAYS} DAYS · ${COINS.length} SYMBOLS</div>
  </div>

  <div class="verdict">
    <div class="verdict-label">${verdict.label}</div>
    <div class="verdict-text">${verdict.text}</div>
  </div>

  <div class="grid">
    <div class="card"><div class="card-label">Total Trades</div><div class="card-value">${m.totalTrades}</div><div class="card-sub">Signals fired</div></div>
    <div class="card"><div class="card-label">Win Rate</div><div class="card-value" style="color:${wrColor}">${fmt(m.wr)}%</div><div class="card-sub">${m.wins}W / ${m.losses}L</div></div>
    <div class="card"><div class="card-label">Net P&L</div><div class="card-value" style="color:${pnlColor}">${m.totalPnl >= 0 ? '+' : ''}$${fmt(m.totalPnl)}</div><div class="card-sub">${fmt(m.totalPnlPct)}% from $${STARTING_BALANCE}</div></div>
    <div class="card"><div class="card-label">Sharpe Ratio</div><div class="card-value" style="color:${sharpeColor}">${fmt(m.sharpe)}</div><div class="card-sub">Annualized</div></div>
    <div class="card"><div class="card-label">R:R</div><div class="card-value">${fmt(m.rr)}</div><div class="card-sub">$${fmt(m.avgWin)} / $${fmt(m.avgLoss)}</div></div>
    <div class="card"><div class="card-label">Expectancy</div><div class="card-value" style="color:${m.expectancy >= 0 ? 'var(--green)' : 'var(--red)'}">$${fmt(m.expectancy)}</div><div class="card-sub">Per trade</div></div>
    <div class="card"><div class="card-label">Max Drawdown</div><div class="card-value red">−${fmt(m.maxDrawdown)}%</div><div class="card-sub">Peak to trough</div></div>
    <div class="card"><div class="card-label">Loss Streak</div><div class="card-value">${m.maxLossStreak}</div><div class="card-sub">Longest sequence</div></div>
  </div>

  <div class="section">
    <div class="section-title">Equity Curve</div>
    <div class="chart-wrap"><canvas id="equityChart" height="80"></canvas></div>
  </div>

  <div class="section">
    <div class="section-title">Outcome Breakdown</div>
    <div class="chart-wrap" style="height:280px"><canvas id="outcomeChart"></canvas></div>
  </div>

  <div class="section">
    <div class="section-title">Performance by Symbol</div>
    <table>
      <thead><tr><th>Symbol</th><th>Trades</th><th>Win Rate</th><th>Net P&L</th></tr></thead>
      <tbody>${perSymbolHtml}</tbody>
    </table>
  </div>

  <div class="section">
    <div class="section-title">First 50 Trades</div>
    <table>
      <thead><tr><th>Time</th><th>Symbol</th><th>Side</th><th>Entry</th><th>Exit</th><th>Outcome</th><th>Hold</th><th>Net P&L</th></tr></thead>
      <tbody>${tradesHtml}</tbody>
    </table>
  </div>

  <div class="footer">
    APEX ALGO FUND · Backtest v1 · S1 Volume Spike · Fees ${FEE_PCT}% · Slippage ${SLIPPAGE_PCT}%/side · Confidence ≥ ${S1_CONFIDENCE_THRESHOLD}%
  </div>
</div>

<script>
const equityData = [${equityPoints}].map(p => ({ x: p[0], y: p[1] }));
const ctxEq = document.getElementById('equityChart').getContext('2d');
new Chart(ctxEq, {
  type: 'line',
  data: { datasets: [{ label: 'Balance ($)', data: equityData, borderColor: '#22cc66', backgroundColor: 'rgba(34,204,102,0.08)', borderWidth: 1.5, pointRadius: 0, fill: true, tension: 0.1 }] },
  options: {
    responsive: true, maintainAspectRatio: false,
    scales: {
      x: { type: 'time', time: { unit: 'day' }, grid: { color: '#1f2a20' }, ticks: { color: '#6b7280' } },
      y: { grid: { color: '#1f2a20' }, ticks: { color: '#6b7280', callback: v => '$' + v.toFixed(0) } }
    },
    plugins: { legend: { display: false } }
  }
});

const ctxOut = document.getElementById('outcomeChart').getContext('2d');
new Chart(ctxOut, {
  type: 'bar',
  data: {
    labels: ['TP2 (full)', 'TP1', 'SL', 'Expired'],
    datasets: [{ data: [${m.tp2Hits}, ${m.tp1Hits}, ${m.slHits}, ${m.expired}],
      backgroundColor: ['#22cc66', '#86efac', '#ff4444', '#6b7280'] }]
  },
  options: {
    responsive: true, maintainAspectRatio: false,
    scales: { x: { grid: { display: false }, ticks: { color: '#9ca3af' } }, y: { grid: { color: '#1f2a20' }, ticks: { color: '#6b7280' } } },
    plugins: { legend: { display: false } }
  }
});
</script>
</body>
</html>`;
}

// ─── Date adapter check note ─────────────────────────────────
// Chart.js v4 needs date-fns adapter for time scale. Inline the adapter via CDN.
// (We add it to the chart.js script in the HTML by switching to a different CDN)

// Run
backtest().catch(e => { console.error('❌ Fatal:', e); process.exit(1); });
