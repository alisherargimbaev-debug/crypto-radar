// ============================================================
// autoexec.js — Модуль автоматического исполнения сигналов
// Дочерний модуль к Crypto Radar
//
// Подключение из index.js (ОДНА строка в конце):
//   if (process.env.AUTO_EXECUTE === 'true') require('./autoexec');
//
// npm install bybit-api
//
// ENV переменные (добавить в Render):
//   BYBIT_API_KEY=...
//   BYBIT_API_SECRET=...
//   BYBIT_TESTNET=true          ← true для тестов!
//   AUTO_EXECUTE=false           ← false по умолчанию
//   AUTO_RISK_PCT=1.0            ← % от баланса на сделку
//   AUTO_MAX_POSITIONS=2         ← макс. одновременных позиций
//   AUTO_DAILY_LOSS_LIMIT=-3.0   ← дневной лимит потерь %
//   AUTO_MIN_CONFIDENCE=80       ← минимальный confidence сигнала
//   AUTO_DEFAULT_LEVERAGE=5      ← кредитное плечо
// ============================================================

const { EventEmitter } = require('events');
const BybitClient = require('./bybit-client');

// ─── Event bus: index.js будет emit-ить сигналы сюда ─────────
const signals = new EventEmitter();
module.exports = { signals };

// ─── Константы безопасности ──────────────────────────────────
const RISK_PCT = parseFloat(process.env.AUTO_RISK_PCT) || 1.0;
const MAX_POSITIONS = parseInt(process.env.AUTO_MAX_POSITIONS) || 2;
const DAILY_LOSS_LIMIT = parseFloat(process.env.AUTO_DAILY_LOSS_LIMIT) || -3.0;
const MIN_CONFIDENCE = parseFloat(process.env.AUTO_MIN_CONFIDENCE) || 80;
const DEFAULT_LEVERAGE = parseInt(process.env.AUTO_DEFAULT_LEVERAGE) || 5;
const MONITOR_INTERVAL_MS = 30_000;  // 30 секунд
const TESTNET = process.env.BYBIT_TESTNET === 'true';

// ─── Состояние модуля ────────────────────────────────────────
let enabled = true;           // /autoexec on/off из Telegram
let bybit = null;             // инстанс BybitClient
let bot = null;               // Telegram bot (из index.js)
let chatId = null;            // Telegram chat ID
let supabase = null;          // Supabase client (из index.js)

const activePositions = new Map();  // symbol → { signal, orderId, entryPrice, ... }
let dailyPnl = 0;
let dailyPnlResetDate = todayKey();
let monitorTimer = null;

// ─── Инициализация ───────────────────────────────────────────
function init() {
  try {
    if (!process.env.BYBIT_API_KEY || !process.env.BYBIT_API_SECRET) {
      console.error('[AutoExec] ❌ BYBIT_API_KEY / BYBIT_API_SECRET not set. Module disabled.');
      return;
    }

    bybit = new BybitClient();

    console.log('[AutoExec] ✅ Module initialized');
    console.log(`[AutoExec] Config: risk=${RISK_PCT}%, maxPos=${MAX_POSITIONS}, ` +
      `dailyLoss=${DAILY_LOSS_LIMIT}%, minConf=${MIN_CONFIDENCE}, ` +
      `leverage=${DEFAULT_LEVERAGE}x, testnet=${TESTNET}`);

    // Слушаем сигналы от index.js
    signals.on('trade_signal', handleSignal);

    // Слушаем Telegram команды
    signals.on('telegram_command', handleTelegramCommand);

    // Принимаем зависимости из index.js
    signals.on('inject_deps', ({ telegramBot, telegramChatId, supabaseClient }) => {
      bot = telegramBot;
      chatId = telegramChatId;
      supabase = supabaseClient;
      console.log('[AutoExec] Dependencies injected (bot, chatId, supabase)');
    });

    // Запускаем мониторинг позиций
    startMonitor();

  } catch (err) {
    console.error('[AutoExec] Init error:', err.message);
  }
}

