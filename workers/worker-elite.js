// ============================================================
//  STOCK PRO -- Worker Elite: ข่าว ELITE figures
//  ENV: GROQ_KEY, GEMINI_KEY, ANTHROPIC_KEY, NEWS_API_KEY
//       TG_TOKEN, TG_CHAT_ID, FINNHUB_KEY, ALERT_KV
//  Cron: 0 */4 * * *
//  KV Binding: ALERT_KV
// ============================================================

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store'
};

// [FIX] ตรงกับ index.html ELITE_PEOPLE ทุก id, name, role
const ELITE_PEOPLE_DEFAULT = [
  { id: 'trump',    name: 'Donald Trump',       emoji: '🔴', role: 'US President',        ticker: '' },
  { id: 'powell',   name: 'Kevin Warsh',         emoji: '🔴', role: 'Fed Chair',            ticker: '' },
  { id: 'jensen',   name: 'Jensen Huang',        emoji: '🟢', role: 'NVIDIA CEO',           ticker: 'NVDA' },
  { id: 'altman',   name: 'Sam Altman',          emoji: '🟢', role: 'OpenAI CEO',           ticker: 'MSFT' },
  { id: 'musk',     name: 'Elon Musk',           emoji: '🟡', role: 'Tesla/SpaceX CEO',     ticker: 'TSLA' },
  { id: 'xi',       name: 'Xi Jinping',          emoji: '🟡', role: 'China President',       ticker: '' },
  { id: 'opec',     name: 'OPEC+',               emoji: '🟡', role: 'Oil Cartel',            ticker: 'XOM' },
  { id: 'khamenei', name: 'Ali Khamenei',        emoji: '🔴', role: 'Iran Supreme Leader',  ticker: '' },
  { id: 'nadella',  name: 'Satya Nadella',       emoji: '🟢', role: 'Microsoft CEO',        ticker: 'MSFT' },
  { id: 'cook',     name: 'Tim Cook',            emoji: '🟢', role: 'Apple CEO',            ticker: 'AAPL' },
  { id: 'pichai',   name: 'Sundar Pichai',       emoji: '🟢', role: 'Google/Alphabet CEO',  ticker: 'GOOGL' },
  { id: 'zuck',     name: 'Mark Zuckerberg',     emoji: '🟢', role: 'Meta CEO',             ticker: 'META' },
  { id: 'dimon',    name: 'Jamie Dimon',         emoji: '🟡', role: 'JPMorgan CEO',         ticker: 'JPM' },
  { id: 'lisa_su',  name: 'Lisa Su',             emoji: '🟢', role: 'AMD CEO',              ticker: 'AMD' },
  { id: 'jassy',    name: 'Andy Jassy',          emoji: '🟢', role: 'Amazon/AWS CEO',       ticker: 'AMZN' },
  { id: 'lagarde',  name: 'Christine Lagarde',   emoji: '🟡', role: 'ECB President',        ticker: '' },
  { id: 'buffett',  name: 'Warren Buffett',      emoji: '🟢', role: 'Berkshire CEO',        ticker: 'BRK.B' },
];

const ELITE_PEOPLE_VERSION = 3; // v3: ตรงกับ index.html

const WIKI_PAGES = {
  trump:    'Donald_Trump',
  powell:   'Kevin_Warsh',
  jensen:   'Jensen_Huang',
  altman:   'Sam_Altman',
  musk:     'Elon_Musk',
  xi:       'Xi_Jinping',
  nadella:  'Satya_Nadella',
  cook:     'Tim_Cook',
  pichai:   'Sundar_Pichai',
  zuck:     'Mark_Zuckerberg',
  dimon:    'Jamie_Dimon',
  buffett:  'Warren_Buffett',
  lagarde:  'Christine_Lagarde',
  lisa_su:  'Lisa_Su',
  jassy:    'Andy_Jassy',
};

let ELITE_PEOPLE = ELITE_PEOPLE_DEFAULT;

