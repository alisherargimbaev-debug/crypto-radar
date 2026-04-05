require('dotenv').config();
const axios = require('axios');

// ── Настройки ──────────────────────────────────────────────
const COINS    = ['BTC-USDT-SWAP', 'ETH-USDT-SWAP', 'SOL-USDT-SWAP', 'XRP-USDT-SWAP', 'DOGE-USDT-SWAP'];
const BAR      = '1H';
const LIMIT    = 300; // ~12 дней на 1H

// ── HTTP ───────────────────────────────────────────────────
async function httpGet(url) {
  try {
    await new Promise(r => setTimeout(r, 500));
    const resp = await axios.get(url, { timeout: 30000 });
    return resp.data;
  } catch(e) {
    console.error(`[HTTP ERROR] ${url}: ${e.message}`);
    return null;
  }
}

async function getKlines(instId, bar, limit) {
  const data = await httpGet(`https://www.okx.com/api/v5/market/candles?instId=${instId}&bar=${bar}&limit=${limit}`);
  if (!data || data.code !== '0') return [];
  return data.data.reverse().map(c => ({
    ts: +c[0], open: +c[1], high: +c[2], low: +c[3], close: +c[4],
    volume: +c[5], quoteVolume: +c[7],
  }));
}

// ── Индикаторы ─────────────────────────────────────────────
function calcRSI(klines, period = 14) {
  const closes = klines.map(c => c.close);
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    d > 0 ? gains += d : losses -= d;
  }
  let ag = gains / period, al = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + (d > 0 ? d : 0)) / period;
    al = (al * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  return parseFloat((100 - 100 / (1 + (al === 0 ? 100 : ag / al))).toFixed(2));
}

