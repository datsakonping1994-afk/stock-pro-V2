// ============================================================
//  STOCK PRO — Worker 3: Economic Intelligence Brief
//  ชื่อ: stock-brief
//  หน้าที่: ส่งข่าวเศรษฐกิจจริง Forward-looking ล่วงหน้า
//  Cron: 0 */4 * * * (ทุก 4 ชั่วโมง)
//  KV Binding: ALERT_KV
//  ENV: TG_TOKEN, TG_CHAT_ID, GEMINI_KEY, GROQ_KEY, FINNHUB_KEY, GNEWS_KEY
// ============================================================

// ── Utility ──
async function sendTG(env, text, token=null, chatId=null){
  const tok = token||env.TG_TOKEN, cid = chatId||env.TG_CHAT_ID;
  if(!tok||!cid) return;
  for(let i=0; i<text.length; i+=4000){
    try{
      await fetch(`https://api.telegram.org/bot${tok}/sendMessage`,{
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({chat_id:cid, text:text.slice(i,i+4000), parse_mode:'HTML', disable_web_page_preview:false})
      });
    }catch{}
  }
}

async function sendTGAll(env, text){
  await sendTG(env, text);
  try{
    const raw = await env.ALERT_KV.get('users_list');
    if(!raw) return;
    const tokens = JSON.parse(raw);
    await Promise.all(tokens.map(async tok => {
      try{
        const ud = await env.ALERT_KV.get(`user:${tok}`);
        if(!ud) return;
        const u = JSON.parse(ud);
        if(u.tgToken && u.tgChatId) await sendTG(env, text, u.tgToken, u.tgChatId);
      }catch{}
    }));
  }catch{}
}

async function callAI(env, system, user, maxTokens=1200){
  // Gemini first
  const gkey = env.GEMINI_KEY||'';
  if(gkey){
    try{
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${gkey}`,{
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({
          system_instruction:{parts:[{text:system}]},
          contents:[{parts:[{text:user}]}],
          generationConfig:{maxOutputTokens:maxTokens}
        }), signal:AbortSignal.timeout(25000)
      });
      if(r.ok){ const d=await r.json(); const t=d?.candidates?.[0]?.content?.parts?.[0]?.text; if(t) return t; }
    }catch{}
  }
  // Groq fallback
  const grok = env.GROQ_KEY||'';
  if(grok){
    for(let i=0; i<3; i++){
      try{
        const r = await fetch('https://api.groq.com/openai/v1/chat/completions',{
          method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+grok},
          body: JSON.stringify({model:'llama-3.3-70b-versatile', messages:[{role:'system',content:system},{role:'user',content:user}], max_tokens:maxTokens}),
          signal:AbortSignal.timeout(20000)
        });
        if(r.status===429){ await new Promise(r=>setTimeout(r,(2**i)*5000)); continue; }
        if(r.ok){ const d=await r.json(); return d?.choices?.[0]?.message?.content||null; }
        break;
      }catch{ break; }
    }
  }
  return null;
}

// ── ดึง Economic Calendar จาก Finnhub ──
async function getEconomicEvents(env, daysAhead=2){
  const key = env.FINNHUB_KEY||'';
  if(!key) return [];
  try{
    const from = new Date().toISOString().slice(0,10);
    const to = new Date(Date.now() + daysAhead*86400000).toISOString().slice(0,10);
    const r = await fetch(
      `https://finnhub.io/api/v1/calendar/economic?from=${from}&to=${to}&token=${key}`,
      {signal:AbortSignal.timeout(8000)}
    );
    if(!r.ok) return [];
    const d = await r.json();
    // filter เฉพาะ High impact และ USD
    return (d.economicCalendar||[])
      .filter(e => e.impact==='high' && (e.country==='US'||e.currency==='USD'))
      .sort((a,b) => new Date(a.time||a.date) - new Date(b.time||b.date));
  }catch{ return []; }
}

