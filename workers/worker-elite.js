// ============================================================
//  STOCK PRO -- Worker Elite: ข่าว ELITE figures
//  ENV: GROQ_KEY, ANTHROPIC_KEY, NEWS_API_KEY, TG_TOKEN, TG_CHAT_ID, ALERT_KV
//  Cron: 0 */4 * * * (ทุก 4 ชั่วโมง)
//  KV Binding: ALERT_KV
// ============================================================

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store'
};

const ELITE_PEOPLE_DEFAULT = [
  { id: 'trump',    name: 'Donald Trump',       emoji: '🔴', role: 'US President' },
  { id: 'powell',   name: 'Jerome Powell',       emoji: '🔴', role: 'Fed Chair' },
  { id: 'jensen',   name: 'Jensen Huang',        emoji: '🟢', role: 'NVIDIA CEO' },
  { id: 'cook',     name: 'John Ternus',          emoji: '🟢', role: 'Apple CEO' },
  { id: 'musk',     name: 'Elon Musk',           emoji: '🟡', role: 'Tesla/SpaceX CEO' },
  { id: 'nadella',  name: 'Satya Nadella',       emoji: '🟢', role: 'Microsoft CEO' },
  { id: 'zuck',     name: 'Mark Zuckerberg',     emoji: '🟢', role: 'Meta CEO' },
  { id: 'altman',   name: 'Sam Altman',          emoji: '🟢', role: 'OpenAI CEO' },
  { id: 'xi',       name: 'Xi Jinping',          emoji: '🟡', role: 'China President' },
  { id: 'putin',    name: 'Vladimir Putin',      emoji: '🟡', role: 'Russia President' },
  { id: 'lagarde',  name: 'Christine Lagarde',   emoji: '🟡', role: 'ECB President' },
  { id: 'opec',     name: 'OPEC',                emoji: '🟡', role: 'Oil Cartel' },
  { id: 'pichai',   name: 'Sundar Pichai',       emoji: '🟢', role: 'Google CEO' },
  { id: 'bezos',    name: 'Jeff Bezos',          emoji: '🟢', role: 'Amazon Founder' },
  { id: 'dimon',    name: 'Jamie Dimon',         emoji: '🟡', role: 'JPMorgan CEO' },
  { id: 'buffett',  name: 'Warren Buffett',      emoji: '🟢', role: 'Berkshire CEO' },
  { id: 'yellen',   name: 'Janet Yellen',        emoji: '🟡', role: 'US Treasury Sec.' },
  { id: 'iger',     name: 'Bob Iger',            emoji: '🟢', role: 'Disney CEO' },
  { id: 'modi',     name: 'Narendra Modi',       emoji: '🟡', role: 'India PM' },
  { id: 'khamenei', name: 'Ali Khamenei',        emoji: '🔴', role: 'Iran Supreme Leader' },
];

const WIKI_PAGES = {
  trump:    'Donald_Trump',
  powell:   'Jerome_Powell',
  jensen:   'Jensen_Huang',
  cook:     'Apple_Inc.',
  musk:     'Elon_Musk',
  nadella:  'Satya_Nadella',
  zuck:     'Mark_Zuckerberg',
  altman:   'Sam_Altman',
  pichai:   'Sundar_Pichai',
  bezos:    'Jeff_Bezos',
  dimon:    'Jamie_Dimon',
  buffett:  'Warren_Buffett',
  iger:     'The_Walt_Disney_Company',
  lagarde:  'Christine_Lagarde',
  yellen:   'Janet_Yellen',
  modi:     'Narendra_Modi',
};

async function fetchNameFromWiki(wikiPage) {
  try {
    const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(wikiPage)}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    const d = await r.json();
    const title = d.title || '';
    if (title.includes('Inc.') || title.includes('Company') || title === 'OPEC') return null;
    return title;
  } catch (e) {
    console.warn('[Wiki] fetch error:', wikiPage, e.message);
    return null;
  }
}

async function getElitePeople(env) {
  if (env.ALERT_KV) {
    try {
      const cached = await env.ALERT_KV.get('elite:people');
      if (cached) {
        const { data, ts } = JSON.parse(cached);
        if (Date.now() - ts < 24 * 3600 * 1000) {
          console.log('[Wiki] using cached elite people');
          return data;
        }
      }
    } catch (e) { console.warn('[Wiki] KV read error:', e.message); }
  }

  console.log('[Wiki] refreshing elite people from Wikipedia...');
  const updated = [...ELITE_PEOPLE_DEFAULT];

  for (const person of updated) {
    const wikiPage = WIKI_PAGES[person.id];
    if (!wikiPage) continue;
    const name = await fetchNameFromWiki(wikiPage);
    if (name && name !== person.name) {
      console.log(`[Wiki] updated ${person.id}: ${person.name} → ${name}`);
      person.name = name;
    }
  }

  if (env.ALERT_KV) {
    try {
      await env.ALERT_KV.put('elite:people', JSON.stringify({ data: updated, ts: Date.now() }), { expirationTtl: 86400 });
    } catch (e) { console.warn('[Wiki] KV write error:', e.message); }
  }

  return updated;
}

let ELITE_PEOPLE = ELITE_PEOPLE_DEFAULT;

const NEWS_QUERIES = {
  trump:    'Donald Trump policy economy markets',
  powell:   'Jerome Powell Federal Reserve interest rates',
  jensen:   'Jensen Huang NVIDIA AI chips earnings',
  xi:       'Xi Jinping China economy policy',
  musk:     'Elon Musk Tesla SpaceX',
  altman:   'Sam Altman OpenAI GPT',
};

