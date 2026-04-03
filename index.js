require('dotenv').config();
const axios = require('axios');
const cron  = require('node-cron');

const { GoogleGenerativeAI } = require('@google/generative-ai');
const genAI = new GoogleGenerativeAI(process.env.GEMINI_KEY);

const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ── Настройки ──────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID        = process.env.CHAT_ID;
const GROQ_KEY       = process.env.GROQ_KEY;

const STRATEGY_SL = {
  '1️⃣ Пробой на импульсе (15m)':   { sl: 1.5, tp1: 3.0, tp2: 4.5 },
  '2️⃣ Liquidity Bounce (1h)':       { sl: 2.5, tp1: 5.0, tp2: 7.5 },
  '3️⃣ Ранний вход (5m)':            { sl: 1.0, tp1: 2.0, tp2: 3.0 },
  '4️⃣ MA20/MA50+RSI (1h)':          { sl: 3.0, tp1: 6.0, tp2: 9.0 },
  '5️⃣ RSI Дивергенция (1h)':        { sl: 2.0, tp1: 4.0, tp2: 6.0 },
  '6️⃣ Funding Extreme (1h)':        { sl: 2.5, tp1: 5.0, tp2: 7.5 },
  '7️⃣ Поглощение на объёме (15m)':  { sl: 1.5, tp1: 3.0, tp2: 4.5 },
};

const S1 = { priceMin: 1.5, oiMin: 2.0, vdeltaMin: 1000000, volMin: 5000000 };
const S2 = { priceMax: -2.5, oiMin: 2.0, vdeltaMax: -1500000, ticksMin: 500, volMin: 10000000 };
const S3 = { oiMin5m: 4.0, vol24Min: 10000000 };

const MIN_VOLUME_24H = 50000000;
const TOP_N          = 15;
const COOLDOWN_MIN   = 30;

// Рейтинг стратегий по win rate
const STRATEGY_META = {
  '1️⃣ Пробой на импульсе (15m)':  { color: '#f87171', rating: 'C', wr: '~40%' },
  '2️⃣ Liquidity Bounce (1h)':      { color: '#fbbf24', rating: 'B', wr: '~55%' },
  '3️⃣ Ранний вход (5m)':           { color: '#f87171', rating: 'C', wr: '~38%' },
  '4️⃣ MA20/MA50+RSI (1h)':         { color: '#34d399', rating: 'A', wr: '~65%' },
  '5️⃣ RSI Дивергенция (1h)':       { color: '#34d399', rating: 'A', wr: '~67%' },
  '6️⃣ Funding Extreme (1h)':       { color: '#34d399', rating: 'A', wr: '~68%' },
  '7️⃣ Поглощение на объёме (15m)': { color: '#fbbf24', rating: 'B', wr: '~58%' },
};

// ── Хранилище в памяти (вместо ScriptProperties) ──────────
const store = {
  cooldowns:    {},  // { instId: timestamp }
  openTrades:   [],  // открытые сделки
  tradeHistory: [],  // история сделок
  signalLog:    [],  // лог сигналов
  fngCache:     null,
  fngTs:        0,
  adaptedThresholds: null,
};

// ── Сессии UTC ─────────────────────────────────────────────
const SESSION_ASIA   = { from: 1,  to: 8  };
const SESSION_EUROPE = { from: 7,  to: 16 };
const SESSION_USA    = { from: 13, to: 22 };