// ── ดึงข่าวจริงจาก GNews + Finnhub พร้อม strict filter ──
async function fetchVerifiedNews(env, topics=[]){
  const cutoff = Date.now() - 24*3600*1000;
  const articles = [];

  const isDupe = (title, existing) => {
    const n = t => t.toLowerCase().replace(/[^a-z0-9\s]/g,'').trim();
    const nNew = n(title);
    if(existing.some(a => n(a.title)===nNew)) return true;
    const words = nNew.split(' ').filter(w=>w.length>4);
    return existing.some(a => words.filter(w=>n(a.title).includes(w)).length>=3);
  };

  // Source 1: GNews — ข่าวตลาด/เศรษฐกิจล่าสุด
  const gnewsKey = env.GNEWS_KEY||env.NEWS_API_KEY||'';
  if(gnewsKey){
    const queries = [
      'Federal Reserve inflation GDP employment US economy',
      'stock market earnings S&P500 Nasdaq',
      ...topics.slice(0,2)
    ];
    const from24h = new Date(cutoff).toISOString();
    for(const q of queries){
      if(articles.length >= 8) break;
      try{
        const r = await fetch(
          `https://gnews.io/api/v4/search?q=${encodeURIComponent(q)}&lang=en&max=5&sortby=publishedAt&from=${from24h}&apikey=${gnewsKey}`,
          {signal:AbortSignal.timeout(8000)}
        );
        if(!r.ok) continue;
        const d = await r.json();
        for(const a of (d.articles||[])){
          if(!a.title || !a.url) continue;
          const pubTs = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
          if(pubTs > 0 && pubTs < cutoff) continue; // ข่าวเก่า
          if(!a.publishedAt) continue; // ไม่มีวันที่ = ข้าม
          if(isDupe(a.title, articles)) continue;
          articles.push({
            title: a.title,
            desc: (a.description||'').slice(0,300),
            url: a.url,
            source: a.source?.name||'GNews',
            publishedAt: a.publishedAt,
            verified: true // มี URL + วันที่จริง
          });
        }
      }catch{}
    }
  }

  // Source 2: Finnhub General News — fallback พร้อม strict filter
  if(articles.length < 4){
    try{
      const r = await fetch(
        `https://finnhub.io/api/v1/news?category=general&token=${env.FINNHUB_KEY}`,
        {signal:AbortSignal.timeout(8000)}
      );
      if(r.ok){
        const d = await r.json();
        for(const a of (d||[])){
          if(articles.length >= 8) break;
          if(!a.headline || !a.url) continue;
          const pubTs = (a.datetime||0)*1000;
          if(pubTs > 0 && pubTs < cutoff) continue; // ข่าวเก่า
          if(isDupe(a.headline, articles)) continue;
          articles.push({
            title: a.headline,
            desc: (a.summary||'').slice(0,300),
            url: a.url,
            source: a.source||'Finnhub',
            publishedAt: new Date(pubTs).toISOString(),
            verified: true
          });
        }
      }
    }catch{}
  }

  return articles;
}

