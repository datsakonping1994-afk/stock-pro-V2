// ============================================================
//  STOCK PRO — Worker Elite: ข่าว ELITE figures
//  ENV: GROQ_KEY, ANTHROPIC_KEY, NEWS_API_KEY, TG_TOKEN, TG_CHAT_ID, ALERT_KV
//  Cron: 0 */2 * * * (ทุก 2 ชั่วโมง)
//  KV Binding: ALERT_KV
//
//  PATCHES:
//  1. เปลี่ยนเป็น llama-3.3-70b-versatile — ภาษาไทยแม่นขึ้น
//  2. เพิ่ม ANTHROPIC_KEY fallback — ถ้า Groq 429 ใช้ Claude แทน
//  3. เพิ่ม /results endpoint — แอปดึงผลล่าสุดได้โดยตรง
//  4. บันทึกผลลง KV หลัง scan เสร็จ
//  5. exponential backoff retry on 429
//  6. KV lock ป้องกัน double-run
//  7. dedup ป้องกันส่งข่าวซ้ำ
// ============================================================

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store'
};

const ELITE_PEOPLE = [
  { id: 'trump',    name: 'Donald Trump',       emoji: '🔴', role: 'US President' },
  { id: 'powell',   name: 'Jerome Powell',       emoji: '🔴', role: 'Fed Chair' },
  { id: 'jensen',   name: 'Jensen Huang',        emoji: '🟢', role: 'NVIDIA CEO' },
  { id: 'cook',     name: 'Tim Cook',            emoji: '🟢', role: 'Apple CEO' },
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

// [FIX] ลด queries เหลือ 6 ตัว impact สูงสุด — ป้องกัน exceededCpu
const NEWS_QUERIES = {
  trump:    'Donald Trump policy economy markets',
  powell:   'Jerome Powell Federal Reserve interest rates',
  jensen:   'Jensen Huang NVIDIA AI chips earnings',
  xi:       'Xi Jinping China economy policy',
  musk:     'Elon Musk Tesla SpaceX',
  altman:   'Sam Altman OpenAI GPT',
};

// [FIX] ล้างตัวอักษรที่ไม่ใช่ไทย/อังกฤษ/ตัวเลข/สัญลักษณ์พื้นฐาน
function cleanText(text) {
  if (!text || typeof text !== 'string') return text;
  return text
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
  if (!token || !chatId) { console.warn('sendTG: missing token or chatId'); return; }
  const chunks = [];
  for (let i = 0; i < text.length; i += 4000) chunks.push(text.slice(i, i + 4000));
  for (const chunk of chunks) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: chunk, parse_mode: 'HTML' })
      });
      const data = await res.json();
      if (!data.ok) console.error('TG error:', data.description);
    } catch (e) { console.error('sendTG error:', e.message); }
  }
}

// ── ดึงข่าวจาก GNews พร้อม URL และ source ──
async function fetchNews(env, query) {
  if (!env.NEWS_API_KEY) return { text: '', articles: [] };
  try {
    const url = 'https://gnews.io/api/v4/search?q=' +
      encodeURIComponent(query) +
      '&lang=en&max=3&sortby=publishedAt&apikey=' + env.NEWS_API_KEY;
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) { console.warn(`fetchNews failed: ${r.status}`); return { text: '', articles: [] }; }
    const d = await r.json();
    const articles = (d.articles || []).map(a => ({
      title: a.title || '',
      description: (a.description || '').slice(0, 300),
      url: a.url || '',
      source: a.source?.name || '',
      publishedAt: a.publishedAt || '',
      sourceQuality: getSourceQuality(a.source?.name || '')
    }));
    const text = articles.map(a =>
      `[SOURCE: ${a.source}] [URL: ${a.url}] ${a.title}: ${a.description}`
    ).join(' | ');
    return { text, articles };
  } catch (e) {
    console.warn(`fetchNews error:`, e.message);
    return { text: '', articles: [] };
  }
}


