require('dotenv').config();
const axios = require('axios');
const cron  = require('node-cron');

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
  '2️⃣ Liquidity Bounce (1h)':       { sl: 2.5, tp1: 5.0, tp2: 7.5 },
  '3️⃣ Ранний вход (5m)':            { sl: 1.0, tp1: 2.0, tp2: 3.0 },
  '4️⃣ MA20/MA50+RSI (1h)':          { sl: 3.0, tp1: 6.0, tp2: 9.0 },
  '5️⃣ RSI Дивергенция (1h)':        { sl: 2.0, tp1: 4.0, tp2: 6.0 },
  '6️⃣ Funding Extreme (1h)':        { sl: 2.5, tp1: 5.0, tp2: 7.5 },
  '7️⃣ Поглощение на объёме (15m)':  { sl: 1.5, tp1: 3.0, tp2: 4.5 },
  '8️⃣ Basis Farming (1h)': { sl: 2.0, tp1: 4.0, tp2: 6.0 },
};

const S2 = { priceMax: -2.5, oiMin: 2.0, vdeltaMax: -1500000, ticksMin: 500, volMin: 10000000 };

const MIN_VOLUME_24H = 10000000;
const TOP_N          = 30;
const COOLDOWN_MIN   = 30;

// ── Портфельный риск-менеджмент ────────────────────────────
const MAX_OPEN_TRADES     = 3;    // максимум открытых сделок
const MAX_CORRELATED      = 2;    // максимум сделок в одном секторе
const MAX_DAILY_LOSS_PCT  = 5.0;  // дневной лимит убытка %
const MAX_SAME_DIRECTION  = 2;    // максимум лонгов или шортов одновременно

// Секторы монет для проверки корреляции
const COIN_SECTORS = {
  BTC: 'store_of_value', ETH: 'layer1', BNB: 'layer1',
  SOL: 'layer1', ADA: 'layer1', AVAX: 'layer1', NEAR: 'layer1',
  APT: 'layer1', ATOM: 'layer1', DOT: 'layer1', TIA: 'layer1',
  MATIC: 'layer2', ARB: 'layer2', OP: 'layer2',
  LINK: 'defi', AAVE: 'defi', INJ: 'defi',
  DOGE: 'meme', SHIB: 'meme', PEPE: 'meme', WIF: 'meme',
  LTC: 'payments', XRP: 'payments', XLM: 'payments', BCH: 'payments',
};

// Дневной PnL трекер
if (!global.dailyPnlTracker) {
  global.dailyPnlTracker = { date: '', losses: 0, wins: 0 };
}

function checkPortfolioRisk(sig) {
  const open = store.openTrades;
  const symbol = sig.instId.replace('-USDT-SWAP', '');

  // 1. Максимум открытых сделок
  if (open.length >= MAX_OPEN_TRADES) {
    console.log(`[PORTFOLIO] Лимит сделок (${open.length}/${MAX_OPEN_TRADES})`);
    return { allowed: false, reason: 'Лимит открытых сделок' };
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
    global.dailyPnlTracker = { date: today, losses: 0, wins: 0 };
  }
  if (global.dailyPnlTracker.losses >= MAX_DAILY_LOSS_PCT) {
    console.log(`[PORTFOLIO] Дневной лимит убытка достигнут: ${global.dailyPnlTracker.losses}%`);
    return { allowed: false, reason: 'Дневной лимит убытка' };
  }

  return { allowed: true };
}

function updateDailyPnl(pnl) {
  const today = new Date().toISOString().split('T')[0];
  if (global.dailyPnlTracker.date !== today) {
    global.dailyPnlTracker = { date: today, losses: 0, wins: 0 };
  }
  if (pnl < 0) global.dailyPnlTracker.losses += Math.abs(pnl);
  else global.dailyPnlTracker.wins += pnl;
}

// Рейтинг стратегий по win rate
const STRATEGY_META = {
  '2️⃣ Liquidity Bounce (1h)': { color: '#fbbf24', rating: 'B', wr: 'Обновлена' },
  '3️⃣ Ранний вход (5m)':           { color: '#4a5a7a', rating: 'C', wr: '~38% (откл.)' },
  '4️⃣ MA20/MA50+RSI (1h)':         { color: '#34d399', rating: 'A', wr: '~40%' },
  '5️⃣ RSI Дивергенция (1h)':       { color: '#34d399', rating: 'A', wr: '~67%' },
  '6️⃣ Funding Extreme (1h)':       { color: '#34d399', rating: 'A', wr: '~68%' },
  '7️⃣ Поглощение на объёме (15m)': { color: '#fbbf24', rating: 'B', wr: '~58%' },
  '8️⃣ Basis Farming (1h)': { color: '#34d399', rating: 'A', wr: 'Новая' },
};