async function getElitePeople(env) {
  if (env.ALERT_KV) {
    try {
      const cached = await env.ALERT_KV.get('elite:people');
      if (cached) {
        const { data, ts, version } = JSON.parse(cached);
        if (version === ELITE_PEOPLE_VERSION && Date.now() - ts < 24*3600*1000) return data;
      }
    } catch {}
  }
  const updated = ELITE_PEOPLE_DEFAULT.map(p => ({ ...p }));
  for (const person of updated) {
    const wikiPage = WIKI_PAGES[person.id];
    if (!wikiPage) continue;
    try {
      const r = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(wikiPage)}`, { signal: AbortSignal.timeout(5000) });
      if (r.ok) {
        const d = await r.json();
        const title = d.title || '';
        if (!title.includes('Inc.') && !title.includes('Company') && title !== 'OPEC') person.name = title;
      }
    } catch {}
  }
  if (env.ALERT_KV) {
    try { await env.ALERT_KV.put('elite:people', JSON.stringify({ data: updated, ts: Date.now(), version: ELITE_PEOPLE_VERSION }), { expirationTtl: 86400 }); } catch {}
  }
  return updated;
}

function cleanText(text) {
  if (!text || typeof text !== 'string') return text;
  return text
    .replace(/[\u2E80-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F]/g, '')
    .replace(/[^\u0E00-\u0E7Fa-zA-Z0-9\s$%+\-.,!?:;()/&@#'"°฿\u2019\u2018\u201C\u201D]/g, '')
    .replace(/\s+/g, ' ').trim();
}

function cleanItem(item) {
  if (!item || typeof item !== 'object') return item;
  const strFields = ['headline','ai_take','what_happened','why_important','market_impact','action','read_game','watch'];
  for (const f of strFields) { if (item[f]) item[f] = cleanText(item[f]); }
  if (Array.isArray(item.stocks_to_monitor)) item.stocks_to_monitor = item.stocks_to_monitor.map(s=>({...s,reason:cleanText(s.reason)}));
  if (Array.isArray(item.stocks_at_risk)) item.stocks_at_risk = item.stocks_at_risk.map(s=>({...s,reason:cleanText(s.reason)}));
  if (Array.isArray(item.pros)) item.pros = item.pros.map(cleanText);
  if (Array.isArray(item.cons)) item.cons = item.cons.map(cleanText);
  if (Array.isArray(item.bullish_reasons)) item.bullish_reasons = item.bullish_reasons.map(cleanText);
  if (Array.isArray(item.bearish_reasons)) item.bearish_reasons = item.bearish_reasons.map(cleanText);
  if (Array.isArray(item.impact_stocks)) item.impact_stocks = item.impact_stocks.filter(s=>s&&s.t);
  if (item.timeline) { item.timeline.short = cleanText(item.timeline.short); item.timeline.medium = cleanText(item.timeline.medium); }
  return item;
}

async function sendTG(env, text) {
  const token = env.TG_TOKEN, chatId = env.TG_CHAT_ID;
  if (!token || !chatId) return;
  for (let i = 0; i < text.length; i += 4000) {
    try {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: text.slice(i,i+4000), parse_mode: 'HTML' })
      });
    } catch {}
  }
}

const SOURCE_TIERS = {
  tier1: { sources: ['reuters','bloomberg','wsj','wall street journal','ft','financial times'], score: 10 },
  tier2: { sources: ['cnbc','ap','associated press','barron','marketwatch','economist'], score: 8 },
  tier3: { sources: ['techcrunch','the verge','fortune','business insider','seeking alpha','yahoo finance'], score: 6 },
  tier4: { sources: ['firstpost','economic times','mint','ndtv'], score: 5 },
};
function getSourceQuality(sourceName) {
  const s = (sourceName || '').toLowerCase();
  for (const { sources, score } of Object.values(SOURCE_TIERS)) {
    if (sources.some(t => s.includes(t))) return score;
  }
  return 4;
}

function buildQuery(person) {
  return `${person.name} OR ${person.role}`;
}

async function fetchNews(env, person) {
  const query = buildQuery(person);
  const articles = [];
  const finnhubKeys = [env.FINNHUB_KEY, env.FINNHUB_KEY_2, env.FINNHUB_KEY_3].filter(Boolean);

  // GNews
  if (env.NEWS_API_KEY) {
    try {
      const from24h = new Date(Date.now() - 86400000).toISOString();
      const r = await fetch(`https://gnews.io/api/v4/search?q=${encodeURIComponent(query)}&lang=en&max=5&sortby=publishedAt&from=${from24h}&apikey=${env.NEWS_API_KEY}`, { signal: AbortSignal.timeout(6000) });
      if (r.ok) {
        const d = await r.json();
        const cutoff = Date.now() - 24*3600*1000;
        const items = (d.articles||[]).filter(a=>new Date(a.publishedAt||0).getTime()>=cutoff).map(a=>({
          title:a.title||'', description:(a.description||'').slice(0,300),
          url:a.url||'', source:a.source?.name||'GNews',
          publishedAt:a.publishedAt||'', sourceQuality:getSourceQuality(a.source?.name||'')
        }));
        articles.push(...items);
      }
    } catch {}
  }

  // Finnhub company news สำหรับ CEO ที่มี ticker
  if (person.ticker && articles.length < 3 && finnhubKeys.length > 0) {
    const to = new Date().toISOString().slice(0,10);
    const from = new Date(Date.now()-2*86400000).toISOString().slice(0,10);
    for (const key of finnhubKeys) {
      try {
        const r = await fetch(`https://finnhub.io/api/v1/company-news?symbol=${person.ticker}&from=${from}&to=${to}&token=${key}`, { signal: AbortSignal.timeout(6000) });
        if (!r.ok) continue;
        const d = await r.json();
        const items = (d||[]).slice(0,3).map(a=>({
          title:a.headline||'', description:(a.summary||'').slice(0,300),
          url:a.url||'', source:a.source||'Finnhub',
          publishedAt:new Date((a.datetime||Date.now()/1000)*1000).toISOString(),
          sourceQuality:getSourceQuality(a.source||'')
        }));
        if (items.length>0) { articles.push(...items); break; }
      } catch {}
    }
  }

  // Finnhub general news fallback
  if (articles.length < 2 && finnhubKeys.length > 0) {
    for (const key of finnhubKeys) {
      try {
        const r = await fetch(`https://finnhub.io/api/v1/news?category=general&token=${key}`, { signal: AbortSignal.timeout(6000) });
        if (!r.ok) continue;
        const d = await r.json();
        const keywords = query.toLowerCase().split(' ').filter(w=>w.length>3);
        const cutoff24h = Date.now()-24*3600*1000;
        const filtered = (d||[]).filter(a=>{
          if((a.datetime||0)*1000<cutoff24h) return false;
          const text=(a.headline+' '+(a.summary||'')).toLowerCase();
          return keywords.some(kw=>text.includes(kw));
        }).slice(0,3).map(a=>({
          title:a.headline||'', description:(a.summary||'').slice(0,300),
          url:a.url||'', source:a.source||'Finnhub',
          publishedAt:new Date((a.datetime||Date.now()/1000)*1000).toISOString(),
          sourceQuality:getSourceQuality(a.source||'')
        }));
        if (filtered.length>0) { articles.push(...filtered); break; }
      } catch {}
    }
  }

  const text = articles.map(a=>`[SOURCE: ${a.source}] [URL: ${a.url}] [DATE: ${(a.publishedAt||'').slice(0,10)}] ${a.title}: ${a.description}`).join(' | ');
  return { text, articles };
}