// ── AI filter + วิเคราะห์ข่าวเศรษฐกิจจริง ──
async function analyzeEconomicNews(env, articles, events, portfolio){
  if(!articles.length && !events.length) return null;

  const now = new Date().toLocaleString('th-TH',{
    timeZone:'Asia/Bangkok', day:'numeric', month:'short',
    hour:'2-digit', minute:'2-digit'
  });

  const eventContext = events.slice(0,5).map(e => {
    const t = e.time||e.date||'';
    const timeStr = t ? new Date(t).toLocaleString('th-TH',{timeZone:'Asia/Bangkok',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}) : 'เร็วๆ นี้';
    return `[EVENT] ${e.event||e.name} | ${timeStr} | คาด: ${e.estimate||'N/A'} | ก่อนหน้า: ${e.prev||'N/A'}`;
  }).join('\n');

  const newsContext = articles.slice(0,6).map((a,i) =>
    `[${i+1}] "${a.title}" — ${a.source} (${(a.publishedAt||'').slice(0,10)})\nURL: ${a.url}\n${a.desc||''}`
  ).join('\n\n');

  const portTickers = portfolio.length ? portfolio.map(p=>p.t).join(', ') : '';

  const system = `คุณคือนักเศรษฐศาสตร์และนักวิเคราะห์การลงทุนระดับ CFA
กฎเหล็ก:
1. วิเคราะห์เฉพาะข้อมูลที่ให้มาเท่านั้น ห้ามสร้างข่าวหรือตัวเลขขึ้นมาเอง
2. ทุก claim ต้องอ้างอิง source จริงที่ให้มา
3. ถ้าข้อมูลไม่พอ ให้บอกตรงๆ ว่าไม่แน่ใจ
4. เน้น Forward-looking — สิ่งที่จะเกิดขึ้น ไม่ใช่สิ่งที่เกิดแล้ว
5. ห้ามใช้ ** # Markdown`;

  const user = `วันนี้: ${now}

=== ตัวเลขเศรษฐกิจที่กำลังจะประกาศ ===
${eventContext||'ไม่มีข้อมูล'}

=== ข่าวจริงจาก verified sources (24h ล่าสุด) ===
${newsContext||'ไม่มีข่าว'}

${portTickers ? `=== พอร์ตของผู้ใช้ ===\n${portTickers}` : ''}

วิเคราะห์ในรูปแบบนี้ (ใช้ภาษาไทย):

🗓 ตัวเลขเศรษฐกิจที่ต้องจับตา
สำหรับแต่ละ event ที่สำคัญ:
- ชื่อ event + วันเวลา
- ตลาดคาดอะไร (consensus)
- ถ้าออกมาสูงกว่าคาด → กระทบอะไร บวก/ลบ
- ถ้าออกมาต่ำกว่าคาด → กระทบอะไร บวก/ลบ
- หุ้น/sector ที่ sensitive ที่สุด

📰 ข่าวจริงที่กระทบตลาด
เฉพาะข่าวที่มี market impact จริงเท่านั้น (ข้าม generic):
- ข่าวอะไร (อ้าง source)
- กระทบ sector/หุ้นไหน บวก/ลบ อย่างไร
- Chain: ข่าว → อุตสาหกรรม → หุ้น

${portTickers ? `💼 กระทบพอร์ต (${portTickers})\n- หุ้นไหนในพอร์ตได้รับผลกระทบ ควรทำอะไร` : ''}

⚡ สิ่งที่นักลงทุนควรทำ (concrete action)
- ไม่ใช่ "ควรติดตาม" แต่คือ "ควรทำอะไรจริงๆ"`;

  return await callAI(env, system, user, 1400);
}

// ── Morning Brief ──
async function sendMorningBrief(env){
  const coolKey = 'morning_brief_sent';
  try{ const l=await env.ALERT_KV.get(coolKey); if(l&&Date.now()-parseInt(l)<20*3600*1000) return; }catch{}

  const fmt = v => v>=0?`+${v.toFixed(2)}%`:`${v.toFixed(2)}%`;
  const getQ = async t => {
    try{
      const r=await env.ALERT_KV.get('priceCache');
      if(r){const c=JSON.parse(r);if(c.quotes?.[t]) return c.quotes[t];}
    }catch{}
    try{
      const r=await fetch(`https://finnhub.io/api/v1/quote?symbol=${t}&token=${env.FINNHUB_KEY}`,{signal:AbortSignal.timeout(5000)});
      if(r.ok){const d=await r.json();if(d?.c>0) return {price:d.c,change:d.dp||0};}
    }catch{}
    return null;
  };

  const [spy, qqq, vix] = await Promise.all([getQ('SPY'), getQ('QQQ'), getQ('VIX')]);
  const events = await getEconomicEvents(env, 2);
  const articles = await fetchVerifiedNews(env);

  let ownerPort = [];
  try{ const r=await env.ALERT_KV.get('portfolio'); if(r) ownerPort=JSON.parse(r); }catch{}

  const analysis = await analyzeEconomicNews(env, articles, events, ownerPort);

  const date = new Date().toLocaleDateString('th-TH',{weekday:'long',year:'numeric',month:'long',day:'numeric',timeZone:'Asia/Bangkok'});
  let msg = `🌅 <b>Morning Brief — ${date}</b>\n\n`;
  msg += `📊 ตลาดเช้านี้\n`;
  if(spy) msg += `SPY: $${spy.price.toFixed(2)} <b>${fmt(spy.change)}</b>\n`;
  if(qqq) msg += `QQQ: $${qqq.price.toFixed(2)} <b>${fmt(qqq.change)}</b>\n`;
  if(vix) msg += `VIX: ${vix.price.toFixed(1)} ${vix.price>20?'⚠️':'✅'}\n`;

  if(events.length){
    msg += `\n🗓 <b>ตัวเลขเศรษฐกิจที่จะประกาศ</b>\n`;
    events.slice(0,4).forEach(e => {
      const t = e.time||e.date;
      const ts = t ? new Date(t).toLocaleString('th-TH',{timeZone:'Asia/Bangkok',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}) : '';
      msg += `🔴 <b>${e.event||e.name}</b>${ts?` — ${ts}`:''}\n`;
      if(e.estimate) msg += `   คาด: ${e.estimate}${e.prev?` | ก่อนหน้า: ${e.prev}`:''}\n`;
    });
  }

  if(analysis) msg += `\n${analysis}`;
  msg += `\n\n⚠️ ใช้ประกอบการตัดสินใจเท่านั้น`;

  await sendTG(env, msg);
  try{ await env.ALERT_KV.put(coolKey, Date.now().toString()); }catch{}
}