function cleanText(text) {
  if (!text || typeof text !== 'string') return text;
  return text
    .replace(/[\u2E80-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F]/g, '')
    .replace(/[^\u0E00-\u0E7Fa-zA-Z0-9\s$%+\-.,!?:;()/&@#'"°฿\u2019\u2018\u201C\u201D]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanItem(item) {
  if (!item || typeof item !== 'object') return item;
  const strFields = ['headline','ai_take','what_happened','why_important','market_impact','action','read_game','watch','watchlist_alert'];
  for (const f of strFields) {
    if (item[f]) item[f] = cleanText(item[f]);
  }
  if (Array.isArray(item.stocks_to_monitor)) item.stocks_to_monitor = item.stocks_to_monitor.map(s=>({...s,reason:cleanText(s.reason)}));
  if (Array.isArray(item.stocks_at_risk)) item.stocks_at_risk = item.stocks_at_risk.map(s=>({...s,reason:cleanText(s.reason)}));
  if (Array.isArray(item.stocks_benefit)) item.stocks_benefit = item.stocks_benefit.map(s=>({...s,reason:cleanText(s.reason)}));
  if (Array.isArray(item.stocks_hurt)) item.stocks_hurt = item.stocks_hurt.map(s=>({...s,reason:cleanText(s.reason)}));
  if (Array.isArray(item.pros)) item.pros = item.pros.map(cleanText);
  if (Array.isArray(item.cons)) item.cons = item.cons.map(cleanText);
  if (Array.isArray(item.bullish_reasons)) item.bullish_reasons = item.bullish_reasons.map(cleanText);
  if (Array.isArray(item.bearish_reasons)) item.bearish_reasons = item.bearish_reasons.map(cleanText);
  if (Array.isArray(item.impact_stocks)) item.impact_stocks = item.impact_stocks.filter(s=>s && s.t);
  if (item.timeline) {
    item.timeline.short = cleanText(item.timeline.short);
    item.timeline.medium = cleanText(item.timeline.medium);
    item.timeline.long = cleanText(item.timeline.long);
  }
  return item;
}

async function sendTG(env, text) {
  const token = env.TG_TOKEN;
  const chatId = env.TG_CHAT_ID;
  if (!token || !chatId) return;
  const chunks = [];
  for (let i = 0; i < text.length; i += 4000) chunks.push(text.slice(i, i + 4000));
  for (const chunk of chunks) {
    try {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: chunk, parse_mode: 'HTML' })
      });
    } catch (e) { console.error('sendTG error:', e.message); }
  }
}

async function fetchNews(env, query) {
  const articles = [];
  const finnhubKeys = [env.FINNHUB_KEY, env.FINNHUB_KEY_2, env.FINNHUB_KEY_3].filter(Boolean);

  if (env.NEWS_API_KEY && articles.length === 0) {
    try {
      const from24h = new Date(Date.now() - 86400000).toISOString();
      const url = 'https://gnews.io/api/v4/search?q=' +
        encodeURIComponent(query) +
        '&lang=en&max=5&sortby=publishedAt&from=' + from24h +
        '&apikey=' + env.NEWS_API_KEY;
      const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
      if (r.ok) {
        const d = await r.json();
        const cutoff = Date.now() - 24 * 3600 * 1000;
        const items = (d.articles || [])
          .filter(a => new Date(a.publishedAt || 0).getTime() >= cutoff)
          .map(a => ({
            title: a.title || '',
            description: (a.description || '').slice(0, 300),
            url: a.url || '',
            source: a.source?.name || 'GNews',
            publishedAt: a.publishedAt || '',
            sourceQuality: getSourceQuality(a.source?.name || '')
          }));
        if (items.length > 0) {
          articles.push(...items);
          console.log('[GNews] got', items.length, 'articles for:', query);
        }
      }
    } catch (e) { console.warn('GNews primary error:', e.message); }
  }

  if (finnhubKeys.length > 0) {
    for (const key of finnhubKeys) {
      try {
        const r = await fetch(
          `https://finnhub.io/api/v1/news?category=general&minId=0&token=${key}`,
          { signal: AbortSignal.timeout(6000) }
        );
        if (!r.ok) continue;
        const d = await r.json();
        const keywords = query.toLowerCase().split(' ').filter(w => w.length > 3);
        const cutoff24h = Date.now() - 24 * 3600 * 1000;
        const filtered = (d || [])
          .filter(a => {
            if ((a.datetime || 0) * 1000 < cutoff24h) return false;
            const text = (a.headline + ' ' + (a.summary || '')).toLowerCase();
            return keywords.some(kw => text.includes(kw));
          })
          .slice(0, 5)
          .map(a => ({
            title: a.headline || '',
            description: (a.summary || '').slice(0, 300),
            url: a.url || '',
            source: a.source || 'Finnhub',
            publishedAt: new Date((a.datetime || Date.now()/1000) * 1000).toISOString(),
            sourceQuality: getSourceQuality(a.source || '')
          }));
        if (filtered.length > 0) {
          articles.push(...filtered);
          break;
        }
      } catch (e) { console.warn('Finnhub general news error:', e.message); }
    }
  }

  const PERSON_TICKERS = {
    jensen: 'NVDA', cook: 'AAPL', musk: 'TSLA',
    nadella: 'MSFT', zuck: 'META', altman: 'MSFT',
    pichai: 'GOOGL', bezos: 'AMZN', dimon: 'JPM', iger: 'DIS'
  };
  const queryId = Object.keys(NEWS_QUERIES).find(id => NEWS_QUERIES[id] === query);
  const ticker = queryId ? PERSON_TICKERS[queryId] : null;

  if (ticker && articles.length < 3 && finnhubKeys.length > 0) {
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
    for (const key of finnhubKeys) {
      try {
        const r = await fetch(
          `https://finnhub.io/api/v1/company-news?symbol=${ticker}&from=${from}&to=${to}&token=${key}`,
          { signal: AbortSignal.timeout(6000) }
        );
        if (!r.ok) continue;
        const d = await r.json();
        const items = (d || []).slice(0, 3).map(a => ({
          title: a.headline || '',
          description: (a.summary || '').slice(0, 300),
          url: a.url || '',
          source: a.source || 'Finnhub',
          publishedAt: new Date((a.datetime || Date.now()/1000) * 1000).toISOString(),
          sourceQuality: getSourceQuality(a.source || '')
        }));
        if (items.length > 0) { articles.push(...items); break; }
      } catch (e) { console.warn('Finnhub company news error:', e.message); }
    }
  }

  if (articles.length === 0 && env.NEWS_API_KEY) {
    try {
      const url = 'https://gnews.io/api/v4/search?q=' +
        encodeURIComponent(query) +
        '&lang=en&max=3&sortby=publishedAt&apikey=' + env.NEWS_API_KEY;
      const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (r.ok) {
        const d = await r.json();
        const items = (d.articles || []).map(a => ({
          title: a.title || '',
          description: (a.description || '').slice(0, 300),
          url: a.url || '',
          source: a.source?.name || '',
          publishedAt: a.publishedAt || '',
          sourceQuality: getSourceQuality(a.source?.name || '')
        }));
        articles.push(...items);
      }
    } catch (e) { console.warn('GNews fallback error:', e.message); }
  }

  const text = articles.map(a =>
    `[SOURCE: ${a.source}] [URL: ${a.url}] [DATE: ${(a.publishedAt||'').slice(0,10)}] ${a.title}: ${a.description}`
  ).join(' | ');

  return { text, articles };
}