// ════════════════════════════════════════════════════
//  MODULE 1: News Deduplication Engine
//  Merge news with >80% similarity using token overlap
// ════════════════════════════════════════════════════
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
      // merge: keep higher source_quality, combine sources
      if ((art.sourceQuality || 5) > (dup.sourceQuality || 5)) {
        dup.title = art.title;
        dup.source = art.source;
        dup.url = art.url;
        dup.sourceQuality = art.sourceQuality;
      }
      dup.sourceCount = (dup.sourceCount || 1) + 1;
    } else {
      merged.push({ ...art, sourceCount: 1 });
    }
  }
  return merged;
}

// ════════════════════════════════════════════════════
//  MODULE 2: Catalyst Detection Engine
//  Score news by how actionable it is for trading
// ════════════════════════════════════════════════════
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

// ════════════════════════════════════════════════════
//  MODULE 3: Source Quality Engine
//  Rate source reliability 1-10
// ════════════════════════════════════════════════════
const SOURCE_TIERS = {
  tier1: { sources: ['reuters', 'bloomberg', 'wsj', 'wall street journal', 'ft', 'financial times'], score: 10 },
  tier2: { sources: ['cnbc', 'ap', 'associated press', 'barron', 'marketwatch', 'economist'], score: 8 },
  tier3: { sources: ['techcrunch', 'the verge', 'fortune', 'business insider', 'investopedia', 'seeking alpha', 'yahoo finance'], score: 6 },
  tier4: { sources: ['firstpost', 'economic times', 'mint', 'ndtv'], score: 5 },
};
function getSourceQuality(sourceName) {
  const s = (sourceName || '').toLowerCase();
  for (const { sources, score } of Object.values(SOURCE_TIERS)) {
    if (sources.some(t => s.includes(t))) return score;
  }
  return 4;
}

// ════════════════════════════════════════════════════
//  MODULE 4: Event Classification Engine
// ════════════════════════════════════════════════════
const EVENT_LABELS = {
  earnings:    '💰 Earnings',
  ma:          '🤝 M&A',
  product:     '🚀 Product Launch',
  regulation:  '⚖️ Regulation',
  macro:       '🏦 Macro',
  insider:     '👤 Insider',
  partnership: '🤝 Partnership',
  upgrade:     '📊 Analyst',
  general:     '📰 News',
};
function classifyEvent(catalystType) {
  return EVENT_LABELS[catalystType] || EVENT_LABELS.general;
}

// ════════════════════════════════════════════════════
//  MODULE 5: Insight Specificity Engine
//  Reject generic insight, require specifics
// ════════════════════════════════════════════════════
const GENERIC_PATTERNS = [
  /นักลงทุนควรติดตาม.{0,10}อย่างใกล้ชิด/,
  /อาจส่งผลกระทบต่อ.{0,10}ตลาด/,
  /ตลาดหุ้น.{0,10}ผันผวน/,
  /การเปลี่ยนแปลง.{0,10}ตลาดหุ้น/,
  /ควรพิจารณา.{0,10}ลงทุน/,
  /ชาวอเมริกัน.{0,20}ทรัพย์สิน/,
  /คนอเมริกัน.{0,20}เงิน/,
  /เศรษฐกิจ.{0,10}ดี|เศรษฐกิจ.{0,10}แย่/,
  /ตลาดเปิด.{0,10}วัน/,
  /ความไม่แน่นอน.{0,20}ตลาด/,
];

// Block news without individual stock tickers
function hasIndividualStock(item) {
  const etfList = new Set(['SPY','QQQ','IWM','DIA','VTI','VXX','GLD','SLV','USO','TLT','HYG','LQD','XLK','XLF','XLE','XLV','ARKK','SQQQ','TQQQ']);
  const monitors = [...(item.stocks_to_monitor||[]), ...(item.stocks_at_risk||[])];
  return monitors.some(s => s.t && !etfList.has(s.t));
}
function isInsightSpecific(text) {
  return !GENERIC_PATTERNS.some(p => p.test(text || ''));
}

// ════════════════════════════════════════════════════
//  MODULE 6: Portfolio Correlation Engine
//  Match news tickers against user portfolio
// ════════════════════════════════════════════════════
function getPortfolioImpact(item, portfolioTickers) {
  if (!portfolioTickers?.length) return [];
  const mentioned = [
    ...(item.stocks_to_monitor || []).map(s => s.t),
    ...(item.stocks_at_risk || []).map(s => s.t),
    ...(item.affected_stocks || []).map(s => s.t),
  ];
  return portfolioTickers.filter(t => mentioned.includes(t));
}

