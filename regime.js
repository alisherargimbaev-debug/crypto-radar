'use strict';

/**
 * Regime Detector — ADX/ATR based market state classification
 *
 * Pure functions only — no API calls, no global state.
 * Inject klines from outside; index.js handles caching and fetching.
 */

// ── ATR ───────────────────────────────────────────────────────
function calcATR(klines, period = 14) {
  if (!klines || klines.length < period + 1) return 0;
  const trs = [];
  for (let i = 1; i < klines.length; i++) {
    const high = klines[i]?.high;
    const low  = klines[i]?.low;
    const prev = klines[i - 1]?.close;
    if (high == null || low == null || prev == null) continue;
    trs.push(Math.max(high - low, Math.abs(high - prev), Math.abs(low - prev)));
  }
  if (!trs.length) return 0;
  return trs.slice(-period).reduce((a, b) => a + b, 0) / Math.min(trs.length, period);
}

// ── ADX ───────────────────────────────────────────────────────
function calcADX(klines, period = 14) {
  if (!klines || klines.length < period + 1) return 0;
  const trs = [], plusDMs = [], minusDMs = [];
  for (let i = 1; i < klines.length; i++) {
    const h  = klines[i]?.high;
    const l  = klines[i]?.low;
    const pc = klines[i - 1]?.close;
    const ph = klines[i - 1]?.high;
    const pl = klines[i - 1]?.low;
    if (h == null || l == null || pc == null || ph == null || pl == null) continue;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    const upMove   = h - ph;
    const downMove = pl - l;
    plusDMs.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDMs.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }
  if (trs.length < period) return 0;

  const smooth = (arr, p) => {
    let s = arr.slice(0, p).reduce((a, b) => a + b, 0);
    const res = [s];
    for (let i = p; i < arr.length; i++) {
      s = s - s / p + arr[i];
      res.push(s);
    }
    return res;
  };

  const atrS   = smooth(trs, period);
  const plusS  = smooth(plusDMs, period);
  const minusS = smooth(minusDMs, period);
  const dxArr  = atrS.map((a, i) => {
    const diPlus  = a ? plusS[i]  / a * 100 : 0;
    const diMinus = a ? minusS[i] / a * 100 : 0;
    const sum = diPlus + diMinus;
    return sum ? Math.abs(diPlus - diMinus) / sum * 100 : 0;
  });
  const slice = dxArr.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

// ── ATR-based average volatility ─────────────────────────────
function calcAtrAvg(klines, lookback = 20) {
  if (!klines || klines.length < 2) return 0;
  const slice = klines.slice(-lookback);
  let sum = 0, count = 0;
  for (let i = 1; i < slice.length; i++) {
    const diff = Math.abs((slice[i]?.close || 0) - (slice[i - 1]?.close || 0));
    sum += diff;
    count++;
  }
  return count ? sum / count : 0;
}

// ── Regime classifier (pure — no async) ──────────────────────
/**
 * @param {number} adx1h  - ADX on 1H timeframe
 * @param {number} adx4h  - ADX on 4H timeframe
 * @param {number} atr    - ATR(14) on 1H
 * @param {number} atrAvg - avg close-to-close move over last 20 bars
 * @param {number} price  - current price
 * @param {number|null} ma200 - 200-period SMA on daily (null = unknown)
 * @returns regime object
 */
function detectRegime(adx1h, adx4h, atr, atrAvg, price, ma200) {
  // 4H weighted average (more reliable for trend strength)
  const adx = adx1h * 0.35 + adx4h * 0.65;

  return {
    adx,
    adx1h,
    adx4h,
    isTrending:    adx > 25,
    isSideways:    adx < 20,
    isHighVol:     atrAvg > 0 && atr > atrAvg * 1.8,
    isBearMkt:     ma200 != null ? price < ma200 : false,
    isStrongTrend: adx4h > 30,
    ma200,
    price,
  };
}

// ── Null-safe regime fallback ─────────────────────────────────
function neutralRegime() {
  return {
    adx: 0, adx1h: 0, adx4h: 0,
    isTrending: false, isSideways: true,
    isHighVol: false, isBearMkt: false, isStrongTrend: false,
    ma200: null, price: 0,
  };
}

module.exports = { calcADX, calcATR, calcAtrAvg, detectRegime, neutralRegime };