// ── Хранилище в памяти (вместо ScriptProperties) ──────────
const store = {
  cooldowns:    {},
  openTrades:   [],
  tradeHistory: [],
  signalLog:    [],
  fngCache:     null,
  fngTs:        0,
  oiCache:      {},
  klinesCache:  {},  // кэш свечей на 60 секунд
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
    await new Promise(r => setTimeout(r, 1500)); // пауза 1500ms
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
//  TELEGRAM КОМАНДЫ
// ============================================================
async function handleTelegramCommand(text, chatId) {
  const cmd = text.trim().toLowerCase();

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
      .select('pnl,outcome')
      .order('closed_at', { ascending: true })
      .limit(500);
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
    const fng    = store.fngCache || { value: '?', label: '?' };

    await sendTelegramTo(chatId,
      `📊 СТАТИСТИКА\n━━━━━━━━━━━━━━━━━━━━━━\n` +
      `😐 F&G: ${fng.value} (${fng.label})\n\n` +
      `📅 За сегодня:\n` +
      `  Сигналов: ${sigs}\n` +
      `  Сделок: ${today.length} | ✅ ${wins.length} ❌ ${losses.length}\n` +
      `  Win Rate: ${wr}%\n` +
      `  PnL: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(1)}%\n\n` +
      `📈 За всё время:\n` +
      `  Сделок: ${store.tradeHistory.length}\n` +
      `  Win Rate: ${allWR}%\n` +
      `  Открытых: ${store.openTrades.length}`
    );
  }

  else if (cmd === '/help') {
    await sendTelegramTo(chatId,
      `🤖 КРИПТО РАДАР\n━━━━━━━━━━━━━━━━━━━━━━\n` +
      `/status — открытые сделки\n` +
      `/trades — последние 10 сделок\n` +
      `/stats  — статистика за день\n` +
      `/guide  — инструкция по сигналам\n` +
      `/help   — это сообщение`
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

async function pollTelegramUpdates() {
  let offset = 0;
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
          const msg = update.message;
          if (msg?.text?.startsWith('/')) {
            console.log(`[TG CMD] ${msg.text} от ${msg.chat.id}`);
            await handleTelegramCommand(msg.text, msg.chat.id);
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
${sig.srNote      ? 'Уровни S/R: '  + sig.srNote      : ''}
${sig.fngNote     ? 'F&G: '         + sig.fngNote     : ''}
${sig.patternNote ? 'Паттерны: '    + sig.patternNote  : ''}
${sig.liqNote     ? 'Ликвидации: '  + sig.liqNote     : ''}
${sig.newsNote    ? 'Новости: '     + sig.newsNote    : ''}
${sig.whaleNote   ? 'Киты: '        + sig.whaleNote   : ''}

ПРАВИЛА ОЦЕНКИ:
- Рейтинг A (S4,S5,S6): одобряй при confidence 70%+
- Рейтинг B (S2,S7): одобряй при confidence 75%+
- Минимум 2 подтверждающих фактора → APPROVE
- Азия сессия → снижай уверенность но не всегда REJECT
- Ты не обязан отклонять — одобряй хорошие сигналы

Ответь СТРОГО в одном из двух форматов:
APPROVE | 94
или
REJECT | причина одной строкой`;

  try {
    // Пробуем Claude API
    if (process.env.CLAUDE_KEY) {
      const data = await httpPost(
        'https://api.anthropic.com/v1/messages',
        {
          model:      'claude-haiku-4-5-20251001',
          max_tokens: 100,
          messages:   [{ role: 'user', content: prompt }],
        },
        {
          'x-api-key':         process.env.CLAUDE_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Type':      'application/json',
        }
      );
      const response = data?.content?.[0]?.text || '';
      if (response.trim()) {
        const line = response.trim().split('\n')[0].trim();
        console.log(`[CLAUDE] ${sig.instId} → ${line}`);
        return parseAIResponse(line, sig);
      }
    }

    // Fallback — Groq
    console.log('[AI] Claude недоступен → Groq');
    const response = await callGroq(prompt);
    const line = response.trim().split('\n')[0].trim();
    console.log(`[GROQ] ${sig.instId} → ${line}`);
    return parseAIResponse(line, sig);

  } catch(e) {
    console.error('[AI] error:', e.message);
    return { approved: true, confidence: sig.confidence, reason: 'AI недоступен' };
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
    .sort((a, b) => {
    // Сортируем по комбинации объёма и движения цены
    const scoreA = b.volume24h + Math.abs(a.change24h) * 1e8;
    const scoreB = a.volume24h + Math.abs(b.change24h) * 1e8;
    return scoreA - scoreB;
    })
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
async function checkMacroEvents() {
  try {
    const data = await httpGet('https://nfs.faireconomy.media/ff_calendar_thisweek.json');
    if (!data || !Array.isArray(data)) return null;
    const now = Date.now();
    const twoHours = 2 * 60 * 60 * 1000;
    const highImpact = data.filter(e => {
      if (e.impact !== 'High') return false;
      if (e.country !== 'USD') return false;
      const eventTime = new Date(e.date).getTime();
      return Math.abs(now - eventTime) < twoHours;
    });
    if (!highImpact.length) return null;
    return { events: highImpact.map(e => e.title).join(', '), count: highImpact.length };
  } catch(e) { return null; }
}

// Кэш для CoinGecko (лимит 30 req/min)
let coingeckoCache = { data: null, ts: 0 };
const COINGECKO_TTL = 10 * 60 * 1000; // 10 минут

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

  // За 2 часа до и после важного события — снижаем уверенность
  sig.confidence  = Math.max(sig.confidence - 20, 0);
  sig.macroNote   = `⚠️ Макро событие: ${macroEvent.events} → -20%`;
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
    const symbol = sig.instId.replace('-USDT-SWAP', '');
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
  const whale = await getWhaleActivity(sig.instId, sig.instId.replace('-USDT-SWAP',''));
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
  // Минимальные пороги
  const MIN_SL_PCT  = 1.0; // минимум 1% стоп
  const MAX_SL_PCT  = 2.7; // максимум 2.7% стоп
  const MIN_TP1_PCT = 3.0; // минимум 3% TP1
  const MIN_TP2_PCT = 5.0; // минимум 5% TP2

  let slDist, tp1Dist, tp2Dist;

  if (atr && atr > 0) {
    slDist  = atr * 1.5;
    tp1Dist = atr * 3.0;
    tp2Dist = atr * 4.5;
  } else {
    const params = STRATEGY_SL[strategy] || { sl: 1.5, tp1: 3.0, tp2: 4.5 };
    slDist  = price * params.sl  / 100;
    tp1Dist = price * params.tp1 / 100;
    tp2Dist = price * params.tp2 / 100;
  }

  // Применяем ограничения
  const minSL  = price * MIN_SL_PCT  / 100;
  const maxSL  = price * MAX_SL_PCT  / 100;
  const minTP1 = price * MIN_TP1_PCT / 100;
  const minTP2 = price * MIN_TP2_PCT / 100;

  slDist  = Math.min(Math.max(slDist,  minSL),  maxSL);
  tp1Dist = Math.max(tp1Dist, minTP1);
  tp2Dist = Math.max(tp2Dist, minTP2);

  // Гарантируем RR минимум 1:2
  if (tp1Dist < slDist * 2) tp1Dist = slDist * 2;
  if (tp2Dist < slDist * 3) tp2Dist = slDist * 3;

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
    // MA200 на дневном таймфрейме — главный тренд
    const kD = await getOKXKlinesCached(instId, '1D', 210);
    if (kD.length < 200) return sig;

    const ma200 = calcSMA(kD, 200);
    const price = sig.price;
    const dist  = ((price - ma200) / ma200 * 100).toFixed(2);

    if (sig.direction === 'long') {
      if (price > ma200) {
        // Выше MA200 — глобальный бычий тренд
        sig.confidence = Math.min(sig.confidence + 8, 100);
        sig.ma200Note  = `📈 Выше MA200 дневной ($${ma200.toFixed(2)}) → +8%`;
      } else {
        // Ниже MA200 — глобальный медвежий тренд, лонги опасны
        sig.confidence = Math.max(sig.confidence - 15, 0);
        sig.ma200Note  = `⚠️ Ниже MA200 дневной ($${ma200.toFixed(2)}) → -15%`;
      }
    } else {
      if (price < ma200) {
        sig.confidence = Math.min(sig.confidence + 8, 100);
        sig.ma200Note  = `📉 Ниже MA200 дневной ($${ma200.toFixed(2)}) → +8%`;
      } else {
        sig.confidence = Math.max(sig.confidence - 15, 0);
        sig.ma200Note  = `⚠️ Выше MA200 дневной ($${ma200.toFixed(2)}) → -15%`;
      }
    }
  } catch(e) { console.error('applyMA200 error:', e.message); }
  return sig;
}

// ============================================================
//  РЕЖИМ РЫНКА
// ============================================================
function calcADX(klines, period = 14) {
  if (!klines || klines.length < period + 1) return 0;
  const trs = [], plusDMs = [], minusDMs = [];
  for (let i = 1; i < klines.length; i++) {
    const h = klines[i].high, l = klines[i].low, pc = klines[i-1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    const upMove   = h - klines[i-1].high;
    const downMove = klines[i-1].low - l;
    plusDMs.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDMs.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }
  const smooth = (arr, p) => {
    let s = arr.slice(0, p).reduce((a,b) => a+b, 0);
    const res = [s];
    for (let i = p; i < arr.length; i++) {
      s = s - s/p + arr[i];
      res.push(s);
    }
    return res;
  };
  const atrS    = smooth(trs, period);
  const plusS   = smooth(plusDMs, period);
  const minusS  = smooth(minusDMs, period);
  const dxArr   = atrS.map((a, i) => {
    const di_plus  = a ? plusS[i]  / a * 100 : 0;
    const di_minus = a ? minusS[i] / a * 100 : 0;
    const sum = di_plus + di_minus;
    return sum ? Math.abs(di_plus - di_minus) / sum * 100 : 0;
  });
  return dxArr.slice(-period).reduce((a,b) => a+b, 0) / period;
}

async function getMarketRegime(instId) {
  try {
    const k1h = await getOKXKlinesCached(instId, '1H', 30);
    const k4h = await getOKXKlinesCached(instId, '4H', 30);
    const k1d = await getOKXKlinesCached(instId, '1D', 210);

    const adx1h = calcADX(k1h, 14);
    const adx4h = calcADX(k4h, 14);
    // Используем среднее — 4H весит больше (надёжнее)
    const adx = adx1h * 0.35 + adx4h * 0.65;

    const atr    = calcATR(k1h, 14);
    const atrAvg = k1h.slice(-20).reduce((s,c,i,a) => {
      if (i === 0) return s;
      return s + Math.abs(c.close - a[i-1].close);
    }, 0) / 19;

    const ma200   = k1d.length >= 200 ? calcSMA(k1d, 200) : null;
    const price   = k1h[k1h.length-1]?.close || 0;

    const isTrending = adx > 25;
    const isSideways = adx < 20;
    const isHighVol  = atr > atrAvg * 1.8;
    const isBearMkt  = ma200 ? price < ma200 : false;

    // Дополнительно: если 4H сильно трендовый — усиливаем сигнал
    const isStrongTrend = adx4h > 30;

    console.log(`[REGIME] ${instId} ADX 1H:${adx1h.toFixed(1)} 4H:${adx4h.toFixed(1)} Avg:${adx.toFixed(1)} ${isTrending?'TREND':isSideways?'SIDEWAYS':'NEUTRAL'} ${isBearMkt?'BEAR':''}`);

    return { adx, adx1h, adx4h, isTrending, isSideways, isHighVol, isBearMkt, isStrongTrend, ma200, price };
  } catch(e) {
    return { adx: 0, adx1h: 0, adx4h: 0, isTrending: false, isSideways: true, isHighVol: false, isBearMkt: false, isStrongTrend: false };
  }
}

function applyMarketRegime(sig, regime) {
  if (!regime) return sig;

  // 1. Медвежий рынок — блокируем лонги кроме S5
  if (regime.isBearMkt && sig.direction === 'long') {
    const isS5 = sig.strategy.includes('RSI Диверг');
    if (!isS5) {
      sig.confidence = Math.max(sig.confidence - 20, 0);
      sig.regimeNote = `⚠️ Медвежий рынок (ниже MA200) → -20%`;
    } else {
      // S5 в медвежьем рынке — осторожно но разрешаем
      sig.confidence = Math.max(sig.confidence - 8, 0);
      sig.regimeNote = `⚠️ Медвежий рынок — S5 осторожно → -8%`;
    }
  }

  // 2. Высокая волатильность — уменьшаем уверенность
  if (regime.isHighVol) {
    sig.confidence = Math.max(sig.confidence - 10, 0);
    sig.regimeNote = (sig.regimeNote || '') + ` 🌊 Высокая волатильность → -10%`;
  }

  // 3. Сильный тренд (4H ADX > 30) — S2 Bounce очень рискован
  if (regime.isStrongTrend && sig.strategy.includes('Bounce')) {
    sig.confidence = Math.max(sig.confidence - 20, 0);
    sig.regimeNote = `📈 Сильный тренд (4H ADX:${regime.adx4h.toFixed(0)}) — bounce опасен → -20%`;
  }
  // Обычный тренд — S2 тоже под давлением
  else if (regime.isTrending && sig.strategy.includes('Bounce')) {
    sig.confidence = Math.max(sig.confidence - 12, 0);
    sig.regimeNote = `📈 Тренд (ADX:${regime.adx.toFixed(0)}) — bounce рискован → -12%`;
  }

  // 4. Боковик — MA Cross слабее
  if (regime.isSideways && sig.strategy.includes('MA20')) {
    sig.confidence = Math.max(sig.confidence - 10, 0);
    sig.regimeNote = `↔️ Боковик (ADX:${regime.adx.toFixed(0)}) — MA крест слабее → -10%`;
  }

  // 5. Сильный тренд подтверждает S5 и S4
  if (regime.isStrongTrend) {
    if (sig.strategy.includes('RSI Диверг') || sig.strategy.includes('MA20')) {
      sig.confidence = Math.min(sig.confidence + 7, 100);
      sig.regimeNote = (sig.regimeNote || '') + ` 💪 Сильный тренд подтверждает → +7%`;
    }
  }

  return sig;
}

function calcATR(klines, period = 14) {
  if (klines.length < period + 1) return 0;
  const trs = [];
  for (let i = 1; i < klines.length; i++) {
    const high  = klines[i].high;
    const low   = klines[i].low;
    const prev  = klines[i-1].close;
    trs.push(Math.max(high - low, Math.abs(high - prev), Math.abs(low - prev)));
  }
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}


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
  // S4: MA20/MA50 + RSI — улучшенная версия
if (k1h.length >= 55) {
  const cross  = calcMACross(k1h, 20, 50);
  const rsi    = calcRSI(k1h, 14);
  const ma20   = calcSMA(k1h, 20);
  const ma50   = calcSMA(k1h, 50);
  const macd   = calcMACD(k1h);
  const bb     = calcBollinger(k1h);
  const closes = k1h.map(c => c.close);
  const price  = coinData.price;

  // Расстояние между MA — чем меньше тем свежее крест
  const maDist = Math.abs(ma20 - ma50) / ma50 * 100;
  const freshCross = maDist < 0.5; // крест произошёл недавно

  // Цена не должна быть далеко от MA20 — значит мы не опоздали
  const priceNearMA = Math.abs(price - ma20) / ma20 * 100 < 1.5;

  // RSI дивергенция как подтверждение разворота
  const lows   = k1h.map(c => c.low);
  const rsiPrev = calcRSI(k1h.slice(0, -5), 14);
  const bullDiv = lows[lows.length-1] < Math.min(...lows.slice(-20,-1)) && rsi > rsiPrev + 2; // 20 свечей — лучше качество дивергенции
  const bearDiv = closes[closes.length-1] > Math.max(...closes.slice(-20,-1)) && rsi < rsiPrev - 2;

  const iL = cross === 'bullish' && rsi < 55 && rsi > 30 && macd.hist > 0;
  const iS = cross === 'bearish' && rsi > 45 && rsi < 70 && macd.hist < 0;

  if ((iL || iS) && (freshCross || priceNearMA)) {
    const dir = iL ? 'long' : 'short';
    let conf  = 58; // снижаем базовый с 68 до 58

    // Бонусы за подтверждения
    if (freshCross)  conf += 8;  // свежий крест
    if (priceNearMA) conf += 5;  // цена рядом с MA
    if (iL && bullDiv) conf += 10; // бычья дивергенция RSI
    if (iS && bearDiv) conf += 10; // медвежья дивергенция RSI
    if (iL && rsi < 45) conf += 7; // RSI перепродан
    if (iS && rsi > 55) conf += 7; // RSI перекуплен
    if (iL && price < bb.lower * 1.01) conf += 5; // цена у нижней BB
    if (iS && price > bb.upper * 0.99) conf += 5; // цена у верхней BB

    signals.push({
      strategy:  '4️⃣ MA20/MA50+RSI (1h)',
      instId, direction: dir,
      signal:    dir === 'long' ? '🟢 LONG' : '🔴 SHORT',
      price, confidence: Math.min(conf, 100),
      metrics:   `MA20:${ma20.toFixed(4)} MA50:${ma50.toFixed(4)} RSI:${rsi} MACD:${macd.hist > 0 ? '▲' : '▼'} Dist:${maDist.toFixed(2)}% ${cross === 'bullish' ? '🔀 Golden Cross' : '🔀 Death Cross'}`,
      ...calcSLTP(price, dir, '4️⃣ MA20/MA50+RSI (1h)', atr1h),
    });
  }
}

    // S5: RSI Дивергенция (1h) — цена новый минимум, RSI нет = разворот вверх
    if (k1h.length >= 20) {
      const closes = k1h.map(c => c.close);
      const lows   = k1h.map(c => c.low);
      const rsiNow = calcRSI(k1h, 14);
      const rsiPrev= calcRSI(k1h.slice(0, -5), 14);

      const priceNewLow  = lows[lows.length-1] < Math.min(...lows.slice(-20, -1)); // 20 свечей вместо 10 — меньше ложных дивергенций
      const rsiHigher    = rsiNow > rsiPrev + 3;
      const priceNewHigh = closes[closes.length-1] > Math.max(...closes.slice(-20, -1)); // 20 свечей вместо 10
      const rsiLower     = rsiNow < rsiPrev - 3;

      if (priceNewLow && rsiHigher && rsiNow < 42) {
        // Бычья дивергенция → LONG
        signals.push({
          strategy: '5️⃣ RSI Дивергенция (1h)', instId, direction: 'long',
          signal: '🟢 LONG', price, confidence: 78,
          metrics: `RSI сейчас:${rsiNow} RSI ранее:${rsiPrev.toFixed(1)} Цена новый лоу: да`,
          ...calcSLTP(price, 'long',  '5️⃣ RSI Дивергенция (1h)', atr1h)
        });
      }
      if (priceNewHigh && rsiLower && rsiNow > 55) {
        // Медвежья дивергенция → SHORT
        signals.push({
          strategy: '5️⃣ RSI Дивергенция (1h)', instId, direction: 'short',
          signal: '🔴 SHORT', price, confidence: 78,
          metrics: `RSI сейчас:${rsiNow} RSI ранее:${rsiPrev.toFixed(1)} Цена новый хай: да`,
          ...calcSLTP(price, 'short', '5️⃣ RSI Дивергенция (1h)', atr1h)
        });
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

    // S7: Поглощение на объёме (15m) — жёсткие фильтры
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

    // S8: Basis Farming — разница фьючерс/спот
    try {
      const spotData = await httpGet(`https://www.okx.com/api/v5/market/ticker?instId=${coinData.symbol}-USDT`);
      if (spotData?.code === '0' && spotData.data?.length) {
        const spotPrice    = parseFloat(spotData.data[0].last);
        const futurePrice  = price;
        const basis        = (futurePrice - spotPrice) / spotPrice * 100;
        const rsi1h        = calcRSI(k1h, 14);
        const atr          = calcATR(k1h, 14);

        // Сильное контанго → шортисты будут закрываться → SHORT
        if (basis > 0.8 && rsi1h > 55 && atr) { // порог 0.3%→0.8% убираем шум
          signals.push({
            strategy:  '8️⃣ Basis Farming (1h)',
            instId, direction: 'short',
            signal:    '🔴 SHORT', price, confidence: 60,
            metrics:   `Basis:+${basis.toFixed(3)}% (фьюч дороже спота) RSI:${rsi1h}`,
            ...calcSLTP(price, 'short', '8️⃣ Basis Farming (1h)', atr)
          });
        }

        // Сильная бэквордация → лонгисты будут закрываться → LONG
        if (basis < -0.8 && rsi1h < 45 && atr) { // порог 0.3%→0.8% убираем шум
          signals.push({
            strategy:  '8️⃣ Basis Farming (1h)',
            instId, direction: 'long',
            signal:    '🟢 LONG', price, confidence: 60,
            metrics:   `Basis:${basis.toFixed(3)}% (фьюч дешевле спота) RSI:${rsi1h}`,
            ...calcSLTP(price, 'long', '8️⃣ Basis Farming (1h)', atr)
          });
        }
      }
    } catch(e) { console.error('S8 error:', e.message); }



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
  const filled   = Math.round(sig.confidence / 10);
  const bar      = '█'.repeat(filled) + '░'.repeat(10 - filled);
  const emoji    = sig.direction === 'long' ? '🚀' : '🩸';
  const name     = sig.instId.replace('-USDT-SWAP', '');
  const meta      = STRATEGY_META[sig.strategy] || { color: '#999', rating: '?', wr: '?' };
  const ratingLine = `${meta.rating === 'A' ? '🟢' : meta.rating === 'B' ? '🟡' : '🔴'} Рейтинг: ${meta.rating} | Win Rate: ${meta.wr}`;
  const timeStr  = getAlmatyTime();
  const fngEmoji = !sig.fng ? '😐' : sig.fng.value < 25 ? '😱' : sig.fng.value > 75 ? '🤑' : '😐';
  const fngLine  = sig.fng ? `${fngEmoji} F&G: ${sig.fng.value} (${sig.fng.label})` : '';
  const slPct = sig.price && sig.sl
    ? Math.abs((parseFloat(sig.sl) - sig.price) / sig.price * 100).toFixed(2)
    : null;
  if (slPct) sig.slPctNote = `📏 ATR стоп: ${slPct}% от цены`;
  const notes = [sig.srNote, sig.slNote, sig.slPctNote, sig.fngNote, sig.sessionNote, sig.dowNote, sig.macroNote, sig.etfNote, sig.regimeNote, sig.lsrNote, sig.btcDomNote, sig.cbNote, sig.liqNote, sig.liqLevelNote, sig.patternNote, sig.chartPatNote, sig.newsNote, sig.whaleNote, sig.trendNote, sig.ma200Note, sig.vwapNote, sig.mtfNote, sig.obvNote, sig.bbNote, sig.volNote, sig.fvgNote, sig.fibNote, sig.aiNote]
    .filter(Boolean).map(n => `  ${n}`).join('\n');
  const duration = estimateTradeDuration(sig.strategy, sig.atr, sig.price);
  return (
    `${emoji} ${name}/USDT — ${sig.signal}\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `📌 ${sig.strategy}\n` +
    `${ratingLine}\n` +
    `⏰ ${timeStr} Алматы\n` +
    `⌛️ Ориентир: ${duration} в позиции\n` +
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

const fs = require('fs');
const path = require('path');

// ── NEWS API ──────────────────────────────────────────────────
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
        const xml = await httpGet(feed.url);
        if (!xml || typeof xml !== 'string') continue;
        const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)];
        for (const item of items.slice(0, 8)) {
          const c = item[1];
          const title   = (c.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/) || c.match(/<title>([\s\S]*?)<\/title>/))?.[1]?.trim() || '';
          const pubDate = (c.match(/<pubDate>(.*?)<\/pubDate>/))?.[1] || '';
          const link    = (c.match(/<link>(.*?)<\/link>/))?.[1]?.trim() || '';
          if (!title || title.length < 5) continue;
          articles.push({ title, pubDate, link, source: feed });
        }
      } catch(e) { continue; }
    }

    articles.sort((a,b) => new Date(b.pubDate) - new Date(a.pubDate));
    res.json({ ok: true, data: articles });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
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

async function httpGetFast(url) {
  try {
    await new Promise(r => setTimeout(r, 300)); // быстрая пауза 300ms
    const resp = await axios.get(url, { timeout: 30000 });
    return resp.data;
  } catch(e) {
    return null;
  }
}

async function runBacktest(coins, limit = 300) {
  const strategies = {
  /* 'S1 Пробой 15m':     { signals:0, wins:0, losses:0, expired:0, pnl:0, trades:[] }, */
  'S2 Bounce 1h':      { signals:0, wins:0, losses:0, expired:0, pnl:0, trades:[] },
  'S4 MA/RSI':         { signals:0, wins:0, losses:0, expired:0, pnl:0, trades:[] },
  'S5 RSI Дивергенция':{ signals:0, wins:0, losses:0, expired:0, pnl:0, trades:[] },
  'S7 Поглощение':     { signals:0, wins:0, losses:0, expired:0, pnl:0, trades:[] },
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

// Загружаем 15m свечи для S1


if (klines1h.length < 60) continue;

    const runs = [
  /* { name:'S1 Пробой 15m',      fn: btS1 }, */
  { name:'S2 Bounce 1h',       fn: btS2 },
  { name:'S4 MA/RSI',          fn: btS4 },
  { name:'S5 RSI Дивергенция', fn: btS5 },
  { name:'S7 Поглощение',      fn: btS7 },
  //{ name:'S9 Pairs Trading',   fn: btS9 },
];

    for (const { name, fn } of runs) {
      // S1 использует 15m свечи, остальные — 1H
      const klines = klines1h;
      let lastI = -10;
      for (let i = 55; i < klines.length - 15; i++) {
        if (i - lastI < 5) continue;
        const direction = fn(klines, i);
        if (!direction) continue;

        const price = klines[i].close;
        const atr   = calcATR(klines.slice(0, i+1), 14);
        if (!atr || atr === 0) continue;

        const sl  = direction === 'long' ? price - atr*1.5 : price + atr*1.5;
        const tp1 = direction === 'long' ? price + atr*3.0 : price - atr*3.0;
        const tp2 = direction === 'long' ? price + atr*4.5 : price - atr*4.5;

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
  const slice = klines.slice(0, i+1);
  if (slice.length < 55) return null;
  const cross = calcMACross(slice, 20, 50);
  const rsi   = calcRSI(slice, 14);
  const macd  = calcMACD(slice);
  const ma20  = calcSMA(slice, 20);
  const ma50  = calcSMA(slice, 50);
  const price = slice[slice.length-1].close;
  const maDist = Math.abs(ma20 - ma50) / ma50 * 100;
  const freshCross  = maDist < 0.5;
  const priceNearMA = Math.abs(price - ma20) / ma20 * 100 < 1.5;
  if (!freshCross && !priceNearMA) return null;
  if (cross==='bullish' && rsi<55 && rsi>30 && macd.hist>0) return 'long';
  if (cross==='bearish' && rsi>45 && rsi<70 && macd.hist<0) return 'short';
  return null;
}

function btS5(klines, i) {
  const slice  = klines.slice(0, i+1);
  if (slice.length < 20) return null;
  const closes = slice.map(c => c.close);
  const lows   = slice.map(c => c.low);
  const rsiNow = calcRSI(slice, 14);
  const rsiPrev= calcRSI(slice.slice(0,-5), 14);
  if (lows[lows.length-1] < Math.min(...lows.slice(-20,-1)) && rsiNow > rsiPrev+3 && rsiNow < 45) return 'long'; // 20 свечей — sync с live
  if (closes[closes.length-1] > Math.max(...closes.slice(-20,-1)) && rsiNow < rsiPrev-3 && rsiNow > 55) return 'short';
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

async function checkSignals() {
  if (isRunning) { console.log('[SKIP] checkSignals уже выполняется'); return; }
  isRunning = true;
  try {
    console.log(`[${getAlmatyTime()}] checkSignals запущен`);

    const candidates   = await getOKXCandidates();
    if (!candidates.length) { console.log('Нет кандидатов'); return; }

    const fng          = await getFearAndGreed();
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

// Блокируем если монета уже в открытых сделках
const alreadyOpen = store.openTrades.some(t => t.instId === coin.instId);
if (alreadyOpen) {
  console.log(`[SKIP] ${coin.instId} уже в открытой сделке`);
  continue;
}

      let signals = await runStrategies(coin.instId, coin, asianSession);
      if (!signals.length) continue;

      // Вычисляем один раз ДО цикла — не повторяем для каждого сигнала
      const regime = await getMarketRegime(coin.instId);
      const lsr    = await getLongShortRatio(coin.symbol);

      const filtered = [];
      for (let sig of signals) {
        sig = applyFearGreed(sig, fng);
        sig = await applySupportResistance(sig, coin.instId);
        sig = applySessionFilter(sig, session);
        sig = await applyCandlePatterns(sig, coin.instId);
        sig = await applyLiquidationBoost(sig);
        sig = await applyWhaleBoost(sig);
        sig = applyVolumeProfile(sig, await getOKXKlinesCached(coin.instId, '1H', 21));
        sig = await apply4HTrend(sig, coin.instId);
        sig = applyVWAP(sig, await getOKXKlinesCached(coin.instId, '1H', 24));
        sig = await applyMA200(sig, coin.instId);
        sig = applyOBV(sig, await getOKXKlinesCached(coin.instId, '1H', 20));
        sig = applyBollingerSqueeze(sig, await getOKXKlinesCached(coin.instId, '1H', 25));
        sig = await applyMultiTimeframe(sig, coin.instId);
        sig = applyChartPatterns(sig, await getOKXKlinesCached(coin.instId, '1H', 20));
        sig = applyMacroFilter(sig, macroEvent);
        sig = applyETFFlow(sig, etfFlow);
        sig = applyMarketRegime(sig, regime);
        sig = applyLongShortRatio(sig, lsr);
        sig = applyBTCDominance(sig, btcDom, coin.symbol);
        sig = applyCoinbasePremium(sig, cbPremium);
        sig = applyDayOfWeekFilter(sig);
        sig = await applyLiquidationLevels(sig);

        // FVG зоны
        const fvgKlines = await getOKXKlinesCached(coin.instId, '1H', 30);
        const fvgZones  = detectFVG(fvgKlines.slice(-30));
        const atrForFVG = calcATR(fvgKlines, 14);

        // FVG буст уверенности
        const inFVG = priceInFVG(sig.price, fvgZones, sig.direction);
        if (inFVG) {
          sig.confidence = Math.min(sig.confidence + 12, 100);
          sig.fvgNote    = `📊 Цена в FVG зоне → +12%`;
        }

        // FVG стоп-лосс
        const fvgSL = calcFVGStopLoss(sig.price, sig.direction, fvgZones, atrForFVG);
        if (fvgSL) {
          sig.sl     = fvgSL.sl;
          sig.slNote = fvgSL.note;
          // Пересчитываем TP на основе нового SL (RR 1:2 и 1:3)
          const slDist = Math.abs(sig.price - parseFloat(fvgSL.sl));
          if (sig.direction === 'long') {
            sig.tp1 = (sig.price + slDist * 2).toFixed(4);
            sig.tp2 = (sig.price + slDist * 3).toFixed(4);
          } else {
            sig.tp1 = (sig.price - slDist * 2).toFixed(4);
            sig.tp2 = (sig.price - slDist * 3).toFixed(4);
          }
        }

        // Fibonacci TP — только если уровни логичны
        const fibKlines = await getOKXKlinesCached(coin.instId, '1H', 20);
        const fib = calcFibonacci(fibKlines, sig.direction, sig.price);
        if (fib) {
          sig.tp1 = fib.tp1.toFixed(4);
          sig.tp2 = fib.tp2.toFixed(4);
          sig.fibNote = `📐 Fibonacci TP: ${fib.key}`;
        }
        // Финальная проверка логики SL/TP
        const entry = sig.price;
        const sl    = parseFloat(sig.sl);
        const tp1   = parseFloat(sig.tp1);
        const tp2   = parseFloat(sig.tp2);

        if (sig.direction === 'long') {
          // Для лонга: SL < entry < TP1 < TP2
          if (sl >= entry || tp1 <= entry || tp2 <= tp1) {
            const atr = calcATR(await getOKXKlinesCached(coin.instId, '1H', 20), 14);
            sig.sl  = (entry - atr * 1.5).toFixed(4);
            sig.tp1 = (entry + atr * 3.0).toFixed(4);
            sig.tp2 = (entry + atr * 4.5).toFixed(4);
            sig.slNote = '📏 ATR стоп (fallback)';
          }
        } else {
          // Для шорта: SL > entry > TP1 > TP2
          if (sl <= entry || tp1 >= entry || tp2 >= tp1) {
            const atr = calcATR(await getOKXKlinesCached(coin.instId, '1H', 20), 14);
            sig.sl  = (entry + atr * 1.5).toFixed(4);
            sig.tp1 = (entry - atr * 3.0).toFixed(4);
            sig.tp2 = (entry - atr * 4.5).toFixed(4);
            sig.slNote = '📏 ATR стоп (fallback)';
          }
        }

        filtered.push(sig);
      }

      const fngValue = fng?.value || 50;

      const best = filtered
        .filter(s => s.confidence >= 80)
        .filter(s => {
          // Extreme Fear (< 25) — блокируем LONG кроме S2 и S7
          if (fngValue < 25 && s.direction === 'long') {
            const allowed = s.strategy.includes('Bounce') || s.strategy.includes('Поглощение');
            if (!allowed) {
              console.log(`[FNG BLOCK] ${s.instId} LONG заблокирован F&G:${fngValue}`);
              return false;
            }
          }
          // Extreme Greed (> 75) — блокируем SHORT кроме S2 и S7
          if (fngValue > 75 && s.direction === 'short') {
            const allowed = s.strategy.includes('Bounce') || s.strategy.includes('Поглощение');
            if (!allowed) {
              console.log(`[FNG BLOCK] ${s.instId} SHORT заблокирован F&G:${fngValue}`);
              return false;
            }
          }
          return true;
        })
        .sort((a, b) => b.confidence - a.confidence)[0];

      if (!best) continue;

      const news = await checkNews(coin.symbol);
      if (news.blocked) { console.log(`[NEWS BLOCK] ${coin.instId}`); continue; }
      if (news.note) best.newsNote = news.note;

      best.ts      = Date.now();
      best.fng     = fng;
      best.session = session;

      // Проверка портфельного риска ПЕРЕД AI валидацией
      const portfolioCheck = checkPortfolioRisk(best);
      if (!portfolioCheck.allowed) {
        console.log(`[PORTFOLIO BLOCK] ${coin.instId} — ${portfolioCheck.reason}`);
        continue;
      }

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
  } finally {
    isRunning = false;
  }
}

// ============================================================
//  TRAILING STOP — только для S5 RSI Дивергенция
// ============================================================
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

      // Уровень 1: достигли TP1 → переносим SL на безубыток
      if (currentPrice >= tp1 && !trade.trailingActive) {
        const newSL = (entry * 1.001).toFixed(4); // чуть выше входа
        if (parseFloat(newSL) > sl) {
          trade.sl            = newSL;
          trade.trailingActive = true;
          trade.trailingHigh   = currentPrice;
          console.log(`[TRAIL] ${trade.instId} — SL → безубыток $${newSL}`);
          supabase.from('open_trades').update({ sl: newSL, trailing_active: true })
            .eq('ts', trade.ts).eq('inst_id', trade.instId)
            .then(() => {}).catch(e => console.error('[TRAIL DB]', e.message));
          await sendTelegram(
            `🔄 TRAILING STOP — ${trade.symbol}/USDT\n` +
            `━━━━━━━━━━━━━━━━━━━━━━\n` +
            `✅ TP1 достигнут — SL перенесён на безубыток\n` +
            `💰 Вход: $${trade.price}\n` +
            `🛡 Новый SL: $${newSL}\n` +
            `📍 Цена: $${currentPrice.toFixed(4)}\n` +
            `📈 PnL: +${pnlPct.toFixed(2)}%\n` +
            `━━━━━━━━━━━━━━━━━━━━━━`
          );
        }
      }

      // Уровень 2: trailing — SL следует за ценой с отступом 1.5%
      if (trade.trailingActive && currentPrice > (trade.trailingHigh || entry)) {
        trade.trailingHigh = currentPrice;
        const trailSL = (currentPrice * 0.985).toFixed(4); // -1.5% от максимума
        if (parseFloat(trailSL) > parseFloat(trade.sl)) {
          const oldSL = trade.sl;
          trade.sl    = trailSL;
          console.log(`[TRAIL] ${trade.instId} — SL поднят $${oldSL} → $${trailSL} (цена $${currentPrice.toFixed(4)})`);
          supabase.from('open_trades').update({ sl: trailSL })
            .eq('ts', trade.ts).eq('inst_id', trade.instId)
            .then(() => {}).catch(e => console.error('[TRAIL DB]', e.message));
        }
      }

    } else { // SHORT
      const pnlPct = (entry - currentPrice) / entry * 100;

      // Уровень 1: достигли TP1 → безубыток
      if (currentPrice <= tp1 && !trade.trailingActive) {
        const newSL = (entry * 0.999).toFixed(4); // чуть ниже входа
        if (parseFloat(newSL) < sl) {
          trade.sl             = newSL;
          trade.trailingActive = true;
          trade.trailingLow    = currentPrice;
          console.log(`[TRAIL] ${trade.instId} SHORT — SL → безубыток $${newSL}`);
          supabase.from('open_trades').update({ sl: newSL, trailing_active: true })
            .eq('ts', trade.ts).eq('inst_id', trade.instId)
            .then(() => {}).catch(e => console.error('[TRAIL DB]', e.message));
          await sendTelegram(
            `🔄 TRAILING STOP — ${trade.symbol}/USDT\n` +
            `━━━━━━━━━━━━━━━━━━━━━━\n` +
            `✅ TP1 достигнут — SL перенесён на безубыток\n` +
            `💰 Вход: $${trade.price}\n` +
            `🛡 Новый SL: $${newSL}\n` +
            `📍 Цена: $${currentPrice.toFixed(4)}\n` +
            `📉 PnL: +${pnlPct.toFixed(2)}%\n` +
            `━━━━━━━━━━━━━━━━━━━━━━`
          );
        }
      }

      // Уровень 2: trailing — SL следует за ценой с отступом 1.5%
      if (trade.trailingActive && currentPrice < (trade.trailingLow || entry)) {
        trade.trailingLow = currentPrice;
        const trailSL = (currentPrice * 1.015).toFixed(4); // +1.5% от минимума
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
    if (ageMin > 480) {
  trade.outcome = 'expired';
  trade.closedAt = Date.now();
  const expPrice = await getCurrentPrice(trade.instId);
  if (expPrice) {
    trade.closePrice = expPrice;
    const entry = parseFloat(trade.price);
    trade.pnl = trade.direction === 'long'
      ? parseFloat(((expPrice - entry) / entry * 100).toFixed(2))
      : parseFloat(((entry - expPrice) / entry * 100).toFixed(2));
  } else {
    trade.pnl = 0;
  }
  closed.push(trade);
  continue;
}

    const price = await getCurrentPrice(trade.instId);
    if (!price) { stillOpen.push(trade); continue; }

    let outcome = null;
    if (trade.direction === 'long') {
      if (price <= parseFloat(trade.sl)) {
        // Если trailing был активен — это фиксация прибыли а не стоп
        outcome = trade.trailingActive ? 'tp1' : 'sl';
      }
      else if (price >= parseFloat(trade.tp2)) outcome = 'tp2';
      else if (price >= parseFloat(trade.tp1) && !trade.trailingActive) outcome = 'tp1';
    } else {
      if (price >= parseFloat(trade.sl)) {
        outcome = trade.trailingActive ? 'tp1' : 'sl';
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
      updateDailyPnl(trade.pnl || 0);
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

// ============================================================
//  WHALE REPORT — рассылка активности китов (каждый час)
// ============================================================
async function checkWhales() {
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
    `⚠️ Не является финансовым советом.`
  );
}
// ============================================================
//  RSS НОВОСТИ
// ============================================================
async function checkRSSNews() {
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
          `⚠️ Не является финансовым советом.`
        );

        console.log(`[RSS] ${action}: ${title.slice(0,60)} | ${coins}`);
      }
    }
  } catch(e) {
    console.error('checkRSSNews error:', e.message);
  }
}
async function dailyReport() {
  const since = Date.now() - 24*60*60*1000;
  const fng   = await getFearAndGreed();

  try {
    // Читаем из Supabase а не из памяти
    const { data: trades } = await supabase
      .from('trades')
      .select('*')
      .gte('closed_at', since);

    const { data: signals } = await supabase
      .from('signals')
      .select('*')
      .gte('ts', since);

    const t = trades || [];
    const s = signals || [];

    if (!t.length && !s.length) {
      await sendTelegram(`📊 ДНЕВНОЙ ОТЧЁТ | ${getAlmatyDate()}\n😴 Сигналов не было.`);
      return;
    }

    const wins   = t.filter(x => x.outcome==='tp1'||x.outcome==='tp2');
    const losses = t.filter(x => x.outcome==='sl');
    const wr     = t.length ? Math.round(wins.length/t.length*100) : 0;
    const pnl    = t.reduce((a,x) => a+(parseFloat(x.pnl)||0), 0);
    const longs  = s.filter(x => x.direction==='long').length;
    const shorts = s.filter(x => x.direction==='short').length;

    let msg = `📊 ДНЕВНОЙ ОТЧЁТ v4.0\n━━━━━━━━━━━━━━━━━━━━━━\n🗓 ${getAlmatyDate()}\n😐 F&G: ${fng.value} (${fng.label})\n\n`;
    if (t.length) msg += `📈 Сделки: ${t.length} | ✅ TP: ${wins.length} ❌ SL: ${losses.length}\n🏆 Win Rate: ${wr}%  💰 PnL: ${pnl>=0?'+':''}${pnl.toFixed(1)}%\n\n`;
    if (s.length) msg += `📨 Сигналов: ${s.length} (🟢 ${longs} / 🔴 ${shorts})\n`;
    msg += '\n⚠️ Статистика бота, не реальных сделок.';

    await sendTelegram(msg);
  } catch(e) {
    console.error('dailyReport error:', e.message);
    await sendTelegram(`📊 ДНЕВНОЙ ОТЧЁТ | ${getAlmatyDate()}\n❌ Ошибка загрузки данных.`);
  }
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
cron.schedule('*/15 * * * *', () => {
  checkOutcomes().catch(e => console.error('checkOutcomes error:', e.message));
  checkTradeTimers().catch(e => console.error('checkTradeTimers error:', e.message));
  checkTrailingStop().catch(e => console.error('checkTrailingStop error:', e.message));
});
// Каждые 30 минут — RSS новости
cron.schedule('*/30 * * * *', () => { checkRSSNews().catch(e => console.error('RSS error:', e.message)); });

// Каждый час (в 00 минут)
cron.schedule('0 */2 * * *', () => { checkAnomalies().catch(e => console.error('checkAnomalies error:', e.message)); });

// Каждые 2 часа — whale активность
cron.schedule('0 */2 * * *', () => { checkWhales().catch(e => console.error('checkWhales error:', e.message)); });

// Каждый день в 07:00 UTC = 12:00 Алматы
cron.schedule('0 7 * * *', () => { dailyReport().catch(e => console.error('dailyReport error:', e.message)); });

// Загружаем открытые сделки из Supabase при старте
supabase.from('open_trades').select('*').then(({ data }) => {
  if (data?.length) {
    // Берём только сделки за последние 4 часа
    const fourHoursAgo = Date.now() - 4 * 60 * 60 * 1000;
    const recent = data.filter(t => +t.ts >= fourHoursAgo);
    store.openTrades = recent.map(t => ({
      ts: t.ts, instId: t.inst_id, symbol: t.symbol,
      strategy: t.strategy, direction: t.direction,
      price: t.price, sl: t.sl, tp1: t.tp1, tp2: t.tp2,
      confidence: t.confidence,
    }));
    console.log(`[START] Загружено ${recent.length} из ${data.length} открытых сделок (только за 4ч)`);
  }
});

// Первый запуск сразу при старте для проверки
setTimeout(() => {
  checkSignals().catch(e => console.error('Initial checkSignals error:', e.message));
}, 10000);
// Запускаем опрос команд Telegram
pollTelegramUpdates();

process.on('uncaughtException', e => {
  console.error('[CRASH PREVENTED]', e.message);
});
process.on('unhandledRejection', e => {
  console.error('[PROMISE ERROR]', e?.message || e);
});