// ── Economic News Alert (ทุก 4 ชม.) ──
async function sendEconomicAlert(env, force=false){
  const coolKey = 'econ_alert_ts';
  if(!force){
    try{ const l=await env.ALERT_KV.get(coolKey); if(l&&Date.now()-parseInt(l)<14400*1000) return; }catch{}
  }

  // ดึงข้อมูลพร้อมกัน
  const [events, articles] = await Promise.all([
    getEconomicEvents(env, 3),
    fetchVerifiedNews(env, ['Federal Reserve rate inflation GDP', 'earnings stock market'])
  ]);

  if(!articles.length && !events.length){
    console.log('[sendEconomicAlert] ไม่มีข้อมูลใหม่');
    return;
  }

  let ownerPort = [];
  try{ const r=await env.ALERT_KV.get('portfolio'); if(r) ownerPort=JSON.parse(r); }catch{}

  const analysis = await analyzeEconomicNews(env, articles, events, ownerPort);
  if(!analysis){ console.warn('[sendEconomicAlert] AI ไม่ตอบสนอง'); return; }

  const now = new Date().toLocaleString('th-TH',{timeZone:'Asia/Bangkok',hour:'2-digit',minute:'2-digit',day:'numeric',month:'short'});
  let msg = `📡 <b>Economic Intelligence — ${now}</b>\n\n`;
  msg += analysis;

  // แนบ source links
  if(articles.length){
    msg += `\n\n📰 <b>Sources (verified)</b>`;
    articles.slice(0,3).forEach(a => {
      msg += `\n• ${a.title.slice(0,60)}${a.title.length>60?'...':''} — ${a.source}`;
      if(a.url) msg += `\n  <a href="${a.url}">อ่านต่อ →</a>`;
    });
  }

  msg += `\n\n⚠️ ใช้ประกอบการตัดสินใจเท่านั้น`;

  await sendTGAll(env, msg);
  try{ await env.ALERT_KV.put(coolKey, Date.now().toString()); }catch{}
}

// ── Pre-market (16:00 ไทย = ก่อนตลาด US เปิด) ──
async function sendPreMarket(env){
  const coolKey = 'premarket_sent';
  try{ const l=await env.ALERT_KV.get(coolKey); if(l&&Date.now()-parseInt(l)<20*3600*1000) return; }catch{}

  const [events, articles] = await Promise.all([
    getEconomicEvents(env, 1),
    fetchVerifiedNews(env, ['premarket futures earnings today'])
  ]);

  let ownerPort = [];
  try{ const r=await env.ALERT_KV.get('portfolio'); if(r) ownerPort=JSON.parse(r); }catch{}

  const analysis = await analyzeEconomicNews(env, articles, events, ownerPort);
  if(!analysis) return;

  const date = new Date().toLocaleDateString('th-TH',{weekday:'long',day:'numeric',month:'long',timeZone:'Asia/Bangkok'});
  let msg = `☀️ <b>Pre-Market Brief — ${date}</b>\n\n`;
  msg += analysis;
  if(articles.length){
    msg += `\n\n📰 <b>Sources</b>`;
    articles.slice(0,2).forEach(a => {
      if(a.url) msg += `\n• <a href="${a.url}">${a.title.slice(0,55)}...</a>`;
    });
  }
  msg += `\n\n⚠️ ใช้ประกอบการตัดสินใจเท่านั้น`;

  await sendTG(env, msg);
  try{ await env.ALERT_KV.put(coolKey, Date.now().toString()); }catch{}
}