// ─── Обработка входящего сигнала ─────────────────────────────
async function handleSignal(signal) {
  /*
    Ожидаемый формат сигнала от index.js:
    {
      symbol: 'BTCUSDT',       // торговая пара
      side: 'Buy' или 'Sell',  // направление
      confidence: 85,          // уверенность 0-100
      sl_pct: 1.5,             // стоп-лосс в %
      tp_pct: 3.0,             // тейк-профит в %
      reason: 'RSI oversold + MACD cross',
      source: 'crypto-radar'
    }
  */
  const tag = `[AutoExec][${signal.symbol}]`;

  try {
    // ── Проверки безопасности ──
    if (!enabled) {
      console.log(`${tag} Module disabled, skipping signal`);
      return;
    }

    if (!bybit) {
      console.log(`${tag} Bybit client not initialized`);
      return;
    }

    // Confidence check
    if ((signal.confidence || 0) < MIN_CONFIDENCE) {
      console.log(`${tag} Low confidence ${signal.confidence}% < ${MIN_CONFIDENCE}%, skip`);
      await notify(`⏭️ Пропущен сигнал ${signal.symbol} ${signal.side}\nConfidence: ${signal.confidence}% < ${MIN_CONFIDENCE}%`);
      return;
    }

    // SL обязателен
    if (!signal.sl_pct || signal.sl_pct <= 0) {
      console.log(`${tag} No SL defined, refusing to enter`);
      await notify(`🚫 Отклонён сигнал ${signal.symbol} — нет SL!`);
      return;
    }

    // Макс позиций
    if (activePositions.size >= MAX_POSITIONS) {
      console.log(`${tag} Max positions (${MAX_POSITIONS}) reached`);
      await notify(`⚠️ Макс. позиций (${MAX_POSITIONS}) достигнут. Пропускаю ${signal.symbol}`);
      return;
    }

    // Уже есть позиция по этому символу?
    if (activePositions.has(signal.symbol)) {
      console.log(`${tag} Already have a position, skip`);
      return;
    }

    // Дневной лимит потерь
    resetDailyPnlIfNeeded();
    if (dailyPnl <= DAILY_LOSS_LIMIT) {
      console.log(`${tag} Daily loss limit hit: ${dailyPnl.toFixed(2)}%`);
      await notify(`🛑 Дневной лимит потерь достигнут (${dailyPnl.toFixed(2)}%). Торговля остановлена.`);
      enabled = false;
      return;
    }

    // ── Получаем данные для расчёта ──
    const [balance, price, instrument] = await Promise.all([
      bybit.getBalance(),
      bybit.getLastPrice(signal.symbol),
      bybit.getInstrumentInfo(signal.symbol),
    ]);

    if (!balance || !price || !instrument) {
      console.error(`${tag} Failed to fetch market data`);
      await notify(`❌ Не удалось получить данные для ${signal.symbol}. Пропускаю.`);
      return;
    }

    console.log(`${tag} Balance: $${balance.total}, Price: ${price}`);

    // ── Расчёт размера позиции ──
    // positionSize = balance × RISK_PCT / SL_PCT
    const riskAmount = balance.total * (RISK_PCT / 100);
    const slPct = signal.sl_pct;
    const tpPct = signal.tp_pct || slPct * 2; // TP = 2×SL по умолчанию

    let positionValue = riskAmount / (slPct / 100);
    let qty = positionValue / price;

    // Округляем qty до шага лота
    qty = roundToStep(qty, instrument.qtyStep);

    // Проверяем минимальный лот
    if (qty < instrument.minQty) {
      console.log(`${tag} Calculated qty ${qty} < minQty ${instrument.minQty}`);
      await notify(`⚠️ Слишком маленькая позиция для ${signal.symbol}. Минимум: ${instrument.minQty}`);
      return;
    }

    // ── Вычисляем цены SL и TP ──
    let slPrice, tpPrice;
    if (signal.side === 'Buy') {
      slPrice = roundToStep(price * (1 - slPct / 100), instrument.tickSize);
      tpPrice = roundToStep(price * (1 + tpPct / 100), instrument.tickSize);
    } else {
      slPrice = roundToStep(price * (1 + slPct / 100), instrument.tickSize);
      tpPrice = roundToStep(price * (1 - tpPct / 100), instrument.tickSize);
    }

    // ── Устанавливаем плечо ──
    const leverage = Math.min(DEFAULT_LEVERAGE, instrument.maxLeverage);
    await bybit.setLeverage(signal.symbol, leverage);

    // ── Открываем позицию ──
    const linkId = `cr_${Date.now()}_${signal.symbol}`;

    await notify(
      `🔄 Открываю позицию...\n` +
      `${signal.side === 'Buy' ? '🟢' : '🔴'} ${signal.side} ${signal.symbol}\n` +
      `Размер: ${qty} (~$${(qty * price).toFixed(2)})\n` +
      `Цена: ${price}\n` +
      `SL: ${slPrice} (${slPct}%)\n` +
      `TP: ${tpPrice} (${tpPct}%)\n` +
      `Confidence: ${signal.confidence}%\n` +
      `Причина: ${signal.reason || 'N/A'}\n` +
      `${TESTNET ? '⚠️ TESTNET' : '🔴 LIVE'}`
    );

    const order = await bybit.placeMarketOrder({
      symbol: signal.symbol,
      side: signal.side,
      qty,
      stopLoss: slPrice,
      takeProfit: tpPrice,
      orderLinkId: linkId,
    });

    if (!order) {
      await notify(`❌ Не удалось открыть позицию ${signal.symbol}`);
      return;
    }

    // ── Получаем реальную цену входа с биржи ──
    let realEntry = price;
    try {
      await new Promise(r => setTimeout(r, 800)); // ждём чтобы биржа обновила позицию
      const positions = await bybit.getPositions(signal.symbol);
      const pos = positions?.find(p => p.symbol === signal.symbol && parseFloat(p.size) > 0);
      if (pos && parseFloat(pos.avgPrice) > 0) {
        realEntry = parseFloat(pos.avgPrice);
      }
    } catch(e) { console.error(`${tag} getPositions error:`, e.message); }

    // ── Сохраняем в трекер с реальной ценой ──
    activePositions.set(signal.symbol, {
      signal,
      orderId:     order.orderId,
      orderLinkId: linkId,
      side:        signal.side,
      qty,
      entryPrice:  realEntry,
      slPrice,
      tpPrice,
      openedAt:    new Date(),
    });

    // ── Уведомляем с реальными данными ──
    const coin = signal.symbol.replace('USDT', '');
    const dir  = signal.side === 'Buy' ? '🟢 LONG' : '🔴 SHORT';
    await notify(
      `✅ Позиция открыта!\n` +
      `━━━━━━━━━━━━━━━━━━━\n` +
      `${dir} ${coin}/USDT\n` +
      `💰 Вход: $${realEntry}\n` +
      `🛡 SL: $${slPrice} (-${slPct}%)\n` +
      `🎯 TP: $${tpPrice} (+${tpPct}%)\n` +
      `📦 Размер: ${qty} (~$${(qty * realEntry).toFixed(0)})\n` +
      `⚡️ Плечо: ${leverage}x\n` +
      `📊 Уверенность: ${signal.confidence}%`
    );

    // ── Запись в Supabase ──
    await saveTrade({
      symbol: signal.symbol,
      side: signal.side,
      entry_price: price,
      qty,
      sl_price: slPrice,
      tp_price: tpPrice,
      confidence: signal.confidence,
      reason: signal.reason,
      order_id: order.orderId,
      status: 'open',
      source: 'autoexec',
      testnet: TESTNET,
    });

    console.log(`${tag} ✅ Position opened: orderId=${order.orderId}`);

  } catch (err) {
    console.error(`${tag} handleSignal error:`, err.message);
    await notify(`❌ Ошибка автовхода ${signal.symbol}: ${err.message}`);
  }
}

