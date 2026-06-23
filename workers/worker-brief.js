// ============================================================
//  STOCK PRO -- Worker 3: Economic Intelligence Brief
//  ชื่อ: stock-brief
//  หน้าที่: Morning Brief สรุปพอร์ต + ตลาด ทุกเช้า 08:00 ไทย
//  Cron: 0 */2 * * *
//  KV Binding: ALERT_KV
//  ENV: TG_TOKEN, TG_CHAT_ID, ANTHROPIC_KEY, GEMINI_KEY, GROQ_KEY, FINNHUB_KEY, GNEWS_KEY
// ============================================================

async function sendTG(env, text, token=null, chatId=null){
  const tok = token||env.TG_TOKEN, cid = chatId||env.TG_CHAT_ID;
  if(!tok||!cid) return;
  for(let i=0; i<text.length; i+=4000){
    try{
      await fetch(`https://api.telegram.org/bot${tok}/sendMessage`,{
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({chat_id:cid, text:text.slice(i,i+4000), parse_mode:'HTML', disable_web_page_preview:true})
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

// [FIX] ลำดับ AI ตรงกับแอป: Groq → Claude → Gemini
async function callAI(env, system, user, maxTokens=1200){
  // 1. Groq (ฟรี เร็ว — ลองก่อนเสมอ)
  const grok = env.GROQ_KEY||'';
  if(grok){
    for(let i=0; i<3; i++){
      try{
        const r = await fetch('https://api.groq.com/openai/v1/chat/completions',{
          method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+grok},
          body: JSON.stringify({model:'llama-3.3-70b-versatile', messages:[{role:'system',content:system},{role:'user',content:user}], max_tokens:maxTokens, temperature:0.3}),
          signal:AbortSignal.timeout(20000)
        });
        if(r.status===429){ await new Promise(r=>setTimeout(r,(2**i)*5000)); continue; }
        if(r.ok){ const d=await r.json(); const t=d?.choices?.[0]?.message?.content; if(t) return t; }
        break;
      }catch{ break; }
    }
  }
  // 2. Claude Haiku (คุณภาพสูง)
  const ank = env.ANTHROPIC_KEY||'';
  if(ank){
    try{
      const r = await fetch('https://api.anthropic.com/v1/messages',{
        method:'POST',
        headers:{'Content-Type':'application/json','x-api-key':ank,'anthropic-version':'2023-06-01'},
        body: JSON.stringify({model:'claude-haiku-4-5', max_tokens:maxTokens, system, messages:[{role:'user',content:user}]}),
        signal:AbortSignal.timeout(20000)
      });
      if(r.ok){ const d=await r.json(); const t=(d.content||[]).filter(c=>c.type==='text').map(c=>c.text).join(''); if(t) return t; }
    }catch(e){ console.warn('[callAI Claude]', e.message); }
  }
  // 3. Gemini Flash (fallback)
  const gkey = env.GEMINI_KEY||'';
  if(gkey){
    try{
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${gkey}`,{
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({
          systemInstruction:{parts:[{text:system}]},
          contents:[{role:'user', parts:[{text:user}]}],
          generationConfig:{maxOutputTokens:maxTokens, temperature:0.3}
        }), signal:AbortSignal.timeout(25000)
      });
      if(r.ok){ const d=await r.json(); const t=d?.candidates?.[0]?.content?.parts?.[0]?.text; if(t) return t; }
    }catch(e){ console.warn('[callAI Gemini]', e.message); }
  }
  return null;
}

async function getQuote(env, ticker){
  try{
    const r = await env.ALERT_KV.get('priceCache');
    if(r){ const c=JSON.parse(r); if(c.quotes?.[ticker]) return c.quotes[ticker]; }
  }catch{}
  try{
    const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${env.FINNHUB_KEY}`,{signal:AbortSignal.timeout(5000)});
    if(r.ok){ const d=await r.json(); if(d?.c>0) return {price:d.c, change:d.dp||0}; }
  }catch{}
  return null;
}

async function fetchNews(env){
  const articles = [];
  const cutoff = Date.now() - 24*3600*1000;
  const gnewsKey = env.GNEWS_KEY||'';
  if(gnewsKey){
    try{
      const from24h = new Date(cutoff).toISOString();
      const r = await fetch(
        `https://gnews.io/api/v4/search?q=stock+market+economy+Federal+Reserve&lang=en&max=5&sortby=publishedAt&from=${from24h}&apikey=${gnewsKey}`,
        {signal:AbortSignal.timeout(8000)}
      );
      if(r.ok){
        const d = await r.json();
        for(const a of (d.articles||[])){
          if(!a.title||!a.url) continue;
          articles.push({title:a.title, source:a.source?.name||'GNews', url:a.url});
        }
      }
    }catch{}
  }
  if(articles.length < 3){
    try{
      const r = await fetch(`https://finnhub.io/api/v1/news?category=general&token=${env.FINNHUB_KEY}`,{signal:AbortSignal.timeout(8000)});
      if(r.ok){
        const d = await r.json();
        for(const a of (d||[]).slice(0,5)){
          if(!a.headline||!a.url) continue;
          const pubTs = (a.datetime||0)*1000;
          if(pubTs > 0 && pubTs < cutoff) continue;
          articles.push({title:a.headline, source:a.source||'Finnhub', url:a.url});
          if(articles.length >= 5) break;
        }
      }
    }catch{}
  }
  return articles;
}

async function loadPortfolio(env){
  try{
    const r = await env.ALERT_KV.get('portfolio');
    if(r) return JSON.parse(r);
  }catch{}
  return [];
}

async function sendMorningBrief(env){
  const coolKey = 'morning_brief_sent_v2';
  try{
    const l = await env.ALERT_KV.get(coolKey);
    if(l && Date.now()-parseInt(l) < 20*3600*1000) return;
  }catch{}

  const portfolio = await loadPortfolio(env);
  const [spy, qqq, vix] = await Promise.all([getQuote(env,'SPY'), getQuote(env,'QQQ'), getQuote(env,'VIX')]);

  const portQuotes = {};
  if(portfolio.length){
    await Promise.all(portfolio.map(async pos => {
      const q = await getQuote(env, pos.t);
      if(q) portQuotes[pos.t] = q;
    }));
  }

  const articles = await fetchNews(env);
  const date = new Date().toLocaleDateString('th-TH',{weekday:'long',year:'numeric',month:'long',day:'numeric',timeZone:'Asia/Bangkok'});
  const fmt = v => v>=0?`+${v.toFixed(2)}%`:`${v.toFixed(2)}%`;

  let portDetails = '';
  if(portfolio.length){
    portDetails = portfolio.map(pos => {
      const q = portQuotes[pos.t];
      if(!q) return null;
      const pnlPct = pos.avgPrice>0 ? ((q.price-pos.avgPrice)/pos.avgPrice*100) : 0;
      return `${pos.t}: วันนี้ ${fmt(q.change)} | P&L ${fmt(pnlPct)} | ราคา $${q.price.toFixed(2)} (เข้าที่ $${pos.avgPrice.toFixed(2)})`;
    }).filter(Boolean).join('\n');
  }

  const newsContext = articles.length
    ? articles.slice(0,4).map((a,i) => `[${i+1}] ${a.title} -- ${a.source}`).join('\n')
    : 'ไม่มีข่าวใหม่';

  const system = `คุณคือที่ปรึกษาการลงทุนส่วนตัว วิเคราะห์พอร์ตและตลาดแบบกระชับตรงประเด็น ภาษาไทยธรรมดา ห้ามใช้ ** # Markdown`;
  const user = `Morning Brief ${date}

📊 ตลาดวันนี้
SPY: ${spy?`$${spy.price.toFixed(2)} ${fmt(spy.change)}`:'N/A'}
QQQ: ${qqq?`$${qqq.price.toFixed(2)} ${fmt(qqq.change)}`:'N/A'}
VIX: ${vix?vix.price.toFixed(1):'N/A'}

💼 พอร์ตของฉัน
${portDetails||'ไม่มีข้อมูลพอร์ต'}

📰 ข่าวล่าสุด
${newsContext}

สรุป 3 ข้อ:
1) แต่ละหุ้นในพอร์ตควรทำอะไร (ถือ/ขายบางส่วน/ระวัง)
2) ตลาดวันนี้ควรระวังอะไร
3) กลยุทธ์วันนี้ 1 ประโยค`;

  const analysis = await callAI(env, system, user, 800);

  let msg = `🌅 <b>Morning Brief -- ${date}</b>\n\n`;
  msg += `📊 <b>ตลาดเช้านี้</b>\n`;
  if(spy) msg += `SPY: $${spy.price.toFixed(2)} <b>${fmt(spy.change)}</b>\n`;
  if(qqq) msg += `QQQ: $${qqq.price.toFixed(2)} <b>${fmt(qqq.change)}</b>\n`;
  if(vix) msg += `VIX: ${vix.price.toFixed(1)} ${vix.price>20?'⚠️':'✅'}\n`;

  if(portfolio.length){
    msg += `\n💼 <b>พอร์ตของคุณ</b>\n`;
    portfolio.forEach(pos => {
      const q = portQuotes[pos.t];
      if(!q) return;
      const pnlPct = pos.avgPrice>0 ? ((q.price-pos.avgPrice)/pos.avgPrice*100) : 0;
      const dayEmoji = q.change>=0?'🟢':'🔴';
      const pnlEmoji = pnlPct>=5?'🚀':pnlPct>=0?'✅':pnlPct>=-5?'⚠️':'🔴';
      msg += `${dayEmoji} <b>${pos.t}</b>: วันนี้ ${fmt(q.change)} | ${pnlEmoji} P&L ${fmt(pnlPct)}\n`;
    });
  }

  if(analysis) msg += `\n🤖 <b>AI วิเคราะห์พอร์ต</b>\n${analysis}`;
  msg += `\n\n⚠️ ใช้ประกอบการตัดสินใจเท่านั้น`;

  await sendTG(env, msg);
  try{ await env.ALERT_KV.put(coolKey, Date.now().toString()); }catch{}
}

async function sendEconomicAlert(env, force=false){
  const coolKey = 'econ_alert_ts';
  if(!force){
    try{ const l=await env.ALERT_KV.get(coolKey); if(l&&Date.now()-parseInt(l)<14400*1000) return; }catch{}
  }

  const articles = await fetchNews(env);
  if(!articles.length) return;

  const ownerPort = await loadPortfolio(env);
  const portTickers = ownerPort.length ? ownerPort.map(p=>p.t).join(', ') : '';
  const now = new Date().toLocaleString('th-TH',{timeZone:'Asia/Bangkok',hour:'2-digit',minute:'2-digit',day:'numeric',month:'short'});

  const system = `คุณคือนักวิเคราะห์การลงทุน วิเคราะห์ข่าวเศรษฐกิจกระทบตลาด ภาษาไทยกระชับ ห้ามใช้ ** # Markdown`;
  const user = `วันนี้: ${now}

ข่าวล่าสุด (verified):
${articles.map((a,i)=>`[${i+1}] ${a.title} -- ${a.source}`).join('\n')}

${portTickers ? `พอร์ต: ${portTickers}` : ''}

วิเคราะห์:
1) ข่าวไหนกระทบตลาดมากที่สุด บวก/ลบ อย่างไร
2) sector/หุ้นไหนได้รับผลกระทบ
${portTickers ? `3) กระทบพอร์ต (${portTickers}) อย่างไร` : ''}`;

  const analysis = await callAI(env, system, user, 800);
  if(!analysis) return;

  let msg = `📡 <b>Economic Intelligence -- ${now}</b>\n\n${analysis}`;
  if(articles.length){
    msg += `\n\n📰 <b>Sources</b>`;
    articles.slice(0,3).forEach(a => {
      msg += `\n• ${a.title.slice(0,60)}${a.title.length>60?'...':''} -- ${a.source}`;
    });
  }
  msg += `\n\n⚠️ ใช้ประกอบการตัดสินใจเท่านั้น`;

  await sendTGAll(env, msg);
  try{ await env.ALERT_KV.put(coolKey, Date.now().toString()); }catch{}
}

async function sendPreMarket(env){
  const coolKey = 'premarket_sent';
  try{ const l=await env.ALERT_KV.get(coolKey); if(l&&Date.now()-parseInt(l)<20*3600*1000) return; }catch{}

  const articles = await fetchNews(env);
  const ownerPort = await loadPortfolio(env);
  if(!articles.length && !ownerPort.length) return;

  const date = new Date().toLocaleDateString('th-TH',{weekday:'long',day:'numeric',month:'long',timeZone:'Asia/Bangkok'});
  const system = `คุณคือที่ปรึกษาการลงทุน สรุป Pre-Market Brief ภาษาไทยกระชับ ห้ามใช้ ** # Markdown`;
  const user = `Pre-Market Brief ${date}
ข่าวล่าสุด: ${articles.map(a=>a.title).join(' | ')||'ไม่มี'}
พอร์ต: ${ownerPort.map(p=>p.t).join(', ')||'ไม่มี'}
สรุป: ตลาดคืนนี้ควรระวังอะไร และพอร์ตควรทำอะไร`;

  const analysis = await callAI(env, system, user, 600);
  if(!analysis) return;

  await sendTG(env, `☀️ <b>Pre-Market Brief -- ${date}</b>\n\n${analysis}\n\n⚠️ ใช้ประกอบการตัดสินใจเท่านั้น`);
  try{ await env.ALERT_KV.put(coolKey, Date.now().toString()); }catch{}
}

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
      const recent = (d?.data||[]).filter(t => new Date(t.transactionDate||t.filingDate).getTime() >= sevenDaysAgo);
      if(!recent.length) continue;
      let buyVal=0, sellVal=0;
      recent.forEach(t => {
        const val = Math.abs((t.share||0)*(t.transactionPrice||0));
        if(t.change>0) buyVal+=val; else sellVal+=val;
      });
      const fmtM = v => '$'+(v/1000000).toFixed(1)+'M';
      if(buyVal>500000) alerts.push(`🟢 <b>${s.t}</b> -- Insider ซื้อ ${fmtM(buyVal)}`);
      if(sellVal>1000000) alerts.push(`🔴 <b>${s.t}</b> -- Insider ขาย ${fmtM(sellVal)}`);
    }catch{}
    await new Promise(r=>setTimeout(r,200));
  }

  if(!alerts.length) return;
  await sendTGAll(env, `👔 <b>Insider Trading Alert</b>\n\n${alerts.join('\n')}\n\n⚠️ ใช้ประกอบการตัดสินใจเท่านั้น`);
  try{ await env.ALERT_KV.put(coolKey, Date.now().toString(), {expirationTtl:86400}); }catch{}
}