function tokenize(text) {
  return (text || '').toLowerCase().replace(/[^a-zก-๙0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2);
}
function cosineSimilarity(a, b) {
  const setA = new Set(tokenize(a)), setB = new Set(tokenize(b));
  const inter = [...setA].filter(t => setB.has(t)).length;
  const denom = Math.sqrt(setA.size) * Math.sqrt(setB.size);
  return denom === 0 ? 0 : inter / denom;
}
function deduplicateNews(articles) {
  const merged = [];
  for (const art of articles) {
    const dup = merged.find(m => cosineSimilarity(m.title, art.title) > 0.8);
    if (dup) {
      if ((art.sourceQuality || 5) > (dup.sourceQuality || 5)) {
        dup.title = art.title; dup.source = art.source;
        dup.url = art.url; dup.sourceQuality = art.sourceQuality;
      }
      dup.sourceCount = (dup.sourceCount || 1) + 1;
    } else {
      merged.push({ ...art, sourceCount: 1 });
    }
  }
  return merged;
}

const CATALYST_PATTERNS = {
  earnings:    { pattern: /earnings|revenue|profit|EPS|beat|miss|guidance/i, score: 10 },
  ma:          { pattern: /acqui|merger|takeover|buyout|deal|billion/i,       score: 9  },
  product:     { pattern: /launch|release|unveil|announce|new model|IPO/i,    score: 8  },
  regulation:  { pattern: /regulat|ban|fine|antitrust|SEC|FTC|lawsuit/i,      score: 8  },
  macro:       { pattern: /Fed|interest rate|inflation|CPI|GDP|jobs|payroll/i, score: 7  },
  insider:     { pattern: /insider|bought|sold|stake|CEO.*buy|executive/i,     score: 9  },
  partnership: { pattern: /partner|contract|agreement|deal with/i,             score: 7  },
  upgrade:     { pattern: /upgrade|downgrade|price target|analyst|rating/i,    score: 6  },
};
function detectCatalyst(text) {
  let best = null, bestScore = 0;
  for (const [type, { pattern, score }] of Object.entries(CATALYST_PATTERNS)) {
    if (pattern.test(text) && score > bestScore) { best = type; bestScore = score; }
  }
  return { type: best || 'general', catalystScore: bestScore };
}

const SOURCE_TIERS = {
  tier1: { sources: ['reuters', 'bloomberg', 'wsj', 'wall street journal', 'ft', 'financial times'], score: 10 },
  tier2: { sources: ['cnbc', 'ap', 'associated press', 'barron', 'marketwatch', 'economist'], score: 8 },
  tier3: { sources: ['techcrunch', 'the verge', 'fortune', 'business insider', 'seeking alpha', 'yahoo finance'], score: 6 },
  tier4: { sources: ['firstpost', 'economic times', 'mint', 'ndtv'], score: 5 },
};
function getSourceQuality(sourceName) {
  const s = (sourceName || '').toLowerCase();
  for (const { sources, score } of Object.values(SOURCE_TIERS)) {
    if (sources.some(t => s.includes(t))) return score;
  }
  return 4;
}

const EVENT_LABELS = {
  earnings: '💰 Earnings', ma: '🤝 M&A', product: '🚀 Product Launch',
  regulation: '⚖️ Regulation', macro: '🏦 Macro', insider: '👤 Insider',
  partnership: '🤝 Partnership', upgrade: '📊 Analyst', general: '📰 News',
};
function classifyEvent(catalystType) {
  return EVENT_LABELS[catalystType] || EVENT_LABELS.general;
}

const GENERIC_PATTERNS = [
  /นักลงทุนควรติดตาม.{0,10}อย่างใกล้ชิด/,
  /อาจส่งผลกระทบต่อ.{0,10}ตลาด/,
  /ตลาดหุ้น.{0,10}ผันผวน/,
  /ความไม่แน่นอน.{0,20}ตลาด/,
  /ราคา.{0,10}อาจ(เพิ่มขึ้น|ลดลง)$/,
  /^.{0,15}(เพิ่มขึ้น|ลดลง)(เล็กน้อย)?$/,
];

function hasIndividualStock(item) {
  const etfList = new Set(['SPY','QQQ','IWM','DIA','VTI','VXX','GLD','SLV','USO','TLT','HYG','LQD','XLK','XLF','XLE','XLV','ARKK','SQQQ','TQQQ']);
  const monitors = [...(item.stocks_to_monitor||[]), ...(item.stocks_at_risk||[])];
  return monitors.some(s => s.t && !etfList.has(s.t));
}
function isInsightSpecific(text) {
  return !GENERIC_PATTERNS.some(p => p.test(text || ''));
}
function scoreTradingRelevance(item, catalystScore, sourceQuality) {
  let score = 0;
  score += Math.min(catalystScore, 10) * 2;
  score += Math.min(sourceQuality, 10);
  score += Math.min((item.impact || 5), 10);
  score += (item.stocks_to_monitor?.length || 0) > 0 ? 5 : 0;
  score += item.sentiment !== 'neutral' ? 3 : 0;
  score += item.fact_check === 'confirmed' ? 5 : item.fact_check === 'semi-confirmed' ? 2 : 0;
  return Math.min(score, 100);
}

// ── [FIX] loadSeenBatch: โหลด dedup set จาก KV key เดียว ──
async function loadSeenBatch(env) {
  if (!env.ALERT_KV) return new Set();
  try {
    const raw = await env.ALERT_KV.get('elite:seen:batch');
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch (e) {
    console.warn('[KV] loadSeenBatch error:', e.message);
    return new Set();
  }
}

// ── [FIX] saveSeenBatch: บันทึก dedup set ลง KV key เดียว (1 write) ──
async function saveSeenBatch(env, seenSet) {
  if (!env.ALERT_KV) return;
  try {
    // เก็บแค่ 300 รายการล่าสุด ป้องกัน value ใหญ่เกิน
    const arr = [...seenSet].slice(-300);
    await env.ALERT_KV.put('elite:seen:batch', JSON.stringify(arr), { expirationTtl: 43200 });
    console.log('[KV] saveSeenBatch:', arr.length, 'items (1 write)');
  } catch (e) {
    console.warn('[KV] saveSeenBatch error:', e.message);
  }
}

async function callGroq(env, system, user, retries = 2) {
  if (!env.GROQ_KEY) throw new Error('No GROQ_KEY');
  for (let attempt = 0; attempt < retries; attempt++) {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + env.GROQ_KEY },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 2000, temperature: 0.3,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }]
      }),
      signal: AbortSignal.timeout(20000)
    });
    if (res.status === 429) {
      const waitMs = Math.min((2 ** attempt) * 2000, 8000);
      await new Promise(r => setTimeout(r, waitMs));
      continue;
    }
    if (!res.ok) throw new Error('Groq error: ' + res.status);
    const data = await res.json();
    const raw = data.choices?.[0]?.message?.content || '';
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) throw new Error('No JSON array in response');
    const results = JSON.parse(match[0]);
    if (!Array.isArray(results)) throw new Error('Not array');
    return results;
  }
  throw new Error('Groq max retries reached');
}

