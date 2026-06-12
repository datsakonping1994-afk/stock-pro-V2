// ============================================================
//  STOCK PRO — Worker 2: Buy Signal + Exit Signal + Earnings Alert
//  ชื่อ: stock-signals
//  หน้าที่: คำนวณ Buy Signal + Exit Signal + Earnings Alert ทุก 5 นาที
//  Cron: */5 * * * *
//  KV Binding: ALERT_KV
//  ENV: FINNHUB_KEY, TG_TOKEN, TG_CHAT_ID, POLYGON_KEY
// ============================================================

const SUP0={
  RKLB:95.0,EOSE:7.0,SLNH:1.45,MU:92.0,NVTS:5.8,ASTS:24.5,INTC:18.5,AMD:95.0,HIMS:30.0,IREN:11.2,
  ASML:640.0,CRWD:390.0,AVGO:190.0,IONQ:44.0,AAPL:188.0,NVDA:108.0,KTOS:28.5,RBRK:60.0,AAOI:25.0,HOOD:52.0,
  OKLO:37.0,TEM:48.0,GOOGL:155.0,NVO:62.0,AMZN:195.0,PLTR:108.0,CRDO:65.0,ANET:82.0,VRT:88.0,ARM:118.0,
  TSM:155.0,ISRG:510.0,NFLX:980.0,META:540.0,MSFT:380.0,JPM:240.0,XOM:108.0,SOFI:15.0,SPGI:480.0,MP:17.0,
  NOW:860.0,LLY:720.0,NBIS:35.0,AXON:430.0,TMDX:58.0,CRWV:48.0,MELI:1950.0,QCOM:135.0,AMAT:152.0,LRCX:740.0,
  CRM:248.0,ADBE:330.0,SNOW:135.0,DDOG:95.0,MDB:165.0,NET:92.0,TSLA:240.0,V:308.0,MA:475.0,WMT:88.0,
  ELF:28.0,AMSC:18.0,APP:280.0,COST:920.0,UNH:260.0,FPS:38.0,NOK:4.0,DELL:105.0,ONDS:3.0,
  OSS:7.0,AEHR:10.0,SNDK:42.0,AVAV:165.0,STX:82.0,VST:120.0,AMBA:55.0,ORCL:190.0,
  SPY:510.0,QQQ:420.0,SMH:200.0,
  PANW:250.0,MRVL:235.0,CBRS:210.0,SPCX:125.0
};

const LOG = {
  info:  (msg, d={}) => console.log(JSON.stringify({ level:'info',  msg, ...d, ts: Date.now() })),
  warn:  (msg, d={}) => console.warn(JSON.stringify({ level:'warn',  msg, ...d, ts: Date.now() })),
  error: (msg, d={}) => console.error(JSON.stringify({ level:'error', msg, ...d, ts: Date.now() })),
};
const _mon = { scanned:0, signals:0, exits:0, errors:[], lastRun:null };

function validateTicker(t) {
  if (!t || typeof t !== 'string') return null;
  return t.toUpperCase().replace(/[^A-Z0-9.\-]/g, '').slice(0,10) || null;
}

async function hasCooldown(env,key){ try{return !!(await env.ALERT_KV.get(key));}catch{return false;} }
async function setCooldown(env,key,hours=4){
  try{
    await env.ALERT_KV.put(key,Date.now().toString(),{expirationTtl:hours*3600});
  }catch(e){
    if(e.message?.includes('limit exceeded')) console.warn('[KV limit] cooldown write skipped:',key);
  }
}

async function getQuoteFromCache(ticker, env){
  try{
    const raw=await env.ALERT_KV.get('priceCache');
    if(raw){ const c=JSON.parse(raw); if(c.quotes[ticker]) return c.quotes[ticker]; }
  }catch(e){ LOG.warn('KV quote cache miss', {ticker, err:e.message}); }
  try{
    const r=await fetch(`https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${env.FINNHUB_KEY}`,{signal:AbortSignal.timeout(6000)});
    if(!r.ok) throw new Error('HTTP '+r.status);
    const d=await r.json();
    if(d&&d.c>0) return {price:d.c,change:d.dp||0};
  }catch(e){ LOG.warn('Finnhub quote failed', {ticker, err:e.message}); }
  return null;
}