// ─── Мониторинг позиций (каждые 30 сек) ─────────────────────
function startMonitor() {
  if (monitorTimer) clearInterval(monitorTimer);

  monitorTimer = setInterval(async () => {
    if (activePositions.size === 0) return;

    try {
      const positions = await bybit.getPositions();
      if (!positions) return;

      // Создаём Set символов, которые ещё открыты на бирже
      const openOnExchange = new Set(positions.map((p) => p.symbol));

      for (const [symbol, tracked] of activePositions.entries()) {
        const livePos = positions.find((p) => p.symbol === symbol);

        if (!livePos) {
          // Позиция закрылась (по SL или TP на бирже)
          console.log(`[AutoExec] Position ${symbol} closed on exchange`);
          await handlePositionClosed(symbol, tracked);
          continue;
        }

        // Логируем текущий PnL
        const pnlPct = ((livePos.markPrice - tracked.entryPrice) / tracked.entryPrice * 100 *
          (tracked.side === 'Buy' ? 1 : -1)).toFixed(2);

        console.log(`[AutoExec][Monitor] ${symbol} PnL: ${livePos.unrealisedPnl} (${pnlPct}%)`);

        // ── Breakeven: когда достигли 50% от TP1 → SL в безубыток ──
        if (!tracked.breakevenSet && tracked.signal?.tp_pct) {
          const halfTP = tracked.signal.tp_pct * 0.5; // половина пути до TP1
          if (parseFloat(pnlPct) >= halfTP) {
            console.log(`[AutoExec][Breakeven] ${symbol} достиг ${halfTP.toFixed(2)}% (50% TP) → SL в безубыток`);
            const beResult = await bybit.setTradingStop({
              symbol,
              stopLoss: String(tracked.entryPrice),
            });
            if (beResult) {
              tracked.breakevenSet = true;
              await notify(`🛡 ${symbol} — SL в безубыток (50% TP достигнут). Сделка безрисковая.`);
            }
          }
        }

        // ── Trailing stop: после breakeven двигаем SL вслед за ценой ──
        if (tracked.breakevenSet && tracked.signal?.sl_pct) {
          const slPct    = tracked.signal.sl_pct;
          const curPnl   = parseFloat(pnlPct);
          const trailSL  = tracked.trailSL || tracked.entryPrice;

          if (curPnl > 0) {
            // Новый SL = текущая цена минус дистанция SL
            const side = tracked.side === 'Buy' ? 1 : -1;
            const newSL = livePos.markPrice * (1 - side * slPct / 100);
            const improvement = side === 1
              ? newSL > trailSL + 0.0001
              : newSL < trailSL - 0.0001;

            if (improvement) {
              const result = await bybit.setTradingStop({
                symbol,
                stopLoss: String(parseFloat(newSL.toFixed(6))),
              });
              if (result) {
                tracked.trailSL = newSL;
                console.log(`[AutoExec][Trail] ${symbol} SL → ${newSL.toFixed(6)} (PnL: ${curPnl.toFixed(2)}%)`);
              }
            }
          }
        }
      }
    } catch (err) {
      console.error('[AutoExec] Monitor error:', err.message);
    }
  }, MONITOR_INTERVAL_MS);

  console.log(`[AutoExec] Position monitor started (every ${MONITOR_INTERVAL_MS / 1000}s)`);
}