const CATALYST_PATTERNS = {
  earnings:   { pattern: /earnings|revenue|profit|EPS|beat|miss|guidance/i, score: 10 },
  ma:         { pattern: /acqui|merger|takeover|buyout|deal|billion/i, score: 9 },
  product:    { pattern: /launch|release|unveil|announce|new model|IPO/i, score: 8 },
  regulation: { pattern: /regulat|ban|fine|antitrust|SEC|FTC|lawsuit/i, score: 8 },
  macro:      { pattern: /Fed|interest rate|inflation|CPI|GDP|jobs|payroll/i, score: 7 },
  insider:    { pattern: /insider|bought|sold|stake|CEO.*buy|executive/i, score: 9 },
  partnership:{ pattern: /partner|contract|agreement|deal with/i, score: 7 },
  upgrade:    { pattern: /upgrade|downgrade|price target|analyst|rating/i, score: 6 },
};
function detectCatalyst(text) {
  let best = null, bestScore = 0;
  for (const [type, { pattern, score }] of Object.entries(CATALYST_PATTERNS)) {
    if (pattern.test(text) && score > bestScore) { best = type; bestScore = score; }
  }
  return { type: best||'general', catalystScore: bestScore };
}

function tokenize(text) { return (text||'').toLowerCase().replace(/[^a-zก-๙0-9\s]/g,'').split(/\s+/).filter(w=>w.length>2); }
function cosineSimilarity(a, b) {
  const setA=new Set(tokenize(a)), setB=new Set(tokenize(b));
  const inter=[...setA].filter(t=>setB.has(t)).length;
  const denom=Math.sqrt(setA.size)*Math.sqrt(setB.size);
  return denom===0?0:inter/denom;
}
function deduplicateNews(articles) {
  const merged = [];
  for (const art of articles) {
    const dup = merged.find(m=>cosineSimilarity(m.title,art.title)>0.55);
    if (dup) { if((art.sourceQuality||5)>(dup.sourceQuality||5)){ dup.title=art.title; dup.source=art.source; dup.url=art.url; dup.sourceQuality=art.sourceQuality; } dup.sourceCount=(dup.sourceCount||1)+1; }
    else merged.push({...art,sourceCount:1});
  }
  return merged;
}