async function getCandles(ticker, env, days=60){
  try{
    const cached=await env.ALERT_KV.get(`candles_${ticker}`);
    if(cached){ const d=JSON.parse(cached); if(d?.c?.length>=10) return d; }
  }catch(e){ LOG.warn('candle cache read failed', {ticker, err:e.message}); }

  const polyKeys=[env.POLYGON_KEY,env.POLYGON_KEY_2,env.POLYGON_KEY_3].filter(Boolean);
  if(!polyKeys.length){ LOG.error('POLYGON_KEY not set'); return null; }

  const polyTicker = ticker.replace('.', '-');
  const to=new Date(), from=new Date();
  from.setDate(from.getDate()-Math.ceil(days*1.5));
  const fmt=d=>d.toISOString().slice(0,10);

  for(const polyKey of polyKeys){
    try{
      const url=`https://api.polygon.io/v2/aggs/ticker/${polyTicker}/range/1/day/${fmt(from)}/${fmt(to)}?adjusted=true&sort=asc&limit=200&apiKey=${polyKey}`;
      const r=await fetch(url,{signal:AbortSignal.timeout(8000)});
      if(r.status===429){ LOG.warn('Polygon 429', {ticker}); continue; }
      if(!r.ok){ LOG.warn('Polygon error', {ticker, status:r.status}); continue; }
      const d=await r.json();
      if(d.results?.length>=10){
        const results=d.results.slice(-days);
        const c=[],h=[],l=[],o=[],v=[];
        for(const bar of results){c.push(bar.c);h.push(bar.h);l.push(bar.l);o.push(bar.o);v.push(bar.v||0);}
        const data={c,h,l,o,v,ok:true};
        try{await env.ALERT_KV.put(`candles_${ticker}`,JSON.stringify(data),{expirationTtl:21600});}catch{}
        return data;
      }
    }catch(e){ LOG.warn('Polygon fetch failed', {ticker, err:e.message}); }
  }
  return null;
}

function getS1(t,p,candles=null){
  if(!p||p<=0) return p*0.95;
  if(candles?.l?.length>=20){
    const lows=candles.l, n=Math.min(60,lows.length), recentLows=lows.slice(-n);
    const swingLows=[];
    for(let i=2;i<recentLows.length-2;i++){
      if(recentLows[i]<recentLows[i-1]&&recentLows[i]<recentLows[i-2]&&recentLows[i]<recentLows[i+1]&&recentLows[i]<recentLows[i+2]) swingLows.push(recentLows[i]);
    }
    const valid=swingLows.filter(v=>v<p*0.99&&v>p*0.85).sort((a,b)=>b-a);
    if(valid.length>0) return +valid[0].toFixed(2);
    const low20=Math.min(...lows.slice(-20));
    if(low20<p*0.99&&low20>p*0.85) return +low20.toFixed(2);
  }
  const b=SUP0[t]; if(b&&b<p*0.99&&b>p*0.85) return b;
  return +(p*0.93).toFixed(2);
}
function getR1(t,p,candles=null){const s1=getS1(t,p,candles);return +(s1+(p-s1)*3).toFixed(2);}

function calcRSI(closes,period=14){
  if(!closes||closes.length<period+1) return 50;
  let gains=0,losses=0;
  for(let i=closes.length-period;i<closes.length;i++){const d=closes[i]-closes[i-1];if(d>0)gains+=d;else losses+=Math.abs(d);}
  const ag=gains/period,al=losses/period;
  return al===0?100:+(100-(100/(1+ag/al))).toFixed(1);
}
function calcBB(closes){
  if(!closes||closes.length<20) return {bbPct:null};
  const sl=closes.slice(-20),mid=sl.reduce((a,b)=>a+b,0)/20;
  const sd=Math.sqrt(sl.reduce((a,b)=>a+(b-mid)**2,0)/20);
  const bbLower=mid-2*sd,bbUpper=mid+2*sd;
  return {bbPct:bbUpper>bbLower?+((closes[closes.length-1]-bbLower)/(bbUpper-bbLower)*100).toFixed(1):50};
}
function calcMACD(closes){
  if(!closes||closes.length<35) return {macdLine:null,macdSignal:null};
  const ema=(arr,n)=>{if(arr.length<n)return null;const k=2/(n+1);let e=arr.slice(0,n).reduce((a,b)=>a+b,0)/n;for(let i=n;i<arr.length;i++)e=arr[i]*k+e*(1-k);return e;};
  const macdSeries=[];
  for(let i=26;i<=closes.length;i++){const s=closes.slice(0,i);const e12=ema(s,12),e26=ema(s,26);if(e12!==null&&e26!==null)macdSeries.push(e12-e26);}
  if(macdSeries.length<9) return {macdLine:null,macdSignal:null};
  const k9=2/(9+1);let signal=macdSeries.slice(0,9).reduce((a,b)=>a+b,0)/9;
  for(let i=9;i<macdSeries.length;i++) signal=macdSeries[i]*k9+signal*(1-k9);
  return {macdLine:+(macdSeries[macdSeries.length-1]).toFixed(4),macdSignal:+signal.toFixed(4)};
}