// ─── Обработка закрытой позиции ──────────────────────────────
async function handlePositionClosed(symbol, tracked) {
  try {
    // Получаем данные о закрытом PnL с биржи
    const closedPnlList = await bybit.getClosedPnl(symbol, 1);
    const closedPnl = closedPnlList?.[0];

    const pnl = closedPnl ? parseFloat(closedPnl.closedPnl) : 0;
    const exitPrice = closedPnl ? parseFloat(closedPnl.avgExitPrice) : 0;

    // Обновляем дневной PnL
    const balance = await bybit.getBalance();
    const pnlPct = balance ? (pnl / balance.total * 100) : 0;
    dailyPnl += pnlPct;

    const emoji    = pnl >= 0 ? '✅' : '❌';
    const outcome  = pnl >= 0 ? 'ПРИБЫЛЬ' : 'УБЫТОК';
    const dir      = tracked.side === 'Buy' ? '🟢 LONG' : '🔴 SHORT';
    const duration = formatDuration(new Date() - tracked.openedAt);
    const coin     = symbol.replace('USDT','');

    await notify(
      `${emoji} ${coin}/USDT — ${outcome}\n` +
      `━━━━━━━━━━━━━━━━━━━\n` +
      `${dir}\n` +
      `💰 Вход: $${tracked.entryPrice}\n` +
      `📍 Выход: $${exitPrice}\n` +
      `💵 PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}\n` +
      `⏱ В сделке: ${duration}\n` +
      `📊 Дневной P&L: ${dailyPnl >= 0 ? '+' : ''}${dailyPnl.toFixed(2)}%`
    );

    // Запись в Supabase
    await saveTrade({
      symbol,
      side: tracked.side,
      entry_price: tracked.entryPrice,
      exit_price: exitPrice,
      qty: tracked.qty,
      pnl,
      pnl_pct: pnlPct,
      order_id: tracked.orderId,
      status: pnl >= 0 ? 'win' : 'loss',
      source: 'autoexec',
      testnet: TESTNET,
      closed_at: new Date().toISOString(),
    });

    // Убираем из трекера
    activePositions.delete(symbol);

    // Проверяем дневной лимит
    if (dailyPnl <= DAILY_LOSS_LIMIT) {
      enabled = false;
      await notify(`🛑 Дневной лимит потерь (${DAILY_LOSS_LIMIT}%) достигнут! AutoExec выключен.`);
    }

  } catch (err) {
    console.error(`[AutoExec] handlePositionClosed(${symbol}) error:`, err.message);
    activePositions.delete(symbol);
  }
}