function scoreTradingRelevance(item, catalystScore, sourceQuality) {
  let score = 0;
  score += Math.min(catalystScore,10)*2;
  score += Math.min(sourceQuality,10);
  score += Math.min((item.impact||5),10);
  score += (item.stocks_to_monitor?.length||0)>0?5:0;
  score += item.sentiment!=='neutral'?3:0;
  score += item.fact_check==='confirmed'?5:item.fact_check==='semi-confirmed'?2:0;
  return Math.min(score,100);
}

const GENERIC_PATTERNS = [/นักลงทุนควรติดตาม.{0,10}อย่างใกล้ชิด/,/อาจส่งผลกระทบต่อ.{0,10}ตลาด/,/ตลาดหุ้น.{0,10}ผันผวน/];
function isInsightSpecific(text) { return !GENERIC_PATTERNS.some(p=>p.test(text||'')); }
function hasIndividualStock(item) {
  const etfList = new Set(['SPY','QQQ','IWM','DIA','VTI','GLD','SLV','USO','TLT','HYG','LQD','XLK','XLF','XLE','XLV','ARKK']);
  const monitors=[...(item.stocks_to_monitor||[]),...(item.stocks_at_risk||[])];
  return monitors.some(s=>s.t&&!etfList.has(s.t));
}

async function loadSeenBatch(env) {
  if (!env.ALERT_KV) return new Set();
  try { const raw=await env.ALERT_KV.get('elite:seen:batch'); return new Set(raw?JSON.parse(raw):[]); } catch { return new Set(); }
}
async function saveSeenBatch(env, seenSet) {
  if (!env.ALERT_KV) return;
  try { await env.ALERT_KV.put('elite:seen:batch',JSON.stringify([...seenSet].slice(-300)),{expirationTtl:43200}); } catch {}
}

