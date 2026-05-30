#!/usr/bin/env node
require('dotenv').config();
/**
 * APEX ALGO FUND — MAE/MFE Analysis
 * ──────────────────────────────────
 * Standalone analytics script. Does NOT modify the bot or any live data.
 *
 * What it does:
 *   1. Reads all LIVE trades from Supabase (source='bybit_real')
 *   2. For each trade, fetches 1m klines from Bybit public API
 *   3. Computes MAE (Max Adverse Excursion) and MFE (Max Favorable Excursion)
 *   4. Aggregates statistics + breakdowns
 *   5. Saves a markdown report into analysis/reports/
 *
 * How to run:
 *   On VPS:    cd /root/crypto-radar && node analysis/mae_mfe.js
 *   Locally:   cd ~/crypto-radar && node analysis/mae_mfe.js
 *
 * Requires:  SUPABASE_URL, SUPABASE_KEY env vars (already set on VPS via PM2)
 *
 * Safe to run anytime. Read-only on Supabase. Public API for Bybit.
 */

const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

// ─── Config ──────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const BYBIT_BASE   = 'https://api.bybit.com';
const REPORT_DIR   = path.join(__dirname, 'reports');
const KLINE_DELAY  = 80; // ms between Bybit requests (rate limit safety)

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ SUPABASE_URL and SUPABASE_KEY env vars required');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── Utilities ───────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function toMs(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  const n = new Date(v).getTime();
  return isNaN(n) ? null : n;
}

function toBybitSymbol(instId) {
  // "BTC-USDT-SWAP" → "BTCUSDT" ; "BTCUSDT" → "BTCUSDT"
  if (!instId) return null;
  return instId.replace('-USDT-SWAP', 'USDT').replace('-USDT', 'USDT').replace('-', '');
}

function pct(part, whole) {
  return whole > 0 ? ((part / whole) * 100).toFixed(1) + '%' : '—';
}