function calcBuyScore(ticker,price,candles){
  if(!candles?.c||candles.c.length<15) return null;
  const closes=candles.c,highs=candles.h,lows=candles.l,vols=candles.v||[];
  const s1=getS1(ticker,price,candles),r1=getR1(ticker,price,candles);
  const rsi=calcRSI(closes);
  const {macdLine,macdSignal}=calcMACD(closes);
  const {bbPct}=calcBB(closes);
  const ema=(arr,n)=>{if(arr.length<n)return null;const k=2/(n+1);let e=arr.slice(0,n).reduce((a,b)=>a+b,0)/n;for(let i=n;i<arr.length;i++)e=arr[i]*k+e*(1-k);return e;};
  const ema20=ema(closes,20),ema50=ema(closes,50);
  const volToday=vols[vols.length-1]||0;
  const volAvg=vols.slice(-20).reduce((a,b)=>a+b,0)/Math.max(vols.slice(-20).length,1);
  const volRatio=volAvg>0?volToday/volAvg:1;
  const recentHigh=highs.length>=20?Math.max(...highs.slice(-20)):price;
  const pullbackPct=recentHigh>0?((recentHigh-price)/recentHigh*100):0;
  let score=0,breakdown=[];
  let g1=0;
  if(pullbackPct>=8&&pullbackPct<=25)g1+=12;else if(pullbackPct>=5)g1+=8;else if(pullbackPct>=3)g1+=4;
  if(bbPct!==null&&bbPct<=10)g1+=8;else if(bbPct!==null&&bbPct<=20)g1+=5;
  if(ema20&&Math.abs(price-ema20)/ema20*100<1.5)g1+=5;else if(ema50&&Math.abs(price-ema50)/ema50*100<2.0)g1+=5;
  score+=Math.min(g1,30); if(g1>0)breakdown.push(`📍แนวรับ ${Math.min(g1,30)}/30`);
  let osV=0;
  if(rsi<=30)osV+=1;else if(rsi<=40)osV+=0.7;else if(rsi<=50)osV+=0.3;
  const g2=Math.round(Math.min(osV/1,1)*25);
  score+=g2; if(g2>0)breakdown.push(`📉Oversold ${g2}/25`);
  let g3=0;
  if(rsi>=25&&rsi<=55){const prevRsi=calcRSI(closes.slice(0,-3));if(prevRsi<rsi)g3+=10;else g3+=4;}
  if(macdLine!==null&&macdSignal!==null&&macdLine>macdSignal)g3+=3;
  score+=Math.min(g3,20); if(g3>0)breakdown.push(`⚡Momentum ${Math.min(g3,20)}/20`);
  let g4=0;
  if(volRatio>=2.0)g4+=15;else if(volRatio>=1.5)g4+=10;else if(volRatio>=1.2)g4+=6;else if(volRatio>=1.0)g4+=3;
  score+=Math.min(g4,15); if(g4>0)breakdown.push(`📊Vol ${Math.min(g4,15)}/15`);
  let g5=0;
  if(ema20&&ema50&&ema20>ema50)g5+=5;
  if(pullbackPct<30)g5+=5;
  score+=Math.min(g5,10);
  return {score:Math.min(score,100),breakdown,rsi,bbPct,volRatio:+volRatio.toFixed(2),pullbackPct:+pullbackPct.toFixed(2),s1,r1};
}