// ─── Telegram команды ────────────────────────────────────────
async function handleTelegramCommand({ command, args, replyFn }) {
  try {
    switch (command) {
      case '/autoexec': {
        const action = args[0]?.toLowerCase();
        if (action === 'on') {
          enabled = true;
          dailyPnl = 0; // Сброс при включении
          await replyFn('✅ AutoExec включён');
        } else if (action === 'off') {
          enabled = false;
          await replyFn('⛔ AutoExec выключён');
        } else {
          await replyFn(
            `🤖 AutoExec: ${enabled ? '✅ ВКЛ' : '⛔ ВЫКЛ'}\n` +
            `Режим: ${TESTNET ? 'TESTNET' : 'LIVE'}\n` +
            `Активных позиций: ${activePositions.size}/${MAX_POSITIONS}\n` +
            `Дневной PnL: ${dailyPnl >= 0 ? '+' : ''}${dailyPnl.toFixed(2)}%\n` +
            `Риск: ${RISK_PCT}% | Плечо: ${DEFAULT_LEVERAGE}x\n\n` +
            `Команды:\n/autoexec on — включить\n/autoexec off — выключить\n/positions — открытые позиции`
          );
        }
        break;
      }

      case '/positions': {
        if (activePositions.size === 0) {
          await replyFn('📭 Нет открытых авто-позиций');
          return;
        }

        // Получаем live данные
        const livePositions = await bybit.getPositions();
        let msg = `📊 Открытые авто-позиции (${activePositions.size}):\n\n`;

        for (const [symbol, tracked] of activePositions.entries()) {
          const live = livePositions?.find((p) => p.symbol === symbol);
          const pnl = live ? live.unrealisedPnl : 0;
          const pnlPct = live
            ? ((live.markPrice - tracked.entryPrice) / tracked.entryPrice * 100 *
              (tracked.side === 'Buy' ? 1 : -1))
            : 0;

          msg += `${tracked.side === 'Buy' ? '🟢' : '🔴'} ${symbol} ${tracked.side}\n`;
          msg += `  Вход: ${tracked.entryPrice} | Сейчас: ${live?.markPrice || '?'}\n`;
          msg += `  PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%)\n`;
          msg += `  SL: ${tracked.slPrice} | TP: ${tracked.tpPrice}\n`;
          msg += `  Открыта: ${formatDuration(new Date() - tracked.openedAt)} назад\n\n`;
        }

        await replyFn(msg);
        break;
      }

      case '/closeall': {
        if (activePositions.size === 0) {
          await replyFn('📭 Нет открытых позиций для закрытия');
          return;
        }

        await replyFn(`🔄 Закрываю ${activePositions.size} позиций...`);

        for (const [symbol, tracked] of activePositions.entries()) {
          const result = await bybit.closePosition(symbol, tracked.side, tracked.qty);
          if (result) {
            await replyFn(`✅ Закрыта: ${symbol}`);
          } else {
            await replyFn(`❌ Ошибка закрытия: ${symbol}`);
          }
        }
        break;
      }
    }
  } catch (err) {
    console.error('[AutoExec] Telegram command error:', err.message);
    await replyFn?.(`❌ Ошибка: ${err.message}`);
  }
}