async function callClaude(env, system, user) {
  if (!env.ANTHROPIC_KEY) throw new Error('No ANTHROPIC_KEY');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001', max_tokens: 2000, system,
      messages: [{ role: 'user', content: user }]
    }),
    signal: AbortSignal.timeout(20000)
  });
  if (!res.ok) throw new Error('Claude error: ' + res.status);
  const data = await res.json();
  const raw = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) throw new Error('No JSON array from Claude');
  const results = JSON.parse(match[0]);
  if (!Array.isArray(results)) throw new Error('Not array');
  return results;
}

async function callAI(env, system, user, userFallback) {
  try { return await callGroq(env, system, user); }
  catch (e) {
    console.warn('Groq failed:', e.message, '-- trying Claude');
    return await callClaude(env, system, userFallback || user);
  }
}

const LOG = {
  info:  (msg, d={}) => console.log(JSON.stringify({ level:'info',  msg, ...d, ts: Date.now() })),
  warn:  (msg, d={}) => console.warn(JSON.stringify({ level:'warn',  msg, ...d, ts: Date.now() })),
  error: (msg, d={}) => console.error(JSON.stringify({ level:'error', msg, ...d, ts: Date.now() })),
};
const _mon = { scans:0, sent:0, deduped:0, lastRun:null };