async function sendTG(env,text,tgToken=null,tgChatId=null){
  const token=tgToken||env.TG_TOKEN, chatId=tgChatId||env.TG_CHAT_ID;
  if(!token||!chatId) return;
  try{await fetch(`https://api.telegram.org/bot${token}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:chatId,text,parse_mode:'HTML'})});}catch{}
}

async function sendTGAll(env,text){
  await sendTG(env,text);
  try{
    const raw=await env.ALERT_KV.get('users_list');
    if(!raw) return;
    const tokens=JSON.parse(raw);
    for(const token of tokens){
      try{const ud=await env.ALERT_KV.get(`user:${token}`);if(!ud)continue;const u=JSON.parse(ud);if(u.tgToken&&u.tgChatId)await sendTG(env,text,u.tgToken,u.tgChatId);}catch{}
    }
  }catch{}
}

async function saveSignalLog(env, entry){
  try{
    const raw = await env.ALERT_KV.get('signal_log');
    const log = raw ? JSON.parse(raw) : [];
    const dup = log.find(e => e.ticker===entry.ticker &&
      Math.abs(new Date(e.time)-new Date(entry.time)) < 5*60*1000);
    if(dup) return;
    log.push(entry);
    const trimmed = log.slice(-200);
    await env.ALERT_KV.put('signal_log', JSON.stringify(trimmed), {expirationTtl: 30*24*3600});
  }catch(e){ console.warn('[saveSignalLog]', e.message); }
}

function isMarketHours(){
  const et=new Date(new Date().toLocaleString('en-US',{timeZone:'America/New_York'}));
  const day=et.getDay(); if(day===0||day===6) return false;
  const mins=et.getHours()*60+et.getMinutes();
  return mins>=240&&mins<1200;
}

function isRegularHours(){
  const et=new Date(new Date().toLocaleString('en-US',{timeZone:'America/New_York'}));
  const day=et.getDay(); if(day===0||day===6) return false;
  const mins=et.getHours()*60+et.getMinutes();
  return mins>=570&&mins<960;
}

async function fetchEarningsCalendar(env){
  const today=new Date();
  const from=new Date(today); from.setDate(from.getDate()-1);
  const to=new Date(today); to.setDate(to.getDate()+7);
  const fmt=d=>d.toISOString().slice(0,10);
  const kvKey=`earnings_cal_${fmt(today)}`;
  try{ const cached=await env.ALERT_KV.get(kvKey); if(cached) return JSON.parse(cached); }catch{}
  try{
    const r=await fetch(`https://finnhub.io/api/v1/calendar/earnings?from=${fmt(from)}&to=${fmt(to)}&token=${env.FINNHUB_KEY}`,{signal:AbortSignal.timeout(8000)});
    if(r.ok){
      const d=await r.json();
      const items=d?.earningsCalendar||[];
      if(items.length>0){
        await env.ALERT_KV.put(kvKey,JSON.stringify(items),{expirationTtl:3600});
        return items;
      }
    }
  }catch{}
  return [];
}

async function runEarningsAlerts(env, stocks, portfolio){
  const tickerSet=new Set([...stocks.map(s=>s.t),...portfolio.map(p=>p.t)]);
  if(!tickerSet.size) return;
  const calendar=await fetchEarningsCalendar(env);
  if(!calendar.length) return;
  const today=new Date(); today.setHours(0,0,0,0);
  for(const e of calendar){
    if(!tickerSet.has(e.symbol)) continue;
    const dt=new Date(e.date+'T00:00:00'); dt.setHours(0,0,0,0);
    const diffDays=Math.round((dt-today)/86400000);
    const inPort=portfolio.some(p=>p.t===e.symbol);
    if(diffDays>=1&&diffDays<=3){
      const key=`earn_soon_${e.symbol}_${e.date}`;
      if(await hasCooldown(env,key)) continue;
      await setCooldown(env,key,24);
      const eps=e.epsEstimate!=null?`EPS คาด $${(+e.epsEstimate).toFixed(2)}`:'';
      const rev=e.revenueEstimate!=null?`| Rev คาด $${(e.revenueEstimate/1e9).toFixed(1)}B`:'';
      const when=e.hour==='bmo'?'ก่อนตลาดเปิด':e.hour==='amc'?'หลังตลาดปิด':'ระหว่างวัน';
      await sendTGAll(env,`📅 <b>Earnings Alert: ${e.symbol}</b>\n${inPort?'💼 อยู่ในพอร์ต\n':''}ประกาศผลใน <b>${diffDays} วัน</b> (${e.date})\n${eps} ${rev}\n⏰ ${when}`);
    }
    if(diffDays<=0&&e.epsActual!=null&&e.epsEstimate!=null){
      const key=`earn_result_${e.symbol}_${e.date}`;
      if(await hasCooldown(env,key)) continue;
      await setCooldown(env,key,48);
      const epsBeat=e.epsActual>=e.epsEstimate;
      const epsPct=e.epsEstimate!==0?((e.epsActual-e.epsEstimate)/Math.abs(e.epsEstimate)*100).toFixed(1):0;
      const revBeat=e.revenueActual!=null&&e.revenueEstimate!=null?e.revenueActual>=e.revenueEstimate:null;
      let result,emoji;
      if(epsBeat&&revBeat!==false){ result=`✅ Beat EPS${epsPct>0?` +${epsPct}%`:''}`; emoji='🟢'; }
      else if(!epsBeat&&revBeat===false){ result=`❌ Miss EPS ${epsPct}%`; emoji='🔴'; }
      else if(epsBeat){ result='⚠️ Beat EPS แต่ Miss Revenue'; emoji='🟡'; }
      else { result='⚠️ Miss EPS แต่ Beat Revenue'; emoji='🟡'; }
      const q=await getQuoteFromCache(e.symbol,env);
      const priceStr=q?`💰 $${q.price.toFixed(2)} (${q.change>=0?'+':''}${q.change.toFixed(2)}%)`:'';
      const revStr=revBeat!==null?`Rev ${revBeat?'Beat':'Miss'}: $${(e.revenueActual/1e9).toFixed(1)}B vs $${(e.revenueEstimate/1e9).toFixed(1)}B\n`:'';
      await sendTGAll(env,`${emoji} <b>Earnings Result: ${e.symbol}</b>\n${inPort?'💼 อยู่ในพอร์ต\n':''}${result}\nEPS จริง $${(+e.epsActual).toFixed(2)} vs คาด $${(+e.epsEstimate).toFixed(2)}\n${revStr}${priceStr}`);
    }
  }
}

async function runInsiderAlerts(env, stocks) {
  if(!stocks.length) return;
  const timeKey = `insider_check_${Math.floor(Date.now()/1800000)}`;
  if(await hasCooldown(env, timeKey)) return;
  await setCooldown(env, timeKey, 1);
  const finnhubKey = env.FINNHUB_KEY;
  if(!finnhubKey) return;
  const BATCH = 5;
  for(let i=0; i<stocks.length; i+=BATCH){
    const batch = stocks.slice(i, i+BATCH);
    await Promise.all(batch.map(async stk => {
      try{
        const r = await fetch(`https://finnhub.io/api/v1/stock/insider-transactions?symbol=${stk.t}&token=${finnhubKey}`,{signal: AbortSignal.timeout(6000)});
        if(!r.ok) return;
        const d = await r.json();
        const txns = (d?.data||[]).filter(t => {
          if(!t.transactionDate) return false;
          const age = (Date.now() - new Date(t.transactionDate).getTime()) / 86400000;
          if(age > 3) return false;
          const val = Math.abs((t.share||0) * (t.transactionPrice||0));
          return val >= 1000000;
        });
        if(!txns.length) return;
        const key = `insider_${stk.t}_${txns[0].transactionDate}`;
        if(await hasCooldown(env, key)) return;
        await setCooldown(env, key, 48);
        const buys = txns.filter(t => t.change > 0);
        const sells = txns.filter(t => t.change < 0);
        const fmtVal = v => v >= 1e9 ? `$${(v/1e9).toFixed(1)}B` : v >= 1e6 ? `$${(v/1e6).toFixed(1)}M` : `$${(v/1e3).toFixed(0)}K`;
        const fmtName = n => (n||'').split(' ').slice(0,2).join(' ');
        let msg = `🕵️ <b>Insider Trading Alert: ${stk.t}</b>\n`;
        if(buys.length){ buys.slice(0,3).forEach(t=>{ const val = Math.abs(t.share * t.transactionPrice); msg += `🟢 ${fmtName(t.name)} ซื้อ ${fmtVal(val)} (${t.transactionDate})\n`; }); }
        if(sells.length){ sells.slice(0,3).forEach(t=>{ const val = Math.abs(t.share * t.transactionPrice); msg += `🔴 ${fmtName(t.name)} ขาย ${fmtVal(val)} (${t.transactionDate})\n`; }); }
        msg += `\n📊 ซื้อ ${buys.length} / ขาย ${sells.length} รายการ (3 วันล่าสุด)\n⚠️ ใช้ประกอบการตัดสินใจเท่านั้น`;
        await sendTGAll(env, msg);
      }catch{}
    }));
    if(i+BATCH < stocks.length) await new Promise(r=>setTimeout(r,500));
  }
}

async function runSignalChecks(env){
  _mon.scanned=0; _mon.signals=0; _mon.exits=0;
  _mon.lastRun=new Date().toISOString();
  if(!isMarketHours()) return;
  let stocks=[], port=[], alerts=[], trail={};
  try{const r=await env.ALERT_KV.get('stocks');if(r){const s=JSON.parse(r);if(Array.isArray(s))stocks=s;}}catch{}
  try{port=JSON.parse(await env.ALERT_KV.get('portfolio')||'[]');}catch{}
  try{alerts=JSON.parse(await env.ALERT_KV.get('priceAlerts')||'[]');}catch{}
  try{trail=JSON.parse(await env.ALERT_KV.get('trailingHigh')||'{}');}catch{}
  if(!stocks.length && !port.length && !alerts.length) return;
  let quotes={};
  try{const r=await env.ALERT_KV.get('priceCache');if(r)quotes=JSON.parse(r).quotes||{};}catch{}
  const spyQ=quotes['SPY'],qqqQ=quotes['QQQ'];
  const marketWeak=(spyQ&&spyQ.change<=-2.5)||(qqqQ&&qqqQ.change<=-2.5);
  let alertsChanged=false;
  for(const a of alerts){
    if(a.triggered) continue;
    const q=quotes[a.ticker]; if(!q) continue;
    const hit=a.dir==='above'?q.price>=a.price:q.price<=a.price;
    if(!hit) continue;
    const key=`pa_${a.ticker}_${a.price}`;
    if(await hasCooldown(env,key)) continue;
    await setCooldown(env,key,24);
    a.triggered=true; alertsChanged=true;
    await sendTGAll(env,`🔔 <b>Price Alert: ${a.ticker}</b>\n${a.dir==='above'?'🔺':'🔻'} ราคาถึง $${q.price.toFixed(2)}\nเปลี่ยน ${q.change>=0?'+':''}${q.change.toFixed(2)}%`);
  }
  if(alertsChanged) await env.ALERT_KV.put('priceAlerts',JSON.stringify(alerts));
  await runInsiderAlerts(env, stocks);
  await runEarningsAlerts(env, stocks, port);
  if(isRegularHours()){
    const strongSignals=[],watchSignals=[];
    const CHUNK=15;
    let chunkIdx=0;
    try{ const raw=await env.ALERT_KV.get('sig_chunk_idx'); chunkIdx=raw?parseInt(raw):0; }catch{}
    const totalChunks=Math.ceil(stocks.length/CHUNK);
    chunkIdx=chunkIdx%totalChunks;
    try{ await env.ALERT_KV.put('sig_chunk_idx',String((chunkIdx+1)%totalChunks),{expirationTtl:3600}); }catch{}
    const chunk=stocks.slice(chunkIdx*CHUNK,(chunkIdx+1)*CHUNK);
    _mon.scanned+=chunk.length;
    await Promise.all(chunk.map(async stk=>{
      try{
        const q=quotes[stk.t]; if(!q||q.price<=0) return;
        const key=`buy_${stk.t}`; if(await hasCooldown(env,key)) return;
        const candles=await getCandles(stk.t,env,60); if(!candles) return;
        const result=calcBuyScore(stk.t,q.price,candles);
        if(!result) return;
        const pctFromS1=(q.price-result.s1)/result.s1*100;
        if(pctFromS1>1.5) return;
        if(result.rsi>=60) return;
        if(result.score<50) return;
        if(marketWeak&&result.score<55) return;
        await setCooldown(env,key,8);
        const item={t:stk.t,score:result.score,price:+q.price.toFixed(2),change:+q.change.toFixed(2),s1:+result.s1.toFixed(2),r1:+result.r1.toFixed(2),rsi:result.rsi,volRatio:+result.volRatio.toFixed(2),pullbackPct:+result.pullbackPct.toFixed(2),pctFromS1:+pctFromS1.toFixed(2),breakdown:result.breakdown,short:stk.short||0};
        _mon.signals++; if(result.score>=65) strongSignals.push(item); else watchSignals.push(item);
        await saveSignalLog(env, {ticker:stk.t,price:+q.price.toFixed(2),score:result.score,s1:+result.s1.toFixed(2),r1:+result.r1.toFixed(2),time:new Date().toISOString(),result:null,pct:null});
      }catch{}
    }));
    strongSignals.sort((a,b)=>b.score-a.score);
    watchSignals.sort((a,b)=>b.score-a.score);
    const allSignals=[...strongSignals,...watchSignals];
    if(allSignals.length>0){
      const timeStr=new Date().toLocaleString('th-TH',{timeZone:'Asia/Bangkok',hour:'2-digit',minute:'2-digit'});
      const now=new Date().toLocaleString('th-TH',{timeZone:'Asia/Bangkok',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});
      const digestKey='digest_sent';
      if(allSignals.length===1){
        const s=allSignals[0];
        await sendTGAll(env,`${s.score>=65?'🟢':'👀'} <b>${s.score>=65?'Buy Signal':'น่าจับตา'}: ${s.t}</b>\n🎯 Score: ${s.score}/100 <i>(${timeStr})</i>\n${s.breakdown.join(' | ')}\n\n💰 $${s.price} (${s.change>=0?'+':''}${s.change}%)\n📍 S1: $${s.s1} (ห่าง ${s.pctFromS1}%) | R1: $${s.r1}\n📊 RSI: ${s.rsi} | Vol: x${s.volRatio}${s.short>10?`\n⚠️ Short: ${s.short}%`:''}\n\n⚠️ Score คำนวณ ณ ${now}`);
      } else if(!(await hasCooldown(env,digestKey+'_check'))){
        await setCooldown(env,digestKey+'_check',6);
        let msg=`📊 <b>Signal Digest — ${timeStr}</b>\n${marketWeak?'⚠️ ตลาดอ่อน\n':''}\n`;
        if(strongSignals.length){msg+=`🟢 <b>Buy Signal (${strongSignals.length})</b>\n`;strongSignals.forEach(s=>{msg+=`• <b>${s.t}</b> $${s.price} Score <b>${s.score}</b> | RSI ${s.rsi}\n`;});msg+='\n';}
        if(watchSignals.length){msg+=`👀 <b>น่าจับตา (${watchSignals.length})</b>\n`;watchSignals.forEach(s=>{msg+=`• <b>${s.t}</b> $${s.price} Score <b>${s.score}</b>\n`;});}
        msg+=`\n⏱ ${now}\n⚠️ Score คำนวณจาก candle data ณ เวลานี้`;
        await sendTGAll(env,msg);
      }
    }
  }
  if(!port.length) return;
  const exitMessages=[];
  for(const pos of port){
    if(!pos.avgPrice||!pos.shares) continue;
    const shares = Math.round(pos.shares * 100) / 100;
    const q=quotes[pos.t]; if(!q) continue;
    const price=+q.price.toFixed(2), r1=+getR1(pos.t,price).toFixed(2);
    const avgP=+pos.avgPrice.toFixed(2);
    const pnlPct=+((price-avgP)/avgP*100).toFixed(2);
    if(!trail[pos.t]||price>trail[pos.t]) trail[pos.t]=price;
    const trailHigh=+trail[pos.t].toFixed(2)||avgP;
    const trailDrop=+((trailHigh-price)/trailHigh*100).toFixed(2);
    let exitReason='', sellPct=100;
    const key=`exit_${pos.t}`;
    if(price>=(r1*1.05)&&!(await hasCooldown(env,key))){exitReason=`🎯 ถึงเป้า R2! กำไร +${pnlPct}%`;await setCooldown(env,key,8);}
    else if(price>=r1&&!(await hasCooldown(env,key))){sellPct=50;exitReason=`🎯 ถึง R1 แนะนำขาย 50%`;await setCooldown(env,key,8);}
    else if(pnlPct<=-8&&!(await hasCooldown(env,key))){exitReason=`🔴 Cut Loss! ขาดทุน ${pnlPct}%`;await setCooldown(env,key,24);}
    else if(trailDrop>=10&&pnlPct>0&&!(await hasCooldown(env,key))){sellPct=50;exitReason=`📉 Trailing Stop ร่วง ${trailDrop}%`;await setCooldown(env,key,24);}
    if(exitReason){
      const sellShares = Math.ceil(shares * sellPct / 100);
      exitMessages.push(`<b>${pos.t}</b> — ${exitReason}\n📌 ขาย ${sellShares} หุ้น | $${price} (เข้า $${avgP}) | P&amp;L: ${pnlPct>=0?'+':''}${pnlPct}%`);
    }
  }
  _mon.exits+=exitMessages.length;
  if(exitMessages.length===1){ await sendTGAll(env,`🚨 <b>Exit Signal</b>\n\n${exitMessages[0]}`); }
  else if(exitMessages.length>1){
    const timeStr=new Date().toLocaleString('th-TH',{timeZone:'Asia/Bangkok',hour:'2-digit',minute:'2-digit'});
    await sendTGAll(env,`🚨 <b>Exit Signals — ${timeStr}</b>\n\n${exitMessages.join('\n\n')}`);
  }
  await env.ALERT_KV.put('trailingHigh',JSON.stringify(trail));
}

export default {
  async fetch(req, env){
    const url=new URL(req.url);
    const cors={'Access-Control-Allow-Origin':'*','Cache-Control':'no-store'};
    if(url.pathname==='/test-earnings'){
      try{
        let stocks=[], port=[];
        try{const r=await env.ALERT_KV.get('stocks');if(r){const s=JSON.parse(r);if(Array.isArray(s))stocks=s;}}catch{}
        try{port=JSON.parse(await env.ALERT_KV.get('portfolio')||'[]');}catch{}
        await runEarningsAlerts(env, stocks, port);
        return new Response(JSON.stringify({ok:true,message:'Earnings alert sent'}),{headers:{...cors,'Content-Type':'application/json'}});
      }catch(e){
        return new Response(JSON.stringify({ok:false,error:e.message}),{status:500,headers:{...cors,'Content-Type':'application/json'}});
      }
    }
    if(url.pathname==='/signals/log'){
      try{
        const raw = await env.ALERT_KV.get('signal_log');
        const log = raw ? JSON.parse(raw) : [];
        return new Response(JSON.stringify(log), {headers:{...cors,'Content-Type':'application/json'}});
      }catch(e){
        return new Response(JSON.stringify([]),{headers:{...cors,'Content-Type':'application/json'}});
      }
    }
    if(url.pathname==='/signals/save'){
      try{
        const body = await req.json();
        await saveSignalLog(env, body);
        return new Response(JSON.stringify({ok:true}),{headers:{...cors,'Content-Type':'application/json'}});
      }catch(e){
        return new Response(JSON.stringify({ok:false,error:e.message}),{status:500,headers:{...cors,'Content-Type':'application/json'}});
      }
    }
    if(url.pathname==='/stocks/add'){
      try{
        const t = validateTicker(url.searchParams.get('t'));
        if(!t) return new Response(JSON.stringify({ok:false,error:'invalid ticker'}),{status:400,headers:{...cors,'Content-Type':'application/json'}});
        const shortParam = parseFloat(url.searchParams.get('short')) || 0;
        let stocks=[];
        try{const r=await env.ALERT_KV.get('stocks');if(r){const s=JSON.parse(r);if(Array.isArray(s))stocks=s;}}catch{}
        if(stocks.some(s=>s.t===t)){
          return new Response(JSON.stringify({ok:true,message:`${t} already exists`,stocks}),{headers:{...cors,'Content-Type':'application/json'}});
        }
        stocks.push({t, short:shortParam});
        await env.ALERT_KV.put('stocks', JSON.stringify(stocks));
        return new Response(JSON.stringify({ok:true,message:`${t} added`,stocks}),{headers:{...cors,'Content-Type':'application/json'}});
      }catch(e){
        return new Response(JSON.stringify({ok:false,error:e.message}),{status:500,headers:{...cors,'Content-Type':'application/json'}});
      }
    }
    if(url.pathname==='/stocks/remove'){
      try{
        const t = validateTicker(url.searchParams.get('t'));
        if(!t) return new Response(JSON.stringify({ok:false,error:'invalid ticker'}),{status:400,headers:{...cors,'Content-Type':'application/json'}});
        let stocks=[];
        try{const r=await env.ALERT_KV.get('stocks');if(r){const s=JSON.parse(r);if(Array.isArray(s))stocks=s;}}catch{}
        const filtered = stocks.filter(s=>s.t!==t);
        await env.ALERT_KV.put('stocks', JSON.stringify(filtered));
        return new Response(JSON.stringify({ok:true,message:`${t} removed`,stocks:filtered}),{headers:{...cors,'Content-Type':'application/json'}});
      }catch(e){
        return new Response(JSON.stringify({ok:false,error:e.message}),{status:500,headers:{...cors,'Content-Type':'application/json'}});
      }
    }
    if(url.pathname==='/stocks/list'){
      try{
        let stocks=[];
        try{const r=await env.ALERT_KV.get('stocks');if(r){const s=JSON.parse(r);if(Array.isArray(s))stocks=s;}}catch{}
        return new Response(JSON.stringify({stocks}),{headers:{...cors,'Content-Type':'application/json'}});
      }catch(e){
        return new Response(JSON.stringify({stocks:[],error:e.message}),{status:500,headers:{...cors,'Content-Type':'application/json'}});
      }
    }
    if(url.pathname==='/health'){
      try{
        const chunkRaw=await env.ALERT_KV.get('sig_chunk_idx').catch(()=>null);
        const sigLogRaw=await env.ALERT_KV.get('signal_log').catch(()=>null);
        const sigCount=sigLogRaw?JSON.parse(sigLogRaw).length:0;
        return new Response(JSON.stringify({status:'ok',lastRun:_mon.lastRun,signals:{total:sigCount,session:_mon.signals},exits:_mon.exits,chunk:chunkRaw?parseInt(chunkRaw):0,errors:_mon.errors.slice(-5),ts:new Date().toISOString()}),{headers:{...cors,'Content-Type':'application/json'}});
      }catch(e){
        return new Response(JSON.stringify({status:'error',error:e.message}),{status:500,headers:{...cors,'Content-Type':'application/json'}});
      }
    }
    return new Response('STOCK PRO — Signals Worker OK',{headers:cors});
  },
  async scheduled(event, env, ctx){
    if(event.cron==='*/5 * * * *') ctx.waitUntil(runSignalChecks(env));
  }
};