// ── Insider Trading Alert ──
async function checkInsiderAlerts(env){
  const coolKey = 'insider_alert_sent';
  try{ const l=await env.ALERT_KV.get(coolKey); if(l&&Date.now()-parseInt(l)<24*3600*1000) return; }catch{}

  let stocks = [];
  try{ const r=await env.ALERT_KV.get('stocks'); if(r) stocks=JSON.parse(r); }catch{}
  if(!stocks.length || !env.FINNHUB_KEY) return;

  const sevenDaysAgo = Date.now() - 7*86400000;
  const alerts = [];

  for(const s of stocks.slice(0,20)){
    try{
      const r = await fetch(`https://finnhub.io/api/v1/stock/insider-transactions?symbol=${s.t}&token=${env.FINNHUB_KEY}`,{signal:AbortSignal.timeout(5000)});
      if(!r.ok) continue;
      const d = await r.json();
      const recent = (d?.data||[])
        .filter(t => new Date(t.transactionDate||t.filingDate).getTime() >= sevenDaysAgo)
        .sort((a,b) => new Date(b.transactionDate||b.filingDate) - new Date(a.transactionDate||a.filingDate))
        .slice(0,1);
      if(!recent.length) continue;
      let buyVal=0, sellVal=0;
      recent.forEach(t => {
        const val = Math.abs((t.share||0)*(t.transactionPrice||0));
        if((t.transactionCode||'').toUpperCase()==='P'||t.change>0) buyVal+=val;
        else sellVal+=val;
      });
      const fmtM = v => '$'+(v/1000000).toFixed(1)+'M';
      if(buyVal>500000) alerts.push(`🟢 <b>${s.t}</b> — Insider ซื้อ ${fmtM(buyVal)} (สัญญาณบวก)`);
      if(sellVal>1000000) alerts.push(`🔴 <b>${s.t}</b> — Insider ขาย ${fmtM(sellVal)} (ควรติดตาม)`);
    }catch{}
    await new Promise(r=>setTimeout(r,200));
  }

  if(!alerts.length) return;
  await sendTGAll(env, `👔 <b>Insider Trading Alert</b>\n\n${alerts.join('\n\n')}\n\n📌 ข้อมูล SEC via Finnhub\n⚠️ ใช้ประกอบการตัดสินใจเท่านั้น`);
  try{ await env.ALERT_KV.put(coolKey, Date.now().toString(), {expirationTtl:86400}); }catch{}
}

export default {
  async fetch(req, env, ctx){
    const url = new URL(req.url);
    const h = {'Access-Control-Allow-Origin':'*','Content-Type':'text/plain'};
    if(url.pathname==='/trigger/morning'){ ctx.waitUntil(sendMorningBrief(env)); return new Response('Morning Brief triggered',{headers:h}); }
    if(url.pathname==='/trigger/premarket'){ ctx.waitUntil(sendPreMarket(env)); return new Response('Pre-market triggered',{headers:h}); }
    if(url.pathname==='/trigger/news'){
      try{ await sendEconomicAlert(env, true); }catch(e){ console.error(e.message); }
      return new Response('Economic alert triggered',{headers:h});
    }
    if(url.pathname==='/trigger/insider'){ ctx.waitUntil(checkInsiderAlerts(env)); return new Response('Insider triggered',{headers:h}); }
    return new Response('STOCK PRO — Brief Worker OK',{headers:h});
  },

  async scheduled(event, env, ctx){
    const h = new Date().getUTCHours();
    const d = new Date().getUTCDay();
    ctx.waitUntil(sendEconomicAlert(env));
    ctx.waitUntil(checkInsiderAlerts(env));
    if(h===1) ctx.waitUntil(sendMorningBrief(env));           // 08:00 ไทย
    if(h===9 && d>=1 && d<=5) ctx.waitUntil(sendPreMarket(env)); // 16:00 ไทย จ-ศ
  }
};
