// ════════════════════════════════════════════════════════════════════════
//  COPY TRADING TRACKER — подпроект к Crypto Radar
//  Отслеживает позиции топ-трейдеров на Hyperliquid и Binance Futures.
//  Полностью изолирован от index.js: свой state, свой cycle, свой rate-limiter.
//
//  Публичные источники (без API-ключей):
//    • Hyperliquid leaderboard — https://stats-data.hyperliquid.xyz/Mainnet/leaderboard
//    • Hyperliquid позиции     — POST https://api.hyperliquid.xyz/info
//                                body: {"type":"clearinghouseState","user":"0x..."}
//    • Binance leaderboard     — POST https://www.binance.com/bapi/futures/v1/
//                                public/future/leaderboard/getLeaderboardRank
//                                (неофициальный endpoint — может отвалиться без предупреждения)
//    • Binance позиции         — POST .../leaderboard/getOtherPosition
//
//  Env: TELEGRAM_TOKEN, CHAT_ID, CHAT_ID_2 (всё берётся из уже загруженного .env)
// ════════════════════════════════════════════════════════════════════════

const axios = require('axios');

// ── ENV ─────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_IDS       = [process.env.CHAT_ID, process.env.CHAT_ID_2].filter(Boolean);
const GROQ_KEY       = process.env.GROQ_KEY;

if (!TELEGRAM_TOKEN || !CHAT_IDS.length) {
  console.warn('[COPYTRADER] ⚠️  TELEGRAM_TOKEN или CHAT_ID не заданы — алерты работать не будут.');
}

// ── НАСТРОЙКИ ───────────────────────────────────────────────────────────
const MIN_PNL_MONTH_PCT = 100;                  // PnL за месяц, % (было 50 — слишком много трейдеров)
const MIN_ACCOUNT_USD   = 250_000;              // минимальный размер аккаунта трейдера
const MIN_POSITION_USD  = 1_000_000;            // фильтр размера позиции (было 500k — много шума)
const MAX_TRACKED       = 15;                   // сколько трейдеров держим одновременно
const CHECK_INTERVAL_MS      = 5 * 60 * 1000;   // каждые 5 минут (было 2 — слишком часто)
const LEADERBOARD_REFRESH_MS = 60 * 60 * 1000;  // раз в час — обновляем список трейдеров
const ALERT_COOLDOWN_MS      = 8 * 60 * 60 * 1000; // не чаще 1 алерта на трейдера в 8ч (было 4)
const MAX_REQS_PER_MIN       = 30;              // rate-limit (общий на модуль)

// Whitelist из топ-50 монет по объёму (обновлять вручную при сдвигах рынка)
const TOP50_COINS = new Set([
  'BTC','ETH','SOL','XRP','BNB','DOGE','ADA','TRX','AVAX','LINK',
  'DOT','MATIC','SHIB','LTC','TON','ICP','BCH','UNI','NEAR','APT',
  'ATOM','ETC','HBAR','FIL','XLM','ARB','OP','VET','MKR','INJ',
  'IMX','TIA','SUI','SEI','RUNE','AAVE','LDO','RNDR','WIF','PEPE',
  'FET','BONK','FTM','ALGO','GRT','SAND','AXS','STX','KAS','JUP',
]);

// Выключить Binance можно одним флагом, если вдруг endpoint заблокируют
const ENABLE_BINANCE = true;

// ── STATE ───────────────────────────────────────────────────────────────
const state = {
  enabled: true,                    // 🔌 если false — cycle ничего не делает
  // id = `${source}:${address}` → { source, address, name, wr, pnlMonth, accountValue, positions: Map }
  whales: new Map(),
  lastAlert: new Map(),             // id → timestamp
  reqLog: [],                       // timestamps for rate-limit
  lastLeaderboardUpdate: 0,
  stats: { opens: 0, closes: 0, errors: 0, cycles: 0, aiCalls: 0 },
};

// ── RATE LIMITER (sliding window) ───────────────────────────────────────
async function throttle() {
  const now = Date.now();
  state.reqLog = state.reqLog.filter(t => now - t < 60_000);
  if (state.reqLog.length >= MAX_REQS_PER_MIN) {
    const waitMs = 60_000 - (now - state.reqLog[0]) + 50;
    console.log(`[COPYTRADER] rate-limit ${MAX_REQS_PER_MIN}/min — жду ${Math.round(waitMs/1000)}с`);
    await new Promise(r => setTimeout(r, waitMs));
    return throttle();
  }
  state.reqLog.push(now);
}

