/**
 * APEX ALGO FUND — Footprint Chart Engine
 * ─────────────────────────────────────────────────────────────
 * Собирает тиковые данные через OKX WebSocket и агрегирует их
 * по ценовым уровням внутри каждой свечи (footprint).
 *
 * Что считаем:
 *  - bidVol / askVol на каждом ценовом уровне
 *  - Delta (askVol - bidVol) на уровне и за свечу
 *  - Imbalance zones (покупок в 3x+ больше продаж и наоборот)
 *  - POC (Point of Control) — уровень с макс объёмом
 *  - Unfinished auction — цена ушла не завершив торги на уровне
 *
 * Использование в pipeline:
 *  const fp = footprint.getFootprint('BTC-USDT-SWAP', gexLevel);
 *  if (fp.imbalanceBullish) signal.confidence += 12;
 */

'use strict';

const WebSocket = require('ws');
const EventEmitter = require('events');

// ── Настройки ─────────────────────────────────────────────────
const OKX_WS_URL      = 'wss://ws.okx.com:8443/ws/v5/public';
const TICK_SIZE_MAP   = {
  'BTC-USDT-SWAP':  1,       // $1 на уровень
  'ETH-USDT-SWAP':  0.1,
  'SOL-USDT-SWAP':  0.01,
  'BNB-USDT-SWAP':  0.1,
  'XRP-USDT-SWAP':  0.0001,
  'default':        0.01,
};
const CANDLE_MS       = 15 * 60 * 1000;  // 15 минут = 1 свеча
const MAX_CANDLES     = 10;              // храним 10 свечей на монету
const IMBALANCE_RATIO = 3.0;            // imbalance если bid/ask >= 3x
const MIN_TRADES      = 20;             // минимум тиков для валидного footprint

// ── Структура свечи ───────────────────────────────────────────
function newCandle(openTime) {
  return {
    openTime,                  // timestamp начала свечи
    closeTime: null,
    levels: {},                // { priceLevel: { bid, ask, total } }
    totalBid:  0,
    totalAsk:  0,
    totalDelta: 0,
    tradesCount: 0,
    poc: null,                 // Point of Control (уровень макс объёма)
    high: -Infinity,
    low:  +Infinity,
    open: null,
    close: null,
  };
}

// ── Основной класс ────────────────────────────────────────────
class FootprintEngine extends EventEmitter {
  constructor() {
    super();
    this.ws       = null;
    this.coins    = new Set();
    this.candles  = {};       // { instId: [candle, ...] }
    this.current  = {};       // { instId: candle } — текущая незакрытая свеча
    this.ready    = false;
    this._reconnectTimer = null;
    this._pingInterval   = null;
  }

  // ── Запуск ────────────────────────────────────────────────
  start(instIds = []) {
    instIds.forEach(id => this.coins.add(id));
    this._connect();
  }

  addCoin(instId) {
    if (this.coins.has(instId)) return;
    this.coins.add(instId);
    this._subscribe([instId]);
    // инициализируем структуры
    if (!this.candles[instId])  this.candles[instId]  = [];
    if (!this.current[instId])  this.current[instId]  = newCandle(this._candleStart());
  }

  isReady() { return this.ready; }

  // ── WebSocket ─────────────────────────────────────────────
  _connect() {
    try {
      this.ws = new WebSocket(OKX_WS_URL);

      this.ws.on('open', () => {
        console.log('[FOOTPRINT] WebSocket connected');
        this.ready = true;
        this._subscribe([...this.coins]);
        this._startPing();
      });

      this.ws.on('message', (raw) => {
        try { this._onMessage(JSON.parse(raw)); }
        catch(e) { /* ignore parse errors */ }
      });

      this.ws.on('error', (e) => {
        console.error('[FOOTPRINT] WS error:', e.message);
      });

      this.ws.on('close', () => {
        console.log('[FOOTPRINT] WS closed — reconnecting in 5s');
        this.ready = false;
        this._stopPing();
        this._reconnectTimer = setTimeout(() => this._connect(), 5000);
      });
    } catch(e) {
      console.error('[FOOTPRINT] connect error:', e.message);
      setTimeout(() => this._connect(), 5000);
    }
  }