// ============================================================
//  HTTP ЗАПРОСЫ
// ============================================================
async function httpGet(url) {
  try {
    await new Promise(r => setTimeout(r, 800)); // пауза 800ms
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
async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  await httpPost(url, { chat_id: CHAT_ID, text });
  console.log(`[TG] Отправлено: ${text.substring(0, 60)}...`);
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

  const prompt =
    `Ты — профессиональный крипто-трейдер уровня проп-фонда, работающий с деривативами более 10 лет.
Твоя задача — ПРОФЕССИОНАЛЬНАЯ ОЦЕНКА уже сгенерированного сигнала.
Ты НЕ создаешь сигнал с нуля — ты РЕШАЕШЬ: ОСТАВИТЬ или ОТКЛОНИТЬ.

📊 СИГНАЛ:
Стратегия: ${sig.strategy} (Рейтинг: ${meta.rating}, Win Rate: ${meta.wr})
Направление: ${sig.direction === 'long' ? 'LONG' : 'SHORT'}
Цена: $${sig.price}
Confidence (до AI): ${sig.confidence}%
Метрики: ${sig.metrics}

ДОПОЛНИТЕЛЬНЫЙ КОНТЕКСТ:
Сессия: ${session}
Fear & Greed: ${fng ? fng.value + ' (' + fng.label + ')' : 'N/A'}
${sig.srNote     ? 'Уровни S/R: '   + sig.srNote     : ''}
${sig.fngNote    ? 'F&G заметка: '  + sig.fngNote    : ''}
${sig.patternNote? 'Паттерны: '     + sig.patternNote : ''}
${sig.liqNote    ? 'Ликвидации: '   + sig.liqNote    : ''}
${sig.newsNote   ? 'Новости: '      + sig.newsNote   : ''}

ЖЁСТКИЕ ПРАВИЛА:
- Минимум 3 независимых подтверждения для APPROVE
- Если есть противоречия между индикаторами → REJECT
- Рейтинг A (S4,S5,S6): порог 75%+ | Рейтинг B (S2,S7): 85%+ | Рейтинг C (S1,S3): 92%+
- Азия сессия → почти всегда REJECT
- Если RR < 1:2 → REJECT
- Лучше пропустить 10 сделок чем взять одну плохую

Ответь СТРОГО в одном из двух форматов:
APPROVE | 94
или
REJECT | причина одной строкой`;

  try {
    // Проверяем есть ли ключ
    if (!process.env.GEMINI_KEY) {
      console.log('[GEMINI] Ключ не найден — пропускаем валидацию');
      return { approved: true, confidence: sig.confidence, reason: 'Gemini недоступен' };
    }

    const data = await httpPost(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model:    'mistralai/mistral-7b-instruct',
        messages: [{ role: 'user', content: prompt }],
      },
      {
        'Authorization':  `Bearer ${process.env.OPENROUTER_KEY}`,
        'Content-Type':   'application/json',
        'HTTP-Referer':   'https://crypto-radar-8ceq.onrender.com',
        'X-Title':        'Crypto Radar Bot',
      }
    );
    const response = data?.choices?.[0]?.message?.content || '';
    const line     = response.trim().split('\n')[0].trim();

    console.log(`[GEMINI] ${sig.instId} → ${line}`);

    if (line.startsWith('APPROVE')) {
      const parts   = line.split('|');
      const newConf = parts[1] ? parseInt(parts[1].trim()) : sig.confidence;
      return {
        approved:   true,
        confidence: isNaN(newConf) ? sig.confidence : Math.min(newConf, 100),
        reason:     parts[1] ? `Gemini: ${newConf}% уверенность` : 'Gemini подтвердил'
      };
    }

    if (line.startsWith('REJECT')) {
      const reason = line.split('|')[1]?.trim() || 'Gemini отклонил';
      return { approved: false, confidence: 0, reason };
    }

    // Непонятный ответ — перестраховываемся
    console.log(`[GEMINI] Непонятный ответ: ${line}`);
    return { approved: false, confidence: 0, reason: 'Непонятный ответ Gemini' };

  } catch(e) {
    console.error('[GEMINI] error:', e.message);
    // Если Gemini недоступен — не блокируем сигнал
    return { approved: true, confidence: sig.confidence, reason: 'Gemini недоступен' };
  }
}


// ============================================================
//  OKX API
// ============================================================
async function getOKXCandidates() {
  const data = await httpGet('https://www.okx.com/api/v5/market/tickers?instType=SWAP');
  if (!data || data.code !== '0') return [];
  return data.data
    .filter(t => t.instId.endsWith('-USDT-SWAP'))
    .map(t => ({
      instId:    t.instId,
      symbol:    t.instId.replace('-USDT-SWAP', ''),
      price:     parseFloat(t.last),
      change24h: (parseFloat(t.last) - parseFloat(t.open24h)) / parseFloat(t.open24h) * 100,
      volume24h: parseFloat(t.volCcy24h) * parseFloat(t.last),
      fundingRate: parseFloat(t.fundingRate || 0),
    }))
    .filter(t => t.volume24h >= MIN_VOLUME_24H)
    .sort((a, b) => b.volume24h - a.volume24h)
    .slice(0, TOP_N);
}