async function httpGet(url, params) {
  await throttle();
  try {
    const resp = await axios.get(url, {
      params, timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0 crypto-radar-copytrader' },
    });
    return resp.data;
  } catch(e) {
    console.error(`[CT GET] ${url}: ${e.message}`);
    state.stats.errors++;
    return null;
  }
}

async function httpPost(url, body, extraHeaders = {}) {
  await throttle();
  try {
    const resp = await axios.post(url, body, {
      timeout: 15000,
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 crypto-radar-copytrader', ...extraHeaders },
    });
    return resp.data;
  } catch(e) {
    console.error(`[CT POST] ${url}: ${e.message}`);
    state.stats.errors++;
    return null;
  }
}

// Функция отправки, которую index.js может подменить через setSender()
// чтобы уважать персональные подписки пользователей на модуль "whales"
let externalSender = null;
function setSender(fn) { externalSender = fn; }

// ── TELEGRAM ────────────────────────────────────────────────────────────
async function sendTelegram(text) {
  // Если index.js передал внешний sender — используем его (учитывает подписки)
  if (externalSender) {
    try { await externalSender(text, 'whales'); } catch(e) { console.error('[CT extSender]', e.message); }
    console.log(`[COPYTRADER TG] ${text.split('\n')[0]}`);
    return;
  }
  // Fallback: отправляем всем (используется если index.js не подменил sender)
  if (!TELEGRAM_TOKEN || !CHAT_IDS.length) return;
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  for (const id of CHAT_IDS) {
    try {
      await axios.post(url, { chat_id: id, text, disable_web_page_preview: true }, { timeout: 10000 });
    } catch(e) {
      console.error(`[CT TG] ${e.message}`);
    }
  }
  console.log(`[COPYTRADER TG] ${text.split('\n')[0]}`);
}