  _subscribe(instIds) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const args = instIds.map(id => ({ channel: 'trades', instId: id }));
    if (!args.length) return;
    this.ws.send(JSON.stringify({ op: 'subscribe', args }));
  }

  _startPing() {
    this._pingInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send('ping');
      }
    }, 25000);
  }

  _stopPing() {
    if (this._pingInterval) { clearInterval(this._pingInterval); this._pingInterval = null; }
  }

  // ── Обработка тика ────────────────────────────────────────
  _onMessage(msg) {
    if (msg.event) return; // subscribe confirmations
    if (!msg.data?.length) return;

    const instId = msg.arg?.instId;
    if (!instId || !this.coins.has(instId)) return;

    for (const trade of msg.data) {
      this._processTrade(instId, trade);
    }
  }

  _processTrade(instId, trade) {
    // OKX trade format: { tradeId, instId, px, sz, side, ts }
    const price = parseFloat(trade.px);
    const size  = parseFloat(trade.sz);  // contracts
    const side  = trade.side;            // 'buy' или 'sell'
    const ts    = parseInt(trade.ts);

    if (!price || !size || !side) return;

    // Инициализируем если нужно
    if (!this.current[instId]) {
      this.current[instId] = newCandle(this._candleStart(ts));
    }
    if (!this.candles[instId]) {
      this.candles[instId] = [];
    }

    // Проверяем смену свечи
    const candleStart = this._candleStart(ts);
    if (candleStart > this.current[instId].openTime) {
      this._closeCandle(instId);
      this.current[instId] = newCandle(candleStart);
    }

    const candle = this.current[instId];
    const tick   = TICK_SIZE_MAP[instId] || TICK_SIZE_MAP.default;

    // Округляем цену до ближайшего tick level
    const level  = (Math.round(price / tick) * tick).toFixed(
      tick < 1 ? String(tick).split('.')[1]?.length || 2 : 0
    );

    // Агрегируем на уровне
    if (!candle.levels[level]) {
      candle.levels[level] = { bid: 0, ask: 0, total: 0 };
    }

    const notional = price * size; // в USDT

    if (side === 'buy') {
      candle.levels[level].ask   += notional;  // покупки = агрессивный ask
      candle.totalAsk            += notional;
      candle.totalDelta          += notional;
    } else {
      candle.levels[level].bid   += notional;  // продажи = агрессивный bid
      candle.totalBid            += notional;
      candle.totalDelta          -= notional;
    }
    candle.levels[level].total += notional;

    // OHLC
    if (!candle.open)          candle.open  = price;
    candle.close             = price;
    if (price > candle.high)   candle.high  = price;
    if (price < candle.low)    candle.low   = price;
    candle.tradesCount++;

    // Обновляем POC
    candle.poc = this._calcPOC(candle);
  }

  _closeCandle(instId) {
    const candle = this.current[instId];
    if (!candle || candle.tradesCount < MIN_TRADES) return;

    candle.closeTime = Date.now();
    candle.poc       = this._calcPOC(candle);

    this.candles[instId].push(candle);
    if (this.candles[instId].length > MAX_CANDLES) {
      this.candles[instId].shift();
    }

    this.emit('candle_closed', { instId, candle });
    console.log(`[FOOTPRINT] ${instId} свеча закрыта: delta=${(candle.totalDelta/1000).toFixed(0)}K trades=${candle.tradesCount} poc=${candle.poc}`);
  }

  _calcPOC(candle) {
    let maxVol = 0, poc = null;
    for (const [level, data] of Object.entries(candle.levels)) {
      if (data.total > maxVol) { maxVol = data.total; poc = parseFloat(level); }
    }
    return poc;
  }

  _candleStart(ts = Date.now()) {
    return Math.floor(ts / CANDLE_MS) * CANDLE_MS;
  }

  // ── Публичные методы ──────────────────────────────────────

  /**
   * Получить footprint анализ для конкретного ценового уровня (GEX)
   * Главный метод для использования в pipeline
   */
  getFootprintAtLevel(instId, gexLevel, tolerancePct = 0.005) {
    const candle = this.current[instId];
    if (!candle || candle.tradesCount < MIN_TRADES) return null;

    const tolerance = gexLevel * tolerancePct;
    const nearby = Object.entries(candle.levels).filter(([lvl]) => {
      return Math.abs(parseFloat(lvl) - gexLevel) <= tolerance;
    });

    if (!nearby.length) return null;

    const aggBid = nearby.reduce((s, [, d]) => s + d.bid, 0);
    const aggAsk = nearby.reduce((s, [, d]) => s + d.ask, 0);
    const total  = aggBid + aggAsk;

    if (!total) return null;

    const delta          = aggAsk - aggBid;
    const imbalanceLong  = aggAsk >= aggBid * IMBALANCE_RATIO; // покупатели доминируют
    const imbalanceShort = aggBid >= aggAsk * IMBALANCE_RATIO; // продавцы доминируют

    return {
      level:          gexLevel,
      bid:            aggBid,
      ask:            aggAsk,
      delta,
      deltaRatio:     delta / total,         // -1 = все продают, +1 = все покупают
      imbalanceLong,
      imbalanceShort,
      strength:       Math.abs(delta) / total, // 0-1, насколько сильный дисбаланс
      tradesNearby:   nearby.length,
      totalVolume:    total,
    };
  }

  /**
   * Полный анализ текущей свечи — для общего pipeline
   */
  getFootprint(instId) {
    const candle = this.current[instId];
    if (!candle || candle.tradesCount < MIN_TRADES) return null;

    const levels = Object.entries(candle.levels);

    // Imbalance zones — уровни с сильным дисбалансом
    const bullishImbalances = [];
    const bearishImbalances = [];

    for (const [lvl, d] of levels) {
      if (d.ask >= d.bid * IMBALANCE_RATIO && d.total > 0) {
        bullishImbalances.push({ price: parseFloat(lvl), bid: d.bid, ask: d.ask, ratio: d.ask / (d.bid || 1) });
      }
      if (d.bid >= d.ask * IMBALANCE_RATIO && d.total > 0) {
        bearishImbalances.push({ price: parseFloat(lvl), bid: d.bid, ask: d.ask, ratio: d.bid / (d.ask || 1) });
      }
    }

    // Unfinished auction — POC текущей свечи далеко от close
    // Цена вернётся к нему в следующей свече
    const unfinishedAuction = candle.poc && candle.close
      ? Math.abs(candle.poc - candle.close) / candle.close > 0.003
      : false;

    // Накопление vs распределение
    const isAccumulation  = candle.totalDelta > 0 && candle.close >= candle.open; // растём с покупками
    const isDistribution  = candle.totalDelta < 0 && candle.close <= candle.open; // падаем с продажами

    // Скрытое давление (hidden pressure)
    // Свеча растёт, но delta отрицательная → скрытые продавцы → опасно
    const hiddenSelling = candle.close > candle.open && candle.totalDelta < -candle.totalAsk * 0.3;
    const hiddenBuying  = candle.close < candle.open && candle.totalDelta > candle.totalBid * 0.3;

    const totalVol = candle.totalBid + candle.totalAsk;

    return {
      // Базовые данные
      open:           candle.open,
      high:           candle.high,
      low:            candle.low,
      close:          candle.close,
      poc:            candle.poc,
      tradesCount:    candle.tradesCount,

      // Объёмы
      totalBid:       candle.totalBid,
      totalAsk:       candle.totalAsk,
      totalVolume:    totalVol,
      delta:          candle.totalDelta,
      deltaRatio:     totalVol ? candle.totalDelta / totalVol : 0,

      // Imbalances
      bullishImbalances,  // уровни с доминированием покупателей
      bearishImbalances,  // уровни с доминированием продавцов
      imbalanceBullish:   bullishImbalances.length >= 2,
      imbalanceBearish:   bearishImbalances.length >= 2,

      // Паттерны
      unfinishedAuction,
      isAccumulation,
      isDistribution,
      hiddenSelling,
      hiddenBuying,
    };
  }

  /**
   * Последние N закрытых свечей (для анализа тренда)
   */
  getClosedCandles(instId, n = 3) {
    return (this.candles[instId] || []).slice(-n);
  }

  /**
   * Delta divergence через footprint:
   * цена растёт, но cumulative delta падает → разворот
   */
  getFootprintDivergence(instId) {
    const closed = this.getClosedCandles(instId, 4);
    if (closed.length < 3) return null;

    const prices = closed.map(c => c.close);
    const deltas = closed.map(c => c.totalDelta);

    const priceUp   = prices[prices.length-1] > prices[0];
    const deltaDown = deltas[deltas.length-1] < deltas[0];
    const priceDown = prices[prices.length-1] < prices[0];
    const deltaUp   = deltas[deltas.length-1] > deltas[0];

    if (priceUp && deltaDown) return { type: 'bearish', strength: 'medium' };
    if (priceDown && deltaUp) return { type: 'bullish', strength: 'medium' };
    return null;
  }

  stop() {
    this._stopPing();
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    if (this.ws) { this.ws.removeAllListeners(); this.ws.terminate(); }
    this.ready = false;
  }
}

module.exports = new FootprintEngine();