// ─── Утилиты ─────────────────────────────────────────────────

// Уведомление в Telegram — напрямую через HTTP (bot может быть null)
async function notify(text) {
  try {
    const fullText = `🤖 *AutoExec*\n${text}`;
    console.log(`[AutoExec] Notify: ${text.substring(0, 80)}...`);

    if (bot && chatId) {
      await bot.sendMessage(chatId, fullText, { parse_mode: 'Markdown' });
      return;
    }

    // Fallback — прямой HTTP запрос
    if (chatId && process.env.TELEGRAM_TOKEN) {
      const url = `https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`;
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: fullText,
          parse_mode: 'Markdown',
        }),
      });
    }
  } catch (err) {
    console.error('[AutoExec] Notify error:', err.message);
  }
}

// Запись в Supabase
async function saveTrade(data) {
  try {
    if (!supabase) return;
    const { error } = await supabase.from('trades').insert([{
      ...data,
      created_at: new Date().toISOString(),
    }]);
    if (error) console.error('[AutoExec] Supabase insert error:', error.message);
  } catch (err) {
    console.error('[AutoExec] saveTrade error:', err.message);
  }
}

// Округление до шага (цены или лота)
function roundToStep(value, step) {
  if (!step || step <= 0) return value;
  const precision = countDecimals(step);
  return parseFloat((Math.floor(value / step) * step).toFixed(precision));
}

function countDecimals(num) {
  const str = String(num);
  if (str.includes('.')) return str.split('.')[1].length;
  return 0;
}

// Ключ дня для сброса дневного PnL
function todayKey() {
  return new Date().toISOString().split('T')[0];
}

function resetDailyPnlIfNeeded() {
  const today = todayKey();
  if (dailyPnlResetDate !== today) {
    dailyPnl = 0;
    dailyPnlResetDate = today;
    console.log('[AutoExec] Daily PnL reset');
  }
}

// Форматирование длительности
function formatDuration(ms) {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}с`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}м ${secs % 60}с`;
  const hours = Math.floor(mins / 60);
  return `${hours}ч ${mins % 60}м`;
}

// ─── Запуск! ─────────────────────────────────────────────────
init();
