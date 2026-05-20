/**
 * Delta Tracker — реальный Delta Profile через OKX WebSocket
 *
 * Подписывается на trade stream OKX и накапливает:
 * - Cumulative Delta (CVD) — накопленная разница buy/sell объёмов
 * - Delta по ценовым уровням (Delta Profile)
 * - Absorption detection — высокий объём без движения цены
 *
 * Данные хранятся в памяти за последние N минут для каждой монеты.
 */

'use strict';

const WebSocket = require('ws');

// ── Конфиг ───────────────────────────────────────────────────
const OKX_WS_URL    = 'wss://ws.okx.com:8443/ws/v5/public';
const MAX_TRADES    = 500;   // максимум сделок в истории на монету
const RETAIN_MS     = 30 * 60 * 1000; // храним данные 30 минут
const RECONNECT_MS  = 5000;

// ── Хранилище данных ─────────────────────────────────────────
// instId → { trades: [], cvd: number, lastPrice: number }
const deltaStore = new Map();

// Список монет для подписки (добавляются динамически)
const subscribedCoins = new Set();

let ws = null;
let reconnectTimer = null;
let isConnected = false;

// ── Инициализация монеты ─────────────────────────────────────
function ensureStore(instId) {
  if (!deltaStore.has(instId)) {
    deltaStore.set(instId, {
      trades:    [],   // { ts, side, price, size }
      cvd:       0,    // Cumulative Volume Delta
      lastPrice: 0,
    });
  }
  return deltaStore.get(instId);
}

// ── Подключение к OKX WebSocket ──────────────────────────────
function connect() {
  if (ws) {
    try { ws.terminate(); } catch(_) {}
    ws = null;
  }

  console.log('[DeltaTracker] Подключение к OKX WebSocket...');
  ws = new WebSocket(OKX_WS_URL);

  ws.on('open', () => {
    isConnected = true;
    console.log('[DeltaTracker] ✅ Подключено к OKX WS');
    // Переподписываемся на все монеты
    if (subscribedCoins.size > 0) {
      subscribeToCoins([...subscribedCoins]);
    }
    // Пинг каждые 25 секунд
    setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) ws.send('ping');
    }, 25000);
  });

  ws.on('message', (raw) => {
    if (raw === 'pong') return;
    try {
      const msg = JSON.parse(raw);
      if (msg.event) return; // subscribe/error events
      if (msg.arg?.channel === 'trades' && msg.data) {
        processTrades(msg.arg.instId, msg.data);
      }
    } catch(_) {}
  });

  ws.on('close', () => {
    isConnected = false;
    console.log('[DeltaTracker] ❌ WS закрыт — переподключение через', RECONNECT_MS/1000, 'сек');
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, RECONNECT_MS);
  });

  ws.on('error', (e) => {
    console.error('[DeltaTracker] WS error:', e.message);
  });
}

// ── Подписка на монеты ───────────────────────────────────────
function subscribeToCoins(instIds) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const args = instIds.map(id => ({ channel: 'trades', instId: id }));
  ws.send(JSON.stringify({ op: 'subscribe', args }));
  console.log('[DeltaTracker] Подписались на', instIds.length, 'монет');
}

// ── Добавление монеты ────────────────────────────────────────
function addCoin(instId) {
  if (subscribedCoins.has(instId)) return;
  subscribedCoins.add(instId);
  ensureStore(instId);
  if (isConnected) subscribeToCoins([instId]);
}

// ── Обработка входящих сделок ────────────────────────────────
function processTrades(instId, trades) {
  const store = ensureStore(instId);
  const now   = Date.now();

  for (const t of trades) {
    const side  = t.side; // 'buy' или 'sell'
    const price = parseFloat(t.px);
    const size  = parseFloat(t.sz);

    // Добавляем в историю
    store.trades.push({ ts: parseInt(t.ts || now), side, price, size });

    // Обновляем CVD
    store.cvd      += side === 'buy' ? size : -size;
    store.lastPrice = price;
  }

  // Чистим старые сделки
  const cutoff = now - RETAIN_MS;
  store.trades = store.trades.filter(t => t.ts > cutoff);
  if (store.trades.length > MAX_TRADES) {
    store.trades = store.trades.slice(-MAX_TRADES);
  }
}

// ── Аналитика ────────────────────────────────────────────────

/**
 * Получить Delta за последние N минут
 * @returns { delta, buyVol, sellVol, cvd, absorption, deltaProfile }
 */