async function getOKXKlines(instId, bar, limit) {
  const data = await httpGet(`https://www.okx.com/api/v5/market/candles?instId=${instId}&bar=${bar}&limit=${limit}`);
  if (!data || data.code !== '0') return [];
  return data.data.reverse().map(c => ({
    ts: +c[0], open: +c[1], high: +c[2], low: +c[3], close: +c[4],
    volume: +c[5], quoteVolume: +c[7], takerBuyQuote: +c[7] * 0.5,
  }));
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
//  FEAR & GREED
// ============================================================
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
  const klines = await getOKXKlines(instId, '4H', 42);
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
  const base = calcSLTP(price, direction);
  try {
    if (direction === 'long') {
      const supports = sr.supports.filter(s => s < price * 0.999);
      if (supports.length) {
        const nearest  = supports.reduce((p, c) => Math.abs(c - price) < Math.abs(p - price) ? c : p);
        const smartSL  = nearest * 0.997;
        if (smartSL > price * (1 - SL_PCT * 2 / 100)) {
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
        if (smartSL < price * (1 + SL_PCT * 2 / 100)) {
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
    const k15m = await getOKXKlines(instId, '15m', 5);
    const k1h  = await getOKXKlines(instId, '1H',  5);
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
//  LIQUIDATION BOOST
// ============================================================
async function getLiquidationData(instId) {
  const data = await httpGet(`https://www.okx.com/api/v5/public/liquidation-orders?instType=SWAP&instId=${instId}&state=filled&limit=50`);
  if (!data || data.code !== '0' || !data.data?.length) return { longLiqs: 0, shortLiqs: 0, totalUsd: 0, dominant: 'none' };
  const details = data.data[0].details || [];
  let longLiqs = 0, shortLiqs = 0, totalUsd = 0;
  details.forEach(d => {
    const usd = parseFloat(d.sz) * parseFloat(d.bkPx);
    totalUsd += usd;
    if (d.side === 'buy')  shortLiqs += usd;
    if (d.side === 'sell') longLiqs  += usd;
  });
  return { longLiqs, shortLiqs, totalUsd, dominant: longLiqs > shortLiqs ? 'longs' : 'shorts' };
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
function calcSLTP(price, direction, strategy) {
  const params = STRATEGY_SL[strategy] || { sl: 1.5, tp1: 3.0, tp2: 4.5 };
  const { sl, tp1, tp2 } = params;
  return direction === 'long'
    ? {
        sl:  (price * (1 - sl  / 100)).toFixed(4),
        tp1: (price * (1 + tp1 / 100)).toFixed(4),
        tp2: (price * (1 + tp2 / 100)).toFixed(4),
      }
    : {
        sl:  (price * (1 + sl  / 100)).toFixed(4),
        tp1: (price * (1 - tp1 / 100)).toFixed(4),
        tp2: (price * (1 - tp2 / 100)).toFixed(4),
      };
}


// ============================================================
//  СТРАТЕГИИ
// ============================================================
async function runStrategies(instId, coinData, asianSession) {
  const signals = [];
  try {
    const price = coinData.price;
    const ccy   = coinData.symbol; // ← это было удалено случайно

    const [k5m, k15m, k1h, oi5m, oi1h, tf5m, tf1h] = await Promise.all([
      getOKXKlines(instId, '5m',  20),
      getOKXKlines(instId, '15m', 10),
      getOKXKlines(instId, '1H',  60),
      getOKXOIHistory(ccy, '5m',  3),
      getOKXOIHistory(ccy, '1H',  3),
      getOKXTakerFlow(ccy, '5m'),
      getOKXTakerFlow(ccy, '1H'),
    ]);
    const oi15m = oi5m;
    const tf15m = tf5m;

    // S1: Пробой 15m
    if (!asianSession && k15m.length >= 2 && oi15m.length >= 2) {
      const pc  = calcPriceChangePct(k15m);
      const oi  = calcOiChangePct(oi15m);
      const vd  = tf15m ? tf15m.delta : calcVolumeDelta(k15m);
      const vol = k15m.reduce((s, c) => s + c.quoteVolume, 0);
      const iL  = pc >= S1.priceMin && oi >= S1.oiMin && vd >= S1.vdeltaMin && vol >= S1.volMin;
      const iS  = pc <= -S1.priceMin && oi >= S1.oiMin && vd <= -S1.vdeltaMin && vol >= S1.volMin;
      if (iL || iS) {
        const dir = iL ? 'long' : 'short';
        const met = [Math.abs(pc)>=S1.priceMin, oi>=S1.oiMin, Math.abs(vd)>=S1.vdeltaMin, vol>=S1.volMin].filter(Boolean).length;
         // MACD и Bollinger подтверждение для S1
        const macd15 = calcMACD(k15m);
        const bb15   = calcBollinger(k15m);
        let confS1   = met * 25;

        if (dir === 'long') {
          if (macd15.hist > 0)              confS1 = Math.min(confS1 + 10, 100); // MACD бычий
          if (k15m[k15m.length-1].close > bb15.upper) confS1 = Math.min(confS1 + 10, 100); // пробой BB вверх
        } else {
          if (macd15.hist < 0)              confS1 = Math.min(confS1 + 10, 100); // MACD медвежий
          if (k15m[k15m.length-1].close < bb15.lower) confS1 = Math.min(confS1 + 10, 100); // пробой BB вниз
        }
        signals.push({ strategy: '1️⃣ Пробой на импульсе (15m)', instId, direction: dir,
          signal: dir==='long'?'🟢 LONG':'🔴 SHORT', price, confidence: confS1,
          metrics: `Цена:${pc.toFixed(2)}% OI:${oi.toFixed(2)}% VΔ:$${(vd/1e6).toFixed(2)}M Vol:$${(vol/1e6).toFixed(1)}M MACD:${macd15.hist.toFixed(4)} BB:${bb15.width.toFixed(1)}%`,
          ...calcSLTP(price, dir, '1️⃣ Пробой на импульсе (15m)') });
      }
    }

    // S2: Bounce 1h
    if (!asianSession && k1h.length >= 2 && oi1h.length >= 2) {
      const pc   = calcPriceChangePct(k1h);
      const oi   = calcOiChangePct(oi1h);
      const vd   = tf1h ? tf1h.delta : calcVolumeDelta(k1h);
      const vol  = k1h.reduce((s, c) => s + c.quoteVolume, 0);
      const tick = Math.round(k1h[k1h.length-1].quoteVolume / 10000);
      const rsi  = k1h.length >= 15 ? calcRSI(k1h, 14) : 50;
      const lc   = [pc<=S2.priceMax, oi>=S2.oiMin, vd<=S2.vdeltaMax, tick>=S2.ticksMin, vol>=S2.volMin];
      const sc   = [pc>=-S2.priceMax, oi>=S2.oiMin, vd>=-S2.vdeltaMax, tick>=S2.ticksMin, vol>=S2.volMin];
      const ml   = lc.filter(Boolean).length, ms = sc.filter(Boolean).length;
      if (ml >= 4 || ms >= 4) {
        const dir = ml >= ms ? 'long' : 'short';
        let conf  = Math.max(ml, ms) * 20;
        if (dir==='long' && rsi<35)  conf = Math.min(conf+10, 100);
        if (dir==='short' && rsi>65) conf = Math.min(conf+10, 100);
        signals.push({ strategy: '2️⃣ Liquidity Bounce (1h)', instId, direction: dir,
          signal: dir==='long'?'🟢 LONG':'🔴 SHORT', price, confidence: Math.round(conf),
          metrics: `Цена:${pc.toFixed(2)}% OI:${oi.toFixed(2)}% VΔ:$${(vd/1e6).toFixed(2)}M Тики:~${tick} RSI:${rsi}`,
          ...calcSLTP(price, dir, '2️⃣ Liquidity Bounce (1h)') });
      }
    }

    // S3: Ранний вход 5m
    if (k5m.length >= 7 && oi5m.length >= 2) {
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
    }

  // S4: MA20/MA50 + RSI (1h) — долгосрочный разворот тренда
    if (k1h.length >= 55) {
      const cross = calcMACross(k1h, 20, 50);
      const rsi   = calcRSI(k1h, 14);
      const ma20  = calcSMA(k1h, 20);
      const ma50  = calcSMA(k1h, 50);
      const iL    = cross === 'bullish' && rsi < 70;
      const iS    = cross === 'bearish' && rsi > 30;

      if (iL || iS) {
        const dir = iL ? 'long' : 'short';
        let conf  = 70;
        if (iL && rsi < 50) conf += 10; // RSI не перекуплен — хорошо
        if (iS && rsi > 50) conf += 10; // RSI не перепродан — хорошо
        if (iL && cross === 'bullish') conf += 5; // Golden Cross бонус
        if (iS && cross === 'bearish') conf += 5; // Death Cross бонус

        signals.push({
          strategy:  '4️⃣ MA20/MA50+RSI (1h)',
          instId,
          direction: dir,
          signal:    dir === 'long' ? '🟢 LONG' : '🔴 SHORT',
          price,
          confidence: Math.min(conf, 100),
          metrics: `MA20:${ma20.toFixed(4)} MA50:${ma50.toFixed(4)} RSI:${rsi} ${cross === 'bullish' ? '🔀 Golden Cross' : '🔀 Death Cross'}`,
          ...calcSLTP(price, dir, '4️⃣ MA20/MA50+RSI (1h)'),
        });
      }
    }

    // S5: RSI Дивергенция (1h) — цена новый минимум, RSI нет = разворот вверх
    if (k1h.length >= 20) {
      const closes = k1h.map(c => c.close);
      const lows   = k1h.map(c => c.low);
      const rsiNow = calcRSI(k1h, 14);
      const rsiPrev= calcRSI(k1h.slice(0, -5), 14);

      const priceNewLow  = lows[lows.length-1] < Math.min(...lows.slice(-10, -1));
      const rsiHigher    = rsiNow > rsiPrev + 3;
      const priceNewHigh = closes[closes.length-1] > Math.max(...closes.slice(-10, -1));
      const rsiLower     = rsiNow < rsiPrev - 3;

      if (priceNewLow && rsiHigher && rsiNow < 45) {
        // Бычья дивергенция → LONG
        signals.push({
          strategy: '5️⃣ RSI Дивергенция (1h)', instId, direction: 'long',
          signal: '🟢 LONG', price, confidence: 78,
          metrics: `RSI сейчас:${rsiNow} RSI ранее:${rsiPrev.toFixed(1)} Цена новый лоу: да`,
          ...calcSLTP(price, 'long', '5️⃣ RSI Дивергенция (1h)')
        });
      }
      if (priceNewHigh && rsiLower && rsiNow > 55) {
        // Медвежья дивергенция → SHORT
        signals.push({
          strategy: '5️⃣ RSI Дивергенция (1h)', instId, direction: 'short',
          signal: '🔴 SHORT', price, confidence: 78,
          metrics: `RSI сейчас:${rsiNow} RSI ранее:${rsiPrev.toFixed(1)} Цена новый хай: да`,
          ...calcSLTP(price, 'short', '5️⃣ RSI Дивергенция (1h)')
        });
      }
    }

    // S6: Funding Rate Extreme — шортисты/лонгисты переплачивают = разворот
    if (oi1h.length >= 2) {
      const funding = coinData.fundingRate || 0;
      const rsi1h  = calcRSI(k1h, 14);
      // Экстремально отрицательный funding = шортисты переплачивают = скоро закроются = рост
      if (funding < -0.03 && rsi1h < 45) {
        signals.push({
          strategy: '6️⃣ Funding Extreme (1h)', instId, direction: 'long',
          signal: '🟢 LONG', price, confidence: 80,
          metrics: `Funding:${funding.toFixed(4)}% RSI:${rsi1h} Шортисты переплачивают`,
          ...calcSLTP(price, 'long', '6️⃣ Funding Extreme (1h)')
        });
      }
      if (funding > 0.03 && rsi1h > 55) {
        signals.push({
          strategy: '6️⃣ Funding Extreme (1h)', instId, direction: 'short',
          signal: '🔴 SHORT', price, confidence: 80,
          metrics: `Funding:${funding.toFixed(4)}% RSI:${rsi1h} Лонгисты переплачивают`,
          ...calcSLTP(price, 'short', '6️⃣ Funding Extreme (1h)')
        });
      }
    }

    // S7: Поглощение на объёме (15m) — свеча поглощения + объём 3x выше среднего
    if (k15m.length >= 10) {
      const patterns = detectCandlePatterns(k15m);
      const engulfing = patterns.find(p => p.name.includes('engulfing'));
      if (engulfing) {
        const avgVol  = k15m.slice(-10, -1).reduce((a, c) => a + c.quoteVolume, 0) / 9;
        const lastVol = k15m[k15m.length-1].quoteVolume;
        const volBoost = lastVol >= avgVol * 2.5;

        if (volBoost) {
          const dir = engulfing.direction === 'bullish' ? 'long' : 'short';
          signals.push({
            strategy: '7️⃣ Поглощение на объёме (15m)', instId, direction: dir,
            signal: dir === 'long' ? '🟢 LONG' : '🔴 SHORT', price, confidence: 72,
            metrics: `${engulfing.desc} | Vol:$${(lastVol/1e6).toFixed(2)}M (${(lastVol/avgVol).toFixed(1)}x среднего)`,
            ...calcSLTP(price, dir, '7️⃣ Поглощение на объёме (15m)')
          });
        }
      }
    }

  } catch(e) { console.error(`runStrategies [${instId}]:`, e.message); }
  return signals;
}


// ============================================================
//  ФОРМАТИРОВАНИЕ
// ============================================================
function buildSignalAlert(sig) {
  const filled   = Math.round(sig.confidence / 10);
  const bar      = '█'.repeat(filled) + '░'.repeat(10 - filled);
  const emoji    = sig.direction === 'long' ? '🚀' : '🩸';
  const name     = sig.instId.replace('-USDT-SWAP', '');
  const meta      = STRATEGY_META[sig.strategy] || { color: '#999', rating: '?', wr: '?' };
  const ratingLine = `${meta.rating === 'A' ? '🟢' : meta.rating === 'B' ? '🟡' : '🔴'} Рейтинг: ${meta.rating} | Win Rate: ${meta.wr}`;
  const timeStr  = getAlmatyTime();
  const fngEmoji = !sig.fng ? '😐' : sig.fng.value < 25 ? '😱' : sig.fng.value > 75 ? '🤑' : '😐';
  const fngLine  = sig.fng ? `${fngEmoji} F&G: ${sig.fng.value} (${sig.fng.label})` : '';
  const notes = [sig.srNote, sig.slNote, sig.fngNote, sig.sessionNote, sig.liqNote, sig.patternNote, sig.newsNote, sig.aiNote]
    .filter(Boolean).map(n => `  ${n}`).join('\n');
  return (
    `${emoji} ${name}/USDT — ${sig.signal}\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `📌 ${sig.strategy}\n` +
    `${ratingLine}\n` +
    `⏰ ${timeStr} Алматы\n` +
    (fngLine ? fngLine + '\n' : '') +
    `\n💰 Вход: $${sig.price}\n` +
    `🛡 Стоп-лосс:    $${sig.sl}\n` +
    `🎯 Тейк-1 (1:2): $${sig.tp1}\n` +
    `🎯 Тейк-2 (1:3): $${sig.tp2}\n\n` +
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
    tp1:     { e:'✅', t:'ТП1 достигнут' },
    tp2:     { e:'🏆', t:'ТП2 достигнут' },
    sl:      { e:'❌', t:'Стоп-лосс' },
    expired: { e:'⏰', t:'Истёк' }
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
    symbol: sig.instId.replace('-USDT-SWAP',''),
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
      symbol:     sig.instId.replace('-USDT-SWAP',''),
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
    ts: sig.ts, symbol: sig.instId.replace('-USDT-SWAP',''),
    strategy: sig.strategy, direction: sig.direction,
    price: sig.price, confidence: sig.confidence
  });
  if (store.signalLog.length > 300) store.signalLog = store.signalLog.slice(-300);

  // В базу данных (постоянно)
  try {
    await supabase.from('signals').insert({
      ts:         sig.ts,
      inst_id:    sig.instId,
      symbol:     sig.instId.replace('-USDT-SWAP',''),
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

app.get('/', async (req, res) => {
  try {
    const [sigRes, tradeRes, openRes] = await Promise.all([
      supabase.from('signals').select('*').order('ts', { ascending: false }).limit(50),
      supabase.from('trades').select('*').order('closed_at', { ascending: false }).limit(50),
      supabase.from('open_trades').select('*').order('ts', { ascending: false }).limit(20),
    ]);

    const signals    = sigRes.data    || [];
    const trades     = tradeRes.data  || [];
    const openTrades = openRes.data   || [];

    // Общая статистика
    const wins    = trades.filter(t => t.outcome === 'tp1' || t.outcome === 'tp2');
    const losses  = trades.filter(t => t.outcome === 'sl');
    const wr      = trades.length ? Math.round(wins.length / trades.length * 100) : 0;
    const pnl     = trades.reduce((a, t) => a + (parseFloat(t.pnl) || 0), 0);
    const longs   = signals.filter(s => s.direction === 'long').length;
    const shorts  = signals.filter(s => s.direction === 'short').length;

    // Дневная статистика (последние 24 часа)
    const since24h     = Date.now() - 24 * 60 * 60 * 1000;
    const todayTrades  = trades.filter(t => t.closed_at && +t.closed_at >= since24h);
    const todayWins    = todayTrades.filter(t => t.outcome === 'tp1' || t.outcome === 'tp2');
    const todayLosses  = todayTrades.filter(t => t.outcome === 'sl');
    const todayWR      = todayTrades.length ? Math.round(todayWins.length / todayTrades.length * 100) : 0;
    const todayPnl     = todayTrades.reduce((a, t) => a + (parseFloat(t.pnl) || 0), 0);
    const todaySignals = signals.filter(s => +s.ts >= since24h).length;

    const fmtTime = ts => new Date(+ts + 5*60*60*1000).toISOString().replace('T',' ').substr(0,16);
    const fmtPnl  = p => `${parseFloat(p) >= 0 ? '+' : ''}${parseFloat(p).toFixed(1)}%`;

    const outcomeIcon = o => ({ tp1:'✅', tp2:'🏆', sl:'❌', expired:'⏰' }[o] || '❓');
    const dirIcon     = d => d === 'long' ? '🟢' : '🔴';

    const html = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Крипто Радар</title>
<meta http-equiv="refresh" content="60">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f0f0f; color: #e0e0e0; padding: 24px; font-size: 14px; }
  h1 { font-size: 20px; font-weight: 600; margin-bottom: 4px; }
  .sub { color: #666; font-size: 12px; margin-bottom: 24px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .card { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 12px; padding: 16px; }
  .card-label { font-size: 11px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px; }
  .card-val { font-size: 28px; font-weight: 600; }
  .green { color: #34d399; }
  .red { color: #f87171; }
  .blue { color: #60a5fa; }
  .yellow { color: #fbbf24; }
  section { margin-bottom: 28px; }
  h2 { font-size: 14px; font-weight: 500; color: #999; margin-bottom: 12px; text-transform: uppercase; letter-spacing: 0.5px; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; padding: 8px 12px; color: #555; font-size: 11px; font-weight: 400; text-transform: uppercase; letter-spacing: 0.5px; border-bottom: 1px solid #222; }
  td { padding: 10px 12px; border-bottom: 1px solid #1a1a1a; font-size: 13px; }
  tr:hover td { background: #1a1a1a; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 5px; font-size: 11px; font-weight: 500; }
  .badge-long  { background: #064e3b; color: #34d399; }
  .badge-short { background: #450a0a; color: #f87171; }
  .tag { display: inline-block; padding: 2px 8px; border-radius: 5px; font-size: 11px; }
  .tag-tp  { background: #064e3b; color: #34d399; }
  .tag-sl  { background: #450a0a; color: #f87171; }
  .tag-exp { background: #1c1c1c; color: #666; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #34d399; margin-right: 6px; animation: pulse 2s infinite; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
</style>
</head>
<body>
<h1>🤖 Крипто Радар v4.0</h1>
<p class="sub"><span class="dot"></span>Обновляется каждую минуту · ${fmtTime(Date.now())} Алматы</p>

<p style="font-size:11px;color:#555;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">За сегодня</p>
<div class="grid" style="margin-bottom:16px;">
  <div class="card">
    <div class="card-label">Сигналов сегодня</div>
    <div class="card-val blue">${todaySignals}</div>
  </div>
  <div class="card">
    <div class="card-label">Win Rate сегодня</div>
    <div class="card-val ${todayWR >= 60 ? 'green' : todayWR >= 40 ? 'yellow' : todayTrades.length ? 'red' : ''}">${todayTrades.length ? todayWR + '%' : '—'}</div>
  </div>
  <div class="card">
    <div class="card-label">PnL сегодня</div>
    <div class="card-val ${todayPnl >= 0 ? 'green' : 'red'}">${todayTrades.length ? fmtPnl(todayPnl) : '—'}</div>
  </div>
  <div class="card">
    <div class="card-label">TP / SL сегодня</div>
    <div class="card-val" style="font-size:20px"><span class="green">${todayWins.length}</span> / <span class="red">${todayLosses.length}</span></div>
  </div>
</div>

<p style="font-size:11px;color:#555;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">За всё время</p>
<div class="grid">
  <div class="card">
    <div class="card-label">Всего сигналов</div>
    <div class="card-val blue">${signals.length}</div>
  </div>
  <div class="card">
    <div class="card-label">Win Rate общий</div>
    <div class="card-val ${wr >= 60 ? 'green' : wr >= 40 ? 'yellow' : trades.length ? 'red' : ''}">${trades.length ? wr + '%' : '—'}</div>
  </div>
  <div class="card">
    <div class="card-label">PnL общий</div>
    <div class="card-val ${pnl >= 0 ? 'green' : 'red'}">${trades.length ? fmtPnl(pnl) : '—'}</div>
  </div>
  <div class="card">
    <div class="card-label">Long / Short</div>
    <div class="card-val" style="font-size:20px"><span class="green">${longs}</span> / <span class="red">${shorts}</span></div>
  </div>
  <div class="card">
    <div class="card-label">Открытых</div>
    <div class="card-val yellow">${openTrades.length}</div>
  </div>
  <div class="card">
    <div class="card-label">Закрытых всего</div>
    <div class="card-val">${trades.length}</div>
  </div>
</div>

${openTrades.length ? `
<section>
  <h2>⚡ Открытые сделки</h2>
  <table>
    <thead><tr><th>Монета</th><th>Направление</th><th>Вход</th><th>SL</th><th>TP1</th><th>TP2</th><th>Уверенность</th><th>Время</th></tr></thead>
    <tbody>
      ${openTrades.map(t => `<tr>
        <td><b>${t.symbol}</b></td>
        <td><span class="badge ${t.direction === 'long' ? 'badge-long' : 'badge-short'}">${t.direction === 'long' ? '🟢 LONG' : '🔴 SHORT'}</span></td>
        <td>$${parseFloat(t.price).toFixed(4)}</td>
        <td style="color:#f87171">$${parseFloat(t.sl).toFixed(4)}</td>
        <td style="color:#34d399">$${parseFloat(t.tp1).toFixed(4)}</td>
        <td style="color:#34d399">$${parseFloat(t.tp2).toFixed(4)}</td>
        <td>${t.confidence}%</td>
        <td style="color:#666">${fmtTime(t.ts)}</td>
      </tr>`).join('')}
    </tbody>
  </table>
</section>` : ''}

<section>
  <h2>📊 История сделок</h2>
  <table>
    <thead><tr><th>Монета</th><th>Направление</th><th>Стратегия</th><th>Исход</th><th>PnL</th><th>Вход</th><th>Выход</th><th>Время</th></tr></thead>
    <tbody>
      ${trades.map(t => `<tr>
        <td><b>${t.symbol}</b></td>
        <td><span class="badge ${t.direction === 'long' ? 'badge-long' : 'badge-short'}">${t.direction === 'long' ? '🟢 LONG' : '🔴 SHORT'}</span></td>
        <td style="color:#666;font-size:11px">${t.strategy || '—'}</td>
        <td><span class="tag ${t.outcome?.startsWith('tp') ? 'tag-tp' : t.outcome === 'sl' ? 'tag-sl' : 'tag-exp'}">${outcomeIcon(t.outcome)} ${t.outcome?.toUpperCase()}</span></td>
        <td style="color:${parseFloat(t.pnl) >= 0 ? '#34d399' : '#f87171'};font-weight:500">${fmtPnl(t.pnl)}</td>
        <td>$${parseFloat(t.price).toFixed(4)}</td>
        <td>${t.close_price ? '$' + parseFloat(t.close_price).toFixed(4) : '—'}</td>
        <td style="color:#666">${t.closed_at ? fmtTime(t.closed_at) : '—'}</td>
      </tr>`).join('')}
    </tbody>
  </table>
</section>

<section>
  <h2>📨 Последние сигналы</h2>
  <table>
    <thead><tr><th>Монета</th><th>Направление</th><th>Стратегия</th><th>Уверенность</th><th>Цена</th><th>Время</th></tr></thead>
    <tbody>
      ${signals.map(s => `<tr>
        <td><b>${s.symbol}</b></td>
        <td><span class="badge ${s.direction === 'long' ? 'badge-long' : 'badge-short'}">${dirIcon(s.direction)} ${s.direction?.toUpperCase()}</span></td>
        <td style="color:#666;font-size:12px">${s.strategy}</td>
        <td>${s.confidence}%</td>
        <td>$${parseFloat(s.price).toFixed(4)}</td>
        <td style="color:#666">${fmtTime(s.ts)}</td>
      </tr>`).join('')}
    </tbody>
  </table>
</section>

</body></html>`;

    res.send(html);
  } catch(e) {
    res.status(500).send('Ошибка: ' + e.message);
  }
});

app.listen(process.env.PORT || 3000);

// Каждые 5 минут — поиск сигналов
async function checkSignals() {
  console.log(`[${getAlmatyTime()}] checkSignals запущен`);
  const candidates    = await getOKXCandidates();
  if (!candidates.length) { console.log('Нет кандидатов'); return; }

  const fng           = await getFearAndGreed();
  const session       = getCurrentSession();
  const asianSession  = isAsianSession();

  for (const coin of candidates) {
    if (isCoinOnCooldown(coin.instId)) continue;

    let signals = await runStrategies(coin.instId, coin, asianSession);
    if (!signals.length) continue;

    // Применяем все фильтры
    const filtered = [];
    for (let sig of signals) {
      sig = applyFearGreed(sig, fng);
      sig = await applySupportResistance(sig, coin.instId);
      sig = applySessionFilter(sig, session);
      sig = await applyCandlePatterns(sig, coin.instId);
      sig = await applyLiquidationBoost(sig);
      filtered.push(sig);
    }

    const best = filtered
      .filter(s => s.confidence >= 90)
      .sort((a, b) => b.confidence - a.confidence)[0];

    if (!best) continue;

    // Новостной фильтр
    const news = await checkNews(coin.symbol);
    if (news.blocked) { console.log(`[NEWS BLOCK] ${coin.instId}`); continue; }
    if (news.note) best.newsNote = news.note;

    best.ts      = Date.now();
    best.fng     = fng;
    best.session = session;

    // AI валидация — финальный фильтр
    const aiResult = await validateSignalWithAI(best, fng, session);
    if (!aiResult.approved) {
      console.log(`[AI REJECT] ${coin.instId} → ${aiResult.reason}`);
      continue;
    }
    best.confidence = aiResult.confidence;
    best.aiNote     = `🤖 AI: ${aiResult.reason}`;

    await sendTelegram(buildSignalAlert(best));
    setCoinCooldown(coin.instId);
    logSignal(best);
    saveOpenTrade(best);
  }
}

// Каждые 15 минут — проверка исходов
async function checkOutcomes() {
  if (!store.openTrades.length) return;
  const stillOpen = [], closed = [];

  for (const trade of store.openTrades) {
    const ageMin = (Date.now() - trade.ts) / 60000;
    if (ageMin > 240) { trade.outcome = 'expired'; trade.closedAt = Date.now(); closed.push(trade); continue; }

    const price = await getCurrentPrice(trade.instId);
    if (!price) { stillOpen.push(trade); continue; }

    let outcome = null;
    if (trade.direction === 'long') {
      if (price <= parseFloat(trade.sl))       outcome = 'sl';
      else if (price >= parseFloat(trade.tp2)) outcome = 'tp2';
      else if (price >= parseFloat(trade.tp1)) outcome = 'tp1';
    } else {
      if (price >= parseFloat(trade.sl))       outcome = 'sl';
      else if (price <= parseFloat(trade.tp2)) outcome = 'tp2';
      else if (price <= parseFloat(trade.tp1)) outcome = 'tp1';
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
      closed.push(trade);
      await sendTelegram(buildOutcomeAlert(trade));
    } else { stillOpen.push(trade); }
  }

  store.openTrades   = stillOpen;
store.tradeHistory = [...store.tradeHistory, ...closed].slice(-500);

// Сохраняем закрытые сделки в базу
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
}
}

// Каждый час — аномалии
async function checkAnomalies() {
  const candidates = await getOKXCandidates();
  const anomalies  = candidates.filter(c => Math.abs(c.change24h) >= 3.0);
  if (!anomalies.length) { await sendTelegram('✅ КРИПТО РАДАР\nАномалий нет (<3% за 24h)'); return; }

  const fng   = await getFearAndGreed();
  const top5  = anomalies.slice(0, 5);
  const coins = top5.map(c => `${c.change24h > 0 ? '🚀' : '📉'} ${c.symbol} $${c.price}  ${c.change24h.toFixed(2)}%  $${(c.volume24h/1e6).toFixed(0)}M`).join('\n');
  const prompt = `Крипто аналитик. OKX аномалии:\n\n${top5.map(c => `${c.symbol}: $${c.price}, ${c.change24h.toFixed(2)}%`).join('\n')}\n\nF&G: ${fng.value} (${fng.label}). Grade A-D, LONG/SHORT/ЖДАТЬ, 1-2 предложения. На русском.`;

  await sendTelegram(`🔔 КРИПТО РАДАР v4.0\n🕐 ${getAlmatyTime()}\n😐 F&G: ${fng.value} (${fng.label})\n\n${coins}\n\n🤖 AI:\n${await callGroq(prompt)}`);
}

// Раз в день — дневной отчёт
async function dailyReport() {
  const since   = Date.now() - 24*60*60*1000;
  const signals = store.signalLog.filter(s => s.ts >= since);
  const trades  = store.tradeHistory.filter(t => t.closedAt >= since);
  const fng     = await getFearAndGreed();

  if (!signals.length && !trades.length) {
    await sendTelegram(`📊 ДНЕВНОЙ ОТЧЁТ | ${getAlmatyDate()}\n😴 Сигналов не было.`); return;
  }

  const wins   = trades.filter(t => t.outcome==='tp1'||t.outcome==='tp2');
  const losses = trades.filter(t => t.outcome==='sl');
  const wr     = trades.length ? Math.round(wins.length/trades.length*100) : 0;
  const pnl    = trades.reduce((a, t) => a + (t.pnl||0), 0);
  const lc     = signals.filter(s => s.direction==='long').length;
  const sc     = signals.filter(s => s.direction==='short').length;

  let msg = `📊 ДНЕВНОЙ ОТЧЁТ v4.0\n━━━━━━━━━━━━━━━━━━━━━━\n🗓 ${getAlmatyDate()}\n😐 F&G: ${fng.value} (${fng.label})\n\n`;
  if (trades.length) msg += `📈 Сделки: ${trades.length} | ✅ TP: ${wins.length} ❌ SL: ${losses.length}\n🏆 Win Rate: ${wr}%  💰 PnL: ${pnl>=0?'+':''}${pnl.toFixed(1)}%\n\n`;
  if (signals.length) msg += `📨 Сигналов: ${signals.length} (🟢 ${lc} / 🔴 ${sc})\n`;
  msg += '\n⚠️ Статистика бота, не реальных сделок.';

  await sendTelegram(msg);
}


// ============================================================
//  РАСПИСАНИЕ (node-cron)
// ============================================================
console.log('🚀 Крипто Радар v4.0 запущен');
console.log(`⏰ Время Алматы: ${getAlmatyTime()}`);
console.log(`📊 Сессия: ${getCurrentSession()}`);

// Каждые 5 минут
cron.schedule('*/5 * * * *', () => { checkSignals().catch(e => console.error('checkSignals error:', e.message)); });

// Каждые 15 минут
cron.schedule('*/15 * * * *', () => { checkOutcomes().catch(e => console.error('checkOutcomes error:', e.message)); });

// Каждый час (в 00 минут)
cron.schedule('0 * * * *', () => { checkAnomalies().catch(e => console.error('checkAnomalies error:', e.message)); });

// Каждый день в 07:00 UTC = 12:00 Алматы
cron.schedule('0 7 * * *', () => { dailyReport().catch(e => console.error('dailyReport error:', e.message)); });

// Первый запуск сразу при старте для проверки
checkSignals().catch(e => console.error('Initial checkSignals error:', e.message));

process.on('uncaughtException', e => {
  console.error('[CRASH PREVENTED]', e.message);
});
process.on('unhandledRejection', e => {
  console.error('[PROMISE ERROR]', e?.message || e);
});