// ════════════════════════════════════════════════════
//  MODULE 7: Trading Relevance Engine
//  Final score: actionable vs informational
// ════════════════════════════════════════════════════
function scoreTradingRelevance(item, catalystScore, sourceQuality) {
  let score = 0;
  score += Math.min(catalystScore, 10) * 2;                           // catalyst weight x2
  score += Math.min(sourceQuality, 10);                                // source quality
  score += Math.min((item.impact || 5), 10);                          // AI impact score
  score += (item.stocks_to_monitor?.length || 0) > 0 ? 5 : 0;        // has specific tickers
  score += item.sentiment !== 'neutral' ? 3 : 0;                      // directional
  score += item.fact_check === 'confirmed' ? 5 :
           item.fact_check === 'semi-confirmed' ? 2 : 0;              // confirmation
  return Math.min(score, 100);
}

// ── [PATCH 1] เปลี่ยนเป็น llama-3.3-70b-versatile ──
async function callGroq(env, system, user, retries = 2) {
  if (!env.GROQ_KEY) throw new Error('No GROQ_KEY');
  for (let attempt = 0; attempt < retries; attempt++) {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + env.GROQ_KEY
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 2000,
        temperature: 0.3,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ]
      }),
      signal: AbortSignal.timeout(20000)
    });
    if (res.status === 429) {
      const retryAfter = res.headers.get('retry-after');
      const waitMs = Math.min(retryAfter ? parseInt(retryAfter) * 1000 : (2 ** attempt) * 2000, 8000);
      console.warn(`Groq 429 — waiting ${waitMs}ms (attempt ${attempt + 1}/${retries})`);
      await new Promise(r => setTimeout(r, waitMs));
      continue;
    }
    if (!res.ok) throw new Error('Groq error: ' + res.status);
    const data = await res.json();
    const raw = data.choices?.[0]?.message?.content || '';
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) throw new Error('No JSON array in response');
    try {
      const results = JSON.parse(match[0]);
      if (!Array.isArray(results)) throw new Error('Not array');
      return results;
    } catch (e) { throw new Error('Parse error: ' + e.message); }
  }
  throw new Error('Groq 429 — max retries reached');
}

// ── [PATCH 2] Claude fallback ถ้า Groq ล้มเหลว ──
async function callClaude(env, system, user) {
  if (!env.ANTHROPIC_KEY) throw new Error('No ANTHROPIC_KEY');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      system: system,
      messages: [{ role: 'user', content: user }]
    }),
    signal: AbortSignal.timeout(20000)
  });
  if (!res.ok) {
    let errBody = '';
    try { errBody = await res.text(); } catch {}
    const errMsg = 'Claude error: ' + res.status + ' — ' + errBody.slice(0, 200);
    LOG.error('Claude API error', { status: res.status, body: errBody.slice(0,100) });
    throw new Error(errMsg);
  }
  const data = await res.json();
  const raw = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) throw new Error('No JSON array from Claude');
  const results = JSON.parse(match[0]);
  if (!Array.isArray(results)) throw new Error('Not array');
  return results;
}

// ── เรียก AI — ลอง Groq ก่อน fallback Claude ──
async function callAI(env, system, user, userFallback) {
  try {
    return await callGroq(env, system, user);
  } catch (e) {
    console.warn('Groq failed:', e.message, '— trying Claude fallback');
    return await callClaude(env, system, userFallback || user);
  }
}