function avg(arr) {
  if (!arr.length) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function median(arr) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function fmtNum(n, digits = 2) {
  return n == null || isNaN(n) ? '—' : n.toFixed(digits);
}

// ─── Bybit klines ────────────────────────────────────────────
async function fetchKlines(symbol, startMs, endMs) {
  // Bybit returns max 1000 candles per request. 1m × 1000 = ~16h.
  // Paginate if trade duration exceeds this.
  const all = [];
  let cursor = startMs;

  while (cursor < endMs) {
    const url =
      `${BYBIT_BASE}/v5/market/kline` +
      `?category=linear&symbol=${symbol}&interval=1` +
      `&start=${cursor}&end=${endMs}&limit=1000`;

    let res;
    try {
      res = await fetch(url);
    } catch (e) {
      console.warn(`  ⚠ Network error for ${symbol}: ${e.message}`);
      return all;
    }

    if (!res.ok) {
      console.warn(`  ⚠ HTTP ${res.status} for ${symbol}`);
      return all;
    }

    const json = await res.json();
    if (json.retCode !== 0 || !json.result?.list?.length) {
      return all;
    }

    // Bybit returns DESCENDING (newest first), each row:
    // [start, open, high, low, close, volume, turnover]
    const candles = json.result.list
      .map((row) => ({
        t: Number(row[0]),
        o: Number(row[1]),
        h: Number(row[2]),
        l: Number(row[3]),
        c: Number(row[4]),
      }))
      .sort((a, b) => a.t - b.t);

    all.push(...candles);

    if (candles.length < 1000) break; // got everything
    cursor = candles[candles.length - 1].t + 60_000;

    await sleep(KLINE_DELAY);
  }

  return all;
}

// ─── MAE/MFE computation ─────────────────────────────────────
function computeMaeMfe(trade, candles) {
  if (!candles.length) return null;

  const entry = trade.price;
  const sl    = trade.sl;
  const tp    = trade.tp2 || trade.tp1;
  const isLong = String(trade.direction).toLowerCase() === 'long';

  let bestPrice = entry;   // most favorable price reached
  let worstPrice = entry;  // most adverse price reached

  for (const c of candles) {
    if (isLong) {
      if (c.h > bestPrice)  bestPrice  = c.h;
      if (c.l < worstPrice) worstPrice = c.l;
    } else {
      if (c.l < bestPrice)  bestPrice  = c.l;
      if (c.h > worstPrice) worstPrice = c.h;
    }
  }

  const mfePct = isLong
    ? ((bestPrice  - entry) / entry) * 100
    : ((entry - bestPrice)  / entry) * 100;

  const maePct = isLong
    ? ((worstPrice - entry) / entry) * 100   // negative
    : ((entry - worstPrice) / entry) * 100;  // negative

  // Distance from entry to TP and SL (in % terms, always positive)
  const tpDistPct = tp && entry
    ? Math.abs(((tp - entry) / entry) * 100)
    : null;
  const slDistPct = sl && entry
    ? Math.abs(((sl - entry) / entry) * 100)
    : null;

  // How much of TP was reached (1.0 = hit TP exactly, >1.0 = went past then reversed)
  const tpReachedRatio = tpDistPct ? mfePct / tpDistPct : null;

  // How close to SL we came (1.0 = hit SL, <1.0 = recovered)
  const slThreatRatio = slDistPct ? Math.abs(maePct) / slDistPct : null;

  return {
    mfePct,
    maePct,
    tpDistPct,
    slDistPct,
    tpReachedRatio,
    slThreatRatio,
    candleCount: candles.length,
  };
}

// ─── Main analysis ───────────────────────────────────────────
async function main() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  APEX ALGO FUND — MAE/MFE Analysis');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // Step 1: Pull all live trades from Supabase
  console.log('📥 Fetching live trades from Supabase…');
  const { data: trades, error } = await supabase
    .from('paper_trades')
    .select('*')
    .eq('source', 'bybit_real')
    .order('ts', { ascending: true });

  if (error) {
    console.error('❌ Supabase error:', error.message);
    process.exit(1);
  }
  if (!trades?.length) {
    console.error('❌ No live trades found in Supabase');
    process.exit(1);
  }

  console.log(`✅ Found ${trades.length} live trades in DB\n`);

  // Step 2: For each trade, fetch klines and compute MAE/MFE
  console.log('🔍 Fetching klines and computing MAE/MFE…');
  const enriched = [];

  for (let i = 0; i < trades.length; i++) {
    const t = trades[i];
    const symbol  = toBybitSymbol(t.inst_id);
    const openMs  = toMs(t.ts);
    const closeMs = toMs(t.closed_at);

    if (!symbol || !openMs || !closeMs || closeMs <= openMs) {
      console.warn(`  [${i + 1}/${trades.length}] ⚠ ${symbol || '?'} — skipped (bad timestamps)`);
      enriched.push({ trade: t, metrics: null, reason: 'bad_timestamps' });
      continue;
    }

    // Pad window by 1 minute on each side for safety
    const candles = await fetchKlines(symbol, openMs - 60_000, closeMs + 60_000);

    if (!candles.length) {
      console.warn(`  [${i + 1}/${trades.length}] ⚠ ${symbol} — no klines returned`);
      enriched.push({ trade: t, metrics: null, reason: 'no_klines' });
      continue;
    }

    const metrics = computeMaeMfe(t, candles);
    const won = t.pnl > 0;
    const tag = won ? '🟢' : '🔴';
    console.log(
      `  [${i + 1}/${trades.length}] ${tag} ${symbol.padEnd(10)} ` +
      `MFE=${fmtNum(metrics.mfePct)}%  MAE=${fmtNum(metrics.maePct)}%  ` +
      `outcome=${t.outcome}  pnl=${fmtNum(t.pnl)}`
    );
    enriched.push({ trade: t, metrics, won });

    await sleep(KLINE_DELAY);
  }

  console.log('\n📊 Aggregating results…\n');

  // Step 3: Aggregate statistics
  const valid = enriched.filter((e) => e.metrics);
  const wins  = valid.filter((e) => e.won);
  const losses = valid.filter((e) => !e.won);

  const report = buildReport(valid, wins, losses, trades.length);

  // Step 4: Save report
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const filename = `mae_mfe_${new Date().toISOString().slice(0, 10)}.md`;
  const filepath = path.join(REPORT_DIR, filename);
  fs.writeFileSync(filepath, report);

  console.log(`✅ Report saved: ${filepath}`);
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(report);
}