async function fetchBLSCPI(env) {
  try {
    const seriesIds = ['CUUR0000SA0', 'CUUR0000SA0L1E'];
    const currentYear = new Date().getFullYear();
    const body = JSON.stringify({
      seriesid: seriesIds,
      startyear: String(currentYear - 1),
      endyear: String(currentYear),
      registrationkey: env.BLS_API_KEY || ''
    });
    const r = await fetch('https://api.bls.gov/publicAPI/v2/timeseries/data/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(8000)
    });
    if (!r.ok) throw new Error('BLS API error: ' + r.status);
    const d = await r.json();
    if (d.status !== 'REQUEST_SUCCEEDED') throw new Error('BLS status: ' + d.status);
    const result = {};
    for (const series of (d.Results?.series || [])) {
      const latest = series.data?.[0];
      if (!latest) continue;
      const prevYear = series.data?.find(x => String(parseInt(latest.year)-1) === x.year && x.period === latest.period);
      const yoy = prevYear ? (((parseFloat(latest.value) - parseFloat(prevYear.value)) / parseFloat(prevYear.value)) * 100).toFixed(1) : null;
      if (series.seriesID === 'CUUR0000SA0') {
        result.headline = { value: parseFloat(latest.value), yoy, period: latest.periodName + ' ' + latest.year };
      } else if (series.seriesID === 'CUUR0000SA0L1E') {
        result.core = { value: parseFloat(latest.value), yoy, period: latest.periodName + ' ' + latest.year };
      }
    }
    console.log('[BLS] CPI data:', JSON.stringify(result));
    return result;
  } catch (e) {
    console.warn('[BLS] fetch error:', e.message);
    return null;
  }
}

