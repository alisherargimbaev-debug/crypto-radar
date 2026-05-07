// ============================================================
// bybit-client.js — Обёртка над Bybit V5 API для Crypto Radar
// Использует официальный npm-пакет: npm install bybit-api
// ============================================================

const { RestClientV5 } = require('bybit-api');

class BybitClient {
  constructor() {
    const testnet = process.env.BYBIT_TESTNET === 'true';

    this.client = new RestClientV5({
      key: process.env.BYBIT_API_KEY,
      secret: process.env.BYBIT_API_SECRET,
      testnet,
      recv_window: 5000,
    });

    this.env = testnet ? 'TESTNET' : 'LIVE';
    console.log(`[BybitClient] Initialized on ${this.env}`);
  }

  // ─── Баланс аккаунта ───────────────────────────────────────
  async getBalance(coin = 'USDT') {
    try {
      const res = await this.client.getWalletBalance({ accountType: 'UNIFIED' });
      this._checkResponse(res, 'getBalance');

      const account = res.result.list?.[0];
      if (!account) return { total: 0, available: 0 };

      const coinData = account.coin?.find((c) => c.coin === coin);
      return {
        total: parseFloat(account.totalEquity || '0'),
        available: parseFloat(coinData?.availableToWithdraw || '0'),
        walletBalance: parseFloat(coinData?.walletBalance || '0'),
      };
    } catch (err) {
      console.error('[BybitClient] getBalance error:', err.message);
      return null;
    }
  }

  // ─── Информация об инструменте (шаг цены, лота) ────────────
  async getInstrumentInfo(symbol) {
    try {
      const res = await this.client.getInstrumentsInfo({
        category: 'linear',
        symbol,
      });
      this._checkResponse(res, 'getInstrumentInfo');

      const info = res.result.list?.[0];
      if (!info) return null;

      return {
        symbol: info.symbol,
        minQty: parseFloat(info.lotSizeFilter?.minOrderQty || '0.001'),
        qtyStep: parseFloat(info.lotSizeFilter?.qtyStep || '0.001'),
        minPrice: parseFloat(info.priceFilter?.minPrice || '0.01'),
        tickSize: parseFloat(info.priceFilter?.tickSize || '0.01'),
        maxLeverage: parseFloat(info.leverageFilter?.maxLeverage || '100'),
      };
    } catch (err) {
      console.error(`[BybitClient] getInstrumentInfo(${symbol}) error:`, err.message);
      return null;
    }
  }

  // ─── Текущая цена (последняя сделка) ───────────────────────
  async getLastPrice(symbol) {
    try {
      const res = await this.client.getTickers({ category: 'linear', symbol });
      this._checkResponse(res, 'getLastPrice');

      const ticker = res.result.list?.[0];
      return ticker ? parseFloat(ticker.lastPrice) : null;
    } catch (err) {
      console.error(`[BybitClient] getLastPrice(${symbol}) error:`, err.message);
      return null;
    }
  }

  // ─── Открыть рыночный ордер ─────────────────────────────────
  async placeMarketOrder({ symbol, side, qty, takeProfit, stopLoss, orderLinkId }) {
    try {
      const params = {
        category: 'linear',
        symbol,
        side,               // 'Buy' или 'Sell'
        orderType: 'Market',
        qty: String(qty),
        timeInForce: 'GTC',
        positionIdx: 0,     // One-way mode
      };

      // SL и TP прямо в ордере (Bybit V5 поддерживает)
      if (stopLoss) params.stopLoss = String(stopLoss);
      if (takeProfit) params.takeProfit = String(takeProfit);
      if (orderLinkId) params.orderLinkId = orderLinkId;

      console.log(`[BybitClient] Placing ${side} market order:`, { symbol, qty, stopLoss, takeProfit });

      const res = await this.client.submitOrder(params);
      this._checkResponse(res, 'placeMarketOrder');

      return {
        orderId: res.result.orderId,
        orderLinkId: res.result.orderLinkId,
      };
    } catch (err) {
      console.error(`[BybitClient] placeMarketOrder error:`, err.message);
      return null;
    }
  }