export default {
  async fetch(req, env, ctx){
    const url = new URL(req.url);
    const h = {'Access-Control-Allow-Origin':'*','Content-Type':'text/plain'};
    if(url.pathname==='/trigger/morning'){ ctx.waitUntil(sendMorningBrief(env)); return new Response('Morning Brief triggered',{headers:h}); }
    if(url.pathname==='/trigger/morning/force'){
      try{ await env.ALERT_KV.delete('morning_brief_sent_v2'); }catch{}
      ctx.waitUntil(sendMorningBrief(env));
      return new Response('Morning Brief forced',{headers:h});
    }
    if(url.pathname==='/trigger/premarket'){ ctx.waitUntil(sendPreMarket(env)); return new Response('Pre-market triggered',{headers:h}); }
    if(url.pathname==='/trigger/news'){ ctx.waitUntil(sendEconomicAlert(env, true)); return new Response('Economic alert triggered',{headers:h}); }
    if(url.pathname==='/trigger/insider'){ ctx.waitUntil(checkInsiderAlerts(env)); return new Response('Insider triggered',{headers:h}); }
    if(url.pathname==='/debug/time'){
      const now = new Date();
      const utcH = now.getUTCHours();
      return new Response(JSON.stringify({
        utc_now: now.toISOString(),
        utc_hour: utcH,
        will_run_morning_brief: (utcH===1||utcH===2),
        will_run_premarket: (utcH===9||utcH===10)
      }, null, 2), {headers:{...h,'Content-Type':'application/json'}});
    }
    if(url.pathname==='/debug/portfolio'){
      const port = await loadPortfolio(env);
      return new Response(JSON.stringify({count:port.length, portfolio:port}, null, 2), {headers:{...h,'Content-Type':'application/json'}});
    }
    return new Response('STOCK PRO -- Brief Worker OK',{headers:h});
  },

  async scheduled(event, env, ctx){
    const h = new Date().getUTCHours();
    const d = new Date().getUTCDay();
    ctx.waitUntil(sendEconomicAlert(env));
    ctx.waitUntil(checkInsiderAlerts(env));
    if(h===1||h===2) ctx.waitUntil(sendMorningBrief(env));
    if((h===9||h===10) && d>=1 && d<=5) ctx.waitUntil(sendPreMarket(env));
  }
};