// [FIX] เพิ่ม Gemini เป็น priority 1 ก่อน Groq และ Claude
async function callAI(env, system, user) {
  // 1. Gemini Flash
  const gemKeys = [env.GEMINI_KEY, env.GEMINI_KEY_2, env.GEMINI_KEY_3].filter(Boolean);
  for (const gk of gemKeys) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=${gk}`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          systemInstruction:{parts:[{text:system}]},
          contents:[{role:'user',parts:[{text:user}]}],
          generationConfig:{maxOutputTokens:2000,temperature:0.3}
        }), signal:AbortSignal.timeout(25000)
      });
      if (r.ok) {
        const d = await r.json();
        const raw = d?.candidates?.[0]?.content?.parts?.[0]?.text||'';
        const match = raw.match(/\[[\s\S]*\]/);
        if (match) { const items=JSON.parse(match[0]); if(Array.isArray(items)) { console.log('[AI] Gemini ok'); return items; } }
      }
    } catch(e) { console.warn('[AI Gemini]',e.message); }
  }
  // 2. Groq
  if (env.GROQ_KEY) {
    for (let attempt=0; attempt<2; attempt++) {
      try {
        const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+env.GROQ_KEY},
          body:JSON.stringify({model:'llama-3.3-70b-versatile',max_tokens:2000,temperature:0.3,messages:[{role:'system',content:system},{role:'user',content:user}]}),
          signal:AbortSignal.timeout(20000)
        });
        if (r.status===429) { await new Promise(r=>setTimeout(r,(2**attempt)*2000)); continue; }
        if (r.ok) {
          const d = await r.json();
          const raw = d?.choices?.[0]?.message?.content||'';
          const match = raw.match(/\[[\s\S]*\]/);
          if (match) { const items=JSON.parse(match[0]); if(Array.isArray(items)) { console.log('[AI] Groq ok'); return items; } }
        }
        break;
      } catch(e) { console.warn('[AI Groq]',e.message); break; }
    }
  }
  // 3. Claude Haiku
  if (env.ANTHROPIC_KEY) {
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method:'POST',
        headers:{'Content-Type':'application/json','x-api-key':env.ANTHROPIC_KEY,'anthropic-version':'2023-06-01'},
        body:JSON.stringify({model:'claude-haiku-4-5-20251001',max_tokens:2000,system,messages:[{role:'user',content:user}]}),
        signal:AbortSignal.timeout(20000)
      });
      if (r.ok) {
        const d = await r.json();
        const raw=(d.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('');
        const match = raw.match(/\[[\s\S]*\]/);
        if (match) { const items=JSON.parse(match[0]); if(Array.isArray(items)) { console.log('[AI] Claude ok'); return items; } }
      }
    } catch(e) { console.warn('[AI Claude]',e.message); }
  }
  throw new Error('All AI providers failed');
}

const _mon = { scans:0, sent:0, lastRun:null };

async function runEliteScan(env) {
  _mon.lastRun = new Date().toISOString();
  _mon.scans++;
  ELITE_PEOPLE = await getElitePeople(env);

  if (env.ALERT_KV) {
    const running = await env.ALERT_KV.get('elite:running');
    if (running) { console.warn('[elite] already running'); return { skipped: true }; }
    await env.ALERT_KV.put('elite:running','1',{expirationTtl:240});
  }

  try {
    const today = new Date().toLocaleDateString('th-TH',{weekday:'long',day:'numeric',month:'long',year:'numeric',timeZone:'Asia/Bangkok'});

    // ดึงข่าวทุกคน
    let allArticles = [];
    let newsContext = '';
    const BATCH_SIZE = 4;
    for (let i=0; i<ELITE_PEOPLE.length; i+=BATCH_SIZE) {
      const batch = ELITE_PEOPLE.slice(i,i+BATCH_SIZE);
      const results = await Promise.all(batch.map(p=>fetchNews(env,p)));
      for (let j=0; j<batch.length; j++) {
        const person=batch[j], result=results[j];
        if (!result.articles?.length) continue;
        newsContext += `\n[${person.id}] ${result.text}`;
        allArticles.push(...result.articles.map(a=>({...a,person:person.id})));
      }
      if (i+BATCH_SIZE<ELITE_PEOPLE.length) await new Promise(r=>setTimeout(r,200));
    }

    allArticles = deduplicateNews(allArticles);
    const cutoffScan = Date.now()-24*3600*1000;
    allArticles = allArticles.filter(a=>{
      const pubTs=a.publishedAt?new Date(a.publishedAt).getTime():0;
      if(pubTs>0&&pubTs<cutoffScan) return false;
      if(!a.publishedAt&&pubTs===0) return false;
      const {catalystScore}=detectCatalyst(a.title+' '+(a.description||''));
      return (a.sourceQuality||4)>=4&&(catalystScore>0||a.sourceQuality>=8);
    });

    newsContext = allArticles.map(a=>`[SOURCE: ${a.source} Q:${a.sourceQuality||'?'}] [URL: ${a.url}] [DATE: ${(a.publishedAt||'').slice(0,10)}] ${a.title}: ${a.description||''}`).join(' | ');
    if (!newsContext.trim()) return { ok:true, count:0, reason:'no_news' };

    // [FIX] ใช้ id ที่ตรงกับ index.html
    const validIds = ELITE_PEOPLE.map(p=>p.id).join(', ');

    const system = `คุณคือนักวิเคราะห์การเงินไทยระดับโปร วันนี้: ${today}
วิเคราะห์เฉพาะข่าวที่ไม่เกิน 24 ชั่วโมง ตอบ JSON array เท่านั้น ทุกฟิลด์เป็นภาษาไทย ยกเว้น ticker

กฎ id: id ต้องเป็นหนึ่งใน: ${validIds}
ผูก id กับข่าวที่เป็น "การกระทำ/คำพูด/ประกาศ" ของบุคคลนั้นโดยตรงเท่านั้น ห้ามสร้างข่าวเอง

กฎ ai_take: ต้องเป็น second-order effect ที่ไม่อยู่ใน headline
กฎ read_game: ต้องมีเงื่อนไข/ตัวเลข เช่น "ถ้า [เงื่อนไข] → [ผลที่ตามมา]" หรือ null
กฎ watch: จับคู่ event ที่เกี่ยวข้อง FOMC/CPI/NFP/GDP/OPEC ฯลฯ

รูปแบบ JSON:
{"id":"person_id","headline":"หัวข้อไม่เกิน 15 คำ","source":"ชื่อสำนักข่าว",
"source_url":"https://...","fact_check":"confirmed/semi-confirmed/rumor","source_quality":8,
"ai_take":"second-order effect","sentiment":"bullish/bearish/neutral","confidence":75,
"impact_level":"low/medium/high","what_happened":"2 ประโยค","why_important":"1 ประโยค",
"market_impact":"1 ประโยค","chain_reasoning":"ข่าว→อุตสาหกรรม→บริษัท→หุ้น",
"etf_impact":{"SPY":"positive/negative/neutral","QQQ":"positive/negative/neutral","TLT":"positive/negative/neutral","GLD":"positive/negative/neutral"},
"stocks_to_monitor":[{"t":"TICKER","reason":"เหตุผล"}],
"stocks_at_risk":[{"t":"TICKER","reason":"เหตุผล"}],
"impact_stocks":[{"t":"TICKER","dir":"up/down"}],
"bullish_reasons":["เหตุผลบวก"],"bearish_reasons":["เหตุผลลบ"],
"timeline":{"short":"1-5 วัน","medium":"1-3 เดือน"},
"impact":8,"pros":["ข้อดี"],"cons":["ความเสี่ยง"],
"read_game":"insight+threshold หรือ null","watch":"event ที่เกี่ยวข้อง"}
เฉพาะ impact>=6 ไม่เกิน 5 รายการ`;

    const userPrompt = `บริบทข่าว (วิเคราะห์จากนี้เท่านั้น):\n${newsContext.slice(0,6000)}\n\nตอบ JSON array ภาษาไทย`;

    let items;
    try { items = await callAI(env, system, userPrompt); }
    catch(e) { console.error('[elite] AI failed:', e.message); return { ok:false, error:e.message }; }

    if (!items?.length) return { ok:true, count:0 };

    const seenSet = await loadSeenBatch(env);
    let seenDirty = false;
    let newItems = [];

    for (const item of items.map(cleanItem)) {
      // [FIX] ตรวจ id ว่าตรงกับ ELITE_PEOPLE
      if (!ELITE_PEOPLE.find(p=>p.id===item.id)) { console.log('[skip] invalid id:', item.id); continue; }

      if (item.headline) {
        const key = item.headline.toLowerCase().replace(/\s+/g,'').slice(0,40);
        if (seenSet.has(key)) continue;
        seenSet.add(key); seenDirty=true;
      }

      const {type:catalystType,catalystScore} = detectCatalyst((item.headline||'')+(item.what_happened||''));
      const sourceQuality = getSourceQuality(item.source||'');
      item._catalyst=catalystType; item._catalystScore=catalystScore;
      item._sourceQuality=sourceQuality; item._tradingScore=scoreTradingRelevance(item,catalystScore,sourceQuality);

      if (!isInsightSpecific(item.read_game||'')) item.read_game=null;

      const isMacroLeader = ['trump','xi','opec','lagarde','khamenei'].includes(item.id);
      if (!hasIndividualStock(item)&&!isMacroLeader) continue;
      if (item._tradingScore<25) continue;

      newItems.push(item);
    }

    if (seenDirty) await saveSeenBatch(env, seenSet);

    newItems.sort((a,b)=>(b._tradingScore||0)-(a._tradingScore||0));
    newItems = newItems.filter(item=>(item.impact||0)>=6).slice(0,5);
    if (!newItems.length) return { ok:true, count:0 };

    if (env.ALERT_KV) {
      try { await env.ALERT_KV.put('elite:results',JSON.stringify({ts:Date.now(),items:newItems}),{expirationTtl:14400}); } catch {}
    }

    const today2 = new Date().toLocaleDateString('th-TH',{weekday:'long',day:'numeric',month:'long',year:'numeric',timeZone:'Asia/Bangkok'});
    let msg = `🌐 <b>ELITE SCAN</b> -- ${today2}\n━━━━━━━━━━━━━━━━━━━━\n\n`;
    for (const item of newItems) {
      const person = ELITE_PEOPLE.find(p=>p.id===(item.id||'').toLowerCase());
      const emoji = person?.emoji||(item.impact>=8?'🔴':item.impact>=6?'🟡':'🟢');
      msg += `${emoji} <b>${item.headline}</b>\n`;
      if (person?.role) msg += `<i>${person.role}</i>\n`;
      if (item.source) msg += item.source_url?`📰 <a href="${item.source_url}">${item.source}</a>\n`:`📰 ${item.source}\n`;
      const sentEmoji = item.sentiment==='bullish'?'📈 Bullish':item.sentiment==='bearish'?'📉 Bearish':'➡️ Neutral';
      msg += `${sentEmoji} | Confidence ${item.confidence||70}%\n`;
      if (item.ai_take) msg += `💬 <i>${item.ai_take}</i>\n`;
      if (item.impact_stocks?.length) msg += `📊 หุ้นกระทบ: ${item.impact_stocks.map(s=>`$${s.t}${s.dir==='up'?'↑':'↓'}`).join(', ')}\n`;
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
    return { ok:true, count:newItems.length };

  } finally {
    if (env.ALERT_KV) try { await env.ALERT_KV.delete('elite:running'); } catch {}
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method==='OPTIONS') return new Response(null,{status:204,headers:CORS});

    if (url.pathname==='/results') {
      try {
        const raw = env.ALERT_KV?await env.ALERT_KV.get('elite:results'):null;
        if (!raw) return new Response(JSON.stringify({ok:false,error:'no results yet'}),{status:404,headers:CORS});
        const data = JSON.parse(raw);
        return new Response(JSON.stringify({ok:true,items:data.items,age:Math.floor((Date.now()-data.ts)/1000),count:data.items.length}),{headers:CORS});
      } catch(e) { return new Response(JSON.stringify({ok:false,error:e.message}),{status:500,headers:CORS}); }
    }

    if (url.pathname==='/clear-dedup') {
      try {
        await env.ALERT_KV.delete('elite:seen:batch');
        await env.ALERT_KV.delete('elite:running');
        ctx.waitUntil(runEliteScan(env).catch(e=>console.error('scan error:',e.message)));
        return new Response(JSON.stringify({ok:true,message:'cleared and triggered'}),{headers:CORS});
      } catch(e) { return new Response(JSON.stringify({ok:false,error:e.message}),{status:500,headers:CORS}); }
    }

    if (url.pathname==='/trigger') {
      try {
        const running = env.ALERT_KV?await env.ALERT_KV.get('elite:running'):null;
        if (running) return new Response(JSON.stringify({ok:true,message:'already running'}),{headers:CORS});
        ctx.waitUntil(runEliteScan(env).catch(e=>console.error('trigger error:',e.message)));
        return new Response(JSON.stringify({ok:true,message:'scan triggered'}),{headers:CORS});
      } catch(e) { return new Response(JSON.stringify({ok:false,error:e.message}),{status:500,headers:CORS}); }
    }

    if (url.pathname==='/health') {
      return new Response(JSON.stringify({ok:true,ts:new Date().toISOString(),lastRun:_mon.lastRun,scans:_mon.scans,sent:_mon.sent}),{headers:CORS});
    }

    return new Response(JSON.stringify({ok:false,error:'Not found'}),{status:404,headers:CORS});
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runEliteScan(env).catch(e=>console.error('scheduled error:',e.message)));
  }
};