  // ─── Изменить SL/TP существующей позиции ───────────────────
  async setTradingStop({ symbol, stopLoss, takeProfit, positionIdx = 0 }) {
    try {
      const params = {
        category: 'linear',
        symbol,
        positionIdx,
      };
      if (stopLoss) params.stopLoss = String(stopLoss);
      if (takeProfit) params.takeProfit = String(takeProfit);

      const res = await this.client.setTradingStop(params);
      this._checkResponse(res, 'setTradingStop');
      return true;
    } catch (err) {
      console.error(`[BybitClient] setTradingStop error:`, err.message);
      return false;
    }
  }

  // ─── Получить открытые позиции ──────────────────────────────
  async getPositions(symbol) {
    try {
      const params = { category: 'linear', settleCoin: 'USDT' };
      if (symbol) params.symbol = symbol;

      const res = await this.client.getPositionInfo(params);
      this._checkResponse(res, 'getPositions');

      // Фильтруем только реально открытые (size > 0)
      return (res.result.list || []).filter(
        (p) => parseFloat(p.size) > 0
      ).map((p) => ({
        symbol: p.symbol,
        side: p.side,
        size: parseFloat(p.size),
        entryPrice: parseFloat(p.avgPrice),
        markPrice: parseFloat(p.markPrice),
        unrealisedPnl: parseFloat(p.unrealisedPnl),
        stopLoss: parseFloat(p.stopLoss || '0'),
        takeProfit: parseFloat(p.takeProfit || '0'),
        leverage: p.leverage,
        createdTime: parseInt(p.createdTime),
      }));
    } catch (err) {
      console.error('[BybitClient] getPositions error:', err.message);
      return [];
    }
  }

  // ─── Закрыть позицию рыночным ордером ──────────────────────
  async closePosition(symbol, side, qty) {
    try {
      // Чтобы закрыть: если были Buy → делаем Sell, и наоборот
      const closeSide = side === 'Buy' ? 'Sell' : 'Buy';

      const res = await this.client.submitOrder({
        category: 'linear',
        symbol,
        side: closeSide,
        orderType: 'Market',
        qty: String(qty),
        timeInForce: 'GTC',
        reduceOnly: true,
        positionIdx: 0,
      });
      this._checkResponse(res, 'closePosition');
      return res.result;
    } catch (err) {
      console.error(`[BybitClient] closePosition error:`, err.message);
      return null;
    }
  }

  // ─── Получить историю закрытых PnL ─────────────────────────
  async getClosedPnl(symbol, limit = 5) {
    try {
      const res = await this.client.getClosedPnL({
        category: 'linear',
        symbol,
        limit,
      });
      this._checkResponse(res, 'getClosedPnl');
      return res.result.list || [];
    } catch (err) {
      console.error('[BybitClient] getClosedPnl error:', err.message);
      return [];
    }
  }

  // ─── Установить кредитное плечо ────────────────────────────
  async setLeverage(symbol, leverage) {
    try {
      const res = await this.client.setLeverage({
        category: 'linear',
        symbol,
        buyLeverage: String(leverage),
        sellLeverage: String(leverage),
      });
      // 110043 = leverage not modified (уже установлен) — не ошибка
      if (res.retCode !== 0 && res.retCode !== 110043) {
        console.warn(`[BybitClient] setLeverage warning: ${res.retMsg}`);
      }
      return true;
    } catch (err) {
      console.error(`[BybitClient] setLeverage error:`, err.message);
      return false;
    }
  }

  // ─── Проверка ответа API ───────────────────────────────────
  _checkResponse(res, method) {
    if (res.retCode !== 0) {
      throw new Error(`[${method}] API error ${res.retCode}: ${res.retMsg}`);
    }
  }
}

module.exports = BybitClient;