async function runEliteScan(env) {
  _mon.lastRun = new Date().toISOString();
  _mon.scans++;
  LOG.info('runEliteScan start', { scan: _mon.scans });
  // KV lock ป้องกัน double-run
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

    // ดึงข่าว GNews พร้อม URL และ source
    let newsContext = '';
    let allArticles = [];
    if (env.NEWS_API_KEY) {
      const ids = Object.keys(NEWS_QUERIES);
      for (let i = 0; i < ids.length; i++) {
        const result = await fetchNews(env, NEWS_QUERIES[ids[i]]);
        if (result.text) newsContext += `\n[${ids[i]}] ${result.text}`;
        if (result.articles?.length) allArticles.push(...result.articles.map(a => ({...a, person: ids[i]})));
        await new Promise(r => setTimeout(r, 150));
      }
    }

    // MODULE 1: Dedup raw articles before sending to AI
    allArticles = deduplicateNews(allArticles);
    // Filter low-quality sources (< 4) and no-catalyst articles before AI
    allArticles = allArticles.filter(a => {
      const { catalystScore } = detectCatalyst(a.title + ' ' + a.description);
      return (a.sourceQuality || 4) >= 4 && catalystScore > 0;
    });
    // Rebuild newsContext after dedup+filter
    newsContext = allArticles.map(a =>
      `[SOURCE: ${a.source} Q:${a.sourceQuality || '?'}] [URL: ${a.url}] ${a.title}: ${a.description}`
    ).join(' | ');

    const hasNews = newsContext.trim().length > 0;

    // [FIX] ถ้าไม่มีข่าวจริง — หยุดเลย ไม่ให้ AI สร้างข่าวปลอม
    if (!hasNews) {
      LOG.warn('no real news from GNews', { today });
      return { ok: true, count: 0, reason: 'no_news' };
    }

    const system = `คุณคือนักวิเคราะห์การเงินไทยระดับโปร วันนี้: ${today}
ตอบ JSON array เท่านั้น ห้ามมี markdown นอก JSON
ข้อความทุกฟิลด์ต้องเป็นภาษาไทยเท่านั้น ยกเว้น ticker หุ้นและค่าตัวเลข
หมายเหตุ: Twitter = X แล้ว ไม่มี ticker $TWTR ห้ามใช้ TWTR

🚨 กฎ News Integrity (บังคับเด็ดขาด):
1. ห้ามสร้างข่าวขึ้นมาเอง ทุก item ต้องมาจาก source ที่ให้มาเท่านั้น
2. "source" ต้องเป็นชื่อสำนักข่าวจริง เช่น Reuters, Bloomberg, CNBC, WSJ ห้ามใช้ "ผู้เชี่ยวชาญ"
3. "source_url" ต้องเป็น URL จริงจาก context ที่ให้ ถ้าไม่มีให้ใส่ "" ห้ามแต่ง
4. ถ้าไม่มีข่าวจริง impact>=6 ให้ return [] ดีกว่าสร้างข่าวปลอม

🔍 กฎ Fact Check & Quality:
5. fact_check: "confirmed"=หลายแหล่งยืนยัน, "semi-confirmed"=แหล่งเดียว, "rumor"=ยังไม่ยืนยัน
6. source_quality: 1-10 (Reuters/Bloomberg=9-10, CNBC/WSJ=7-8, blog=1-3)
7. confidence = fact_check + source_quality: confirmed+q≥8=80-90%, semi=55-70%, rumor=30-50%
8. ถ้า fact_check="rumor" ให้ใช้ภาษา "อาจ" หรือ "มีรายงานว่า" ห้ามสรุปแน่นอน

🚫 กฎ Filter ข่าวที่ไม่มีประโยชน์ต่อการลงทุน (ห้าม include เด็ดขาด):
- ข่าว generic ที่ไม่ระบุบริษัท/ตัวเลข เช่น "ตลาดเปิดวันนี้" "เศรษฐกิจดี/แย่"
- ข่าว lifestyle/สังคม เช่น "คนอเมริกันมีเงินมาก" "ค่าครองชีพสูง" "ชาวอเมริกันมีทรัพย์สินบนกระดาษ" ที่ไม่มี ticker จริง
- ข่าวที่ stocks_to_monitor ว่างเปล่า หรือใส่ ETF กว้างๆ เช่น SPY, QQQ, VTI เท่านั้น — ต้องมีหุ้นเดี่ยว (individual stock) อย่างน้อย 1 ตัว
- ข่าวที่ impact < 7
- ข่าวซ้ำ content เดียวกัน headline ต่างกัน
- ข่าวที่ไม่มี catalyst ชัดเจน: earnings, M&A, product launch, regulation, rate decision, macro data ที่มีตัวเลขจริง
- ข่าวที่ผู้บริหารพูดแต่ไม่มีนโยบาย/ตัวเลขใหม่ เช่น "CEO พูดว่าบริษัทยังเติบโต"
- ข่าวตลาดรวม เช่น "ดาวโจนส์ขึ้น/ลง" "ตลาดผันผวน" โดยไม่ระบุสาเหตุที่ actionable
ถ้าข่าวใน context ไม่มีชิ้นใดผ่านเกณฑ์ impact>=7 และมี individual stock ให้ return [] ทันที

📊 กฎ Impact & Compliance:
9. impact_level: "high"=กระทบตลาดรวม, "medium"=กระทบ sector, "low"=กระทบบริษัทเดียว
10. action ต้องขึ้นต้นว่า "หุ้นที่ควรติดตาม:" ห้ามใช้ "ควรซื้อ" หรือ "แนะนำลงทุน"
11. stocks_to_monitor และ stocks_at_risk ต้องมีทุก card อย่างน้อย 1 ตัว — ต้องเป็น listed ticker จริง
12. headline เฉพาะเจาะจง ระบุตัวเลข/นโยบาย/บริษัท
13. read_game ต้องเป็น insight เฉพาะเจาะจงกับข่าวนี้ เช่น "ถ้า Powell ลดดอกเบี้ย หุ้น Growth จะได้ประโยชน์มากกว่า Value เพราะ discount rate ต่ำลง" ห้ามใช้ประโยคกว้างๆ เช่น "การวิเคราะห์ผลกระทบต่อตลาด"
14. watch ต้องระบุ event/วันที่/ตัวเลขที่ต้องติดตามจริงๆ เช่น "ติดตาม FOMC meeting 11-12 มิ.ย., ตัวเลข CPI 12 มิ.ย., earnings NVDA 28 พ.ค." ห้ามใช้ประโยคกว้างๆ เช่น "ติดตามการเคลื่อนไหวของตลาด"
15. ai_take ห้าม copy หรือ paraphrase headline เด็ดขาด — ต้องเป็น insight ใหม่ที่ต่างจาก headline เช่น second-order effect, sector rotation, หรือ implication ที่ไม่ชัดเจนจาก headline

id ต้องเป็นหนึ่งในนี้:
trump, powell, jensen, cook, musk, nadella, zuck, altman, xi, putin, lagarde, opec, pichai, bezos, dimon, buffett, yellen, iger, modi, khamenei

รูปแบบ JSON แต่ละรายการ:
{
  "id":"person_id",
  "headline":"หัวข้อเฉพาะเจาะจง ไม่เกิน 15 คำ",
  "source":"ชื่อสำนักข่าวจริง",
  "source_url":"https://...",
  "fact_check":"confirmed/semi-confirmed/rumor",
  "source_quality":8,
  "source_count":2,
  "ai_take":"insight ใหม่ที่ไม่ซ้ำ headline — ต้องเป็น second-order effect หรือ implication ที่คนอ่านไม่เห็นชัดจาก headline เช่น ถ้า headline คือ 'Apple เปิดตัว AI chip ใหม่' ai_take ต้องไม่ใช่ 'Apple เปิดตัว AI chip' แต่ควรเป็น 'TSMC และ AVGO จะได้ order ผลิต chip เพิ่ม ดีต่อ supply chain'",
  "sentiment":"bullish/bearish/neutral",
  "confidence":85,
  "impact_level":"low/medium/high",
  "what_happened":"2 ประโยค",
  "why_important":"1 ประโยค",
  "market_impact":"1 ประโยค",
  "sector":"Technology/Finance/Energy/Healthcare/Defense/Macro/AI/Crypto",
  "event_type":"Macro/Earnings/AI/Defense/Space/M&A/Regulation/Rumor",
  "etf_impact":{"SPY":"positive/negative/neutral","QQQ":"positive/negative/neutral","IWM":"positive/negative/neutral","TLT":"positive/negative/neutral","GLD":"positive/negative/neutral","BTC":"positive/negative/neutral"},
  "stocks_to_monitor":[{"t":"TICKER","reason":"เหตุผลเฉพาะเจาะจง"}],
  "stocks_at_risk":[{"t":"TICKER","reason":"เหตุผลเฉพาะเจาะจง"}],
  "affected_stocks":[{"t":"TICKER","impact":"positive/negative","reason":"เหตุผล"}],
  "watchlist_alert":"หุ้นใน watchlist ที่อาจกระทบ",
  "action":"หุ้นที่ควรติดตาม: X, Y — ไม่ใช่คำแนะนำการลงทุน",
  "risk_level":"low/medium/high",
  "timeline":{"short":"ผลใน 1-5 วัน","medium":"ผลใน 1-3 เดือน","long":"ผลใน 6+ เดือน"},
  "impact":7,
  "pros":["ข้อดีเฉพาะเจาะจง"],
  "cons":["ความเสี่ยงเฉพาะเจาะจง"],
  "read_game":"insight เฉพาะเจาะจงกับข่าวนี้ เช่น second-order effect หรือ sector rotation ที่เกิดขึ้น — ห้ามใช้ประโยคกว้างๆ",
  "watch":"ระบุ event/วันที่/ตัวเลขจริงที่ต้องติดตาม เช่น FOMC 11-12 มิ.ย., CPI 12 มิ.ย., earnings ORCL 10 มิ.ย. — ห้ามใช้ประโยคทั่วไป",
  "tags":["US"],"markets":["NYSE"]
}
เฉพาะ impact>=6 เท่านั้น ไม่เกิน 4 รายการ`;

    // Claude รับ input สั้นกว่า Groq — จำกัดไว้ที่ 4000 chars
    const newsCtxGroq = newsContext.slice(0, 6000);
    const newsCtxClaude = newsContext.slice(0, 4000);
    const userPrompt = `บริบทข่าว (วิเคราะห์จากข้อมูลนี้):\n${newsCtxGroq}\n\nตอบ JSON array ภาษาไทยเท่านั้น ห้ามสร้างข่าวนอกเหนือจาก context ที่ให้มา`;
    const userPromptClaude = `บริบทข่าว:\n${newsCtxClaude}\n\nตอบ JSON array ภาษาไทยเท่านั้น`;

    const items = await callAI(env, system, userPrompt, userPromptClaude);

    if (!items || items.length === 0) {
      console.warn('no items returned');
      return { ok: true, count: 0 };
    }

    // [FIX] ล้าง encoding ผิด เช่น "trênn", "takxe", "chuyên家"
    const cleanedItems = items.map(cleanItem);

    // Dedup — ใช้ทั้ง ticker + keyword จาก headline + วันที่
    const todayStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const newItems = [];
    for (const item of cleanedItems) {
      if (env.ALERT_KV && item.headline) {
        // Key 1: headline-based (40 chars)
        const headlineKey = 'elite:seen:' + item.headline.toLowerCase().replace(/\s+/g, '').slice(0, 40);
        // Key 2: ticker + date — กัน 1 ticker ต่อวัน
        const tickerKey = item.tickers?.length
          ? 'elite:day:' + todayStr + ':' + item.tickers[0]
          : null;
        try {
          const [s1, s2] = await Promise.all([
            env.ALERT_KV.get(headlineKey),
            tickerKey ? env.ALERT_KV.get(tickerKey) : null
          ]);
          if (s1 || s2) { console.log('dedup skip:', item.headline); continue; }
          await Promise.allSettled([
            env.ALERT_KV.put(headlineKey, '1', { expirationTtl: 43200 }),
            tickerKey ? env.ALERT_KV.put(tickerKey, '1', { expirationTtl: 86400 }) : null
          ].filter(Boolean));
        } catch (e) {
          if (e.message?.includes('limit exceeded')) {
            console.warn('[KV limit] dedup write skipped:', item.headline);
          } else { continue; }
        }
      }
      // MODULE 2-7: Enrich item with module data
      const { type: catalystType, catalystScore } = detectCatalyst(
        (item.headline || '') + ' ' + (item.what_happened || '')
      );
      const sourceQuality = getSourceQuality(item.source || '');
      item._catalyst     = catalystType;
      item._catalystScore = catalystScore;
      item._sourceQuality = sourceQuality;
      item._eventLabel   = classifyEvent(catalystType);
      item._tradingScore = scoreTradingRelevance(item, catalystScore, sourceQuality);
      item._actionable   = item._tradingScore >= 30;
      // MODULE 5: Reject non-specific insights
      if (!isInsightSpecific(item.read_game || '')) {
        item.read_game = null; // will be omitted from TG
      }
      // MODULE 7+: Reject items without individual stock tickers
      if (!hasIndividualStock(item)) {
        _mon.deduped++;
        LOG.info('no individual stock skip', { headline: (item.headline||'').slice(0,60) });
        continue;
      }
      // Reject low trading score items
      if (item._tradingScore < 25) {
        _mon.deduped++;
        LOG.info('low score skip', { score: item._tradingScore, headline: (item.headline||'').slice(0,60) });
        continue;
      }
      // MODULE 7: Remove affected_stocks without reason
      if (item.affected_stocks) {
        item.affected_stocks = item.affected_stocks.filter(s => s.reason && s.reason.length > 5);
      }
      newItems.push(item);
    }

    // Sort: actionable first, then by trading score
    newItems.sort((a, b) => (b._tradingScore || 0) - (a._tradingScore || 0));

    if (newItems.length === 0) {
      return { ok: true, count: 0, deduped: true };
    }

    // [PATCH 4] บันทึกผลลง KV สำหรับ /results endpoint
    if (env.ALERT_KV) {
      try {
        await env.ALERT_KV.put('elite:results', JSON.stringify({
          ts: Date.now(),
          items: newItems
        }), { expirationTtl: 7200 });
      } catch (e) {
        if (e.message?.includes('limit exceeded')) {
          console.warn('[KV limit] elite:results write skipped — limit exceeded');
        } else { throw e; }
      }
    }

    // ฟอร์แมต Telegram
    let msg = `🌐 <b>ELITE SCAN</b> — ${today}\n━━━━━━━━━━━━━━━━━━━━\n\n`;
    for (const item of newItems) {
      const itemId = (item.id || '').toLowerCase();
      const person = ELITE_PEOPLE.find(p =>
        p.id === itemId || itemId.includes(p.id) ||
        p.name.toLowerCase().split(' ').some(w => itemId.includes(w))
      );
      const impactScore = item.impact || 5;
      const fallbackEmoji = impactScore >= 8 ? '🔴' : impactScore >= 6 ? '🟡' : '🟢';
      const emoji = person?.emoji || fallbackEmoji;

      msg += `${emoji} <b>${item.headline}</b>\n`;
      if (person?.role) msg += `<i>${person.role}</i>\n`;
      // [NEWS INTEGRITY] แสดง source จริง + URL
      if (item.source) {
        msg += item.source_url
          ? `📰 <a href="${item.source_url}">${item.source}</a>\n`
          : `📰 ${item.source}\n`;
      }
      const sentimentEmoji = item.sentiment==='bullish'?'📈 Bullish':item.sentiment==='bearish'?'📉 Bearish':'➡️ Neutral';
      const riskEmoji = item.risk_level==='high'?'🔴':item.risk_level==='medium'?'🟡':'🟢';
      msg += `${sentimentEmoji} | ${riskEmoji} Risk ${item.risk_level||'medium'} | Confidence ${item.confidence||70}%\n`;
      if (item.ai_take) msg += `💬 <i>${item.ai_take}</i>\n`;
      msg += `📌 ${item.what_happened}\n`;
      msg += `💡 ${item.why_important}\n`;
      msg += `📈 ${item.market_impact}\n`;

      // ETF Impact
      if (item.etf_impact) {
        const etfLine = Object.entries(item.etf_impact)
          .map(([k,v]) => `${v==='positive'?'🟢':v==='negative'?'🔴':'⚪'}${k}`)
          .join(' ');
        msg += `ETF: ${etfLine}\n`;
      }

      // Sector & Type
      if (item.sector || item.news_type) {
        msg += `🏷️ ${item.sector||''}${item.news_type?` · ${item.news_type}`:''}\n`;
      }

      // หุ้นได้ประโยชน์/เสียประโยชน์
      if (item.stocks_benefit?.length) {
        msg += `✅ ได้ประโยชน์: ${item.stocks_benefit.map(s=>`$${s.t}`).join(', ')}\n`;
      }
      if (item.stocks_hurt?.length) {
        msg += `❌ เสียประโยชน์: ${item.stocks_hurt.map(s=>`$${s.t}`).join(', ')}\n`;
      }

      // แยก action กับ disclaimer ออกจากกัน
      if (item.action) {
        // ตัด disclaimer ออกจาก action ถ้าติดมา
        const cleanAction = (item.action||'')
          .replace(/—?\s*ไม่ใช่คำแนะนำการลงทุน/g,'')
          .replace(/—?\s*ไม่ใช่คำแนะนำ/g,'')
          .replace(/\(ไม่ใช่คำแนะนำ.*?\)/g,'')
          .trim();
        if(cleanAction) msg += `🎯 ${cleanAction}\n`;
      }
      msg += `⚠️ <i>ใช้ประกอบการตัดสินใจเท่านั้น ไม่ใช่คำแนะนำการลงทุน</i>\n`;

      // Timeline
      if (item.timeline?.short) msg += `⚡ ระยะสั้น: ${item.timeline.short}\n`;

      msg += '\n';
    }

    await sendTG(env, msg);
    console.log(`sent ${newItems.length} items`);
    _mon.sent += newItems.length; LOG.info('elite scan done', { sent: newItems.length, deduped: _mon.deduped, total: _mon.sent });
    return { ok: true, count: newItems.length };

  } finally {
    if (env.ALERT_KV) await env.ALERT_KV.delete('elite:running');
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    // [PATCH 3] /results — แอปดึงผล scan ล่าสุดได้โดยตรง
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

    // GET /clear-dedup — ล้าง dedup cache แล้ว trigger scan ใหม่
    if (url.pathname === '/clear-dedup') {
      try {
        const list = await env.ALERT_KV.list({ prefix: 'elite:seen:' });
        let cleared = 0;
        for (const key of list.keys) {
          await env.ALERT_KV.delete(key.name);
          cleared++;
        }
        await env.ALERT_KV.delete('elite:running');
        console.log(`clear-dedup: cleared ${cleared} keys`);
        // FIX: ใช้ ctx.waitUntil แทน await โดยตรง — ป้องกัน timeout
        ctx.waitUntil(runEliteScan(env).catch(e => console.error('clear-dedup scan error:', e.message)));
        return new Response(JSON.stringify({ ok: true, cleared, message: 'scan triggered in background' }), { headers: CORS });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: CORS });
      }
    }

    // /trigger — FIX: ใช้ ctx.waitUntil ป้องกัน timeout (runEliteScan ใช้เวลา 20-60s)
    if (url.pathname === '/trigger') {
      try {
        // ตรวจว่ากำลัง running อยู่ไหม
        const running = env.ALERT_KV ? await env.ALERT_KV.get('elite:running') : null;
        if (running) {
          return new Response(JSON.stringify({ ok: true, message: 'scan already running' }), { headers: CORS });
        }
        // รัน scan ใน background ไม่ block response
        ctx.waitUntil(runEliteScan(env).catch(e => console.error('/trigger scan error:', e.message)));
        return new Response(JSON.stringify({ ok: true, message: 'scan triggered' }), { headers: CORS });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: CORS });
      }
    }

    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true, ts: new Date().toISOString() }), { headers: CORS });
    }

    return new Response(JSON.stringify({ ok: false, error: 'Not found' }), { status: 404, headers: CORS });
  },

  // FIX: ลบ duplicate scheduled handler — เหลืออันเดียว
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runEliteScan(env).catch(e => console.error('scheduled error:', e.message)));
  }
};// ── Structured Logger ──
const LOG = {
  info:  (msg, d={}) => console.log(JSON.stringify({ level:'info',  msg, ...d, ts: Date.now() })),
  warn:  (msg, d={}) => console.warn(JSON.stringify({ level:'warn',  msg, ...d, ts: Date.now() })),
  error: (msg, d={}) => console.error(JSON.stringify({ level:'error', msg, ...d, ts: Date.now() })),
};
const _mon = { scans:0, newsItems:0, sent:0, deduped:0, errors:[], lastRun:null };

// ── Input Validator ──
function validateTicker(t) {
  if (!t || typeof t !== 'string') return null;
  return t.toUpperCase().replace(/[^A-Z0-9.\-]/g, '').slice(0,10) || null;
}


