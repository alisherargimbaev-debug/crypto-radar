// ============================================================
//  STOCKS ENGINE — торговля акциями через Alpaca API
//  Часть AI Hedge Fund экосистемы
// ============================================================

const https = require('https');

const ALPACA_BASE      = 'https://paper-api.alpaca.markets'; // paper trading
const ALPACA_DATA_BASE = 'https://data.alpaca.markets';

// ── Акции для сканирования (топ ликвидные) ─────────────────
const STOCK_WATCHLIST = [
  'AAPL', 'MSFT', 'NVDA', 'TSLA', 'META',
  'GOOGL', 'AMZN', 'AMD', 'COIN', 'MSTR',
  'SPY', 'QQQ', 'SOXL', 'TQQQ', 'ARKK',
  'PLTR', 'HOOD', 'RBLX', 'SOFI', 'NIO',
];

// ── Торговые часы NYSE ─────────────────────────────────────
// 09:30 - 16:00 EST = 14:30 - 21:00 UTC = 19:30 - 02:00 Алматы
function isMarketOpen() {
  const now    = new Date();
  const utcH   = now.getUTCHours();
  const utcM   = now.getUTCMinutes();
  const utcMin = utcH * 60 + utcM;
  const day    = now.getUTCDay();

  // Выходные
  if (day === 0 || day === 6) return false;

  // 14:30 - 21:00 UTC
  return utcMin >= 870 && utcMin < 1260;
}