async function runEliteScan(env) {
  _mon.lastRun = new Date().toISOString();
  _mon.scans++;

  ELITE_PEOPLE = await getElitePeople(env);

  const blsCPI = await fetchBLSCPI(env);
  const cpiContext = blsCPI
    ? `\n[BLS OFFICIAL DATA] Headline CPI YoY: ${blsCPI.headline?.yoy ?? 'N/A'}% (${blsCPI.headline?.period ?? ''}), Core CPI YoY: ${blsCPI.core?.yoy ?? 'N/A'}% (${blsCPI.core?.period ?? ''}) -- ใช้ตัวเลขนี้เท่านั้น ห้ามเดาหรือใช้ตัวเลขอื่น`
    : '';

  if (env.ALERT_KV) {
    const running = await env.ALERT_KV.get('elite:running');
    if (running) { console.warn('already running'); return { skipped: true }; }
    await env.ALERT_KV.put('elite:running', '1', { expirationTtl: 90 });
  }

  try {
    const today = new Date().toLocaleDateString('th-TH', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
      timeZone: 'Asia/Bangkok'
    });

    let newsContext = '';
    let allArticles = [];
    const ids = Object.keys(NEWS_QUERIES);
    for (let i = 0; i < ids.length; i++) {
      const result = await fetchNews(env, NEWS_QUERIES[ids[i]]);
      if (result.text) newsContext += `\n[${ids[i]}] ${result.text}`;
      if (result.articles?.length) allArticles.push(...result.articles.map(a => ({...a, person: ids[i]})));
      await new Promise(r => setTimeout(r, 150));
    }

    allArticles = deduplicateNews(allArticles);
    const cutoffScan = Date.now() - 24 * 3600 * 1000;
    allArticles = allArticles.filter(a => {
      const pubTs = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
      if (pubTs > 0 && pubTs < cutoffScan) {
        console.log('[stale] ข้ามข่าวเก่า:', (a.publishedAt||'').slice(0,10), a.title?.slice(0,50));
        return false;
      }
      if (!a.publishedAt && pubTs === 0) {
        console.log('[no-date] ข้ามข่าวไม่มีวันที่:', a.title?.slice(0,50));
        return false;
      }
      const { catalystScore } = detectCatalyst(a.title + ' ' + (a.description||''));
      return (a.sourceQuality || 4) >= 4 && catalystScore > 0;
    });
    newsContext = allArticles.map(a =>
      `[SOURCE: ${a.source} Q:${a.sourceQuality||'?'}] [URL: ${a.url}] [DATE: ${(a.publishedAt||'').slice(0,10)}] ${a.title}: ${a.description||''}`
    ).join(' | ');

    if (!newsContext.trim()) {
      LOG.warn('no real news', { today });
      return { ok: true, count: 0, reason: 'no_news' };
    }

    const system = `คุณคือนักวิเคราะห์การเงินไทยระดับโปร วันนี้: ${today}
กฎสำคัญ: วิเคราะห์เฉพาะข่าวที่ไม่เกิน 24 ชั่วโมงเท่านั้น
ตอบ JSON array เท่านั้น ห้ามมี markdown นอก JSON
ข้อความทุกฟิลด์ต้องเป็นภาษาไทยเท่านั้น ยกเว้น ticker และตัวเลข

🚨 กฎ News Integrity (บังคับ):
1. ห้ามสร้างข่าวขึ้นมาเอง ทุก item ต้องมาจาก source ที่ให้มาเท่านั้น
2. source_url ต้องเป็น URL จริง ถ้าไม่มีให้ใส่ ""
3. ถ้าไม่มีข่าวจริง impact>=5 ให้ return []

🔗 กฎ Chain Reasoning (บังคับ):
ก่อนระบุ stocks_to_monitor และ stocks_at_risk ต้องคิด chain นี้ก่อนเสมอ:
  ข่าว → อุตสาหกรรมที่ได้รับผล → บริษัทในอุตสาหกรรมนั้น → หุ้น → บวก/ลบ

🎯 กฎ ai_take (ต้องเป็น "วิเคราะห์" ไม่ใช่สรุปข่าวซ้ำ):
- ห้ามเขียนซ้ำเนื้อหาเดียวกับ what_happened/headline ในคำพูดอื่น (ห้าม paraphrase ข่าวเฉยๆ)
- ต้องเป็น second-order effect ที่ไม่อยู่ใน headline และตอบให้ได้อย่างน้อย 1 ใน 4 มุมนี้:
  1) ผลกระทบจะกระจายไปยังหุ้น/อุตสาหกรรมกลุ่มไหนต่อ
  2) เงินทุนน่าจะไหลไปยังสินทรัพย์ประเภทใด (หุ้น/บอนด์/ทอง/น้ำมัน/เงินสด)
  3) ผลระยะสั้น (1-5 วัน) ต่างจากระยะกลาง (1-3 เดือน) อย่างไร
  4) ใครได้ประโยชน์ (winner) ใครเสียประโยชน์ (loser) จากเหตุการณ์นี้
- ต้องสอดคล้องกับ sentiment ข่าว ห้าม contradict

🔮 กฎ read_game (Insight ที่คนมองข้าม -- ต้องเฉพาะเจาะจง ใช้ได้จริง):
- ห้ามเป็นประโยคทั่วไปลอยๆ เช่น "ราคาน้ำมันอาจเพิ่มขึ้น" หรือ "นักลงทุนควรติดตามอย่างใกล้ชิด"
- ต้องมีเงื่อนไข/ตัวเลข/threshold ที่จับต้องได้ รูปแบบ "ถ้า [เงื่อนไข/ระดับราคา] → [ผลที่ตามมา]"
  ตัวอย่างที่ดี: "หากราคาน้ำมันทะลุ $90 หุ้นกลุ่มพลังงานอาจ Outperform ตลาดอย่างชัดเจน"
  ตัวอย่างที่ดี: "ความขัดแย้งลักษณะนี้มักหนุนหุ้นพลังงานก่อนทองคำในช่วง 1-2 สัปดาห์แรก"
- ถ้าไม่มีข้อมูลพอจะใส่ threshold ที่สมเหตุสมผล ให้ตั้งค่า read_game เป็น null

📅 กฎ watch (เชื่อม Event ที่เกี่ยวข้องอัตโนมัติ -- บังคับ):
จับคู่หัวข้อข่าวกับ event/ข้อมูลเศรษฐกิจที่เกี่ยวข้องเสมอ ตามตาราง:
- ข่าวน้ำมัน/พลังงาน/OPEC → "OPEC+ meeting" หรือ inventory data ที่ใกล้ที่สุด
- ข่าวแรงงาน/การจ้างงาน/ตลาดแรงงาน → "NFP (Non-Farm Payrolls)"
- ข่าวเงินเฟ้อ/ราคาผู้บริโภค/ค่าครองชีพ → "CPI release"
- ข่าวดอกเบี้ย/Fed/นโยบายการเงิน → "FOMC meeting"
- ข่าวอื่นๆ ที่ไม่เข้าหมวดข้างต้น → ใส่ event/วันที่จริงที่เกี่ยวข้องโดยตรงกับข่าวนั้น
ห้ามปล่อยว่างหรือใส่ event ที่ไม่เกี่ยวข้องกับเนื้อข่าว

🗣️ กฎการเลือกคำตามระดับ confidence (บังคับ ใช้กับ ai_take, read_game, market_impact ทุกฟิลด์):
- confidence 80-100% → ใช้น้ำเสียง "มีแนวโน้มสูงที่จะ..." (ฟันธงได้)
- confidence 60-79% → ใช้น้ำเสียง "คาดว่า..."
- confidence 40-59% → ใช้น้ำเสียง "อาจ..." (ห้ามฟันธง)
- confidence ต่ำกว่า 40% → ใช้น้ำเสียง "ยังไม่มีข้อมูลยืนยันเพียงพอ แต่..." และห้ามให้คำแนะนำที่ดูมั่นใจเกินจริง
ห้ามใช้คำฟันธง ("จะ...แน่นอน") เมื่อ confidence ต่ำกว่า 80%

📊 กฎ confidence_score:
- 40% = ความชัดเจนของข่าว (มีตัวเลข/ชื่อบริษัท/รายละเอียดชัดเจน)
- 30% = คุณภาพ source (ดูตาราง source_quality)
- 30% = โอกาสเกิด market impact จริง

📰 กฎ source_quality (ให้คะแนนตาม tier):
- Reuters, Bloomberg, WSJ, FT = 10
- CNBC, AP, Barron's, Marketwatch = 8
- TechCrunch, Yahoo Finance, Business Insider = 6
- Social media (X/Twitter, blog, forum) = 4

📈📉 กฎ bullish_reasons / bearish_reasons (แทนการใช้แค่ tag สีลอยๆ):
ต้องระบุเหตุผลสั้นๆ แบบ bullet อย่างน้อยฝั่งละ 1 ข้อ ที่อธิบายว่าทำไมข่าวนี้เป็นปัจจัยบวก (bullish_reasons) และปัจจัยลบ (bearish_reasons) ต่อตลาดหรือหุ้นกลุ่มที่เกี่ยวข้อง โดยต้องสอดคล้องกับ chain_reasoning และ sentiment หลักของข่าว

📊 กฎ impact_stocks (หุ้นที่ได้รับผลกระทบ -- แสดงใต้ ai_take):
ระบุ array ของ {"t":"TICKER","dir":"up"/"down"} อย่างน้อย 2 ตัว โดยต่อยอดจาก stocks_to_monitor (dir="up" ถ้าได้ประโยชน์) และ stocks_at_risk (dir="down" ถ้าเสียประโยชน์) ตาม chain_reasoning

🚫 Filter ออก: stocks_to_monitor ว่างหรือมีแค่ ETF, impact < 5, ข่าวซ้ำ

🎯 กฎการเลือก id (บังคับ -- แก้ปัญหา id ไม่ตรงกับเนื้อข่าว):
id ของบุคคลต้องผูกกับข่าวที่เป็น "การกระทำ คำพูด คำสั่ง การประกาศ หรือการตัดสินใจของบุคคลนั้นโดยตรง" เท่านั้น
ตัวอย่างที่ถูกต้อง: "Trump ประกาศภาษีนำเข้าใหม่", "Powell แถลง Fed คงดอกเบี้ย", "Musk เปิดตัวผลิตภัณฑ์ใหม่"
ตัวอย่างที่ผิด: ข่าว "ตลาดหุ้นร่วงเพราะความกังวลสงคราม" หรือข่าวมหภาคทั่วไปที่แค่ "พาดพิงถึง" ประเทศ/องค์กรที่บุคคลนั้นเกี่ยวข้อง แต่ไม่มีการกระทำของบุคคลนั้นเอง
ถ้าข่าวเป็นข่าวมหภาค/ผลกระทบทั่วไปที่ไม่มีการกระทำของบุคคลใน ELITE_PEOPLE โดยตรง -- ห้าม return item นั้น (ข้ามทิ้งไปเลย)

id ต้องเป็นหนึ่งใน: trump, powell, jensen, cook, musk, nadella, zuck, altman, xi, putin, lagarde, opec, pichai, bezos, dimon, buffett, yellen, iger, modi, khamenei

รูปแบบ JSON:
{
  "id":"person_id","headline":"หัวข้อเฉพาะ ไม่เกิน 15 คำ","source":"ชื่อสำนักข่าวจริง",
  "source_url":"https://...","fact_check":"confirmed/semi-confirmed/rumor","source_quality":8,
  "ai_take":"การวิเคราะห์ second-order effect (ห้ามสรุปข่าวซ้ำ)","sentiment":"bullish/bearish/neutral","confidence":85,
  "confidence_breakdown":{"news_clarity":40,"source_quality":25,"market_impact_prob":20},
  "impact_level":"low/medium/high","what_happened":"2 ประโยค","why_important":"1 ประโยค",
  "market_impact":"1 ประโยค","chain_reasoning":"ข่าว → อุตสาหกรรม → บริษัท → หุ้น",
  "sector":"Technology/Finance/Energy/Healthcare/Defense/Macro/AI/Crypto",
  "etf_impact":{"SPY":"positive/negative/neutral","QQQ":"positive/negative/neutral","TLT":"positive/negative/neutral","GLD":"positive/negative/neutral"},
  "stocks_to_monitor":[{"t":"TICKER","reason":"เหตุผล"}],
  "stocks_at_risk":[{"t":"TICKER","reason":"เหตุผล"}],
  "impact_stocks":[{"t":"TICKER","dir":"up/down"}],
  "bullish_reasons":["เหตุผลเชิงบวก"],"bearish_reasons":["เหตุผลเชิงลบ"],
  "action":"หุ้นที่ควรติดตาม: X, Y","risk_level":"low/medium/high",
  "timeline":{"short":"1-5 วัน","medium":"1-3 เดือน","long":"6+ เดือน"},
  "impact":7,"pros":["ข้อดี"],"cons":["ความเสี่ยง"],
  "read_game":"insight เฉพาะเจาะจงพร้อม threshold หรือ null","watch":"event ที่เกี่ยวข้องเสมอ","markets":["NYSE"]
}
เฉพาะ impact>=5 ไม่เกิน 4 รายการ`;

    const newsCtxGroq = newsContext.slice(0, 6000);
    const newsCtxClaude = newsContext.slice(0, 4000);
    const userPrompt = `บริบทข่าว (วิเคราะห์จากข้อมูลนี้เท่านั้น ห้ามสร้างข่าวเอง):\n${newsCtxGroq}${cpiContext}\n\nตอบ JSON array ภาษาไทย`;
    const userPromptClaude = `บริบทข่าว:\n${newsCtxClaude}${cpiContext}\n\nตอบ JSON array ภาษาไทย`;

    const items = await callAI(env, system, userPrompt, userPromptClaude);
    if (!items || items.length === 0) return { ok: true, count: 0 };

    const cleanedItems = items.map(cleanItem);

    // ── [FIX] โหลด seen batch ครั้งเดียว (1 read) ──
    const seenSet = await loadSeenBatch(env);
    let seenDirty = false;

    let newItems = [];
    for (const item of cleanedItems) {
      if (item.headline) {
        const key = item.headline.toLowerCase().replace(/\s+/g, '').slice(0, 40);
        if (seenSet.has(key)) {
          console.log('dedup skip:', item.headline);
          _mon.deduped++;
          continue;
        }
        seenSet.add(key);
        seenDirty = true;
      }

      const { type: catalystType, catalystScore } = detectCatalyst((item.headline||'') + ' ' + (item.what_happened||''));
      const sourceQuality = getSourceQuality(item.source || '');
      item._catalyst = catalystType;
      item._catalystScore = catalystScore;
      item._sourceQuality = sourceQuality;
      item._eventLabel = classifyEvent(catalystType);
      item._tradingScore = scoreTradingRelevance(item, catalystScore, sourceQuality);

      if (!isInsightSpecific(item.read_game || '')) item.read_game = null;
      if (!hasIndividualStock(item)) { _mon.deduped++; continue; }
      if (item._tradingScore < 25) { _mon.deduped++; continue; }

      newItems.push(item);
    }

    // ── [FIX] บันทึก seen batch ครั้งเดียว (1 write แทน N writes) ──
    if (seenDirty) await saveSeenBatch(env, seenSet);

    newItems.sort((a, b) => (b._tradingScore || 0) - (a._tradingScore || 0));
    if (newItems.length === 0) return { ok: true, count: 0 };

    if (env.ALERT_KV) {
      try {
        await env.ALERT_KV.put('elite:results', JSON.stringify({ ts: Date.now(), items: newItems }), { expirationTtl: 14400 });
      } catch (e) { console.warn('[KV] elite:results write failed:', e.message); }
    }

    const now24h = Date.now() - 24 * 3600 * 1000;
    newItems = newItems.filter(item => {
      if (item.published_at) {
        const ts = new Date(item.published_at).getTime();
        if (ts > 0 && ts < now24h) {
          console.log('[stale-result] ข้ามผล AI ที่ข่าวเก่า:', item.id, item.published_at);
          return false;
        }
      }
      return true;
    });

    newItems = newItems.filter(item => (item.impact || 0) >= 5);
    if (!newItems.length) { LOG.info('no high-impact items'); return { ok: true, count: 0 }; }

    let msg = `🌐 <b>ELITE SCAN</b> -- ${today}\n━━━━━━━━━━━━━━━━━━━━\n\n`;
    for (const item of newItems) {
      const person = ELITE_PEOPLE.find(p => p.id === (item.id||'').toLowerCase());
      const emoji = person?.emoji || (item.impact>=8?'🔴':item.impact>=6?'🟡':'🟢');
      msg += `${emoji} <b>${item.headline}</b>\n`;
      if (person?.role) msg += `<i>${person.role}</i>\n`;
      if (item.source) msg += item.source_url ? `📰 <a href="${item.source_url}">${item.source}</a>\n` : `📰 ${item.source}\n`;
      const sentEmoji = item.sentiment==='bullish'?'📈 Bullish':item.sentiment==='bearish'?'📉 Bearish':'➡️ Neutral';
      msg += `${sentEmoji} | Confidence ${item.confidence||70}%\n`;
      if (item.ai_take) msg += `💬 <i>${item.ai_take}</i>\n`;
      if (item.impact_stocks?.length) {
        msg += `📊 หุ้นกระทบ: ${item.impact_stocks.map(s=>`$${s.t}${s.dir==='up'?'↑':'↓'}`).join(', ')}\n`;
      }
      msg += `📌 ${item.what_happened}\n`;
      if (item.bullish_reasons?.length) msg += `📈 บวก: ${item.bullish_reasons.join(' / ')}\n`;
      if (item.bearish_reasons?.length) msg += `📉 ลบ: ${item.bearish_reasons.join(' / ')}\n`;
      if (item.stocks_to_monitor?.length) msg += `✅ จับตา: ${item.stocks_to_monitor.map(s=>`$${s.t}`).join(', ')}\n`;
      if (item.stocks_at_risk?.length) msg += `⚠️ ระวัง: ${item.stocks_at_risk.map(s=>`$${s.t}`).join(', ')}\n`;
      if (item.read_game) msg += `🔮 <i>${item.read_game}</i>\n`;
      if (item.watch) msg += `👁️ จับตา event: ${item.watch}\n`;
      if (item.timeline?.short) msg += `⚡ ระยะสั้น: ${item.timeline.short}\n`;
      msg += `⚠️ <i>ไม่ใช่คำแนะนำการลงทุน</i>\n\n`;
    }
    await sendTG(env, msg);
    _mon.sent += newItems.length;
    LOG.info('elite scan done', { sent: newItems.length });
    return { ok: true, count: newItems.length };

  } finally {
    if (env.ALERT_KV) await env.ALERT_KV.delete('elite:running');
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    if (url.pathname === '/results') {
      try {
        const raw = env.ALERT_KV ? await env.ALERT_KV.get('elite:results') : null;
        if (!raw) return new Response(JSON.stringify({ ok: false, error: 'no results yet' }), { status: 404, headers: CORS });
        const data = JSON.parse(raw);
        const age = Math.floor((Date.now() - data.ts) / 1000);
        return new Response(JSON.stringify({ ok: true, items: data.items, age, count: data.items.length }), { headers: CORS });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: CORS });
      }
    }

    if (url.pathname === '/clear-dedup') {
      try {
        // ── [FIX] ลบแค่ key เดียวแทนการ list ทั้งหมด ──
        await env.ALERT_KV.delete('elite:seen:batch');
        await env.ALERT_KV.delete('elite:running');
        ctx.waitUntil(runEliteScan(env).catch(e => console.error('scan error:', e.message)));
        return new Response(JSON.stringify({ ok: true, cleared: 1, message: 'dedup cleared, scan triggered' }), { headers: CORS });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: CORS });
      }
    }

    if (url.pathname === '/trigger') {
      try {
        const running = env.ALERT_KV ? await env.ALERT_KV.get('elite:running') : null;
        if (running) return new Response(JSON.stringify({ ok: true, message: 'already running' }), { headers: CORS });
        ctx.waitUntil(runEliteScan(env).catch(e => console.error('trigger error:', e.message)));
        return new Response(JSON.stringify({ ok: true, message: 'scan triggered' }), { headers: CORS });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: CORS });
      }
    }

    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true, ts: new Date().toISOString(), lastRun: _mon.lastRun }), { headers: CORS });
    }

    return new Response(JSON.stringify({ ok: false, error: 'Not found' }), { status: 404, headers: CORS });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runEliteScan(env).catch(e => console.error('scheduled error:', e.message)));
  }
};