// ─── Report builder ──────────────────────────────────────────
function buildReport(valid, wins, losses, totalCount) {
  const lines = [];
  const now = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

  lines.push(`# Apex Algo Fund — MAE/MFE Analysis`);
  lines.push(`*Generated: ${now}*\n`);

  // ─── Overview ─────────────────────────────────────────────
  const wr = (wins.length / valid.length) * 100;
  const totalPnl = valid.reduce((s, e) => s + (e.trade.pnl || 0), 0);
  const avgWin  = avg(wins.map((e) => e.trade.pnl));
  const avgLoss = avg(losses.map((e) => e.trade.pnl));
  const rr = avgWin && avgLoss ? Math.abs(avgWin / avgLoss) : null;
  const breakevenWR = rr ? (1 / (1 + rr)) * 100 : null;

  lines.push(`## Overview\n`);
  lines.push(`| Metric | Value |`);
  lines.push(`|---|---|`);
  lines.push(`| Trades in Supabase | ${totalCount} |`);
  lines.push(`| Analyzed (with kline data) | ${valid.length} |`);
  lines.push(`| Win Rate | ${fmtNum(wr)}% |`);
  lines.push(`| Net P&L | $${fmtNum(totalPnl)} |`);
  lines.push(`| Avg Win | $${fmtNum(avgWin)} |`);
  lines.push(`| Avg Loss | $${fmtNum(avgLoss)} |`);
  lines.push(`| R:R | ${fmtNum(rr)} |`);
  lines.push(`| Breakeven WR @ this R:R | ${fmtNum(breakevenWR)}% |`);
  lines.push(`| Gap to breakeven | ${fmtNum(breakevenWR - wr)}% |\n`);

  // ─── MAE/MFE core ─────────────────────────────────────────
  lines.push(`## MAE / MFE — The Big Picture\n`);
  lines.push(`**MFE** = Max Favorable Excursion (best price reached during trade)`);
  lines.push(`**MAE** = Max Adverse Excursion (worst price reached during trade)\n`);

  const mfeAll = valid.map((e) => e.metrics.mfePct);
  const maeAll = valid.map((e) => e.metrics.maePct);
  const mfeWins   = wins.map((e) => e.metrics.mfePct);
  const mfeLosses = losses.map((e) => e.metrics.mfePct);
  const maeWins   = wins.map((e) => e.metrics.maePct);
  const maeLosses = losses.map((e) => e.metrics.maePct);

  lines.push(`| Bucket | Avg MFE | Median MFE | Avg MAE | Median MAE |`);
  lines.push(`|---|---|---|---|---|`);
  lines.push(`| All trades | +${fmtNum(avg(mfeAll))}% | +${fmtNum(median(mfeAll))}% | ${fmtNum(avg(maeAll))}% | ${fmtNum(median(maeAll))}% |`);
  lines.push(`| Wins | +${fmtNum(avg(mfeWins))}% | +${fmtNum(median(mfeWins))}% | ${fmtNum(avg(maeWins))}% | ${fmtNum(median(maeWins))}% |`);
  lines.push(`| Losses | +${fmtNum(avg(mfeLosses))}% | +${fmtNum(median(mfeLosses))}% | ${fmtNum(avg(maeLosses))}% | ${fmtNum(median(maeLosses))}% |\n`);

  // ─── The most actionable insight ──────────────────────────
  lines.push(`## 🎯 The Key Question — How Much Profit Did Losses Have on the Table?\n`);

  const lossesWithGoodMfe = losses.filter((e) => {
    const r = e.metrics.tpReachedRatio;
    return r != null && r >= 0.5;
  });
  const lossesNearTp = losses.filter((e) => {
    const r = e.metrics.tpReachedRatio;
    return r != null && r >= 0.8;
  });
  const lossesPastTp = losses.filter((e) => {
    const r = e.metrics.tpReachedRatio;
    return r != null && r >= 1.0;
  });

  lines.push(`Of **${losses.length} losses**:`);
  lines.push(`- ${lossesWithGoodMfe.length} (${pct(lossesWithGoodMfe.length, losses.length)}) reached ≥50% of TP distance before reversing`);
  lines.push(`- ${lossesNearTp.length} (${pct(lossesNearTp.length, losses.length)}) reached ≥80% of TP distance before reversing`);
  lines.push(`- ${lossesPastTp.length} (${pct(lossesPastTp.length, losses.length)}) **actually touched TP** before reversing to SL\n`);

  if (lossesPastTp.length > 0) {
    lines.push(`> ⚠️ **${lossesPastTp.length} trades hit TP price and then reversed into stop-loss.** This is a classic signal that **trailing stop or partial close at TP1** could materially boost WR.\n`);
  }

  lines.push(`## 🛡️ How Often Did Wins Come Close to Stop-Loss?\n`);
  const winsCloseToSl = wins.filter((e) => {
    const r = e.metrics.slThreatRatio;
    return r != null && r >= 0.7;
  });
  const winsVeryClose = wins.filter((e) => {
    const r = e.metrics.slThreatRatio;
    return r != null && r >= 0.9;
  });
  lines.push(`Of **${wins.length} wins**:`);
  lines.push(`- ${winsCloseToSl.length} (${pct(winsCloseToSl.length, wins.length)}) came within 30% of SL before recovering`);
  lines.push(`- ${winsVeryClose.length} (${pct(winsVeryClose.length, wins.length)}) came within 10% of SL before recovering\n`);
  if (winsVeryClose.length > 0) {
    lines.push(`> 💡 These wins survived close calls. If we tightened SL, we'd kill some of these. If we loosened, we might save some of the lossesPastTp.\n`);
  }

  // ─── Breakdown by strategy ────────────────────────────────
  lines.push(`## Breakdown by Strategy\n`);
  const byStrategy = groupBy(valid, (e) => e.trade.strategy || 'Unknown');
  lines.push(`| Strategy | Trades | WR | Avg MFE | Avg MAE | Total P&L |`);
  lines.push(`|---|---|---|---|---|---|`);
  for (const [strat, items] of Object.entries(byStrategy)) {
    const w = items.filter((e) => e.won).length;
    const pnl = items.reduce((s, e) => s + (e.trade.pnl || 0), 0);
    lines.push(
      `| ${strat} | ${items.length} | ${fmtNum((w / items.length) * 100)}% | ` +
      `+${fmtNum(avg(items.map((e) => e.metrics.mfePct)))}% | ` +
      `${fmtNum(avg(items.map((e) => e.metrics.maePct)))}% | ` +
      `$${fmtNum(pnl)} |`
    );
  }

  // ─── Breakdown by confidence bucket ───────────────────────
  lines.push(`\n## Breakdown by Confidence\n`);
  const buckets = [
    { name: '60-69%', min: 60, max: 69.99 },
    { name: '70-79%', min: 70, max: 79.99 },
    { name: '80-89%', min: 80, max: 89.99 },
    { name: '90%+',   min: 90, max: 999 },
  ];
  lines.push(`| Confidence | Trades | WR | Avg MFE | Avg MAE | Total P&L |`);
  lines.push(`|---|---|---|---|---|---|`);
  for (const b of buckets) {
    const items = valid.filter((e) => {
      const c = e.trade.confidence || 0;
      return c >= b.min && c <= b.max;
    });
    if (!items.length) { lines.push(`| ${b.name} | 0 | — | — | — | — |`); continue; }
    const w = items.filter((e) => e.won).length;
    const pnl = items.reduce((s, e) => s + (e.trade.pnl || 0), 0);
    lines.push(
      `| ${b.name} | ${items.length} | ${fmtNum((w / items.length) * 100)}% | ` +
      `+${fmtNum(avg(items.map((e) => e.metrics.mfePct)))}% | ` +
      `${fmtNum(avg(items.map((e) => e.metrics.maePct)))}% | ` +
      `$${fmtNum(pnl)} |`
    );
  }

  // ─── Breakdown by direction ───────────────────────────────
  lines.push(`\n## Breakdown by Direction\n`);
  const byDir = groupBy(valid, (e) => String(e.trade.direction || '?').toLowerCase());
  lines.push(`| Direction | Trades | WR | Avg MFE | Avg MAE | Total P&L |`);
  lines.push(`|---|---|---|---|---|---|`);
  for (const [dir, items] of Object.entries(byDir)) {
    const w = items.filter((e) => e.won).length;
    const pnl = items.reduce((s, e) => s + (e.trade.pnl || 0), 0);
    lines.push(
      `| ${dir} | ${items.length} | ${fmtNum((w / items.length) * 100)}% | ` +
      `+${fmtNum(avg(items.map((e) => e.metrics.mfePct)))}% | ` +
      `${fmtNum(avg(items.map((e) => e.metrics.maePct)))}% | ` +
      `$${fmtNum(pnl)} |`
    );
  }

  // ─── Breakdown by hour of day (UTC) ───────────────────────
  lines.push(`\n## Breakdown by Hour of Day (UTC)\n`);
  const byHour = groupBy(valid, (e) => {
    const ms = toMs(e.trade.ts);
    return ms ? String(new Date(ms).getUTCHours()).padStart(2, '0') : '?';
  });
  lines.push(`| Hour | Trades | WR | Total P&L |`);
  lines.push(`|---|---|---|---|`);
  const sortedHours = Object.keys(byHour).sort();
  for (const h of sortedHours) {
    const items = byHour[h];
    const w = items.filter((e) => e.won).length;
    const pnl = items.reduce((s, e) => s + (e.trade.pnl || 0), 0);
    lines.push(`| ${h}:00 | ${items.length} | ${fmtNum((w / items.length) * 100)}% | $${fmtNum(pnl)} |`);
  }

  // ─── Breakdown by day of week ─────────────────────────────
  lines.push(`\n## Breakdown by Day of Week (UTC)\n`);
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const byDay = groupBy(valid, (e) => {
    const ms = toMs(e.trade.ts);
    return ms ? dayNames[new Date(ms).getUTCDay()] : '?';
  });
  lines.push(`| Day | Trades | WR | Total P&L |`);
  lines.push(`|---|---|---|---|`);
  for (const d of dayNames) {
    const items = byDay[d] || [];
    if (!items.length) { lines.push(`| ${d} | 0 | — | — |`); continue; }
    const w = items.filter((e) => e.won).length;
    const pnl = items.reduce((s, e) => s + (e.trade.pnl || 0), 0);
    lines.push(`| ${d} | ${items.length} | ${fmtNum((w / items.length) * 100)}% | $${fmtNum(pnl)} |`);
  }

  // ─── Filter analysis (from JSON filters column) ───────────
  lines.push(`\n## Filter Score Analysis\n`);
  const withFilters = valid.filter((e) => e.trade.filters);
  if (withFilters.length < 10) {
    lines.push(`Not enough trades with filter metadata (${withFilters.length}). Need ≥10.\n`);
  } else {
    const filterScores = {}; // { filterName: { winValues:[], lossValues:[] } }
    for (const e of withFilters) {
      let f;
      try { f = typeof e.trade.filters === 'string' ? JSON.parse(e.trade.filters) : e.trade.filters; }
      catch (_) { continue; }
      if (!f || typeof f !== 'object') continue;
      for (const [name, val] of Object.entries(f)) {
        if (typeof val !== 'number') continue;
        if (!filterScores[name]) filterScores[name] = { winValues: [], lossValues: [] };
        (e.won ? filterScores[name].winValues : filterScores[name].lossValues).push(val);
      }
    }
    lines.push(`| Filter | Avg in Wins | Avg in Losses | Spread |`);
    lines.push(`|---|---|---|---|`);
    const rows = Object.entries(filterScores)
      .map(([name, data]) => {
        const aw = avg(data.winValues);
        const al = avg(data.lossValues);
        const spread = (aw != null && al != null) ? aw - al : null;
        return { name, aw, al, spread, nw: data.winValues.length, nl: data.lossValues.length };
      })
      .filter((r) => r.nw >= 3 && r.nl >= 3)
      .sort((a, b) => Math.abs(b.spread || 0) - Math.abs(a.spread || 0));

    for (const r of rows.slice(0, 20)) {
      lines.push(`| ${r.name} | ${fmtNum(r.aw)} (n=${r.nw}) | ${fmtNum(r.al)} (n=${r.nl}) | ${r.spread > 0 ? '+' : ''}${fmtNum(r.spread)} |`);
    }
    lines.push(`\n*Filters sorted by predictive spread. Positive spread = filter scored higher on winners. Need 50+ trades for reliable signal.*\n`);
  }

  // ─── Outcome distribution ─────────────────────────────────
  lines.push(`\n## Outcome Distribution\n`);
  const byOutcome = groupBy(valid, (e) => e.trade.outcome || '?');
  lines.push(`| Outcome | Count | % |`);
  lines.push(`|---|---|---|`);
  for (const [o, items] of Object.entries(byOutcome)) {
    lines.push(`| ${o} | ${items.length} | ${pct(items.length, valid.length)} |`);
  }

  // ─── Recommendations (mechanical, based on data) ──────────
  lines.push(`\n## 🧭 Mechanical Recommendations\n`);
  lines.push(`*These are flags, not conclusions. With ${valid.length} trades, treat as hypotheses.*\n`);

  const flags = [];
  if (lossesPastTp.length / Math.max(losses.length, 1) >= 0.15) {
    flags.push(`🚩 **TRAILING STOP / PARTIAL CLOSE AT TP1** — ${lossesPastTp.length} losses (${pct(lossesPastTp.length, losses.length)}) actually touched TP price and then reversed into loss. Highest-leverage fix.`);
  }
  if (lossesNearTp.length / Math.max(losses.length, 1) >= 0.30) {
    flags.push(`🚩 **TP MAY BE TOO FAR** — ${lossesNearTp.length} losses reached ≥80% of TP distance. Consider TP at 0.7-0.8× current distance.`);
  }
  if (avg(maeLosses) != null && Math.abs(avg(maeLosses)) > 1.5 * Math.abs(avg(maeWins) || 0)) {
    flags.push(`🚩 **SL MAY BE TOO LOOSE** — losses tend to drift deep before hitting stop. Tighter SL could cap downside.`);
  }
  const longs  = byDir['long']  || [];
  const shorts = byDir['short'] || [];
  if (longs.length >= 5 && shorts.length >= 5) {
    const longWR  = longs.filter((e) => e.won).length / longs.length;
    const shortWR = shorts.filter((e) => e.won).length / shorts.length;
    if (Math.abs(longWR - shortWR) >= 0.25) {
      flags.push(`🚩 **DIRECTIONAL BIAS** — long WR ${fmtNum(longWR * 100)}% vs short WR ${fmtNum(shortWR * 100)}%. One side is dragging.`);
    }
  }
  // Confidence: if high-confidence trades aren't doing better, calibration is off
  const c80plus = valid.filter((e) => (e.trade.confidence || 0) >= 80);
  const c60to70 = valid.filter((e) => {
    const c = e.trade.confidence || 0;
    return c >= 60 && c < 70;
  });
  if (c80plus.length >= 5 && c60to70.length >= 5) {
    const wr80 = c80plus.filter((e) => e.won).length / c80plus.length;
    const wr60 = c60to70.filter((e) => e.won).length / c60to70.length;
    if (wr80 <= wr60) {
      flags.push(`🚩 **CONFIDENCE NOT PREDICTIVE** — 80%+ confidence WR (${fmtNum(wr80 * 100)}%) is not better than 60-69% (${fmtNum(wr60 * 100)}%). Confidence scoring needs recalibration.`);
    }
  }

  if (!flags.length) {
    lines.push(`No mechanical red flags found. Continue collecting data.\n`);
  } else {
    for (const f of flags) lines.push(`- ${f}\n`);
  }

  lines.push(`\n---\n*Apex Algo Fund · MAE/MFE Analyzer v1.0*\n`);

  return lines.join('\n');
}

function groupBy(arr, fn) {
  const out = {};
  for (const item of arr) {
    const k = fn(item);
    if (!out[k]) out[k] = [];
    out[k].push(item);
  }
  return out;
}

// ─── Run ─────────────────────────────────────────────────────
main().catch((err) => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});