function getDelta(instId, minutes = 15) {
  const store = deltaStore.get(instId);
  if (!store || !store.trades.length) return null;

  const cutoff = Date.now() - minutes * 60000;
  const recent = store.trades.filter(t => t.ts > cutoff);
  if (!recent.length) return null;

  let buyVol  = 0;
  let sellVol = 0;
  let delta   = 0;

  for (const t of recent) {
    if (t.side === 'buy') {
      buyVol += t.size;
      delta  += t.size;
    } else {
      sellVol += t.size;
      delta   -= t.size;
    }
  }

  const totalVol = buyVol + sellVol;
  const deltaRatio = totalVol > 0 ? delta / totalVol : 0; // -1 до +1

  // Delta Profile — delta по ценовым зонам (10 зон)
  const prices = recent.map(t => t.price);
  const priceHigh = Math.max(...prices);
  const priceLow  = Math.min(...prices);
  const range     = priceHigh - priceLow;
  const ZONES     = 10;
  const deltaProfile = new Array(ZONES).fill(0);

  if (range > 0) {
    const zoneSize = range / ZONES;
    for (const t of recent) {
      const z = Math.min(Math.floor((t.price - priceLow) / zoneSize), ZONES - 1);
      deltaProfile[z] += t.side === 'buy' ? t.size : -t.size;
    }
  }

  // Absorption detection:
  // Высокий объём (>1.5x avg) в зонах где delta близка к нулю
  const avgZoneVol = recent.length / ZONES;
  const absorptionZones = deltaProfile.filter((d, i) => {
    const zoneTradeCount = recent.filter(t => {
      const z = range > 0 ? Math.min(Math.floor((t.price - priceLow) / (range / ZONES)), ZONES - 1) : 0;
      return z === i;
    }).length;
    return zoneTradeCount > avgZoneVol * 1.5 && Math.abs(d) < avgZoneVol * 0.2;
  }).length;

  return {
    delta,
    buyVol,
    sellVol,
    totalVol,
    deltaRatio,         // -1 (все продавцы) до +1 (все покупатели)
    cvd: store.cvd,
    absorption: absorptionZones > 0,  // есть ли зоны поглощения
    absorptionZones,
    deltaProfile,
    priceHigh,
    priceLow,
    tradesCount: recent.length,
  };
}

/**
 * Delta divergence — цена растёт но delta падает (или наоборот)
 * Это сигнал слабости текущего движения
 */
function getDeltaDivergence(instId) {
  const store = deltaStore.get(instId);
  if (!store || store.trades.length < 20) return null;

  // Разбиваем последние сделки на 3 периода
  const all    = store.trades.slice(-60);
  const third  = Math.floor(all.length / 3);
  if (third < 5) return null;

  const p1 = all.slice(0, third);
  const p3 = all.slice(-third);

  const calcDelta = trades => trades.reduce((s,t) => s + (t.side==='buy'?t.size:-t.size), 0);
  const calcAvgPrice = trades => trades.reduce((s,t) => s + t.price, 0) / trades.length;

  const delta1 = calcDelta(p1);
  const delta3 = calcDelta(p3);
  const price1 = calcAvgPrice(p1);
  const price3 = calcAvgPrice(p3);

  const priceUp   = price3 > price1;
  const deltaUp   = delta3 > delta1;

  // Bullish divergence: цена падает, delta растёт → разворот вверх
  // Bearish divergence: цена растёт, delta падает → разворот вниз
  if (!priceUp && deltaUp)  return { type: 'bullish', strength: Math.abs(delta3 - delta1) };
  if (priceUp && !deltaUp)  return { type: 'bearish', strength: Math.abs(delta3 - delta1) };
  return null;
}

/**
 * Snapshot текущего состояния для мониторинга
 */
function getSnapshot(instId) {
  const store = deltaStore.get(instId);
  if (!store) return null;
  return {
    instId,
    cvd:        store.cvd,
    lastPrice:  store.lastPrice,
    tradesCount: store.trades.length,
    delta15m:   getDelta(instId, 15),
    divergence: getDeltaDivergence(instId),
  };
}

function getSubscribedCount() { return subscribedCoins.size; }
function isReady() { return isConnected && subscribedCoins.size > 0; }

// ── Запуск ───────────────────────────────────────────────────
function start(initialCoins = []) {
  // Проверяем ws библиотеку
  try {
    require('ws');
  } catch(e) {
    console.error('[DeltaTracker] ws не установлен — delta tracking отключён');
    return;
  }

  for (const c of initialCoins) {
    subscribedCoins.add(c);
    ensureStore(c);
  }
  connect();
  console.log('[DeltaTracker] Запущен с', initialCoins.length, 'монетами');
}

module.exports = {
  start,
  addCoin,
  getDelta,
  getDeltaDivergence,
  getSnapshot,
  getSubscribedCount,
  isReady,
};
