require('dotenv').config();
const axios = require('axios');
const cron  = require('node-cron');

// ── Stocks Engine (акции NYSE/NASDAQ) ──────────────────────
let stocksEngine = null;
try {
  stocksEngine = require('./stocks_engine');
  console.log('[STOCKS] Engine загружен ✅');
} catch(e) {
  console.log('[STOCKS] Engine не найден — stocks отключён');
}

// Delta Tracker — реальный Delta Profile через OKX WebSocket
let deltaTracker = null;
try { deltaTracker = require('./delta-tracker'); } catch(e) { console.log('[DELTA] delta-tracker не найден:', e.message); }

// Footprint Engine — агрегация тиков по ценовым уровням (GEX confirmation)
let footprint = null;
try { footprint = require('./footprint'); } catch(e) { console.log('[FOOTPRINT] footprint.js не найден:', e.message); }

// Regime Detector instance (класс с .get(), .isStrategyAllowed())
let regimeDetector = null;
try {
  const _regimeMod = require('./regime');
  if (_regimeMod && typeof _regimeMod.get === 'function') {
    regimeDetector = _regimeMod;
    console.log('[REGIME] RegimeDetector загружен');
  }
} catch(e) { console.log('[REGIME] regime.js не найден:', e.message); }

// Regime Detector — ADX/ATR market state classification
const { calcADX, calcATR, calcAtrAvg, detectRegime, neutralRegime } = require('./regime');
try {
  deltaTracker = require('./delta-tracker');
  console.log('[DELTA] Tracker загружен ✅');
} catch(e) {
  console.log('[DELTA] Tracker не найден:', e.message);
}

const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ── Copy Trading Tracker — подпроект (отдельный модуль) ────
const copytrader = require('./copytrader');

// AutoExec — автоматическое исполнение на Bybit
let autoExecSignals = null;
if (process.env.AUTO_EXECUTE === 'true') {
  try {
    autoExecSignals = require('./autoexec').signals;
    console.log('[AutoExec] Модуль загружен');
  } catch(e) { console.error('[AutoExec] Ошибка:', e.message); }
}

// Подменяем sender в copytrader — он будет использовать нашу sendTelegram с учётом подписок
copytrader.setSender((text) => sendTelegram(text, 'whales'));

// ── Персональные подписки на информационные модули ──
// Таблица user_subscriptions в Supabase: chat_id(PK), anomalies, news, whales, updated_at
// Каждый user сам решает что получать. Сигналы сделок (checkSignals) шлются ВСЕГДА — это ядро бота.
const subsCache = new Map();  // chatId (string) → {anomalies, news, whales}
const SUB_MODULES = ['anomalies', 'news', 'whales'];

async function loadSubscriptions() {
  try {
    const { data, error } = await supabase.from('user_subscriptions').select('*');
    if (error) { console.error('[SUBS] load error:', error.message); return; }
    subsCache.clear();
    for (const r of (data || [])) {
      subsCache.set(String(r.chat_id), { anomalies: r.anomalies, news: r.news, whales: r.whales });
    }
    console.log(`[SUBS] загружено подписок: ${subsCache.size}`);
  } catch(e) { console.error('[SUBS] load exception:', e.message); }
}

function getSubs(chatId) {
  const key = String(chatId);
  // Дефолт для новых users — подписан на всё
  return subsCache.get(key) || { anomalies: true, news: true, whales: true };
}

async function setSub(chatId, module, on) {
  const key = String(chatId);
  const cur = getSubs(key);
  cur[module] = !!on;
  subsCache.set(key, cur);
  try {
    const { error } = await supabase.from('user_subscriptions').upsert({
      chat_id: key,
      anomalies: cur.anomalies,
      news: cur.news,
      whales: cur.whales,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'chat_id' });
    if (error) console.error('[SUBS] save error:', error.message);
  } catch(e) { console.error('[SUBS] save exception:', e.message); }
}

// Проверка: кто-нибудь вообще подписан на модуль? Если нет — можно пропустить сам cron
function anyoneSubscribed(module) {
  for (const id of CHAT_IDS) {
    if (getSubs(id)[module]) return true;
  }
  return false;
}

// ── Настройки ──────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID || '@ApexAlgoFund'; // публичный канал

// ── Отправка в публичный канал ────────────────────────────────
async function sendToChannel(text) {
  if (!TELEGRAM_TOKEN) return;
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    await httpPost(url, {
      chat_id:    CHANNEL_ID,
      text,
      parse_mode: 'Markdown',
    });
    console.log('[CHANNEL] Пост отправлен в', CHANNEL_ID);
  } catch(e) {
    console.error('[CHANNEL] Ошибка отправки:', e.message);
  }
}

// ── Формат сигнала для публичного канала ─────────────────────
function buildChannelSignal(sig) {
  if (!sig?.instId) return null;
  const coin    = (sig.instId || '').replace('-USDT-SWAP', '');
  const dir     = sig.direction === 'long' ? '🟢 LONG' : '🔴 SHORT';
  const emoji   = sig.direction === 'long' ? '📈' : '📉';
  const regime  = sig.regimeNote ? sig.regimeNote.split('(')[0].trim() : '';
  const session = sig.sessionNote ? sig.sessionNote.split('→')[0].trim() : '';

  const filled = Math.round(sig.confidence / 10);
  const bar    = '█'.repeat(filled) + '░'.repeat(10 - filled);

  // Короткое название стратегии
  const stratName = (sig.strategy || '')
    .replace(/[0-9️⃣]/g, '').trim()
    .split('(')[0].trim();

  return (
    `${emoji} *${coin}/USDT — ${dir}*\n` +
    `━━━━━━━━━━━━━━━\n` +
    `💰 Entry:  \`$${sig.price}\`\n` +
    `🎯 TP1:    \`$${sig.tp1}\`\n` +
    `🎯 TP2:    \`$${sig.tp2}\`\n` +
    `🛡 SL:     \`$${sig.sl}\`\n` +
    `━━━━━━━━━━━━━━━\n` +
    `📊 Confidence: ${sig.confidence}%\n` +
    `[${bar}]\n` +
    `📌 ${stratName}\n` +
    (regime  ? `🌐 ${regime}\n`  : '') +
    (session ? `⏰ ${session}\n` : '') +
    `━━━━━━━━━━━━━━━\n` +
    `_Apex Algo Fund — automated 24/7_\n` +
    `@ApexAlgoFund`
  );
}
const CHAT_ID        = process.env.CHAT_ID;
const CHAT_IDS       = [process.env.CHAT_ID, process.env.CHAT_ID_2].filter(Boolean);
const GROQ_KEY       = process.env.GROQ_KEY;

// Все SL ≤ 1.5% — максимальная защита для проп-аккаунта
// RR 1:3 минимум — математически оправдано при WR 40-50%
const STRATEGY_SL = {
  '1️⃣ Volume Spike (15m)':           { sl: 1.5, tp1: 4.5, tp2: 6.75 }, // RR 1:3
  '2️⃣ Liquidity Bounce (1h)':       { sl: 1.5, tp1: 4.5, tp2: 6.75 }, // RR 1:3/1:4.5
  '3️⃣ Ранний вход (5m)':            { sl: 1.0, tp1: 3.0, tp2: 4.5  }, // RR 1:3/1:4.5
  '4️⃣ MA20/MA50+RSI (1h)':          { sl: 1.5, tp1: 4.5, tp2: 6.75 }, // было 2.7 → 1.5
  '5️⃣ RSI Дивергенция (1h)':        { sl: 1.5, tp1: 4.5, tp2: 7.5  }, // было 2.0 → 1.5
  '6️⃣ Funding Extreme (1h)':        { sl: 1.5, tp1: 4.5, tp2: 6.75 }, // было 2.5 → 1.5
  '7️⃣ Поглощение на объёме (15m)':  { sl: 1.5, tp1: 4.5, tp2: 6.75 }, // RR 1:3
  '8️⃣ Basis Farming (1h)':          { sl: 1.5, tp1: 4.5, tp2: 7.5  }, // было 2.0 → 1.5
  '9️⃣ Pullback в тренде (15m)':     { sl: 1.2, tp1: 3.6, tp2: 5.4  }, // RR 1:3/1:4.5
  '🔟 4H Range Breakout (5m)':       { sl: 1.2, tp1: 3.6, tp2: 5.4  }, // RR 1:3/1:4.5
  '1️⃣1️⃣ Elliott+Fib+SMA':           { sl: 1.5, tp1: 4.5, tp2: 7.5  }, // RR 1:3/1:5
  '1️⃣2️⃣ Liquidity Sweep (15m)':    { sl: 1.5, tp1: 3.75, tp2: 6.0 }, // RR 1:2.5/1:4
  '1️⃣3️⃣ Order Block (1H)':          { sl: 1.5, tp1: 3.0,  tp2: 4.5 }, // RR 1:2/1:3
  '1️⃣4️⃣ Whale Follow (15m)':        { sl: 1.5, tp1: 3.0,  tp2: 4.5 }, // RR 1:2/1:3 (быстрая реакция)
  '1️⃣8️⃣ News Trading':               { sl: 1.0, tp1: 3.0,  tp2: 5.0 }, // быстрый выход на новостях
  '1️⃣9️⃣ Value Area Reversal (1H)':   { sl: 1.2, tp1: 2.4,  tp2: 3.6 }, // SL под минимумом дипа
  '1️⃣5️⃣ Liquidation Hunt (5m)':     { sl: 1.0, tp1: 2.5,  tp2: 4.0 }, // RR 1:2.5/1:4 (тугой SL — каскад быстрый)
};

const S2 = { priceMax: -2.5, oiMin: 2.0, vdeltaMax: -1500000, ticksMin: 500, volMin: 10000000 };

const MIN_VOLUME_24H = 10000000;

// Liquidity filter — позиция не должна превышать 0.1% суточного объёма
function checkLiquidity(coin, positionUsd) {
  const vol24h = coin.volume24h || 0;
  if (vol24h <= 0) return { ok: true };
  const maxPos = vol24h * 0.005; // 0.5% суточного объёма (было 0.1%)
  if (positionUsd > maxPos) {
    return {
      ok: false,
      reason: `Позиция $${Math.round(positionUsd)} > 0.5% объёма монеты ($${Math.round(maxPos)}). Высокое проскальзывание!`,
    };
  }
  return { ok: true };
}
const TOP_N          = 50;

// ── SECTOR MAP — для correlation check ──────────────────────
// Не открываем 2 позиции в одном секторе одновременно
const COIN_SECTORS = {
  // Layer 1
  BTC:'L1', ETH:'L1', SOL:'L1', ADA:'L1', AVAX:'L1', DOT:'L1',
  TIA:'L1', SUI:'L1', APT:'L1', NEAR:'L1', TON:'L1', ICP:'L1',
  // Layer 2
  ARB:'L2', OP:'L2', MATIC:'L2', MANTA:'L2', BLAST:'L2',
  // DeFi
  UNI:'DEFI', AAVE:'DEFI', INJ:'DEFI', DYDX:'DEFI', GMX:'DEFI',
  // Meme
  DOGE:'MEME', SHIB:'MEME', PEPE:'MEME', FLOKI:'MEME', BONK:'MEME',
  WIF:'MEME', NEIRO:'MEME',
  // AI
  WLD:'AI', FET:'AI', RNDR:'AI', TAO:'AI', AGIX:'AI',
  // Commodities
  XAU:'COMMODITY', XAG:'COMMODITY', CL:'COMMODITY', BZ:'COMMODITY',
  // Stocks
  NVDA:'STOCK', TSLA:'STOCK', AAPL:'STOCK', INTC:'STOCK', MSTR:'STOCK',
};

function getCoinSector(instId) {
  const coin = instId.replace('-USDT-SWAP','');
  return COIN_SECTORS[coin] || 'OTHER';
}

// Unified correlation check — accepts instId string OR signal object.
// Returns { ok, allowed, reason } — both ok and allowed are set for compat.
function checkCorrelation(instIdOrSig, direction) {
  if (!store.openTrades?.length) return { ok: true, allowed: true };
  const instId = typeof instIdOrSig === 'string'
    ? instIdOrSig
    : (instIdOrSig?.instId || '');
  const dir = direction || (typeof instIdOrSig === 'object' ? instIdOrSig?.direction : null);
  const newSector = getCoinSector(instId);
  if (newSector === 'OTHER') return { ok: true, allowed: true };

  for (const trade of store.openTrades) {
    const openSector = getCoinSector(trade.instId || '');
    if (openSector !== newSector) continue;
    // When direction is known, only block same-direction trades
    if (dir && trade.direction && trade.direction !== dir) continue;
    const sym = (trade.instId || '').replace('-USDT-SWAP', '');
    const reason = `Корреляция: уже открыт ${sym} (${newSector})${dir ? ' в ' + dir : ''}`;
    return { ok: false, allowed: false, reason };
  }
  return { ok: true, allowed: true };
}

// ── КЛАССИФИКАЦИЯ АКТИВОВ ────────────────────────────────────
// Определяем тип актива и применяем правильные параметры
const ASSET_CLASSES = {
  // Золото и серебро
  XAU: { class: 'commodity', name: 'Золото',   slPct: 0.7,  tpMult: 2, sessionUTC: null,         dxyFilter: true  },
  XAG: { class: 'commodity', name: 'Серебро',  slPct: 1.0,  tpMult: 2, sessionUTC: null,         dxyFilter: true  },
  // Нефть
  CL:  { class: 'commodity', name: 'Нефть WTI',slPct: 1.2,  tpMult: 2, sessionUTC: null,         opecFilter: true },
  BZ:  { class: 'commodity', name: 'Нефть Brent',slPct: 1.2, tpMult: 2, sessionUTC: null,        opecFilter: true },
  // Акции (NYSE: 14:30-21:00 UTC)
  NVDA:{ class: 'stock',     name: 'NVIDIA',   slPct: 1.5,  tpMult: 2, sessionUTC: [14.5, 21],   earningsFilter: true },
  TSLA:{ class: 'stock',     name: 'Tesla',    slPct: 2.0,  tpMult: 2, sessionUTC: [14.5, 21],   earningsFilter: true },
  AAPL:{ class: 'stock',     name: 'Apple',    slPct: 1.0,  tpMult: 2, sessionUTC: [14.5, 21],   earningsFilter: true },
  INTC:{ class: 'stock',     name: 'Intel',    slPct: 1.5,  tpMult: 2, sessionUTC: [14.5, 21],   earningsFilter: true },
  MSTR:{ class: 'stock',     name: 'MicroStrategy',slPct: 3.0, tpMult: 2, sessionUTC: [14.5, 21],earningsFilter: true },
};

function getAssetClass(instId) {
  const coin = instId.replace('-USDT-SWAP','').replace('-USDT','');
  return ASSET_CLASSES[coin] || { class: 'crypto', slPct: null, tpMult: 2, sessionUTC: null };
}

// Проверяем что рынок открыт для данного актива
function isMarketOpenForAsset(asset) {
  if (asset.class === 'crypto') return true; // крипта 24/7
  if (!asset.sessionUTC) return true; // коммодити торгуются почти 24/7

  const utcHour = new Date().getUTCHours() + new Date().getUTCMinutes() / 60;
  const [open, close] = asset.sessionUTC;
  const day = new Date().getUTCDay(); // 0=вс, 6=сб

  // Акции не торгуются в выходные
  if (asset.class === 'stock' && (day === 0 || day === 6)) return false;
  return utcHour >= open && utcHour < close;
}

// DXY кэш (индекс доллара — влияет на золото)
let dxyCache = { value: null, ts: 0 };
async function getDXY() {
  if (Date.now() - dxyCache.ts < 3600000) return dxyCache.value;
  try {
    // DXY через BTC/USDT как прокси (упрощённо)
    // В идеале использовать forex API
    const data = await httpGet('https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT-SPOT');
    // Если BTC растёт → доллар слабеет → золото может расти
    dxyCache = { value: null, ts: Date.now() };
    return null;
  } catch(e) { return null; }
}
const COOLDOWN_MIN   = 60;  // 60 мин — защита от серий по одной монете

// ── Портфельный риск-менеджмент ────────────────────────────
const MAX_OPEN_TRADES     = 3;    // максимум открытых сделок
const MAX_CORRELATED      = 2;    // максимум сделок в одном секторе
const MAX_DAILY_LOSS_PCT  = 3.0;  // дневной лимит убытка % (3% буфер до проп-лимита 5%)
const MAX_SAME_DIRECTION  = 2;    // максимум лонгов или шортов одновременно

// Дневной PnL трекер
if (!global.dailyPnlTracker) {
  global.dailyPnlTracker = { date: '', losses: 0, wins: 0, slCount: 0 };
}

function checkPortfolioRisk(sig) {
  if (!sig || !sig.instId) return { allowed: false, reason: 'Нет instId в сигнале' };
  const open = store.openTrades;
  const symbol = (sig.instId||'').replace('-USDT-SWAP', '');

  // ── EMERGENCY STOP ────────────────────────────────────────
  if (store.emergencyStop) {
    console.log(`[EMERGENCY] ${sig.instId} — бот в аварийной остановке`);
    return { allowed: false, reason: '🚨 Аварийная остановка (/resume для возобновления)' };
  }

  // ── РЕЖИМ НАБЛЮДЕНИЯ — пропускаем все ограничения ─────────
  // В observe mode сигналы идут но сделки не открываются (см. checkSignals)
  if (store.observeMode) {
    return { allowed: true, reason: 'observe' };
  }

  // ── ANTI-TILT: 2 SL за 4 часа → пауза 4 часа ────────────
  // Профи: после серии лоссов мозг "наклоняется" (tilt), решения ухудшаются
  const fourHrAgo = Date.now() - 4 * 60 * 60 * 1000;
  const recentSLs = store.tradeHistory.filter(t =>
    t.outcome === 'sl' && t.closedAt > fourHrAgo
  );
  if (recentSLs.length >= 2) {
    const lastSL = Math.max(...recentSLs.map(t => t.closedAt));
    const pauseUntil = lastSL + 4 * 60 * 60 * 1000;
    if (Date.now() < pauseUntil) {
      const minLeft = Math.round((pauseUntil - Date.now()) / 60000);
      console.log(`[ANTI-TILT] ${sig.instId} — пауза ${minLeft} мин (${recentSLs.length} SL за 4ч)`);
      return { allowed: false, reason: `Anti-tilt: ${recentSLs.length} SL за 4ч → пауза ${minLeft} мин` };
    }
  }

  // ── СТРАТЕГИЯ-СПЕЦИФИЧНЫЙ AUTO-DISABLE ─────────────────
  // Если стратегия дала 3+ SL за последние 5 сделок — пауза 24ч
  // Это защита от стратегии которая перестала работать
  const stratTrades = store.tradeHistory
    .filter(t => t.strategy === sig.strategy)
    .slice(-5);
  if (stratTrades.length >= 5) {
    const stratSLs = stratTrades.filter(t => t.outcome === 'sl').length;
    const lastTradeTs = stratTrades[stratTrades.length - 1].closedAt || 0;
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    if (stratSLs >= 3 && lastTradeTs > dayAgo) {
      console.log(`[STRAT-OFF] ${sig.instId} — ${sig.strategy.split(' ')[0]} имеет ${stratSLs}/5 SL → пауза 24ч`);
      return { allowed: false, reason: `Стратегия ${sig.strategy.split(' ')[0]} в просадке (${stratSLs}/5 SL) — пауза 24ч` };
    }
  }

  // ── БЛОКИРОВКА ВЫХОДНЫХ (проп-режим) ──────────────────────
  if (store.propMode && store.blockWeekends) {
    const day = new Date().getUTCDay(); // 0=вс, 6=сб
    if (day === 0 || day === 6) {
      console.log(`[WEEKEND BLOCK] ${sig.instId} — выходной (UTC день ${day})`);
      return { allowed: false, reason: 'Выходной — проп не торгует в сб/вс' };
    }
  }

  // ── ЭМПИРИЧЕСКИЕ ФИЛЬТРЫ (из анализа 442 сделок) ─────────
  // Вторник UTC: WR 23% на 61 сделке — статистически значимо
  const dayUTC = new Date().getUTCDay();
  if (dayUTC === 2) { // 2 = вторник
    console.log(`[TUESDAY BLOCK] ${sig.instId} — вторник WR 23% → блок`);
    sig.confidence = Math.max(sig.confidence - 25, 0);
    sig.dowNote = '⚠️ Вторник (WR 23%) → -25%';
  }

  // Confidence < 60 → блок (WR 31% на 127 сделках)
  if (sig.confidence < 60) {
    console.log(`[CONF BLOCK] ${sig.instId} — confidence ${sig.confidence}% < 60% (WR 31%) → блок`);
    return { allowed: false, reason: `Confidence ${sig.confidence}% < 60% (empirical threshold)` };
  }

  // Азиатская ночь UTC 1-5: снижаем confidence
  const hourUTC = new Date().getUTCHours();
  if (hourUTC >= 1 && hourUTC <= 5) {
    sig.confidence = Math.max(sig.confidence - 10, 0);
    sig.sessionNote = (sig.sessionNote || '') + ' 🌙 Азия ночь → -10%';
  }

  // ── ЭМПИРИЧЕСКИЕ ФИЛЬТРЫ v2 (из анализа 180 сделок с filters) ──
  // Данные: Delta=true → WR 82%, Delta=false → WR 25-36%
  //         POC=true → WR 67-100%, POC=false → WR 33%

  // hasDelta=true: delta подтверждает ('+' в note)
  // hasDelta=false + deltaNote непустой: delta противоречит ('⚠️')
  // hasDelta=false + deltaNote пустой: нет данных delta (не блокируем)
  const hasDelta    = !!(sig.deltaNote && sig.deltaNote.includes('+'));
  const deltaAgainst = !!(sig.deltaNote && sig.deltaNote.includes('⚠️') && !sig.deltaNote.includes('[no delta]'));
  const noDeltaData  = !sig.deltaNote; // нет данных вообще — не штрафуем
  const hasPoc      = !!(sig.pocNote || sig.mpocNote);
  const session     = getCurrentSession();

  // US+EU сессия: без delta подтверждения → штраф
  if (session === 'US+EU' || session === 'America') {
    if (!hasDelta && !noDeltaData) {
      sig.confidence = Math.max(sig.confidence - 20, 0);
      sig.sessionNote = (sig.sessionNote || '') + ' ⚠️ US+EU без Delta → -20%';
    }
  }

  // ЖЁСТКИЕ ВОРОТА — только в live/prop mode
  if (!store.observeMode) {
    // Блок только если delta АКТИВНО ПРОТИВОРЕЧИТ сигналу
    if (deltaAgainst && !hasPoc) {
      console.log(`[GATE BLOCK] ${sig.instId} — Delta против + нет POC → блок`);
      return { allowed: false, reason: 'Delta противоречит сигналу и нет POC' };
    }
    // Delta против сигнала — штраф
    if (deltaAgainst) {
      sig.confidence = Math.max(sig.confidence - 15, 0);
      console.log(`[DELTA GATE] ${sig.instId} — Delta против сигнала → -15%`);
    }
    // Нет POC — штраф
    if (!hasPoc) {
      sig.confidence = Math.max(sig.confidence - 12, 0);
      sig.pocNote = (sig.pocNote || '') + ' ⚠️ Нет POC → -12%';
      console.log(`[POC GATE] ${sig.instId} — нет POC → -12%`);
    }
    // Повторная проверка после штрафов
    if (sig.confidence < 60) {
      return { allowed: false, reason: `После фильтров confidence упал до ${sig.confidence}%` };
    }
  } else {
    if (!hasDelta) sig.deltaNote = (sig.deltaNote || '') + ' 📊 [no delta]';
    if (!hasPoc)   sig.pocNote   = (sig.pocNote   || '') + ' 📊 [no poc]';
  }

  // ── ПРОП-РЕЖИМ: только S1 + S10 (на основе 442 paper trades) ──
  // S1 Volume Spike: WR 73% на 52 сделках → порог 70%
  // S10 4H Range:   WR 64% на 95 сделках → порог 65%
  // S4 MA20/MA50:   WR 0% → полностью убрана
  // S17 BB Squeeze: WR 24% → полностью убрана
  if (store.propMode) {
    const isS1  = sig.strategy.startsWith('1️⃣ ');
    const isS10 = sig.strategy.includes('4H Range');

    if (!isS1 && !isS10) {
      console.log(`[PROP BLOCK] ${sig.instId} — "${sig.strategy}" заблокирована (только S1+S10)`);
      return { allowed: false, reason: 'Проп-режим: только S1 Volume Spike + S10 4H Range' };
    }

    // S1: порог 70% (анализ 52 сделок — ниже 70% WR падает)
    if (isS1 && sig.confidence < 70) {
      console.log(`[PROP S1 BLOCK] ${sig.instId} — conf=${sig.confidence}% < 70%`);
      return { allowed: false, reason: `S1: низкий confidence ${sig.confidence}% < 70%` };
    }

    // S10: порог 65%
    if (isS10 && sig.confidence < 65) {
      console.log(`[PROP S10 BLOCK] ${sig.instId} — conf=${sig.confidence}% < 65%`);
      return { allowed: false, reason: `S10: низкий confidence ${sig.confidence}% < 65%` };
    }
  }

  // ── КОРРЕЛЯЦИОННЫЙ КОНТРОЛЬ ─────────────────────────────
  if (!store.observeMode) {
    const corrCheck = checkCorrelation(sig);
    if (!corrCheck.allowed) {
      console.log(`[CORR BLOCK] ${sig.instId} — ${corrCheck.reason}`);
      return { allowed: false, reason: corrCheck.reason };
    }
  }

  // ── MAX OPEN RISK — суммарный риск всех позиций не >2.5% ─
  if (!store.observeMode && store.openTrades?.length) {
    const totalRisk = store.openTrades.reduce((sum, t) => {
      const entry = parseFloat(t.price);
      const sl    = parseFloat(t.sl);
      const slPct = entry && sl ? Math.abs((sl - entry) / entry * 100) : 1.5;
      return sum + slPct;
    }, 0);
    const newRisk = sig.price && sig.sl
      ? Math.abs((parseFloat(sig.sl) - sig.price) / sig.price * 100)
      : 1.5;
    const maxTotal = store.propMode ? 2.5 : 4.5;
    if (totalRisk + newRisk > maxTotal) {
      console.log(`[MAX RISK BLOCK] ${sig.instId} — текущий риск ${totalRisk.toFixed(1)}% + ${newRisk.toFixed(1)}% > ${maxTotal}%`);
      return {
        allowed: false,
        reason: `Суммарный риск превысит ${maxTotal}% (${(totalRisk + newRisk).toFixed(1)}%)`,
      };
    }
  }

  // Лимит сделок — считаем только крипто сделки (не акции из Stocks модуля)
  const cryptoTrades = open.filter(t => t.instId && t.instId.includes('-USDT-SWAP'));
  const maxTrades = store.propMode ? 2 : MAX_OPEN_TRADES;
  if (cryptoTrades.length >= maxTrades) {
    console.log(`[PORTFOLIO] Лимит крипто сделок (${cryptoTrades.length}/${maxTrades})`);
    return { allowed: false, reason: `Проп: уже ${cryptoTrades.length} крипто сделки открыты` };
  }

  // 2. Проверка корреляции по сектору
  const sector = COIN_SECTORS[symbol] || 'other';
  if (sector !== 'other') {
    const sectorTrades = open.filter(t => {
      const s = t.symbol || t.instId?.replace('-USDT-SWAP','') || '';
      return (COIN_SECTORS[s] || 'other') === sector && t.direction === sig.direction;
    });
    if (sectorTrades.length >= MAX_CORRELATED) {
      console.log(`[PORTFOLIO] Корреляция: уже ${sectorTrades.length} сделок в секторе ${sector}`);
      return { allowed: false, reason: `Много сделок в секторе ${sector}` };
    }
  }

  // 3. Максимум одинаковых направлений
  const sameDir = open.filter(t => t.direction === sig.direction).length;
  if (sameDir >= MAX_SAME_DIRECTION) {
    console.log(`[PORTFOLIO] Много ${sig.direction}: ${sameDir}/${MAX_SAME_DIRECTION}`);
    return { allowed: false, reason: `Много ${sig.direction} позиций` };
  }

  // 4. Дневной лимит убытка
  const today = new Date().toISOString().split('T')[0];
  if (global.dailyPnlTracker.date !== today) {
    global.dailyPnlTracker = { date: today, losses: 0, wins: 0, slCount: 0 };
  }
  const dailyLimit = store.propMode ? 3.0 : MAX_DAILY_LOSS_PCT;
  if (global.dailyPnlTracker.losses >= dailyLimit) {
    console.log(`[PORTFOLIO] Дневной лимит убытка достигнут: ${global.dailyPnlTracker.losses}% (лимит: ${dailyLimit}%)`);
    return { allowed: false, reason: 'Дневной лимит убытка' };
  }

  return { allowed: true };
}

function updateDailyPnl(pnl, outcome) {
  const today = new Date().toISOString().split('T')[0];
  if (global.dailyPnlTracker.date !== today) {
    global.dailyPnlTracker = { date: today, losses: 0, wins: 0, slCount: 0 };
  }
  if (pnl < 0) global.dailyPnlTracker.losses += Math.abs(pnl);
  else global.dailyPnlTracker.wins += pnl;
  if (outcome === 'sl') global.dailyPnlTracker.slCount += 1;
}

// Рейтинг стратегий по win rate
const STRATEGY_META = {
  '1️⃣ Volume Spike (15m)':         { color: '#f59e0b', rating: 'B', wr: 'Новая' },
  '2️⃣ Liquidity Bounce (1h)': { color: '#fbbf24', rating: 'B', wr: 'Обновлена' },
  '3️⃣ Ранний вход (5m)':           { color: '#4a5a7a', rating: 'C', wr: '~38% (откл.)' },
  '4️⃣ MA20/MA50+RSI (1h)':         { color: '#34d399', rating: 'A', wr: '~40%' },
  '5️⃣ RSI Дивергенция (1h)':       { color: '#34d399', rating: 'A', wr: '~67%' },
  '6️⃣ Funding Extreme (1h)':       { color: '#34d399', rating: 'A', wr: '~68%' },
  '7️⃣ Поглощение на объёме (15m)': { color: '#fbbf24', rating: 'B', wr: '~58%' },
  '8️⃣ Basis Farming (1h)': { color: '#34d399', rating: 'A', wr: 'Новая' },
  '9️⃣ Pullback в тренде (15m)': { color: '#34d399', rating: 'A', wr: 'Новая' },
  '🔟 4H Range Breakout (5m)':  { color: '#34d399', rating: 'A', wr: 'Новая' },
  '1️⃣2️⃣ Liquidity Sweep (15m)': { color: '#34d399', rating: 'A', wr: 'Новая' },
  '1️⃣1️⃣ Elliott+Fib+SMA':       { color: '#a78bfa', rating: 'A', wr: 'Новая' },
  '1️⃣3️⃣ Order Block (1H)':      { color: '#06b6d4', rating: 'A', wr: 'Новая' },
  '1️⃣4️⃣ Whale Follow (15m)':    { color: '#0ea5e9', rating: 'A', wr: 'Новая' },
  '1️⃣5️⃣ Liquidation Hunt (5m)': { color: '#f43f5e', rating: 'A', wr: 'Новая' },
};

// ── Хранилище в памяти (вместо ScriptProperties) ──────────
const store = {
  cooldowns:      {},
  openTrades:     [],
  tradeHistory:   [], // ограничен 500 записями (защита от memory leak)
  signalLog:      [], // ограничен 300 записями
  fngCache:       null,
  fngTs:          0,
  oiCache:        {},
  klinesCache:    {},  // кэш свечей на 60 секунд
  propMode:       false, // режим проп-фирмы
  accountBalance: 5000,  // баланс аккаунта в USDT (менять через /setbalance)
  leverage:       10,    // кредитное плечо (менять через /setleverage)
  riskPct:        1.0,   // риск на сделку % (менять через /setrisk)
  emergencyStop:  false, // аварийная остановка (kill switch)
  blockWeekends:  true,  // не торговать в субботу-воскресенье
  observeMode:      false, // реальная торговля по умолчанию
  observeStartedAt: null,  // timestamp последнего включения /observe
  peakBalance:      0,     // макс баланс для расчёта drawdown
};

// ── DRAWDOWN-AWARE RISK SIZING ────────────────────────────
// Профи уменьшают размер позиции когда в просадке, не увеличивают
function getEffectiveRiskPct() {
  let baseRisk = store.riskPct;

  // 1. ПРОСАДКА — снижаем риск
  if (store.peakBalance && store.peakBalance > store.accountBalance) {
    const dd = (store.peakBalance - store.accountBalance) / store.peakBalance * 100;
    if (dd >= 7)        baseRisk *= 0.25;
    else if (dd >= 5)   baseRisk *= 0.4;
    else if (dd >= 3)   baseRisk *= 0.6;
    else if (dd >= 1.5) baseRisk *= 0.8;
  }

  // 2. WIN/LOSS STREAK — после серии SL снижаем, после серии TP можно поднять
  const recent = store.tradeHistory.slice(-10);
  if (recent.length >= 5) {
    const lastTrades = recent.slice(-5);
    const slStreak = (() => {
      let n = 0;
      for (let i = lastTrades.length - 1; i >= 0; i--) {
        if (lastTrades[i].outcome === 'sl') n++; else break;
      }
      return n;
    })();
    const winStreak = (() => {
      let n = 0;
      for (let i = lastTrades.length - 1; i >= 0; i--) {
        const o = lastTrades[i].outcome;
        if (o === 'tp1' || o === 'tp2') n++; else break;
      }
      return n;
    })();

    if (slStreak >= 3) baseRisk *= 0.5;
    else if (slStreak >= 2) baseRisk *= 0.7;
    else if (winStreak >= 4) baseRisk *= 1.15;
  }

  // 3. ROLLING SHARPE (последние 20 сделок) — auto risk reduction
  // Quant стандарт: плохой Sharpe → снижать позицию
  const last20 = store.tradeHistory.slice(-20).map(t => t.pnl || 0);
  if (last20.length >= 10) {
    const m20  = last20.reduce((a,b)=>a+b,0) / last20.length;
    const s20  = Math.sqrt(last20.reduce((s,r)=>s+(r-m20)**2,0) / last20.length);
    const rs   = s20 > 0 ? (m20/s20) * Math.sqrt(252) : 0;

    if (rs < 0)        baseRisk *= 0.0;  // Sharpe отрицательный → не торгуем
    else if (rs < 0.5) baseRisk *= 0.5;  // Sharpe слабый → риск /2
    else if (rs < 1.0) baseRisk *= 0.75; // Sharpe умеренный → риск × 0.75
    // Sharpe >= 1.0 → полный риск

    if (rs < 0 && !store.observeMode) {
      console.log(`[QUANT] Rolling Sharpe=${rs.toFixed(2)} < 0 → переключаем в observe mode`);
      // Не переключаем автоматически — только логируем, пользователь решает
    }
  }

  // 4. ОГРАНИЧЕНИЯ
  return Math.max(0.1, Math.min(baseRisk, store.riskPct * 1.2));
}

function updatePeakBalance() {
  if (store.accountBalance > store.peakBalance) {
    store.peakBalance = store.accountBalance;
    saveSettings();
  }
}

// ── КАЛИБРОВКА CONFIDENCE ПО РЕАЛЬНОЙ СТАТИСТИКЕ ────────────
// Каждый раз при старте и после каждой сделки пересчитываем WR
// по живой истории — confidence перестаёт быть "числом с потолка"
function calcRealWR() {
  const history = store.tradeHistory;
  if (history.length < 10) return null; // мало данных

  const byStrategy = {};
  for (const t of history) {
    const key = (t.strategy || '?').substring(0, 20);
    if (!byStrategy[key]) byStrategy[key] = { wins: 0, total: 0 };
    byStrategy[key].total++;
    if (t.outcome === 'tp1' || t.outcome === 'tp2') byStrategy[key].wins++;
  }

  const result = {};
  for (const [key, data] of Object.entries(byStrategy)) {
    if (data.total >= 5) { // минимум 5 сделок чтобы считать
      result[key] = Math.round(data.wins / data.total * 100);
    }
  }
  return result;
}

// Применяем реальный WR к confidence (смешиваем 50/50 с техническим)
function applyRealWRCalibration(sig) {
  const wrMap = calcRealWR();
  if (!wrMap) return sig; // нет данных — не меняем

  const key = Object.keys(wrMap).find(k => sig.strategy.includes(k.substring(2)));
  if (!key) return sig;

  const realWR = wrMap[key];
  // Смешиваем: 40% от реального WR + 60% от технического confidence
  const calibrated = Math.round(realWR * 0.4 + sig.confidence * 0.6);
  sig.confidence = Math.min(Math.max(calibrated, 0), 100);
  sig.wrNote = `📊 Live WR ${realWR}% → скорр. confidence`;
  return sig;
}
const fs = require('fs');
const SETTINGS_FILE = './bot-settings.json';

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const data = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      if (typeof data.accountBalance === 'number') store.accountBalance = data.accountBalance;
      if (typeof data.leverage === 'number')       store.leverage       = data.leverage;
      if (typeof data.riskPct === 'number')        store.riskPct        = data.riskPct;
      if (typeof data.propMode === 'boolean')      store.propMode       = data.propMode;
      if (typeof data.emergencyStop === 'boolean') store.emergencyStop  = data.emergencyStop;
      if (typeof data.blockWeekends === 'boolean') store.blockWeekends  = data.blockWeekends;
      if (typeof data.observeMode === 'boolean')  store.observeMode   = data.observeMode;
      if (typeof data.peakBalance === 'number')   store.peakBalance    = data.peakBalance;
      console.log(`[SETTINGS] Загружено: balance=$${store.accountBalance}, risk=${store.riskPct}%, prop=${store.propMode}, emergency=${store.emergencyStop}`);
    }
  } catch(e) { console.error('[SETTINGS] Ошибка загрузки:', e.message); }
}

function saveSettings() {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify({
      accountBalance:   store.accountBalance,
      leverage:         store.leverage,
      riskPct:          store.riskPct,
      propMode:         store.propMode,
      emergencyStop:    store.emergencyStop,
      blockWeekends:    store.blockWeekends,
      observeMode:      store.observeMode,
      observeStartedAt: store.observeStartedAt,
      peakBalance:      store.peakBalance,
    }, null, 2));
  } catch(e) { console.error('[SETTINGS] Ошибка сохранения файла:', e.message); }
  // Supabase — сохраняем между деплоями
  supabase.from('bot_settings').upsert({
    id: 1,
    account_balance:    store.accountBalance,
    leverage:           store.leverage,
    risk_pct:           store.riskPct,
    prop_mode:          store.propMode,
    emergency_stop:     store.emergencyStop,
    block_weekends:     store.blockWeekends,
    observe_mode:       store.observeMode,
    observe_started_at: store.observeStartedAt,
    peak_balance:       store.peakBalance,
    updated_at:         new Date().toISOString(),
  }).then(({ error }) => {
    if (error) console.error('[SETTINGS] Supabase error:', error.message);
    else console.log(`[SETTINGS] Saved: prop=${store.propMode} observe=${store.observeMode}`);
  });
}

async function loadSettingsFromSupabase() {
  try {
    const { data, error } = await supabase
      .from('bot_settings').select('*').eq('id', 1).single();
    if (error || !data) { console.log('[SETTINGS] Supabase: нет данных, используем файл'); return; }
    if (typeof data.account_balance === 'number') store.accountBalance = data.account_balance;
    if (typeof data.leverage        === 'number') store.leverage       = data.leverage;
    if (typeof data.risk_pct        === 'number') store.riskPct        = data.risk_pct;
    if (typeof data.prop_mode       === 'boolean') store.propMode      = data.prop_mode;
    if (typeof data.emergency_stop  === 'boolean') store.emergencyStop = data.emergency_stop;
    if (typeof data.block_weekends  === 'boolean') store.blockWeekends = data.block_weekends;
    if (typeof data.observe_mode    === 'boolean') store.observeMode   = data.observe_mode;
    if (data.observe_started_at != null)           store.observeStartedAt = data.observe_started_at;
    if (typeof data.peak_balance    === 'number') store.peakBalance    = data.peak_balance;
    console.log(`[SETTINGS] Supabase: balance=$${store.accountBalance} prop=${store.propMode} observe=${store.observeMode}`);
  } catch(e) { console.error('[SETTINGS] Supabase load error:', e.message); }
}

loadSettings();
loadSettingsFromSupabase().catch(() => {});

// ── Добавить в tradeHistory с защитой от переполнения ──────
async function pushTradeHistory(trade) {
  store.tradeHistory.push(trade);
  if (store.tradeHistory.length > 500) {
    store.tradeHistory = store.tradeHistory.slice(-500);
  }

  // Live trades are saved to 'trades' table by autoexec.js — no save here.
  // Paper trades use savePaperTradeToSupabase separately.
  // This function only updates in-memory store.tradeHistory.
}

// ── Сессии UTC ─────────────────────────────────────────────
const SESSION_ASIA   = { from: 1,  to: 8  };
const SESSION_EUROPE = { from: 7,  to: 16 };
const SESSION_USA    = { from: 13, to: 22 };


// ============================================================
//  HTTP ЗАПРОСЫ
// ============================================================
async function httpGet(url) {
  try {
    await new Promise(r => setTimeout(r, 300)); // пауза 300ms (было 1500ms)
    const resp = await axios.get(url, { timeout: 30000 });
    return resp.data;
  } catch(e) {
    console.error(`[HTTP ERROR] ${url}: ${e.message}`);
    return null;
  }
}

async function httpPost(url, data, headers = {}) {
  try {
    const resp = await axios.post(url, data, { headers, timeout: 15000 });
    return resp.data;
  } catch(e) {
    console.error(`[POST ERROR] ${url}: ${e.message}`);
    return null;
  }
}


// ============================================================
//  TELEGRAM
// ============================================================
async function sendTelegram(text, module = null) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  for (const id of CHAT_IDS) {
    // Если module указан — шлём только подписанным на него. Иначе (module=null) — всем (сигналы сделок).
    if (module && SUB_MODULES.includes(module) && !getSubs(id)[module]) continue;
    await httpPost(url, { chat_id: id, text });
  }
  console.log(`[TG${module ? '/' + module : ''}] ${text.substring(0, 60)}...`);
}
// ============================================================
//  TELEGRAM КОМАНДЫ
// ============================================================
// Команды только для администратора
const ADMIN_ONLY_COMMANDS = [
  '/prop', '/observe', '/emergency', '/resume', '/setrisk',
  '/setbalance', '/setleverage', '/weekends', '/autoexec',
  '/closeall', '/nightmode', '/audit', '/report', '/debrief',
  '/psychologist', '/benchmark', '/weekly', '/versions', '/logs',
  '/diag', '/stocks', '/resetpaper',
];

async function handleTelegramCommand(text, chatId) {
  const parts = text.trim().split(/\s+/);
  const cmd   = parts[0].toLowerCase();
  const args  = parts.slice(1);

  // Управляющие команды — только для владельца
  const isAdmin    = String(chatId) === String(process.env.CHAT_ID);
  const isAdminCmd = ADMIN_ONLY_COMMANDS.some(c => cmd === c);
  if (isAdminCmd && !isAdmin) {
    await sendTelegramTo(chatId, '⛔️ Эта команда доступна только администратору.');
    return;
  }

  if (cmd === '/status' || cmd === '/start') {
    const open = store.openTrades;
    if (!open.length) {
      await sendTelegramTo(chatId, '📊 СТАТУС\n━━━━━━━━━━━━━━━━━━━━━━\nОткрытых сделок нет.');
      return;
    }
    const lines = open.map(t => {
      const dir   = t.direction === 'long' ? '🟢 LONG' : '🔴 SHORT';
      const age   = Math.round((Date.now() - t.ts) / 60000);
      return `${dir} ${t.symbol}/USDT\n  💰 Вход: $${t.price}\n  🛡 SL: $${t.sl} | 🎯 TP1: $${t.tp1}\n  ⏱ ${age} мин назад`;
    }).join('\n\n');
    await sendTelegramTo(chatId,
      `📊 ОТКРЫТЫЕ СДЕЛКИ (${open.length})\n━━━━━━━━━━━━━━━━━━━━━━\n${lines}`
    );
  }

  else if (cmd === '/trades') {
    const recent = store.tradeHistory.slice(-10).reverse();
    if (!recent.length) {
      await sendTelegramTo(chatId, '📈 ИСТОРИЯ\n━━━━━━━━━━━━━━━━━━━━━━\nИстории сделок нет.');
      return;
    }
    const lines = recent.map(t => {
      const icon = t.outcome === 'tp1' || t.outcome === 'tp2' ? '✅' : t.outcome === 'sl' ? '❌' : '⏰';
      const pnl  = t.pnl >= 0 ? `+${t.pnl}%` : `${t.pnl}%`;
      return `${icon} ${t.symbol}/USDT — ${pnl}`;
    }).join('\n');
    await sendTelegramTo(chatId,
      `📈 ПОСЛЕДНИЕ 10 СДЕЛОК\n━━━━━━━━━━━━━━━━━━━━━━\n${lines}`
    );
  }

  else if (cmd === '/stats') {
    const since  = Date.now() - 24*60*60*1000;
    const today  = store.tradeHistory.filter(t => t.closedAt >= since);
    const wins   = today.filter(t => t.outcome === 'tp1' || t.outcome === 'tp2');
    const losses = today.filter(t => t.outcome === 'sl');
    const wr     = today.length ? Math.round(wins.length / today.length * 100) : 0;
    const pnl    = today.reduce((a, t) => a + (t.pnl || 0), 0);
    const sigs   = store.signalLog.filter(s => s.ts >= since).length;
    // Читаем из Supabase — не из памяти (память обнуляется при рестарте)
    const { data: dbTrades } = await supabase
      .from('trades')
      .select('pnl,outcome,direction,strategy')
      .order('closed_at', { ascending: true })
      .limit(1000);
    const allDbTrades = dbTrades || [];
    const allW   = allDbTrades.filter(t => t.outcome === 'tp1' || t.outcome === 'tp2');
    const allWR  = allDbTrades.length ? Math.round(allW.length / allDbTrades.length * 100) : 0;

    // Sharpe Ratio из реальных данных
    const returns = allDbTrades.map(t => parseFloat(t.pnl) || 0);
    const meanR   = returns.length ? returns.reduce((a,b)=>a+b,0)/returns.length : 0;
    const stdR    = returns.length > 1 ? Math.sqrt(returns.reduce((a,b)=>a+(b-meanR)**2,0)/returns.length) : 1;
    const sharpe  = stdR > 0 ? (meanR / stdR * Math.sqrt(252)).toFixed(2) : '—';
    // Max Drawdown
    let peak = 0, cumPnl = 0, maxDD = 0;
    for (const t of allDbTrades) {
      cumPnl += parseFloat(t.pnl) || 0;
      if (cumPnl > peak) peak = cumPnl;
      const dd = peak - cumPnl;
      if (dd > maxDD) maxDD = dd;
    }
    // Profit Factor
    const grossWin  = allDbTrades.filter(t=>parseFloat(t.pnl)>0).reduce((a,t)=>a+parseFloat(t.pnl),0);
    const grossLoss = Math.abs(allDbTrades.filter(t=>parseFloat(t.pnl)<0).reduce((a,t)=>a+parseFloat(t.pnl),0));
    const pf = grossLoss > 0 ? (grossWin/grossLoss).toFixed(2) : '∞';
    // Consecutive losses
    let maxConsecLoss = 0, consecLoss = 0;
    for (const t of allDbTrades) {
      if (t.outcome === 'sl') { consecLoss++; maxConsecLoss = Math.max(maxConsecLoss, consecLoss); }
      else consecLoss = 0;
    }
    // Sharpe по стратегиям
    const stratMap = {};
    allDbTrades.forEach(t => {
      const k = (t.strategy || 'Unknown').replace(/\d️⃣\s*/, '').split('(')[0].trim();
      if (!stratMap[k]) stratMap[k] = [];
      stratMap[k].push(parseFloat(t.pnl) || 0);
    });
    const stratSharpeLines = Object.entries(stratMap)
      .filter(([k, v]) => v.length >= 5)
      .map(([k, v]) => {
        const m = v.reduce((a,b)=>a+b,0)/v.length;
        const s = Math.sqrt(v.reduce((a,b)=>a+(b-m)**2,0)/v.length) || 1;
        const sh = (m/s*Math.sqrt(252)).toFixed(2);
        const wr = Math.round(v.filter(x=>x>0).length/v.length*100);
        return `  ${k}: Sharpe ${sh} | WR ${wr}% | ${v.length} сд.`;
      }).join('\n');

    const fng    = store.fngCache || { value: '?', label: '?' };

    // Recovery Factor = Net PnL / Max Drawdown (> 2.0 = хорошо для проп)
    const totalNetPnl = allDbTrades.reduce((a,t) => a+(parseFloat(t.pnl)||0), 0);
    const recoveryFactor = maxDD > 0 ? (totalNetPnl / maxDD).toFixed(2) : '∞';

    // Среднее время удержания сделки (из Supabase с полными данными)
    const { data: holdingData } = await supabase
      .from('trades')
      .select('ts, closed_at')
      .not('closed_at', 'is', null)
      .limit(100);
    const avgHoldingHrs = holdingData?.length
      ? (holdingData.reduce((a,t) => a + ((+t.closed_at - +t.ts) / 3600000), 0) / holdingData.length).toFixed(1)
      : '—';

    // Calmar Ratio (годовой PnL / MaxDD) — важнее Sharpe для проп
    const tradingDays = Math.max(1, allDbTrades.length / 3); // ~3 сделки в день
    const annualized = totalNetPnl * (252 / tradingDays);
    const calmar = maxDD > 0 ? (annualized / maxDD).toFixed(2) : '∞';

    await sendTelegramTo(chatId,
      `📊 СТАТИСТИКА\n━━━━━━━━━━━━━━━━━━━━━━\n` +
      `😐 F&G: ${fng.value} (${fng.label})\n\n` +
      `📅 За сегодня:\n` +
      `  Сигналов: ${sigs}\n` +
      `  Сделок: ${today.length} | ✅ ${wins.length} ❌ ${losses.length}\n` +
      `  Win Rate: ${wr}%\n` +
      `  PnL: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(1)}%\n\n` +
      `📈 За всё время:\n` +
      `  Сделок: ${allDbTrades.length}\n` +
      `  Win Rate: ${allWR}%\n` +
      `  Открытых: ${store.openTrades.length}\n` +
      `  LONG WR: ${(() => { const lt = allDbTrades.filter(t=>t.direction==='long'); return lt.length ? Math.round(lt.filter(t=>t.outcome==='tp1'||t.outcome==='tp2').length/lt.length*100) : 0; })()}% (${allDbTrades.filter(t=>t.direction==='long').length} сд.)\n` +
      `  SHORT WR: ${(() => { const st = allDbTrades.filter(t=>t.direction==='short'); return st.length ? Math.round(st.filter(t=>t.outcome==='tp1'||t.outcome==='tp2').length/st.length*100) : 0; })()}% (${allDbTrades.filter(t=>t.direction==='short').length} сд.)\n\n` +
      `📐 Расширенные метрики:\n` +
      `  Recovery Factor: ${recoveryFactor}\n` +
      `  Calmar Ratio: ${calmar}\n` +
      `  Avg Hold Time: ${avgHoldingHrs}ч\n` +
      `  Sharpe: ${sharpe} | MaxDD: -${maxDD.toFixed(1)}%\n` +
      `  Profit Factor: ${pf} | Серия SL: ${maxConsecLoss}\n\n` +
      `📊 Sharpe по стратегиям:\n${stratSharpeLines || '  Нужно 5+ сделок на стратегию'}`
    );
  }

  else if (cmd === '/prop') {
    // Переключаем проп-режим
    store.propMode = !store.propMode;
    saveSettings();

    // Обновляем autoexec
    if (autoExecSignals) {
      autoExecSignals.emit('inject_deps', {
        telegramBot:    null,
        telegramChatId: CHAT_ID,
        supabaseClient: supabase,
        propMode:       store.propMode,
      });
    }

    if (store.propMode) {
      await sendTelegramTo(chatId,
        `🏆 ПРОП-РЕЖИМ ВКЛЮЧЁН\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `⚙️ Настройки изменены:\n` +
        `  Стратегии: только S5 + S10\n` +
        `  Макс. сделок: 2 (было 3)\n` +
        `  Дневной лимит: 3% (было 5%)\n` +
        `  Авто-стоп: 3 SL подряд → пауза 4ч\n\n` +
        `🎯 Цель: пройти челлендж проп-фирмы\n` +
        `  Daily Loss Limit: 5% (наш: 3%)\n` +
        `  Overall Loss Limit: 10%\n\n` +
        `⚠️ Выключить: /prop`
      );
    } else {
      await sendTelegramTo(chatId,
        `📊 ПРОП-РЕЖИМ ВЫКЛЮЧЕН\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `⚙️ Настройки восстановлены:\n` +
        `  Все стратегии: S4 S5 S6 S7 S8 S9 S10\n` +
        `  Макс. сделок: 3\n` +
        `  Дневной лимит: 5%\n\n` +
        `💡 Включить снова: /prop`
      );
    }
  }

  else if (cmd === '/propstatus') {
    const slStreak = (() => {
      let streak = 0;
      for (let i = store.tradeHistory.length - 1; i >= 0; i--) {
        if (store.tradeHistory[i].outcome === 'sl') streak++;
        else break;
      }
      return streak;
    })();
    const today = new Date().toISOString().split('T')[0];
    const dayLoss = global.dailyPnlTracker?.date === today
      ? global.dailyPnlTracker.losses.toFixed(2)
      : '0.00';
    const daySlCount = global.dailyPnlTracker?.date === today
      ? (global.dailyPnlTracker.slCount || 0)
      : 0;
    const propLimit = store.propMode ? 3.0 : 5.0;
    const remaining = Math.max(0, propLimit - parseFloat(dayLoss)).toFixed(2);

    await sendTelegramTo(chatId,
      `🏆 СТАТУС ПРОП-РЕЖИМА\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `Режим: ${store.propMode ? '🟢 ВКЛЮЧЁН' : '🔴 ВЫКЛЮЧЕН'}\n\n` +
      `📊 Текущий день:\n` +
      `  Потери сегодня: -${dayLoss}%\n` +
      `  Лимит: ${propLimit}%\n` +
      `  Осталось до лимита: ${remaining}%\n\n` +
      `❌ SL за сегодня: ${daySlCount}/3\n` +
      `  (Дневной стоп при 3 SL до 00:00 UTC)\n\n` +
      `🔴 SL подряд сейчас: ${slStreak}\n` +
      `  (Авто-стоп при 3 подряд → пауза 4ч)\n\n` +
      `📈 Открытых сделок: ${store.openTrades.length}\n` +
      `  Макс: ${store.propMode ? 2 : 3}`
    );
  }

  else if (cmd === '/whales') {
    await copytrader.handleWhalesCommand(chatId);
  }

  // ── ПЕРСОНАЛЬНЫЕ ПОДПИСКИ ──
  // Каждый user сам управляет тем, что ему приходит. Не влияет на других.
  else if (cmd === '/modules') {
    await sendModulesPanel(chatId);
  }
  else if (/^\/(anomalies|news|whales)_(on|off)$/.test(cmd)) {
    const [, key, action] = cmd.match(/^\/(anomalies|news|whales)_(on|off)$/);
    const on = action === 'on';
    await setSub(chatId, key, on);
    const labels = { anomalies: 'Аномалии', news: 'Новости', whales: 'Киты' };
    await sendTelegramTo(chatId,
      `${on ? '🟢' : '🔴'} ${labels[key]} → ${on ? 'ВКЛЮЧЕНЫ для тебя' : 'ВЫКЛЮЧЕНЫ для тебя'}\n` +
      `(на других пользователей не влияет)`
    );
    console.log(`[SUBS] ${chatId}: ${key}=${on ? 'on' : 'off'}`);
  }

  else if (cmd === '/diag') {
    // Диагностика — показывает почему сигналы блокируются
    const today = new Date().toISOString().split('T')[0];
    const recent = store.tradeHistory.slice(-20);
    const wins = recent.filter(t => t.outcome === 'tp1' || t.outcome === 'tp2').length;
    const losses = recent.filter(t => t.outcome === 'sl').length;
    const expired = recent.filter(t => t.outcome === 'expired').length;
    const wr = recent.length ? Math.round(wins / recent.length * 100) : 0;

    // По стратегиям
    const byStrat = {};
    recent.forEach(t => {
      const key = (t.strategy || '?').split(' ').slice(0,2).join(' ');
      if (!byStrat[key]) byStrat[key] = { w: 0, l: 0, e: 0 };
      if (t.outcome === 'tp1' || t.outcome === 'tp2') byStrat[key].w++;
      else if (t.outcome === 'sl') byStrat[key].l++;
      else byStrat[key].e++;
    });
    const stratLines = Object.entries(byStrat)
      .map(([k, v]) => `  ${k}: ${v.w}W ${v.l}L ${v.e}E`)
      .join('\n') || '  нет данных';

    await sendTelegramTo(chatId,
      `🔬 ДИАГНОСТИКА БОТА\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `📊 Последние ${recent.length} сделок:\n` +
      `  Wins: ${wins} | Losses: ${losses} | Expired: ${expired}\n` +
      `  Win Rate: ${wr}%\n\n` +
      `📈 По стратегиям:\n${stratLines}\n\n` +
      `⚙️ Настройки:\n` +
      `  Прoп: ${store.propMode ? '🟢' : '🔴'}\n` +
      `  Авария: ${store.emergencyStop ? '🚨' : '✅'}\n` +
      `  Выходные: ${store.blockWeekends ? '🚫' : '✅'}\n` +
      `  Открытых сделок: ${store.openTrades.length}\n\n` +
      `💡 Если все стратегии в минусе — рынок не подходит. Лучше выключить /emergency на 1-2 дня.`
    );
  }

  else if (cmd === '/stocks') {
    if (!stocksEngine) {
      await sendTelegramTo(chatId, '❌ Stocks engine не загружен');
      return;
    }
    if (!stocksEngine.isMarketOpen()) {
      await sendTelegramTo(chatId,
        `📈 STOCKS\n━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `🔴 Рынок закрыт\n\n` +
        `NYSE/NASDAQ работает:\n` +
        `🇺🇸 14:30 — 21:00 UTC\n` +
        `🇰🇿 19:30 — 02:00 Алматы\n\n` +
        `Сигналы будут приходить автоматически когда рынок откроется.`
      );
      return;
    }
    const alpacaKey    = process.env.ALPACA_KEY;
    const alpacaSecret = process.env.ALPACA_SECRET;
    if (!alpacaKey || !alpacaSecret) {
      await sendTelegramTo(chatId,
        `📈 STOCKS\n━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `⚠️ Нет API ключей Alpaca\n\n` +
        `Добавь в Render Environment Variables:\n` +
        `ALPACA_KEY = твой ключ\n` +
        `ALPACA_SECRET = твой секрет\n\n` +
        `Получить ключи: alpaca.markets → Paper Trading → API Keys`
      );
      return;
    }
    await sendTelegramTo(chatId, '⏳ Сканирую акции...');
    const signals = await stocksEngine.scanStocks(alpacaKey, alpacaSecret, 0);
    if (!signals.length) {
      await sendTelegramTo(chatId, '📈 STOCKS\n\nСигналов нет. Попробуй позже.');
      return;
    }
    await sendTelegramTo(chatId,
      `📈 STOCKS — найдено ${signals.length} сигналов\n` +
      `Топ-3:\n\n` +
      signals.slice(0,3).map(s =>
        `${s.direction === 'long' ? '🟢' : '🔴'} ${s.symbol} | ${s.strategy.split(' ').slice(0,2).join(' ')} | ${s.confidence}%`
      ).join('\n')
    );
  }

  else if (cmd === '/webapp' || cmd === '/dashboard') {
    const appUrl = 'https://apexalgofund.com';
    await sendTelegramTo(chatId,
      `📊 *APEX ALGO FUND DASHBOARD*\n\n` +
      `🌐 ${appUrl}\n\n` +
      `📈 Что доступно:\n` +
      `• Live trades & open positions\n` +
      `• Paper trading statistics\n` +
      `• Strategy performance breakdown\n` +
      `• Quant metrics (Sharpe, Kelly, Calmar)\n` +
      `• Whale activity tracker\n` +
      `• Risk monitor & calibration\n\n` +
      `🔄 Auto-updates every 30 seconds\n` +
      `🌏 Hosted in Singapore`
    );
  }

  else if (cmd === '/psychologist') {
    await sendTelegramTo(chatId, '🧠 Анализирую твоё состояние...');
    await psychologistAgent();
  }

  else if (cmd === '/versions') {
    let msg = `📋 ВЕРСИИ СТРАТЕГИЙ\n━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    for (const [name, info] of Object.entries(STRATEGY_VERSIONS)) {
      const short = name.split(' ').slice(0,3).join(' ');
      msg += `${short}\n  v${info.v} (${info.date})\n  ${info.changes}\n\n`;
    }
    await sendTelegramTo(chatId, msg);
  }

  else if (cmd === '/logs') {
    try {
      if (!fs.existsSync(LOG_FILE)) {
        await sendTelegramTo(chatId, '📋 Лог-файл пуст');
        return;
      }
      const data = fs.readFileSync(LOG_FILE, 'utf8');
      const lines = data.trim().split('\n').slice(-30); // последние 30 строк
      const out = lines.join('\n').slice(-3500); // обрезать до 3500 chars
      await sendTelegramTo(chatId, `📋 ПОСЛЕДНИЕ ЛОГИ:\n\`\`\`\n${out}\n\`\`\``);
    } catch(e) {
      await sendTelegramTo(chatId, '❌ Ошибка чтения логов: ' + e.message);
    }
  }

  else if (cmd === '/weekly') {
    await sendTelegramTo(chatId, '💼 Генерирую еженедельный отчёт...');
    await weeklyPnLReport();
  }

  else if (cmd === '/benchmark') {
    const btc7  = await getBTCBenchmark(7);
    const btc30 = await getBTCBenchmark(30);
    const all   = [...store.tradeHistory, ...((global.paperTrades||[]).filter(t=>t.outcome))];
    const m7    = calcAdvancedMetrics(all.filter(t => (t.closedAt||t.ts) >= Date.now() - 7*24*60*60*1000));
    const m30   = calcAdvancedMetrics(all);
    await sendTelegramTo(chatId,
      `📊 БЕНЧМАРК vs BTC Buy&Hold\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `За 7 дней:\n` +
      `  BTC: ${btc7 ? (btc7.change >= 0 ? '+' : '') + btc7.change + '%' : 'н/д'}\n` +
      `  Бот: ${m7 ? (m7.totalPnl >= 0 ? '+' : '') + m7.totalPnl + '%' : 'мало данных'}\n\n` +
      `За всё время:\n` +
      `  Бот: ${m30 ? (m30.totalPnl >= 0 ? '+' : '') + m30.totalPnl + '%' : 'мало данных'}\n` +
      `  BTC 30д: ${btc30 ? (btc30.change >= 0 ? '+' : '') + btc30.change + '%' : 'н/д'}\n\n` +
      `💡 Цель: обгонять BTC на растущем рынке\n` +
      `   и терять меньше на падающем`
    );
  }

  else if (cmd === '/metrics') {
    const all = [
      ...store.tradeHistory,
      ...((global.paperTrades || []).filter(t => t.outcome)),
    ];
    const m = calcAdvancedMetrics(all);
    if (!m) {
      await sendTelegramTo(chatId, '📊 Недостаточно данных (нужно 5+ закрытых сделок)');
      return;
    }
    const dd     = checkWeeklyDrawdown();
    const pfIcon = m.profitFactor >= 1.5 ? '✅' : m.profitFactor >= 1.0 ? '⚠️' : '❌';
    const shIcon = m.sharpe >= 2.0 ? '✅' : m.sharpe >= 1.0 ? '⚠️' : '❌';
    const soIcon = m.sortino >= 2.0 ? '✅' : m.sortino >= 1.0 ? '⚠️' : '❌';
    const exIcon = m.expectancy >= 0.3 ? '✅' : m.expectancy >= 0 ? '⚠️' : '❌';

    // Анализ проигранных стратегий
    let lossLines = '';
    if (m.lossByStrategy && Object.keys(m.lossByStrategy).length) {
      const top = Object.entries(m.lossByStrategy)
        .sort((a,b) => b[1].totalLoss - a[1].totalLoss)
        .slice(0,3);
      lossLines = `\n❌ Топ убыточных:\n` + top.map(([k,v]) =>
        `  ${k}: ${v.count}x SL (-${v.totalLoss.toFixed(1)}%)`
      ).join('\n');
    }

    await sendTelegramTo(chatId,
      `📊 ПРОФЕССИОНАЛЬНЫЕ МЕТРИКИ\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `📈 Сделок: ${m.total} | WR: ${m.wr}%\n` +
      `💰 Total PnL: ${m.totalPnl >= 0 ? '+' : ''}${m.totalPnl}%\n\n` +
      `${pfIcon} Profit Factor: ${m.profitFactor}\n` +
      `   норма >1.5 | отлично >2.0\n\n` +
      `${exIcon} Expectancy: ${m.expectancy}%\n` +
      `   ожидаемая прибыль на сделку\n\n` +
      `${shIcon} Sharpe Ratio: ${m.sharpe}\n` +
      `${soIcon} Sortino Ratio: ${m.sortino}\n` +
      `   норма >1.5 (Sortino строже)\n\n` +
      `📉 Max Drawdown: -${m.maxDD}%\n` +
      `🔄 Recovery Factor: ${m.recoveryFactor}\n\n` +
      `💵 avg Win: +${m.avgWin}% | avg Loss: -${m.avgLoss}%\n\n` +
      `📅 Weekly DD: -${dd.weekLoss}% / 8%\n` +
      `${dd.isOverLimit ? '🚨 ПРЕВЫШЕН' : '✅ В норме'}` +
      lossLines
    );
  }

  else if (cmd === '/audit') {
    await sendTelegramTo(chatId, '🔍 Запускаю аудит стратегий...');
    await auditorAgent();
  }

  else if (cmd === '/debrief') {
    await sendTelegramTo(chatId, '🌙 Генерирую вечерний дебрифинг...');
    await eveningDebrief();
  }

  else if (cmd === '/report') {
    await sendTelegramTo(chatId, '🤖 Генерирую отчёт аналитика...');
    await dailyReport();
  }

  else if (cmd === '/paper') {
    const stats = getPaperStats();
    if (!stats) {
      await sendTelegramTo(chatId,
        `📄 PAPER TRADING\n━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `Пока нет закрытых виртуальных сделок.\n` +
        `Включи /observe и подожди — бот будет записывать сигналы и отслеживать их исход автоматически.`
      );
      return;
    }

    const { closed, wins, losses, expired, wr, totalPnl, byStrat } = stats;
    const open = (global.paperTrades || []).filter(t => !t.outcome).length;

    // Строки по стратегиям
    const stratLines = Object.entries(byStrat)
      .sort((a, b) => {
        const wrA = a[1].wins / (a[1].wins + a[1].losses + a[1].expired || 1);
        const wrB = b[1].wins / (b[1].wins + b[1].losses + b[1].expired || 1);
        return wrB - wrA;
      })
      .map(([name, s]) => {
        const total = s.wins + s.losses + s.expired;
        const stratWR = total ? Math.round(s.wins / total * 100) : 0;
        const icon = stratWR >= 55 ? '✅' : stratWR >= 40 ? '⚠️' : '❌';
        const shortName = name.split(' ').slice(0, 3).join(' ');
        return `${icon} ${shortName}: ${s.wins}W ${s.losses}L | WR ${stratWR}% | ${s.pnl >= 0 ? '+' : ''}${s.pnl.toFixed(1)}%`;
      })
      .join('\n');

    await sendTelegramTo(chatId,
      `📄 PAPER TRADING СТАТИСТИКА\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `📊 Всего закрыто: ${closed.length}\n` +
      `✅ TP: ${wins.length} | ❌ SL: ${losses.length} | ⏰ Expired: ${expired.length}\n` +
      `🎯 Win Rate: ${wr}%\n` +
      `💰 Суммарный PnL: ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}%\n` +
      `🔄 Открытых виртуальных: ${open}\n\n` +
      `📈 По стратегиям:\n${stratLines || 'нет данных'}\n\n` +
      `💡 ${wr >= 55 ? 'Хороший WR — можно переходить к реальной торговле с 0.5% риска' : wr >= 45 ? 'Нормально — продолжай наблюдение ещё неделю' : 'WR низкий — нужна настройка стратегий'}`
    );
  }

  else if (cmd === '/observe') {
    store.observeMode = !store.observeMode;
    if (store.observeMode) store.observeStartedAt = Date.now();
    saveSettings();
    if (store.observeMode) {
      await sendTelegramTo(chatId,
        `👁 РЕЖИМ НАБЛЮДЕНИЯ ВКЛЮЧЁН\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `✅ Все стратегии шлют сигналы\n` +
        `✅ Виртуальные сделки записываются автоматически\n` +
        `✅ Исходы (TP/SL) отслеживаются в реальном времени\n` +
        `❌ Реальных денег НЕ тратится\n\n` +
        `📊 Статистику смотри: /paper\n\n` +
        `Через 2-3 недели /paper покажет реальный WR\n` +
        `каждой стратегии — и ты поймёшь что работает.\n\n` +
        `Выключить: /observe`
      );
    } else {
      await sendTelegramTo(chatId,
        `👁 РЕЖИМ НАБЛЮДЕНИЯ ВЫКЛЮЧЕН\n` +
        `Сигналы снова открывают реальные сделки.\n\n` +
        `Накопленная статистика сохранена — /paper`
      );
    }
  }

  else if (cmd === '/emergency') {
    store.emergencyStop = true;
    saveSettings();
    await sendTelegramTo(chatId,
      `🚨 АВАРИЙНАЯ ОСТАНОВКА\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `❌ Новые сигналы НЕ отправляются\n` +
      `✅ Открытые сделки продолжают работать (SL/TP на бирже)\n\n` +
      `Для возобновления: /resume`
    );
  }

  else if (cmd === '/resume') {
    store.emergencyStop = false;
    saveSettings();
    await sendTelegramTo(chatId,
      `✅ БОТ ВОЗОБНОВЛЁН\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `Сигналы снова отправляются.`
    );
  }

  else if (cmd === '/autoexec') {
    if (!autoExecSignals) {
      await sendTelegramTo(chatId, '❌ AutoExec не загружен. Проверь AUTO_EXECUTE=true в Render.');
    } else {
      const arg = (text.trim().split(/\s+/)[1] || '').toLowerCase();
      autoExecSignals.emit('telegram_command', {
        command: '/autoexec', args: arg ? [arg] : [],
        replyFn: (t) => sendTelegramTo(chatId, t),
      });
    }
  }

  else if (cmd === '/positions') {
    if (!autoExecSignals) { await sendTelegramTo(chatId, '❌ AutoExec не загружен'); }
    else { autoExecSignals.emit('telegram_command', { command: '/positions', args: [], replyFn: (t) => sendTelegramTo(chatId, t) }); }
  }

  else if (cmd === '/resetpaper') {
    try {
      const paperCount = (global.paperTrades || []).length;
      const histCount  = store.tradeHistory.length;
      global.paperTrades = [];
      store.tradeHistory = store.tradeHistory.filter(t => t.source === 'bybit_real');
      await supabase.from('paper_trades').delete().neq('id', 0);
      await sendTelegramTo(chatId,
        `🗑 PAPER TRADES СБРОШЕНЫ\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `Удалено из памяти: ${paperCount} paper trades\n` +
        `История очищена: ${histCount - store.tradeHistory.length} записей\n\n` +
        `✅ Дашборд теперь чистый\n` +
        `Напиши /observe чтобы начать новый сбор данных`
      );
    } catch(e) {
      await sendTelegramTo(chatId, `❌ Ошибка сброса: ${e.message}`);
    }
  }

  else if (cmd === '/today') {
    const today = new Date().toISOString().split('T')[0];
    const todayTrades = store.tradeHistory.filter(t => {
      const d = new Date(t.closedAt || t.ts).toISOString().split('T')[0];
      return d === today;
    });
    const wins   = todayTrades.filter(t => t.outcome === 'tp1' || t.outcome === 'tp2').length;
    const losses = todayTrades.filter(t => t.outcome === 'sl').length;
    const be     = todayTrades.filter(t => t.outcome === 'breakeven').length;
    const riskUSD = store.accountBalance * store.riskPct / 100;
    const pnlUSD  = wins * riskUSD * 2 - losses * riskUSD;
    const openTrades = (store.openTrades || []).filter(t => t.instId && t.instId.includes('-USDT-SWAP'));

    await sendTelegramTo(chatId,
      `📅 ИТОГ ЗА СЕГОДНЯ
` +
      `━━━━━━━━━━━━━━━━━━━━━━

` +
      `📊 Сделок: ${todayTrades.length}
` +
      `✅ Побед: ${wins}
` +
      `❌ Потерь: ${losses}
` +
      `🛡 Безубыток: ${be}

` +
      `💵 P&L: ${pnlUSD >= 0 ? '+' : ''}$${pnlUSD.toFixed(0)}
` +
      `📈 Открытых: ${openTrades.length}

` +
      `${todayTrades.length === 0 ? 'Сделок сегодня не было.' : ''}` +
      (() => {
        const cot = cotCache.data;
        if (!Object.keys(cot).length) return '';
        const lines = Object.entries(cot).map(([a, d]) => {
          const e = d.signal==='bullish'?'🟢':d.signal==='bullish_weak'?'🟡':d.signal==='bearish'?'🔴':d.signal==='bearish_weak'?'🟠':'⚪️';
          return `${e} ${a}: ${d.signal} (inst ${d.netInst>0?'+':''}${d.netInst.toLocaleString()})`;
        }).join('\n');
        return `\n\n📊 COT Report (CFTC):\n${lines}`;
      })()
    );
  }

  else if (cmd === '/closeall') {
    if (!autoExecSignals) { await sendTelegramTo(chatId, '❌ AutoExec не загружен'); }
    else {
      await sendTelegramTo(chatId, '⚠️ Закрываю все позиции на Bybit...');
      autoExecSignals.emit('telegram_command', { command: '/closeall', args: [], replyFn: (t) => sendTelegramTo(chatId, t) });
    }
  }

  else if (cmd === '/weekends') {
    store.blockWeekends = !store.blockWeekends;
    saveSettings();
    await sendTelegramTo(chatId,
      store.blockWeekends
        ? `✅ Блокировка выходных ВКЛЮЧЕНА\nСигналы не приходят в субботу-воскресенье.`
        : `❌ Блокировка выходных ВЫКЛЮЧЕНА\nБот торгует все 7 дней.`
    );
  }

  else if (cmd === '/autoexec') {
    if (!autoExecSignals) {
      await sendTelegramTo(chatId,
        `❌ AutoExec не загружен\n\n` +
        `Проверь в Render:\n` +
        `AUTO_EXECUTE = true\n\n` +
        `И что файлы autoexec.js и bybit-client.js есть в репозитории.`
      );
    } else {
      const arg = (args[0] || '').toLowerCase();
      autoExecSignals.emit('telegram_command', {
        command: '/autoexec',
        args: arg ? [arg] : [],
        replyFn: (text) => sendTelegramTo(chatId, text),
      });
    }
  }

  else if (cmd === '/positions') {
    if (!autoExecSignals) {
      await sendTelegramTo(chatId, `❌ AutoExec не загружен`);
    } else {
      autoExecSignals.emit('telegram_command', {
        command: '/positions',
        args: [],
        replyFn: (text) => sendTelegramTo(chatId, text),
      });
    }
  }

  else if (cmd === '/today') {
    const today = new Date().toISOString().split('T')[0];
    const todayTrades = store.tradeHistory.filter(t => {
      const d = new Date(t.closedAt || t.ts).toISOString().split('T')[0];
      return d === today;
    });
    const wins   = todayTrades.filter(t => t.outcome === 'tp1' || t.outcome === 'tp2').length;
    const losses = todayTrades.filter(t => t.outcome === 'sl').length;
    const be     = todayTrades.filter(t => t.outcome === 'breakeven').length;
    const riskUSD = store.accountBalance * store.riskPct / 100;
    const pnlUSD  = wins * riskUSD * 2 - losses * riskUSD;
    const openTrades = (store.openTrades || []).filter(t => t.instId && t.instId.includes('-USDT-SWAP'));

    await sendTelegramTo(chatId,
      `📅 ИТОГ ЗА СЕГОДНЯ
` +
      `━━━━━━━━━━━━━━━━━━━━━━

` +
      `📊 Сделок: ${todayTrades.length}
` +
      `✅ Побед: ${wins}
` +
      `❌ Потерь: ${losses}
` +
      `🛡 Безубыток: ${be}

` +
      `💵 P&L: ${pnlUSD >= 0 ? '+' : ''}$${pnlUSD.toFixed(0)}
` +
      `📈 Открытых: ${openTrades.length}

` +
      `${todayTrades.length === 0 ? 'Сделок сегодня не было.' : ''}`
    );
  }

  else if (cmd === '/closeall') {
    if (!autoExecSignals) {
      await sendTelegramTo(chatId, `❌ AutoExec не загружен`);
    } else {
      await sendTelegramTo(chatId, `⚠️ Закрываю все позиции на Bybit...`);
      autoExecSignals.emit('telegram_command', {
        command: '/closeall',
        args: [],
        replyFn: (text) => sendTelegramTo(chatId, text),
      });
    }
  }

  else if (cmd === '/nightmode') {
    store.nightMode = !store.nightMode;
    saveSettings();
    if (store.nightMode) {
      await sendTelegramTo(chatId,
        `🌙 НОЧНОЙ РЕЖИМ ВКЛЮЧЁН\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `Бот работает пока ты спишь:\n` +
        `  Только S1 Volume Spike\n` +
        `  Риск: 0.3%\n` +
        `  Авто-стоп: 2 SL подряд\n\n` +
        `Включи AutoExec: /autoexec on\n` +
        `Выключить: /nightmode`
      );
    } else {
      await sendTelegramTo(chatId,
        `☀️ НОЧНОЙ РЕЖИМ ВЫКЛЮЧЕН\n` +
        `Не забудь: /autoexec off`
      );
    }
  }

  else if (cmd === '/setbalance') {
    const val = parseFloat(text.split(/\s+/)[1]);
    if (!val || val < 100) {
      await sendTelegramTo(chatId, `❌ Используй: /setbalance 10000`);
    } else {
      store.accountBalance = val;
      updatePeakBalance();
      saveSettings();
      const effRisk = getEffectiveRiskPct();
      const dd = store.peakBalance > val ? ((store.peakBalance - val) / store.peakBalance * 100).toFixed(1) : '0';
      await sendTelegramTo(chatId, `✅ Баланс: $${val.toLocaleString()}\nПик: $${store.peakBalance.toLocaleString()} (просадка ${dd}%)\nРиск: ${effRisk.toFixed(2)}% = $${(val * effRisk / 100).toFixed(0)}${effRisk < store.riskPct ? ' ⚠️ снижен' : ''}`);
    }
  }

  else if (cmd === '/setrisk') {
    const val = parseFloat(text.split(/\s+/)[1]);
    if (!val || val < 0.1 || val > 5) {
      await sendTelegramTo(chatId, `❌ Используй: /setrisk 1 (0.1 — 5%)`);
    } else {
      store.riskPct = val;
      saveSettings();
      await sendTelegramTo(chatId, `✅ Риск: ${val}% = $${(store.accountBalance * val / 100).toFixed(0)} на сделку`);
    }
  }

  else if (cmd === '/setleverage') {
    const val = parseInt(text.split(/\s+/)[1]);
    if (!val || val < 1 || val > 50) {
      await sendTelegramTo(chatId, `❌ Используй: /setleverage 10 (1 — 50x)`);
    } else {
      store.leverage = val;
      saveSettings();
      await sendTelegramTo(chatId, `✅ Плечо: ${val}x`);
    }
  }

  else if (cmd === '/account') {
    const risk = store.accountBalance * store.riskPct / 100;

    // Получаем реальный баланс с Bybit Demo
    let bybitBalance = null;
    if (autoExecSignals) {
      try {
        const BybitClient = require('./bybit-client');
        // Баланс через autoexec
      } catch(e) {}
    }

    // Считаем реальный P&L из истории сделок
    const trades = store.tradeHistory || [];
    const wins = trades.filter(t => t.outcome === 'tp1' || t.outcome === 'tp2').length;
    const losses = trades.filter(t => t.outcome === 'sl').length;
    const wr = trades.length ? Math.round(wins / trades.length * 100) : 0;
    const riskUSD = store.accountBalance * store.riskPct / 100;
    const pnlUSD = wins * riskUSD * 2 - losses * riskUSD;

    await sendTelegramTo(chatId,
      `💼 НАСТРОЙКИ АККАУНТА\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `Баланс:   $${store.accountBalance.toLocaleString()}\n` +
      `Риск:     ${store.riskPct}% = $${risk.toFixed(0)}\n` +
      `Плечо:    ${store.leverage}x\n` +
      `Прoп:     ${store.propMode ? '🟢 ВКЛ' : '🔴 ВЫКЛ'}\n` +
      `Авария:   ${store.emergencyStop ? '🚨 СТОП' : '✅ Работает'}\n` +
      `Выходные: ${store.blockWeekends ? '🚫 Блок' : '✅ Торгуем'}\n` +
      `Наблюд.:  ${store.observeMode ? '👁 ВКЛ (не торгуем)' : '🔴 ВЫКЛ'}\n\n` +
      `📊 Live Bot статистика:\n` +
      `  Сделок: ${trades.length} | WR: ${wr}%\n` +
      `  Побед: ${wins} | Потерь: ${losses}\n` +
      `  P&L: ${pnlUSD >= 0 ? '+' : ''}$${pnlUSD.toFixed(0)}\n\n` +
      `📊 При SL 1.5%:\n` +
      `Position Size: $${(risk / 0.015).toFixed(0)}\n` +
      `Маржа: $${(risk / 0.015 / store.leverage).toFixed(0)}\n\n` +
      `Команды:\n` +
      `/setbalance 10000\n` +
      `/setrisk 1\n` +
      `/setleverage 10\n` +
      `/emergency  — стоп\n` +
      `/resume     — старт\n` +
      `/weekends   — вкл/выкл выходные`
    );
  }

  else if (cmd === '/help') {
    await sendTelegramTo(chatId,
      `🤖 КРИПТО РАДАР\n━━━━━━━━━━━━━━━━━━━━━━\n` +
      `/status       — открытые сделки\n` +
      `/trades       — последние 10 сделок\n` +
      `/stats        — статистика за день\n` +
      `/whales       — 🐋 топ-5 трейдеров\n` +
      `/modules      — ⚙️ твои подписки\n` +
      `/guide        — инструкция по сигналам\n` +
      `/autoexec     — 🤖 вкл/выкл автоторговлю Bybit\n` +
      `/positions    — 📊 позиции на Bybit\n` +
      `/closeall     — 🔴 закрыть все позиции Bybit\n` +
      `/prop         — 🏆 вкл/выкл проп-режим\n` +
      `/propstatus   — статус проп-режима\n` +
      `/account      — 💼 настройки аккаунта\n` +
      `/setbalance   — установить баланс\n` +
      `/setrisk      — установить риск %\n` +
      `/setleverage  — установить плечо\n` +
      `🚨 АВАРИЙНЫЕ:\n` +
      `/today        — 📅 итог за сегодня\n` +
      `/emergency    — экстренный стоп\n` +
      `/resume       — возобновить\n` +
      `/weekends     — вкл/выкл выходные\n` +
      `/observe      — 👁 режим наблюдения\n` +
      `/paper        — 📄 paper trading статистика\n` +
      `/report       — 🤖 отчёт AI аналитика сейчас\n` +
      `/debrief      — 🌙 вечерний дебрифинг сейчас\n` +
      `/psychologist — 🧠 проверить психологическое состояние\n` +
      `/audit        — 🔍 аудит стратегий прямо сейчас\n` +
      `/metrics      — 📊 проф. метрики (Sharpe, PF, etc)\n` +
      `/weekly       — 💼 еженедельный P&L отчёт\n` +
      `/benchmark    — 📊 сравнение с BTC buy&hold\n` +
      `/versions     — 📋 версии стратегий\n` +
      `/logs         — 📋 последние логи бота\n` +
      `/webapp       — 📱 Paper Trading веб-приложение\n` +
      `/dashboard    — 🌐 apexalgofund.com (live dashboard)\n` +
      `/stocks       — 📈 сигналы по акциям\n\n` +
      `🔧 ПОДПИСКИ:\n` +
      `/anomalies_on  /anomalies_off\n` +
      `/news_on       /news_off\n` +
      `/whales_on     /whales_off`
    );
  }

  else if (cmd === '/guide') {
    await sendTelegramTo(chatId,
      `📖 ИНСТРУКЦИЯ\n━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `📌 СТРАТЕГИИ:\n` +
      `🟢 A — высокий win rate (~65-68%)\n` +
      `🟡 B — средний win rate (~55-58%)\n\n` +
      `💰 КАК ИСПОЛЬЗОВАТЬ СИГНАЛ:\n` +
      `1. Открой позицию по цене входа\n` +
      `2. Выставь стоп-лосс (SL) — защита\n` +
      `3. Тейк-1 (TP1) — частичная прибыль\n` +
      `4. Тейк-2 (TP2) — полная прибыль\n\n` +
      `📊 ЧТО ЗНАЧАТ МЕТРИКИ:\n` +
      `• OI — открытый интерес (новые деньги)\n` +
      `• VΔ — разница покупок и продаж\n` +
      `• RSI — перекупленность (>70) / перепроданность (<30)\n` +
      `• F&G — настроение рынка (0=паника, 100=эйфория)\n` +
      `• MACD — направление импульса\n\n` +
      `🐋 WHALE TRACKING:\n` +
      `• Киты покупают → подтверждает LONG\n` +
      `• Киты продают → подтверждает SHORT\n` +
      `• Против сигнала → осторожно!\n\n` +
      `📈 4H ТРЕНД:\n` +
      `• Торгуй по тренду — лучший win rate\n` +
      `• Против тренда — избегай или уменьши размер\n\n` +
      `⚠️ Не является финансовым советом.\n` +
      `Управляй рисками — не более 1-2% депозита на сделку.`
    );
  }
}

async function sendTelegramTo(chatId, text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  await httpPost(url, { chat_id: chatId, text });
}

// ── Inline-клавиатура для /modules ──────────────────────────
function buildModulesKeyboard(chatId) {
  const s = getSubs(chatId);
  const btn = (label, on, key) => ({
    text: `${on ? '🟢' : '🔴'} ${label}`,
    callback_data: `sub:${key}:${on ? 'off' : 'on'}`,
  });
  return {
    inline_keyboard: [
      [btn('Аномалии', s.anomalies, 'anomalies'), btn('Новости', s.news, 'news')],
      [btn('Киты', s.whales, 'whales')],
    ],
  };
}
function buildModulesText(chatId) {
  const s = getSubs(chatId);
  const ico = (b) => b ? '🟢 ON ' : '🔴 OFF';
  return (
    `⚙️ ТВОИ ПОДПИСКИ\n━━━━━━━━━━━━━━━━━━━━━━\n` +
    `${ico(s.anomalies)} Аномалии (OKX 24h ≥3%)\n` +
    `${ico(s.news)} Новости (RSS + AI)\n` +
    `${ico(s.whales)} Киты (Hyperliquid + Bybit)\n\n` +
    `👆 Нажми кнопку чтобы вкл/выкл.\n` +
    `ℹ️ Сигналы сделок приходят всегда.`
  );
}
async function sendModulesPanel(chatId) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  await httpPost(url, {
    chat_id: chatId,
    text: buildModulesText(chatId),
    reply_markup: JSON.stringify(buildModulesKeyboard(chatId)),
  });
}
async function editModulesPanel(chatId, messageId) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/editMessageText`;
  await httpPost(url, {
    chat_id: chatId,
    message_id: messageId,
    text: buildModulesText(chatId),
    reply_markup: JSON.stringify(buildModulesKeyboard(chatId)),
  });
}

async function pollTelegramUpdates() {
  let offset = 0;

  // Пропускаем старые апдейты при старте — убираем двойные ответы
  try {
    const init = await httpPost(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates`,
      { offset: -1, limit: 1, timeout: 0 },
      { 'Content-Type': 'application/json' }
    );
    if (init?.result?.length) {
      offset = init.result[init.result.length - 1].update_id + 1;
      console.log(`[TG] Старт с offset=${offset} (старые апдейты пропущены)`);
    }
  } catch(e) { console.error('[TG] init offset error:', e.message); }

  const poll = async () => {
    try {
      const data = await httpPost(
        `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates`,
        { offset, limit: 10, timeout: 5 },
        { 'Content-Type': 'application/json' }
      );
      if (data?.result?.length) {
        for (const update of data.result) {
          offset = update.update_id + 1;

          // Обычные команды
          const msg = update.message;
          if (msg?.text?.startsWith('/')) {
            console.log(`[TG CMD] ${msg.text} от ${msg.chat.id}`);
            await handleTelegramCommand(msg.text, msg.chat.id);
          }

          // Inline-кнопки (callback_query) — переключение подписок
          const cb = update.callback_query;
          if (cb?.data?.startsWith('sub:')) {
            const chatId   = cb.message?.chat?.id;
            const msgId    = cb.message?.message_id;
            const [, key, action] = cb.data.split(':');  // sub:anomalies:on
            if (chatId && SUB_MODULES.includes(key)) {
              const on = action === 'on';
              await setSub(chatId, key, on);
              console.log(`[SUBS] ${chatId}: ${key}=${on ? 'on' : 'off'} (inline)`);
              // Обновляем панель на месте (без нового сообщения)
              await editModulesPanel(chatId, msgId);
              // Ответ на callback чтобы убрать «часики» на кнопке
              await httpPost(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/answerCallbackQuery`, {
                callback_query_id: cb.id,
                text: `${on ? '🟢' : '🔴'} ${key === 'anomalies' ? 'Аномалии' : key === 'news' ? 'Новости' : 'Киты'} ${on ? 'ON' : 'OFF'}`,
              });
            }
          }
        }
      }
    } catch(e) { console.error('[TG POLL] error:', e.message); }
    setTimeout(poll, 3000);
  };
  poll();
}

// ============================================================
//  GROQ AI
// ============================================================
async function callGroq(prompt) {
  const data = await httpPost(
    'https://api.groq.com/openai/v1/chat/completions',
    { model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: prompt }] },
    { Authorization: `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' }
  );
  return data?.choices?.[0]?.message?.content || 'AI недоступен';
}

async function validateSignalWithAI(sig, fng, session) {
  const meta = STRATEGY_META[sig.strategy] || { rating: '?', wr: '?' };

  // ── АГЕНТ РИСК-МЕНЕДЖЕР ───────────────────────────────────
  // Проверяет сигнал по 6 критериям перед отправкой
  // Каждый критерий может заблокировать или снизить confidence

  // 1. Дневной лимит потерь
  const today = new Date().toISOString().split('T')[0];
  const dayLoss = global.dailyPnlTracker?.date === today
    ? global.dailyPnlTracker.losses : 0;
  const daySlCount = global.dailyPnlTracker?.date === today
    ? (global.dailyPnlTracker.slCount || 0) : 0;
  const maxDayLoss = store.propMode ? 3.0 : 5.0;

  if (dayLoss >= maxDayLoss * 0.8) {
    return {
      approved: false,
      confidence: 0,
      reason: `🛑 Риск-менеджер: дневные потери ${dayLoss.toFixed(1)}% близко к лимиту ${maxDayLoss}%`
    };
  }

  // 2. Серия SL подряд
  if (daySlCount >= 2) {
    // При 2+ SL за день — снижаем уверенность
    sig.confidence = Math.max(sig.confidence - 10, 0);
  }
  if (daySlCount >= 3) {
    return {
      approved: false,
      confidence: 0,
      reason: `🛑 Риск-менеджер: ${daySlCount} SL сегодня — пауза`
    };
  }

  // 3. Время — избегаем первые 15 минут после открытия сессий
  const nowUTC = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();
  const dangerZones = [
    { start: 0, end: 15, label: 'открытие азии' },     // 00:00 UTC
    { start: 420, end: 435, label: 'открытие лондона' }, // 07:00 UTC
    { start: 870, end: 885, label: 'открытие NY' },      // 14:30 UTC
  ];
  const inDangerZone = dangerZones.find(z => nowUTC >= z.start && nowUTC <= z.end);
  if (inDangerZone) {
    sig.confidence = Math.max(sig.confidence - 8, 0);
  }

  // 4. Paper trading статистика — если стратегия плохо работает
  const paperStats = getPaperStats();
  if (paperStats) {
    const stratKey = Object.keys(paperStats.byStrat).find(k =>
      sig.strategy.includes(k.substring(2, 10))
    );
    if (stratKey) {
      const s = paperStats.byStrat[stratKey];
      const total = s.wins + s.losses + s.expired;
      if (total >= 10) {
        const stratWR = s.wins / total;
        if (stratWR < 0.35) {
          // Стратегия плохо работает — снижаем confidence
          sig.confidence = Math.max(sig.confidence - 12, 0);
          sig.rmNote = `⚠️ РМ: WR стратегии ${Math.round(stratWR*100)}% < 35% → -12%`;
        } else if (stratWR > 0.6) {
          // Стратегия хорошо работает — буст
          sig.confidence = Math.min(sig.confidence + 5, 100);
          sig.rmNote = `✅ РМ: WR стратегии ${Math.round(stratWR*100)}% → +5%`;
        }
      }
    }
  }

  // 5. AI финальная оценка через Claude
  const prompt =
    `Ты агент риск-менеджер торгового бота. Оцени сигнал кратко.

Сигнал: ${sig.strategy} ${sig.direction.toUpperCase()} ${(sig.instId||'').replace('-USDT-SWAP','')}
Цена: $${sig.price} | SL: $${sig.sl} | TP1: $${sig.tp1}
Confidence: ${sig.confidence}%
Метрики: ${sig.metrics}
F&G: ${fng?.value || 50} (${fng?.label || 'N/A'})
Сессия: ${session}
SL сегодня: ${daySlCount}
Потери сегодня: ${dayLoss.toFixed(1)}%
${inDangerZone ? `⚠️ Опасная зона: ${inDangerZone.label}` : ''}
${sig.rmNote || ''}

Ответь СТРОГО одной строкой:
APPROVE | [число 60-95]
или
REJECT | [причина до 10 слов]`;

  try {
    const apiKey = process.env.CLAUDE_KEY || process.env.ANTHROPIC_API_KEY;
    if (apiKey) {
      const data = await httpPost(
        'https://api.anthropic.com/v1/messages',
        {
          model:      'claude-haiku-4-5-20251001',
          max_tokens: 60,
          messages:   [{ role: 'user', content: prompt }],
        },
        {
          'x-api-key':         apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type':      'application/json',
        }
      );
      const response = data?.content?.[0]?.text || '';
      if (response.trim()) {
        const line = response.trim().split('\n')[0].trim();
        console.log(`[RISK MGR] ${sig.instId} → ${line}`);
        return parseAIResponse(line, sig);
      }
    }

    // Fallback — Groq
    const response = await callGroq(prompt);
    const line = response.trim().split('\n')[0].trim();
    console.log(`[RISK MGR GROQ] ${sig.instId} → ${line}`);
    return parseAIResponse(line, sig);

  } catch(e) {
    console.error('[RISK MGR] error:', e.message);
    // При ошибке AI — пропускаем сигнал если confidence достаточный
    return {
      approved: sig.confidence >= 65,
      confidence: sig.confidence,
      reason: sig.confidence >= 65 ? 'AI недоступен — пропущен по confidence' : 'AI недоступен — низкий confidence'
    };
  }
}

function parseAIResponse(line, sig) {
  if (line.startsWith('APPROVE')) {
    const parts   = line.split('|');
    const newConf = parseInt(parts[1]?.trim());
    return {
      approved:   true,
      confidence: isNaN(newConf) ? sig.confidence : Math.min(newConf, 100),
      reason:     `Claude: ${isNaN(newConf) ? sig.confidence : newConf}%`,
    };
  }
  if (line.startsWith('REJECT')) {
    const reason = line.split('|')[1]?.trim() || 'Отклонён';
    console.log(`[AI REJECT] ${sig.instId} → ${reason}`);
    return { approved: false, confidence: 0, reason };
  }
  // Непонятный ответ — пропускаем
  return { approved: true, confidence: sig.confidence, reason: 'AI не определился' };
}


// ============================================================
//  OKX API
// ============================================================
async function getOKXCandidates() {
  const data = await httpGet('https://www.okx.com/api/v5/market/tickers?instType=SWAP');
  if (!data || data.code !== '0') return [];

  // Принудительно добавляем товарные и фондовые активы
  // (они могут не попасть в топ по объёму, но мы хотим их сканировать)
  const FORCED_ASSETS = [
    'XAU-USDT-SWAP',  // Золото
    'XAG-USDT-SWAP',  // Серебро
    'CL-USDT-SWAP',   // Нефть WTI
    'BZ-USDT-SWAP',   // Нефть Brent
    'NVDA-USDT-SWAP', // NVIDIA
    'TSLA-USDT-SWAP', // Tesla
    'AAPL-USDT-SWAP', // Apple
    'INTC-USDT-SWAP', // Intel
    'MSTR-USDT-SWAP', // MicroStrategy
  ];

  const allTickers = data.data.filter(t => t.instId.endsWith('-USDT-SWAP'));

  // Топ по объёму
  const topCoins = allTickers
    .map(t => ({
      instId:    t.instId,
      symbol:    (t.instId||'').replace('-USDT-SWAP', ''),
      price:     parseFloat(t.last),
      change24h: (parseFloat(t.last) - parseFloat(t.open24h)) / parseFloat(t.open24h) * 100,
      volume24h: parseFloat(t.volCcy24h) * parseFloat(t.last),
      fundingRate: parseFloat(t.fundingRate || 0),
    }))
    .filter(t => t.volume24h >= MIN_VOLUME_24H)
    .sort((a, b) => {
      const scoreA = b.volume24h + Math.abs(a.change24h) * 1e8;
      const scoreB = a.volume24h + Math.abs(b.change24h) * 1e8;
      return scoreA - scoreB;
    })
    .slice(0, TOP_N);

  // Добавляем форсированные активы если их нет в топе
  const topIds = new Set(topCoins.map(c => c.instId));
  for (const forcedId of FORCED_ASSETS) {
    if (topIds.has(forcedId)) continue;
    const ticker = allTickers.find(t => t.instId === forcedId);
    if (ticker && parseFloat(ticker.last) > 0) {
      topCoins.push({
        instId:      ticker.instId,
        symbol:      (ticker.instId||'').replace('-USDT-SWAP',''),
        price:       parseFloat(ticker.last),
        change24h:   (parseFloat(ticker.last) - parseFloat(ticker.open24h)) / parseFloat(ticker.open24h) * 100,
        volume24h:   parseFloat(ticker.volCcy24h) * parseFloat(ticker.last),
        fundingRate: parseFloat(ticker.fundingRate || 0),
        forced:      true,
      });
    }
  }

  return topCoins;
}

async function getOKXKlines(instId, bar, limit) {
  const data = await httpGet(`https://www.okx.com/api/v5/market/candles?instId=${instId}&bar=${bar}&limit=${limit}`);
  if (!data || data.code !== '0') return [];
  return data.data.reverse().map(c => ({
    ts: +c[0], open: +c[1], high: +c[2], low: +c[3], close: +c[4],
    volume: +c[5], quoteVolume: +c[7], takerBuyQuote: +c[7] * 0.5,
  }));
}

const KLINES_TTL = 60000; // 60 секунд

async function getOKXKlinesCached(instId, bar, limit) {
  const key = `${instId}-${bar}-${limit}`;
  const cached = store.klinesCache[key];
  if (cached && Date.now() - cached.ts < KLINES_TTL) {
    return cached.data;
  }
  const data = await getOKXKlines(instId, bar, limit);
  store.klinesCache[key] = { data, ts: Date.now() };
  // Чистим старые записи если кэш вырос больше 200 записей
  const keys = Object.keys(store.klinesCache);
  if (keys.length > 200) {
    const oldest = keys.sort((a,b) =>
      store.klinesCache[a].ts - store.klinesCache[b].ts
    ).slice(0, 50);
    oldest.forEach(k => delete store.klinesCache[k]);
  }
  return data;
}

async function getOKXOIHistory(ccy, period, limit) {
  const data = await httpGet(`https://www.okx.com/api/v5/rubik/stat/contracts/open-interest-volume?ccy=${ccy}&period=${period}&limit=${limit}`);
  if (!data || data.code !== '0') return [];
  return data.data.reverse().map(x => ({ ts: +x[0], oi: parseFloat(x[1]) }));
}

async function getOKXTakerFlow(ccy, period) {
  const data = await httpGet(`https://www.okx.com/api/v5/rubik/stat/taker-volume?ccy=${ccy}&instType=CONTRACTS&period=${period}`);
  if (!data || data.code !== '0' || !data.data?.length) return null;
  const l = data.data[0];
  const buyVol = parseFloat(l[1]), sellVol = parseFloat(l[2]);
  return { buyVol, sellVol, delta: buyVol - sellVol };
}

async function getCurrentPrice(instId) {
  const data = await httpGet(`https://www.okx.com/api/v5/market/ticker?instId=${instId}`);
  return data?.code === '0' ? parseFloat(data.data[0].last) : null;
}

// ============================================================
//  S14 + S15 — данные о ликвидациях и китах
// ============================================================

// Кэш ликвидаций OKX (обновляем раз в 60 секунд)
const liquidationCache = { data: null, ts: 0 };

async function getFearAndGreed() {
  if (store.fngCache && (Date.now() - store.fngTs) / 60000 < 60) return store.fngCache;
  const data = await httpGet('https://api.alternative.me/fng/?limit=1');
  if (!data?.data?.length) return { value: 50, label: 'Neutral' };
  store.fngCache = { value: parseInt(data.data[0].value), label: data.data[0].value_classification };
  store.fngTs    = Date.now();
  return store.fngCache;
}

function applyFearGreed(sig, fng) {
  if (!fng) return sig;
  let adjust = 0, note = '';
  if (sig.direction === 'long') {
    if (fng.value < 30)      { adjust = +10; note = `😱 Страх (${fng.value}) → +10%`; }
    else if (fng.value > 70) { adjust = -10; note = `🤑 Жадность (${fng.value}) → -10%`; }
  } else {
    if (fng.value > 70)      { adjust = +10; note = `🤑 Жадность (${fng.value}) → +10%`; }
    else if (fng.value < 30) { adjust = -10; note = `😱 Страх (${fng.value}) → -10%`; }
  }
  sig.confidence = Math.min(Math.max(sig.confidence + adjust, 0), 100);
  if (note) sig.fngNote = note;
  return sig;
}


// ============================================================
//  УРОВНИ S/R
// ============================================================
async function getSupportResistanceLevels(instId) {
  const klines = await getOKXKlinesCached(instId, '4H', 42);
  if (klines.length < 5) return { supports: [], resistances: [] };
  const supports = [], resistances = [];
  for (let i = 2; i < klines.length - 2; i++) {
    const { low, high } = klines[i];
    if (low  < klines[i-1].low  && low  < klines[i-2].low  && low  < klines[i+1].low  && low  < klines[i+2].low)  supports.push(low);
    if (high > klines[i-1].high && high > klines[i-2].high && high > klines[i+1].high && high > klines[i+2].high) resistances.push(high);
  }
  return { supports: mergeLevels(supports), resistances: mergeLevels(resistances) };
}

function mergeLevels(levels) {
  if (!levels.length) return [];
  levels.sort((a, b) => a - b);
  const merged = [levels[0]];
  for (let i = 1; i < levels.length; i++) {
    const last = merged[merged.length - 1];
    if (Math.abs(levels[i] - last) / last > 0.003) merged.push(levels[i]);
  }
  return merged;
}

function findNearest(price, levels) {
  return levels.find(l => Math.abs(l - price) / price <= 0.005) || null;
}

async function applySupportResistance(sig, instId) {
  try {
    const sr    = await getSupportResistanceLevels(instId);
    const price = sig.price;
    let note    = '';

    if (sig.direction === 'long') {
      const ns = findNearest(price, sr.supports);
      if (ns) { sig.confidence = Math.min(sig.confidence + 10, 100); note = `✅ Поддержка $${ns.toFixed(4)} → +10%`; }
      const nr = findNearest(price, sr.resistances);
      if (nr) { sig.confidence = Math.max(sig.confidence - 15, 0);  note = `⛔️ Сопротивление $${nr.toFixed(4)} → -15%`; }
    } else {
      const nr = findNearest(price, sr.resistances);
      if (nr) { sig.confidence = Math.min(sig.confidence + 10, 100); note = `✅ Сопротивление $${nr.toFixed(4)} → +10%`; }
      const ns = findNearest(price, sr.supports);
      if (ns) { sig.confidence = Math.max(sig.confidence - 15, 0);  note = `⛔️ Поддержка $${ns.toFixed(4)} → -15%`; }
    }

    if (note) sig.srNote = note;

    // Умный SL/TP
    const smart = await calcSmartSLTP(price, sig.direction, sr);
    sig.sl  = smart.sl;
    sig.tp1 = smart.tp1;
    sig.tp2 = smart.tp2;
    if (smart.slNote) sig.slNote = smart.slNote;

  } catch(e) { console.error('applySR error:', e.message); }
  return sig;
}

async function calcSmartSLTP(price, direction, sr) {
  const base = calcSLTP(price, direction, null);
  try {
    if (direction === 'long') {
      const supports = sr.supports.filter(s => s < price * 0.999);
      if (supports.length) {
        const nearest  = supports.reduce((p, c) => Math.abs(c - price) < Math.abs(p - price) ? c : p);
        const smartSL  = nearest * 0.997;
        if (smartSL > price * 0.97) {
          const slPct = (price - smartSL) / price * 100;
          return { sl: smartSL.toFixed(4), tp1: (price * (1 + slPct * 2 / 100)).toFixed(4),
            tp2: (price * (1 + slPct * 3 / 100)).toFixed(4), slNote: `📍 SL за поддержкой $${nearest.toFixed(4)}` };
        }
      }
    } else {
      const resistances = sr.resistances.filter(r => r > price * 1.001);
      if (resistances.length) {
        const nearest   = resistances.reduce((p, c) => Math.abs(c - price) < Math.abs(p - price) ? c : p);
        const smartSL   = nearest * 1.003;
        if (smartSL < price * 1.03) {
          const slPct = (smartSL - price) / price * 100;
          return { sl: smartSL.toFixed(4), tp1: (price * (1 - slPct * 2 / 100)).toFixed(4),
            tp2: (price * (1 - slPct * 3 / 100)).toFixed(4), slNote: `📍 SL за сопротивлением $${nearest.toFixed(4)}` };
        }
      }
    }
  } catch(e) {}
  return base;
}


// ============================================================
//  ПАТТЕРНЫ СВЕЧЕЙ
// ============================================================
function detectCandlePatterns(klines) {
  if (!klines || klines.length < 2) return [];
  const c      = klines[klines.length - 1];
  const p      = klines[klines.length - 2];
  const body   = Math.abs(c.close - c.open);
  const range  = c.high - c.low;
  const upper  = c.high - Math.max(c.close, c.open);
  const lower  = Math.min(c.close, c.open) - c.low;
  const isBull = c.close > c.open;
  const isBear = c.close < c.open;
  const patterns = [];
  if (range === 0) return patterns;

  if (body / range < 0.1) patterns.push({ name: 'doji', direction: 'neutral', desc: 'Доджи — нерешительность' });
  if (lower >= body * 2 && upper <= body) patterns.push({ name: 'hammer', direction: 'bullish', desc: 'Молот → разворот вверх' });
  if (upper >= body * 2 && lower <= body && isBear) patterns.push({ name: 'shooting_star', direction: 'bearish', desc: 'Падающая звезда → разворот вниз' });
  if (lower / range > 0.6) patterns.push({ name: 'pin_bar_bull', direction: 'bullish', desc: 'Пин-бар → отскок вверх' });
  if (upper / range > 0.6) patterns.push({ name: 'pin_bar_bear', direction: 'bearish', desc: 'Пин-бар → разворот вниз' });
  if (isBull && p.close < p.open && c.open <= p.close && c.close >= p.open)
    patterns.push({ name: 'bullish_engulfing', direction: 'bullish', desc: 'Бычье поглощение → сильный сигнал вверх' });
  if (isBear && p.close > p.open && c.open >= p.close && c.close <= p.open)
    patterns.push({ name: 'bearish_engulfing', direction: 'bearish', desc: 'Медвежье поглощение → сильный сигнал вниз' });

  return patterns;
}

async function applyCandlePatterns(sig, instId) {
  try {
    const k15m = await getOKXKlinesCached(instId, '15m', 5);
    const k1h  = await getOKXKlinesCached(instId, '1H',  5);
    const all  = [...detectCandlePatterns(k15m), ...detectCandlePatterns(k1h)];
    if (!all.length) return sig;

    let boost = 0;
    const notes = [];

    for (const pat of all) {
      if (pat.direction === 'neutral') { boost -= 5; notes.push(`〰️ ${pat.desc} → -5%`); continue; }
      const confirms   = (sig.direction === 'long' && pat.direction === 'bullish') || (sig.direction === 'short' && pat.direction === 'bearish');
      const contradicts= (sig.direction === 'long' && pat.direction === 'bearish') || (sig.direction === 'short' && pat.direction === 'bullish');
      if (confirms) {
        const add = pat.name.includes('engulfing') ? 15 : 10;
        boost += add; notes.push(`✅ ${pat.desc} → +${add}%`);
      } else if (contradicts) {
        if (pat.name.includes('engulfing') || pat.name.includes('pin_bar')) {
          sig.confidence = 0; notes.push(`🚫 ${pat.desc} — БЛОКИРОВКА`);
          sig.patternNote = notes.join(' | ');
          return sig;
        }
        boost -= 10; notes.push(`⚠️ ${pat.desc} → -10%`);
      }
    }
    sig.confidence = Math.min(Math.max(sig.confidence + boost, 0), 100);
    if (notes.length) sig.patternNote = notes.join(' | ');
  } catch(e) { console.error('applyCandlePatterns error:', e.message); }
  return sig;
}

// ============================================================
//  VOLUME PROFILE ФИЛЬТР
// ============================================================
function applyVolumeProfile(sig, klines) {
  try {
    if (!klines || klines.length < 20) return sig;
    const avgVol  = klines.slice(-21, -1).reduce((a, c) => a + c.quoteVolume, 0) / 20;
    const lastVol = klines[klines.length - 1].quoteVolume;
    const ratio   = lastVol / avgVol;

    if (ratio >= 2.0) {
      sig.confidence = Math.min(sig.confidence + 10, 100);
      sig.volNote    = `📊 Объём ${ratio.toFixed(1)}x среднего → +10%`;
    } else if (ratio < 0.7) {
      sig.confidence = Math.max(sig.confidence - 15, 0);
      sig.volNote    = `📊 Слабый объём ${ratio.toFixed(1)}x → -15%`;
    }
  } catch(e) {}
  return sig;
}

// ============================================================
// BTC тикер кэш — используется в S6 чтобы не делать запрос каждый раз
let btcTickerCache = { data: null, ts: 0 };
async function getBTCTickerCached() {
  if (btcTickerCache.data && Date.now() - btcTickerCache.ts < 60000) {
    return btcTickerCache.data;
  }
  try {
    const data = await httpGet('https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT-SWAP');
    if (data?.data?.[0]) {
      btcTickerCache = { data, ts: Date.now() };
    }
    return data;
  } catch(e) { return btcTickerCache.data || null; }
}

// ============================================================
//  4H ТРЕНД ФИЛЬТР
// ============================================================
async function apply4HTrend(sig, instId) {
  try {
    const k4h  = await getOKXKlinesCached(instId, '4H', 55);
    if (k4h.length < 51) return sig;

    const ma20 = calcSMA(k4h, 20);
    const ma50 = calcSMA(k4h, 50);
    const trend = ma20 > ma50 ? 'bullish' : 'bearish';

    if (sig.direction === 'long' && trend === 'bullish') {
      sig.confidence = Math.min(sig.confidence + 8, 100);
      sig.trendNote  = `📈 4H тренд бычий (MA20>MA50) → +8%`;
    } else if (sig.direction === 'short' && trend === 'bearish') {
      sig.confidence = Math.min(sig.confidence + 8, 100);
      sig.trendNote  = `📉 4H тренд медвежий (MA20<MA50) → +8%`;
    } else if (sig.direction === 'long' && trend === 'bearish') {
      sig.confidence = Math.max(sig.confidence - 20, 0);
      sig.trendNote  = `⚠️ 4H тренд медвежий — торговля против тренда → -20%`;
    } else if (sig.direction === 'short' && trend === 'bullish') {
      sig.confidence = Math.max(sig.confidence - 20, 0);
      sig.trendNote  = `⚠️ 4H тренд бычий — торговля против тренда → -20%`;
    }
  } catch(e) { console.error('apply4HTrend error:', e.message); }
  return sig;
}


// ============================================================
//  НОВОСТНОЙ ФИЛЬТР
// ============================================================
async function checkNews(symbol) {
  try {
    const key  = process.env.CRYPTOCOMPARE_KEY;
    if (!key) return { blocked: false, note: null };

    const data = await httpGet(
      `https://min-api.cryptocompare.com/data/v2/news/?categories=${symbol}&excludeCategories=Sponsored&lang=EN&api_key=${key}`
    );

    if (!data || data.Response !== 'Success' || !data.Data?.length) {
      return { blocked: false, note: null };
    }

    // Берём последние 5 новостей за последние 6 часов
    const sixHoursAgo = Date.now() / 1000 - 6 * 60 * 60;
    const recent = data.Data
      .filter(n => n.published_on >= sixHoursAgo)
      .slice(0, 5);

    if (!recent.length) return { blocked: false, note: null };

    const headlines = recent.map(n => n.title).join('\n');
    const prompt =
      `Ты криптовалютный аналитик. Последние новости по ${symbol}:\n\n${headlines}\n\n` +
      `Ответь ТОЛЬКО одним словом: POSITIVE, NEGATIVE или NEUTRAL.`;

    const sentiment = (await callGroq(prompt)).trim().toUpperCase();
    console.log(`[NEWS] ${symbol}: ${sentiment}`);

    if (sentiment.includes('NEGATIVE')) {
      return { blocked: true, reason: `📰 Негативные новости по ${symbol}` };
    }
    if (sentiment.includes('POSITIVE')) {
      return { blocked: false, note: `📰 Позитивные новости → подтверждает` };
    }
    return { blocked: false, note: null };

  } catch(e) {
    console.error('checkNews error:', e.message);
    return { blocked: false, note: null };
  }
}


// ============================================================
//  СЕССИИ
// ============================================================
function getCurrentSession() {
  const h = new Date().getUTCHours();
  if (h >= SESSION_USA.from && h < SESSION_USA.to && h >= SESSION_EUROPE.from) return 'US+EU';
  if (h >= SESSION_USA.from && h < SESSION_USA.to)    return 'USA';
  if (h >= SESSION_EUROPE.from && h < SESSION_EUROPE.to) return 'Europe';
  if (h >= SESSION_ASIA.from && h < SESSION_ASIA.to)  return 'Asia';
  return 'Off-hours';
}

function isAsianSession() {
  const h = new Date().getUTCHours();
  return h >= SESSION_ASIA.from && h < SESSION_ASIA.to;
}

function applySessionFilter(sig, session) {
  // В проп-режиме — жёсткий блок вне рабочих часов
  // Нерабочие часы = низкая ликвидность = фейковые пробои
  if (store.propMode && !store.observeMode) {
    const hour = new Date().getUTCHours();
    // Разрешены: Лондон (07-16 UTC) + NY (13-21 UTC) = 07:00-21:00 UTC
    if (hour < 7 || hour >= 21) {
      sig.confidence  = 0;
      sig.sessionNote = `❌ Проп: вне торговых часов (${hour}:xx UTC, нужно 07-21)`;
      return sig;
    }
  }

  if (['USA', 'Europe', 'US+EU'].includes(session)) {
    sig.confidence = Math.min(sig.confidence + 5, 100);
    sig.sessionNote = `🇺🇸🇪🇺 ${session} → +5%`;
  } else if (session === 'Asia') {
    sig.confidence = Math.max(sig.confidence - 20, 0);
    sig.sessionNote = '🌏 Азия (слабый объём) → -20%';
  } else {
    sig.confidence = Math.max(sig.confidence - 10, 0);
    sig.sessionNote = '🌙 Нерабочие часы → -10%';
  }
  return sig;
}

// ============================================================
//  LONG/SHORT RATIO, BTC DOMINANCE, COINBASE PREMIUM
// ============================================================

// Long/Short Ratio — соотношение лонгов и шортов
async function getLongShortRatio(symbol) {
  try {
    const data = await httpGet(
      `https://www.okx.com/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=${symbol}&period=1H&limit=2`
    );
    if (!data || data.code !== '0' || !data.data?.length) return null;
    const latest = data.data[0];
    const ratio  = parseFloat(latest[1]); // longRatio
    return {
      longPct:  (ratio * 100).toFixed(1),
      shortPct: ((1 - ratio) * 100).toFixed(1),
      extreme:  ratio > 0.75 ? 'long_extreme' : ratio < 0.25 ? 'short_extreme' : 'neutral',
    };
  } catch(e) { return null; }
}

function applyLongShortRatio(sig, lsr) {
  if (!lsr) return sig;

  // Если 75%+ лонгов — рынок перегрет лонгами → скоро шорт-сквиз → SHORT
  if (lsr.extreme === 'long_extreme') {
    if (sig.direction === 'short') {
      sig.confidence = Math.min(sig.confidence + 10, 100);
      sig.lsrNote    = `👥 ${lsr.longPct}% лонгов — перегрев → подтверждает шорт +10%`;
    } else {
      sig.confidence = Math.max(sig.confidence - 10, 0);
      sig.lsrNote    = `👥 ${lsr.longPct}% лонгов — опасно открывать лонг → -10%`;
    }
  }

  // Если 75%+ шортов — рынок перегрет шортами → скоро лонг-сквиз → LONG
  if (lsr.extreme === 'short_extreme') {
    if (sig.direction === 'long') {
      sig.confidence = Math.min(sig.confidence + 10, 100);
      sig.lsrNote    = `👥 ${lsr.shortPct}% шортов — перегрев → подтверждает лонг +10%`;
    } else {
      sig.confidence = Math.max(sig.confidence - 10, 0);
      sig.lsrNote    = `👥 ${lsr.shortPct}% шортов — опасно открывать шорт → -10%`;
    }
  }
  return sig;
}

// BTC Dominance — когда доминация растёт альты падают
async function getBTCDominance() {
  try {
    const data = await getCoingeckoGlobal();
    if (!data) return null;
    const dom    = parseFloat(data.market_cap_percentage?.btc || 0);
    const change = data.market_cap_change_percentage_24h_usd || 0;
    return { dom: dom.toFixed(1), change: change.toFixed(2), rising: dom > 55 };
  } catch(e) { return null; }
}

function applyBTCDominance(sig, btcDom, symbol) {
  if (!btcDom) return sig;
  // Если BTC доминация высокая (>55%) и монета не BTC — альты под давлением
  if (btcDom.rising && symbol !== 'BTC') {
    if (sig.direction === 'long') {
      sig.confidence = Math.max(sig.confidence - 8, 0);
      sig.btcDomNote = `📊 BTC Dom ${btcDom.dom}% высокая — альты под давлением → -8%`;
    } else {
      sig.confidence = Math.min(sig.confidence + 5, 100);
      sig.btcDomNote = `📊 BTC Dom ${btcDom.dom}% высокая — подтверждает шорт альта → +5%`;
    }
  }
  return sig;
}

// Coinbase Premium — разница BTC цены на Coinbase vs OKX
// Положительный = американцы покупают = рост
async function getCoinbasePremium() {
  try {
    const [okxData, cbData] = await Promise.all([
      httpGet('https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT-SWAP'),
      httpGet('https://api.coinbase.com/v2/prices/BTC-USD/spot'),
    ]);
    if (!okxData?.data?.[0] || !cbData?.data?.amount) return null;

    const okxPrice = parseFloat(okxData.data[0].last);
    const cbPrice  = parseFloat(cbData.data.amount);
    const premium  = ((cbPrice - okxPrice) / okxPrice * 100);

    return {
      premium:  premium.toFixed(3),
      positive: premium > 0.05,
      negative: premium < -0.05,
    };
  } catch(e) { return null; }
}

function applyCoinbasePremium(sig, cbPremium) {
  if (!cbPremium) return sig;

  // Положительный premium = американцы покупают BTC = бычий сигнал
  if (cbPremium.positive) {
    if (sig.direction === 'long') {
      sig.confidence  = Math.min(sig.confidence + 7, 100);
      sig.cbNote      = `🇺🇸 Coinbase Premium +${cbPremium.premium}% — США покупают → +7%`;
    }
  }
  // Отрицательный premium = американцы продают = медвежий сигнал
  if (cbPremium.negative) {
    if (sig.direction === 'short') {
      sig.confidence  = Math.min(sig.confidence + 7, 100);
      sig.cbNote      = `🇺🇸 Coinbase Premium ${cbPremium.premium}% — США продают → +7%`;
    } else if (sig.direction === 'long') {
      sig.confidence  = Math.max(sig.confidence - 7, 0);
      sig.cbNote      = `🇺🇸 Coinbase Premium ${cbPremium.premium}% — США продают → -7%`;
    }
  }
  return sig;
}

function applyDayOfWeekFilter(sig) {
  const day = new Date().getUTCDay(); // 0=вс, 1=пн, ..., 6=сб
  const hour = new Date().getUTCHours();

  // Понедельник — рынок часто слабый после выходных
  if (day === 1 && hour < 12) {
    sig.confidence = Math.max(sig.confidence - 10, 0);
    sig.dowNote = '📅 Понедельник утро (слабый рынок) → -10%';
  }

  // Пятница вечер — закрытие позиций перед выходными
  if (day === 5 && hour >= 18) {
    sig.confidence = Math.max(sig.confidence - 8, 0);
    sig.dowNote = '📅 Пятница вечер (закрытие позиций) → -8%';
  }

  // Пятница 08:00 UTC — экспирация опционов, высокая волатильность
  if (day === 5 && hour >= 7 && hour <= 9) {
    sig.confidence = Math.max(sig.confidence - 15, 0);
    sig.dowNote = '📅 Экспирация опционов (пятница 08 UTC) → -15%';
  }

  // Вторник/среда US сессия — исторически лучшие дни
  if ((day === 2 || day === 3) && hour >= 14 && hour <= 21) {
    sig.confidence = Math.min(sig.confidence + 5, 100);
    sig.dowNote = '📅 Вт/Ср US сессия (сильные дни) → +5%';
  }

  return sig;
}

// ============================================================
//  МАКРО КАЛЕНДАРЬ
// ============================================================
let macroCalendarCache = { data: null, ts: 0 };
async function checkMacroEvents() {
  try {
    // Кэшируем на 1 час — бесплатный API имеет rate limit
    if (macroCalendarCache.data && Date.now() - macroCalendarCache.ts < 3600000) {
      return processMacroData(macroCalendarCache.data);
    }
    const data = await httpGet('https://nfs.faireconomy.media/ff_calendar_thisweek.json');
    if (data && Array.isArray(data)) macroCalendarCache = { data, ts: Date.now() };
    if (!data && !macroCalendarCache.data) return null;
    return processMacroData(macroCalendarCache.data || data);
  } catch(e) { console.error('[MACRO] error:', e.message); return null; }
}

function processMacroData(data) {
  try {
    if (!data || !Array.isArray(data)) return null;
    const now = Date.now();
    const BLOCK_BEFORE = 30 * 60 * 1000;
    const BLOCK_AFTER  = 30 * 60 * 1000;
    const WARN_WINDOW  = 2 * 60 * 60 * 1000;

    const highImpact = data.filter(e => {
      if (e.impact !== 'High') return false;
      if (e.country !== 'USD') return false;
      const eventTime = new Date(e.date).getTime();
      return Math.abs(now - eventTime) < WARN_WINDOW;
    });
    if (!highImpact.length) return null;

    // Определяем — блокировать торговлю или только предупредить
    const blocking = highImpact.filter(e => {
      const eventTime = new Date(e.date).getTime();
      return (now >= eventTime - BLOCK_BEFORE) && (now <= eventTime + BLOCK_AFTER);
    });

    return {
      events:   highImpact.map(e => e.title).join(', '),
      count:    highImpact.length,
      blocking: blocking.length > 0, // true = блокируем сигналы
      blockReason: blocking.length > 0 ? blocking.map(e => e.title).join(', ') : null,
    };
  } catch(e) {
    console.error('checkMacroEvents API failed — continuing without news filter', e.message);
    return { events: 'unknown', blocking: false, count: 0 }; // safe fallback
  }
}

// Кэш для CoinGecko (лимит 30 req/min)
let coingeckoCache = { data: null, ts: 0 };
const COINGECKO_TTL = 30 * 60 * 1000; // 30 минут (rate limit защита)

async function getCoingeckoGlobal() {
  if (coingeckoCache.data && Date.now() - coingeckoCache.ts < COINGECKO_TTL) {
    return coingeckoCache.data;
  }
  try {
    const data = await httpGet('https://api.coingecko.com/api/v3/global');
    if (data?.data) {
      coingeckoCache = { data: data.data, ts: Date.now() };
      return data.data;
    }
  } catch(e) {}
  return coingeckoCache.data || null;
}

async function getBTCETFFlow() {
  try {
    const data = await getCoingeckoGlobal();
    if (!data) return null;
    const change = data.market_cap_change_percentage_24h_usd || 0;
    const btcDom = data.market_cap_percentage?.btc || 0;
    const bullish = change > 0;
    return {
      netFlow: change,
      label: bullish
        ? `🟢 Рынок +${change.toFixed(1)}% за 24h (BTC dom: ${btcDom.toFixed(1)}%)`
        : `🔴 Рынок ${change.toFixed(1)}% за 24h (BTC dom: ${btcDom.toFixed(1)}%)`,
      bullish,
    };
  } catch(e) { return null; }
}

function applyETFFlow(sig, etfFlow) {
  if (!etfFlow) return sig;

  if (sig.direction === 'long' && etfFlow.bullish) {
    sig.confidence = Math.min(sig.confidence + 8, 100);
    sig.etfNote    = `${etfFlow.label} → +8%`;
  } else if (sig.direction === 'short' && !etfFlow.bullish) {
    sig.confidence = Math.min(sig.confidence + 8, 100);
    sig.etfNote    = `${etfFlow.label} → +8%`;
  } else if (sig.direction === 'long' && !etfFlow.bullish) {
    sig.confidence = Math.max(sig.confidence - 10, 0);
    sig.etfNote    = `${etfFlow.label} → -10%`;
  }
  return sig;
}

function applyMacroFilter(sig, macroEvent) {
  if (!macroEvent) return sig;

  if (macroEvent.blocking) {
    // В окне ±30 мин от события — обнуляем confidence (блокировка)
    sig.confidence = 0;
    sig.macroNote  = `🚫 NEWS BLOCK: ${macroEvent.blockReason} → торговля заблокирована`;
  } else {
    // За 2 часа до события — снижаем уверенность на 25%
    sig.confidence  = Math.max(sig.confidence - 25, 0);
    sig.macroNote   = `⚠️ Скоро макро событие: ${macroEvent.events} → -25%`;
  }
  return sig;
}

// ============================================================
//  LIQUIDATION BOOST
// ============================================================
// Ликвидационные уровни — через OKX
async function getLiquidationLevels(symbol) {
  try {
    const SUPPORTED = ['BTC','ETH','SOL','XRP','BNB','DOGE','PEPE','AVAX',
      'LINK','ADA','MATIC','DOT','LTC','ATOM','NEAR','APT','ARB','OP','INJ',
      'TIA','HYPE','WIF','SHIB','HBAR','FIL','AAVE','XLM','BCH'];
    if (!SUPPORTED.includes(symbol)) return null;

    const data = await httpGet(
      `https://www.okx.com/api/v5/public/liquidation-orders?instType=SWAP&instId=${symbol}-USDT-SWAP&state=filled&limit=100`
    );
    if (!data || data.code !== '0' || !data.data?.length) return null;
    const details = data.data[0]?.details || [];
    if (!details.length) return null;

    let longLevels = [], shortLevels = [];
    details.forEach(d => {
      const usd = parseFloat(d.sz) * parseFloat(d.bkPx);
      const px  = parseFloat(d.bkPx);
      if (d.side === 'sell') longLevels.push({ px, usd });
      if (d.side === 'buy')  shortLevels.push({ px, usd });
    });

    const bigLong  = longLevels.sort((a,b)  => b.usd - a.usd)[0];
    const bigShort = shortLevels.sort((a,b) => b.usd - a.usd)[0];

    return {
      bigLongLevel:  bigLong?.px  || null,
      bigShortLevel: bigShort?.px || null,
      maxLong:  (longLevels.reduce((a,b)  => a + b.usd, 0) / 1e6).toFixed(2),
      maxShort: (shortLevels.reduce((a,b) => a + b.usd, 0) / 1e6).toFixed(2),
    };
  } catch(e) { return null; }
}

async function applyLiquidationLevels(sig) {
  try {
    const symbol = (sig.instId||'').replace('-USDT-SWAP', '');
    const liq    = await getLiquidationLevels(symbol);
    if (!liq) return sig;

    const price = sig.price;

    if (sig.direction === 'long' && liq.bigShortLevel) {
      const dist = (liq.bigShortLevel - price) / price * 100;
      // Большое скопление шорт-стопов выше — цена пойдёт туда → подтверждает LONG
      if (dist > 0 && dist < 5) {
        sig.confidence = Math.min(sig.confidence + 12, 100);
        sig.liqLevelNote = `🎯 Шорт-стопы $${liq.bigShortLevel.toFixed(2)} (+${dist.toFixed(1)}%) $${liq.maxShort}M → +12%`;
        // Используем уровень как TP
        sig.tp1 = (liq.bigShortLevel * 0.998).toFixed(4);
      }
    }

    if (sig.direction === 'short' && liq.bigLongLevel) {
      const dist = (price - liq.bigLongLevel) / price * 100;
      // Большое скопление лонг-стопов ниже — цена пойдёт туда → подтверждает SHORT
      if (dist > 0 && dist < 5) {
        sig.confidence = Math.min(sig.confidence + 12, 100);
        sig.liqLevelNote = `🎯 Лонг-стопы $${liq.bigLongLevel.toFixed(2)} (-${dist.toFixed(1)}%) $${liq.maxLong}M → +12%`;
        sig.tp1 = (liq.bigLongLevel * 1.002).toFixed(4);
      }
    }
  } catch(e) {
    console.error('applyLiquidationLevels error:', e.message);
  }
  return sig;
}

// ============================================================
//  WHALE TRACKER — крупные ордера OKX
// ============================================================
async function getWhaleActivity(instId, symbol) {
  try {
    // Крупные сделки через trade history
    const data = await httpGet(
      `https://www.okx.com/api/v5/market/trades?instId=${instId}&limit=50`
    );
    if (!data || data.code !== '0' || !data.data?.length) {
      return { hasWhales: false, buyUsd: 0, sellUsd: 0, dominant: 'none', note: null };
    }

    const price    = parseFloat(data.data[0].px);
    const WHALE_MIN = 100000; // $100k минимум для "кита"

    let buyUsd  = 0;
    let sellUsd = 0;
    let whaleTrades = 0;

    data.data.forEach(t => {
      const usd = parseFloat(t.sz) * parseFloat(t.px);
      if (usd < WHALE_MIN) return; // игнорируем мелкие сделки
      whaleTrades++;
      if (t.side === 'buy')  buyUsd  += usd;
      if (t.side === 'sell') sellUsd += usd;
    });

    if (whaleTrades === 0) {
      return { hasWhales: false, buyUsd: 0, sellUsd: 0, dominant: 'none', note: null };
    }

    const totalUsd = buyUsd + sellUsd;
    const dominant = buyUsd > sellUsd * 1.3 ? 'buy' :
                     sellUsd > buyUsd * 1.3  ? 'sell' : 'neutral';

    const note = dominant === 'buy'
      ? `🐋 Киты покупают $${(buyUsd/1e6).toFixed(2)}M vs продают $${(sellUsd/1e6).toFixed(2)}M`
      : dominant === 'sell'
      ? `🐋 Киты продают $${(sellUsd/1e6).toFixed(2)}M vs покупают $${(buyUsd/1e6).toFixed(2)}M`
      : `🐋 Нейтральная активность китов $${(totalUsd/1e6).toFixed(2)}M`;

    return { hasWhales: true, buyUsd, sellUsd, totalUsd, dominant, note, whaleTrades };
  } catch(e) {
    console.error('getWhaleActivity error:', e.message);
    return { hasWhales: false, buyUsd: 0, sellUsd: 0, dominant: 'none', note: null };
  }
}

async function applyWhaleBoost(sig) {
  const whale = await getWhaleActivity(sig.instId, (sig.instId||'').replace('-USDT-SWAP',''));
  if (!whale.hasWhales) return sig;

  if (sig.direction === 'long' && whale.dominant === 'buy') {
    sig.confidence = Math.min(sig.confidence + 15, 100);
    sig.whaleNote  = `${whale.note} → +15%`;
  } else if (sig.direction === 'short' && whale.dominant === 'sell') {
    sig.confidence = Math.min(sig.confidence + 15, 100);
    sig.whaleNote  = `${whale.note} → +15%`;
  } else if (
    (sig.direction === 'long'  && whale.dominant === 'sell') ||
    (sig.direction === 'short' && whale.dominant === 'buy')
  ) {
    sig.confidence = Math.max(sig.confidence - 20, 0);
    sig.whaleNote  = `${whale.note} → -20% (против сигнала)`;
  } else {
    sig.whaleNote = whale.note;
  }

  return sig;
}

async function applyLiquidationBoost(sig) {
  if (!sig.strategy.includes('Bounce')) return sig;
  const liq = await getLiquidationData(sig.instId);
  if (liq.totalUsd < 100000) return sig;
  if (sig.direction === 'long' && liq.dominant === 'longs') {
    sig.confidence = Math.min(sig.confidence + 15, 100);
    sig.liqNote = `💥 Ликвидации лонгов $${(liq.longLiqs/1e6).toFixed(2)}M → разворот +15%`;
  } else if (sig.direction === 'short' && liq.dominant === 'shorts') {
    sig.confidence = Math.min(sig.confidence + 15, 100);
    sig.liqNote = `💥 Ликвидации шортов $${(liq.shortLiqs/1e6).toFixed(2)}M → разворот +15%`;
  }
  return sig;
}


// ============================================================
//  ИНДИКАТОРЫ
// ============================================================
function calcOiChangePct(h) {
  if (!h || h.length < 2) return 0;
  const old = h[0].oi, cur = h[h.length - 1].oi;
  return old ? (cur - old) / old * 100 : 0;
}
function calcVolumeDelta(k) {
  if (!k?.length) return 0;
  const c = k[k.length - 1];
  return c.takerBuyQuote - (c.quoteVolume - c.takerBuyQuote);
}
function calcPriceChangePct(k) {
  if (!k || k.length < 2) return 0;
  const prev = k[k.length - 2].close, cur = k[k.length - 1].close;
  return prev ? (cur - prev) / prev * 100 : 0;
}
// ── COT REPORT (CFTC) — Commitment of Traders ────────────────
// Публикуется каждую пятницу в 15:30 ET на cftc.gov
// Показывает позиции институционалов vs физиков по каждому активу
// Используем как sentiment filter для XAU, XAG, CL, BZ

let cotCache = {
  ts: 0,
  data: {}, // { XAU: { netInst: 0, netRetail: 0, signal: 'neutral', raw: {} }, ... }
};

// CFTC коды активов для legacy COT report
const COT_CODES = {
  XAU: '088691', // Gold - COMEX
  XAG: '084691', // Silver - COMEX
  CL:  '067651', // Crude Oil WTI - NYMEX
  BZ:  '067651', // Brent (используем WTI как прокси)
};

// Парсим CSV строку из CFTC legacy format
function parseCOTcsv(csvText, code) {
  try {
    const lines = csvText.split('\n').filter(l => l.includes(code));
    if (!lines.length) return null;

    // Берём самую свежую строку (первая после header)
    const cols = lines[0].split(',').map(s => s.replace(/"/g, '').trim());

    // Индексы по legacy COT format:
    // 7 = NonComm Long, 8 = NonComm Short (институционалы / hedge funds)
    // 10 = NonReport Long, 11 = NonReport Short (retail / физики)
    const nonCommLong  = parseInt(cols[7])  || 0;
    const nonCommShort = parseInt(cols[8])  || 0;
    const retailLong   = parseInt(cols[10]) || 0;
    const retailShort  = parseInt(cols[11]) || 0;

    const netInst   = nonCommLong - nonCommShort;   // >0 = институционалы net long
    const netRetail = retailLong  - retailShort;     // >0 = физики net long

    // Сигнал:
    // inst net long + retail net short → сильный лонг сигнал (институционалы покупают, физики продают)
    // inst net short + retail net long → медвежий (институционалы продают, физики покупают)
    let signal = 'neutral';
    if (netInst > 10000 && netRetail < 0)  signal = 'bullish';
    else if (netInst > 5000)               signal = 'bullish_weak';
    else if (netInst < -10000 && netRetail > 0) signal = 'bearish';
    else if (netInst < -5000)              signal = 'bearish_weak';

    return { netInst, netRetail, signal, nonCommLong, nonCommShort, retailLong, retailShort };
  } catch(e) {
    console.error('[COT] parseCOTcsv error:', e.message);
    return null;
  }
}

async function fetchCOTReport() {
  const CACHE_TTL = 6 * 3600 * 1000; // 6 часов (отчёт раз в неделю)
  if (Date.now() - cotCache.ts < CACHE_TTL && Object.keys(cotCache.data).length) {
    return cotCache.data;
  }

  try {
    console.log('[COT] Загружаем CFTC COT Report...');

    // CFTC legacy CSV — текущий год
    const year = new Date().getFullYear();
    const url  = `https://www.cftc.gov/dea/newcot/fut_fin_xls_${year}.zip`;

    // Fallback: используем прямой CSV (без zip для простоты)
    // CFTC URLs — пробуем несколько
    const COT_URLS = [
      'https://www.cftc.gov/dea/newcot/FinFutYY.txt',
      'https://www.cftc.gov/files/dea/history/fut_fin_xls_2025.zip',
      'https://www.cftc.gov/dea/newcot/fut_disagg_xls.zip',
    ];

    let csvText = null;
    for (const csvUrl of COT_URLS) {
      try {
        const resp = await axios.get(csvUrl, {
          timeout: 20000,
          headers: { 'User-Agent': 'Mozilla/5.0' },
          responseType: 'text',
        });
        if (resp.data && resp.data.length > 100) {
          csvText = resp.data;
          console.log('[COT] Загружено с:', csvUrl);
          break;
        }
      } catch(urlErr) {
        console.log('[COT] URL недоступен:', csvUrl);
      }
    }

    if (!csvText) throw new Error('Все COT URLs недоступны');

    const result = {};
    for (const [asset, code] of Object.entries(COT_CODES)) {
      const parsed = parseCOTcsv(csvText, code);
      if (parsed) {
        result[asset] = parsed;
        console.log(`[COT] ${asset}: netInst=${parsed.netInst > 0 ? '+' : ''}${parsed.netInst} netRetail=${parsed.netRetail > 0 ? '+' : ''}${parsed.netRetail} → ${parsed.signal}`);
      }
    }

    if (Object.keys(result).length) {
      cotCache = { ts: Date.now(), data: result };
      console.log('[COT] ✅ Загружено успешно');
    }

    return cotCache.data;
  } catch(e) {
    console.error('[COT] fetchCOTReport error:', e.message);
    // Возвращаем кэш если есть, иначе пустой
    return cotCache.data;
  }
}

// Применяем COT к сигналу — только для commodities
function applyCOTFilter(sig) {
  const coin = (sig.instId || '').replace('-USDT-SWAP', '').split('-')[0];
  const cot  = cotCache.data?.[coin];

  if (!cot) return sig; // нет данных — пропускаем без изменений

  const { signal, netInst } = cot;
  const dir = sig.direction;

  // ЛОНГ против медвежьего COT — снижаем уверенность
  if (dir === 'long' && (signal === 'bearish' || signal === 'bearish_weak')) {
    const penalty = signal === 'bearish' ? 15 : 8;
    sig.confidence = Math.max(sig.confidence - penalty, 0);
    sig.cotNote = `⚠️ COT bearish (inst net ${netInst > 0 ? '+' : ''}${netInst}) → -${penalty}%`;
    console.log(`[COT] ${coin} LONG пенальти -${penalty}% | ${sig.cotNote}`);
  }

  // ШОРТ против бычьего COT
  if (dir === 'short' && (signal === 'bullish' || signal === 'bullish_weak')) {
    const penalty = signal === 'bullish' ? 15 : 8;
    sig.confidence = Math.max(sig.confidence - penalty, 0);
    sig.cotNote = `⚠️ COT bullish (inst net +${netInst}) → -${penalty}%`;
    console.log(`[COT] ${coin} SHORT пенальти -${penalty}% | ${sig.cotNote}`);
  }

  // БОНУС: сигнал совпадает с институционалами
  if (dir === 'long'  && signal === 'bullish')  { sig.confidence = Math.min(sig.confidence + 8, 100); sig.cotNote = `✅ COT bullish (inst +${netInst}) → +8%`; }
  if (dir === 'short' && signal === 'bearish')  { sig.confidence = Math.min(sig.confidence + 8, 100); sig.cotNote = `✅ COT bearish (inst ${netInst}) → +8%`; }

  return sig;
}

// Загрузка при старте
fetchCOTReport().catch(e => console.error('[COT] init error:', e.message));

// ── DVOL — Deribit Volatility Index (крипто аналог VIX) ──────
let dvolCache = { btc: null, eth: null, ts: 0 };
async function getDVOL() {
  if (Date.now() - dvolCache.ts < 300000) return dvolCache;
  try {
    const res = await httpGet(
      'https://www.deribit.com/api/v2/public/get_volatility_index_data' +
      '?currency=BTC&start_timestamp=' + (Date.now() - 3600000) +
      '&end_timestamp=' + Date.now() + '&resolution=3600'
    );
    const dvol = res?.result?.data?.slice(-1)?.[0]?.[4] || null;
    dvolCache = { btc: dvol, ts: Date.now() };
    if (dvol) console.log(`[DVOL] BTC: ${dvol}`);
    return dvolCache;
  } catch(e) {
    console.error('[DVOL] error:', e.message);
    return dvolCache;
  }
}

// ── SLIPPAGE MODEL ───────────────────────────────────────────
// Реалистичные потери при входе/выходе (аудит v2.0)
// Top liquid coins: 0.05-0.08% | Mid: 0.12-0.18% | Small: 0.25-0.5%
const SLIPPAGE_TIERS = {
  // Топ ликвидные — минимальный slippage
  TOP: new Set(['BTC','ETH','SOL','BNB','XRP','DOGE','ADA','AVAX','TRX','TON','LINK','DOT']),
  // Средние — умеренный slippage
  MID: new Set(['NEAR','SUI','APT','OP','ARB','INJ','WLD','HYPE','JUP','PENGU',
                'TRUMP','ONDO','AAVE','UNI','LTC','BCH','ETC','XLM','ATOM','FIL',
                'XAU','XAG','CL','BZ','NVDA','TSLA','AAPL']),
};

function getSlippagePct(instId) {
  const coin = (instId || '').replace('-USDT-SWAP','').replace('-USDT','').toUpperCase();
  if (SLIPPAGE_TIERS.TOP.has(coin)) return 0.07;  // 0.07% — топ монеты
  if (SLIPPAGE_TIERS.MID.has(coin)) return 0.15;  // 0.15% — средние
  return 0.35;                                      // 0.35% — мелкие/неизвестные
}

// Применяем slippage к PnL — вычитаем при входе И выходе
function applySlippage(pnl, instId, direction) {
  const slip = getSlippagePct(instId);
  // Slippage при входе + при выходе = 2x
  // Для лонга: покупаем дороже + продаём дешевле
  // Для шорта: продаём дешевле + покупаем дороже
  return parseFloat((pnl - slip * 2).toFixed(3));
}


// Самый торгуемый уровень за текущую неделю — магнит для цены
// ── OPTIONS UNUSUAL ACTIVITY — крупные опционные сделки ──────
let optionsFlowCache = { btc: null, eth: null, ts: 0 };
const OPTIONS_FLOW_TTL = 30 * 60 * 1000;

async function getOptionsUnusualActivity(coin) {
  if (!['BTC','ETH'].includes(coin)) return null;
  const key = coin.toLowerCase();
  if (optionsFlowCache[key] && Date.now() - optionsFlowCache.ts < OPTIONS_FLOW_TTL) {
    return optionsFlowCache[key];
  }
  try {
    const data = await httpGet(
      `https://www.deribit.com/api/v2/public/get_last_trades_by_currency?currency=${coin}&kind=option&count=100&include_old=false`
    );
    if (!data?.result?.trades) return null;
    const trades = data.result.trades;
    const MIN_NOTIONAL = 1_000_000;
    const large = trades.filter(t => {
      const notional = (t.price||0) * (t.amount||0) * (t.underlying_price||0);
      return notional >= MIN_NOTIONAL;
    }).map(t => ({
      instrument: t.instrument_name,
      direction:  t.direction,
      notional:   Math.round((t.price||0) * (t.amount||0) * (t.underlying_price||0)),
      isCall:     t.instrument_name.includes('-C'),
    }));

    const callBuys = large.filter(t => t.isCall && t.direction === 'buy');
    const putBuys  = large.filter(t => !t.isCall && t.direction === 'buy');
    const totalCallNotional = callBuys.reduce((s,t) => s + t.notional, 0);
    const totalPutNotional  = putBuys.reduce((s,t) => s + t.notional, 0);

    let signal = 'neutral';
    if (totalCallNotional > totalPutNotional * 2) signal = 'bullish';
    else if (totalPutNotional > totalCallNotional * 2) signal = 'bearish';

    const result = { signal, totalCallNotional, totalPutNotional, count: large.length };
    optionsFlowCache[key] = result;
    optionsFlowCache.ts   = Date.now();
    if (signal !== 'neutral') console.log(`[OPTIONS FLOW] ${coin}: ${signal} calls=$${(totalCallNotional/1e6).toFixed(1)}M puts=$${(totalPutNotional/1e6).toFixed(1)}M`);
    return result;
  } catch(e) { return null; }
}

// ── ORDER BOOK IMBALANCE — топ-10 уровней стакана OKX ─────────
async function getOrderBookImbalance(instId) {
  try {
    const data = await httpGet(`https://www.okx.com/api/v5/market/books?instId=${instId}&sz=20`);
    if (!data?.data?.[0]) return null;
    const book = data.data[0];
    const bidVol = (book.bids||[]).slice(0,10).reduce((s,b) => s + parseFloat(b[1]||0), 0);
    const askVol = (book.asks||[]).slice(0,10).reduce((s,a) => s + parseFloat(a[1]||0), 0);
    const total  = bidVol + askVol;
    if (!total) return null;
    const imbalance = (bidVol - askVol) / total;
    return {
      imbalance: parseFloat(imbalance.toFixed(3)),
      bidPct:    Math.round(bidVol / total * 100),
      askPct:    Math.round(askVol / total * 100),
      signal:    imbalance > 0.2 ? 'bullish' : imbalance < -0.2 ? 'bearish' : 'neutral',
    };
  } catch(e) { return null; }
}

let weeklyPocCache  = new Map();
let monthlyPocCache = new Map();

// ── Общая функция расчёта Volume Profile ─────────────────────
function calcVolumeProfile(candles, zones = 50) {
  if (!candles?.length) return null;
  const allHighs  = candles.map(k => k.high || k.close);
  const allLows   = candles.map(k => k.low  || k.close);
  const priceHigh = Math.max(...allHighs);
  const priceLow  = Math.min(...allLows);
  const range     = priceHigh - priceLow;
  if (range <= 0) return null;

  const zoneSize     = range / zones;
  const volumeByZone = new Array(zones).fill(0);

  for (const k of candles) {
    const vol    = k.quoteVolume || 0;
    const high   = k.high || k.close;
    const low    = k.low  || k.close;
    const kRange = high - low || zoneSize;
    for (let z = 0; z < zones; z++) {
      const zLow    = priceLow + z * zoneSize;
      const zHigh   = zLow + zoneSize;
      const overlap = Math.max(0, Math.min(high, zHigh) - Math.max(low, zLow));
      volumeByZone[z] += vol * (overlap / kRange);
    }
  }

  const pocIdx  = volumeByZone.indexOf(Math.max(...volumeByZone));
  const poc     = priceLow + (pocIdx + 0.5) * zoneSize;
  const totalVol = volumeByZone.reduce((a,b) => a+b, 0);

  // Value Area = 70% объёма вокруг POC
  let vaVol = volumeByZone[pocIdx], vaLow = pocIdx, vaHigh = pocIdx;
  while (vaVol < totalVol * 0.7 && (vaLow > 0 || vaHigh < zones - 1)) {
    const extLow  = vaLow  > 0       ? volumeByZone[vaLow - 1]  : 0;
    const extHigh = vaHigh < zones-1 ? volumeByZone[vaHigh + 1] : 0;
    if (extLow >= extHigh && vaLow > 0) { vaLow--;  vaVol += extLow; }
    else if (vaHigh < zones - 1)        { vaHigh++; vaVol += extHigh; }
    else break;
  }

  return {
    poc: parseFloat(poc.toFixed(6)),
    vah: parseFloat((priceLow + (vaHigh + 1) * zoneSize).toFixed(6)),
    val: parseFloat((priceLow + vaLow * zoneSize).toFixed(6)),
    ts:  Date.now(),
    // Low Volume Nodes — зоны с объёмом < 30% от среднего (быстро проходимые)
    // High Volume Nodes — зоны с объёмом > 150% от среднего (магниты, поддержки)
    lvn: (() => {
      const avg = totalVol / zones;
      const nodes = [];
      for (let z = 0; z < zones; z++) {
        if (volumeByZone[z] < avg * 0.30) {
          nodes.push({
            price: parseFloat((priceLow + (z + 0.5) * zoneSize).toFixed(6)),
            low:   parseFloat((priceLow + z * zoneSize).toFixed(6)),
            high:  parseFloat((priceLow + (z + 1) * zoneSize).toFixed(6)),
            vol:   volumeByZone[z],
          });
        }
      }
      return nodes;
    })(),
    hvn: (() => {
      const avg = totalVol / zones;
      const nodes = [];
      for (let z = 0; z < zones; z++) {
        if (volumeByZone[z] > avg * 1.50) {
          nodes.push({
            price: parseFloat((priceLow + (z + 0.5) * zoneSize).toFixed(6)),
            low:   parseFloat((priceLow + z * zoneSize).toFixed(6)),
            high:  parseFloat((priceLow + (z + 1) * zoneSize).toFixed(6)),
            vol:   volumeByZone[z],
          });
        }
      }
      return nodes;
    })(),
    volumeByZone,
    zoneSize,
    priceLow,
  };
}

async function getWeeklyPOC(instId) {
  const cached = weeklyPocCache.get(instId);
  if (cached && Date.now() - cached.ts < 3600000) return cached;
  try {
    const k1h = await getOKXKlinesCached(instId, '1H', 168);
    if (k1h.length < 24) return null;
    const now        = new Date();
    const dayOfWeek  = now.getDay() === 0 ? 6 : now.getDay() - 1;
    const weekStart  = Date.now() - dayOfWeek * 86400000 - now.getHours() * 3600000;
    const candles    = k1h.filter(k => k.ts >= weekStart);
    if (candles.length < 8) { weeklyPocCache.set(instId, null); return null; }
    const result = calcVolumeProfile(candles);
    if (result) weeklyPocCache.set(instId, result);
    return result;
  } catch(e) { console.error('[WeeklyPOC]', instId, e.message); return null; }
}

async function getMonthlyPOC(instId) {
  const cached = monthlyPocCache.get(instId);
  if (cached && Date.now() - cached.ts < 7200000) return cached; // кэш 2 часа
  try {
    // 30 дней × 24 часа = 720 часов (берём 4H свечи = 180 свечей)
    const k4h    = await getOKXKlinesCached(instId, '4H', 180);
    if (k4h.length < 30) return null;
    const result = calcVolumeProfile(k4h);
    if (result) monthlyPocCache.set(instId, result);
    console.log(`[MonthlyPOC] ${instId}: POC=${result?.poc}`);
    return result;
  } catch(e) { console.error('[MonthlyPOC]', instId, e.message); return null; }
}

// ── GEX (Gamma Exposure) из Deribit ──────────────────────────
// Уровни где маркет-мейкеры держат гамму → магниты цены
// Работает только для BTC и ETH
let gexCache = { btc: null, eth: null, ts: 0 };

async function getGEXLevels(coin) {
  if (!['BTC','ETH'].includes(coin)) return null;
  const key = coin.toLowerCase();
  if (gexCache[key] && Date.now() - gexCache.ts < 3600000) return gexCache[key];

  try {
    const instruments = await httpGet(
      `https://www.deribit.com/api/v2/public/get_instruments?currency=${coin}&kind=option&expired=false`
    );
    if (!instruments?.result) return null;

    const now30d = Date.now() + 30 * 86400000;
    const near = instruments.result.filter(i =>
      i.expiration_timestamp < now30d && i.strike
    );
    if (!near.length) return null;

    const strikes = {};
    let totalNetGEX = 0;

    for (const ins of near.slice(0, 150)) {
      const strike = ins.strike;
      if (!strikes[strike]) strikes[strike] = { callGEX: 0, putGEX: 0, callOI: 0, putOI: 0 };
      try {
        const ticker = await httpGet(
          `https://www.deribit.com/api/v2/public/ticker?instrument_name=${ins.instrument_name}`
        );
        const gamma = ticker?.result?.greeks?.gamma || 0;
        const oi    = ticker?.result?.open_interest || 0;
        const price = ticker?.result?.underlying_price || 1;
        const gex   = gamma * oi * price * price * 0.01;

        const isCall = ins.instrument_name.includes('-C');
        if (isCall) {
          strikes[strike].callGEX += gex;
          strikes[strike].callOI  += oi;
          totalNetGEX += gex;  // calls = positive GEX
        } else {
          strikes[strike].putGEX  += gex;
          strikes[strike].putOI   += oi;
          totalNetGEX -= gex;  // puts = negative GEX
        }
      } catch(_) {}
    }

    // Net GEX per strike (call - put)
    const levels = Object.entries(strikes)
      .map(([strike, d]) => ({
        strike:  parseFloat(strike),
        netGEX:  d.callGEX - d.putGEX,
        callGEX: d.callGEX,
        putGEX:  d.putGEX,
        totalOI: d.callOI + d.putOI,
      }))
      .filter(l => l.totalOI > 0)
      .sort((a, b) => Math.abs(b.netGEX) - Math.abs(a.netGEX));

    // GEX Flip Level — where net GEX crosses zero (most important level)
    const sorted = [...levels].sort((a, b) => a.strike - b.strike);
    let flipLevel = null;
    for (let i = 1; i < sorted.length; i++) {
      if (Math.sign(sorted[i-1].netGEX) !== Math.sign(sorted[i].netGEX)) {
        flipLevel = (sorted[i-1].strike + sorted[i].strike) / 2;
        break;
      }
    }

    // Largest positive GEX = support wall (MM buy here)
    const wallUp   = levels.filter(l => l.netGEX > 0).sort((a,b) => a.strike - b.strike)[0]?.strike || null;
    // Largest negative GEX = resistance wall (MM sell here)
    const wallDown = levels.filter(l => l.netGEX < 0).sort((a,b) => b.strike - a.strike)[0]?.strike || null;

    // Put/Call Ratio from OI
    const totalCallOI = Object.values(strikes).reduce((s,d) => s + d.callOI, 0);
    const totalPutOI  = Object.values(strikes).reduce((s,d) => s + d.putOI, 0);
    const pcRatio     = totalCallOI > 0 ? parseFloat((totalPutOI / totalCallOI).toFixed(2)) : null;

    const result = {
      levels: levels.slice(0, 5),
      wallUp,
      wallDown,
      flipLevel,
      netGEX:    parseFloat(totalNetGEX.toFixed(0)),
      pcRatio,   // >1 = bearish (more puts), <0.7 = bullish (more calls)
      regime:    totalNetGEX > 0 ? 'POSITIVE' : 'NEGATIVE', // positive = stable, negative = volatile
      ts: Date.now(),
    };

    gexCache[key] = result;
    gexCache.ts   = Date.now();
    console.log(`[GEX] ${coin}: NetGEX=${result.netGEX} Flip=$${flipLevel} Wall↑$${wallUp} Wall↓$${wallDown} P/C=${pcRatio}`);
    return result;
  } catch(e) {
    console.error('[GEX]', coin, e.message);
    return null;
  }
}

function calcRSI(klines, period) {
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
function calcMACD(klines, fast = 12, slow = 26, signal = 9) {
  const closes = klines.map(c => c.close);
  if (closes.length < slow + signal) return { macd: 0, signal: 0, hist: 0 };

  const ema = (arr, period) => {
    const k = 2 / (period + 1);
    let val = arr[0];
    for (let i = 1; i < arr.length; i++) val = arr[i] * k + val * (1 - k);
    return val;
  };

  const macdLine = [];
  for (let i = slow - 1; i < closes.length; i++) {
    macdLine.push(ema(closes.slice(0, i + 1), fast) - ema(closes.slice(0, i + 1), slow));
  }

  const signalLine = ema(macdLine, signal);
  const macdVal    = macdLine[macdLine.length - 1];
  const hist       = macdVal - signalLine;

  return { macd: macdVal, signal: signalLine, hist: parseFloat(hist.toFixed(6)) };
}

function calcBollinger(klines, period = 20, mult = 2) {
  const closes = klines.map(c => c.close);
  if (closes.length < period) return { upper: 0, mid: 0, lower: 0, width: 0 };

  const slice = closes.slice(-period);
  const mid   = slice.reduce((a, b) => a + b, 0) / period;
  const std   = Math.sqrt(slice.reduce((a, b) => a + (b - mid) ** 2, 0) / period);
  const upper = mid + mult * std;
  const lower = mid - mult * std;
  const width = ((upper - lower) / mid * 100);

  return { upper: parseFloat(upper.toFixed(4)), mid: parseFloat(mid.toFixed(4)),
           lower: parseFloat(lower.toFixed(4)), width: parseFloat(width.toFixed(2)) };
}
function calcSLTP(price, direction, strategy, atr = null) {
  // Адаптивный SL на основе ATR:
  // - SL = max(0.8%, min(ATR × 1.2, 1.5%))
  // - Узкий SL в спокойном рынке = меньшие потери
  // - Широкий SL в волатильном рынке = меньше выбиваний шумом
  // - Жёсткий cap 1.5% для защиты капитала
  // RR консервативный 1:2 (TP1) и 1:3 (TP2) — реалистичнее на крипте
  const MIN_SL_PCT = 0.8;
  const MAX_SL_PCT = 1.5;

  let slPct;
  if (atr && atr > 0) {
    const atrPct = (atr / price) * 100 * 1.2; // ATR × 1.2 в процентах
    slPct = Math.max(MIN_SL_PCT, Math.min(atrPct, MAX_SL_PCT));
  } else {
    slPct = 1.2; // дефолт если нет ATR
  }

  const slDist  = price * slPct / 100;
  const tp1Dist = slDist * 2.0; // RR 1:2 (раньше было 1:2.5)
  const tp2Dist = slDist * 3.0; // RR 1:3 (раньше было 1:4)

  return direction === 'long'
    ? {
        sl:  (price - slDist).toFixed(4),
        tp1: (price + tp1Dist).toFixed(4),
        tp2: (price + tp2Dist).toFixed(4),
      }
    : {
        sl:  (price + slDist).toFixed(4),
        tp1: (price - tp1Dist).toFixed(4),
        tp2: (price - tp2Dist).toFixed(4),
      };
}

// ============================================================
//  FVG (Fair Value Gap) и FIBONACCI
// ============================================================

// ── IFVG (Inverse Fair Value Gap) — Smart Money Concept ─────
// FVG заполнена = переворачивается (поддержка → сопротивление и наоборот)
function detectIFVG(klines, fvgZones) {
  if (!fvgZones || !fvgZones.length) return [];
  const ifvgs = [];
  const allCloses = klines.map(c => c.close);
  const allLows   = klines.map(c => c.low);
  const allHighs  = klines.map(c => c.high);
  for (const fvg of fvgZones) {
    const filled = fvg.type === 'bullish'
      ? allLows.some(l => l <= fvg.bottom)
      : allHighs.some(h => h >= fvg.top);
    if (filled) {
      ifvgs.push({ ...fvg, type: fvg.type === 'bullish' ? 'bearish' : 'bullish', isIFVG: true });
    }
  }
  return ifvgs;
}

function detectFVG(klines) {
  const zones = [];
  for (let i = 2; i < klines.length; i++) {
    const c1 = klines[i-2];
    const c3 = klines[i];
    // Бычий FVG — gap между high свечи 1 и low свечи 3
    if (c3.low > c1.high) {
      zones.push({ type: 'bullish', top: c3.low, bottom: c1.high, ts: c3.ts });
    }
    // Медвежий FVG — gap между low свечи 1 и high свечи 3
    if (c3.high < c1.low) {
      zones.push({ type: 'bearish', top: c1.low, bottom: c3.high, ts: c3.ts });
    }
  }
  return zones.slice(-5); // последние 5 зон
}

function calcFVGStopLoss(price, direction, fvgZones, atr) {
  if (!fvgZones || !fvgZones.length) return null;

  if (direction === 'long') {
    // Ищем ближайший медвежий FVG ниже цены входа
    const below = fvgZones
      .filter(z => z.type === 'bearish' && z.top < price)
      .sort((a, b) => b.top - a.top); // ближайший снизу
    if (below.length) {
      const sl = below[0].bottom * 0.998; // чуть ниже FVG зоны
      // Проверяем что стоп не слишком далеко (максимум 3x ATR)
      if (atr && (price - sl) > atr * 3) return null;
      return { sl: sl.toFixed(4), note: `📊 SL за FVG зоной $${below[0].bottom.toFixed(4)}` };
    }
  } else {
    // Ищем ближайший бычий FVG выше цены входа
    const above = fvgZones
      .filter(z => z.type === 'bullish' && z.bottom > price)
      .sort((a, b) => a.bottom - b.bottom); // ближайший сверху
    if (above.length) {
      const sl = above[0].top * 1.002; // чуть выше FVG зоны
      if (atr && (sl - price) > atr * 3) return null;
      return { sl: sl.toFixed(4), note: `📊 SL за FVG зоной $${above[0].top.toFixed(4)}` };
    }
  }
  return null;
}

function priceInFVG(price, zones, direction) {
  return zones.some(z => {
    const inZone = price >= z.bottom && price <= z.top;
    if (direction === 'long')  return inZone && z.type === 'bullish';
    if (direction === 'short') return inZone && z.type === 'bearish';
    return false;
  });
}

function calcFibonacci(klines, direction, entryPrice) {
  if (!klines || klines.length < 20) return null;
  const slice = klines.slice(-20);
  const high  = Math.max(...slice.map(c => c.high));
  const low   = Math.min(...slice.map(c => c.low));
  const range = high - low;
  if (range === 0) return null;

  if (direction === 'long') {
    const tp1 = low + range * 0.618;
    const tp2 = low + range * 0.786;
    // Проверяем что TP выше цены входа
    if (tp1 <= entryPrice || tp2 <= entryPrice) return null;
    return { tp1, tp2, key: '61.8%/78.6%' };
  } else {
    const tp1 = high - range * 0.618;
    const tp2 = high - range * 0.786;
    // Проверяем что TP ниже цены входа
    if (tp1 >= entryPrice || tp2 >= entryPrice) return null;
    return { tp1, tp2, key: '61.8%/78.6%' };
  }
}

// ============================================================
//  OBV, BOLLINGER SQUEEZE, МУЛЬТИТАЙМФРЕЙМ, CHART PATTERNS
// ============================================================

// OBV — On Balance Volume
function calcOBV(klines) {
  if (!klines || klines.length < 2) return null;
  let obv = 0;
  const obvValues = [0];
  for (let i = 1; i < klines.length; i++) {
    if (klines[i].close > klines[i-1].close)      obv += klines[i].volume;
    else if (klines[i].close < klines[i-1].close) obv -= klines[i].volume;
    obvValues.push(obv);
  }
  // Тренд OBV — сравниваем последние 5 и предыдущие 5
  const recentOBV = obvValues.slice(-5).reduce((a,b) => a+b, 0) / 5;
  const prevOBV   = obvValues.slice(-10, -5).reduce((a,b) => a+b, 0) / 5;
  return {
    value:    obv,
    trend:    recentOBV > prevOBV ? 'up' : 'down',
    diverge:  null, // заполним ниже
  };
}

function applyOBV(sig, klines) {
  const obv = calcOBV(klines);
  if (!obv) return sig;

  const closes = klines.map(c => c.close);
  const priceUp = closes[closes.length-1] > closes[closes.length-5];

  // Бычья дивергенция OBV: цена падает но OBV растёт → разворот вверх
  if (sig.direction === 'long' && !priceUp && obv.trend === 'up') {
    sig.confidence = Math.min(sig.confidence + 10, 100);
    sig.obvNote    = `📊 OBV бычья дивергенция (накопление) → +10%`;
  }
  // Медвежья дивергенция: цена растёт но OBV падает → разворот вниз
  else if (sig.direction === 'short' && priceUp && obv.trend === 'down') {
    sig.confidence = Math.min(sig.confidence + 10, 100);
    sig.obvNote    = `📊 OBV медвежья дивергенция (распределение) → +10%`;
  }
  // OBV подтверждает направление
  else if (sig.direction === 'long' && obv.trend === 'up') {
    sig.confidence = Math.min(sig.confidence + 5, 100);
    sig.obvNote    = `📊 OBV растёт — подтверждает лонг → +5%`;
  }
  else if (sig.direction === 'short' && obv.trend === 'down') {
    sig.confidence = Math.min(sig.confidence + 5, 100);
    sig.obvNote    = `📊 OBV падает — подтверждает шорт → +5%`;
  }
  // OBV против сигнала
  else if (sig.direction === 'long' && obv.trend === 'down') {
    sig.confidence = Math.max(sig.confidence - 8, 0);
    sig.obvNote    = `📊 OBV падает — против лонга → -8%`;
  }
  else if (sig.direction === 'short' && obv.trend === 'up') {
    sig.confidence = Math.max(sig.confidence - 8, 0);
    sig.obvNote    = `📊 OBV растёт — против шорта → -8%`;
  }
  return sig;
}

// Bollinger Squeeze — сужение полос предсказывает взрыв
function applyBollingerSqueeze(sig, klines) {
  try {
    if (!klines || klines.length < 25) return sig;

    const curr = calcBollinger(klines, 20, 2);
    const prev = calcBollinger(klines.slice(0, -5), 20, 2);
    if (!curr || !prev) return sig;

    const isSqueeze  = curr.width < prev.width * 0.7; // полосы сузились на 30%+
    const isExpand   = curr.width > prev.width * 1.3; // полосы расширились
    const price      = sig.price;

    if (isSqueeze) {
      // Сжатие — скоро взрывное движение, ждём подтверждения
      sig.confidence = Math.min(sig.confidence + 8, 100);
      sig.bbNote     = `🔲 Bollinger Squeeze — взрывное движение скоро → +8%`;
    }

    if (isExpand) {
      // Расширение — движение уже началось, подтверждаем направление
      if (sig.direction === 'long' && price > curr.mid) {
        sig.confidence = Math.min(sig.confidence + 7, 100);
        sig.bbNote     = `📈 BB расширение вверх → +7%`;
      } else if (sig.direction === 'short' && price < curr.mid) {
        sig.confidence = Math.min(sig.confidence + 7, 100);
        sig.bbNote     = `📉 BB расширение вниз → +7%`;
      }
    }

    // Цена у края BB — перекупленность/перепроданность
    if (sig.direction === 'long' && price <= curr.lower * 1.005) {
      sig.confidence = Math.min(sig.confidence + 8, 100);
      sig.bbNote     = `📊 Цена у нижней BB — перепродан → +8%`;
    }
    if (sig.direction === 'short' && price >= curr.upper * 0.995) {
      sig.confidence = Math.min(sig.confidence + 8, 100);
      sig.bbNote     = `📊 Цена у верхней BB — перекуплен → +8%`;
    }
  } catch(e) {}
  return sig;
}

// Мультитаймфреймовый анализ (15m + 1H + 4H + 1D)
async function applyMultiTimeframe(sig, instId) {
  try {
    const k15m = await getOKXKlinesCached(instId, '15m', 55);
    const k1d  = await getOKXKlinesCached(instId, '1D',  55);

    let score = 0;
    const notes = [];

    // 15m тренд
    if (k15m.length >= 20) {
      const ma20_15m = calcSMA(k15m, 20);
      const price    = sig.price;
      if (sig.direction === 'long' && price > ma20_15m) {
        score++; notes.push('15m ▲');
      } else if (sig.direction === 'short' && price < ma20_15m) {
        score++; notes.push('15m ▼');
      } else {
        score--; notes.push('15m ✗');
      }
    }

    // Дневной тренд
    if (k1d.length >= 20) {
      const ma20_1d = calcSMA(k1d, 20);
      const price   = sig.price;
      if (sig.direction === 'long' && price > ma20_1d) {
        score++; notes.push('1D ▲');
      } else if (sig.direction === 'short' && price < ma20_1d) {
        score++; notes.push('1D ▼');
      } else {
        score--; notes.push('1D ✗');
      }
    }

    // Применяем результат
    if (score >= 2) {
      sig.confidence  = Math.min(sig.confidence + 12, 100);
      sig.mtfNote     = `📊 Мультитаймфрейм [${notes.join(' | ')}] → +12%`;
    } else if (score === 1) {
      sig.confidence  = Math.min(sig.confidence + 5, 100);
      sig.mtfNote     = `📊 Мультитаймфрейм [${notes.join(' | ')}] → +5%`;
    } else if (score <= -1) {
      sig.confidence  = Math.max(sig.confidence - 12, 0);
      sig.mtfNote     = `📊 Мультитаймфрейм [${notes.join(' | ')}] → -12%`;
    }
  } catch(e) { console.error('applyMultiTimeframe error:', e.message); }
  return sig;
}

// Chart Patterns — треугольник, клин, флаг
function detectChartPatterns(klines) {
  if (!klines || klines.length < 20) return null;

  const slice  = klines.slice(-20);
  const highs  = slice.map(c => c.high);
  const lows   = slice.map(c => c.low);
  const closes = slice.map(c => c.close);

  // Восходящий треугольник — highs flat, lows растут → бычий
  const highFlat    = Math.max(...highs.slice(-5)) - Math.min(...highs.slice(-5));
  const highRange   = Math.max(...highs) * 0.005; // 0.5% допуск
  const lowsRising  = lows[lows.length-1] > lows[0] * 1.005;
  if (highFlat < highRange && lowsRising) {
    return { pattern: 'ascending_triangle', direction: 'bullish', desc: '📐 Восходящий треугольник → бычий' };
  }

  // Нисходящий треугольник — lows flat, highs падают → медвежий
  const lowFlat      = Math.max(...lows.slice(-5)) - Math.min(...lows.slice(-5));
  const lowRange     = Math.min(...lows) * 0.005;
  const highsFalling = highs[highs.length-1] < highs[0] * 0.995;
  if (lowFlat < lowRange && highsFalling) {
    return { pattern: 'descending_triangle', direction: 'bearish', desc: '📐 Нисходящий треугольник → медвежий' };
  }

  // Симметричный треугольник — highs падают, lows растут → нейтральный
  const highsFall2 = highs[highs.length-1] < highs[0] * 0.998;
  const lowsRise2  = lows[lows.length-1]  > lows[0]  * 1.002;
  if (highsFall2 && lowsRise2) {
    return { pattern: 'symmetric_triangle', direction: 'neutral', desc: '📐 Симметричный треугольник → прорыв скоро' };
  }

  // Бычий флаг — резкий рост потом боковик
  const prevHigh = Math.max(...closes.slice(0, 10));
  const currLow  = Math.min(...closes.slice(-5));
  const flag     = prevHigh > closes[0] * 1.03 && currLow > closes[0] * 1.01;
  if (flag) {
    return { pattern: 'bull_flag', direction: 'bullish', desc: '🚩 Бычий флаг → продолжение роста' };
  }

  return null;
}

function applyChartPatterns(sig, klines) {
  const pattern = detectChartPatterns(klines);
  if (!pattern) return sig;

  const confirms    = (sig.direction === 'long'  && pattern.direction === 'bullish') ||
                      (sig.direction === 'short' && pattern.direction === 'bearish');
  const contradicts = (sig.direction === 'long'  && pattern.direction === 'bearish') ||
                      (sig.direction === 'short' && pattern.direction === 'bullish');
  const neutral     = pattern.direction === 'neutral';

  if (confirms) {
    sig.confidence    = Math.min(sig.confidence + 12, 100);
    sig.chartPatNote  = `${pattern.desc} → +12%`;
  } else if (contradicts) {
    sig.confidence    = Math.max(sig.confidence - 15, 0);
    sig.chartPatNote  = `${pattern.desc} — против сигнала → -15%`;
  } else if (neutral) {
    sig.confidence    = Math.min(sig.confidence + 5, 100);
    sig.chartPatNote  = `${pattern.desc} → +5%`;
  }
  return sig;
}

// ============================================================
//  VWAP и MA200
// ============================================================
function calcVWAP(klines) {
  if (!klines || klines.length < 2) return null;
  let cumTPV = 0, cumVol = 0;
  for (const c of klines) {
    const tp  = (c.high + c.low + c.close) / 3;
    cumTPV   += tp * c.volume;
    cumVol   += c.volume;
  }
  return cumVol > 0 ? cumTPV / cumVol : null;
}

function applyVWAP(sig, klines) {
  const vwap = calcVWAP(klines);
  if (!vwap) return sig;

  const price = sig.price;
  const dist  = ((price - vwap) / vwap * 100).toFixed(2);

  if (sig.direction === 'long') {
    if (price > vwap) {
      // Цена выше VWAP — тренд бычий, подтверждает лонг
      sig.confidence = Math.min(sig.confidence + 7, 100);
      sig.vwapNote   = `📊 Цена выше VWAP ($${vwap.toFixed(4)}) +${dist}% → +7%`;
    } else {
      // Цена ниже VWAP — торгуем против тренда
      sig.confidence = Math.max(sig.confidence - 10, 0);
      sig.vwapNote   = `📊 Цена ниже VWAP ($${vwap.toFixed(4)}) ${dist}% → -10%`;
    }
  } else {
    if (price < vwap) {
      sig.confidence = Math.min(sig.confidence + 7, 100);
      sig.vwapNote   = `📊 Цена ниже VWAP ($${vwap.toFixed(4)}) ${dist}% → +7%`;
    } else {
      sig.confidence = Math.max(sig.confidence - 10, 0);
      sig.vwapNote   = `📊 Цена выше VWAP ($${vwap.toFixed(4)}) +${dist}% → -10%`;
    }
  }
  return sig;
}

async function applyMA200(sig, instId) {
  try {
    const kD   = await getOKXKlinesCached(instId, '1D', 210);
    if (kD.length < 200) return sig;

    const ma200 = calcSMA(kD, 200);
    const price = sig.price;
    const distPct = Math.abs(price - ma200) / ma200 * 100;

    // Зона "облизывания" — ±1.5% от MA200 — не торгуем
    if (distPct < 1.5) {
      sig.confidence = Math.max(sig.confidence - 25, 0);
      sig.ma200Note  = `⚠️ Цена у MA200 ($${ma200.toFixed(2)}) ±${distPct.toFixed(1)}% — зона неопределённости → -25%`;
      return sig;
    }

    if (sig.direction === 'long') {
      if (price > ma200) {
        sig.confidence = Math.min(sig.confidence + 8, 100);
        sig.ma200Note  = `📈 Выше MA200 ($${ma200.toFixed(2)}) → лонг по тренду +8%`;
      } else {
        // Ниже MA200 — лонг против глобального тренда — блокируем
        sig.confidence = Math.max(sig.confidence - 25, 0);
        sig.ma200Note  = `🚫 Ниже MA200 ($${ma200.toFixed(2)}) — лонг против тренда → -25%`;
      }
    } else {
      if (price < ma200) {
        sig.confidence = Math.min(sig.confidence + 15, 100);
        sig.ma200Note  = `📉 Ниже MA200 ($${ma200.toFixed(2)}) → шорт по тренду +15%`;
      } else {
        // Выше MA200 — шорт против глобального тренда — блокируем
        sig.confidence = Math.max(sig.confidence - 25, 0);
        sig.ma200Note  = `🚫 Выше MA200 ($${ma200.toFixed(2)}) — шорт против тренда → -25%`;
      }
    }
  } catch(e) { console.error('applyMA200 error:', e.message); }
  return sig;
}

// ============================================================
//  РЕЖИМ РЫНКА
// ============================================================
// calcADX and calcATR are provided by regime.js (imported above)

async function getMarketRegime(instId) {
  try {
    const k1h = await getOKXKlinesCached(instId, '1H', 30);
    const k4h = await getOKXKlinesCached(instId, '4H', 30);
    const k1d = await getOKXKlinesCached(instId, '1D', 210);

    const adx1h  = calcADX(k1h, 14);
    const adx4h  = calcADX(k4h, 14);
    const atr    = calcATR(k1h, 14);
    const atrAvg = calcAtrAvg(k1h, 20);
    const ma200  = k1d?.length >= 200 ? calcSMA(k1d, 200) : null;
    const price  = k1h?.[k1h.length - 1]?.close || 0;

    const regime = detectRegime(adx1h, adx4h, atr, atrAvg, price, ma200);
    console.log(`[REGIME] ${instId} ADX 1H:${adx1h.toFixed(1)} 4H:${adx4h.toFixed(1)} Avg:${regime.adx.toFixed(1)} ${regime.isTrending?'TREND':regime.isSideways?'SIDEWAYS':'NEUTRAL'} ${regime.isBearMkt?'BEAR':''}`);
    return regime;
  } catch(e) {
    return neutralRegime();
  }
}

function applyMarketRegime(sig, regime) {
  if (!regime) return sig;

  // ═══════════════════════════════════════════════════════════
  // DVOL ФИЛЬТР — Deribit Volatility Index (крипто VIX)
  // При экстремальной волатильности только шорты/выход
  // ═══════════════════════════════════════════════════════════
  const dvol = dvolCache?.btc;
  if (dvol && dvol > 80 && sig.direction === 'long') {
    // DVOL > 80 = паника на опционном рынке → не входим в лонги
    const isS1 = sig.strategy.startsWith('1️⃣ ');
    if (!isS1) {
      sig.confidence = Math.max(sig.confidence - 15, 0);
      sig.regimeNote = (sig.regimeNote || '') + ` ⚠️ DVOL:${dvol.toFixed(0)}>80 → -15%`;
    }
  }

  // ═══════════════════════════════════════════════════════════
  // ЖЁСТКИЕ БЛОКИ — confidence → 0 (сигнал не пройдёт порог)
  // ═══════════════════════════════════════════════════════════

  // 1. БОКОВИК (ADX < 18) — пробойные стратегии НЕ работают
  // S10 Range Breakout, S9 Pullback, S12 Sweep в боковике дают фальшивые пробои
  const isBreakout = sig.strategy.includes('4H Range') ||
                     sig.strategy.includes('Pullback') ||
                     sig.strategy.includes('Liquidity Sweep');
  if (isBreakout && regime.adx < 18) {
    if (store.observeMode) {
      sig.confidence  = Math.max(sig.confidence - 8, 0);
      sig.regimeNote  = `⚠️ Боковик (ADX:${regime.adx.toFixed(1)}) — observe → -8%`;
    } else {
      sig.confidence  = 0;
      sig.regimeNote  = `❌ Боковик (ADX:${regime.adx.toFixed(1)}<18) — пробои ненадёжны`;
      return sig;
    }
  }

  // 2. МЕДВЕЖИЙ РЫНОК — ЛОНГИ полностью блокируются
  // Исключение: S5 RSI Дивергенция (ловит локальные отскоки)
  if (regime.isBearMkt && sig.direction === 'long') {
    const isS5 = sig.strategy.includes('RSI Диверг');
    if (!isS5) {
      if (store.observeMode) {
        sig.confidence  = Math.max(sig.confidence - 10, 0);
        sig.regimeNote  = `⚠️ Медвежий рынок — observe → -10%`;
      } else {
        sig.confidence  = 0;
        sig.regimeNote  = `❌ Медвежий рынок (ниже MA200) — LONG заблокирован`;
        return sig;
      }
    } else {
      // S5 в медвежьем — разрешаем но требуем уверенности
      sig.confidence  = Math.max(sig.confidence - 12, 0);
      sig.regimeNote  = `⚠️ Медвежий рынок — S5 осторожно → -12%`;
    }
  }

  // 3. СИЛЬНЫЙ СТРАХ (FNG < 30) — только шорты
  // При панике лонги — ловля падающего ножа
  if (sig.fng?.value < 30 && sig.direction === 'long') {
    const isS5 = sig.strategy.includes('RSI Диверг');
    if (!isS5) {
      if (store.observeMode) {
        sig.confidence  = Math.max(sig.confidence - 8, 0);
        sig.regimeNote  = (sig.regimeNote || '') + ` ⚠️ Паника FNG:${sig.fng.value} → -8%`;
      } else {
        sig.confidence  = 0;
        sig.regimeNote  = `❌ Паника (FNG:${sig.fng.value}<30) — LONG заблокирован`;
        return sig;
      }
    }
  }

  // 4. ВЫСОКАЯ ВОЛАТИЛЬНОСТЬ — уменьшаем уверенность
  if (regime.isHighVol) {
    sig.confidence  = Math.max(sig.confidence - 12, 0);
    sig.regimeNote  = (sig.regimeNote || '') + ` 🌊 Высокая волатильность → -12%`;
  }

  // ═══════════════════════════════════════════════════════════
  // МЯГКИЕ КОРРЕКТИРОВКИ
  // ═══════════════════════════════════════════════════════════

  // 5. Сильный тренд — Bounce очень опасен
  if (regime.isStrongTrend && sig.strategy.includes('Bounce')) {
    sig.confidence  = Math.max(sig.confidence - 25, 0);
    sig.regimeNote  = `📈 Сильный тренд (4H ADX:${regime.adx4h.toFixed(0)}) — bounce опасен → -25%`;
  } else if (regime.isTrending && sig.strategy.includes('Bounce')) {
    sig.confidence  = Math.max(sig.confidence - 15, 0);
    sig.regimeNote  = `📈 Тренд (ADX:${regime.adx.toFixed(0)}) — bounce рискован → -15%`;
  }

  // 6. Боковик — MA Cross слабее
  if (regime.isSideways && sig.strategy.includes('MA20')) {
    sig.confidence  = Math.max(sig.confidence - 12, 0);
    sig.regimeNote  = `↔️ Боковик (ADX:${regime.adx.toFixed(0)}) — MA крест слабее → -12%`;
  }

  // 7. Сильный тренд ПОДТВЕРЖДАЕТ трендовые стратегии
  if (regime.isStrongTrend) {
    if (sig.strategy.includes('RSI Диверг') || sig.strategy.includes('MA20')) {
      sig.confidence  = Math.min(sig.confidence + 8, 100);
      sig.regimeNote  = (sig.regimeNote || '') + ` 💪 Сильный тренд → +8%`;
    }
  }

  // 8. ADX 20-25 (слабый тренд) — пробойные получают небольшой штраф
  if (regime.adx >= 18 && regime.adx < 22 && isBreakout) {
    sig.confidence  = Math.max(sig.confidence - 6, 0);
    sig.regimeNote  = (sig.regimeNote || '') + ` ↔️ Слабый тренд (ADX:${regime.adx.toFixed(0)}) → -6%`;
  }

  return sig;
}

// calcATR is provided by regime.js (imported above)


// ============================================================
//  СТРАТЕГИИ
// ============================================================
async function runStrategies(instId, coinData, asianSession) {
  const signals = [];
  try {
    const price = coinData.price;
    const ccy   = coinData.symbol; // ← это было удалено случайно

    // Последовательные запросы — без rate limit
    // Свечи — всегда свежие
    const k15m = await getOKXKlinesCached(instId, '15m', 10);
    const k1h  = await getOKXKlinesCached(instId, '1H',  60);
    // ATR для динамического SL
    const atr1h  = calcATR(k1h,  14);
    const atr15m = calcATR(k15m, 14);

    // OI и taker — кэшируем на 5 минут чтобы не словить 429
    const OI_TTL = 5 * 60 * 1000;
    if (!store.oiCache[ccy] || Date.now() - store.oiCache[ccy].ts > OI_TTL) {
      console.log(`[OI CACHE] Обновляем ${ccy}...`);
      store.oiCache[ccy] = {
        oi5m: await getOKXOIHistory(ccy, '5m', 3),
        oi1h: await getOKXOIHistory(ccy, '1H', 3),
        tf5m: await getOKXTakerFlow(ccy, '5m'),
        tf1h: await getOKXTakerFlow(ccy, '1H'),
        ts:   Date.now(),
      };
    }
    const oi5m = store.oiCache[ccy].oi5m;
    const oi1h = store.oiCache[ccy].oi1h;
    const tf5m = store.oiCache[ccy].tf5m;
    const tf1h = store.oiCache[ccy].tf1h;

    // ────────────────────────────────────────────────────────
    // S1: Volume Spike Breakout (15m)
    // Резкий рост объёма + цена движется → импульсный пробой
    // ────────────────────────────────────────────────────────
    try {
      const k15m_s1 = await getOKXKlinesCached(instId, '15m', 20);
      if (k15m_s1.length >= 15) {
        const last    = k15m_s1[k15m_s1.length-1];
        const prev    = k15m_s1[k15m_s1.length-2];
        const pc      = prev.close ? (last.close - prev.close) / prev.close * 100 : 0;
        const avgVol  = k15m_s1.slice(-11,-1).reduce((a,c)=>a+(c.quoteVolume||0),0)/10;
        const volSpike = (last.quoteVolume||0) >= avgVol * 2.0;

        if (volSpike && Math.abs(pc) >= 1.0) {
          const dir = pc >= 1.0 ? 'long' : 'short';
          const atr_s1 = calcATR(k15m_s1, 14);
          let conf = 65;
          if ((last.quoteVolume||0) >= avgVol * 3.0) conf += 8;
          if (Math.abs(pc) >= 2.0) conf += 6;

          signals.push({
            strategy:  '1️⃣ Volume Spike (15m)',
            instId, direction: dir,
            signal:    dir === 'long' ? '🟢 LONG' : '🔴 SHORT',
            price, confidence: Math.min(conf, 95),
            metrics:   `Vol: ${((last.quoteVolume||0)/avgVol).toFixed(1)}x | Δ: ${pc.toFixed(2)}%`,
            ...calcSLTP(price, dir, '1️⃣ Volume Spike (15m)', atr_s1),
          });
        }
      }
    } catch(e) { console.error('S1 error:', e.message); }

// S2 включена для observe mode (сбор данных)
// S2: Liquidity Bounce (1h) — только в боковике или развороте
    if (!asianSession && k1h.length >= 2 && oi1h.length >= 2) {
      const pc   = calcPriceChangePct(k1h);
      const oi   = calcOiChangePct(oi1h);
      const vd   = tf1h ? tf1h.delta : calcVolumeDelta(k1h);
      const vol  = k1h.reduce((s, c) => s + c.quoteVolume, 0);
      const tick = Math.round(k1h[k1h.length-1].quoteVolume / 10000);
      const rsi  = k1h.length >= 15 ? calcRSI(k1h, 14) : 50;

      const k4h  = await getOKXKlinesCached(instId, '4H', 55);
      const ma20_4h = k4h.length >= 20 ? calcSMA(k4h, 20) : 0;
      const ma50_4h = k4h.length >= 50 ? calcSMA(k4h, 50) : 0;
      const trend4h = ma20_4h > ma50_4h ? 'bullish' : 'bearish';
      const trendStrength = ma50_4h ? Math.abs(ma20_4h - ma50_4h) / ma50_4h * 100 : 0;
      const isSideways = trendStrength < 1.0;

      const lc = [pc<=S2.priceMax, oi>=S2.oiMin, vd<=S2.vdeltaMax, tick>=S2.ticksMin, vol>=S2.volMin];
      const sc = [pc>=-S2.priceMax, oi>=S2.oiMin, vd>=-S2.vdeltaMax, tick>=S2.ticksMin, vol>=S2.volMin];
      const ml = lc.filter(Boolean).length;
      const ms = sc.filter(Boolean).length;

      if (ml >= 4 || ms >= 4) {
        const dir = ml >= ms ? 'long' : 'short';

        // Фильтр 1 — RSI в зоне перепроданности/перекупленности
        const rsiOk = (dir === 'long' && rsi < 40) || (dir === 'short' && rsi > 60);
        if (!rsiOk) {
          console.log(`[S2 SKIP] ${instId} — RSI не в зоне (${rsi})`);
        } else {
          // Фильтр 2 — объём выше среднего
          const avgVol2  = k1h.slice(-11,-1).reduce((a,c) => a + c.quoteVolume, 0) / 10;
          const lastVol2 = k1h[k1h.length-1].quoteVolume;
          if (lastVol2 < avgVol2 * 1.5) {
            console.log(`[S2 SKIP] ${instId} — слабый объём`);
          } else if (!isSideways && dir === 'long' && trend4h === 'bearish') {
            console.log(`[S2 BLOCK] ${instId} — лонг против медвежьего 4H тренда`);
          } else if (!isSideways && dir === 'short' && trend4h === 'bullish') {
            console.log(`[S2 BLOCK] ${instId} — шорт против бычьего 4H тренда`);
          } else {
            let conf = Math.max(ml, ms) * 14; // базовый 56-70 вместо 80-100
            if (dir==='long'  && rsi < 35) conf = Math.min(conf+10, 100);
            if (dir==='short' && rsi > 65) conf = Math.min(conf+10, 100);
            if (isSideways) conf = Math.min(conf+10, 100);

            signals.push({
              strategy: '2️⃣ Liquidity Bounce (1h)',
              instId, direction: dir,
              signal: dir==='long'?'🟢 LONG':'🔴 SHORT',
              price, confidence: Math.round(conf),
              metrics: `Цена:${pc.toFixed(2)}% OI:${oi.toFixed(2)}% RSI:${rsi} 4H:${isSideways?'Боковик':'Тренд'} Сила:${trendStrength.toFixed(2)}%`,
              ...calcSLTP(price, dir, '2️⃣ Liquidity Bounce (1h)', calcATR(k1h, 14))
            });
          }
        }
      }
    }

    // конец S2

    // S3: Ранний вход 5m
    /* if (k5m.length >= 7 && oi5m.length >= 2) {
      const oi5  = calcOiChangePct(oi5m);
      const vd5  = tf5m ? tf5m.delta : calcVolumeDelta(k5m);
      const prev = k5m.slice(-6, -1);
      const pH   = Math.max(...prev.map(c => c.high));
      const pL   = Math.min(...prev.map(c => c.low));
      const iL   = oi5 >= S3.oiMin5m && coinData.volume24h >= S3.vol24Min && price > pH && vd5 > 0;
      const iS   = oi5 >= S3.oiMin5m && coinData.volume24h >= S3.vol24Min && price < pL && vd5 < 0;
      if (iL || iS) {
        const dir   = iL ? 'long' : 'short';
        const cross = k1h.length >= 51 ? calcMACross(k1h, 20, 50) : 'none';
        let conf    = 85;
        // MACD подтверждение для S3
        const macd5 = calcMACD(k5m);
        if (dir === 'long'  && macd5.hist > 0) conf = Math.min(conf + 10, 100);
        if (dir === 'short' && macd5.hist < 0) conf = Math.min(conf + 10, 100);
        if (dir === 'long'  && macd5.hist < 0) conf = Math.max(conf - 15, 0);
        if (dir === 'short' && macd5.hist > 0) conf = Math.max(conf - 15, 0);
        if (dir==='long' && cross==='bullish')  conf = Math.min(conf+10, 100);
        if (dir==='short' && cross==='bearish') conf = Math.min(conf+10, 100);
        signals.push({ strategy: '3️⃣ Ранний вход (5m)', instId, direction: dir,
          signal: dir==='long'?'🟢 LONG':'🔴 SHORT', price, confidence: conf,
          metrics: `OI 5m:${oi5.toFixed(2)}% CVD:$${(vd5/1e6).toFixed(2)}M Vol24h:$${(coinData.volume24h/1e6).toFixed(0)}M MA:${cross}`,
          ...calcSLTP(price, dir, '3️⃣ Ранний вход (5m)') });
      }
    } */

      // Вычисляем FVG зоны один раз для всех стратегий
    const fvgZones1h  = detectFVG(k1h.slice(-30));
    const fvgZones15m = detectFVG(k15m.slice(-20));
  // S4: MA20/MA50 + RSI — ОТКЛЮЧЕНА (WR 0% на 15 сделках)


    // S5: RSI Дивергенция (1h) v2 — только в боковике (ADX < 30)
    // Урок апреля 2026: в трендовом рынке RSI div = ловушка
    if (k1h.length >= 25) {
      // ── Режим рынка: ADX < 30 = боковик, только тогда торгуем дивергенции ──
      const adxS5 = calcADX(k1h, 14);
      if (adxS5 > 30) {
        console.log(`[S5 SKIP] ${instId} — тренд ADX:${adxS5.toFixed(1)}`);
      } else {
        const closes  = k1h.map(c => c.close);
        const lows    = k1h.map(c => c.low);
        const highs   = k1h.map(c => c.high);
        const rsiNow  = calcRSI(k1h, 14);
        const rsiPrev = calcRSI(k1h.slice(0, -5), 14);

        // ── Объёмный фильтр — подтверждение разворота ───────────
        const avgVol  = k1h.slice(-20,-1).reduce((a,c)=>a+c.quoteVolume,0)/19;
        const lastVol = k1h[k1h.length-1].quoteVolume;
        const volConf = lastVol >= avgVol * 0.9; // объём не ниже 90% среднего

        // ── Бычья дивергенция: цена новый лоу, RSI выше ─────────
        const priceNewLow = lows[lows.length-1] < Math.min(...lows.slice(-20,-1));
        const rsiHigher   = rsiNow > rsiPrev + 2; // снижен порог: +2 вместо +3
        if (priceNewLow && rsiHigher && rsiNow < 45 && volConf) {
          let conf = 75;
          if (rsiNow < 35)   conf += 7;   // глубокое перепродание
          if (adxS5 < 20)    conf += 5;   // чёткий боковик
          if (lastVol > avgVol * 1.2) conf += 3; // объём выше среднего
          signals.push({
            strategy: '5️⃣ RSI Дивергенция (1h)', instId, direction: 'long',
            signal: '🟢 LONG', price, confidence: Math.min(conf, 95),
            metrics: `RSI:${rsiNow.toFixed(1)}→${rsiPrev.toFixed(1)} | ADX:${adxS5.toFixed(1)} боковик | Vol:${(lastVol/avgVol).toFixed(1)}x`,
            ...calcSLTP(price, 'long', '5️⃣ RSI Дивергенция (1h)', atr1h)
          });
        }

        // ── Медвежья дивергенция: цена новый хай, RSI ниже ──────
        const priceNewHigh = closes[closes.length-1] > Math.max(...closes.slice(-20,-1));
        const rsiLower     = rsiNow < rsiPrev - 2; // снижен порог
        if (priceNewHigh && rsiLower && rsiNow > 55 && volConf) {
          let conf = 75;
          if (rsiNow > 65)   conf += 7;
          if (adxS5 < 20)    conf += 5;
          if (lastVol > avgVol * 1.2) conf += 3;
          signals.push({
            strategy: '5️⃣ RSI Дивергенция (1h)', instId, direction: 'short',
            signal: '🔴 SHORT', price, confidence: Math.min(conf, 95),
            metrics: `RSI:${rsiNow.toFixed(1)}→${rsiPrev.toFixed(1)} | ADX:${adxS5.toFixed(1)} боковик | Vol:${(lastVol/avgVol).toFixed(1)}x`,
            ...calcSLTP(price, 'short', '5️⃣ RSI Дивергенция (1h)', atr1h)
          });
        }
      }
    }

   // S6: Funding Rate Extreme
    if (k1h.length >= 14) {
      const funding = coinData.fundingRate || 0;
      const rsi1h   = calcRSI(k1h, 14);
      const macd1h  = calcMACD(k1h);

      // Уровни funding:
      // Умеренный: ±0.01%  → осторожный сигнал
      // Сильный:   ±0.02%  → хороший сигнал
      // Экстремальный: ±0.05% → очень сильный

      const fundingAbs = Math.abs(funding);
      let fundingConf  = 0;
      let fundingLabel = '';

      if (fundingAbs >= 0.05)      { fundingConf = 72; fundingLabel = 'ЭКСТРЕМАЛЬНЫЙ'; }
      else if (fundingAbs >= 0.02) { fundingConf = 62; fundingLabel = 'СИЛЬНЫЙ'; }
      else if (fundingAbs >= 0.01) { fundingConf = 55; fundingLabel = 'УМЕРЕННЫЙ'; }

      if (fundingConf === 0) {
        // funding нейтральный — пропускаем
      } else if (funding < 0 && rsi1h < 50) {
        // Отрицательный funding → шортисты переплачивают → разворот вверх
        let conf = fundingConf;
        if (macd1h.hist > 0) conf = Math.min(conf + 8, 100); // MACD подтверждает
        if (rsi1h < 35)      conf = Math.min(conf + 5, 100); // перепродан

        // Дополнительный фильтр: BTC тоже должен поддерживать направление
        const btcTicker = await getBTCTickerCached();
        const btcPrice  = btcTicker?.data?.[0] ? parseFloat(btcTicker.data[0].last) : 0;
        const btcOpen   = btcTicker?.data?.[0] ? parseFloat(btcTicker.data[0].open24h) : 0;
        const btcChange = btcOpen ? (btcPrice - btcOpen) / btcOpen * 100 : 0;
        // Не берём лонг если BTC падает > 2% за день
        if (btcChange < -2.0) {
          console.log(`[S6 SKIP] ${instId} — BTC падает ${btcChange.toFixed(1)}% при лонге`);
        } else {
          signals.push({
            strategy:  '6️⃣ Funding Extreme (1h)',
            instId, direction: 'long',
            signal:    '🟢 LONG', price, confidence: conf,
            metrics:   `Funding:${(funding*100).toFixed(4)}% [${fundingLabel}] RSI:${rsi1h} BTC:${btcChange.toFixed(1)}%`,
            ...calcSLTP(price, 'long',  '6️⃣ Funding Extreme (1h)', atr1h)
          });
        }
      } else if (funding > 0 && rsi1h > 50) {
        // Положительный funding → лонгисты переплачивают → разворот вниз
        let conf = fundingConf;
        if (macd1h.hist < 0) conf = Math.min(conf + 8, 100); // MACD подтверждает
        if (rsi1h > 65)      conf = Math.min(conf + 5, 100); // перекуплен

        // BTC фильтр — не берём шорт если BTC сильно растёт
        const btcTickerS = await getBTCTickerCached();
        const btcPriceS  = btcTickerS?.data?.[0] ? parseFloat(btcTickerS.data[0].last) : 0;
        const btcOpenS   = btcTickerS?.data?.[0] ? parseFloat(btcTickerS.data[0].open24h) : 0;
        const btcChangeS = btcOpenS ? (btcPriceS - btcOpenS) / btcOpenS * 100 : 0;
        if (btcChangeS > 2.0) {
          console.log(`[S6 SKIP] ${instId} — BTC растёт ${btcChangeS.toFixed(1)}% при шорте`);
        } else {
          signals.push({
            strategy:  '6️⃣ Funding Extreme (1h)',
            instId, direction: 'short',
            signal:    '🔴 SHORT', price, confidence: conf,
            metrics:   `Funding:${(funding*100).toFixed(4)}% [${fundingLabel}] RSI:${rsi1h} BTC:${btcChangeS.toFixed(1)}%`,
            ...calcSLTP(price, 'short', '6️⃣ Funding Extreme (1h)', atr1h)
          });
        }
      }
    }

    // S7: Поглощение на объёме — включена для observe mode (сбор данных)
    if (k15m.length >= 15) {
      const patterns  = detectCandlePatterns(k15m);
      const engulfing = patterns.find(p => p.name.includes('engulfing'));

      if (engulfing) {
        const avgVol  = k15m.slice(-11, -1).reduce((a,c) => a + c.quoteVolume, 0) / 10;
        const lastVol = k15m[k15m.length-1].quoteVolume;
        const volBoost = lastVol >= avgVol * 5.0; // было 3.5x → теперь 5x

        if (!volBoost) {
          console.log(`[S7 SKIP] ${instId} — слабый объём ${(lastVol/avgVol).toFixed(1)}x (нужно 5x)`);
        } else {
          const dir    = engulfing.direction === 'bullish' ? 'long' : 'short';
          const rsi15m = calcRSI(k15m, 14);

          // Фильтр 1 — RSI не должен быть в зоне перекупленности/перепроданности
          // Бычье поглощение при RSI > 70 — скорее всего ловушка
          // Медвежье поглощение при RSI < 30 — скорее всего ловушка
          const rsiOk = (dir === 'long'  && rsi15m < 65 && rsi15m > 20) ||
                        (dir === 'short' && rsi15m > 35 && rsi15m < 80);
          if (!rsiOk) {
            console.log(`[S7 SKIP] ${instId} — RSI экстремальный (${rsi15m.toFixed(1)})`);
          } else {
            // Фильтр 2 — поглощение должно совпадать с 1H трендом
            const ma20_1h = calcSMA(k1h, 20);
            const ma50_1h = k1h.length >= 50 ? calcSMA(k1h, 50) : ma20_1h;
            const trend1h = ma20_1h > ma50_1h ? 'bullish' : 'bearish';

            const trendOk = (dir === 'long'  && trend1h === 'bullish') ||
                            (dir === 'short' && trend1h === 'bearish');

            if (!trendOk) {
              console.log(`[S7 SKIP] ${instId} — против 1H тренда (${trend1h})`);
            } else {
              // Фильтр 3 — минимальный объём монеты $50M в сутки
              if (coinData.volume24h < 50000000) {
                console.log(`[S7 SKIP] ${instId} — низкий суточный объём`);
              } else {
                signals.push({
                  strategy: '7️⃣ Поглощение на объёме (15m)',
                  instId, direction: dir,
                  signal:   dir === 'long' ? '🟢 LONG' : '🔴 SHORT',
                  price,    confidence: 62, // чуть выше 58 — прошло жёсткие фильтры
                  metrics:  `${engulfing.desc} | Vol:${(lastVol/avgVol).toFixed(1)}x | RSI:${rsi15m.toFixed(0)} | 1H:${trend1h}`,
                  ...calcSLTP(price, dir, '7️⃣ Поглощение на объёме (15m)', atr15m)
                });
              }
            }
          }
        }
      }
    }

    // конец S7

    // S8: Basis Farming — УДАЛЕНА (мало данных, нет сделок)

    // S9: Pullback в тренде (1H/4H + M15)
    // Логика: глобальный тренд по SMA200 на 4H,
    // локальный откат на 15m, вход на пробитии отката
    try {
      const k4h_s9 = await getOKXKlinesCached(instId, '4H', 60);
      const k15m_s9 = await getOKXKlinesCached(instId, '15m', 50);

      if (k4h_s9.length >= 50 && k15m_s9.length >= 20) {
        // ── Шаг 1: Определяем глобальный тренд через SMA200 (1D) ──
        const kD_s9  = await getOKXKlinesCached(instId, '1D', 210);
        const ma200_s9 = kD_s9.length >= 200 ? calcSMA(kD_s9, 200) : null;

        // ── Шаг 2: Структура рынка на 4H (lower highs / higher lows) ──
        const highs4h = k4h_s9.map(c => c.high).slice(-10);
        const lows4h  = k4h_s9.map(c => c.low).slice(-10);

        // Даунтренд: последний максимум ниже предыдущего
        const lowerHigh4h = highs4h[highs4h.length-1] < highs4h[highs4h.length-3];
        const lowerLow4h  = lows4h[lows4h.length-1]  < lows4h[lows4h.length-3];

        // Аптренд: последний минимум выше предыдущего
        const higherHigh4h = highs4h[highs4h.length-1] > highs4h[highs4h.length-3];
        const higherLow4h  = lows4h[lows4h.length-1]  > lows4h[lows4h.length-3];

        const downtrend4h = lowerHigh4h && lowerLow4h;
        const uptrend4h   = higherHigh4h && higherLow4h;

        // ── Шаг 3: Проверяем откат на 15m ──
        const lows15m   = k15m_s9.map(c => c.low).slice(-15);
        const highs15m  = k15m_s9.map(c => c.high).slice(-15);
        const closes15m = k15m_s9.map(c => c.close).slice(-15);

        // Для шорта — откат ВВЕРХ (higher lows на 15m)
        // Ищем 3+ последовательных higher lows
        let pullbackUp = 0;
        for (let j = 1; j < lows15m.length; j++) {
          if (lows15m[j] > lows15m[j-1]) pullbackUp++;
          else pullbackUp = 0;
        }

        // Для лонга — откат ВНИЗ (lower highs на 15m)
        let pullbackDown = 0;
        for (let j = 1; j < highs15m.length; j++) {
          if (highs15m[j] < highs15m[j-1]) pullbackDown++;
          else pullbackDown = 0;
        }

        // ── Шаг 4: Пробитие локальной линии отката ──
        // Для шорта: пробитие последнего higher low вниз
        const lastLow15m  = Math.min(...lows15m.slice(-4));
        const prevLow15m  = Math.min(...lows15m.slice(-8, -4));
        const breakdownShort = closes15m[closes15m.length-1] < lastLow15m && pullbackUp >= 3;

        // Для лонга: пробитие последнего lower high вверх
        const lastHigh15m = Math.max(...highs15m.slice(-4));
        const prevHigh15m = Math.max(...highs15m.slice(-8, -4));
        const breakoutLong = closes15m[closes15m.length-1] > lastHigh15m && pullbackDown >= 3;

        // ── Шаг 5: Зона интереса (SMA200 / FVG) ──
        const nearMA200_s9 = ma200_s9
          ? Math.abs(price - ma200_s9) / ma200_s9 * 100 < 2.0
          : false;
        const fvgZones_s9 = detectFVG(k15m_s9.slice(-20));
        const inFVG_s9 = fvgZones_s9.some(z => {
          return price >= z.bottom && price <= z.top;
        });
        const inZoneOfInterest = nearMA200_s9 || inFVG_s9;

        // ── RSI подтверждение ──
        const rsi15m_s9 = calcRSI(k15m_s9, 14);
        const atr15m_s9 = calcATR(k15m_s9, 14);

        // ── ШОРТ: даунтренд 4H + откат вверх + пробитие вниз ──
        if (downtrend4h && breakdownShort) {
          // SMA200 фильтр — шортуем только если ниже MA200 или нет данных
          const belowMA200 = ma200_s9 ? price < ma200_s9 * 1.02 : true;
          if (belowMA200) {
            let conf = 65;
            if (inZoneOfInterest)  conf += 12; // в зоне интереса
            if (nearMA200_s9)      conf += 8;  // у SMA200
            if (inFVG_s9)          conf += 8;  // в FVG
            if (rsi15m_s9 > 55)    conf += 7;  // RSI перекуплен на откате
            if (pullbackUp >= 5)   conf += 5;  // сильный откат = хорошая точка
            if (lowerLow4h && lowerHigh4h) conf += 5; // чёткая структура

            const atrPctS9s = (atr15m_s9 / price) * 100 * 1.2;
            const slPctS9s  = Math.max(0.8, Math.min(atrPctS9s, 1.5));
            const slDist  = price * slPctS9s / 100; // адаптивный SL
            const sl      = (price + slDist).toFixed(4);
            const tp1     = (price - slDist * 2.0).toFixed(4);
            const tp2     = (price - slDist * 3.0).toFixed(4);

            signals.push({
              strategy:  '9️⃣ Pullback в тренде (15m)',
              instId, direction: 'short',
              signal:    '🔴 SHORT', price,
              confidence: Math.min(conf, 95),
              metrics:   `4H даунтренд | Откат ${pullbackUp} свечей вверх | Пробой лоу ${lastLow15m.toFixed(4)} | RSI:${rsi15m_s9.toFixed(0)} ${inFVG_s9?'| FVG ✅':''} ${nearMA200_s9?'| MA200 ✅':''}`,
              sl, tp1, tp2,
            });
          }
        }

        // ── ЛОНГ: аптренд 4H + откат вниз + пробитие вверх ──
        if (uptrend4h && breakoutLong) {
          const aboveMA200 = ma200_s9 ? price > ma200_s9 * 0.98 : true;
          if (aboveMA200) {
            let conf = 65;
            if (inZoneOfInterest)  conf += 12;
            if (nearMA200_s9)      conf += 8;
            if (inFVG_s9)          conf += 8;
            if (rsi15m_s9 < 45)    conf += 7;  // RSI перепродан на откате
            if (pullbackDown >= 5) conf += 5;
            if (higherLow4h && higherHigh4h) conf += 5;

            const atrPctS9l = (atr15m_s9 / price) * 100 * 1.2;
            const slPctS9l  = Math.max(0.8, Math.min(atrPctS9l, 1.5));
            const slDist  = price * slPctS9l / 100; // адаптивный SL
            const sl      = (price - slDist).toFixed(4);
            const tp1     = (price + slDist * 2.0).toFixed(4);
            const tp2     = (price + slDist * 3.0).toFixed(4);

            signals.push({
              strategy:  '9️⃣ Pullback в тренде (15m)',
              instId, direction: 'long',
              signal:    '🟢 LONG', price,
              confidence: Math.min(conf, 95),
              metrics:   `4H аптренд | Откат ${pullbackDown} свечей вниз | Пробой хай ${lastHigh15m.toFixed(4)} | RSI:${rsi15m_s9.toFixed(0)} ${inFVG_s9?'| FVG ✅':''} ${nearMA200_s9?'| MA200 ✅':''}`,
              sl, tp1, tp2,
            });
          }
        }
      }
    } catch(e) { console.error('S9 error:', e.message); }

    // S10: 4H Range Breakout (5m) — усиленная версия
    try {
      const k4h_s10 = await getOKXKlinesCached(instId, '4H', 8);
      const k5m_s10 = await getOKXKlinesCached(instId, '5m', 96);
      const k1h_s10 = await getOKXKlinesCached(instId, '1H', 24);

      if (k4h_s10.length >= 2 && k5m_s10.length >= 50 && k1h_s10.length >= 14) {
        const nowUTC   = Date.now();
        const dayStart = nowUTC - (nowUTC % (24 * 60 * 60 * 1000));

        const todayCandles = k4h_s10.filter(c => c.ts >= dayStart && c.ts < nowUTC - 4*60*60*1000);
        if (!todayCandles.length) throw new Error('[S10] Нет 4H свечи за сегодня');

        const rangeCandle = todayCandles[0];
        const rangeHigh   = rangeCandle.high;
        const rangeLow    = rangeCandle.low;
        const rangeSize   = rangeHigh - rangeLow;

        // ── Фильтр 1: диапазон должен быть значимым (не флэт) ──
        const rangePct = rangeSize / price;
        if (rangeSize >= atr15m * 0.5 && rangePct >= 0.005 && rangePct <= 0.04) {
          // MA200 5m + RSI 1H + средний объём
          const ma200_5m  = calcSMA(k5m_s10, Math.min(200, k5m_s10.length));
          const uptrend   = price > ma200_5m;
          const rsi1h_s10 = calcRSI(k1h_s10, 14);
          const avgVol5m  = k5m_s10.slice(-20).reduce((a,c) => a + (c.quoteVolume||1), 0) / 20;

          const recentK5m = k5m_s10.slice(-30);

          for (let j = 1; j < recentK5m.length; j++) {
            const prev = recentK5m[j - 1];
            const curr = recentK5m[j];

            // ── LONG: пробой вниз + возврат ────────────────────
            if (prev.close < rangeLow && curr.close >= rangeLow && uptrend) {
              // ── Фильтр 2: объём пробоя должен быть выше среднего ──
              if ((prev.quoteVolume||1) < avgVol5m * 1.2) { continue; }
              // ── Фильтр 3: RSI 1H не перекуплен ──
              if (rsi1h_s10 > 65) { continue; }
              // ── Фильтр 4: возвратная свеча должна быть бычьей ──
              if (curr.close <= curr.open) { continue; }

              const atrPctS10l = (atr15m / curr.close) * 100 * 1.2;
              const slPctS10l  = Math.max(0.8, Math.min(atrPctS10l, 1.5));
              const slDist  = curr.close * slPctS10l / 100; // адаптивный SL
              const sl      = (curr.close - slDist).toFixed(4);
              const tp1     = (curr.close + slDist * 2.0).toFixed(4);
              const tp2     = (curr.close + slDist * 3.0).toFixed(4);

              let conf = 70;
              if ((prev.quoteVolume||1) >= avgVol5m * 2.0) conf += 8;
              if (rsi1h_s10 < 45) conf += 6;
              if (price > ma200_5m * 1.01) conf += 4;
              if ((curr.close - curr.open) / curr.open > 0.003) conf += 4; // сильная зелёная

              signals.push({
                strategy: '🔟 4H Range Breakout (5m)', instId, direction: 'long',
                signal: '🟢 LONG', price, confidence: Math.min(conf, 95),
                metrics: `4H:$${rangeLow.toFixed(4)}-$${rangeHigh.toFixed(4)} | Vol:${((prev.quoteVolume||1)/avgVol5m).toFixed(1)}x | RSI1H:${rsi1h_s10.toFixed(0)}`,
                sl, tp1, tp2,
              });
              break;
            }

            // ── SHORT: пробой вверх + возврат ──────────────────
            if (prev.close > rangeHigh && curr.close <= rangeHigh && !uptrend) {
              if ((prev.quoteVolume||1) < avgVol5m * 1.2) { continue; }
              if (rsi1h_s10 < 35) { continue; }
              if (curr.close >= curr.open) { continue; } // должна быть красная

              const atrPctS10s = (atr15m / curr.close) * 100 * 1.2;
              const slPctS10s  = Math.max(0.8, Math.min(atrPctS10s, 1.5));
              const slDist  = curr.close * slPctS10s / 100; // адаптивный SL
              const sl      = (curr.close + slDist).toFixed(4);
              const tp1     = (curr.close - slDist * 2.0).toFixed(4);
              const tp2     = (curr.close - slDist * 3.0).toFixed(4);

              let conf = 70;
              if ((prev.quoteVolume||1) >= avgVol5m * 2.0) conf += 8;
              if (rsi1h_s10 > 55) conf += 6;
              if (price < ma200_5m * 0.99) conf += 4;
              if ((curr.open - curr.close) / curr.open > 0.003) conf += 4;

              signals.push({
                strategy: '🔟 4H Range Breakout (5m)', instId, direction: 'short',
                signal: '🔴 SHORT', price, confidence: Math.min(conf, 95),
                metrics: `4H:$${rangeLow.toFixed(4)}-$${rangeHigh.toFixed(4)} | Vol:${((prev.quoteVolume||1)/avgVol5m).toFixed(1)}x | RSI1H:${rsi1h_s10.toFixed(0)}`,
                sl, tp1, tp2,
              });
              break;
            }
          }
        }
      }
    } catch(e) { console.error('S10 error:', e.message); }

    // ────────────────────────────────────────────────────────
    // S12: Liquidity Sweep — УДАЛЕНА (дублирует S1)

    // S13: Order Block Reversal (1H) — ICT концепт
    // Находим зону где крупные игроки набирали позицию
    // и ждём возврата цены к этой зоне
    // ────────────────────────────────────────────────────────
    try {
      const k1h_s13 = await getOKXKlinesCached(instId, '1H', 50);
      if (k1h_s13.length >= 20) {
        const atr_s13   = calcATR(k1h_s13, 14);
        const ma200_s13 = calcSMA(k1h_s13, Math.min(200, k1h_s13.length));
        const uptrend   = price > ma200_s13;

        // Ищем Order Block за последние 20-40 свечей
        // Бычий OB: последняя медвежья свеча перед импульсом вверх (≥2 ATR)
        // Медвежий OB: последняя бычья свеча перед импульсом вниз (≥2 ATR)
        const searchCandles = k1h_s13.slice(-40, -5); // не берём последние 5

        let bullishOB = null; // зона для лонга
        let bearishOB = null; // зона для шорта

        for (let j = 1; j < searchCandles.length - 1; j++) {
          const prev = searchCandles[j - 1];
          const curr = searchCandles[j];
          const next = searchCandles[j + 1];
          if (!prev || !curr || !next) continue;

          const nextMove = Math.abs(next.close - next.open);

          // Бычий OB: медвежья свеча (close < open) перед большим движением вверх
          const isBearCandle = curr.close < curr.open;
          const bigMoveUp    = next.close > next.open && nextMove >= atr_s13 * 1.5;
          if (isBearCandle && bigMoveUp && uptrend) {
            bullishOB = { high: curr.high, low: curr.low, ts: curr.ts };
          }

          // Медвежий OB: бычья свеча (close > open) перед большим движением вниз
          const isBullCandle = curr.close > curr.open;
          const bigMoveDn    = next.close < next.open && nextMove >= atr_s13 * 1.5;
          if (isBullCandle && bigMoveDn && !uptrend) {
            bearishOB = { high: curr.high, low: curr.low, ts: curr.ts };
          }
        }

        // LONG: цена вернулась в зону бычьего OB
        if (bullishOB) {
          const inBullOB = price >= bullishOB.low && price <= bullishOB.high;
          if (inBullOB) {
            const rsi_s13 = calcRSI(k1h_s13, 14);
            const slDist  = price - bullishOB.low * 0.999; // SL чуть ниже OB
            const slPct   = slDist / price;

            if (slPct <= 0.015 && slPct >= 0.004 && rsi_s13 < 65) {
              let conf = 75;
              if (rsi_s13 < 45) conf += 6;
              if (slPct < 0.01) conf += 5; // тугой SL = точный OB
              if (price > ma200_s13 * 1.01) conf += 4;

              const sl  = (bullishOB.low * 0.999).toFixed(4);
              const tp1 = (price + slDist * 2.0).toFixed(4);
              const tp2 = (price + slDist * 3.0).toFixed(4);

              signals.push({
                strategy:  '1️⃣3️⃣ Order Block (1H)',
                instId, direction: 'long',
                signal:    '🟢 LONG', price,
                confidence: Math.min(conf, 95),
                metrics:   `Бычий OB: $${bullishOB.low.toFixed(4)}-$${bullishOB.high.toFixed(4)} | RSI:${rsi_s13.toFixed(0)}`,
                sl, tp1, tp2,
              });
            }
          }
        }

        // SHORT: цена вернулась в зону медвежьего OB
        if (bearishOB) {
          const inBearOB = price >= bearishOB.low && price <= bearishOB.high;
          if (inBearOB) {
            const rsi_s13 = calcRSI(k1h_s13, 14);
            const slDist  = bearishOB.high * 1.001 - price; // SL чуть выше OB
            const slPct   = slDist / price;

            if (slPct <= 0.015 && slPct >= 0.004 && rsi_s13 > 35) {
              let conf = 75;
              if (rsi_s13 > 55) conf += 6;
              if (slPct < 0.01) conf += 5;
              if (price < ma200_s13 * 0.99) conf += 4;

              const sl  = (bearishOB.high * 1.001).toFixed(4);
              const tp1 = (price - slDist * 2.0).toFixed(4);
              const tp2 = (price - slDist * 3.0).toFixed(4);

              signals.push({
                strategy:  '1️⃣3️⃣ Order Block (1H)',
                instId, direction: 'short',
                signal:    '🔴 SHORT', price,
                confidence: Math.min(conf, 95),
                metrics:   `Медвежий OB: $${bearishOB.low.toFixed(4)}-$${bearishOB.high.toFixed(4)} | RSI:${rsi_s13.toFixed(0)}`,
                sl, tp1, tp2,
              });
            }
          }
        }
      }
    } catch(e) { console.error('S13 error:', e.message); }

    // ────────────────────────────────────────────────────────
    // S11: Elliott+Fib+SMA — УДАЛЕНА (сложная, редко срабатывает)

    // ════════════════════════════════════════════════════════
    // S14 — Whale Follow (15m) — ОТКЛЮЧЕНА (WR 0% на 8 сделках)
    if (false) { // S14 disabled
    try {
      // Получаем недавние действия китов через copytrader модуль
      let whaleActions = [];
      try {
        if (typeof copytrader?.getRecentActions === 'function') {
          whaleActions = copytrader.getRecentActions(15) || [];
        } else if (typeof copytrader?.getTrackedWhalesSnapshot === 'function') {
          const snapshot = copytrader.getTrackedWhalesSnapshot() || [];
          whaleActions = snapshot.flatMap(w =>
            Object.values(w.positions || {}).map(p => ({
              symbol: p.coin,
              side:   p.side?.toLowerCase(),
              size:   p.sizeUsd || 0,
            }))
          );
        }
      } catch(ce) { /* copytrader недоступен */ }

      if (whaleActions.length > 0) {
        // Какой символ нас интересует (без -USDT-SWAP)
        const symbol = instId.replace('-USDT-SWAP', '').replace('-USDT', '');

        // Ищем 2+ китов открывших одинаковое направление по этой монете
        const matching = whaleActions.filter(a => {
          const aSym = (a.symbol || a.coin || '').replace('-USDT-SWAP', '').replace('-USDT', '').replace('USDT', '');
          return aSym.toUpperCase() === symbol.toUpperCase();
        });

        if (matching.length >= 2) {
          // Считаем направление: сколько лонгов, сколько шортов
          let longCnt = 0, shortCnt = 0, totalSize = 0;
          for (const m of matching) {
            const side = (m.side || m.direction || '').toLowerCase();
            const size = parseFloat(m.size || m.notional || m.qty || 0);
            if (side === 'long' || side === 'buy') { longCnt++; totalSize += size; }
            else if (side === 'short' || side === 'sell') { shortCnt++; totalSize += size; }
          }

          // Минимум 2 кита и общий размер $500k+
          if (totalSize >= 500000 && (longCnt >= 2 || shortCnt >= 2)) {
            const dir = longCnt > shortCnt ? 'long' : 'short';
            const sltp = calcSLTP(price, dir, '1️⃣4️⃣ Whale Follow (15m)');

            // Confidence: больше китов и крупнее объём = выше уверенность
            let conf = 65;
            if (matching.length >= 3) conf += 8;
            if (matching.length >= 5) conf += 5;
            if (totalSize >= 1000000) conf += 5;
            if (totalSize >= 5000000) conf += 7;

            signals.push({
              strategy:  '1️⃣4️⃣ Whale Follow (15m)',
              instId, direction: dir,
              signal:    dir === 'long' ? '🟢 LONG' : '🔴 SHORT',
              price, confidence: Math.min(conf, 92),
              metrics:   `${matching.length} китов · $${(totalSize/1e6).toFixed(2)}M · ${longCnt}L/${shortCnt}S`,
              paperOnly: true, // paper-only пока нет достаточно данных
              ...sltp,
            });
          }
        }
      }
    } catch(e) { console.error('S14 error:', e.message); }
    } // end S14 disabled

    // ════════════════════════════════════════════════════════
    // S15: Liquidation Hunt — УДАЛЕНА (OKX API недоступен)

    // ════════════════════════════════════════════════════════
    // S18: News/Listing Trading — PAPER ONLY (сбор данных)
    // Торгует на анонсах листингов и важных новостях
    // ════════════════════════════════════════════════════════
    try {
      const recentNews = global.recentNewsSignals || [];
      const coinBase   = instId.replace('-USDT-SWAP', '');

      // Ищем свежие позитивные/негативные новости по монете (последние 30 минут)
      const relevantNews = recentNews.filter(n => {
        const age = Date.now() - n.ts;
        return age < 30 * 60 * 1000 && // не старше 30 минут
          (n.coin === coinBase || n.keywords?.includes(coinBase.toLowerCase()));
      });

      if (relevantNews.length > 0) {
        const news    = relevantNews[0];
        const k15_s18 = await getOKXKlinesCached(instId, '15m', 10);
        if (k15_s18.length >= 5) {
          const price_s18 = k15_s18[k15_s18.length-1].close;
          const atr_s18   = calcATR(k15_s18, 5);
          const dir = news.sentiment === 'bullish' ? 'long' : 'short';
          const conf = Math.min(55 + news.score * 10, 88);
          signals.push({
            instId, direction: dir,
            strategy: '1️⃣8️⃣ News Trading',
            confidence: Math.round(conf),
            price: price_s18,
            paperOnly: true,
            ...calcSLTP(price_s18, dir, '1️⃣8️⃣ News Trading', atr_s18),
            metrics: `${news.title?.substring(0, 40)}...`,
          });
        }
      }
    } catch(e) { console.error('S18 error:', e.message); }

    // ════════════════════════════════════════════════════════
    // S19: Value Area Reversal (1H) — PAPER ONLY (сбор данных)
    // Цена дипает ниже VAL через LVN → возвращается → LONG
    // Улучшение: используем calcVolumeProfile (зонный VP) + LVN как фильтр
    // LVN = Low Volume Node = быстропроходимая зона = сильное отталкивание
    // ════════════════════════════════════════════════════════
    try {
      const k1h_s19 = await getOKXKlinesCached(instId, '1H', 48);
      const k15_s19 = await getOKXKlinesCached(instId, '15m', 20);

      if (k1h_s19.length >= 24 && k15_s19.length >= 10) {
        // Строим Volume Profile за последние 24 часа (100 зон — точнее)
        const session24 = k1h_s19.slice(-24);
        const vp = calcVolumeProfile(session24, 100);
        if (!vp) throw new Error('VP calc failed');

        const { poc, vah, val, lvn, hvn } = vp;

        // Последние 3 свечи 15m
        const last3     = k15_s19.slice(-3);
        const mid       = last3[1]; // предыдущая
        const curr      = last3[2]; // текущая
        const price_s19 = curr.close;

        // Объём
        const dipVol    = mid.quoteVolume  || 0;
        const returnVol = curr.quoteVolume || 0;
        const avgVol    = k15_s19.slice(-10).reduce((s, k) => s + (k.quoteVolume || 0), 0) / 10;

        // ── Проверка LVN: дип прошёл через Low Volume Node ──────
        // LVN под VAL = "тонкая" зона, цена быстро её пробивает и отталкивается
        const dipLow  = mid.low;
        const dipHigh = mid.high;

        const lvnBelowVAL = lvn.filter(n => n.high <= val && n.high >= val * 0.98);  // LVN прямо под VAL
        const lvnAboveVAH = lvn.filter(n => n.low >= vah && n.low <= vah * 1.02);   // LVN прямо над VAH
        const dipHitLVN   = lvn.some(n => dipLow <= n.high && dipHigh >= n.low);    // дип попал в LVN

        // HVN near POC: подтверждение что VAL/VAH — реальный уровень поддержки
        const hvnNearPOC = hvn.some(n => Math.abs(n.price - poc) / poc < 0.01);

        // ── LONG: дип ниже VAL + возврат выше VAL ───────────────
        const longCondition =
          mid.low  < val &&
          curr.close > val &&
          dipVol    < avgVol * 0.8 &&
          returnVol > avgVol * 1.2;

        // ── SHORT: пробой выше VAH + возврат ────────────────────
        const shortCondition =
          mid.high  > vah &&
          curr.close < vah &&
          dipVol    < avgVol * 0.8 &&
          returnVol > avgVol * 1.2;

        if (longCondition || shortCondition) {
          const dir      = longCondition ? 'long' : 'short';
          const atr_s19  = calcATR(k15_s19, 10);
          const lvnNodes = longCondition ? lvnBelowVAL : lvnAboveVAH;

          // ── Confidence ──────────────────────────────────────────
          // База: 60
          // +15 если дип прошёл через LVN (ключевое улучшение)
          // +10 если LVN прямо у границы VA
          // +8  если возврат сильный (>2x avgVol)
          // +8  если цена близко к POC (магнит)
          // +5  если есть HVN у POC (подтверждение уровня)
          // +7  если VA строится в нашу сторону
          const vaBuilding = longCondition
            ? vah > (k1h_s19[k1h_s19.length - 12]?.close || 0)
            : val < (k1h_s19[k1h_s19.length - 12]?.close || 0);

          const conf = Math.min(
            60 +
            (dipHitLVN              ? 15 : 0) +
            (lvnNodes.length > 0    ? 10 : 0) +
            (returnVol / avgVol > 2 ?  8 : 4) +
            (Math.abs(price_s19 - poc) / poc < 0.015 ? 8 : 0) +
            (hvnNearPOC             ?  5 : 0) +
            (vaBuilding             ?  7 : 0),
            90
          );

          // ── LVN описание для metrics ────────────────────────────
          const lvnDesc = dipHitLVN
            ? `LVN✅(${lvn.filter(n => dipLow <= n.high && dipHigh >= n.low).length} nodes hit)`
            : 'LVN❌';

          signals.push({
            instId, direction: dir,
            strategy:   '1️⃣9️⃣ Value Area Reversal (1H)',
            confidence: Math.round(conf),
            price:      price_s19,
            paperOnly:  true,
            ...calcSLTP(price_s19, dir, '1️⃣9️⃣ Value Area Reversal (1H)', atr_s19),
            metrics: `VAL:${val.toFixed(4)} VAH:${vah.toFixed(4)} POC:${poc.toFixed(4)} ${lvnDesc} RetVol:${(returnVol / avgVol).toFixed(1)}x`,
          });
        }
      }
    } catch(e) { console.error('S19 error:', e.message); }

    // ════════════════════════════════════════════════════════
    // S16: VWAP Deviation (1H) — PAPER ONLY (сбор данных)
    // Цена сильно отклонилась от VWAP → возврат к среднему
    // ════════════════════════════════════════════════════════
    try {
      const k1h_s16 = await getOKXKlinesCached(instId, '1H', 50);
      if (k1h_s16.length >= 20) {
        const vwap_s16 = calcVWAP(k1h_s16);
        const price_s16 = k1h_s16[k1h_s16.length-1].close;
        const dev = (price_s16 - vwap_s16) / vwap_s16 * 100;
        const atr_s16 = calcATR(k1h_s16, 14);
        const rsi_s16 = k1h_s16.length >= 15 ? calcRSI(k1h_s16, 14) : 50;

        // Отклонение > 3% + RSI подтверждает разворот
        if (Math.abs(dev) > 3) {
          const dir = dev > 3 ? 'short' : 'long'; // цена выше VWAP → шорт, ниже → лонг
          const rsiOk = dir === 'short' ? rsi_s16 > 65 : rsi_s16 < 35;
          if (rsiOk) {
            const conf = Math.min(50 + Math.abs(dev) * 3 + (dir === 'short' ? rsi_s16 - 65 : 35 - rsi_s16), 85);
            signals.push({
              instId, direction: dir,
              strategy: '1️⃣6️⃣ VWAP Deviation (1H)',
              confidence: Math.round(conf),
              price: price_s16,
              paperOnly: true, // всегда paper
              ...calcSLTP(price_s16, dir, '1️⃣6️⃣ VWAP Deviation (1H)', atr_s16),
              metrics: `Dev:${dev.toFixed(1)}% RSI:${rsi_s16.toFixed(0)}`,
            });
          }
        }
      }
    } catch(e) { console.error('S16 error:', e.message); }

    // ════════════════════════════════════════════════════════
    // S17: BB Squeeze (1H) — ОТКЛЮЧЕНА (WR 24% на 178 сделках = антисигнал)
    /* S17 disabled
    try {
      const k1h_s17 = await getOKXKlinesCached(instId, '1H', 30);
      if (k1h_s17.length >= 20) {
        const closes = k1h_s17.map(k => k.close);
        const ma20 = closes.slice(-20).reduce((a,b) => a+b, 0) / 20;
        const std20 = Math.sqrt(closes.slice(-20).reduce((s,c) => s + Math.pow(c-ma20,2), 0) / 20);
        const bbWidth = (std20 * 4) / ma20 * 100; // ширина BB в %
        const price_s17 = closes[closes.length-1];
        const atr_s17 = calcATR(k1h_s17, 14);
        const adx_s17 = calcADX(k1h_s17, 14);

        // BB сжаты (ширина < 3%) + ADX растёт → ожидаем пробой
        if (bbWidth < 3 && adx_s17 > 20) {
          const dir = price_s17 > ma20 ? 'long' : 'short';
          const conf = Math.min(55 + (3 - bbWidth) * 5 + adx_s17 * 0.3, 82);
          signals.push({
            instId, direction: dir,
            strategy: '1️⃣7️⃣ BB Squeeze (1H)',
            confidence: Math.round(conf),
            price: price_s17,
            paperOnly: true, // всегда paper
            ...calcSLTP(price_s17, dir, '1️⃣7️⃣ BB Squeeze (1H)', atr_s17),
            metrics: `BBW:${bbWidth.toFixed(1)}% ADX:${adx_s17.toFixed(0)}`,
          });
        }
      }
    } catch(e) { console.error('S17 error:', e.message); }
    */ // end S17 disabled

  } catch(e) { console.error(`runStrategies [${instId}]:`, e.message); }
  return signals;
}


// Ориентировочное время сделки на основе ATR и таймфрейма
function estimateTradeDuration(strategy, atr, price) {
  // Базовое время по стратегии
  const base = {
    '2️⃣ Liquidity Bounce (1h)':      { min: 2,  max: 8  },
    '4️⃣ MA20/MA50+RSI (1h)':         { min: 4,  max: 12 },
    '5️⃣ RSI Дивергенция (1h)':       { min: 3,  max: 10 },
    '6️⃣ Funding Extreme (1h)':       { min: 2,  max: 8  },
    '7️⃣ Поглощение на объёме (15m)': { min: 1,  max: 4  },
    '8️⃣ Basis Farming (1h)':         { min: 4,  max: 16 },
  };
  const t = base[strategy] || { min: 2, max: 8 };

  // Если ATR большой — рынок волатильный — сделка закроется быстрее
  if (atr && price) {
    const atrPct = atr / price * 100;
    if (atrPct > 2.0) return `~${t.min}-${Math.round(t.max * 0.6)}ч`;
    if (atrPct > 1.0) return `~${t.min}-${t.max}ч`;
  }
  return `~${t.min}-${t.max}ч`;
}

// ============================================================
//  ФОРМАТИРОВАНИЕ
// ============================================================
function buildSignalAlert(sig) {
  if (!sig || !sig.instId) return '⚠️ Ошибка сигнала: нет instId';
  const filled   = Math.round(sig.confidence / 10);
  const bar      = '█'.repeat(filled) + '░'.repeat(10 - filled);
  const emoji    = sig.direction === 'long' ? '🚀' : '🩸';
  const name     = (sig.instId||'').replace('-USDT-SWAP', '');
  const meta      = STRATEGY_META[sig.strategy] || { color: '#999', rating: '?', wr: '?' };
  const ratingLine = `${meta.rating === 'A' ? '🟢' : meta.rating === 'B' ? '🟡' : '🔴'} Рейтинг: ${meta.rating} | Win Rate: ${meta.wr}`;
  const timeStr  = getAlmatyTime();
  const fngEmoji = !sig.fng ? '😐' : sig.fng.value < 25 ? '😱' : sig.fng.value > 75 ? '🤑' : '😐';
  const fngLine  = sig.fng ? `${fngEmoji} F&G: ${sig.fng.value} (${sig.fng.label})` : '';
  const slPct = sig.price && sig.sl
    ? Math.abs((parseFloat(sig.sl) - sig.price) / sig.price * 100).toFixed(2)
    : null;
  if (slPct) sig.slPctNote = `📏 ATR стоп: ${slPct}% от цены`;
  const notes = [sig.srNote, sig.slNote, sig.slPctNote, sig.fngNote, sig.sessionNote, sig.dowNote, sig.macroNote, sig.etfNote, sig.regimeNote, sig.lsrNote, sig.btcDomNote, sig.cbNote, sig.liqNote, sig.liqLevelNote, sig.patternNote, sig.chartPatNote, sig.newsNote, sig.whaleNote, sig.trendNote, sig.ma200Note, sig.vwapNote, sig.mtfNote, sig.obvNote, sig.bbNote, sig.volNote, sig.fvgNote, sig.fibNote, sig.pocNote, sig.mpocNote, sig.absNote, sig.deltaNote, sig.gexNote, sig.footprintNote, sig.assetNote, sig.aiNote]
    .filter(Boolean).map(n => `  ${n}`).join('\n');
  const duration = estimateTradeDuration(sig.strategy, sig.atr, sig.price);

  // ── Расчёт Position Size с учётом риска ──────────────────
  const effectiveRisk = getEffectiveRiskPct();
  const riskUSD   = store.accountBalance * effectiveRisk / 100;
  const ddNote    = effectiveRisk < store.riskPct ? `⚠️ Риск снижен с ${store.riskPct}% до ${effectiveRisk.toFixed(2)}% (просадка)` : '';
  const slDistPct = sig.price && sig.sl
    ? Math.abs((parseFloat(sig.sl) - sig.price) / sig.price)
    : 0.015;
  const positionSize = slDistPct > 0 ? (riskUSD / slDistPct) : 0;
  const margin       = positionSize / store.leverage;
  const maxPosition  = store.accountBalance * store.leverage;
  const positionLine = positionSize > maxPosition
    ? `\n💵 Position: $${positionSize.toFixed(0)} ⚠️ превышает баланс×плечо ($${maxPosition.toFixed(0)})\n   Маржа: $${margin.toFixed(0)} (${store.leverage}x)`
    : `\n💵 Position: $${positionSize.toFixed(0)} | Маржа: $${margin.toFixed(0)} (${store.leverage}x)\n   Риск: $${riskUSD.toFixed(0)} (${store.riskPct}%)`;

  const dirLabel  = sig.signal || (sig.direction === 'long' ? '🟢 LONG' : '🔴 SHORT');

  return (
    `${emoji} ${name}/USDT — ${dirLabel}\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    (store.observeMode ? `👁 РЕЖИМ НАБЛЮДЕНИЯ — не торгуй\n` : '') +
    `📌 ${sig.strategy}\n` +
    `${ratingLine}\n` +
    `⏰ ${timeStr} Алматы\n` +
    `⌛️ Ориентир: ${duration} в позиции\n` +
    (fngLine ? fngLine + '\n' : '') +
    `\n💰 Вход: $${sig.price}\n` +
    `🛡 Стоп-лосс:    $${sig.sl}\n` +
    `🎯 Тейк-1 (1:2) закрой 50%: $${sig.tp1}\n` +
    `🎯 Тейк-2 (1:3) остаток: $${sig.tp2}\n` +
    positionLine + `\n\n` +
    `📊 Уверенность: ${sig.confidence}%\n` +
    `[${bar}]\n\n` +
    `🔍 ${sig.metrics}\n` +
    (notes ? `\n📝 Контекст:\n${notes}\n` : '') +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `⚠️ Не является финансовым советом.`
  );
}

function buildOutcomeAlert(trade) {
  const map = {
    tp1:       { e:'✅', t:'ТП1 достигнут' },
    tp2:       { e:'🏆', t:'ТП2 достигнут' },
    sl:        { e:'❌', t:'Стоп-лосс' },
    breakeven: { e:'🛡', t:'Безубыток (SL в BE)' },
    expired:   { e:'⏰', t:'Истёк' }
  };
  const o   = map[trade.outcome] || { e:'❓', t: trade.outcome };
  const age = Math.round((trade.closedAt - trade.ts) / 60000);
  const pnl = trade.pnl >= 0 ? `+${trade.pnl}%` : `${trade.pnl}%`;
  const meta = STRATEGY_META[trade.strategy] || { rating: '?', wr: '?' };
  const ratingEmoji = meta.rating === 'A' ? '🟢' : meta.rating === 'B' ? '🟡' : '🔴';
  return (
    `${o.e} ${trade.symbol}/USDT — ${o.t}\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `📌 ${trade.strategy}\n` +
    `${ratingEmoji} Рейтинг: ${meta.rating} | Win Rate: ${meta.wr}\n` +
    `💰 Вход: $${trade.price}\n` +
    `${trade.closePrice ? `📍 Выход: $${trade.closePrice}\n` : ''}` +
    `💵 PnL: ${pnl}\n` +
    `⏱ В сделке: ${age} мин\n` +
    `📊 Уверенность: ${trade.confidence}%`
  );
}


// ============================================================
//  COOLDOWN
// ============================================================
function isCoinOnCooldown(instId) {
  const ts = store.cooldowns[instId];
  return ts && (Date.now() - ts) / 60000 < COOLDOWN_MIN;
}
function setCoinCooldown(instId) { store.cooldowns[instId] = Date.now(); }


// ============================================================
//  ХРАНЕНИЕ СДЕЛОК
// ============================================================
async function saveOpenTrade(sig) {
  // В памяти
  store.openTrades.push({
    ts: sig.ts, instId: sig.instId,
    symbol: (sig.instId||'').replace('-USDT-SWAP',''),
    strategy: sig.strategy, direction: sig.direction,
    price: sig.price, sl: sig.sl, tp1: sig.tp1,
    tp2: sig.tp2, confidence: sig.confidence
  });
  if (store.openTrades.length > 100) store.openTrades = store.openTrades.slice(-100);

  // В базу данных
  try {
    await supabase.from('open_trades').insert({
      ts:         sig.ts,
      inst_id:    sig.instId,
      symbol:     (sig.instId||'').replace('-USDT-SWAP',''),
      strategy:   sig.strategy,
      direction:  sig.direction,
      price:      sig.price,
      sl:         sig.sl,
      tp1:        sig.tp1,
      tp2:        sig.tp2,
      confidence: sig.confidence,
    });
  } catch(e) { console.error('[DB] saveOpenTrade error:', e.message); }
}
async function logSignal(sig) {
  // В памяти (для текущей сессии)
  store.signalLog.push({
    ts: sig.ts, symbol: (sig.instId||'').replace('-USDT-SWAP',''),
    strategy: sig.strategy, direction: sig.direction,
    price: sig.price, confidence: sig.confidence
  });
  if (store.signalLog.length > 300) store.signalLog = store.signalLog.slice(-300);

  // В базу данных (постоянно)
  try {
    await supabase.from('signals').insert({
      ts:         sig.ts,
      inst_id:    sig.instId,
      symbol:     (sig.instId||'').replace('-USDT-SWAP',''),
      strategy:   sig.strategy,
      direction:  sig.direction,
      signal:     sig.signal,
      price:      sig.price,
      confidence: sig.confidence,
    });
  } catch(e) { console.error('[DB] logSignal error:', e.message); }
}


// ============================================================
//  ВСПОМОГАТЕЛЬНЫЕ
// ============================================================
function getAlmatyTime() { return new Date(Date.now() + 5*60*60*1000).toISOString().substr(11, 5); }
function getAlmatyDate() { return new Date(Date.now() + 5*60*60*1000).toISOString().substr(0, 10); }


// ============================================================
//  ОСНОВНЫЕ ФУНКЦИИ (запускаются по расписанию)
// ============================================================
const express = require('express');
const app     = express();

const path = require('path');

// ── NEWS API ──────────────────────────────────────────────────
app.get('/paper-app', (req, res) => {
  try {
    const html = fs.readFileSync(path.join(__dirname, 'paper_trading_app.html'), 'utf8');
    res.send(html);
  } catch(e) {
    res.status(500).send('Ошибка: ' + e.message);
  }
});

app.get('/api/paper', async (req, res) => {
  try {
    const open = (global.paperTrades || []).filter(t => !t.outcome);

    // Закрытые — из Supabase, фильтруем с момента последнего /observe
    let query = supabase
      .from('paper_trades')
      .select('*')
      .not('outcome', 'is', null)
      .order('closed_at', { ascending: false })
      .limit(500);

    if (store.observeStartedAt) {
      query = query.gte('ts', store.observeStartedAt);
    }

    const { data: closedDB } = await query;

    const closed = (closedDB || []).map(r => ({
      instId:    r.inst_id,
      strategy:  r.strategy,
      direction: r.direction,
      price:     parseFloat(r.price),
      outcome:   r.outcome,
      pnl:       r.pnl ? parseFloat(r.pnl) : null,
      closedAt:  r.closed_at,
      ts:        r.ts,
      ageMin:    r.closed_at && r.ts ? Math.round((r.closed_at - r.ts) / 60000) : null,
    }));

    const wins    = closed.filter(t => t.outcome === 'tp1' || t.outcome === 'tp2');
    const losses  = closed.filter(t => t.outcome === 'sl');
    const expired = closed.filter(t => t.outcome === 'expired');
    const wr      = closed.length ? Math.round(wins.length / closed.length * 100) : 0;
    const totalPnl = closed.reduce((s, t) => s + (t.pnl || 0), 0);

    const byStrat = {};
    for (const t of closed) {
      const key = (t.strategy || '?').substring(0, 30);
      if (!byStrat[key]) byStrat[key] = { wins: 0, losses: 0, expired: 0, pnl: 0 };
      if (t.outcome === 'tp1' || t.outcome === 'tp2') byStrat[key].wins++;
      else if (t.outcome === 'sl') byStrat[key].losses++;
      else byStrat[key].expired++;
      byStrat[key].pnl += t.pnl || 0;
    }
    for (const k of Object.keys(byStrat)) byStrat[k].pnl = parseFloat(byStrat[k].pnl.toFixed(2));

    res.json({
      open: open.map(t => ({
        instId:     t.instId,
        strategy:   t.strategy,
        direction:  t.direction,
        price:      t.price,
        sl:         t.sl,
        tp1:        t.tp1,
        confidence: t.confidence,
        ageMin:     Math.round((Date.now() - t.ts) / 60000),
      })),
      closed,
      stats: closed.length ? { total: closed.length, wins: wins.length, losses: losses.length, expired: expired.length, wr, totalPnl: parseFloat(totalPnl.toFixed(2)), byStrat } : null,
      observeMode:      store.observeMode,
      observeStartedAt: store.observeStartedAt || null,
      timestamp:        Date.now(),
    });
  } catch(e) {
    console.error('[API/paper]', e.message);
    res.json({ open: [], closed: [], stats: null, observeMode: store.observeMode, error: e.message });
  }
});

// ── BACKTEST API ─────────────────────────────────────────────
app.get('/api/backtest', async (req, res) => {
  try {
    const instId = req.query.instId || 'SOL-USDT-SWAP';
    const period = Math.min(parseInt(req.query.period) || 14, 30);
    const limit  = period * 24 * 4 + 10; // 15m свечи

    // Загружаем исторические данные
    const [k15m, k1h, k4h] = await Promise.all([
      getOKXKlinesCached(instId, '15m', Math.min(limit, 300)),
      getOKXKlinesCached(instId, '1H',  Math.min(period * 24, 300)),
      getOKXKlinesCached(instId, '4H',  Math.min(period * 6,  100)),
    ]);

    if (!k15m.length) return res.json({ signals: [], error: 'Нет данных' });

    const cutoff  = Date.now() - period * 24 * 60 * 60 * 1000;
    const signals = [];

    // Прогоняем S1 Volume Spike по истории
    for (let i = 15; i < k15m.length - 1; i++) {
      const slice = k15m.slice(i - 14, i + 1);
      const last  = slice[slice.length - 1];
      const prev  = slice[slice.length - 2];
      if (!last || !prev || last.ts < cutoff) continue;

      const avgVol   = slice.slice(-11, -1).reduce((a,c) => a + (c.quoteVolume||0), 0) / 10;
      const volSpike = (last.quoteVolume||0) >= avgVol * 2.0;
      const pc       = prev.close ? (last.close - prev.close) / prev.close * 100 : 0;

      if (volSpike && Math.abs(pc) >= 1.0) {
        const dir  = pc >= 0 ? 'long' : 'short';
        const atr  = calcATR(slice, 10) || last.close * 0.015;
        const sl   = dir === 'long' ? last.close - atr : last.close + atr;
        const tp1  = dir === 'long' ? last.close + atr * 2 : last.close - atr * 2;
        const conf = Math.min(65 + (last.quoteVolume / avgVol - 2) * 10, 95);

        // Симулируем исход по следующим свечам
        let outcome = 'open', pnl = 0, closePrice = last.close;
        for (let j = i + 1; j < Math.min(i + 33, k15m.length); j++) {
          const future = k15m[j];
          if (!future) break;
          const high = future.high || future.close;
          const low  = future.low  || future.close;
          if (dir === 'long') {
            if (low  <= sl)  { outcome = 'sl';  closePrice = sl;  pnl = (sl - last.close) / last.close * 100; break; }
            if (high >= tp1) { outcome = 'tp1'; closePrice = tp1; pnl = (tp1 - last.close) / last.close * 100; break; }
          } else {
            if (high >= sl)  { outcome = 'sl';  closePrice = sl;  pnl = (last.close - sl) / last.close * 100; break; }
            if (low  <= tp1) { outcome = 'tp1'; closePrice = tp1; pnl = (last.close - tp1) / last.close * 100; break; }
          }
        }
        if (outcome === 'open') { outcome = 'expired'; pnl = (k15m[Math.min(i+32,k15m.length-1)].close - last.close) / last.close * 100 * (dir==='long'?1:-1); }

        signals.push({
          ts:        last.ts,
          strategy:  '1️⃣ Volume Spike (15m)',
          direction: dir,
          price:     parseFloat(last.close.toFixed(4)),
          sl:        parseFloat(sl.toFixed(4)),
          tp1:       parseFloat(tp1.toFixed(4)),
          confidence: Math.round(conf),
          outcome,
          pnl:       parseFloat(pnl.toFixed(2)),
          closePrice: parseFloat(closePrice.toFixed(4)),
          volRatio:  parseFloat((last.quoteVolume / avgVol).toFixed(1)),
        });
      }
    }

    // Прогоняем S4 MA20/MA50 по истории
    for (let i = 55; i < k1h.length - 1; i++) {
      const slice = k1h.slice(i - 54, i + 1);
      const last  = slice[slice.length - 1];
      if (!last || last.ts < cutoff) continue;

      const closes = slice.map(k => k.close);
      const ma20  = closes.slice(-20).reduce((a,b) => a+b, 0) / 20;
      const ma50  = closes.slice(-50).reduce((a,b) => a+b, 0) / 50;
      const prev20 = closes.slice(-21,-1).reduce((a,b) => a+b, 0) / 20;
      const prev50 = closes.slice(-51,-1).reduce((a,b) => a+b, 0) / 50;

      const crossUp   = prev20 <= prev50 && ma20 > ma50;
      const crossDown = prev20 >= prev50 && ma20 < ma50;

      if (crossUp || crossDown) {
        const dir  = crossUp ? 'long' : 'short';
        const atr  = calcATR(slice, 14) || last.close * 0.015;
        const sl   = dir === 'long' ? last.close - atr : last.close + atr;
        const tp1  = dir === 'long' ? last.close + atr * 2 : last.close - atr * 2;
        const gap  = Math.abs(ma20 - ma50) / ma50 * 100;
        const conf = Math.min(50 + gap * 20, 85);

        let outcome = 'open', pnl = 0, closePrice = last.close;
        for (let j = i + 1; j < Math.min(i + 9, k1h.length); j++) {
          const future = k1h[j];
          if (!future) break;
          const high = future.high || future.close;
          const low  = future.low  || future.close;
          if (dir === 'long') {
            if (low  <= sl)  { outcome='sl';  closePrice=sl;  pnl=(sl-last.close)/last.close*100; break; }
            if (high >= tp1) { outcome='tp1'; closePrice=tp1; pnl=(tp1-last.close)/last.close*100; break; }
          } else {
            if (high >= sl)  { outcome='sl';  closePrice=sl;  pnl=(last.close-sl)/last.close*100; break; }
            if (low  <= tp1) { outcome='tp1'; closePrice=tp1; pnl=(last.close-tp1)/last.close*100; break; }
          }
        }
        if (outcome==='open') { outcome='expired'; pnl=0; }

        signals.push({
          ts:        last.ts,
          strategy:  '4️⃣ MA20/MA50 (1H)',
          direction: dir,
          price:     parseFloat(last.close.toFixed(4)),
          sl:        parseFloat(sl.toFixed(4)),
          tp1:       parseFloat(tp1.toFixed(4)),
          confidence: Math.round(conf),
          outcome,
          pnl:       parseFloat(pnl.toFixed(2)),
          closePrice: parseFloat(closePrice.toFixed(4)),
        });
      }
    }

    signals.sort((a,b) => b.ts - a.ts);
    res.json({ signals, instId, period, total: signals.length });
  } catch(e) {
    console.error('[API/backtest]', e.message);
    res.json({ signals: [], error: e.message });
  }
});

app.get('/api/trades', async (req, res) => {
  try {
    const open = store.openTrades || [];

    // In-memory live trades (current session)
    let closed = (store.tradeHistory || []).filter(t => t.source === 'bybit_real' || !t.source);

    // Load live trades from Supabase 'trades' table (clean live-only data)
    try {
      const { data } = await supabase
        .from('trades')
        .select('*')
        .not('outcome', 'is', null)
        .neq('outcome', 'open')
        .order('ts', { ascending: false })
        .limit(200);

      if (data?.length) {
        const fromDB = data.map(t => ({
          ts:         t.ts,
          instId:     t.inst_id,
          symbol:     t.symbol || (t.inst_id || '').replace('-USDT-SWAP', ''),
          strategy:   t.strategy,
          direction:  t.direction,
          price:      t.price,
          closePrice: t.close_price,
          sl:         t.sl,
          tp1:        t.tp1,
          tp2:        t.tp2,
          confidence: t.confidence,
          outcome:    t.outcome,
          pnl:        t.pnl,
          closedAt:   t.closed_at,
          source:     'bybit_real',
        }));

        // Merge by ts to avoid duplicates with in-memory data
        const inMemoryTs = new Set(closed.map(t => t.ts));
        const newFromDB  = fromDB.filter(t => !inMemoryTs.has(t.ts));
        closed = [...closed, ...newFromDB]
          .sort((a, b) => (b.closedAt || b.ts || 0) - (a.closedAt || a.ts || 0));
      }
    } catch(dbErr) {
      console.error('[/api/trades] Supabase fetch error:', dbErr.message);
    }

    const wins     = closed.filter(t => t.outcome === 'tp1' || t.outcome === 'tp2');
    const losses   = closed.filter(t => t.outcome === 'sl');
    const wr       = closed.length ? Math.round(wins.length / closed.length * 100) : 0;
    const totalPnl = closed.reduce((s, t) => s + (t.pnl || 0), 0);

    res.json({
      open:   open.slice(-20),
      closed: closed.slice(0, 100),
      stats:  closed.length ? {
        total:    closed.length,
        wins:     wins.length,
        losses:   losses.length,
        wr,
        totalPnl: parseFloat(totalPnl.toFixed(2)),
      } : null,
    });
  } catch(e) {
    console.error('[/api/trades]', e.message);
    res.json({ open: [], closed: [], stats: null });
  }
});

app.get('/api/radar', async (req, res) => {
  try {
    const candidates = await getOKXCandidates();
    res.json({
      ok:    true,
      coins: candidates.slice(0, 50).map(c => ({
        instId:      c.instId,
        symbol:      c.symbol,
        price:       c.price,
        change24h:   parseFloat((c.change24h || 0).toFixed(2)),
        volume24h:   c.volume24h,
        fundingRate: parseFloat(((c.fundingRate || 0) * 100).toFixed(4)),
      })),
      count:     candidates.length,
      timestamp: Date.now(),
    });
  } catch(e) {
    res.json({ ok: false, error: e.message, coins: [] });
  }
});

app.get('/api/news', async (req, res) => {
  try {
    const key = process.env.CRYPTOCOMPARE_KEY || '';
    const url = `https://min-api.cryptocompare.com/data/v2/news/?lang=EN&limit=50${key ? '&api_key=' + key : ''}`;
    const data = await httpGet(url);
    if (data?.Data?.length) {
      res.json({ ok: true, data: data.Data });
    } else {
      res.json({ ok: false, error: 'No data' });
    }
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── WHALES API (Copy Trading Tracker) ─────────────────────────
app.get('/api/regime', (req, res) => {
  try {
    const r = regimeDetector ? regimeDetector.get() : null;
    res.json({ ok: true, mode: r?.mode || 'UNKNOWN', data: r || {} });
  } catch(e) {
    res.json({ ok: true, mode: 'UNKNOWN', data: {} });
  }
});

// ── FLASH CRASH STRESS TEST ──────────────────────────────────
app.get('/api/flashcrash', (req, res) => {
  try {
    const balance  = store.accountBalance || 9200;
    const riskPct  = store.riskPct || 0.5;
    const leverage = store.leverage || 5;
    const maxPos   = 2;
    const dailyLimit  = balance * 0.03;
    const weeklyLimit = balance * 0.08;

    const scenarios = [
      { name: 'Мягкий (-10%)',              drop: 10, slipMult: 1.3 },
      { name: 'Средний (-20%)',             drop: 20, slipMult: 2.5 },
      { name: 'Жёсткий (-30%, май 2021)',   drop: 30, slipMult: 4.0 },
      { name: 'Крах (-50%, FTX ноябрь 2022)', drop: 50, slipMult: 6.0 },
    ].map(s => {
      const loss    = parseFloat((balance * riskPct / 100 * maxPos * s.slipMult).toFixed(0));
      const lossPct = parseFloat((riskPct * maxPos * s.slipMult).toFixed(1));
      return {
        name:          s.name,
        drop:          s.drop,
        estimatedLoss: loss,
        lossPct,
        survived:      loss < balance * 0.5,
        hitsDaily:     loss >= dailyLimit,
        hitsWeekly:    loss >= weeklyLimit,
        balanceAfter:  Math.max(0, balance - loss).toFixed(0),
      };
    });

    res.json({
      ok: true,
      params:   { balance, riskPct, leverage, maxPositions: maxPos },
      limits:   { daily: dailyLimit.toFixed(0), weekly: weeklyLimit.toFixed(0) },
      scenarios,
    });
  } catch(e) { res.json({ ok: false, error: e.message }); }
});

app.get('/api/cot', (req, res) => {
  res.json({
    ok:        true,
    data:      cotCache.data,
    updatedAt: cotCache.ts,
    age:       cotCache.ts ? Math.round((Date.now() - cotCache.ts) / 3600000) + 'h ago' : 'never',
  });
});

app.get('/api/whales', (req, res) => {
  try {
    if (!copytrader) return res.json({ traders: [], enabled: false });
    const snapshot = copytrader.getTrackedWhalesSnapshot();
    // getTrackedWhalesSnapshot() returns { whales: [...], stats, enabled, ... }
    const traders = snapshot?.whales || [];
    res.json({
      ok:        true,
      traders,
      stats:     snapshot?.stats || {},
      enabled:   snapshot?.enabled ?? true,
      updatedAt: snapshot?.updatedAt || null,
      lastLeaderboardUpdate: snapshot?.lastLeaderboardUpdate || null,
    });
  } catch(e) {
    res.json({ traders: [], error: e.message });
  }
});

// ── RSS MEDIA API ─────────────────────────────────────────────
app.get('/api/rss', async (req, res) => {
  try {
    const feeds = [
      { name: 'CoinTelegraph', handle: 'cointelegraph', url: 'https://cointelegraph.com/rss',                   avatar: 'CT', color: '#00cc88' },
      { name: 'CoinDesk',      handle: 'coindesk',      url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', avatar: 'CD', color: '#1d9bf0' },
      { name: 'Decrypt',       handle: 'decrypt',       url: 'https://decrypt.co/feed',                        avatar: 'DC', color: '#9945ff' },
      { name: 'The Block',     handle: 'theblock',      url: 'https://www.theblock.co/rss.xml',                avatar: 'TB', color: '#ff8c00' },
      { name: 'Bitcoin Mag',   handle: 'bitcoinmag',    url: 'https://bitcoinmagazine.com/.rss/full/',          avatar: 'BM', color: '#f7931a' },
    ];

    const articles = [];
    for (const feed of feeds) {
      try {
        // Используем fetch для получения XML как текст
        const resp = await fetch(feed.url, {
          headers: { 'User-Agent': 'Mozilla/5.0 CryptoRadar RSS Reader' },
          signal: AbortSignal.timeout(5000),
        });
        if (!resp.ok) continue;
        const xml = await resp.text();
        if (!xml || xml.length < 100) continue;

        const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)];
        for (const item of items.slice(0, 8)) {
          const c = item[1];
          const title   = (c.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/) || c.match(/<title>([\s\S]*?)<\/title>/))?.[1]?.trim() || '';
          const pubDate = (c.match(/<pubDate>(.*?)<\/pubDate>/))?.[1] || '';
          const link    = (c.match(/<link>(.*?)<\/link>/))?.[1]?.trim() ||
                          (c.match(/<link\s+\/?>(.*?)<\/link>/))?.[1]?.trim() || '';
          if (!title || title.length < 5) continue;
          articles.push({
            title,
            pubDate,
            link,
            handle:  feed.handle,
            source:  feed.name,
            avatar:  feed.avatar,
            color:   feed.color,
          });
        }
      } catch(e) {
        console.log(`[RSS] ${feed.name} error: ${e.message}`);
        continue;
      }
    }

    articles.sort((a,b) => new Date(b.pubDate) - new Date(a.pubDate));
    res.json({ ok: true, articles });
  } catch(e) {
    console.error('[RSS API]', e.message);
    res.status(500).json({ ok: false, error: e.message, articles: [] });
  }
});

// ============================================================
//  BACKTESTING API
// ============================================================
app.get('/backtest', async (req, res) => {
  try {
    res.json({ status: 'running', message: 'Backtesting запущен...' });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/backtest/run', async (req, res) => {
  try {
    const coins  = req.query.coins
      ? req.query.coins.split(',').map(c => `${c}-USDT-SWAP`)
      : ['BTC-USDT-SWAP','ETH-USDT-SWAP','SOL-USDT-SWAP','XRP-USDT-SWAP','DOGE-USDT-SWAP'];
    const limit  = parseInt(req.query.limit) || 300;
    const result = await runBacktest(coins, limit);
    res.json(result);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

async function httpGetFast(url, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const data = await new Promise((resolve, reject) => {
        const mod = url.startsWith('https') ? require('https') : require('http');
        const req = mod.get(url, { timeout: 8000, headers: { 'User-Agent': 'CryptoRadar/4.0' } }, res => {
          let body = '';
          res.on('data', d => body += d);
          res.on('end', () => {
            try { resolve(JSON.parse(body)); } catch { reject(new Error('JSON parse error')); }
          });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      });
      return data;
    } catch(e) {
      if (attempt < retries) {
        const delay = Math.pow(2, attempt) * 500; // 500ms, 1000ms
        await new Promise(r => setTimeout(r, delay));
        console.log(`[RETRY] ${url.split('?')[0]} attempt ${attempt + 2}/${retries + 1}`);
      } else {
        console.error(`[HTTP ERROR] ${url.split('?')[0]}: ${e.message}`);
        return null;
      }
    }
  }
}


async function runBacktest(coins, limit = 300) {
  const strategies = {
  /* 'S1 Пробой 15m':     { signals:0, wins:0, losses:0, expired:0, pnl:0, trades:[] }, */
  'S2 Bounce 1h':      { signals:0, wins:0, losses:0, expired:0, pnl:0, trades:[] },
  'S4 MA/RSI':         { signals:0, wins:0, losses:0, expired:0, pnl:0, trades:[] },
  'S5 RSI Дивергенция':{ signals:0, wins:0, losses:0, expired:0, pnl:0, trades:[] },
  'S7 Поглощение':     { signals:0, wins:0, losses:0, expired:0, pnl:0, trades:[] },
  'S9 Pullback':       { signals:0, wins:0, losses:0, expired:0, pnl:0, trades:[] },
  'S10 4H Range':      { signals:0, wins:0, losses:0, expired:0, pnl:0, trades:[] },
  'S11 Elliott+Fib':   { signals:0, wins:0, losses:0, expired:0, pnl:0, trades:[] },
  //'S9 Pairs Trading':  { signals:0, wins:0, losses:0, expired:0, pnl:0, trades:[] },
};

  for (const instId of coins) {
    const symbol = instId.replace('-USDT-SWAP','');
    // Загружаем 1H свечи для S2 S4 S5 S7
const data1h = await httpGetFast(`https://www.okx.com/api/v5/market/candles?instId=${instId}&bar=1H&limit=${limit}`);
if (!data1h || data1h.code !== '0') continue;
const klines1h = data1h.data.reverse().map(c => ({
  ts:+c[0], open:+c[1], high:+c[2], low:+c[3], close:+c[4],
  volume:+c[5], quoteVolume:+c[7],
}));

// 4H данные для S11 Elliott
const data4h = await httpGetFast(`https://www.okx.com/api/v5/market/candles?instId=${instId}&bar=4H&limit=200`);
const klines4h = (data4h?.code === '0' && data4h.data?.length)
  ? data4h.data.reverse().map(c => ({ ts:+c[0], open:+c[1], high:+c[2], low:+c[3], close:+c[4], volume:+c[5], quoteVolume:+c[7] }))
  : [];

// 5m данные для btS10 (аудит: live S10 работает на 5m — бэктест тоже должен)
// OKX возвращает max 300 свечей × 5m = 25 часов истории за запрос
// Делаем 2 запроса = ~50 часов (достаточно для анализа паттернов)
let klines5m = [];
{
  const d1 = await httpGetFast(`https://www.okx.com/api/v5/market/candles?instId=${instId}&bar=5m&limit=300`);
  if (d1?.code === '0' && d1.data?.length) {
    const batch1 = d1.data.reverse().map(c => ({ ts:+c[0], open:+c[1], high:+c[2], low:+c[3], close:+c[4], volume:+c[5], quoteVolume:+c[7] }));
    const oldest = d1.data[0][0];
    const d2 = await httpGetFast(`https://www.okx.com/api/v5/market/history-candles?instId=${instId}&bar=5m&limit=300&before=${oldest}`);
    const batch2 = (d2?.code === '0' && d2.data?.length)
      ? d2.data.reverse().map(c => ({ ts:+c[0], open:+c[1], high:+c[2], low:+c[3], close:+c[4], volume:+c[5], quoteVolume:+c[7] }))
      : [];
    klines5m = [...batch2, ...batch1];
  }
}

// 30m данные для S11 (вход)
const data30m = await httpGetFast(`https://www.okx.com/api/v5/market/candles?instId=${instId}&bar=30m&limit=300`);
const klines30m = (data30m?.code === '0' && data30m.data?.length)
  ? data30m.data.reverse().map(c => ({ ts:+c[0], open:+c[1], high:+c[2], low:+c[3], close:+c[4], volume:+c[5], quoteVolume:+c[7] }))
  : [];

if (klines1h.length < 60) continue;

    const runs = [
  /* { name:'S1 Пробой 15m',      fn: btS1 }, */
  { name:'S2 Bounce 1h',       fn: btS2 },
  { name:'S4 MA/RSI',          fn: btS4 },
  { name:'S5 RSI Дивергенция', fn: btS5 },
  { name:'S7 Поглощение',      fn: btS7 },
  { name:'S9 Pullback',        fn: btS9 },
  { name:'S10 4H Range',       fn: btS10 },
  { name:'S11 Elliott+Fib',    fn: btS11 },
  //{ name:'S9 Pairs Trading',   fn: btS9 },
];

    for (const { name, fn } of runs) {
      // S1 использует 15m свечи, остальные — 1H
      const klines = klines1h;
      let lastI = -10;
      const isS11 = name.includes('Elliott');
      for (let i = 55; i < klines.length - 15; i++) {
        if (i - lastI < 5) continue;
        const direction = isS11 ? fn(klines, i, klines30m, klines4h) : fn(klines, i);
        if (!direction) continue;

        const price = klines[i].close;
        const atr   = calcATR(klines.slice(0, i+1), 14);
        if (!atr || atr === 0) continue;

        // Фиксированный SL 1.5% — как в live боте
        const slDist = price * 0.015;
        const sl  = direction === 'long' ? price - slDist : price + slDist;
        const tp1 = direction === 'long' ? price + slDist * 2.5 : price - slDist * 2.5;
        const tp2 = direction === 'long' ? price + slDist * 4.0 : price - slDist * 4.0;

        const future = klines.slice(i+1, i+49); // 48 свечей = 48 часов для 1H
        let outcome  = 'expired', pnl = 0;

        for (const c of future) {
          if (direction === 'long') {
            if (c.low  <= sl)  { outcome='sl';  pnl=(sl -price)/price*100; break; }
            if (c.high >= tp2) { outcome='tp2'; pnl=(tp2-price)/price*100; break; }
            if (c.high >= tp1) { outcome='tp1'; pnl=(tp1-price)/price*100; break; }
          } else {
            if (c.high >= sl)  { outcome='sl';  pnl=(price-sl )/price*100; break; }
            if (c.low  <= tp2) { outcome='tp2'; pnl=(price-tp2)/price*100; break; }
            if (c.low  <= tp1) { outcome='tp1'; pnl=(price-tp1)/price*100; break; }
          }
        }

        strategies[name].signals++;
        strategies[name].pnl += pnl;
        strategies[name].trades.push({ symbol, direction, price, outcome, pnl: parseFloat(pnl.toFixed(2)) });
        if (outcome==='tp1'||outcome==='tp2') strategies[name].wins++;
        else if (outcome==='sl') strategies[name].losses++;
        else strategies[name].expired++;
        lastI = i;
      }
    }
  }

  return Object.entries(strategies).map(([name, s]) => ({
    name,
    signals: s.signals,
    wins:    s.wins,
    losses:  s.losses,
    expired: s.expired,
    winRate: s.signals ? Math.round(s.wins/s.signals*100) : 0,
    pnl:     parseFloat(s.pnl.toFixed(2)),
    avgPnl:  s.signals ? parseFloat((s.pnl/s.signals).toFixed(2)) : 0,
    trades:  s.trades.slice(-20),
  }));
}
function btS1(klines, i) {
  if (i < 15) return null;
  const slice   = klines.slice(0, i+1);
  const last    = slice[slice.length-1];
  const prev    = slice[slice.length-2];
  const pc      = prev.close ? (last.close - prev.close) / prev.close * 100 : 0;
  const avgVol  = slice.slice(-11,-1).reduce((a,c)=>a+c.quoteVolume,0)/10;
  const volSpike = last.quoteVolume >= avgVol * 2.0; // снизили с 3x до 2x
  if (!volSpike) return null;
  if (pc >= 1.0) return 'long';  // снизили с 1.5% до 1.0%
  if (pc <= -1.0) return 'short';
  return null;
}

function btS2(klines, i) {
  if (i < 55) return null;
  const slice = klines.slice(0, i+1);
  const last  = slice[slice.length-1];
  const prev  = slice[slice.length-2];
  const pc    = prev.close ? (last.close - prev.close) / prev.close * 100 : 0;
  const rsi   = calcRSI(slice, 14);

  // Проверяем боковик через MA
  const ma20 = calcSMA(slice, 20);
  const ma50 = calcSMA(slice, 50);
  const trendStrength = ma50 ? Math.abs(ma20 - ma50) / ma50 * 100 : 0;
  const isSideways = trendStrength < 1.0;

  const vol = slice.slice(-5).reduce((a,c)=>a+c.quoteVolume,0);
  const volMin = 10000000;

  if (pc <= -2.5 && vol >= volMin && rsi < 40 && isSideways) return 'long';
  if (pc >= 2.5  && vol >= volMin && rsi > 60 && isSideways) return 'short';
  return null;
}

function btS4(klines, i) {
  // S4: MA cross + MA50 тренд + ADX (MA200 на 1H ненадёжна = только 8 дней)
  const slice = klines.slice(0, i+1);
  if (slice.length < 55) return null;

  const cross = calcMACross(slice, 20, 50);
  if (cross === 'none') return null;

  const rsi   = calcRSI(slice, 14);
  const macd  = calcMACD(slice);
  const ma20  = calcSMA(slice, 20);
  const ma50  = calcSMA(slice, 50);
  const price = slice[slice.length-1].close;

  // ADX — нужен тренд для MA cross
  const adx = calcADX(slice, 14);
  if (adx < 15) return null;

  // Фильтр по MA50: торгуем только когда цена на правильной стороне
  const aboveMA50 = price > ma50;
  const belowMA50 = price < ma50;

  // Свежесть кросса
  const maDist      = Math.abs(ma20 - ma50) / ma50 * 100;
  const freshCross  = maDist < 0.5;
  const priceNearMA = Math.abs(price - ma20) / ma20 * 100 < 1.5;
  if (!freshCross && !priceNearMA) return null;

  // MACD двойное подтверждение
  const macdLong  = macd.hist > 0 && macd.macd > macd.signal;
  const macdShort = macd.hist < 0 && macd.macd < macd.signal;

  if (cross==='bullish' && rsi<55 && rsi>30 && macdLong  && aboveMA50) return 'long';
  if (cross==='bearish' && rsi>45 && rsi<70 && macdShort && belowMA50) return 'short';
  return null;
}

function btS5(klines, i) {
  // S5 бэктест v2: ADX боковик + RSI дивергенция
  const slice  = klines.slice(0, i+1);
  if (slice.length < 25) return null;

  // ADX фильтр — боковик ADX < 30
  const adx = calcADX(slice, 14);
  if (adx > 30) return null;

  const closes = slice.map(c => c.close);
  const lows   = slice.map(c => c.low);
  const rsiNow = calcRSI(slice, 14);
  const rsiPrev= calcRSI(slice.slice(0,-5), 14);

  if (lows[lows.length-1] < Math.min(...lows.slice(-20,-1)) &&
      rsiNow > rsiPrev + 2 && rsiNow < 47) return 'long';
  if (closes[closes.length-1] > Math.max(...closes.slice(-20,-1)) &&
      rsiNow < rsiPrev - 2 && rsiNow > 53) return 'short';
  return null;
}

/*function btS9(klines, i) {
  if (i < 10) return null;
  const slice  = klines.slice(0, i+1);
  const last   = slice[slice.length-1];
  const prev4  = slice[slice.length-5];
  const prev8  = slice[slice.length-9];
  if (!prev4 || !prev8) return null;

  const change4h = (last.close - prev4.close) / prev4.close * 100;
  const change8h = (last.close - prev8.close) / prev8.close * 100;
  const rsi = calcRSI(slice, 14);

  if (change4h < -1.5 && change8h > 0 && rsi < 50) return 'long';
  if (change4h > 1.5 && change8h < 0 && rsi > 50) return 'short';

  return null;
} */

function btS7(klines, i) {
  const slice = klines.slice(0, i+1);
  if (slice.length < 10) return null;
  const last = slice[slice.length-1], prev = slice[slice.length-2];
  const engulfL = last.close>last.open && prev.close<prev.open && last.open<=prev.close && last.close>=prev.open;
  const engulfS = last.close<last.open && prev.close>prev.open && last.open>=prev.close && last.close<=prev.open;
  if (!engulfL && !engulfS) return null;
  const avgVol = slice.slice(-10,-1).reduce((a,c)=>a+c.quoteVolume,0)/9;
  if (last.quoteVolume < avgVol*2.5) return null;
  return engulfL ? 'long' : 'short';
}
function btS9(klines, i) {
  // Бэктест S9: Pullback в тренде (строгая версия для 1H)
  const slice = klines.slice(0, i+1);
  if (slice.length < 55) return null;

  const closes = slice.map(c => c.close);
  const highs  = slice.map(c => c.high);
  const lows   = slice.map(c => c.low);
  const vols   = slice.map(c => c.quoteVolume || c.volume || 0);

  // Тренд MA20/MA50 — минимум 0.5% разница
  const ma20 = calcSMA(slice, 20);
  const ma50 = calcSMA(slice, 50);
  const trendStrength = Math.abs(ma20 - ma50) / ma50 * 100;
  const downtrend = ma20 < ma50 && trendStrength > 0.5;
  const uptrend   = ma20 > ma50 && trendStrength > 0.5;
  if (!downtrend && !uptrend) return null;

  const rsi = calcRSI(slice, 14);
  const atr = calcATR(slice, 14);
  const avgVol = vols.slice(-20, -1).reduce((a,b) => a+b, 0) / 19;

  const last6lows   = lows.slice(-6);
  const last6highs  = highs.slice(-6);
  const last6closes = closes.slice(-6);
  const last6vols   = vols.slice(-6);

  // ШОРТ: даунтренд + 3 higher lows + медвежья свеча + объём + RSI строже
  if (downtrend) {
    const pullback = last6lows[2] > last6lows[1] &&
                     last6lows[3] > last6lows[2] &&
                     last6lows[4] > last6lows[3];
    const bearCandle = last6closes[5] < last6closes[4] &&
                       (last6closes[4] - last6closes[5]) > atr * 0.4; // строже 0.3→0.4
    const rsiOk = rsi > 52 && rsi < 68; // строже диапазон
    const volOk = last6vols[5] > avgVol * 1.5; // строже 1.2→1.5
    if (pullback && bearCandle && rsiOk && volOk) return 'short';
  }

  // ЛОНГ: аптренд + 3 lower highs + бычья свеча + объём + RSI строже
  if (uptrend) {
    const pullback = last6highs[2] < last6highs[1] &&
                     last6highs[3] < last6highs[2] &&
                     last6highs[4] < last6highs[3];
    const bullCandle = last6closes[5] > last6closes[4] &&
                       (last6closes[5] - last6closes[4]) > atr * 0.4;
    const rsiOk = rsi > 32 && rsi < 48; // строже диапазон
    const volOk = last6vols[5] > avgVol * 1.5;
    if (pullback && bullCandle && rsiOk && volOk) return 'long';
  }

  return null;
}


function btS10(klines, i) {
  // S10: 4H Range Breakout v2 — торгуем только по тренду MA200
  // Исправляет: 100% SHORT в нисходящем тренде = серия SL
  const slice = klines.slice(0, i+1);
  if (slice.length < 22) return null;

  const price  = slice[slice.length-1].close;

  // Сессионный фильтр 02:00-10:00 UTC (07:00-15:00 Алматы)
  const _ts = slice[slice.length-1].ts || Date.now();
  const _hour = new Date(_ts).getUTCHours();
  if (_hour < 2 || _hour >= 10) return null;

  const ma200  = calcSMA(slice, Math.min(200, slice.length));
  const uptrend = price > ma200;

  const block = slice.slice(-12, -8);
  if (block.length < 4) return null;

  const rangeHigh = Math.max(...block.map(c => c.high));
  const rangeLow  = Math.min(...block.map(c => c.low));
  const rangeSize = rangeHigh - rangeLow;

  // Диапазон 0.6%-4.5%
  if (rangeSize / price < 0.006) return null;
  if (rangeSize / price > 0.045) return null;

  const atr = calcATR(slice, 14);
  if (rangeSize < atr * 0.5 || rangeSize > atr * 3) return null;

  const rsi = calcRSI(slice, 14);
  if (rsi < 20 || rsi > 80) return null;

  const today = slice.slice(-6);
  for (let j = 1; j < today.length; j++) {
    const prev = today[j-1];
    const curr = today[j];

    // Пробой вниз + возврат → LONG (только выше MA200)
    if (prev.close < rangeLow && curr.close > rangeLow && uptrend) {
      const breakDepth = (rangeLow - prev.close) / rangeLow;
      if (breakDepth < 0.002) continue;
      if (curr.close < rangeLow * 1.001) continue;
      return 'long';
    }

    // Пробой вверх + возврат → SHORT (только ниже MA200)
    if (prev.close > rangeHigh && curr.close < rangeHigh && !uptrend) {
      const breakDepth = (prev.close - rangeHigh) / rangeHigh;
      if (breakDepth < 0.002) continue;
      if (curr.close > rangeHigh * 0.999) continue;
      return 'short';
    }
  }
  return null;
}


function btS11(klines, i, klines30m, klines4h) {
  // S11: Elliott Wave + Fibonacci + SMA200 (мультитаймфрейм)
  // 4H: волна + Fib зона, 30m: флаг + вход, 1H: тренд
  const tf4h  = (klines4h  && klines4h.length  >= 15) ? klines4h  : klines;
  const tf30m = (klines30m && klines30m.length >= 10) ? klines30m : klines;

  const slice = klines.slice(0, i+1);
  if (slice.length < 50) return null;

  const price   = slice[slice.length-1].close;
  const sma200  = calcSMA(slice, Math.min(200, slice.length));
  const sma200p = calcSMA(slice.slice(0,-5), Math.min(200, slice.length-5));
  const uptrend   = price > sma200 && sma200 > sma200p * 0.998;
  const downtrend = price < sma200 && sma200 < sma200p * 1.002;
  if (!uptrend && !downtrend) return null;
  if (Math.abs(price - sma200) / sma200 < 0.012) return null;

  // Волна 1 на 4H
  const highs4h = tf4h.map(c => c.high);
  const lows4h  = tf4h.map(c => c.low);
  const lb = Math.min(40, tf4h.length - 3);
  const rH = highs4h.slice(-lb), rL = lows4h.slice(-lb);
  let w0p, w1p, w0i = 0, w1i = 0;
  if (uptrend) {
    w0p = Math.min(...rL); w0i = rL.indexOf(w0p); w1p = rH[0]; w1i = 0;
    for (let w = w0i+1; w < rH.length; w++) if (rH[w] > w1p) { w1p = rH[w]; w1i = w; }
  } else {
    w0p = Math.max(...rH); w0i = rH.indexOf(w0p); w1p = rL[0]; w1i = 0;
    for (let w = w0i+1; w < rL.length; w++) if (rL[w] < w1p) { w1p = rL[w]; w1i = w; }
  }
  if (w1i <= w0i) return null;
  const w1size = Math.abs(w1p - w0p);
  if (w1size / price < 0.015) return null;

  // Fibonacci зона 50%-70% (ужесточено с 38-76%)
  // Только классическая коррекция Эллиотта — не любой откат
  const fib500 = uptrend ? w1p - w1size * 0.500 : w1p + w1size * 0.500;
  const fib700 = uptrend ? w1p - w1size * 0.700 : w1p + w1size * 0.700;
  const inFibZone = uptrend ? (price <= fib500 && price >= fib700) : (price >= fib500 && price <= fib700);
  if (!inFibZone) return null;

  // Флаг на 30m (последние 8 свечей)
  const highs30m = tf30m.map(c => c.high);
  const lows30m  = tf30m.map(c => c.low);
  const n30m = tf30m.length;
  if (n30m < 8) return null;
  const flagH = Math.max(...highs30m.slice(-8));
  const flagL = Math.min(...lows30m.slice(-8));
  if ((flagH - flagL) / price > 0.06) return null;

  // Пробой флага
  const last = tf30m[n30m-1], prev = tf30m[n30m-2];
  const rsi  = calcRSI(slice, 14);
  if (uptrend   && last.close > flagH && prev.close <= flagH && rsi < 72) return 'long';
  if (downtrend && last.close < flagL && prev.close >= flagL && rsi > 28) return 'short';
  return null;
}

app.get('/', async (req, res) => {
  try {
    let html = fs.readFileSync(path.join(__dirname, 'unified_dashboard.html'), 'utf8');
    html = html.replace('%%SUPABASE_URL%%', process.env.SUPABASE_URL || '');
    html = html.replace('%%SUPABASE_KEY%%', process.env.SUPABASE_KEY || '');
    html = html.replace('%%CRYPTOCOMPARE_KEY%%', process.env.CRYPTOCOMPARE_KEY || '');
    res.send(html);
  } catch(e) {
    res.status(500).send('Ошибка: ' + e.message);
  }
});

app.listen(process.env.PORT || 3000);

// Каждые 5 минут — поиск сигналов
let isRunning = false;
let isRunningStartedAt = 0;
const IS_RUNNING_TIMEOUT_MS = 4 * 60 * 1000; // 4 минуты — максимум на цикл

async function checkSignals() {
  // Защита от вечного зависания — сбрасываем если висит > 4 минут
  if (isRunning) {
    if (Date.now() - isRunningStartedAt > IS_RUNNING_TIMEOUT_MS) {
      console.log('[SKIP] checkSignals завис > 4 мин — принудительный сброс');
      isRunning = false;
    } else {
      console.log('[SKIP] checkSignals уже выполняется');
      return;
    }
  }

  // ── ПРОП-ЗАЩИТА: автостоп при 3 SL подряд ──────────────────
  if (store.propMode) {
    // Дневной SL-стоп: 3 SL за день → стоп до 00:00 UTC
    const today = new Date().toISOString().split('T')[0];
    if (global.dailyPnlTracker?.date === today && (global.dailyPnlTracker.slCount || 0) >= 3) {
      console.log(`[PROP DAY-STOP] ${global.dailyPnlTracker.slCount} SL за сегодня — стоп до 00:00 UTC`);
      return;
    }

    const recentTrades = store.tradeHistory.slice(-3);
    if (recentTrades.length >= 3 && recentTrades.every(t => t.outcome === 'sl')) {
      const lastSL = recentTrades[recentTrades.length-1].closedAt || 0;
      const pauseMs = 4 * 60 * 60 * 1000; // 4 часа
      if (Date.now() - lastSL < pauseMs) {
        const left = Math.round((pauseMs - (Date.now() - lastSL)) / 60000);
        console.log(`[PROP STOP] 3 SL подряд — пауза ещё ${left} мин`);
        return;
      }
    }
  }

  isRunning = true;
  isRunningStartedAt = Date.now();
  try {
    console.log(`[${getAlmatyTime()}] checkSignals запущен`);
  lastCheckTime = Date.now();
  totalChecks++;

    const candidates   = await getOKXCandidates();
    if (!candidates.length) { console.log('Нет кандидатов'); isRunning = false; return; }

    const fng          = await getFearAndGreed();
    const dvol         = await getDVOL(); // Deribit Volatility Index

    // Weekly POC и GEX загружаем параллельно для всех монет пакетом
    // (кэшируются на 1 час — не нагружают API)
    const session      = getCurrentSession();
    const asianSession = isAsianSession();
    const macroEvent   = await checkMacroEvents();
    const etfFlow      = await getBTCETFFlow();
    const btcDom       = await getBTCDominance();
    const cbPremium    = await getCoinbasePremium();
    if (macroEvent) {
      console.log(`[MACRO] Важное событие сегодня: ${macroEvent.events}`);
    }

    for (const coin of candidates) {
      if (isCoinOnCooldown(coin.instId)) continue;

      // ── ПРОВЕРКА ТИПА АКТИВА ─────────────────────────────────
      const asset = getAssetClass(coin.instId);
      if (!isMarketOpenForAsset(asset)) {
        console.log(`[ASSET] ${coin.instId} — рынок закрыт (${asset.name || asset.class})`);
        continue;
      }

// Блокируем если монета уже в открытых сделках
const alreadyOpen = store.openTrades.some(t => t.instId === coin.instId);
if (alreadyOpen) {
  console.log(`[SKIP] ${coin.instId} уже в открытой сделке`);
  continue;
}

// Correlation check — не открываем 2 позиции в одном секторе
if (!store.observeMode) {
  // Сначала чистим устаревшие сделки (старше 12 часов) — AutoExec мог закрыть на Bybit
  const twelveHrsAgo = Date.now() - 12 * 60 * 60 * 1000;
  store.openTrades = store.openTrades.filter(t => (t.ts || 0) > twelveHrsAgo);

  const corr = checkCorrelation(coin.instId);
  if (!corr.ok && corr.reason) {
    console.log(`[CORR] ${coin.instId} пропущен: ${corr.reason}`);
    continue;
  }

  // Liquidity filter — проскальзывание убивает edge на малых монетах
  // Используем реальное плечо AutoExec (5x) а не store.leverage (10x)
  const autoLeverage = parseInt(process.env.AUTO_DEFAULT_LEVERAGE) || 5;
  const estPositionUsd = store.accountBalance * store.riskPct / 100 / 0.015 * autoLeverage;
  const liq = checkLiquidity(coin, estPositionUsd);
  if (!liq.ok) {
    console.log(`[LIQ] ${coin.instId} пропущен: ${liq.reason}`);
    continue;
  }
}

      let signals = await runStrategies(coin.instId, coin, asianSession);
      if (!signals.length) {
        if (Math.random() < 0.05) console.log(`[NO RAW SIGNALS] ${coin.instId}`);
        continue;
      }
      // Убедимся что все сигналы имеют instId
      for (const sig of signals) {
        if (!sig.instId) sig.instId = coin.instId;
      }
      if (signals.length) console.log(`[RAW SIGNALS] ${coin.instId}: ${signals.length} (${signals.map(s=>s.strategy.split(' ')[0]).join(',')})`);

      // ── Корректировка SL/TP под тип актива ────────────────────
      if (asset.slPct && asset.class !== 'crypto') {
        for (const sig of signals) {
          const price = parseFloat(sig.price);
          const sl    = asset.slPct / 100;
          const tp    = sl * (asset.tpMult || 2);
          sig.sl  = sig.direction === 'long'
            ? (price * (1 - sl)).toFixed(6)
            : (price * (1 + sl)).toFixed(6);
          sig.tp1 = sig.direction === 'long'
            ? (price * (1 + tp)).toFixed(6)
            : (price * (1 - tp)).toFixed(6);
          sig.tp2 = sig.direction === 'long'
            ? (price * (1 + tp * 1.5)).toFixed(6)
            : (price * (1 - tp * 1.5)).toFixed(6);
          sig.assetNote = `📦 ${asset.name}: SL=${asset.slPct}% (адаптирован)`;
        }
      }

      // ── АВТОРОТАЦИЯ СТРАТЕГИЙ ────────────────────────────────
      // В observe mode — все стратегии активны для полного наблюдения
      const regime = await getMarketRegime(coin.instId);
      const adx    = regime?.adx || 0;

      if (!store.observeMode) {
        const allowedStrategies = (() => {
          if (adx > 25) {
            return ['Volume Spike', 'MA20', '4H Range', 'Pullback', 'Funding', 'Liquidity Sweep', 'Elliott', 'Whale Follow', 'Liquidation Hunt'];
          } else if (adx < 18) {
            return ['Volume Spike', 'MA20', 'RSI Диверг', 'Funding', 'Liquidity Sweep', 'Whale Follow', 'Liquidation Hunt'];
          } else {
            return ['Volume Spike', 'MA20', 'RSI Диверг', 'Liquidity Sweep', 'Funding', 'Elliott', 'Whale Follow', 'Liquidation Hunt'];
          }
        })();

        signals = signals.filter(s => {
          const ok = allowedStrategies.some(name => s.strategy.includes(name));
          if (!ok) console.log(`[ROTATION] ${coin.instId} ${s.strategy.split(' ').slice(0,2).join(' ')} — ADX:${adx.toFixed(1)}`);
          return ok;
        });
        if (!signals.length) continue;
      }

      // ── 8 ФИЛЬТРОВ (независимых, без дублирования) ─────────
      const k1h_pipe = await getOKXKlinesCached(coin.instId, '1H', 50);

      const filtered = [];
      for (let sig of signals) {

        // В observe mode — НИКАКИХ жёстких блоков, только мягкие корректировки
        // Цель: собрать максимум сырых данных для анализа
        if (!store.observeMode) {
          const isS1S4 = sig.strategy.startsWith('1️⃣ ') || sig.strategy.startsWith('4️⃣ ');

          // 1. MARKET REGIME
          sig = applyMarketRegime(sig, regime);
          if (sig.confidence === 0) {
            if (isS1S4) sig.confidence = 50; // S1/S4 не блокируем — как в observe
            else { filtered.push(sig); continue; }
          }

          // 2. SESSION
          sig = applySessionFilter(sig, session);
          if (sig.confidence === 0) {
            if (isS1S4) sig.confidence = 45; // S1/S4 не блокируем — как в observe
            else { filtered.push(sig); continue; }
          }
        } else {
          // В observe — только мягкая корректировка confidence (информационно)
          sig = applyMarketRegime(sig, regime);
          // Если жёсткий блок выставил 0 — восстанавливаем минимум 50
          if (sig.confidence === 0) sig.confidence = 50;
          sig = applySessionFilter(sig, session);
          if (sig.confidence === 0) sig.confidence = 45;
        }

        // 3. MULTI-TIMEFRAME — 4H и 15m должны совпадать с 1H
        sig = await applyMultiTimeframe(sig, coin.instId);

        // 4. MACD MOMENTUM — против импульса не входим
        if (k1h_pipe.length >= 35) {
          const macd = calcMACD(k1h_pipe);
          if (sig.direction === 'long' && macd.hist < 0) {
            sig.confidence = Math.max(sig.confidence - 12, 0);
            sig.macdNote   = `📉 MACD медвежий → -12%`;
          } else if (sig.direction === 'short' && macd.hist > 0) {
            sig.confidence = Math.max(sig.confidence - 12, 0);
            sig.macdNote   = `📈 MACD бычий → -12%`;
          } else {
            sig.confidence = Math.min(sig.confidence + 6, 100);
            sig.macdNote   = `✅ MACD подтверждает → +6%`;
          }
        }

        // 5. VOLUME — объём должен подтверждать движение
        sig = applyVolumeProfile(sig, k1h_pipe);

        // 6. VWAP — институциональный уровень
        sig = applyVWAP(sig, k1h_pipe);

        // 7. MACRO — блок перед FOMC/CPI
        sig = applyMacroFilter(sig, macroEvent);

        // 7.5 COT — Commitment of Traders (только для commodities: XAU, XAG, CL, BZ)
        const cotAssets = ['XAU', 'XAG', 'CL', 'BZ'];
        const sigCoin   = (sig.instId || '').replace('-USDT-SWAP','').split('-')[0];
        if (cotAssets.includes(sigCoin)) {
          sig = applyCOTFilter(sig);
        }

        // ══════════════════════════════════════════════════════
        // SIGNAL PIPELINE — structured with adjustment caps
        // ──────────────────────────────────────────────────
        // Level 1: Hard gates (block or pass — no compromise)
        // Level 2: Market context filters (cap: ±15% total)
        // Level 3: Technical confirmation filters (cap: ±15% total)
        // ══════════════════════════════════════════════════════

        let contextAdj   = 0;  // Level 2: macro/market context adjustments
        let technicalAdj = 0;  // Level 3: technical entry confirmation adjustments
        const baseConf   = sig.confidence; // save base confidence

        // ── LEVEL 2: MARKET CONTEXT ───────────────────────────

        // 8. FVG — Fair Value Gap
        try {
          if (fvgZones1h?.length) {
            const price    = parseFloat(sig.price);
            const inFVG1h  = fvgZones1h.some(z => price >= z.low && price <= z.high);
            const inFVG15m = fvgZones15m?.some(z => price >= z.low && price <= z.high);
            if (inFVG1h || inFVG15m) {
              contextAdj = Math.min(contextAdj + 8, 15);
              sig.fvgNote = `📊 FVG зона → +8%`;
            }
          }
        } catch(_) {}

        // 9. WEEKLY POC
        try {
          const wpoc = await getWeeklyPOC(coin.instId);
          if (wpoc?.poc) {
            const price   = parseFloat(sig.price);
            const distPct = Math.abs(wpoc.poc - price) / price * 100;
            if (distPct < 1.0) {
              contextAdj = Math.min(contextAdj + 10, 15);
              sig.pocNote = `🎯 Weekly POC: $${wpoc.poc.toFixed(3)} (${distPct.toFixed(1)}% away) → +10%`;
            } else if (distPct < 2.5) {
              contextAdj = Math.min(contextAdj + 6, 15);
              sig.pocNote = `🎯 Weekly POC: $${wpoc.poc.toFixed(3)} (${distPct.toFixed(1)}% away) → +6%`;
            }
          }
        } catch(_) {}

        // Monthly POC
        try {
          const mpoc = await getMonthlyPOC(coin.instId);
          if (mpoc?.poc && !sig.mpocNote) {
            const price   = parseFloat(sig.price);
            const distPct = Math.abs(mpoc.poc - price) / price * 100;
            if (distPct < 0.5) {
              contextAdj = Math.min(contextAdj + 15, 15);
              sig.mpocNote = `🎯🎯 Monthly POC: $${mpoc.poc.toFixed(3)} (${distPct.toFixed(1)}% away) → +15%`;
            } else if (distPct < 1.5) {
              contextAdj = Math.min(contextAdj + 6, 15);
              sig.mpocNote = `🎯 Monthly POC: $${mpoc.poc.toFixed(3)} → +6%`;
            }
          }
        } catch(_) {}

        // GEX regime for ALL coins (BTC GEX = global market regime)
        try {
          const btcGex = await getGEXLevels('BTC');
          if (btcGex) {
            // BTC GEX negative = volatile regime = more risky for all coins
            if (btcGex.regime === 'NEGATIVE') {
              contextAdj = Math.max(contextAdj - 5, -15);
              sig.gexNote = `⚡ BTC GEX Negative (volatile market) → -5%`;
            }
            // For BTC/ETH: more detailed GEX analysis
            const coinName = coin.instId.replace('-USDT-SWAP','');
            if (['BTC','ETH'].includes(coinName)) {
              const coinGex = coinName === 'BTC' ? btcGex : await getGEXLevels('ETH');
              if (coinGex?.flipLevel) {
                const price = parseFloat(sig.price);
                const distToFlip = Math.abs(coinGex.flipLevel - price) / price * 100;
                if (distToFlip < 1.5) {
                  contextAdj = Math.max(contextAdj - 8, -15);
                  sig.gexNote = `⚡ GEX Flip Level $${coinGex.flipLevel.toLocaleString()} близко → -8%`;
                }
              }
              if (coinGex?.levels?.length) {
                const price   = parseFloat(sig.price);
                const nearest = coinGex.levels.reduce((b,l) =>
                  Math.abs(l.strike-price) < Math.abs(b.strike-price) ? l : b
                );
                const distPct = Math.abs(nearest.strike-price)/price*100;
                if (distPct < 2) {
                  if (nearest.netGEX > 0 && sig.direction === 'long') {
                    contextAdj = Math.min(contextAdj + 8, 15);
                    sig.gexNote = `⚡ GEX Support $${nearest.strike.toLocaleString()} → +8%`;
                  } else if (nearest.netGEX < 0 && sig.direction === 'short') {
                    contextAdj = Math.min(contextAdj + 8, 15);
                    sig.gexNote = `⚡ GEX Resistance $${nearest.strike.toLocaleString()} → +8%`;
                  }
                }
              }
              // Options Unusual Activity (BTC/ETH only)
              try {
                const optFlow = await getOptionsUnusualActivity(coinName);
                if (optFlow?.signal !== 'neutral') {
                  const aligned = (optFlow.signal==='bullish'&&sig.direction==='long') ||
                                  (optFlow.signal==='bearish'&&sig.direction==='short');
                  contextAdj = aligned
                    ? Math.min(contextAdj + 6, 15)
                    : Math.max(contextAdj - 8, -15);
                  sig.gexNote = (sig.gexNote||'') + ` 🦁 Options ${optFlow.signal}${aligned?' → +6%':' → -8%'}`;
                }
              } catch(_) {}
            }
          }
        } catch(_) {}

        // Funding Rate (all coins)
        try {
          const funding    = coinData.fundingRate || 0;
          const fundingAbs = Math.abs(funding);
          if (fundingAbs > 0.02) {
            const fundingBullish = funding < 0;
            const aligned = (fundingBullish && sig.direction==='long') ||
                            (!fundingBullish && sig.direction==='short');
            if (fundingAbs > 0.05) {
              contextAdj = aligned
                ? Math.min(contextAdj + 8, 15)
                : Math.max(contextAdj - 10, -15);
              sig.fundingNote = `💸 Funding ${(funding*100).toFixed(3)}% extreme${aligned?' aligned → +8%':' against → -10%'}`;
            } else {
              if (!aligned) {
                contextAdj = Math.max(contextAdj - 5, -15);
                sig.fundingNote = `⚠️ Funding ${(funding*100).toFixed(3)}% against → -5%`;
              }
            }
          }
        } catch(_) {}

        // Apply context cap ±15%
        contextAdj = Math.max(-15, Math.min(15, contextAdj));
        sig.confidence = Math.max(0, Math.min(100, baseConf + contextAdj));

        // ── LEVEL 3: TECHNICAL CONFIRMATION ───────────────────

        // Absorption filter (S1 only)
        try {
          if (sig.strategy.includes('Volume Spike')) {
            const k15 = await getOKXKlinesCached(coin.instId, '15m', 10);
            if (k15.length >= 6) {
              const recent  = k15.slice(-6, -1);
              const avgVol  = recent.reduce((s,k) => s + (k.quoteVolume||0), 0) / recent.length;
              const absorptionCandles = recent.filter(k => {
                const vol  = k.quoteVolume || 0;
                const move = Math.abs(k.close - k.open) / k.open * 100;
                return vol > avgVol * 1.5 && move < 0.3;
              });
              if (absorptionCandles.length >= 1) {
                technicalAdj = Math.min(technicalAdj + 10, 15);
                sig.absNote  = `📦 Absorption (${absorptionCandles.length} свечи) → +10%`;
              }
            }
          }
        } catch(_) {}

        // OI Change (all coins)
        try {
          const ccy = coin.instId.replace('-USDT-SWAP','');
          if (store.oiCache[ccy]?.oi5m?.length >= 2) {
            const oiArr    = store.oiCache[ccy].oi5m;
            const oiChange = (oiArr[oiArr.length-1] - oiArr[0]) / Math.abs(oiArr[0]) * 100;
            const expectedUp = sig.direction === 'long';
            if (oiChange > 1.5 && expectedUp) {
              technicalAdj = Math.min(technicalAdj + 6, 15);
              sig.oiNote   = `📊 OI+${oiChange.toFixed(1)}% (new longs) → +6%`;
            } else if (oiChange < -1.5 && expectedUp) {
              technicalAdj = Math.max(technicalAdj - 5, -15);
              sig.oiNote   = `⚠️ OI${oiChange.toFixed(1)}% (short squeeze only) → -5%`;
            }
          }
        } catch(_) {}

        // Order Book Imbalance (all coins)
        try {
          const ob = await getOrderBookImbalance(coin.instId);
          if (ob?.signal !== 'neutral') {
            const aligned = (ob.signal==='bullish'&&sig.direction==='long') ||
                            (ob.signal==='bearish'&&sig.direction==='short');
            if (aligned && Math.abs(ob.imbalance) > 0.25) {
              technicalAdj = Math.min(technicalAdj + 7, 15);
              sig.obNote   = `📖 OrderBook ${ob.bidPct}%bid/${ob.askPct}%ask → +7%`;
            } else if (!aligned && Math.abs(ob.imbalance) > 0.3) {
              technicalAdj = Math.max(technicalAdj - 7, -15);
              sig.obNote   = `⚠️ OrderBook against ${ob.bidPct}%bid/${ob.askPct}%ask → -7%`;
            }
          }
        } catch(_) {}

        // Footprint (all coins that have data)
        try {
          if (footprint?.isReady()) {
            footprint.addCoin(coin.instId);
            const fp = footprint.getFootprint(coin.instId);
            if (fp && fp.tradesCount >= 20) {
              if (sig.direction === 'long' && fp.imbalanceBullish) {
                technicalAdj = Math.min(technicalAdj + 10, 15);
                sig.footprintNote = `🦶 FP: ${fp.bullishImbalances.length} bullish zones → +10%`;
              } else if (sig.direction === 'short' && fp.imbalanceBearish) {
                technicalAdj = Math.min(technicalAdj + 10, 15);
                sig.footprintNote = `🦶 FP: ${fp.bearishImbalances.length} bearish zones → +10%`;
              }
              if (sig.direction === 'long' && fp.hiddenSelling) {
                technicalAdj = Math.max(technicalAdj - 10, -15);
                sig.footprintNote = `⚠️ FP: hidden selling → -10%`;
              } else if (sig.direction === 'short' && fp.hiddenBuying) {
                technicalAdj = Math.max(technicalAdj - 10, -15);
                sig.footprintNote = `⚠️ FP: hidden buying → -10%`;
              }
              const fpDiv = footprint.getFootprintDivergence(coin.instId);
              if (fpDiv) {
                const aligned = (fpDiv.type==='bullish'&&sig.direction==='long') ||
                                (fpDiv.type==='bearish'&&sig.direction==='short');
                if (aligned) {
                  technicalAdj = Math.min(technicalAdj + 8, 15);
                  sig.footprintNote = (sig.footprintNote||'') + ` 🔄 Delta Div → +8%`;
                }
              }
            }
          }
        } catch(_) {}

        // Delta Tracker
        try {
          if (typeof getDeltaSignal === 'function') {
            const delta = getDeltaSignal(coin.instId);
            if (delta) {
              const aligned = (delta === 'bullish' && sig.direction === 'long') ||
                              (delta === 'bearish' && sig.direction === 'short');
              if (aligned) {
                technicalAdj = Math.min(technicalAdj + 8, 15);
                sig.deltaNote = `🔵 Delta ${delta} → +8%`;
              } else {
                technicalAdj = Math.max(technicalAdj - 8, -15);
                sig.deltaNote = `⚠️ Delta ${delta} against → -8%`;
              }
            }
          }
        } catch(_) {}

        // Apply technical cap ±15%
        technicalAdj = Math.max(-15, Math.min(15, technicalAdj));
        sig.confidence = Math.max(0, Math.min(100,
          baseConf + contextAdj + technicalAdj
        ));

        // Log total adjustment for debugging
        const totalAdj = contextAdj + technicalAdj;
        if (Math.abs(totalAdj) > 5) {
          console.log(`[PIPELINE] ${coin.instId} ${sig.strategy.slice(0,10)}: base=${baseConf}% ctx=${contextAdj>0?'+':''}${contextAdj} tech=${technicalAdj>0?'+':''}${technicalAdj} final=${sig.confidence}%`);
        }

        filtered.push(sig);
      }

      // ── КАЛИБРОВКА CONFIDENCE ─────────────────────────────────
      for (let i = 0; i < filtered.length; i++) {
        filtered[i] = applyRealWRCalibration(filtered[i]);
      }

      const fngValue = fng?.value || 50;

      const best = filtered
        .filter(s => {
          // Обязательно должен быть instId
          if (!s.instId) { s.instId = coin.instId; }
          // В режиме наблюдения — порог ниже чтобы видеть больше сигналов
          // S1=70% в live (WR 73% на 52 сд), S10=65%, остальные=65%
          const isS1live  = s.strategy.startsWith('1️⃣ ');
          const threshold = store.observeMode ? 50 : isS1live ? 70 : 65;
          return s.confidence >= threshold;
        })
        .sort((a, b) => {
          // В проп-режиме — S1 и S4 приоритет над остальными
          if (store.propMode && !store.observeMode) {
            const aIsProp = a.strategy.startsWith('1️⃣ ') || a.strategy.startsWith('4️⃣ ');
            const bIsProp = b.strategy.startsWith('1️⃣ ') || b.strategy.startsWith('4️⃣ ');
            if (aIsProp && !bIsProp) return -1;
            if (!aIsProp && bIsProp) return 1;
          }
          return b.confidence - a.confidence;
        })[0];

      if (!best) continue;

      const news = await checkNews(coin.symbol);
      // S1 Volume Spike — сам является реакцией на новость, блокировать не нужно
      const isS1best = best.strategy.startsWith('1️⃣ ');
      if (news.blocked && !isS1best) { console.log(`[NEWS BLOCK] ${coin.instId}`); continue; }
      if (news.note) best.newsNote = news.note;

      best.ts      = Date.now();
      best.fng     = fng;
      best.session = session;

      // ── Оценка slippage (аудит: скрытые потери) ─────────
      // Реальная цена входа хуже сигнальной на 0.05-0.3%
      // Логируем для анализа (не корректируем — биржа делает сама)
      const estSlippage = best.price * 0.001; // ~0.1% оценочный slippage
      console.log(`[SLIP] ${best.instId}: est. slippage ±$${estSlippage.toFixed(4)}`);

      // Проверка портфельного риска ПЕРЕД AI валидацией
      // В observe mode пропускаем portfolio check
      if (!store.observeMode) {
        const portfolioCheck = checkPortfolioRisk(best);
        if (!portfolioCheck.allowed) {
          console.log(`[PORTFOLIO BLOCK] ${coin.instId} — ${portfolioCheck.reason}`);
          continue;
        }
      }

      // В observe mode пропускаем AI валидацию — собираем сырые данные
      // S1 и S4 тоже пропускаем — они доказали WR 85% без AI фильтра
      const isS1orS4 = best.strategy.startsWith('1️⃣ ') || best.strategy.startsWith('4️⃣ ');
      if (!store.observeMode && !isS1orS4) {
        const aiResult = await validateSignalWithAI(best, fng, session);
        if (!aiResult.approved) {
          console.log(`[AI REJECT] ${coin.instId} → ${aiResult.reason}`);
          continue;
        }
        best.confidence = aiResult.confidence;
        best.aiNote     = `🤖 AI: ${aiResult.reason}`;
      }

      // ── ФИНАЛЬНАЯ ПРОВЕРКА БЕЗОПАСНОСТИ ─────────────────────
      // В observe — только логика направления, без блоков по %
      const entry = best.price;
      const sl    = parseFloat(best.sl);
      const tp1   = parseFloat(best.tp1);
      const slPct = Math.abs((sl - entry) / entry * 100);
      const tp1Pct = Math.abs((tp1 - entry) / entry * 100);

      if (!store.observeMode) {
        if (slPct > 1.51) {
          console.log(`[SAFETY] ${coin.instId} BLOCK — SL ${slPct.toFixed(2)}% > 1.5%`);
          continue;
        }
        if (slPct < 0.4) {
          console.log(`[SAFETY] ${coin.instId} BLOCK — SL ${slPct.toFixed(2)}% < 0.4%`);
          continue;
        }
        if (tp1Pct / slPct < 1.8) {
          console.log(`[SAFETY] ${coin.instId} BLOCK — RR ${(tp1Pct/slPct).toFixed(2)} < 1.8`);
          continue;
        }
      }
      // Логика направления — критично всегда
      if (best.direction === 'long' && (sl >= entry || tp1 <= entry)) {
        console.log(`[SAFETY] ${coin.instId} BLOCK — LONG битая логика`);
        continue;
      }
      if (best.direction === 'short' && (sl <= entry || tp1 >= entry)) {
        console.log(`[SAFETY] ${coin.instId} BLOCK — SHORT битая логика`);
        continue;
      }
      console.log(`[SIGNAL OK] ${coin.instId} ${best.direction} conf=${best.confidence} → отправка`);

      // 5. ОБЪЁМ — главный фильтр против фейковых сигналов
      // В observe mode отключён для сбора всех данных
      if (!store.observeMode) {
        try {
          const k1h_vol = await getOKXKlinesCached(coin.instId, '1H', 25);
          if (k1h_vol.length >= 24) {
            const avgVol = k1h_vol.slice(-24, -1).reduce((s,c) => s + (c.quoteVolume||0), 0) / 23;
            const lastVol = k1h_vol[k1h_vol.length - 1].quoteVolume || 0;
            if (avgVol > 0 && lastVol < avgVol * 0.7) {
              console.log(`[SAFETY] ${coin.instId} BLOCK — объём ${(lastVol/avgVol).toFixed(2)}x от avg (нужно ≥0.7)`);
              continue;
            }
          }
        } catch(e) { /* если нет данных, пропускаем проверку */ }
      }

      setCoinCooldown(coin.instId);
      logSignal(best);
      updateBestSignalOfDay(best); // обновляем лучший сигнал дня

      // ── Snapshot всех фильтров для feature importance анализа ──
      best.filters = {
        fng:           store.fngCache?.value      ?? null,
        fngLabel:      store.fngCache?.label      ?? null,
        dvol:          dvolCache?.btc             ?? null,
        regime:        regimeDetector?.get()?.mode     ?? null,
        adx:           regimeDetector?.get()?.adx      ?? null,
        trendDir:      regimeDetector?.get()?.trendDir ?? null,
        session:       getCurrentSession()        ?? null,
        btcTrend: (() => {
          const b = store.btcPrice; const p = store.btcPrice24h;
          if (!b || !p) return null;
          const ch = (b - p) / p * 100;
          return ch > 1 ? 'up' : ch < -1 ? 'down' : 'flat';
        })(),
        cotSignal:     cotCache?.data?.[(best.instId||'').replace('-USDT-SWAP','')]?.signal ?? null,
        hasGex:        !!(best.gexNote && !best.gexNote.includes('нет')),
        hasDelta:      !!(best.deltaNote && best.deltaNote.includes('+')),
        hasFootprint:  !!(best.footprintNote && !best.footprintNote.includes('⚠️')),
        hasAbsorption: !!(best.absNote),
        hasPoc:        !!(best.pocNote),
        hasMtf:        !!(best.mtfNote && !best.mtfNote.includes('против')),
        hasVwap:       !!(best.vwapNote),
        regimeNote:    best.regimeNote    || null,
        gexNote:       best.gexNote       || null,
        deltaNote:     best.deltaNote     || null,
        footprintNote: best.footprintNote || null,
        cotNote:       best.cotNote       || null,
      };

      if (store.observeMode || best.paperOnly) {
        savePaperTrade(best);

        if (store.observeMode) {
          await sendTelegram(buildSignalAlert(best));
          // Канал — только в 16:00 через cron (лучший сигнал дня)
        } else if (best.paperOnly) {
          console.log(`[PAPER ONLY] ${best.instId} ${best.strategy} conf=${best.confidence}%`);
        }
      } else {
        saveOpenTrade(best);

        // AutoExec emit — ПЕРВЫМ, до Telegram (экономим 1-2 сек)
        if (autoExecSignals) {
          try {
            const sym = (best.instId||'').replace('-USDT-SWAP','USDT').replace(/-/g,'');
            const ep  = parseFloat(best.price);
            const slp = Math.abs((parseFloat(best.sl) - ep) / ep * 100);
            const tpp = Math.abs((parseFloat(best.tp1) - ep) / ep * 100);
            autoExecSignals.emit('trade_signal', {
              symbol:     sym,
              side:       best.direction === 'long' ? 'Buy' : 'Sell',
              confidence: best.confidence,
              sl_pct:     +slp.toFixed(3),
              tp_pct:     +tpp.toFixed(3),
              sl_price:   best.sl,
              tp_price:   best.tp1,
              reason:     best.strategy,
              source:     'apex-algo-fund',
            });
            console.log(`[AutoExec] Сигнал отправлен: ${sym} ${best.direction} conf=${best.confidence}%`);
          } catch(e) { console.error('[AutoExec] emit error:', e.message); }
        }

        // Telegram — параллельно с emit (не ждём)
        sendTelegram(buildSignalAlert(best)).catch(e => console.error('[TG] signal alert error:', e.message));
        // Канал — только в 16:00 через cron (лучший сигнал дня)
      }
    }
  } finally {
    isRunning = false;
  }
}

// ============================================================
//  PAPER TRADING — виртуальные сделки для сбора статистики
// ============================================================
const PAPER_FILE = './paper_trades.json';

// Загрузка из Supabase при старте
async function loadPaperTrades() {
  try {
    // Сначала пробуем Supabase
    const { data, error } = await supabase
      .from('paper_trades')
      .select('*')
      .is('outcome', null) // только открытые
      .order('ts', { ascending: false })
      .limit(200);

    if (!error && data?.length) {
      global.paperTrades = data.map(r => ({
        ts:         r.ts,
        instId:     r.inst_id,
        strategy:   r.strategy,
        direction:  r.direction,
        price:      parseFloat(r.price),
        sl:         parseFloat(r.sl),
        tp1:        parseFloat(r.tp1),
        tp2:        parseFloat(r.tp2),
        confidence: r.confidence,
        outcome:    r.outcome,
        closePrice: r.close_price ? parseFloat(r.close_price) : null,
        closedAt:   r.closed_at,
        pnl:        r.pnl ? parseFloat(r.pnl) : null,
        _id:        r.id,
      }));
      console.log(`[PAPER] Загружено ${global.paperTrades.length} открытых сделок из Supabase`);
    } else {
      global.paperTrades = [];
      console.log('[PAPER] Supabase: нет открытых сделок');
    }
  } catch(e) {
    console.error('[PAPER] loadPaperTrades error:', e.message);
    global.paperTrades = [];
  }
}

// Сохраняем новую paper сделку в Supabase
async function savePaperTradeToSupabase(sig) {
  try {
    const { data, error } = await supabase.from('paper_trades').insert({
      ts:         sig.ts || Date.now(),
      inst_id:    sig.instId,
      strategy:   sig.strategy,
      direction:  sig.direction,
      price:      sig.price,
      sl:         parseFloat(sig.sl),
      tp1:        parseFloat(sig.tp1),
      tp2:        parseFloat(sig.tp2),
      confidence: sig.confidence,
      outcome:    null,
      filters:    sig.filters ? JSON.parse(JSON.stringify(sig.filters)) : null,
    }).select().single();
    if (!error && data) return data.id;
  } catch(e) {
    console.error('[PAPER] savePaperTradeToSupabase error:', e.message);
  }
  return null;
}

// Закрываем paper сделку в Supabase
async function closePaperTradeInSupabase(trade) {
  if (!trade._id) return;
  try {
    await supabase.from('paper_trades').update({
      outcome:     trade.outcome,
      close_price: trade.closePrice,
      closed_at:   trade.closedAt,
      pnl:         trade.pnl,
    }).eq('id', trade._id);
  } catch(e) {
    console.error('[PAPER] closePaperTradeInSupabase error:', e.message);
  }
}

// Загружаем при старте
loadPaperTrades().catch(e => console.error('[PAPER] init error:', e.message));

function savePaperTrade(sig) {
  if (!global.paperTrades) global.paperTrades = [];
  const trade = {
    ts:         Date.now(),
    instId:     sig.instId,
    strategy:   sig.strategy,
    direction:  sig.direction,
    price:      sig.price,
    sl:         parseFloat(sig.sl),
    tp1:        parseFloat(sig.tp1),
    tp2:        parseFloat(sig.tp2),
    confidence: sig.confidence,
    outcome:    null,
    closedAt:   null,
    closePrice: null,
    pnl:        null,
    filters:    sig.filters || null,
    _id:        null,
  };
  global.paperTrades.push(trade);
  if (global.paperTrades.length > 500) {
    global.paperTrades = global.paperTrades.slice(-500);
  }
  // Сохраняем в Supabase async
  savePaperTradeToSupabase(trade).then(id => {
    if (id) trade._id = id;
  }).catch(e => console.error('[PAPER] save error:', e.message));
  console.log(`[PAPER] ${sig.instId} ${sig.direction.toUpperCase()} $${sig.price} записана`);
}

async function checkPaperTrades() {
  if (!global.paperTrades || !global.paperTrades.length) return;

  const open = global.paperTrades.filter(t => !t.outcome);
  if (!open.length) return;

  for (const trade of open) {
    try {
      const price = await getCurrentPrice(trade.instId);
      if (!price) continue;

      const ageMin = (Date.now() - trade.ts) / 60000;

      // Проверяем SL
      const slHit = trade.direction === 'long'
        ? price <= trade.sl
        : price >= trade.sl;

      // Проверяем TP1
      const tp1Hit = trade.direction === 'long'
        ? price >= trade.tp1
        : price <= trade.tp1;

      // Проверяем TP2
      const tp2Hit = trade.direction === 'long'
        ? price >= trade.tp2
        : price <= trade.tp2;

      if (tp2Hit) {
        trade.outcome    = 'tp2';
        trade.closePrice = price;
        trade.closedAt   = Date.now();
        const rawPnl2 = trade.direction === 'long'
          ? (price - trade.price) / trade.price * 100
          : (trade.price - price) / trade.price * 100;
        trade.pnl = applySlippage(rawPnl2, trade.instId, trade.direction);
        console.log(`[PAPER TP2] ${trade.instId} +${trade.pnl}% (slip -${(getSlippagePct(trade.instId)*2).toFixed(2)}%)`);

      } else if (tp1Hit) {
        trade.outcome    = 'tp1';
        trade.closePrice = price;
        trade.closedAt   = Date.now();
        const rawPnl1 = trade.direction === 'long'
          ? (price - trade.price) / trade.price * 100
          : (trade.price - price) / trade.price * 100;
        trade.pnl = applySlippage(rawPnl1, trade.instId, trade.direction);
        console.log(`[PAPER TP1] ${trade.instId} +${trade.pnl}% (slip -${(getSlippagePct(trade.instId)*2).toFixed(2)}%)`);

      } else if (slHit) {
        trade.outcome    = 'sl';
        trade.closePrice = price;
        trade.closedAt   = Date.now();
        const rawPnlSL = trade.direction === 'long'
          ? (price - trade.price) / trade.price * 100
          : (trade.price - price) / trade.price * 100;
        trade.pnl = applySlippage(rawPnlSL, trade.instId, trade.direction);
        console.log(`[PAPER SL] ${trade.instId} ${trade.pnl}% (slip -${(getSlippagePct(trade.instId)*2).toFixed(2)}%)`);

      } else if (ageMin > 480) {
        // Таймаут 8 часов
        trade.outcome    = 'expired';
        trade.closePrice = price;
        trade.closedAt   = Date.now();
        const rawPnlExp = trade.direction === 'long'
          ? (price - trade.price) / trade.price * 100
          : (trade.price - price) / trade.price * 100;
        trade.pnl = applySlippage(rawPnlExp, trade.instId, trade.direction);
        console.log(`[PAPER EXPIRED] ${trade.instId} ${trade.pnl}%`);
      }
      // Если сделка закрылась — сохраняем в Supabase
      if (trade.outcome) {
        closePaperTradeInSupabase(trade).catch(e => console.error('[PAPER] close error:', e.message));
      }
    } catch(e) { console.error(`[PAPER] checkPaperTrades error ${trade.instId}:`, e.message); }
  }
}

// ============================================================
//  ВЕРСИОНИРОВАНИЕ СТРАТЕГИЙ
// ============================================================
const STRATEGY_VERSIONS = {
  '1️⃣ Volume Spike (15m)':         { v: '1.0', date: '2026-04-29', changes: 'Initial release' },
  '2️⃣ Liquidity Bounce (1h)':      { v: '1.0', date: '2026-04-26', changes: 'Re-enabled for observe' },
  '3️⃣ Ранний вход (5m)':           { v: '1.0', date: '2026-04-20', changes: 'Initial' },
  '4️⃣ MA20/MA50+RSI (1h)':        { v: '2.0', date: '2026-04-25', changes: 'Added RSI confirmation' },
  '5️⃣ RSI Дивергенция (1h)':      { v: '2.1', date: '2026-04-26', changes: 'Lowered threshold to 80' },
  '6️⃣ Funding Extreme (1h)':      { v: '1.0', date: '2026-04-20', changes: 'Initial' },
  '7️⃣ Поглощение на объёме (15m)':{ v: '1.1', date: '2026-04-26', changes: 'Re-enabled, volume 5x' },
  '8️⃣ Basis Farming (1h)':        { v: '1.0', date: '2026-04-20', changes: 'Initial' },
  '9️⃣ Pullback (15m)':            { v: '2.0', date: '2026-04-25', changes: 'Adaptive ATR SL' },
  '🔟 4H Range Breakout (5m)':     { v: '3.0', date: '2026-04-25', changes: 'Strengthened with 4 filters' },
  '1️⃣1️⃣ Elliott+Fib+SMA':         { v: '1.0', date: '2026-04-26', changes: 'Initial live' },
  '1️⃣2️⃣ Liquidity Sweep (15m)':  { v: '1.0', date: '2026-04-26', changes: 'Initial - smart money setup' },
  '1️⃣3️⃣ Order Block (1H)':       { v: '1.0', date: '2026-04-28', changes: 'Initial - ICT concept' },
};

function getStrategyVersion(name) {
  return STRATEGY_VERSIONS[name] || { v: '?', date: 'unknown', changes: 'no version info' };
}


const LOG_FILE = './bot.log';

function logToFile(level, msg) {
  try {
    const line = `[${new Date().toISOString()}] [${level}] ${msg}\n`;
    fs.appendFileSync(LOG_FILE, line);
    // Ротация: если файл > 10MB — обрезаем до последних 1MB
    const stats = fs.statSync(LOG_FILE);
    if (stats.size > 10 * 1024 * 1024) {
      const data = fs.readFileSync(LOG_FILE, 'utf8');
      fs.writeFileSync(LOG_FILE, data.slice(-1024 * 1024));
    }
  } catch(e) { /* silent */ }
}

// Перехватываем console.error и важные логи
const _origError = console.error;
console.error = function(...args) {
  _origError.apply(console, args);
  logToFile('ERROR', args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '));
};

const _origLog = console.log;
console.log = function(...args) {
  _origLog.apply(console, args);
  const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
  // Логируем только важные события
  if (msg.includes('[SIGNAL OK]') || msg.includes('[BLOCK]') ||
      msg.includes('[REJECT]') || msg.includes('[PAPER]') ||
      msg.includes('[EMERGENCY]') || msg.includes('Initial')) {
    logToFile('INFO', msg);
  }
};


function calcAdvancedMetrics(trades) {
  if (!trades || trades.length < 5) return null;

  const closed = trades.filter(t => t.outcome && t.outcome !== 'expired');
  if (closed.length < 5) return null;

  const wins   = closed.filter(t => t.outcome === 'tp1' || t.outcome === 'tp2');
  const losses = closed.filter(t => t.outcome === 'sl');

  const wr = wins.length / closed.length;

  // Gross Profit / Loss
  const grossProfit = wins.reduce((s, t)   => s + Math.abs(t.pnl || 0), 0);
  const grossLoss   = losses.reduce((s, t) => s + Math.abs(t.pnl || 0), 0);

  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit;

  // Expectancy = WR × avgWin - (1-WR) × avgLoss
  const avgWin  = wins.length ? grossProfit / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;
  const expectancy = wr * avgWin - (1 - wr) * avgLoss;

  // Max Drawdown — максимальная просадка от пика
  let peak = 0, equity = 0, maxDD = 0;
  for (const t of closed) {
    equity += (t.pnl || 0);
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDD) maxDD = dd;
  }

  const returns = closed.map(t => t.pnl || 0);
  const meanRet = returns.reduce((a, b) => a + b, 0) / returns.length;

  // Sharpe Ratio
  const variance = returns.reduce((s, r) => s + Math.pow(r - meanRet, 2), 0) / returns.length;
  const stdDev   = Math.sqrt(variance);
  const sharpe   = stdDev > 0 ? (meanRet / stdDev) * Math.sqrt(360) : 0;

  // Sortino Ratio — только downside deviation (только убыточные сделки)
  const negReturns    = returns.filter(r => r < 0);
  const downsideVar   = negReturns.length
    ? negReturns.reduce((s, r) => s + r * r, 0) / returns.length
    : 0;
  const downsideDev   = Math.sqrt(downsideVar);
  const sortino       = downsideDev > 0 ? (meanRet / downsideDev) * Math.sqrt(360) : 0;

  // Recovery Factor
  const totalPnl = closed.reduce((s, t) => s + (t.pnl || 0), 0);
  const recoveryFactor = maxDD > 0 ? totalPnl / maxDD : totalPnl;

  // Анализ проигранных сделок
  const lossByStrategy = {};
  for (const t of losses) {
    const key = (t.strategy || '?').split(' ').slice(0,2).join(' ');
    if (!lossByStrategy[key]) lossByStrategy[key] = { count: 0, totalLoss: 0 };
    lossByStrategy[key].count++;
    lossByStrategy[key].totalLoss += Math.abs(t.pnl || 0);
  }

  return {
    total:          closed.length,
    wr:             parseFloat((wr * 100).toFixed(1)),
    avgWin:         parseFloat(avgWin.toFixed(2)),
    avgLoss:        parseFloat(avgLoss.toFixed(2)),
    profitFactor:   parseFloat(profitFactor.toFixed(2)),
    expectancy:     parseFloat(expectancy.toFixed(3)),
    maxDD:          parseFloat(maxDD.toFixed(2)),
    sharpe:         parseFloat(sharpe.toFixed(2)),
    sortino:        parseFloat(sortino.toFixed(2)),
    recoveryFactor: parseFloat(recoveryFactor.toFixed(2)),
    totalPnl:       parseFloat(totalPnl.toFixed(2)),
    lossByStrategy,
  };
}

// ============================================================
//  BTC БЕНЧМАРК — сравнение с buy&hold
// ============================================================
async function getBTCBenchmark(daysSince = 7) {
  try {
    const limit  = Math.min(daysSince * 6, 200); // 4H свечей
    const btc4h  = await getOKXKlinesCached('BTC-USDT-SWAP', '4H', limit);
    if (btc4h.length < 2) return null;
    const start  = btc4h[0].open;
    const end    = btc4h[btc4h.length - 1].close;
    const change = (end - start) / start * 100;
    return { change: parseFloat(change.toFixed(2)), start, end };
  } catch(e) { return null; }
}

// ============================================================
//  КОРРЕЛЯЦИОННЫЙ КОНТРОЛЬ
// ============================================================
// checkCorrelation is defined at the top of the file (unified version)

// ============================================================
//  ЕЖЕНЕДЕЛЬНЫЙ P&L ОТЧЁТ В $$$
// ============================================================
async function weeklyPnLReport() {
  try {
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const real    = store.tradeHistory.filter(t => (t.closedAt || t.ts) >= weekAgo && t.outcome);
    const paper   = (global.paperTrades || []).filter(t => t.ts >= weekAgo && t.outcome);

    const balance = store.accountBalance;
    const riskPct = store.riskPct;

    // Real P&L в $$$
    const realPnlPct = real.reduce((s, t) => s + (t.pnl || 0), 0);
    const realPnlUSD = parseFloat((balance * realPnlPct / 100).toFixed(2));

    // Paper P&L в $$$
    const paperPnlPct = paper.reduce((s, t) => s + (t.pnl || 0), 0);
    const paperPnlUSD = parseFloat((balance * paperPnlPct / 100).toFixed(2));

    // BTC benchmark
    const btcBench = await getBTCBenchmark(7);
    const btcUSD   = btcBench ? parseFloat((balance * btcBench.change / 100).toFixed(2)) : null;

    // Метрики
    const m = calcAdvancedMetrics([...real, ...paper]);

    // Анализ проигранных
    let lossAnalysis = '';
    if (m?.lossByStrategy) {
      const topLosers = Object.entries(m.lossByStrategy)
        .sort((a, b) => b[1].totalLoss - a[1].totalLoss)
        .slice(0, 3);
      if (topLosers.length) {
        lossAnalysis = `\n❌ Топ убыточных стратегий:\n` +
          topLosers.map(([k, v]) =>
            `  ${k}: ${v.count} SL, -${v.totalLoss.toFixed(1)}%`
          ).join('\n');
      }
    }

    const weekStart = new Date(weekAgo).toLocaleDateString('ru-RU', { day:'2-digit', month:'2-digit' });
    const weekEnd   = new Date().toLocaleDateString('ru-RU', { day:'2-digit', month:'2-digit' });

    let msg = `💼 ЕЖЕНЕДЕЛЬНЫЙ ОТЧЁТ\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `📅 ${weekStart} — ${weekEnd}\n`;
    msg += `💰 Баланс: $${balance.toLocaleString()}\n\n`;

    if (real.length) {
      const icon = realPnlUSD >= 0 ? '✅' : '❌';
      msg += `${icon} РЕАЛЬНЫЕ СДЕЛКИ:\n`;
      msg += `  ${real.length} сделок | ${realPnlPct >= 0 ? '+' : ''}${realPnlPct.toFixed(2)}%\n`;
      msg += `  ${realPnlUSD >= 0 ? '+' : ''}$${realPnlUSD} за неделю\n\n`;
    }

    if (paper.length) {
      const icon = paperPnlUSD >= 0 ? '📄' : '📄';
      msg += `${icon} PAPER TRADING:\n`;
      msg += `  ${paper.length} сделок | ${paperPnlPct >= 0 ? '+' : ''}${paperPnlPct.toFixed(2)}%\n`;
      msg += `  ≈ ${paperPnlUSD >= 0 ? '+' : ''}$${paperPnlUSD} (виртуально)\n\n`;
    }

    if (btcBench) {
      const vsBot   = realPnlPct - btcBench.change;
      const vsBotUSD = parseFloat((balance * vsBot / 100).toFixed(2));
      const icon    = vsBot >= 0 ? '✅' : '❌';
      msg += `📊 БЕНЧМАРК BTC Buy&Hold:\n`;
      msg += `  BTC: ${btcBench.change >= 0 ? '+' : ''}${btcBench.change}% (${btcUSD >= 0 ? '+' : ''}$${btcUSD})\n`;
      msg += `  ${icon} Бот vs BTC: ${vsBot >= 0 ? '+' : ''}${vsBot.toFixed(2)}% (${vsBotUSD >= 0 ? '+' : ''}$${vsBotUSD})\n\n`;
    }

    if (m) {
      msg += `📈 МЕТРИКИ:\n`;
      msg += `  Profit Factor: ${m.profitFactor}\n`;
      msg += `  Sharpe: ${m.sharpe} | Sortino: ${m.sortino}\n`;
      msg += `  Expectancy: ${m.expectancy}%\n`;
      msg += `  Max DD: -${m.maxDD}%\n`;
    }

    msg += lossAnalysis;
    msg += `\n━━━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `/metrics — детальные метрики`;

    await sendTelegram(msg);
  } catch(e) {
    console.error('weeklyPnLReport error:', e.message);
  }
}
function checkWeeklyDrawdown() {
  const now = Date.now();
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
  const recent = store.tradeHistory.filter(t => (t.closedAt || t.ts) >= weekAgo);
  const totalLoss = recent.reduce((s, t) => s + (t.pnl < 0 ? Math.abs(t.pnl) : 0), 0);
  return {
    weekLoss:   parseFloat(totalLoss.toFixed(2)),
    isOverLimit: totalLoss >= 8.0, // 8% за неделю = стоп
  };
}

// ============================================================
//  HEARTBEAT — мониторинг живости бота
// ============================================================
async function heartbeat() {
  try {
    if (!global.heartbeatLog) global.heartbeatLog = { last: Date.now(), checks: 0 };
    global.heartbeatLog.last = Date.now();
    global.heartbeatLog.checks++;

    // Лог каждые 12 проверок (час)
    if (global.heartbeatLog.checks % 12 === 0) {
      console.log(`[HEARTBEAT] alive | uptime: ${Math.round(process.uptime() / 60)} мин | checks: ${global.heartbeatLog.checks}`);
    }
  } catch(e) {
    console.error('heartbeat error:', e.message);
  }
}

function getPaperStats() {
  if (!global.paperTrades || !global.paperTrades.length) return null;

  const closed = global.paperTrades.filter(t => t.outcome);
  if (!closed.length) return null;

  const wins = closed.filter(t => t.outcome === 'tp1' || t.outcome === 'tp2');
  const losses = closed.filter(t => t.outcome === 'sl');
  const expired = closed.filter(t => t.outcome === 'expired');
  const wr = Math.round(wins.length / closed.length * 100);
  const totalPnl = closed.reduce((s, t) => s + (t.pnl || 0), 0);

  // По стратегиям
  const byStrat = {};
  for (const t of closed) {
    const key = (t.strategy || '?').substring(0, 25);
    if (!byStrat[key]) byStrat[key] = { wins: 0, losses: 0, expired: 0, pnl: 0 };
    if (t.outcome === 'tp1' || t.outcome === 'tp2') byStrat[key].wins++;
    else if (t.outcome === 'sl') byStrat[key].losses++;
    else byStrat[key].expired++;
    byStrat[key].pnl += t.pnl || 0;
  }

  return { closed, wins, losses, expired, wr, totalPnl, byStrat };
}
async function checkTrailingStop() {
  if (!store.openTrades.length) return;

  for (const trade of store.openTrades) {
    // Только для S5
    if (!trade.strategy?.includes('RSI Диверг')) continue;

    const currentPrice = await getCurrentPrice(trade.instId);
    if (!currentPrice) continue;

    const entry   = parseFloat(trade.price);
    const sl      = parseFloat(trade.sl);
    const tp1     = parseFloat(trade.tp1);

    if (trade.direction === 'long') {
      const pnlPct = (currentPrice - entry) / entry * 100;

      // Уровень 1: прошли 50% пути до TP → безубыток
      const halfway = entry + (tp1 - entry) * 0.5;
      if (currentPrice >= halfway && !trade.trailingActive) {
        const newSL = (entry * 1.001).toFixed(4); // чуть выше входа
        if (parseFloat(newSL) > sl) {
          trade.sl             = newSL;
          trade.trailingActive = true;
          trade.trailingHigh   = currentPrice;
          console.log(`[TRAIL] ${trade.instId} — 50% до TP → SL → безубыток $${newSL}`);
          supabase.from('open_trades').update({ sl: newSL, trailing_active: true })
            .eq('ts', trade.ts).eq('inst_id', trade.instId)
            .then(() => {}).catch(e => console.error('[TRAIL DB]', e.message));
          await sendTelegram(
            `🛡 БЕЗУБЫТОК — ${trade.instId.replace('-USDT-SWAP','')}/USDT\n` +
            `━━━━━━━━━━━━━━━━━━━━━━\n` +
            `📍 50% пути до TP пройдено\n` +
            `💰 Вход: $${trade.price}\n` +
            `🛡 SL → безубыток: $${newSL}\n` +
            `🎯 TP: $${tp1}\n` +
            `📈 Цена: $${currentPrice.toFixed(4)} (+${pnlPct.toFixed(2)}%)\n` +
            `━━━━━━━━━━━━━━━━━━━━━━`
          );
        }
      }

      // Уровень 2: trailing — SL следует за ценой с отступом 1.5%
      if (trade.trailingActive && currentPrice > (trade.trailingHigh || entry)) {
        trade.trailingHigh = currentPrice;
        const trailSL = (currentPrice * 0.985).toFixed(4);
        if (parseFloat(trailSL) > parseFloat(trade.sl)) {
          const oldSL = trade.sl;
          trade.sl    = trailSL;
          console.log(`[TRAIL] ${trade.instId} — SL поднят $${oldSL} → $${trailSL}`);
          supabase.from('open_trades').update({ sl: trailSL })
            .eq('ts', trade.ts).eq('inst_id', trade.instId)
            .then(() => {}).catch(e => console.error('[TRAIL DB]', e.message));
        }
      }

    } else { // SHORT
      const pnlPct = (entry - currentPrice) / entry * 100;

      // Уровень 1: прошли 50% пути до TP → безубыток
      const halfway = entry - (entry - tp1) * 0.5;
      if (currentPrice <= halfway && !trade.trailingActive) {
        const newSL = (entry * 0.999).toFixed(4); // чуть ниже входа
        if (parseFloat(newSL) < sl) {
          trade.sl             = newSL;
          trade.trailingActive = true;
          trade.trailingLow    = currentPrice;
          console.log(`[TRAIL] ${trade.instId} SHORT — 50% до TP → SL → безубыток $${newSL}`);
          supabase.from('open_trades').update({ sl: newSL, trailing_active: true })
            .eq('ts', trade.ts).eq('inst_id', trade.instId)
            .then(() => {}).catch(e => console.error('[TRAIL DB]', e.message));
          await sendTelegram(
            `🛡 БЕЗУБЫТОК — ${trade.instId.replace('-USDT-SWAP','')}/USDT\n` +
            `━━━━━━━━━━━━━━━━━━━━━━\n` +
            `📍 50% пути до TP пройдено\n` +
            `💰 Вход: $${trade.price}\n` +
            `🛡 SL → безубыток: $${newSL}\n` +
            `🎯 TP: $${tp1}\n` +
            `📉 Цена: $${currentPrice.toFixed(4)} (+${pnlPct.toFixed(2)}%)\n` +
            `━━━━━━━━━━━━━━━━━━━━━━`
          );
        }
      }

      // Уровень 2: trailing — SL следует за ценой с отступом 1.5%
      if (trade.trailingActive && currentPrice < (trade.trailingLow || entry)) {
        trade.trailingLow = currentPrice;
        const trailSL = (currentPrice * 1.015).toFixed(4);
        if (parseFloat(trailSL) < parseFloat(trade.sl)) {
          const oldSL = trade.sl;
          trade.sl    = trailSL;
          console.log(`[TRAIL] ${trade.instId} SHORT — SL опущен $${oldSL} → $${trailSL}`);
          supabase.from('open_trades').update({ sl: trailSL })
            .eq('ts', trade.ts).eq('inst_id', trade.instId)
            .then(() => {}).catch(e => console.error('[TRAIL DB]', e.message));
        }
      }
    }
  }
}

// ============================================================
//  ТАЙМЕР НА СДЕЛКУ — напоминание если сделка висит долго
// ============================================================
async function checkTradeTimers() {
  // Когда AutoExec активен — он сам управляет позициями на Bybit
  // Напоминания не нужны — store.openTrades может содержать уже закрытые сделки
  if (autoExecSignals) return;
  if (!store.openTrades.length) return;

  for (const trade of store.openTrades) {
    const ageMin  = Math.round((Date.now() - trade.ts) / 60000);
    const ageHour = Math.floor(ageMin / 60);
    const ageStr  = ageHour > 0 ? `${ageHour}ч ${ageMin % 60}мин` : `${ageMin}мин`;

    const reminded2h = trade.reminded2h || false;
    const reminded4h = trade.reminded4h || false;

    if (ageMin >= 120 && !reminded2h) {
      trade.reminded2h = true;

      // Получаем текущую цену для PnL
      const currentPrice = await getCurrentPrice(trade.instId) || trade.price;
      const entry  = parseFloat(trade.price);
      const sl     = parseFloat(trade.sl);
      const tp1    = parseFloat(trade.tp1);
      const tp2    = parseFloat(trade.tp2);

      let pnlPct;
      if (trade.direction === 'long') {
        pnlPct = (currentPrice - entry) / entry * 100;
      } else {
        pnlPct = (entry - currentPrice) / entry * 100;
      }

      const pnlStr    = pnlPct >= 0 ? `+${pnlPct.toFixed(2)}%` : `${pnlPct.toFixed(2)}%`;
      const pnlEmoji  = pnlPct >= 1.5 ? '🟢' : pnlPct >= 0 ? '🟡' : pnlPct >= -1 ? '🟠' : '🔴';
      const dir       = trade.direction === 'long' ? '🚀 LONG' : '🩸 SHORT';

      // Расстояние до SL и TP
      const distSL  = trade.direction === 'long'
        ? ((currentPrice - sl) / currentPrice * 100).toFixed(2)
        : ((sl - currentPrice) / currentPrice * 100).toFixed(2);
      const distTP1 = trade.direction === 'long'
        ? ((tp1 - currentPrice) / currentPrice * 100).toFixed(2)
        : ((currentPrice - tp1) / currentPrice * 100).toFixed(2);

      const status = pnlPct >= 1.5
        ? '✅ Хорошо идёт — держи позицию'
        : pnlPct >= 0
        ? '😐 В небольшом плюсе — следи за SL'
        : pnlPct >= -1
        ? '⚠️ Небольшой минус — нормально, держи'
        : '🔴 В заметном минусе — оцени риски';

      await sendTelegram(
        `⏰ НАПОМИНАНИЕ 2ч — ${trade.symbol}/USDT\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n` +
        `${dir} | 📌 ${trade.strategy?.split(' ')[0] || ''}\n\n` +
        `💰 Вход:    $${trade.price}\n` +
        `📍 Сейчас: $${currentPrice.toFixed(4)}\n\n` +
        `${pnlEmoji} PnL сейчас: ${pnlStr}\n` +
        `🛡 До SL:  ${distSL}%\n` +
        `🎯 До TP1: ${distTP1}%\n\n` +
        `🛡 SL:  $${trade.sl}\n` +
        `🎯 TP1: $${trade.tp1}\n` +
        `🎯 TP2: $${trade.tp2}\n\n` +
        `⏱ В позиции: ${ageStr}\n` +
        `${status}\n` +
        `━━━━━━━━━━━━━━━━━━━━━━`
      );
    }

    if (ageMin >= 480 && !reminded4h) {
      trade.reminded4h = true;

      const currentPrice = await getCurrentPrice(trade.instId) || trade.price;
      const entry  = parseFloat(trade.price);

      let pnlPct;
      if (trade.direction === 'long') {
        pnlPct = (currentPrice - entry) / entry * 100;
      } else {
        pnlPct = (entry - currentPrice) / entry * 100;
      }

      const pnlStr   = pnlPct >= 0 ? `+${pnlPct.toFixed(2)}%` : `${pnlPct.toFixed(2)}%`;
      const pnlEmoji = pnlPct >= 1.5 ? '🟢' : pnlPct >= 0 ? '🟡' : pnlPct >= -1 ? '🟠' : '🔴';
      const dir      = trade.direction === 'long' ? '🚀 LONG' : '🩸 SHORT';

      await sendTelegram(
        `⚠️ СДЕЛКА ВИСИТ 8Ч — истекает скоро!\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n` +
        `${dir} ${trade.symbol}/USDT\n\n` +
        `💰 Вход:    $${trade.price}\n` +
        `📍 Сейчас: $${currentPrice.toFixed(4)}\n\n` +
        `${pnlEmoji} PnL сейчас: ${pnlStr}\n\n` +
        `⏱ В позиции: ${ageStr}\n` +
        `🔴 Скоро закроется автоматически как EXPIRED\n` +
        `━━━━━━━━━━━━━━━━━━━━━━`
      );
    }
  }
}

// Каждые 15 минут — проверка исходов
async function checkOutcomes() {
  if (!store.openTrades.length) return;
  const stillOpen = [], closed = [];

  for (const trade of store.openTrades) {
    const ageMin = (Date.now() - trade.ts) / 60000;

    // ── TIME-IN-TRADE ТАЙМАУТ ────────────────────────────────
    // Если сделка не закрылась за 8 часов — рынок не подтвердил идею
    // Закрываем: если в плюсе — как TP1, если в нуле/минусе — как expired
    if (ageMin > 480) {
      const expPrice = await getCurrentPrice(trade.instId);
      const entry    = parseFloat(trade.price);
      const pnlPct   = expPrice
        ? trade.direction === 'long'
          ? (expPrice - entry) / entry * 100
          : (entry - expPrice) / entry * 100
        : 0;

      // Если в плюсе — засчитываем как TP1 (не waste)
      trade.outcome    = pnlPct > 0.3 ? 'tp1' : 'expired';
      trade.closedAt   = Date.now();
      trade.closePrice = expPrice || entry;
      trade.pnl        = parseFloat(pnlPct.toFixed(2));

      const timeoutMsg = pnlPct > 0.3
        ? `⏰ ${(trade.instId||'').replace('-USDT-SWAP','')} — Таймаут 8ч, закрыто в плюсе +${pnlPct.toFixed(2)}% ✅`
        : `⏰ ${(trade.instId||'').replace('-USDT-SWAP','')} — Таймаут 8ч, идея не сработала (${pnlPct.toFixed(2)}%). Закрыто.`;
      await sendTelegram(timeoutMsg);

      updateDailyPnl(trade.pnl, trade.outcome);
      closed.push(trade);
      continue;
    }

    let price = await getCurrentPrice(trade.instId);
    if (!price) { stillOpen.push(trade); continue; }

    const sl  = parseFloat(trade.sl);
    const tp1 = parseFloat(trade.tp1);
    const tp2 = parseFloat(trade.tp2);

    // Точная проверка через 1-минутные свечи
    let slHit=false, tp1Hit=false, tp2Hit=false, hitPrice=price;
    try {
      const minsOpen = Math.min(Math.ceil((Date.now()-trade.ts)/60000)+1, 60);
      const k1m = await getOKXKlinesCached(trade.instId, '1m', minsOpen);
      const recentK = k1m.filter(k => k.ts > trade.ts - 60000);
      for (const k of recentK) {
        const high = k.high || k.close;
        const low  = k.low  || k.close;
        if (trade.direction === 'long') {
          if (low  <= sl)  { slHit  = true; hitPrice = sl;  break; }
          if (high >= tp2) { tp2Hit = true; hitPrice = tp2; break; }
          if (high >= tp1) { tp1Hit = true; hitPrice = tp1; }
        } else {
          if (high >= sl)  { slHit  = true; hitPrice = sl;  break; }
          if (low  <= tp2) { tp2Hit = true; hitPrice = tp2; break; }
          if (low  <= tp1) { tp1Hit = true; hitPrice = tp1; }
        }
      }
      price = hitPrice;
    } catch(e) { /* fallback to current price */ }

    // ── Breakeven: при +1R передвигаем SL в безубыток ────────
    // Пропускаем если AutoExec управляет позицией на Bybit
    // (AutoExec сам следит за реальной позицией по правильной цене входа)
    if (!trade.trailingActive && !autoExecSignals) {
      const entry = parseFloat(trade.price);
      const slOrig = parseFloat(trade.sl);
      const slDist = Math.abs(entry - slOrig);
      if (trade.direction === 'long') {
        const oneR = entry + slDist; // +1R
        if (price >= oneR) {
          trade.sl = entry.toFixed(4); // SL → безубыток
          trade.trailingActive = true;
          console.log(`[BREAKEVEN] ${trade.instId} LONG → SL в безубыток ($${entry.toFixed(4)})`);
          await sendTelegram(`🛡 ${(trade.instId||"").replace('-USDT-SWAP','')} — SL передвинут в безубыток (+1R достигнут). Сделка теперь безрисковая.`);
        }
      } else {
        const oneR = entry - slDist; // -1R (для шорта)
        if (price <= oneR) {
          trade.sl = entry.toFixed(4);
          trade.trailingActive = true;
          console.log(`[BREAKEVEN] ${trade.instId} SHORT → SL в безубыток ($${entry.toFixed(4)})`);
          await sendTelegram(`🛡 ${(trade.instId||"").replace('-USDT-SWAP','')} — SL передвинут в безубыток (+1R достигнут). Сделка теперь безрисковая.`);
        }
      }
    }

    let outcome = null;
    if (trade.direction === 'long') {
      if (price <= parseFloat(trade.sl)) {
        // Если trailing был активен — закрылся по безубытку (не tp1 и не sl)
        outcome = trade.trailingActive ? 'breakeven' : 'sl';
      }
      else if (price >= parseFloat(trade.tp2)) outcome = 'tp2';
      else if (price >= parseFloat(trade.tp1) && !trade.trailingActive) outcome = 'tp1';
    } else {
      if (price >= parseFloat(trade.sl)) {
        outcome = trade.trailingActive ? 'breakeven' : 'sl';
      }
      else if (price <= parseFloat(trade.tp2)) outcome = 'tp2';
      else if (price <= parseFloat(trade.tp1) && !trade.trailingActive) outcome = 'tp1';
    }

    if (outcome) {
      trade.outcome    = outcome;
      trade.closePrice = price;
      trade.closedAt   = Date.now();
      const entryPrice = parseFloat(trade.price);
      const exitPrice  = parseFloat(price);
      trade.pnl = trade.direction === 'long'
        ? (exitPrice - entryPrice) / entryPrice * 100
        : (entryPrice - exitPrice) / entryPrice * 100;
      trade.pnl = parseFloat(trade.pnl.toFixed(2));
      updateDailyPnl(trade.pnl || 0, outcome);
      closed.push(trade);
      // Уведомление только если AutoExec выключен — иначе он сам уже уведомил
      if (!autoExecSignals) {
        await sendTelegram(buildOutcomeAlert(trade));
        // Итоги сделок — только в личку, не в канал
      }
    } else { stillOpen.push(trade); }
  }

  store.openTrades   = stillOpen;
store.tradeHistory = [...store.tradeHistory, ...closed].slice(-500);

// Сохраняем закрытые сделки в базу + удаляем из open_trades
for (const trade of closed) {
  try {
    await supabase.from('trades').insert({
      ts:          trade.ts,
      inst_id:     trade.instId,
      symbol:      trade.symbol,
      strategy:    trade.strategy,
      direction:   trade.direction,
      price:       trade.price,
      sl:          trade.sl,
      tp1:         trade.tp1,
      tp2:         trade.tp2,
      confidence:  trade.confidence,
      outcome:     trade.outcome,
      close_price: trade.closePrice,
      closed_at:   trade.closedAt,
      pnl:         trade.pnl,
    });
  } catch(e) { console.error('[DB] trade save error:', e.message); }
  supabase.from('open_trades').delete()
    .eq('inst_id', trade.instId).eq('ts', trade.ts)
    .then(() => {}).catch(e => console.error('[DB] open_trades delete error:', e.message));
}
}

// Каждый час — аномалии
async function checkAnomalies() {
  if (!anyoneSubscribed('anomalies')) { console.log('[ANOMALIES] никто не подписан — пропуск'); return; }
  const candidates = await getOKXCandidates();
  const anomalies  = candidates.filter(c => Math.abs(c.change24h) >= 3.0);
  if (!anomalies.length) { await sendTelegram('✅ КРИПТО РАДАР\nАномалий нет (<3% за 24h)', 'anomalies'); return; }

  const fng   = await getFearAndGreed();
  const top5  = anomalies.slice(0, 5);
  const coins = top5.map(c => `${c.change24h > 0 ? '🚀' : '📉'} ${c.symbol} $${c.price}  ${c.change24h.toFixed(2)}%  $${(c.volume24h/1e6).toFixed(0)}M`).join('\n');
  const prompt = `Крипто аналитик. OKX аномалии:\n\n${top5.map(c => `${c.symbol}: $${c.price}, ${c.change24h.toFixed(2)}%`).join('\n')}\n\nF&G: ${fng.value} (${fng.label}). Grade A-D, LONG/SHORT/ЖДАТЬ, 1-2 предложения. На русском.`;

  await sendTelegram(`🔔 КРИПТО РАДАР v4.0\n🕐 ${getAlmatyTime()}\n😐 F&G: ${fng.value} (${fng.label})\n\n${coins}\n\n🤖 AI:\n${await callGroq(prompt)}`, 'anomalies');
}

// ============================================================
//  WHALE REPORT — рассылка активности китов (каждый час)
// ============================================================
async function checkWhales() {
  if (!anyoneSubscribed('whales')) { console.log('[WHALES OKX] никто не подписан — пропуск'); return; }
  const candidates = await getOKXCandidates();
  if (!candidates.length) return;

  const whaleAlerts = [];

  for (const coin of candidates.slice(0, 10)) { // топ-10 по объёму
    const whale = await getWhaleActivity(coin.instId, coin.symbol);
    if (!whale.hasWhales || whale.totalUsd < 500000) continue; // минимум $500k
    if (whale.dominant === 'neutral') continue;

    whaleAlerts.push({
      symbol:    coin.symbol,
      price:     coin.price,
      dominant:  whale.dominant,
      buyUsd:    whale.buyUsd,
      sellUsd:   whale.sellUsd,
      totalUsd:  whale.totalUsd,
    });
  }

  if (!whaleAlerts.length) return; // нет активности — молчим

  // Сортируем по объёму
  whaleAlerts.sort((a, b) => b.totalUsd - a.totalUsd);

  const lines = whaleAlerts.map(w => {
    const emoji = w.dominant === 'buy' ? '🟢' : '🔴';
    const action= w.dominant === 'buy' ? 'ПОКУПКА' : 'ПРОДАЖА';
    return (
      `${emoji} ${w.symbol}/USDT — ${action}\n` +
      `   💰 $${w.price}\n` +
      `   🟢 Купили: $${(w.buyUsd/1e6).toFixed(2)}M\n` +
      `   🔴 Продали: $${(w.sellUsd/1e6).toFixed(2)}M\n` +
      `   📊 Всего: $${(w.totalUsd/1e6).toFixed(2)}M`
    );
  }).join('\n\n━━━━━━━━━━━━\n\n');

  await sendTelegram(
    `🐋 АКТИВНОСТЬ КИТОВ\n` +
    `⏰ ${getAlmatyTime()} Алматы\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
    lines + '\n\n' +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `⚠️ Не является финансовым советом.`,
    'whales'
  );
}
// ============================================================
//  RSS НОВОСТИ
// ============================================================
async function checkRSSNews() {
  if (!anyoneSubscribed('news')) { console.log('[NEWS] никто не подписан — пропуск'); return; }
  const RSS_FEEDS = [
    'https://cointelegraph.com/rss',
    'https://coindesk.com/arc/outboundfeeds/rss/',
    'https://decrypt.co/feed',
  ];

  const WATCH_COINS = ['BTC','ETH','SOL','XRP','DOGE','PEPE','AVAX','LINK','BNB','ADA'];

  try {
    for (const feedUrl of RSS_FEEDS) {
      const data = await httpGet(feedUrl);
      if (!data) continue;

      // Парсим RSS (простой XML парсинг)
      const items = [...data.matchAll(/<item>([\s\S]*?)<\/item>/g)];
      
      for (const item of items.slice(0, 10)) {
        const content = item[1];
        const title   = (content.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || 
                         content.match(/<title>(.*?)<\/title>/))?.[1] || '';
        const pubDate = (content.match(/<pubDate>(.*?)<\/pubDate>/))?.[1] || '';
        const link    = (content.match(/<link>(.*?)<\/link>/) ||
                         content.match(/<link\s[^>]*href="(.*?)"/))?.[1] || '';

        if (!title) continue;

        // Проверяем свежесть — только за последний час
        const pubTs = pubDate ? new Date(pubDate).getTime() : 0;
        if (pubTs && Date.now() - pubTs > 60 * 60 * 1000) continue;

        // Проверяем упоминание монет
        const mentioned = WATCH_COINS.filter(coin => 
          title.toUpperCase().includes(coin) ||
          title.toUpperCase().includes(coin + 'USD')
        );
        if (!mentioned.length) continue;

        // Проверяем не отправляли ли уже эту новость
        const newsKey = title.slice(0, 50);
        if (store.sentNews && store.sentNews.has(newsKey)) continue;
        if (!store.sentNews) store.sentNews = new Set();
        store.sentNews.add(newsKey);
        if (store.sentNews.size > 200) {
          const first = store.sentNews.values().next().value;
          store.sentNews.delete(first);
        }

        // AI анализ тональности
        const prompt = `Крипто новость: "${title}"\nОтветь ОДНИМ словом: BULLISH, BEARISH или NEUTRAL`;
        const sentiment = (await callGroq(prompt)).trim().toUpperCase();

        if (sentiment.includes('NEUTRAL')) continue; // нейтральные не отправляем

        const emoji  = sentiment.includes('BULLISH') ? '🟢' : '🔴';
        const action = sentiment.includes('BULLISH') ? 'ПОЗИТИВНАЯ' : 'НЕГАТИВНАЯ';
        const coins  = mentioned.join(', ');

        await sendTelegram(
          `📰 КРИПТО НОВОСТЬ — ${action}\n` +
          `━━━━━━━━━━━━━━━━━━━━━━\n` +
          `${emoji} ${title}\n\n` +
          `💰 Монеты: ${coins}\n` +
          `⏰ ${getAlmatyTime()} Алматы\n` +
          (link ? `🔗 ${link}\n` : '') +
          `━━━━━━━━━━━━━━━━━━━━━━\n` +
          `⚠️ Не является финансовым советом.`,
          'news'
        );

        console.log(`[RSS] ${action}: ${title.slice(0,60)} | ${coins}`);
      }
    }
  } catch(e) {
    console.error('checkRSSNews error:', e.message);
  }
}
// ============================================================
//  ВЕЧЕРНИЙ ДЕБРИФИНГ — 21:00 Алматы
// ============================================================
// ============================================================
//  АГЕНТ ПСИХОЛОГ — мониторит психологическое состояние
// ============================================================
async function psychologistAgent() {
  try {
    const history  = store.tradeHistory.slice(-20);
    if (history.length < 3) return; // только реальные сделки
    const allTrades = history;

    // Анализируем паттерны
    const recentSL   = allTrades.slice(-5).filter(t => t.outcome === 'sl').length;
    const totalSL    = allTrades.filter(t => t.outcome === 'sl').length;
    const totalWins  = allTrades.filter(t => t.outcome === 'tp1' || t.outcome === 'tp2').length;
    const wr         = allTrades.length ? Math.round(totalWins / allTrades.length * 100) : 0;

    // Паттерны риска
    const consecutiveSL = (() => {
      let streak = 0;
      for (let i = allTrades.length - 1; i >= 0; i--) {
        if (allTrades[i].outcome === 'sl') streak++;
        else break;
      }
      return streak;
    })();

    const daySlCount = global.dailyPnlTracker?.slCount || 0;

    // Определяем уровень риска
    let riskLevel = 'normal';
    let message   = '';

    if (consecutiveSL >= 4) {
      riskLevel = 'critical';
      message   = `🚨 ПСИХОЛОГ: ${consecutiveSL} SL подряд — это серьёзно.\n\nЯ рекомендую полную остановку на сегодня. Такая серия случается у всех трейдеров, но продолжение торговли в этом состоянии статистически ухудшает результат.\n\nЧто сделать прямо сейчас:\n1. Напиши /emergency\n2. Выйди на прогулку или займись чем-то другим\n3. Вернись завтра со свежей головой\n\nЭто не слабость — это профессионализм.`;
    } else if (consecutiveSL === 3) {
      riskLevel = 'high';
      message   = `⚠️ ПСИХОЛОГ: 3 SL подряд.\n\nРекомендую взять паузу 2-3 часа. Рынок никуда не денется, а твоя голова отдохнёт.\n\nWR последних 20 сделок: ${wr}%\n\nЕсли хочешь продолжить — снизь риск до 0.3% на следующие 5 сделок.`;
    } else if (daySlCount >= 3) {
      riskLevel = 'high';
      message   = `⚠️ ПСИХОЛОГ: ${daySlCount} SL за сегодня.\n\nДневной лимит почти исчерпан. Оставшийся потенциал не стоит риска потери аккаунта.\n\nРекомендую: /emergency до завтра.`;
    } else if (recentSL >= 4 && wr < 35) {
      riskLevel = 'medium';
      message   = `💛 ПСИХОЛОГ: WR последних 20 сделок ${wr}% — ниже нормы.\n\nЭто сигнал что текущие условия рынка не подходят для стратегий. Не твоя ошибка — рынок изменился.\n\nЧто делать: уменьши частоту торговли, жди только сигналы с confidence 85+.`;
    }

    if (message) {
      // AI усиливает сообщение
      try {
        const apiKey = process.env.CLAUDE_KEY || process.env.ANTHROPIC_API_KEY;
        if (apiKey) {
          const resp = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({
              model: 'claude-haiku-4-5-20251001',
              max_tokens: 150,
              messages: [{
                role: 'user',
                content: `Ты торговый психолог. Трейдер в такой ситуации: ${consecutiveSL} SL подряд, WR ${wr}%, уровень риска: ${riskLevel}. Напиши одно короткое ободряющее предложение на русском (не более 20 слов) которое поможет ему принять правильное решение. Без советов — только поддержка.`
              }]
            })
          });
          const data = await resp.json();
          const aiLine = data?.content?.[0]?.text || '';
          if (aiLine) message += `\n\n💬 "${aiLine}"`;
        }
      } catch(e) {}

      await sendTelegram(message);
      console.log(`[PSYCHOLOGIST] Уровень риска: ${riskLevel}, отправлено сообщение`);
    }
  } catch(e) {
    console.error('psychologistAgent error:', e.message);
  }
}

// ============================================================
//  АГЕНТ АУДИТОР — анализирует стратегии и отключает слабые
// ============================================================
async function auditorAgent() {
  try {
    const paper = (global.paperTrades || []).filter(t => t.outcome);
    if (paper.length < 15) {
      console.log('[AUDITOR] Мало данных для анализа (нужно 15+)');
      return;
    }

    // Статистика по стратегиям
    const byStrat = {};
    for (const t of paper) {
      const key = t.strategy || '?';
      if (!byStrat[key]) byStrat[key] = { wins: 0, losses: 0, expired: 0, pnl: 0, total: 0 };
      byStrat[key].total++;
      if (t.outcome === 'tp1' || t.outcome === 'tp2') byStrat[key].wins++;
      else if (t.outcome === 'sl') byStrat[key].losses++;
      else byStrat[key].expired++;
      byStrat[key].pnl += t.pnl || 0;
    }

    const weak    = []; // WR < 35% и 10+ сделок
    const strong  = []; // WR > 60% и 10+ сделок
    const medium  = []; // всё остальное

    for (const [name, s] of Object.entries(byStrat)) {
      if (s.total < 10) continue; // мало данных
      const wr = Math.round(s.wins / s.total * 100);
      if (wr < 35)      weak.push({ name, wr, ...s });
      else if (wr > 60) strong.push({ name, wr, ...s });
      else              medium.push({ name, wr, ...s });
    }

    // Формируем отчёт
    let msg = `🔍 АУДИТОР — ЕЖЕНЕДЕЛЬНЫЙ АНАЛИЗ\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `📊 Проанализировано: ${paper.length} paper trades\n\n`;

    if (strong.length) {
      msg += `✅ СИЛЬНЫЕ СТРАТЕГИИ:\n`;
      for (const s of strong.sort((a,b) => b.wr - a.wr)) {
        msg += `  ${s.name.split(' ').slice(0,2).join(' ')}: WR ${s.wr}% (${s.wins}W/${s.losses}L)\n`;
      }
      msg += '\n';
    }

    if (medium.length) {
      msg += `⚠️ СРЕДНИЕ (наблюдаем):\n`;
      for (const s of medium.sort((a,b) => b.wr - a.wr)) {
        msg += `  ${s.name.split(' ').slice(0,2).join(' ')}: WR ${s.wr}%\n`;
      }
      msg += '\n';
    }

    if (weak.length) {
      msg += `❌ СЛАБЫЕ (рекомендую отключить):\n`;
      for (const s of weak) {
        msg += `  ${s.name.split(' ').slice(0,2).join(' ')}: WR ${s.wr}% (${s.total} сделок)\n`;
      }
      msg += '\n';
    }

    // AI рекомендации
    try {
      const apiKey = process.env.CLAUDE_KEY || process.env.ANTHROPIC_API_KEY;
      if (apiKey && (weak.length || strong.length)) {
        const resp = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 200,
            messages: [{
              role: 'user',
              content: `Ты аудитор торгового бота. Дай конкретную рекомендацию на русском (max 80 слов):
Сильные стратегии: ${strong.map(s=>s.name.split(' ').slice(0,2).join(' ')+' WR'+s.wr+'%').join(', ') || 'нет'}
Слабые стратегии: ${weak.map(s=>s.name.split(' ').slice(0,2).join(' ')+' WR'+s.wr+'%').join(', ') || 'нет'}
Всего сделок: ${paper.length}
Что конкретно делать на следующей неделе?`
            }]
          })
        });
        const data = await resp.json();
        const aiRec = data?.content?.[0]?.text || '';
        if (aiRec) msg += `🧠 РЕКОМЕНДАЦИЯ АУДИТОРА:\n${aiRec}\n\n`;
      }
    } catch(e) {}

    msg += `━━━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `Следующий аудит: через 7 дней`;

    await sendTelegram(msg);
    console.log(`[AUDITOR] Отчёт отправлен. Слабых: ${weak.length}, Сильных: ${strong.length}`);
  } catch(e) {
    console.error('auditorAgent error:', e.message);
  }
}

async function eveningDebrief() {
  try {
    const since = Date.now() - 12 * 60 * 60 * 1000; // последние 12 часов

    // Paper trading за день
    const paperStats = getPaperStats();
    const todayPaper = (global.paperTrades || [])
      .filter(t => t.ts >= since && t.outcome);

    // Какие стратегии дали сигналы сегодня
    const todaySignals = (global.paperTrades || [])
      .filter(t => t.ts >= since);

    // Лучшая и худшая стратегия за день
    const byStrat = {};
    for (const t of todayPaper) {
      const key = (t.strategy || '?').split(' ').slice(0,2).join(' ');
      if (!byStrat[key]) byStrat[key] = { wins: 0, losses: 0, pnl: 0 };
      if (t.outcome === 'tp1' || t.outcome === 'tp2') byStrat[key].wins++;
      else if (t.outcome === 'sl') byStrat[key].losses++;
      byStrat[key].pnl += t.pnl || 0;
    }

    const stratLines = Object.entries(byStrat)
      .map(([k, v]) => {
        const total = v.wins + v.losses;
        const wr = total ? Math.round(v.wins/total*100) : 0;
        const icon = wr >= 60 ? '✅' : wr >= 40 ? '⚠️' : '❌';
        return `${icon} ${k}: ${v.wins}W/${v.losses}L WR:${wr}% PnL:${v.pnl>=0?'+':''}${v.pnl.toFixed(1)}%`;
      }).join('\n') || '  нет закрытых сделок';

    // AI анализ дня
    let aiSummary = '';
    try {
      const apiKey = process.env.CLAUDE_KEY || process.env.ANTHROPIC_API_KEY;
      if (apiKey) {
        const fng = await getFearAndGreed();
        const response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 200,
            messages: [{
              role: 'user',
              content: `Ты AI аналитик торгового бота. Дай краткий вечерний дебрифинг на русском (максимум 100 слов).

Данные за сегодня:
- Сигналов получено: ${todaySignals.length}
- Закрытых paper trades: ${todayPaper.length}
- По стратегиям: ${stratLines}
- F&G: ${fng?.value} (${fng?.label})

Что работало сегодня? Что не работало? Что ожидать завтра? Конкретно и коротко.`
            }]
          })
        });
        const data = await response.json();
        aiSummary = data?.content?.[0]?.text || '';
      }
    } catch(e) {}

    let msg = `🌙 ВЕЧЕРНИЙ ДЕБРИФИНГ\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `📅 ${getAlmatyDate()} | ${getAlmatyTime()}\n\n`;

    msg += `📊 ЗА СЕГОДНЯ:\n`;
    msg += `  Сигналов: ${todaySignals.length}\n`;
    msg += `  Закрыто paper: ${todayPaper.length}\n\n`;

    if (Object.keys(byStrat).length > 0) {
      msg += `📈 ПО СТРАТЕГИЯМ:\n${stratLines}\n\n`;
    }

    if (aiSummary) {
      msg += `🧠 АНАЛИЗ:\n${aiSummary}\n\n`;
    }

    msg += `━━━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `Завтра: /report в 9:00 Алматы`;

    await sendTelegram(msg);
  } catch(e) {
    console.error('eveningDebrief error:', e.message);
  }
}

async function dailyReport() {
  const since = Date.now() - 24*60*60*1000;
  const fng   = await getFearAndGreed();

  try {
    // ── 1. Собираем данные ────────────────────────────────────
    const { data: trades }  = await supabase.from('trades').select('*').gte('closed_at', since);
    const { data: signals } = await supabase.from('signals').select('*').gte('ts', since);
    const t = trades  || [];
    const s = signals || [];

    const wins   = t.filter(x => x.outcome==='tp1'||x.outcome==='tp2');
    const losses = t.filter(x => x.outcome==='sl');
    const wr     = t.length ? Math.round(wins.length/t.length*100) : 0;
    const pnl    = t.reduce((a,x) => a+(parseFloat(x.pnl)||0), 0);

    // Paper trading статистика
    const paperStats = getPaperStats();
    const paperOpen  = (global.paperTrades||[]).filter(t=>!t.outcome).length;

    // BTC данные
    let btcPrice = 0, btcChange = 0, btcRegime = 'неизвестен';
    try {
      const btc4h = await getOKXKlinesCached('BTC-USDT-SWAP', '4H', 24);
      if (btc4h.length >= 6) {
        btcPrice  = btc4h[btc4h.length-1].close;
        btcChange = ((btcPrice - btc4h[0].open) / btc4h[0].open * 100);
        const regime = await getMarketRegime('BTC-USDT-SWAP');
        const adx = regime?.adx || 0;
        btcRegime = adx > 25 ? `Тренд (ADX ${adx.toFixed(0)})` : adx < 18 ? `Боковик (ADX ${adx.toFixed(0)})` : `Нейтральный (ADX ${adx.toFixed(0)})`;
      }
    } catch(e) {}

    // ── 2. Определяем активные стратегии по ADX ──────────────
    // Реальные активные стратегии из кода (не хардкод)
    const activeStrategies = [];
    // S1 и S10 всегда активны в live mode
    activeStrategies.push('S1 Volume Spike (15m)');
    activeStrategies.push('S10 4H Range Breakout');
    // Добавляем стратегии в observe mode
    if (store.observeMode) {
      activeStrategies.push('S16 VWAP Deviation (observe)');
      activeStrategies.push('S19 Value Area (observe)');
    }

    // ── 3. AI Анализ через Claude API ────────────────────────
    let aiAnalysis = '';
    try {
      const context = {
        date: getAlmatyDate(),
        time: getAlmatyTime(),
        market: {
          fng: `${fng.value} (${fng.label})`,
          btcPrice: btcPrice.toFixed(0),
          btcChange24h: btcChange.toFixed(2) + '%',
          regime: btcRegime,
          activeStrategies,
        },
        performance: {
          trades24h: t.length,
          winRate: wr + '%',
          pnl24h: pnl.toFixed(2) + '%',
          signals24h: s.length,
        },
        paperTrading: paperStats ? {
          totalClosed: paperStats.closed.length,
          winRate: paperStats.wr + '%',
          totalPnl: paperStats.totalPnl.toFixed(2) + '%',
          openPositions: paperOpen,
          byStrategy: Object.entries(paperStats.byStrat).map(([k,v]) => ({
            strategy: k,
            wins: v.wins, losses: v.losses,
            wr: Math.round(v.wins/(v.wins+v.losses+v.expired||1)*100) + '%'
          }))
        } : null,
      };

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 400,
          messages: [{
            role: 'user',
            content: `Ты AI аналитик торгового бота на крипторынке. Проанализируй данные и дай краткий отчёт на русском языке (максимум 200 слов).

Данные: ${JSON.stringify(context, null, 2)}

Формат ответа:
1. Оценка рынка (1-2 предложения)
2. Что активно сегодня и почему
3. На что обратить внимание
4. Один конкретный совет на сегодня

Будь конкретным и честным. Не используй markdown разметку.`
          }]
        })
      });
      const data = await response.json();
      aiAnalysis = data?.content?.[0]?.text || '';
    } catch(e) {
      console.error('AI analyst error:', e.message);
    }

    // ── 4. Build message ──────────────────────────────────────
    const btcDir = btcChange >= 0 ? '📈' : '📉';
    const modeStr = store.observeMode ? 'OBSERVE' : store.propMode ? 'PROP' : 'LIVE';
    let msg = `🤖 MORNING REPORT — Apex Algo Fund\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `🗓 ${getAlmatyDate()} | ${getAlmatyTime()} ALM\n\n`;

    msg += `📊 MARKET:\n`;
    msg += `${btcDir} BTC: $${Number(btcPrice).toLocaleString()} (${btcChange>=0?'+':''}${btcChange.toFixed(2)}% 24h)\n`;
    msg += `😐 Fear & Greed: ${fng.value} (${fng.label})\n`;
    msg += `📈 Regime: ${btcRegime}\n\n`;

    msg += `⚙️ ACTIVE STRATEGIES [${modeStr}]:\n`;
    msg += activeStrategies.map(s => `  • ${s}`).join('\n') + '\n\n';

    if (paperStats && paperStats.closed.length >= 3) {
      msg += `📄 PAPER (${paperStats.closed.length} trades):\n`;
      msg += `  WR: ${paperStats.wr}% | PnL: ${paperStats.totalPnl>=0?'+':''}${paperStats.totalPnl.toFixed(1)}%\n\n`;
    }

    if (t.length) {
      msg += `📈 YESTERDAY (live):\n`;
      msg += `  Trades: ${t.length} | TP: ${wins.length} | SL: ${losses.length}\n`;
      msg += `  WR: ${wr}% | PnL: ${pnl>=0?'+':''}${pnl.toFixed(1)}%\n\n`;
    }

    if (aiAnalysis) {
      msg += `🧠 ANALYSIS:\n${aiAnalysis}\n\n`;
    }

    msg += `━━━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `🌐 apexalgofund.com\n`;
    msg += `Commands: /paper /diag /account /dashboard`;

    await sendTelegram(msg);
  } catch(e) {
    console.error('dailyReport error:', e.message);
    await sendTelegram(`📊 ОТЧЁТ | ${getAlmatyDate()}\n❌ Ошибка: ${e.message}`);
  }
}


// ============================================================
//  РАСПИСАНИЕ (node-cron)
// ============================================================
console.log('🚀 Крипто Радар v4.0 запущен');
console.log(`⏰ Время Алматы: ${getAlmatyTime()}`);
console.log(`📊 Сессия: ${getCurrentSession()}`);
logToSupabase('startup', 'info', `Бот запущен. Сессия: ${getCurrentSession()}. Observe: ${store.observeMode}`);

// Каждые 5 минут
// ── PROCESS MONITORING — умные алерты при ошибках ───────────
const errorCounts  = {};   // { errorKey: { count, firstTs, lastTs, alerted } }
const ERROR_THRESHOLD = 3; // алерт после 3 одинаковых ошибок за 10 минут
const ERROR_WINDOW_MS = 10 * 60 * 1000;

function trackError(category, message) {
  const key  = `${category}:${message.substring(0, 60)}`;
  const now  = Date.now();

  if (!errorCounts[key]) {
    errorCounts[key] = { count: 0, firstTs: now, lastTs: now, alerted: false };
  }

  const e = errorCounts[key];

  // Сбрасываем если окно истекло
  if (now - e.firstTs > ERROR_WINDOW_MS) {
    e.count = 0; e.firstTs = now; e.alerted = false;
  }

  e.count++;
  e.lastTs = now;

  // Алерт при достижении порога
  if (e.count >= ERROR_THRESHOLD && !e.alerted) {
    e.alerted = true;
    sendTelegram(
      `🚨 *Process Alert*\n\n` +
      `Категория: \`${category}\`\n` +
      `Ошибка: \`${message.substring(0, 120)}\`\n` +
      `Повторений: ${e.count} за последние 10 мин\n\n` +
      `_Проверь логи Render_`
    ).catch(() => {});
    console.error(`[MONITOR] АЛЕРТ отправлен: ${key}`);
  }

  // Пишем в Supabase bot_logs
  supabase.from('bot_logs').insert({
    ts:       now,
    category,
    level:    'error',
    message:  message.substring(0, 500),
  }).then(() => {}).catch(() => {}); // не критично если не записалось
}

// Перехватываем необработанные ошибки
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT]', err.message);
  trackError('uncaughtException', err.message);
});

process.on('unhandledRejection', (reason) => {
  const msg = reason?.message || String(reason);
  console.error('[UNHANDLED]', msg);
  trackError('unhandledRejection', msg);
});

// Функция для логирования важных событий
async function logToSupabase(category, level, message, data = null) {
  try {
    await supabase.from('bot_logs').insert({
      ts:       Date.now(),
      category,
      level,    // 'info' | 'warn' | 'error'
      message:  message.substring(0, 500),
      data:     data ? JSON.stringify(data).substring(0, 1000) : null,
    });
  } catch(e) { /* не критично */ }
}

// ── HEALTH MONITOR ─────────────────────────────────────────
let lastCheckTime = Date.now();
let totalChecks = 0;
cron.schedule('*/30 * * * *', async () => {
  const now = Date.now();
  const minsSinceCheck = Math.round((now - lastCheckTime) / 60000);
  if (minsSinceCheck > 35) {
    // Бот завис — отправляем алерт (checkSignals занимает до 20 минут)
    await sendTelegram(`⚠️ АЛЕРТ: бот не проверял сигналы ${minsSinceCheck} минут! Проверь сервер.`);
  }
});

cron.schedule('*/5 * * * *', () => { checkSignals().catch(e => { console.error('checkSignals error:', e.message); trackError('checkSignals', e.message); }); });

// Синхронизация с Bybit каждые 3 минуты (только при AutoExec)
cron.schedule('*/3 * * * *', async () => {
  if (!autoExecSignals || store.observeMode || !store.openTrades?.length) return;
  try {
    const BybitClient = require('./bybit-client');
    const bybit = new BybitClient();
    const positions = await bybit.getPositions();
    const openOnBybit = new Set((positions||[]).filter(p=>parseFloat(p.size)>0).map(p=>p.symbol));
    const stillOpen=[], toClose=[];
    for (const trade of store.openTrades) {
      const sym = (trade.instId||'').replace('-USDT-SWAP','USDT');
      if (openOnBybit.has(sym)) stillOpen.push(trade);
      else toClose.push(trade);
    }
    if (toClose.length > 0) {
      for (const trade of toClose) {
        trade.outcome='closed_on_exchange'; trade.closedAt=Date.now(); trade.pnl=0;
        pushTradeHistory(trade);
        supabase.from('open_trades').delete()
          .eq('inst_id', trade.instId).eq('ts', trade.ts)
          .then(() => {}).catch(e => console.error('[Bybit Sync] open_trades delete error:', e.message));
        console.log('[Bybit Sync] '+trade.instId+' закрыта → убрана из store и Supabase');
      }
      store.openTrades = stillOpen;
    }
  } catch(e) { console.error('[Bybit Sync]', e.message); trackError('BybitSync', e.message); }
});

// Paper trading — проверяем виртуальные сделки каждые 5 минут
cron.schedule('*/5 * * * *', () => {
  if (store.observeMode) {
    checkPaperTrades().catch(e => console.error('checkPaperTrades error:', e.message));
  }
});

// Каждые 15 минут
cron.schedule('*/15 * * * *', () => {
  checkOutcomes().catch(e => console.error('checkOutcomes error:', e.message));
  checkTradeTimers().catch(e => console.error('checkTradeTimers error:', e.message));
  checkTrailingStop().catch(e => console.error('checkTrailingStop error:', e.message));
});
// Каждые 30 минут — RSS новости

// Каждый час (в 00 минут)
cron.schedule('0 */2 * * *', () => { checkAnomalies().catch(e => console.error('checkAnomalies error:', e.message)); });

// Ежедневный отчёт в 21:00 Алматы (16:00 UTC)
// ── ЛУЧШИЙ СИГНАЛ ДНЯ — накапливаем и публикуем в 16:00 Алматы ──
let bestSignalOfDay = null; // { sig, confidence, ts }

function updateBestSignalOfDay(sig) {
  if (!sig || !sig.confidence) return;
  const today = getAlmatyDate();
  // Сбрасываем если новый день
  if (bestSignalOfDay && bestSignalOfDay.date !== today) {
    bestSignalOfDay = null;
  }
  if (!bestSignalOfDay || sig.confidence > bestSignalOfDay.confidence) {
    bestSignalOfDay = { sig, confidence: sig.confidence, date: today, ts: Date.now() };
    console.log(`[BEST SIGNAL] Новый лучший за ${today}: ${sig.instId} conf=${sig.confidence}%`);
  }
}

// 16:00 Алматы = 11:00 UTC — публикуем лучший сигнал дня
cron.schedule('0 11 * * *', async () => {
  try {
    const today = getAlmatyDate();
    if (!bestSignalOfDay || bestSignalOfDay.date !== today) {
      console.log('[CHANNEL] Нет лучшего сигнала за сегодня');
      return;
    }
    const sig = bestSignalOfDay.sig;
    const coin = (sig.instId || '').replace('-USDT-SWAP', '');
    const dir  = sig.direction === 'long' ? '🟢 LONG' : '🔴 SHORT';
    const emoji = sig.direction === 'long' ? '📈' : '📉';
    const filled = Math.round(sig.confidence / 10);
    const bar    = '█'.repeat(filled) + '░'.repeat(10 - filled);
    const stratName = (sig.strategy || '').replace(/[0-9️⃣]/g, '').trim().split('(')[0].trim();
    const signalTime = new Date(bestSignalOfDay.ts + 5*3600*1000)
      .toISOString().substr(11, 5);

    const post =
      `${emoji} *Signal of the Day — ${today}*\n` +
      `━━━━━━━━━━━━━━━\n` +
      `*${coin}/USDT — ${dir}*\n\n` +
      `💰 Entry:  \`$${sig.price}\`\n` +
      `🎯 TP1:    \`$${sig.tp1}\`\n` +
      `🎯 TP2:    \`$${sig.tp2}\`\n` +
      `🛡 SL:     \`$${sig.sl}\`\n` +
      `━━━━━━━━━━━━━━━\n` +
      `📊 Confidence: *${sig.confidence}%*\n` +
      `[${bar}]\n` +
      `📌 ${stratName}\n` +
      `🕐 Signal at ${signalTime} ALM\n` +
      `━━━━━━━━━━━━━━━\n` +
      `_Best bot signal today_\n` +
      `_Apex Algo Fund — automated 24/7_\n` +
      `@ApexAlgoFund`;

    await sendToChannel(post);
    console.log(`[CHANNEL] Лучший сигнал дня опубликован: ${coin} conf=${sig.confidence}%`);
  } catch(e) { console.error('[CHANNEL] best signal error:', e.message); }
});

// 20:00 Алматы = 15:00 UTC — лучший результат дня в канал
cron.schedule('0 15 * * *', async () => {
  try {
    const today    = getAlmatyDate();
    const dayStart = new Date(today + 'T00:00:00+05:00').getTime();

    const { data: todayTrades } = await supabase
      .from('paper_trades')
      .select('inst_id, direction, outcome, pnl, strategy, price, ts, closed_at')
      .gte('ts', dayStart)
      .not('outcome', 'is', null)
      .order('pnl', { ascending: false });

    const closed  = (todayTrades || []).filter(t => t.outcome !== 'open');
    const wins    = closed.filter(t => t.outcome === 'tp1' || t.outcome === 'tp2');
    const losses  = closed.filter(t => t.outcome === 'sl');
    const total   = closed.length;
    const wr      = total ? Math.round(wins.length / total * 100) : 0;
    const totalPnl = closed.reduce((s, t) => s + ((t.pnl || 0) * 5), 0);
    const pnlStr  = (totalPnl >= 0 ? '+' : '') + totalPnl.toFixed(1) + '%';
    const wrEmoji = wr >= 60 ? '🟢' : wr >= 45 ? '🟡' : '🔴';

    const best = wins.sort((a, b) => (b.pnl || 0) - (a.pnl || 0))[0];
    let post = '';

    if (best) {
      const coin      = (best.inst_id || '').replace('-USDT-SWAP', '');
      const dir       = best.direction === 'long' ? '🟢 LONG' : '🔴 SHORT';
      const pnlBest   = ((best.pnl || 0) * 5);
      const pnlBestStr = (pnlBest >= 0 ? '+' : '') + pnlBest.toFixed(2) + '%';
      const stratName = (best.strategy || '').replace(/[0-9️⃣🔟]/g, '').trim().split('(')[0].trim();
      const durationMs  = (best.closed_at || Date.now()) - (best.ts || Date.now());
      const durationMin = Math.round(durationMs / 60000);
      const durationStr = durationMin >= 60
        ? `${Math.floor(durationMin/60)}ч ${durationMin%60}мин`
        : `${durationMin}мин`;
      const outcomeLabel = best.outcome === 'tp2' ? 'TP2 🏆' : 'TP1 ✅';

      post =
        `🏆 *Best Trade of the Day — ${today}*\n` +
        `━━━━━━━━━━━━━━━\n` +
        `*${coin}/USDT — ${dir}*\n\n` +
        `💰 Entry:  \`$${best.price}\`\n` +
        `🎯 Exit: ${outcomeLabel}\n` +
        `📈 P&L:  \`${pnlBestStr}\` (5x)\n` +
        `⏱ Duration: ${durationStr}\n` +
        `📌 ${stratName}\n` +
        `━━━━━━━━━━━━━━━\n` +
        `📊 *Daily Stats:*\n` +
        `${wrEmoji} Win Rate: *${wr}%* (${wins.length}✅ / ${losses.length}❌)\n` +
        `💹 PnL: \`${pnlStr}\`\n` +
        `Signals: ${total}\n` +
        `━━━━━━━━━━━━━━━\n` +
        `_Apex Algo Fund — building from demo to fund_\n` +
        `@ApexAlgoFund`;
    } else {
      post =
        `📊 *Daily Results — ${today}*\n` +
        `━━━━━━━━━━━━━━━\n` +
        `${wrEmoji} Win Rate: *${wr}%* (${wins.length}✅ / ${losses.length}❌)\n` +
        `💹 PnL: \`${pnlStr}\`\n` +
        `Signals: ${total}\n` +
        `━━━━━━━━━━━━━━━\n` +
        `_Bad days happen. The system keeps running._\n` +
        `@ApexAlgoFund`;
    }

    await sendToChannel(post);
    console.log(`[CHANNEL] Итог дня: WR=${wr}% best=${best?.inst_id || 'none'}`);
  } catch(e) { console.error('[CHANNEL] evening summary error:', e.message); }
});

cron.schedule('0 16 * * *', async () => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const todayTrades = store.tradeHistory.filter(t => {
      const d = new Date(t.closedAt || t.ts).toISOString().split('T')[0];
      return d === today;
    });
    const wins   = todayTrades.filter(t => t.outcome === 'tp1' || t.outcome === 'tp2').length;
    const losses = todayTrades.filter(t => t.outcome === 'sl').length;
    const riskUSD = store.accountBalance * store.riskPct / 100;
    const pnlUSD  = wins * riskUSD * 2 - losses * riskUSD;
    await sendTelegram(
      `📅 ДНЕВНОЙ ИТОГ — ${today}
` +
      `━━━━━━━━━━━━━━━━━━━━━━
` +
      `Сделок: ${todayTrades.length} | ✅${wins} ❌${losses}
` +
      `P&L: ${pnlUSD >= 0 ? '+' : ''}$${pnlUSD.toFixed(0)}
` +
      `Баланс бота: $${store.accountBalance.toLocaleString()}`
    );
  } catch(e) { console.error('daily report error:', e.message); }
});

// Каждые 2 часа — whale активность

// Каждый день в 07:00 UTC = 12:00 Алматы
cron.schedule('0 7 * * *', () => { dailyReport().catch(e => console.error('dailyReport error:', e.message)); });

// Вечерний дебрифинг — 16:00 UTC = 21:00 Алматы

// Агент Психолог — раз в день в 19:00 Алматы (14:00 UTC)
cron.schedule('0 14 * * *', () => { psychologistAgent().catch(e => console.error('psychologist error:', e.message)); });

// Агент Аудитор — каждое воскресенье в 10:00 UTC (15:00 Алматы)
cron.schedule('0 10 * * 0', () => { auditorAgent().catch(e => console.error('auditor error:', e.message)); });

// Heartbeat — каждые 5 минут (мониторинг живости)
cron.schedule('*/5 * * * *', () => { heartbeat().catch(()=>{}); });

// Еженедельный P&L отчёт — воскресенье 18:00 UTC = 23:00 Алматы
cron.schedule('0 18 * * 0', () => { weeklyPnLReport().catch(e => console.error('weeklyPnL error:', e.message)); });

// COT Report — обновляем каждую субботу в 00:00 Алматы (пятница 18:00 ET — после публикации CFTC)
cron.schedule('0 0 * * 6', async () => {
  console.log('[COT] Еженедельное обновление COT Report...');
  cotCache.ts = 0; // сбрасываем кэш
  const data = await fetchCOTReport().catch(e => { console.error('[COT] cron error:', e.message); return {}; });
  if (Object.keys(data).length) {
    let msg = `📊 *COT Report обновлён*\n\n`;
    for (const [asset, d] of Object.entries(data)) {
      const emoji = d.signal === 'bullish' ? '🟢' : d.signal === 'bearish' ? '🔴' : '🟡';
      msg += `${emoji} *${asset}*: inst net ${d.netInst > 0 ? '+' : ''}${d.netInst.toLocaleString()} → \`${d.signal}\`\n`;
    }
    msg += `\n_Источник: CFTC cftc.gov_`;
    await sendTelegram(msg).catch(() => {});
  }
});

// Weekly drawdown check — каждый час
cron.schedule('0 * * * *', async () => {
  try {
    const dd = checkWeeklyDrawdown();
    if (dd.isOverLimit && !store.emergencyStop) {
      store.emergencyStop = true;
      saveSettings();
      await sendTelegram(
        `🚨 АВТО-СТОП: WEEKLY DRAWDOWN\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `Потери за неделю: -${dd.weekLoss}%\n` +
        `Лимит: 8%\n\n` +
        `Бот автоматически остановлен.\n` +
        `Включить: /resume`
      );
    }
  } catch(e) { console.error('weekly DD error:', e.message); }
});

// ── Stocks сканирование — каждые 15 минут пока рынок открыт ─
cron.schedule('*/15 * * * *', async () => {
  if (!stocksEngine) return;
  if (!stocksEngine.isMarketOpen()) return;

  const alpacaKey    = process.env.ALPACA_KEY;
  const alpacaSecret = process.env.ALPACA_SECRET;
  if (!alpacaKey || !alpacaSecret) return;

  try {
    // Получаем изменение BTC за последний час для корреляции
    let btcChange = 0;
    try {
      const btcBars = await getOKXKlinesCached('BTC-USDT-SWAP', '1H', 2);
      if (btcBars.length >= 2) {
        btcChange = (btcBars[1].close - btcBars[0].close) / btcBars[0].close * 100;
      }
    } catch(e) {}

    const signals = await stocksEngine.scanStocks(alpacaKey, alpacaSecret, btcChange);
    if (!signals.length) return;

    // Берём только лучший сигнал (confidence >= 75)
    const best = signals.find(s => s.confidence >= 75);
    if (!best) return;

    const msg = stocksEngine.formatStockSignal(best);
    await sendTelegram(`📈 STOCKS SIGNAL\n${msg}`);
    console.log(`[STOCKS] Сигнал отправлен: ${best.symbol} ${best.direction} ${best.confidence}%`);
  } catch(e) {
    console.error('[STOCKS] scan error:', e.message);
  }
});

// Загружаем открытые сделки из Supabase при старте + Bybit reconciliation
supabase.from('open_trades').select('*').then(async ({ data }) => {
  if (data?.length) {
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const recent = data.filter(t => +t.ts >= dayAgo);
    store.openTrades = recent.map(t => ({
      ts: t.ts, instId: t.inst_id, symbol: t.symbol,
      strategy: t.strategy, direction: t.direction,
      price: t.price, sl: t.sl, tp1: t.tp1, tp2: t.tp2,
      confidence: t.confidence,
    }));
    // Удаляем из Supabase строки старше 24ч (они уже закрыты)
    const stale = data.filter(t => +t.ts < dayAgo);
    for (const t of stale) {
      supabase.from('open_trades').delete()
        .eq('inst_id', t.inst_id).eq('ts', t.ts)
        .then(() => {}).catch(() => {});
    }
    console.log(`[START] Загружено ${recent.length} из ${data.length} открытых сделок (24ч)`);
  }

  // Bybit reconciliation — убираем сделки, закрытые пока бот не работал
  if (!store.openTrades?.length) return;
  try {
    const BybitClient = require('./bybit-client');
    const bybit = new BybitClient();
    const positions = await bybit.getPositions();
    const openOnBybit = new Set((positions||[]).filter(p => parseFloat(p.size) > 0).map(p => p.symbol));
    const stillOpen = [], staleBybit = [];
    for (const trade of store.openTrades) {
      const sym = (trade.instId||'').replace('-USDT-SWAP','USDT');
      if (openOnBybit.has(sym)) stillOpen.push(trade);
      else staleBybit.push(trade);
    }
    if (staleBybit.length > 0) {
      for (const trade of staleBybit) {
        supabase.from('open_trades').delete()
          .eq('inst_id', trade.instId).eq('ts', trade.ts)
          .then(() => {}).catch(() => {});
        console.log(`[START Bybit Recon] ${trade.instId} не найдена на Bybit → убрана`);
      }
      store.openTrades = stillOpen;
      console.log(`[START Bybit Recon] убрано ${staleBybit.length} устаревших сделок`);
    } else {
      console.log(`[START Bybit Recon] все ${stillOpen.length} сделок подтверждены на Bybit`);
    }
  } catch(e) {
    console.log('[START Bybit Recon] недоступен — пропуск:', e.message);
  }
}).catch(e => console.error('[START] open_trades load error:', e.message));

// Восстанавливаем cooldowns из недавних сигналов (защита от повторных входов после рестарта)
supabase.from('signals')
  .select('inst_id, ts')
  .gte('ts', Date.now() - COOLDOWN_MIN * 60 * 1000)
  .then(({ data }) => {
    if (data?.length) {
      data.forEach(s => {
        store.cooldowns[s.inst_id] = parseInt(s.ts);
      });
      console.log(`[START] Восстановлено ${data.length} cooldowns из сигналов`);
    }
  })
  .catch(e => console.error('[START] cooldown restore error:', e.message));

// Первый запуск сразу при старте для проверки
setTimeout(() => {
  checkSignals().catch(e => console.error('Initial checkSignals error:', e.message));
}, 10000);
// Запускаем опрос команд Telegram
(async () => {
  try {
    await httpPost(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/deleteWebhook`,
      { drop_pending_updates: true },
      { 'Content-Type': 'application/json' }
    );
    console.log('[TG] Webhook удалён, запускаю polling...');
  } catch(e) { console.error('[TG] deleteWebhook error:', e.message); }
  await new Promise(r => setTimeout(r, 2000));
  pollTelegramUpdates();

  // Запускаем Delta Tracker — подписываемся на топ монеты
  if (deltaTracker) {
    const TOP_DELTA_COINS = [
      'BTC-USDT-SWAP', 'ETH-USDT-SWAP', 'SOL-USDT-SWAP',
      'BNB-USDT-SWAP', 'XRP-USDT-SWAP', 'DOGE-USDT-SWAP',
      'TON-USDT-SWAP', 'ADA-USDT-SWAP', 'AVAX-USDT-SWAP',
      'LINK-USDT-SWAP', 'DOT-USDT-SWAP', 'NEAR-USDT-SWAP',
      'SUI-USDT-SWAP', 'APT-USDT-SWAP', 'OP-USDT-SWAP',
      'ARB-USDT-SWAP', 'INJ-USDT-SWAP', 'TIA-USDT-SWAP',
      'WLD-USDT-SWAP', 'HYPE-USDT-SWAP',
    ];
    deltaTracker.start(TOP_DELTA_COINS);
    console.log('[DELTA] Tracker запущен — подписан на', TOP_DELTA_COINS.length, 'монет');
  }

  // Запускаем Footprint Engine — те же монеты что и Delta
  if (footprint) {
    const TOP_FP_COINS = [
      'BTC-USDT-SWAP', 'ETH-USDT-SWAP', 'SOL-USDT-SWAP',
      'BNB-USDT-SWAP', 'XRP-USDT-SWAP', 'DOGE-USDT-SWAP',
    ];
    footprint.start(TOP_FP_COINS);
    console.log('[FOOTPRINT] Engine запущен — подписан на', TOP_FP_COINS.length, 'монет');
  }
})();

if (autoExecSignals) {
  autoExecSignals.emit('inject_deps', { telegramBot: null, telegramChatId: CHAT_ID, supabaseClient: supabase });

  // Слушаем реальные закрытия с Bybit — обновляем store реальными данными
  autoExecSignals.on('position_closed', (data) => {
    try {
      // Убираем из openTrades
      store.openTrades = store.openTrades.filter(t =>
        t.instId !== data.instId && t.symbol !== data.symbol.replace('USDT','')
      );

      // Синхронизируем реальный баланс Bybit → store
      if (data.realBalance && data.realBalance > 0) {
        const oldBalance = store.accountBalance;
        store.accountBalance = Math.round(data.realBalance);
        if (Math.abs(oldBalance - store.accountBalance) > 1) {
          console.log(`[AutoExec→Store] Баланс обновлён: $${oldBalance} → $${store.accountBalance}`);
          saveSettings();
        }
      }

      // Добавляем в историю с реальными данными Bybit
      const trade = {
        instId:     data.instId,
        symbol:     data.symbol.replace('USDT',''),
        direction:  data.side === 'Buy' ? 'long' : 'short',
        price:      data.entryPrice,
        closePrice: data.exitPrice,
        sl:         null,
        tp1:        null,
        outcome:    data.outcome,
        pnl:        parseFloat((data.pnlPct || 0).toFixed(2)),
        pnlUSD:     parseFloat((data.pnl || 0).toFixed(2)),
        strategy:   data.strategy,
        confidence: data.confidence,
        ts:         data.openedAt ? new Date(data.openedAt).getTime() : Date.now(),
        closedAt:   data.closedAt ? new Date(data.closedAt).getTime() : Date.now(),
        source:     'bybit_real',
      };
      pushTradeHistory(trade);
      console.log(`[AutoExec→Store] ${data.symbol} закрыт: ${data.outcome} PnL=$${data.pnl?.toFixed(2)}`);
    } catch(e) { console.error('[AutoExec→Store] error:', e.message); }
  });
}

// === AutoExec: inject зависимостей + Telegram команды ===
if (autoExecSignals) {
  // Передаём зависимости в autoexec
  autoExecSignals.emit('inject_deps', {
    telegramBot:    null,
    telegramChatId: CHAT_ID,
    supabaseClient: supabase,
    propMode:       store.propMode, // передаём prop mode
  });

  // Переопределяем notify в autoexec через наш sendTelegram
  // (autoexec сам отправит через свой notify после inject)

  console.log('[AutoExec] Зависимости переданы');

  // Telegram команды autoexec
  // Добавляем в polling обработчик (см. handleCommand ниже)
}

// Загружаем подписки пользователей из Supabase (персональные on/off модулей)
loadSubscriptions().catch(e => console.error('[SUBS] initial load error:', e.message));
// Периодически обновляем кэш подписок (на случай если кто-то изменит напрямую в БД)
setInterval(() => loadSubscriptions().catch(e => console.error('[SUBS] refresh error:', e.message)), 5 * 60 * 1000);

process.on('uncaughtException', e => {
  console.error('[CRASH PREVENTED]', e.message);
});
process.on('unhandledRejection', e => {
  console.error('[PROMISE ERROR]', e?.message || e);
});