function calcSMA(klines, period) {
  const closes = klines.map(c => c.close);
  if (closes.length < period) return closes[closes.length - 1] || 0;
  return closes.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function calcMACross(klines, fast, slow) {
  if (klines.length < slow + 1) return 'none';
  const closes = klines.map(c => c.close);
  const avg = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
  const fn = avg(closes.slice(-fast)), sn = avg(closes.slice(-slow));
  const fp = avg(closes.slice(-fast - 1, -1)), sp = avg(closes.slice(-slow - 1, -1));
  if (fp <= sp && fn > sn) return 'bullish';
  if (fp >= sp && fn < sn) return 'bearish';
  return 'none';
}

function calcATR(klines, period = 14) {
  if (klines.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < klines.length; i++) {
    const high = klines[i].high, low = klines[i].low, prev = klines[i-1].close;
    trs.push(Math.max(high - low, Math.abs(high - prev), Math.abs(low - prev)));
  }
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

// ── Симуляция исхода сделки ────────────────────────────────
function simulateTrade(entryPrice, direction, sl, tp1, tp2, futureCandles) {
  for (const candle of futureCandles) {
    if (direction === 'long') {
      if (candle.low  <= sl)  return { outcome: 'sl',  pnl: (sl  - entryPrice) / entryPrice * 100 };
      if (candle.high >= tp2) return { outcome: 'tp2', pnl: (tp2 - entryPrice) / entryPrice * 100 };
      if (candle.high >= tp1) return { outcome: 'tp1', pnl: (tp1 - entryPrice) / entryPrice * 100 };
    } else {
      if (candle.high >= sl)  return { outcome: 'sl',  pnl: (entryPrice - sl)  / entryPrice * 100 };
      if (candle.low  <= tp2) return { outcome: 'tp2', pnl: (entryPrice - tp2) / entryPrice * 100 };
      if (candle.low  <= tp1) return { outcome: 'tp1', pnl: (entryPrice - tp1) / entryPrice * 100 };
    }
  }
  return { outcome: 'expired', pnl: 0 };
}

// ── Стратегии ──────────────────────────────────────────────
function runS4(klines, i) {
  if (i < 55) return null;
  const slice = klines.slice(0, i + 1);
  const cross = calcMACross(slice, 20, 50);
  const rsi   = calcRSI(slice, 14);
  if (cross === 'bullish' && rsi < 55) return 'long';
  if (cross === 'bearish' && rsi > 45) return 'short';
  return null;
}

function runS5(klines, i) {
  if (i < 20) return null;
  const slice  = klines.slice(0, i + 1);
  const closes = slice.map(c => c.close);
  const lows   = slice.map(c => c.low);
  const rsiNow = calcRSI(slice, 14);
  const rsiPrev= calcRSI(slice.slice(0, -5), 14);

  const priceNewLow  = lows[lows.length-1] < Math.min(...lows.slice(-10, -1));
  const rsiHigher    = rsiNow > rsiPrev + 3;
  const priceNewHigh = closes[closes.length-1] > Math.max(...closes.slice(-10, -1));
  const rsiLower     = rsiNow < rsiPrev - 3;

  if (priceNewLow && rsiHigher && rsiNow < 45) return 'long';
  if (priceNewHigh && rsiLower && rsiNow > 55)  return 'short';
  return null;
}

function runS7(klines, i) {
  if (i < 10) return null;
  const slice   = klines.slice(0, i + 1);
  const last    = slice[slice.length - 1];
  const prev    = slice[slice.length - 2];
  const isBull  = last.close > last.open;
  const isBear  = last.close < last.open;
  const engulfL = isBull && prev.close < prev.open && last.open <= prev.close && last.close >= prev.open;
  const engulfS = isBear && prev.close > prev.open && last.open >= prev.close && last.close <= prev.open;
  if (!engulfL && !engulfS) return null;

  const avgVol  = slice.slice(-10, -1).reduce((a, c) => a + c.quoteVolume, 0) / 9;
  const lastVol = last.quoteVolume;
  if (lastVol < avgVol * 2.5) return null;

  return engulfL ? 'long' : 'short';
}

// ── Основная функция ───────────────────────────────────────
async function backtest() {
  console.log('🔬 BACKTESTING ЗАПУЩЕН\n');
  console.log(`📊 Монет: ${COINS.length} | Таймфрейм: ${BAR} | Свечей: ${LIMIT}\n`);
  console.log('━'.repeat(60));

  const strategies = {
    'S4 MA20/MA50+RSI': { signals: 0, wins: 0, losses: 0, expired: 0, pnl: 0, trades: [] },
    'S5 RSI Дивергенция': { signals: 0, wins: 0, losses: 0, expired: 0, pnl: 0, trades: [] },
    'S7 Поглощение':      { signals: 0, wins: 0, losses: 0, expired: 0, pnl: 0, trades: [] },
  };

  for (const instId of COINS) {
    const symbol = instId.replace('-USDT-SWAP', '');
    console.log(`\n⏳ Загружаем ${symbol}...`);
    const klines = await getKlines(instId, BAR, LIMIT);
    if (klines.length < 60) { console.log(`  ⚠️ Мало данных`); continue; }
    console.log(`  ✅ ${klines.length} свечей (${new Date(klines[0].ts).toLocaleDateString('ru')} — ${new Date(klines[klines.length-1].ts).toLocaleDateString('ru')})`);

    const runs = [
      { name: 'S4 MA20/MA50+RSI', fn: runS4 },
      { name: 'S5 RSI Дивергенция', fn: runS5 },
      { name: 'S7 Поглощение',      fn: runS7 },
    ];

    for (const { name, fn } of runs) {
      let lastSignalI = -10; // cooldown

      for (let i = 55; i < klines.length - 10; i++) {
        if (i - lastSignalI < 5) continue; // минимум 5 свечей между сигналами

        const direction = fn(klines, i);
        if (!direction) continue;

        const price  = klines[i].close;
        const atr    = calcATR(klines.slice(0, i + 1), 14);
        if (!atr) continue;

        const slDist  = atr * 1.5;
        const tp1Dist = atr * 3.0;
        const tp2Dist = atr * 4.5;

        const sl  = direction === 'long' ? price - slDist  : price + slDist;
        const tp1 = direction === 'long' ? price + tp1Dist : price - tp1Dist;
        const tp2 = direction === 'long' ? price + tp2Dist : price - tp2Dist;

        const future = klines.slice(i + 1, i + 25); // следующие 25 свечей (~25 часов)
        const result = simulateTrade(price, direction, sl, tp1, tp2, future);

        strategies[name].signals++;
        strategies[name].pnl += result.pnl;
        strategies[name].trades.push({ symbol, direction, price, outcome: result.outcome, pnl: result.pnl });

        if (result.outcome === 'tp1' || result.outcome === 'tp2') strategies[name].wins++;
        else if (result.outcome === 'sl') strategies[name].losses++;
        else strategies[name].expired++;

        lastSignalI = i;
      }
    }
  }

  // ── Результаты ─────────────────────────────────────────
  console.log('\n\n' + '═'.repeat(60));
  console.log('📊 РЕЗУЛЬТАТЫ BACKTESTING');
  console.log('═'.repeat(60));

  for (const [name, s] of Object.entries(strategies)) {
    if (s.signals === 0) { console.log(`\n${name}: нет сигналов`); continue; }
    const wr  = Math.round(s.wins / s.signals * 100);
    const pnl = s.pnl.toFixed(2);
    const avg = (s.pnl / s.signals).toFixed(2);
    const emoji = wr >= 55 ? '🟢' : wr >= 40 ? '🟡' : '🔴';

    console.log(`\n${emoji} ${name}`);
    console.log(`   Сигналов: ${s.signals} | ✅ TP: ${s.wins} | ❌ SL: ${s.losses} | ⏰ Expired: ${s.expired}`);
    console.log(`   Win Rate: ${wr}% | PnL: ${pnl >= 0 ? '+' : ''}${pnl}% | Avg/сделка: ${avg >= 0 ? '+' : ''}${avg}%`);

    // Топ монеты
    const bySymbol = {};
    s.trades.forEach(t => {
      if (!bySymbol[t.symbol]) bySymbol[t.symbol] = { wins: 0, total: 0 };
      bySymbol[t.symbol].total++;
      if (t.outcome === 'tp1' || t.outcome === 'tp2') bySymbol[t.symbol].wins++;
    });
    const sorted = Object.entries(bySymbol).sort((a, b) => b[1].wins/b[1].total - a[1].wins/a[1].total);
    console.log(`   Лучшие монеты: ${sorted.slice(0,3).map(([sym, d]) => `${sym} ${Math.round(d.wins/d.total*100)}%`).join(' | ')}`);
  }

  console.log('\n' + '═'.repeat(60));
  console.log('✅ Backtesting завершён');
}

backtest().catch(console.error);