// ── GROQ AI (для анализа сделок кита) ───────────────────────────────────
async function callGroq(prompt) {
  if (!GROQ_KEY) return null;
  try {
    const r = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      { model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: prompt }], max_tokens: 250, temperature: 0.4 },
      { headers: { Authorization: `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' }, timeout: 12000 }
    );
    state.stats.aiCalls++;
    return r.data?.choices?.[0]?.message?.content?.trim() || null;
  } catch(e) {
    console.error('[CT GROQ]', e.message);
    return null;
  }
}

async function analyzeWhalePosition(whale, pos) {
  const prompt =
    `Ты опытный крипто-трейдер деривативов. Топ-трейдер с PnL +${whale.pnlMonth}%/мес ` +
    `только что открыл ${pos.side} ${pos.coin} по цене $${pos.entryPx} ` +
    `с плечом ${pos.leverage}x на сумму $${Math.round(pos.sizeUsd/1000)}K.\n\n` +
    `Дай КОРОТКИЙ анализ (3-4 строки, без воды, на русском):\n` +
    `1. Стоит ли заходить следом? (ДА/НЕТ + одна причина)\n` +
    `2. На каком уровне фиксировать прибыль (TP)? (укажи ОДНУ конкретную цену)\n` +
    `3. На каком уровне ставить стоп-лосс (SL)? (укажи ОДНУ конкретную цену, не более 2% от входа)\n` +
    `Без длинных объяснений, только цифры и краткий вывод.`;
  return await callGroq(prompt);
}

// ── FORMAT HELPERS ──────────────────────────────────────────────────────
function shortAddr(addr) {
  if (!addr) return '—';
  const s = String(addr);
  if (s.startsWith('0x') && s.length >= 10) return s.slice(0, 6) + '…' + s.slice(-4);
  return s.slice(0, 10);
}
function fmtUsd(v) {
  if (v == null || !isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1e9) return `$${(v/1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(v/1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(v/1e3).toFixed(1)}K`;
  return `$${v.toFixed(2)}`;
}
function fmtPx(p) {
  if (p == null) return '—';
  if (p >= 1000) return '$' + Math.round(p).toLocaleString('en-US');
  if (p >= 1)    return '$' + p.toFixed(3);
  if (p >= 0.01) return '$' + p.toFixed(5);
  return '$' + p.toFixed(8);
}
function timeAgo(ts) {
  const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (m < 1)  return 'только что';
  if (m < 60) return `${m} мин назад`;
  const h = Math.floor(m/60);
  return `${h} ч назад`;
}

// ══════════════════════════════════════════════════════════════════════
//  HYPERLIQUID
// ══════════════════════════════════════════════════════════════════════
async function fetchHyperliquidLeaderboard() {
  const data = await httpGet('https://stats-data.hyperliquid.xyz/Mainnet/leaderboard');
  if (!data) return [];
  // Endpoint иногда отдаёт {leaderboardRows: [...]}, иногда массив напрямую
  const rows = Array.isArray(data) ? data : (data.leaderboardRows || []);
  const out = [];

  for (const r of rows) {
    try {
      const addr = (r.ethAddress || r.user || r.address || '').toLowerCase();
      if (!/^0x[a-f0-9]{40}$/.test(addr)) continue;

      const displayName = r.displayName || null;
      const accountValue = parseFloat(r.accountValue || 0);

      // Формат windowPerformances: [["day",{pnl,roi,vlm}], ["week",{}], ["month",{}], ["allTime",{}]]
      let monthRoi = null;
      const perf = r.windowPerformances || [];
      for (const item of perf) {
        if (!Array.isArray(item) || item.length < 2) continue;
        const [period, p] = item;
        if (period === 'month' && p?.roi != null) {
          monthRoi = parseFloat(p.roi) * 100;  // roi приходит как доля
          break;
        }
      }
      if (monthRoi == null) continue;
      if (monthRoi < MIN_PNL_MONTH_PCT) continue;
      if (accountValue < MIN_ACCOUNT_USD) continue;

      out.push({
        source: 'hyperliquid',
        address: addr,
        name: displayName || shortAddr(addr),
        wr: null,                    // HL leaderboard не отдаёт WR
        pnlMonth: Math.round(monthRoi),
        accountValue,
      });
    } catch(_) { /* skip broken row */ }
  }

  out.sort((a,b) => b.pnlMonth - a.pnlMonth);
  return out.slice(0, MAX_TRACKED);
}

async function fetchHyperliquidPositions(address) {
  const data = await httpPost('https://api.hyperliquid.xyz/info', {
    type: 'clearinghouseState',
    user: address,
  });
  if (!data?.assetPositions) return null;
  const positions = new Map();

  for (const ap of data.assetPositions) {
    const p = ap.position;
    if (!p) continue;
    const szi = parseFloat(p.szi);            // signed size в монетах (+long / -short)
    if (!szi) continue;
    const coin = p.coin;
    if (!TOP50_COINS.has(coin)) continue;
    const entryPx = parseFloat(p.entryPx || 0);
    if (!entryPx) continue;
    const sizeUsd = Math.abs(szi * entryPx);
    if (sizeUsd < MIN_POSITION_USD) continue;

    positions.set(coin, {
      coin,
      side: szi > 0 ? 'LONG' : 'SHORT',
      szi, sizeUsd, entryPx,
      leverage: parseFloat(p.leverage?.value || 1),
    });
  }
  return positions;
}

// ══════════════════════════════════════════════════════════════════════
//  BINANCE FUTURES LEADERBOARD (неофициальный bapi, работает стабильно,
//  но может быть заблокирован Binance без предупреждения)
// ══════════════════════════════════════════════════════════════════════
async function fetchBinanceLeaderboard() {
  if (!ENABLE_BINANCE) return [];
  const url = 'https://www.binance.com/bapi/futures/v1/public/future/leaderboard/getLeaderboardRank';
  const body = {
    isShared: true,         // только те, кто расшарил позиции
    periodType: 'MONTHLY',
    statisticsType: 'ROI',
    tradeType: 'PERPETUAL', // USDⓈ-M перпетуалы
    isTrader: false,
  };
  const data = await httpPost(url, body);
  if (!data?.data || !Array.isArray(data.data)) return [];

  const out = [];
  for (const r of data.data) {
    try {
      if (!r.positionShared) continue;
      // roiValue может прийти как доля (0.65 = 65%) или уже как процент (65)
      const raw = parseFloat(r.roiValue || 0);
      const roi = Math.abs(raw) <= 100 ? raw * 100 : raw;
      if (!isFinite(roi) || roi < MIN_PNL_MONTH_PCT) continue;

      const pnlVal = parseFloat(r.pnlValue || 0);
      if (pnlVal < MIN_ACCOUNT_USD) continue;

      out.push({
        source: 'binance',
        address: r.encryptedUid,
        name: r.nickName || shortAddr(r.encryptedUid),
        wr: null,
        pnlMonth: Math.round(roi),
        accountValue: pnlVal,
      });
    } catch(_) { /* skip */ }
  }
  out.sort((a,b) => b.pnlMonth - a.pnlMonth);
  return out.slice(0, MAX_TRACKED);
}

async function fetchBinancePositions(uid) {
  if (!ENABLE_BINANCE) return null;
  const url = 'https://www.binance.com/bapi/futures/v1/public/future/leaderboard/getOtherPosition';
  const data = await httpPost(url, { encryptedUid: uid, tradeType: 'PERPETUAL' });
  const list = data?.data?.otherPositionRetList || data?.data?.otherPositions;
  if (!Array.isArray(list)) return null;

  const positions = new Map();
  for (const p of list) {
    const symbol = String(p.symbol || '');
    const coin   = symbol.replace(/USDT$|BUSD$|USDC$/, '');
    if (!TOP50_COINS.has(coin)) continue;
    const amt   = parseFloat(p.amount);
    const entry = parseFloat(p.entryPrice);
    const mark  = parseFloat(p.markPrice || entry);
    if (!amt || !entry) continue;
    const sizeUsd = Math.abs(amt * mark);
    if (sizeUsd < MIN_POSITION_USD) continue;

    positions.set(coin, {
      coin,
      side: amt > 0 ? 'LONG' : 'SHORT',
      szi: amt,
      sizeUsd,
      entryPx: entry,
      leverage: parseFloat(p.leverage || 1),
    });
  }
  return positions;
}

// ══════════════════════════════════════════════════════════════════════
//  DIFF & ALERTS
// ══════════════════════════════════════════════════════════════════════
function canAlert(whaleId) {
  const last = state.lastAlert.get(whaleId) || 0;
  return Date.now() - last >= ALERT_COOLDOWN_MS;
}

async function buildOpenAlert(whale, pos) {
  const arrow = pos.side === 'LONG' ? '📈' : '📉';
  const wrLine = whale.wr != null ? `WR: ${whale.wr}%` : 'WR: —';
  // "Вход для тебя" = чуть хуже цены кита (он уже зашёл, цена уже сдвинулась)
  const slippage = pos.side === 'LONG' ? 1.0005 : 0.9995;
  const entryYou = pos.entryPx * slippage;

  const base =
    `🐋 КИТ ОТКРЫЛ ПОЗИЦИЮ\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `👤 Трейдер: ${whale.name}\n` +
    `📊 ${wrLine} | PnL месяц: +${whale.pnlMonth}%\n` +
    `${arrow} ${pos.side} ${pos.coin} @ ${fmtPx(pos.entryPx)}\n` +
    `📍 Размер: ${fmtUsd(pos.sizeUsd)} | Плечо: ${pos.leverage}x\n` +
    `🎯 Вход для тебя: ~${fmtPx(entryYou)}\n` +
    `🔗 Источник: ${whale.source}\n` +
    `⏰ ${timeAgo(Date.now())}`;

  // AI-анализ — необязательная часть (если Groq лёг — алерт уйдёт без него)
  const ai = await analyzeWhalePosition(whale, pos);
  if (!ai) return base + `\n\n⚠️ AI-анализ недоступен. Не финансовый совет.`;

  return base +
    `\n\n━━━━━━━━━━━━━━━━━━━━\n` +
    `🤖 AI-АНАЛИЗ:\n${ai}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `⚠️ Не финансовый совет — управляй риском сам.`;
}

function buildCloseAlert(whale, oldPos) {
  const arrow = oldPos.side === 'LONG' ? '📈' : '📉';
  return (
    `🐋 КИТ ЗАКРЫЛ ПОЗИЦИЮ\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `👤 Трейдер: ${whale.name}\n` +
    `📊 PnL месяц: +${whale.pnlMonth}%\n` +
    `${arrow} Закрыл: ${oldPos.side} ${oldPos.coin}\n` +
    `📍 Был размер: ${fmtUsd(oldPos.sizeUsd)} @ ${fmtPx(oldPos.entryPx)}\n` +
    `🔗 Источник: ${whale.source}\n` +
    `⏰ ${timeAgo(Date.now())}`
  );
}

// ══════════════════════════════════════════════════════════════════════
//  LEADERBOARD REFRESH
// ══════════════════════════════════════════════════════════════════════
async function refreshLeaderboards() {
  console.log('[COPYTRADER] обновляю leaderboard...');
  const [hl, bn] = await Promise.all([
    fetchHyperliquidLeaderboard().catch(e => (console.error('[HL LB]', e.message), [])),
    fetchBinanceLeaderboard().catch(e => (console.error('[BN LB]', e.message), [])),
  ]);
  const combined = [...hl, ...bn];

  // удаляем тех, кто выпал из рейтинга
  const freshIds = new Set(combined.map(w => `${w.source}:${w.address}`));
  for (const id of state.whales.keys()) {
    if (!freshIds.has(id)) state.whales.delete(id);
  }
  // добавляем/обновляем
  for (const w of combined) {
    const id = `${w.source}:${w.address}`;
    const existing = state.whales.get(id);
    state.whales.set(id, {
      ...w,
      positions: existing?.positions || new Map(),
    });
  }
  state.lastLeaderboardUpdate = Date.now();
  console.log(`[COPYTRADER] отслеживаю ${state.whales.size} трейдеров (HL: ${hl.length}, BN: ${bn.length})`);
}

// ══════════════════════════════════════════════════════════════════════
//  POLL POSITIONS → DIFF → ALERTS
// ══════════════════════════════════════════════════════════════════════
async function pollPositions() {
  const entries = [...state.whales.entries()];
  let opens = 0, closes = 0;

  for (const [id, whale] of entries) {
    try {
      const fresh = whale.source === 'hyperliquid'
        ? await fetchHyperliquidPositions(whale.address)
        : await fetchBinancePositions(whale.address);

      if (!fresh) continue;
      const old = whale.positions || new Map();

      // НОВЫЕ = есть в fresh, нет в old (или сменилась сторона)
      for (const [coin, pos] of fresh) {
        const oldPos = old.get(coin);
        const isNew  = !oldPos || oldPos.side !== pos.side;
        if (isNew && canAlert(id)) {
          await sendTelegram(await buildOpenAlert(whale, pos));
          state.lastAlert.set(id, Date.now());
          opens++;
        }
      }
      // ЗАКРЫТЫЕ = есть в old, нет в fresh
      for (const [coin, oldPos] of old) {
        if (!fresh.has(coin) && canAlert(id)) {
          await sendTelegram(buildCloseAlert(whale, oldPos));
          state.lastAlert.set(id, Date.now());
          closes++;
        }
      }
      whale.positions = fresh;
    } catch(e) {
      console.error(`[COPYTRADER ${id}] ${e.message}`);
    }
  }

  state.stats.opens  += opens;
  state.stats.closes += closes;
  state.stats.cycles++;
  if (opens || closes) console.log(`[COPYTRADER] алертов в цикле: +${opens} open / -${closes} close`);
}

// ══════════════════════════════════════════════════════════════════════
//  MAIN CYCLE
// ══════════════════════════════════════════════════════════════════════
async function cycle() {
  if (!state.enabled) return;     // 🔌 модуль выключен — пропускаем
  try {
    if (Date.now() - state.lastLeaderboardUpdate >= LEADERBOARD_REFRESH_MS) {
      await refreshLeaderboards();
    }
    if (state.whales.size) await pollPositions();
  } catch(e) {
    console.error('[COPYTRADER CYCLE]', e.message);
  }
}

// ══════════════════════════════════════════════════════════════════════
//  PUBLIC API для index.js (команды Telegram, Express endpoint)
// ══════════════════════════════════════════════════════════════════════

/** Обработчик команды /whales. Подключается в index.js одной строкой. */
async function handleWhalesCommand(chatId) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const send = (text) => axios.post(url, { chat_id: chatId, text, disable_web_page_preview: true })
    .catch(e => console.error('[WHALES CMD]', e.message));

  if (!state.whales.size) {
    await send('🐋 КИТЫ\n━━━━━━━━━━━━━━━━\nСписок ещё загружается. Подожди 1–2 минуты и повтори /whales.');
    return;
  }

  const top = [...state.whales.values()]
    .sort((a,b) => (b.pnlMonth||0) - (a.pnlMonth||0))
    .slice(0, 5);

  const lines = top.map((w, i) => {
    const wr = w.wr != null ? `WR ${w.wr}%` : 'WR —';
    const posCount = w.positions?.size || 0;
    const posList  = [...(w.positions?.values?.() || [])]
      .map(p => `${p.side === 'LONG' ? '🟢' : '🔴'}${p.coin}`).join(' ') || '—';
    return `${i+1}. ${w.name}  [${w.source}]\n   📊 ${wr} | +${w.pnlMonth}% / мес\n   💼 ${posCount} поз: ${posList}`;
  }).join('\n\n');

  const statusBadge = state.enabled ? '🟢 ON' : '🔴 OFF';
  await send(
    `🐋 ТОП-5 ТРЕЙДЕРОВ ${statusBadge}\n━━━━━━━━━━━━━━━━━━━\n${lines}\n\n` +
    `👀 Всего отслеживаю: ${state.whales.size}\n` +
    `📊 Алертов за сессию: +${state.stats.opens} / -${state.stats.closes}` +
    (state.stats.aiCalls ? ` | 🤖 AI: ${state.stats.aiCalls}` : '')
  );
}

/** JSON-снимок для вкладки WHALES в дашборде. */
function getTrackedWhalesSnapshot() {
  return {
    updatedAt: Date.now(),
    enabled: state.enabled,
    lastLeaderboardUpdate: state.lastLeaderboardUpdate,
    stats: { ...state.stats, tracked: state.whales.size },
    whales: [...state.whales.values()].map(w => ({
      source: w.source,
      address: w.address,
      name: w.name,
      wr: w.wr,
      pnlMonth: w.pnlMonth,
      accountValue: w.accountValue,
      positions: [...(w.positions?.values?.() || [])].map(p => ({
        coin: p.coin, side: p.side,
        sizeUsd: Math.round(p.sizeUsd),
        entryPx: p.entryPx,
        leverage: p.leverage,
      })),
      lastAlertAt: state.lastAlert.get(`${w.source}:${w.address}`) || null,
    })).sort((a,b) => (b.pnlMonth||0) - (a.pnlMonth||0)),
  };
}

/** Включить/выключить модуль (управляется из index.js админ-командой). */
function setEnabled(on) {
  state.enabled = !!on;
  console.log(`[COPYTRADER] ${state.enabled ? '🟢 ВКЛЮЧЕН' : '🔴 ВЫКЛЮЧЕН'}`);
}
function isEnabled() { return state.enabled; }

// ══════════════════════════════════════════════════════════════════════
//  START
// ══════════════════════════════════════════════════════════════════════
function start() {
  console.log('[COPYTRADER] 🚀 Copy Trading Tracker запущен');
  console.log(`[COPYTRADER] фильтры: PnL мес ≥ ${MIN_PNL_MONTH_PCT}%, позиция ≥ ${fmtUsd(MIN_POSITION_USD)}, топ-50 монет`);
  console.log(`[COPYTRADER] интервал: ${CHECK_INTERVAL_MS/1000}с | cooldown на трейдера: ${ALERT_COOLDOWN_MS/3600_000}ч | rate: ${MAX_REQS_PER_MIN}/мин`);
  // Первый цикл через 15с — чтобы index.js успел поднять Express и Supabase
  setTimeout(() => cycle().catch(e => console.error('[CT first]', e.message)), 15_000);
  setInterval(() => cycle().catch(e => console.error('[CT cycle]', e.message)), CHECK_INTERVAL_MS);
}

start();

module.exports = {
  handleWhalesCommand,
  getTrackedWhalesSnapshot,
  setEnabled,
  isEnabled,
  setSender,
};