// ── HTTP helper ────────────────────────────────────────────
function alpacaGet(endpoint, apiKey, secretKey, baseUrl = ALPACA_BASE) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + endpoint);
    const req = https.request({
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method:   'GET',
      headers:  {
        'APCA-API-KEY-ID':     apiKey,
        'APCA-API-SECRET-KEY': secretKey,
        'Content-Type':        'application/json',
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Получить котировки ─────────────────────────────────────
async function getStockBars(symbol, apiKey, secretKey, timeframe = '1Hour', limit = 50) {
  try {
    const endpoint = `/v2/stocks/${symbol}/bars?timeframe=${timeframe}&limit=${limit}&feed=iex`;
    const data = await alpacaGet(endpoint, apiKey, secretKey, ALPACA_DATA_BASE);
    return data.bars || [];
  } catch(e) {
    console.error(`[STOCKS] getStockBars ${symbol}:`, e.message);
    return [];
  }
}

// ── Расчёт индикаторов ─────────────────────────────────────
function calcSMA_s(data, period) {
  if (data.length < period) return null;
  return data.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function calcRSI_s(bars, period = 14) {
  if (bars.length < period + 1) return 50;
  const closes = bars.map(b => b.c || b.close || b.vw);
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i-1];
    if (diff > 0) gains  += diff;
    else          losses -= diff;
  }
  const rs = losses === 0 ? 100 : gains / losses;
  return 100 - (100 / (1 + rs));
}

function calcATR_s(bars, period = 14) {
  if (bars.length < period) return 0;
  const trs = bars.slice(-period).map((b, i, arr) => {
    if (i === 0) return b.h - b.l;
    const prevClose = arr[i-1].c || arr[i-1].close;
    return Math.max(b.h - b.l, Math.abs(b.h - prevClose), Math.abs(b.l - prevClose));
  });
  return trs.reduce((a, b) => a + b, 0) / period;
}

// ════════════════════════════════════════════════════════════
//  СТРАТЕГИИ ДЛЯ АКЦИЙ
// ════════════════════════════════════════════════════════════

// ST1: Momentum Breakout
// Акция пробивает 20-дневный максимум на высоком объёме
function stratMomentumBreakout(bars, symbol) {
  if (bars.length < 25) return null;

  const closes  = bars.map(b => b.c);
  const volumes = bars.map(b => b.v);
  const current = bars[bars.length - 1];
  const price   = current.c;

  const high20   = Math.max(...closes.slice(-21, -1));
  const avgVol20 = volumes.slice(-21, -1).reduce((a,b) => a+b, 0) / 20;
  const rsi      = calcRSI_s(bars);

  // Пробой вверх + высокий объём + RSI не перекуплен
  if (price > high20 && current.v > avgVol20 * 1.5 && rsi < 75) {
    const atr  = calcATR_s(bars);
    const conf = 70
      + (current.v > avgVol20 * 2 ? 8 : 0)
      + (rsi > 50 && rsi < 65 ? 5 : 0)
      + ((price - high20) / high20 > 0.005 ? 4 : 0);

    return {
      strategy:  'ST1 Momentum Breakout',
      direction: 'long',
      symbol, price,
      confidence: Math.min(conf, 95),
      sl:  (price - atr * 1.5).toFixed(2),
      tp1: (price + atr * 2.0).toFixed(2),
      tp2: (price + atr * 3.5).toFixed(2),
      metrics: `High20: $${high20.toFixed(2)} | Vol: ${(current.v/avgVol20).toFixed(1)}x | RSI: ${rsi.toFixed(0)}`,
    };
  }
  return null;
}

// ST2: Mean Reversion
// Акция сильно упала от MA50, RSI перепродан — откат вверх
function stratMeanReversion(bars, symbol) {
  if (bars.length < 55) return null;

  const closes = bars.map(b => b.c);
  const price  = closes[closes.length - 1];
  const ma50   = calcSMA_s(closes, 50);
  const ma20   = calcSMA_s(closes, 20);
  const rsi    = calcRSI_s(bars);
  const atr    = calcATR_s(bars);

  if (!ma50 || !ma20) return null;

  const distFromMA50 = (price - ma50) / ma50 * 100;

  // Цена на 3%+ ниже MA50, RSI перепродан, MA20 выше цены (поддержка сверху)
  if (distFromMA50 < -3 && rsi < 35 && ma20 > ma50) {
    const conf = 68
      + (rsi < 25 ? 10 : rsi < 30 ? 6 : 0)
      + (distFromMA50 < -5 ? 7 : 0);

    return {
      strategy:  'ST2 Mean Reversion',
      direction: 'long',
      symbol, price,
      confidence: Math.min(conf, 95),
      sl:  (price - atr * 1.5).toFixed(2),
      tp1: (ma50 * 0.99).toFixed(2),          // цель — возврат к MA50
      tp2: (ma50 * 1.01).toFixed(2),
      metrics: `MA50: $${ma50.toFixed(2)} | Dist: ${distFromMA50.toFixed(1)}% | RSI: ${rsi.toFixed(0)}`,
    };
  }
  return null;
}

// ST3: Crypto Correlation
// Когда BTC растёт — COIN, MSTR, HOOD тоже должны расти
// Ищем отставшие акции для лонга
function stratCryptoCorrelation(bars, symbol, btcChange) {
  if (!['COIN', 'MSTR', 'HOOD', 'RIOT', 'MARA'].includes(symbol)) return null;
  if (bars.length < 20) return null;

  const closes   = bars.map(b => b.c);
  const price    = closes[closes.length - 1];
  const prevPrice = closes[closes.length - 2];
  const stockChange = (price - prevPrice) / prevPrice * 100;
  const rsi      = calcRSI_s(bars);
  const atr      = calcATR_s(bars);

  // BTC вырос 2%+, а акция отстала (выросла меньше 1%) → догонит
  if (btcChange > 2 && stockChange < 1 && rsi < 65) {
    const conf = 72 + (btcChange > 4 ? 8 : 4);
    return {
      strategy:  'ST3 Crypto Correlation',
      direction: 'long',
      symbol, price,
      confidence: Math.min(conf, 95),
      sl:  (price - atr * 1.5).toFixed(2),
      tp1: (price + atr * 2.0).toFixed(2),
      tp2: (price + atr * 3.0).toFixed(2),
      metrics: `BTC: +${btcChange.toFixed(1)}% | ${symbol}: +${stockChange.toFixed(1)}% | RSI: ${rsi.toFixed(0)}`,
    };
  }
  return null;
}

// ════════════════════════════════════════════════════════════
//  ГЛАВНАЯ ФУНКЦИЯ СКАНИРОВАНИЯ
// ════════════════════════════════════════════════════════════
async function scanStocks(apiKey, secretKey, btcChange = 0) {
  if (!isMarketOpen()) {
    console.log('[STOCKS] Рынок закрыт');
    return [];
  }

  const signals = [];

  for (const symbol of STOCK_WATCHLIST) {
    try {
      const bars = await getStockBars(symbol, apiKey, secretKey, '1Hour', 60);
      if (!bars.length) continue;

      const s1 = stratMomentumBreakout(bars, symbol);
      const s2 = stratMeanReversion(bars, symbol);
      const s3 = stratCryptoCorrelation(bars, symbol, btcChange);

      if (s1) signals.push(s1);
      if (s2) signals.push(s2);
      if (s3) signals.push(s3);

      // Небольшая пауза чтобы не перегружать API
      await new Promise(r => setTimeout(r, 200));
    } catch(e) {
      console.error(`[STOCKS] ${symbol}:`, e.message);
    }
  }

  // Сортируем по confidence
  return signals.sort((a, b) => b.confidence - a.confidence);
}

// ── Форматирование сигнала для Telegram ────────────────────
function formatStockSignal(sig) {
  const dirIcon = sig.direction === 'long' ? '🟢' : '🔴';
  const dirText = sig.direction === 'long' ? 'LONG' : 'SHORT';

  return (
    `📈 ${sig.symbol} — ${dirIcon} ${dirText}\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `📌 ${sig.strategy}\n` +
    `⚡ STOCKS | NYSE/NASDAQ\n\n` +
    `💰 Вход: $${sig.price}\n` +
    `🛡 Стоп-лосс: $${sig.sl}\n` +
    `🎯 Тейк-1 закрой 50%: $${sig.tp1}\n` +
    `🎯 Тейк-2 остаток: $${sig.tp2}\n\n` +
    `📊 Уверенность: ${sig.confidence}%\n\n` +
    `🔍 ${sig.metrics}\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `⚠️ Не финансовый совет. Paper trading.`
  );
}

module.exports = {
  scanStocks,
  formatStockSignal,
  isMarketOpen,
  STOCK_WATCHLIST,
};
