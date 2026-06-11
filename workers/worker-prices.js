// ============================================================
//  STOCK PRO -- Worker 1: Price Cache
//  ชื่อ: stock-prices
//  หน้าที่: ดึงราคาหุ้นทุกตัว + เก็บใน priceCache ทุก 1 นาที
//  Cron: */1 * * * *
//  KV Binding: ALERT_KV
//  ENV: FINNHUB_KEY, FINNHUB_KEY_2, FINNHUB_KEY_3
//       POLYGON_KEY, POLYGON_KEY_2, POLYGON_KEY_3
//       GOLD_API_KEY (optional)
// ============================================================

// Small cap tickers that need special handling
const SMALL_CAP_TICKERS = new Set(['OSS','AEHR','SNDK','AVAV','AMBA','ONDS','FPS','STX','NOK','SLNH','CBRS']);

// [FIX #1] ย้าย SPY/QQQ/SMH/VIX ขึ้นต้น array -- chunk 0 จะดึงเสมอ
const FALLBACK_TICKERS = [
  'SPY','QQQ','SMH','VIX',
  'NVDA','AAPL','MSFT','META','AMZN','GOOGL','TSLA','AMD','AVGO','ARM',
  'RKLB','EOSE','SLNH','MU','NVTS','ASTS','INTC','HIMS','IREN',
  'ASML','CRWD','IONQ','KTOS','RBRK','AAOI','HOOD',
  'OKLO','TEM','NVO','PLTR','CRDO','ANET','VRT',
  'TSM','ISRG','NFLX','JPM','XOM','SOFI','SPGI','MP',
  'ELF','AMSC','APP','COST','UNH','BRK.B','NOW','LLY','NBIS','AXON',
  'TMDX','CRWV','MELI','QCOM','AMAT','LRCX','CRM','ADBE','SNOW','DDOG',
  'MDB','NET','V','MA','WMT','FPS','NOK','DELL','ONDS',
  'OSS','AEHR','SNDK','AVAV','STX','VST','AMBA',
  'CBRS','PANW','MRVL',
];


// ── Structured Logger (Error Logging #2) ──
const LOG = {
  info:  (msg, data={}) => console.log(JSON.stringify({ level:'info',  msg, ...data, ts: Date.now() })),
  warn:  (msg, data={}) => console.warn(JSON.stringify({ level:'warn',  msg, ...data, ts: Date.now() })),
  error: (msg, data={}) => console.error(JSON.stringify({ level:'error', msg, ...data, ts: Date.now() })),
};

// ── Monitoring Counters (Monitoring #4) ──
const _mon = { finnhubHit:0, finnhubMiss:0, yahooHit:0, yahooMiss:0, vixOk:false, errors:[] };
function monSnapshot() {
  return {
    finnhub: { hit: _mon.finnhubHit, miss: _mon.finnhubMiss,
      rate: _mon.finnhubHit+_mon.finnhubMiss > 0
        ? Math.round(_mon.finnhubHit/(_mon.finnhubHit+_mon.finnhubMiss)*100)+'%' : 'n/a' },
    yahoo:   { hit: _mon.yahooHit,   miss: _mon.yahooMiss,
      rate: _mon.yahooHit+_mon.yahooMiss > 0
        ? Math.round(_mon.yahooHit/(_mon.yahooHit+_mon.yahooMiss)*100)+'%' : 'n/a' },
    vix: _mon.vixOk,
    errors: _mon.errors.slice(-5),
  };
}

// ── Security: Input Validator (Security #6) ──
function validateTicker(t) {
  if (!t || typeof t !== 'string') return null;
  const clean = t.toUpperCase().replace(/[^A-Z0-9.\-]/g, '').slice(0, 10);
  return clean.length >= 1 ? clean : null;
}
function isInternalRequest(req) {
  const auth = req.headers.get('x-worker-secret') || '';
  return auth === 'stockpro_internal_2026';
}

// [FIX #2] KV binding guard -- ตรวจก่อนใช้ทุกครั้ง
function assertKV(env) {
  if (!env.ALERT_KV) {
    throw new Error('ALERT_KV binding missing -- add KV Namespace Binding in Worker Settings');
  }
}

function getFinnhubKeys(env) {
  return [env.FINNHUB_KEY, env.FINNHUB_KEY_2, env.FINNHUB_KEY_3].filter(Boolean);
}

function getPolygonKeys(env) {
  return [env.POLYGON_KEY, env.POLYGON_KEY_2, env.POLYGON_KEY_3].filter(Boolean);
}

async function getQuoteFinnhub(ticker, keys) {
  const symbol = ticker === 'VIX' ? 'CBOE:VIX' : ticker;
  for (const key of keys) {
    try {
      const r = await fetch(
        `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${key}`,
        { signal: AbortSignal.timeout(4000) }
      );
      if (r.status === 429) { LOG.warn('Finnhub 429', { ticker }); continue; }
      if (!r.ok) { LOG.warn('Finnhub error', { ticker, status: r.status }); continue; }
      const d = await r.json();
      if (d && d.c > 0) { _mon.finnhubHit++; return { price: d.c, change: d.dp || 0 }; }
    } catch(e) { LOG.warn('Finnhub fetch failed', { ticker, err: e.message }); }
  }
  _mon.finnhubMiss++;
  return null;
}

// [FIX] Yahoo batch: ดึงหลายตัวในคำขอเดียว ผ่าน proxy chain
const YAHOO_PROXY_CHAIN = [
  sym => `https://yahoo-proxy.datsakonping1994.workers.dev/?url=${encodeURIComponent('https://query1.finance.yahoo.com/v7/finance/quote?symbols='+sym)}`,
  sym => `https://anthropic-proxy.datsakonping1994.workers.dev/yahoo/?url=${encodeURIComponent('https://query1.finance.yahoo.com/v7/finance/quote?symbols='+sym)}`,
  sym => `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${sym}`,
  sym => `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${sym}`,
];

function parseYahooQuoteResponse(text) {
  try {
    let d = JSON.parse(text);
    if (d?.contents) d = JSON.parse(d.contents);
    const list = d?.quoteResponse?.result || [];
    const out = {};
    for (const res of list) {
      if (res.regularMarketPrice > 0) {
        let ticker = res.symbol.replace('-', '.').replace('^VIX', 'VIX');
        out[ticker] = {
          price: res.regularMarketPrice,
          change: parseFloat((res.regularMarketChangePercent || 0).toFixed(2))
        };
      }
    }
    return out;
  } catch { return null; }
}

async function getQuoteYahooBatch(tickers) {
  if (!tickers.length) return {};
  const results = {};
  const BATCH = 20;

  for (let i = 0; i < tickers.length; i += BATCH) {
    const chunk = tickers.slice(i, i + BATCH);
    const symbols = chunk.map(t => {
      if (t === 'VIX') return '%5EVIX';
      return t.replace('.', '-');
    }).join(',');

    let fetched = false;
    for (const mkUrl of YAHOO_PROXY_CHAIN) {
      try {
        const r = await fetch(mkUrl(symbols), {
          headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
          signal: AbortSignal.timeout(7000)
        });
        if (!r.ok) continue;
        const text = await r.text();
        const parsed = parseYahooQuoteResponse(text);
        if (parsed && Object.keys(parsed).length > 0) {
          Object.assign(results, parsed);
          fetched = true;
          break;
        }
      } catch {}
    }
    if (!fetched) {
      _mon.yahooMiss += chunk.length;
      LOG.warn('Yahoo batch failed all proxies', { from: i, to: i+BATCH, tickers: chunk });
      const smallCaps = chunk.filter(t => SMALL_CAP_TICKERS.has(t));
      for (const t of smallCaps) {
        try {
          const yhT = t.replace('.', '-');
          const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yhT}?interval=1d&range=2d`;
          const r = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' },
            signal: AbortSignal.timeout(5000)
          });
          if (r.ok) {
            const d = await r.json();
            const meta = d?.chart?.result?.[0]?.meta;
            if (meta && meta.regularMarketPrice > 0) {
              const prev = meta.regularMarketPreviousClose || meta.chartPreviousClose || meta.regularMarketPrice;
              results[t] = {
                price: meta.regularMarketPrice,
                change: parseFloat(((meta.regularMarketPrice - prev) / prev * 100).toFixed(2))
              };
              LOG.info('small cap fallback ok', { ticker: t, price: meta.regularMarketPrice });
            }
          }
        } catch(e) { LOG.warn('small cap fallback failed', { ticker: t, err: e.message }); }
      }
    }

    if (i + BATCH < tickers.length) {
      await new Promise(r => setTimeout(r, 200));
    }
  }
  return results;
}

async function getQuote(ticker, finnhubKeys) {
  return await getQuoteFinnhub(ticker, finnhubKeys);
}

async function getCandlesPolygon(ticker, from, to, keys) {
  const sym = ticker.replace('.', '-');
  for (const key of keys) {
    try {
      const url = `https://api.polygon.io/v2/aggs/ticker/${sym}/range/1/day/${from}/${to}?adjusted=true&sort=asc&limit=120&apiKey=${key}`;
      const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (r.status === 429) continue;
      if (!r.ok) continue;
      const d = await r.json();
      if (d?.results?.length > 0) return d.results;
    } catch {}
  }
  return null;
}

async function getGoldPrice(env) {
  const key = env.GOLD_API_KEY;
  if (!key) return null;
  try {
    const r = await fetch('https://www.goldapi.io/api/XAU/USD', {
      headers: { 'x-access-token': key },
      signal: AbortSignal.timeout(6000)
    });
    const d = await r.json();
    if (r.ok && d?.price > 0) return { price: d.price, change: d.ch || 0 };
  } catch {}
  return null;
}

const CHUNK_SIZE = 20;
const CHUNK_KEY = 'price_chunk_idx';

async function refreshPriceCache(env) {
  assertKV(env);

  let tickers = [...FALLBACK_TICKERS];
  try {
    const raw = await env.ALERT_KV.get('stocks');
    if (raw) {
      const saved = JSON.parse(raw);
      if (Array.isArray(saved) && saved.length > 0) {
        const fromApp = saved.map(s => s.t).filter(Boolean);
        // [FIX] ให้ priority tickers อยู่ต้นเสมอ แม้ merge กับ user stocks
        const PRIORITY = ['SPY','QQQ','SMH','VIX'];
        const rest = [...new Set([...fromApp, ...FALLBACK_TICKERS])].filter(t => !PRIORITY.includes(t));
        tickers = [...PRIORITY, ...rest];
      }
    }
  } catch (e) {
    console.warn('[refreshPriceCache] failed to load stocks from KV:', e.message);
  }

  const finnhubKeys = getFinnhubKeys(env);
  if (finnhubKeys.length === 0) {
    console.error('[refreshPriceCache] FINNHUB_KEY not set -- skipping refresh');
    return;
  }

  let chunkIdx = 0;
  try {
    const raw = await env.ALERT_KV.get(CHUNK_KEY);
    chunkIdx = raw ? parseInt(raw) : 0;
  } catch {}
  const totalChunks = Math.ceil(tickers.length / CHUNK_SIZE);
  chunkIdx = chunkIdx % totalChunks;
  const nextIdx = (chunkIdx + 1) % totalChunks;
  try { await env.ALERT_KV.put(CHUNK_KEY, String(nextIdx), { expirationTtl: 3600 }); } catch {}

  const chunkTickers = tickers.slice(chunkIdx * CHUNK_SIZE, (chunkIdx + 1) * CHUNK_SIZE);
  LOG.info('chunk start', { chunk: chunkIdx+1, total: totalChunks, tickers: chunkTickers.length });

  const newQuotes = {};

  // Phase 1: Finnhub (parallel ทั้ง chunk)
  await Promise.allSettled(
    chunkTickers.map(async t => {
      const q = await getQuoteFinnhub(t, finnhubKeys);
      if (q) newQuotes[t] = q;
    })
  );

  // Phase 2: Yahoo batch สำหรับตัวที่ Finnhub ไม่มี
  const missing = chunkTickers.filter(t => !newQuotes[t]);
  if (missing.length > 0) {
    const yahooResults = await getQuoteYahooBatch(missing);
    Object.assign(newQuotes, yahooResults);
  }

  // Gold (เฉพาะ chunk แรก)
  if (chunkIdx === 0) {
    try {
      const gold = await getGoldPrice(env);
      if (gold) newQuotes['XAU'] = gold;
    } catch {}
  }

  // VIX fetch แยก -- proxy chain
  if (chunkIdx === 0) {
    const VIX_URLS = [
      `https://yahoo-proxy.datsakonping1994.workers.dev/?url=${encodeURIComponent('https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?interval=1d&range=1d')}`,
      'https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?interval=1d&range=1d',
      'https://query2.finance.yahoo.com/v8/finance/chart/%5EVIX?interval=1d&range=1d',
    ];
    let vixFetched = false;
    for (const vixUrl of VIX_URLS) {
      try {
        const vr = await fetch(vixUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
          signal: AbortSignal.timeout(7000)
        });
        if (!vr.ok) continue;
        let vd = await vr.json();
        if (vd?.contents) vd = JSON.parse(vd.contents);
        const meta = vd?.chart?.result?.[0]?.meta;
        if (meta && meta.regularMarketPrice > 0) {
          const prev = meta.chartPreviousClose || meta.previousClose || meta.regularMarketPrice;
          const chg = prev > 0 ? (meta.regularMarketPrice - prev) / prev * 100 : 0;
          newQuotes['VIX'] = {
            price: parseFloat(meta.regularMarketPrice.toFixed(2)),
            change: parseFloat(chg.toFixed(2))
          };
          LOG.info('VIX updated', { price: newQuotes['VIX'].price });
          vixFetched = true;
          break;
        }
      } catch(e) { LOG.warn('VIX proxy failed', { url: vixUrl.slice(0,50), err: e.message }); }
    }
    if (!vixFetched) LOG.error('VIX all proxies failed', {});
  }

  if (Object.keys(newQuotes).length === 0) return;

  // Merge กับ cache เดิม
  let existingQuotes = {};
  try {
    const raw = await env.ALERT_KV.get('priceCache');
    if (raw) {
      const prev = JSON.parse(raw);
      existingQuotes = prev.quotes || {};
    }
  } catch {}

  const merged = { ...existingQuotes, ...newQuotes };
  const cache = { quotes: merged, ts: Date.now() };
  await env.ALERT_KV.put('priceCache', JSON.stringify(cache), { expirationTtl: 300 });

  // อัป marketCache ด้วย
  const mkt = {};
  for (const s of ['SPY', 'QQQ', 'VIX', 'SMH']) {
    if (merged[s]) mkt[s] = merged[s];
  }
  if (Object.keys(mkt).length > 0) {
    await env.ALERT_KV.put('marketCache', JSON.stringify({ quotes: mkt, ts: Date.now() }), { expirationTtl: 300 });
  }
  LOG.info('chunk done', { chunk: chunkIdx+1, total: totalChunks, updated: Object.keys(newQuotes).length, cacheSize: Object.keys(merged).length, mon: monSnapshot() });
}

function daysToFromTo(days) {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - Math.ceil(days * 1.5));
  const fmt = d => d.toISOString().slice(0, 10);
  return { from: fmt(from), to: fmt(to) };
}

// ── Yahoo incomeStatementHistoryQuarterly helper (ใช้ฝั่ง Worker เพื่อหลีกเลี่ยง CORS)
// คืน { revGrowth, revLatestQ } -- revLatestQ = totalRevenue ของไตรมาสล่าสุด (raw, USD)
async function getRevenueFromYahoo(ticker) {
  let revGrowth = null, revLatestQ = null;
  try {
    const yhTicker = ticker.replace('.', '-');
    const yr = await fetch(
      `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${yhTicker}?modules=incomeStatementHistoryQuarterly`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (yr.ok) {
      const yd = await yr.json();
      const qtrs = yd?.quoteSummary?.result?.[0]?.incomeStatementHistoryQuarterly?.incomeStatementHistory || [];
      const r0 = qtrs[0]?.totalRevenue?.raw;
      const r4 = qtrs[4]?.totalRevenue?.raw;
      if (r0 != null && isFinite(r0)) revLatestQ = r0;
      if (r0 != null && r4 != null && r4 !== 0 && isFinite(r0) && isFinite(r4)) {
        const yoy = (r0 - r4) / Math.abs(r4) * 100;
        if (isFinite(yoy) && yoy >= -100 && yoy <= 5000) {
          revGrowth = r4 < 0 ? null : +(yoy.toFixed(1));
        }
      }
    }
  } catch {}
  return { revGrowth, revLatestQ };
}

export default {
  async fetch(req, env, ctx) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Cache-Control': 'no-store'
    };

    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });

    // [FIX #2] ตรวจ KV binding ก่อนทุก request
    if (!env.ALERT_KV) {
      return new Response(JSON.stringify({
        status: 'error',
        error: 'ALERT_KV binding missing',
        fix: 'Go to Cloudflare Dashboard → Workers → stock-prices → Settings → Variables → KV Namespace Bindings → Add binding: Variable=ALERT_KV'
      }), { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    const url = new URL(req.url);

    if (url.pathname === '/prices') {
      try {
        const raw = await env.ALERT_KV.get('priceCache');
        if (raw) {
          const cache = JSON.parse(raw);
          const age = Math.floor((Date.now() - cache.ts) / 1000);
          if (age > 600) {
            console.warn('[/prices] stale cache', age, 's -- triggering background refresh');
            ctx.waitUntil(refreshPriceCache(env).catch(e => console.error('[bg refresh]', e.message)));
          }
          return new Response(
            JSON.stringify({ ok: true, quotes: cache.quotes, age, count: Object.keys(cache.quotes).length, stale: age > 600 }),
            { headers: { ...cors, 'Content-Type': 'application/json' } }
          );
        }
        console.warn('[/prices] cache empty -- triggering refresh');
        ctx.waitUntil(refreshPriceCache(env).catch(e => console.error('[bg refresh]', e.message)));
        await new Promise(r => setTimeout(r, 2000));
        const raw2 = await env.ALERT_KV.get('priceCache');
        if (raw2) {
          const cache2 = JSON.parse(raw2);
          return new Response(
            JSON.stringify({ ok: true, quotes: cache2.quotes, age: 0, count: Object.keys(cache2.quotes).length }),
            { headers: { ...cors, 'Content-Type': 'application/json' } }
          );
        }
        return new Response(
          JSON.stringify({ ok: false, error: 'cache_warming', message: 'Refreshing prices, retry in 10 seconds.' }),
          { status: 202, headers: { ...cors, 'Content-Type': 'application/json' } }
        );
      } catch (e) {
        console.error('[/prices] KV error:', e.message, e.stack || '');
        return new Response(
          JSON.stringify({ ok: false, error: e.message }),
          { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } }
        );
      }
    }

    if (url.pathname === '/price') {
      const ticker = validateTicker(url.searchParams.get('t'));
      if (!ticker) return new Response(JSON.stringify({ ok: false, error: 'invalid ticker' }), { status: 400, headers: cors });
      try {
        const raw = await env.ALERT_KV.get('priceCache');
        if (raw) {
          const cache = JSON.parse(raw);
          if (cache.quotes[ticker]) {
            return new Response(
              JSON.stringify({ ok: true, ...cache.quotes[ticker] }),
              { headers: { ...cors, 'Content-Type': 'application/json' } }
            );
          }
        }
        const q = await getQuote(ticker, getFinnhubKeys(env));
        if (q) return new Response(JSON.stringify({ ok: true, ...q }), { headers: { ...cors, 'Content-Type': 'application/json' } });
        return new Response(JSON.stringify({ ok: false, error: 'not found' }), { status: 404, headers: cors });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: cors });
      }
    }

    if (url.pathname === '/candles') {
      const ticker = url.searchParams.get('t')?.toUpperCase();
      if (!ticker) {
        return new Response(JSON.stringify({ ok: false, error: 'missing ticker' }), { status: 400, headers: cors });
      }
      let from = url.searchParams.get('from');
      let to = url.searchParams.get('to');
      const days = parseInt(url.searchParams.get('days') || '0');
      if (days > 0 && (!from || !to)) {
        const range = daysToFromTo(days);
        from = range.from;
        to = range.to;
      }
      if (!from || !to) {
        return new Response(JSON.stringify({ ok: false, error: 'missing from/to or days' }), { status: 400, headers: cors });
      }
      const kvKey = `candle_${ticker}_${from}_${to}`;
      try {
        const cached = await env.ALERT_KV.get(kvKey);
        if (cached) {
          const data = JSON.parse(cached);
          return new Response(JSON.stringify({ ok: true, results: data, cached: true }), {
            headers: { ...cors, 'Content-Type': 'application/json' }
          });
        }
      } catch {}
      try {
        const polygonKeys = getPolygonKeys(env);
        if (polygonKeys.length === 0) {
          return new Response(JSON.stringify({ ok: false, error: 'POLYGON_KEY not set' }), { status: 500, headers: cors });
        }
        const results = await getCandlesPolygon(ticker, from, to, polygonKeys);
        if (results) {
          try { await env.ALERT_KV.put(kvKey, JSON.stringify(results), { expirationTtl: 21600 }); } catch {}
          return new Response(JSON.stringify({ ok: true, results }), {
            headers: { ...cors, 'Content-Type': 'application/json' }
          });
        }
        return new Response(JSON.stringify({ ok: false, error: 'no data' }), { status: 404, headers: cors });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: cors });
      }
    }

    if (url.pathname === '/earnings/clear') {
      try {
        const list = await env.ALERT_KV.list({ prefix: 'earnings_v2_' });
        let cleared = 0;
        for (const key of list.keys) { await env.ALERT_KV.delete(key.name); cleared++; }
        const list2 = await env.ALERT_KV.list({ prefix: 'stock_earnings_' });
        for (const key of list2.keys) { await env.ALERT_KV.delete(key.name); cleared++; }
        return new Response(JSON.stringify({ ok: true, cleared }), { headers: { ...cors, 'Content-Type': 'application/json' } });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: cors });
      }
    }

    if (url.pathname === '/earnings') {
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      const force = url.searchParams.get('force') === '1';
      if (!from || !to) {
        return new Response(JSON.stringify({ ok: false, error: 'missing from/to' }), { status: 400, headers: cors });
      }
      const kvKey = `earnings_v2_${from}_${to}`;
      if (!force) {
        try {
          const cached = await env.ALERT_KV.get(kvKey);
          if (cached) {
            const data = JSON.parse(cached);
            return new Response(JSON.stringify({ ok: true, items: data, cached: true }), {
              headers: { ...cors, 'Content-Type': 'application/json' }
            });
          }
        } catch {}
      }
      let items = [];
      const finnhubKeys = getFinnhubKeys(env);
      for (const key of finnhubKeys) {
        try {
          const r = await fetch(
            `https://finnhub.io/api/v1/calendar/earnings?from=${from}&to=${to}&token=${key}`,
            { signal: AbortSignal.timeout(8000) }
          );
          if (r.status === 429) continue;
          if (!r.ok) continue;
          const d = await r.json();
          if ((d?.earningsCalendar||[]).length > 0) { items = d.earningsCalendar; break; }
        } catch {}
      }
      let allTickers = [];
      try {
        const raw = await env.ALERT_KV.get('stocks');
        if (raw) allTickers = JSON.parse(raw).map(s => s.t);
      } catch {}
      const needYahoo = allTickers.filter(t => {
        const existing = items.find(e => e.symbol === t);
        return !existing || (existing.epsActual == null);
      }).slice(0, 20);
      if (needYahoo.length > 0) {
        const yahooResults = await Promise.allSettled(needYahoo.map(async ticker => {
          try {
            const yh = ticker.replace('.', '-');
            const [calR, earnR] = await Promise.allSettled([
              fetch(`https://query1.finance.yahoo.com/v10/finance/quoteSummary/${yh}?modules=calendarEvents`,
                { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(4000) }),
              fetch(`https://query1.finance.yahoo.com/v10/finance/quoteSummary/${yh}?modules=earnings`,
                { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(4000) })
            ]);
            let dateStr = null, epsEstimate = null, epsActual = null, revActual = null, revEstimate = null;
            if (calR.status === 'fulfilled' && calR.value.ok) {
              const d = await calR.value.json();
              const cal = d?.quoteSummary?.result?.[0]?.calendarEvents?.earnings;
              if (cal?.earningsDate?.[0]) {
                const ts = cal.earningsDate[0].raw * 1000;
                dateStr = new Date(ts).toISOString().slice(0, 10);
                epsEstimate = cal.epsEstimate?.raw || null;
              }
            }
            if (earnR.status === 'fulfilled' && earnR.value.ok) {
              const d = await earnR.value.json();
              const hist = d?.quoteSummary?.result?.[0]?.earnings?.earningsChart?.quarterly;
              if (hist?.length > 0) {
                const latest = hist[hist.length - 1];
                epsActual = latest.actual?.raw || null;
                if (!epsEstimate) epsEstimate = latest.estimate?.raw || null;
              }
            }
            if (!dateStr && !epsActual) return null;
            if (dateStr && (dateStr < from || dateStr > to)) {
              if (!epsActual) return null;
            }
            return { symbol: ticker, date: dateStr || null, epsEstimate, epsActual, revenueEstimate: revEstimate, revenueActual: revActual, hour: 'amc', _source: 'yahoo' };
          } catch { return null; }
        }));
        const yahooItems = yahooResults.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value);
        for (const yItem of yahooItems) {
          const existing = items.findIndex(e => e.symbol === yItem.symbol);
          if (existing >= 0) {
            if (yItem.epsActual != null && items[existing].epsActual == null) items[existing].epsActual = yItem.epsActual;
            if (yItem.date && !items[existing].date) items[existing].date = yItem.date;
          } else if (yItem.date) {
            items.push(yItem);
          }
        }
        console.log(`[Yahoo] processed ${yahooItems.length} tickers`);
      }
      if (items.length > 0) {
        try { await env.ALERT_KV.put(kvKey, JSON.stringify(items), { expirationTtl: 21600 }); } catch {}
        return new Response(JSON.stringify({ ok: true, items, cached: false }), {
          headers: { ...cors, 'Content-Type': 'application/json' }
        });
      }
      return new Response(JSON.stringify({ ok: false, error: 'no data' }), { status: 404, headers: cors });
    }

    if (url.pathname === '/stock/earnings') {
      const ticker = validateTicker(url.searchParams.get('t'));
      if (!ticker) return new Response(JSON.stringify({ ok: false, error: 'invalid ticker' }), { status: 400, headers: cors });
      const kvKey = `stock_earnings_${ticker}`;
      try {
        const cached = await env.ALERT_KV.get(kvKey);
        if (cached) return new Response(JSON.stringify({ ok: true, data: JSON.parse(cached), cached: true }), { headers: { ...cors, 'Content-Type': 'application/json' } });
      } catch {}
      const finnhubKeys = getFinnhubKeys(env);
      for (const key of finnhubKeys) {
        try {
          const r = await fetch(`https://finnhub.io/api/v1/stock/earnings?symbol=${ticker}&token=${key}`, { signal: AbortSignal.timeout(6000) });
          if (!r.ok) continue;
          const data = await r.json();
          if (data?.length > 0) {
            try { await env.ALERT_KV.put(kvKey, JSON.stringify(data), { expirationTtl: 7200 }); } catch {}
            return new Response(JSON.stringify({ ok: true, data }), { headers: { ...cors, 'Content-Type': 'application/json' } });
          }
        } catch {}
      }
      return new Response(JSON.stringify({ ok: false, error: 'no data' }), { status: 404, headers: cors });
    }

    if (url.pathname === '/calendar/economic') {
      const kvKey = `econ_calendar_ff_v4`;
      try {
        const cached = await env.ALERT_KV.get(kvKey);
        if (cached) return new Response(cached, { headers: { ...cors, 'Content-Type': 'application/json' } });
      } catch {}

      let allEvents = [];
      for (const suffix of ['thisweek','nextweek']) {
        try {
          const r = await fetch(`https://nfs.faireconomy.media/ff_calendar_${suffix}.json`, { signal: AbortSignal.timeout(6000) });
          if (!r.ok) continue;
          const data = await r.json();
          if (Array.isArray(data)) {
            const filtered = data.filter(ev => ev.impact === 'High' && ev.country === 'USD');
            allEvents = allEvents.concat(filtered.map(ev => ({
              event: ev.title,
              date: new Date(ev.date).toISOString().slice(0,10),
              time: new Date(ev.date).toLocaleTimeString('en-US',{hour12:false,hour:'2-digit',minute:'2-digit',timeZone:'America/New_York'}),
              impact: 'high',
              country: 'US',
              forecast: ev.forecast || '',
              previous: ev.previous || '',
            })));
          }
        } catch {}
      }

      if (allEvents.length > 0) {
        const payload = JSON.stringify({ economicCalendar: allEvents });
        try { await env.ALERT_KV.put(kvKey, payload, { expirationTtl: 3600 }); } catch {}
        return new Response(payload, { headers: { ...cors, 'Content-Type': 'application/json' } });
      }

      // Fallback: Finnhub
      const from = new Date().toISOString().slice(0,10);
      const to = new Date(Date.now()+90*24*60*60*1000).toISOString().slice(0,10);
      const finnhubKeys = getFinnhubKeys(env);
      for (const key of finnhubKeys) {
        try {
          const r = await fetch(`https://finnhub.io/api/v1/calendar/economic?from=${from}&to=${to}&token=${key}`, { signal: AbortSignal.timeout(8000) });
          if (!r.ok) continue;
          const data = await r.text();
          return new Response(data, { headers: { ...cors, 'Content-Type': 'application/json' } });
        } catch {}
      }
      return new Response(JSON.stringify({ ok: false, economicCalendar: [] }), { status: 404, headers: cors });
    }

    if (url.pathname === '/stock/peers') {
      const ticker = validateTicker(url.searchParams.get('t'));
      if (!ticker) return new Response(JSON.stringify({ ok: false }), { status: 400, headers: cors });
      const kvKey = `peers_${ticker}`;
      try {
        const cached = await env.ALERT_KV.get(kvKey);
        if (cached) return new Response(JSON.stringify({ ok: true, peers: JSON.parse(cached), cached: true }), { headers: { ...cors, 'Content-Type': 'application/json' } });
      } catch {}
      const finnhubKeys = getFinnhubKeys(env);
      for (const key of finnhubKeys) {
        try {
          const r = await fetch(`https://finnhub.io/api/v1/stock/peers?symbol=${ticker}&grouping=subIndustry&token=${key}`, { signal: AbortSignal.timeout(6000) });
          if (!r.ok) continue;
          const peers = await r.json();
          if (Array.isArray(peers) && peers.length > 0) {
            const filtered = peers.filter(p => p !== ticker).slice(0, 5);
            try { await env.ALERT_KV.put(kvKey, JSON.stringify(filtered), { expirationTtl: 86400 * 7 }); } catch {}
            return new Response(JSON.stringify({ ok: true, peers: filtered }), { headers: { ...cors, 'Content-Type': 'application/json' } });
          }
        } catch {}
      }
      return new Response(JSON.stringify({ ok: false, peers: [] }), { status: 404, headers: cors });
    }

    if (url.pathname === '/stock/profile') {
      const ticker = validateTicker(url.searchParams.get('t'));
      if (!ticker) return new Response(JSON.stringify({ ok: false }), { status: 400, headers: cors });
      const kvKey = `profile_${ticker}`;
      try {
        const cached = await env.ALERT_KV.get(kvKey);
        if (cached) return new Response(JSON.stringify({ ok: true, ...JSON.parse(cached), cached: true }), { headers: { ...cors, 'Content-Type': 'application/json' } });
      } catch {}
      const finnhubKeys = getFinnhubKeys(env);
      for (const key of finnhubKeys) {
        try {
          const r = await fetch(`https://finnhub.io/api/v1/stock/profile2?symbol=${ticker}&token=${key}`, { signal: AbortSignal.timeout(6000) });
          if (!r.ok) continue;
          const d = await r.json();
          if (d?.name) {
            const result = {
              name: d.name || null,
              industry: d.finnhubIndustry || d.industry || null,
              sector: d.sector || null,
              country: d.country || null,
              exchange: d.exchange || null,
              logo: d.logo || null,
              webUrl: d.weburl || null,
              mktcap: d.marketCapitalization || null,
              shareOutstanding: d.shareOutstanding || null,
            };
            try { await env.ALERT_KV.put(kvKey, JSON.stringify(result), { expirationTtl: 86400 * 7 }); } catch {}
            return new Response(JSON.stringify({ ok: true, ...result }), { headers: { ...cors, 'Content-Type': 'application/json' } });
          }
        } catch {}
      }
      return new Response(JSON.stringify({ ok: false }), { status: 404, headers: cors });
    }

    if (url.pathname === '/stock/target') {
      const ticker = validateTicker(url.searchParams.get('t'));
      if (!ticker) return new Response(JSON.stringify({ ok: false }), { status: 400, headers: cors });
      const kvKey = `target_${ticker}`;
      try {
        const cached = await env.ALERT_KV.get(kvKey);
        if (cached) return new Response(JSON.stringify({ ok: true, ...JSON.parse(cached), cached: true }), { headers: { ...cors, 'Content-Type': 'application/json' } });
      } catch {}
      const finnhubKeys = getFinnhubKeys(env);
      for (const key of finnhubKeys) {
        try {
          const [tgtRes, earnRes] = await Promise.all([
            fetch(`https://finnhub.io/api/v1/stock/price-target?symbol=${ticker}&token=${key}`, { signal: AbortSignal.timeout(6000) }),
            fetch(`https://finnhub.io/api/v1/stock/earnings?symbol=${ticker}&token=${key}`, { signal: AbortSignal.timeout(6000) }),
          ]);
          const tgtData = tgtRes.ok ? await tgtRes.json() : {};
          const earnData = earnRes.ok ? await earnRes.json() : [];
          const result = {
            target: tgtData?.targetMean || tgtData?.targetHigh || null,
            targetHigh: tgtData?.targetHigh || null,
            targetLow: tgtData?.targetLow || null,
            targetCount: tgtData?.numberOfAnalysts || null,
            nextEarn: earnData?.[0]?.date || null,
            nextEarnHour: earnData?.[0]?.hour || null,
          };
          if (result.target || result.nextEarn) {
            try { await env.ALERT_KV.put(kvKey, JSON.stringify(result), { expirationTtl: 86400 }); } catch {}
            return new Response(JSON.stringify({ ok: true, ...result }), { headers: { ...cors, 'Content-Type': 'application/json' } });
          }
        } catch {}
      }
      return new Response(JSON.stringify({ ok: false }), { status: 404, headers: cors });
    }

    if (url.pathname === '/stock/recommendation') {
      const ticker = validateTicker(url.searchParams.get('t'));
      if (!ticker) return new Response(JSON.stringify({ ok: false, error: 'invalid ticker' }), { status: 400, headers: cors });
      const kvKey = `rec_${ticker}`;
      try {
        const cached = await env.ALERT_KV.get(kvKey);
        if (cached) return new Response(JSON.stringify({ ok: true, items: JSON.parse(cached), cached: true }), { headers: { ...cors, 'Content-Type': 'application/json' } });
      } catch {}
      const finnhubKeys = getFinnhubKeys(env);
      for (const key of finnhubKeys) {
        try {
          const r = await fetch(`https://finnhub.io/api/v1/stock/recommendation?symbol=${ticker}&token=${key}`, { signal: AbortSignal.timeout(6000) });
          if (!r.ok) continue;
          const data = await r.json();
          if (Array.isArray(data) && data.length > 0) {
            try { await env.ALERT_KV.put(kvKey, JSON.stringify(data), { expirationTtl: 86400 }); } catch {}
            return new Response(JSON.stringify({ ok: true, items: data }), { headers: { ...cors, 'Content-Type': 'application/json' } });
          }
        } catch {}
      }
      return new Response(JSON.stringify({ ok: false, error: 'no data' }), { status: 404, headers: cors });
    }

    if (url.pathname === '/stock/insider') {
      const ticker = validateTicker(url.searchParams.get('t'));
      if (!ticker) return new Response(JSON.stringify({ ok: false, error: 'invalid ticker' }), { status: 400, headers: cors });
      const kvKey = `insider_${ticker}`;
      try {
        const cached = await env.ALERT_KV.get(kvKey);
        if (cached) return new Response(JSON.stringify({ ok: true, items: JSON.parse(cached), cached: true }), { headers: { ...cors, 'Content-Type': 'application/json' } });
      } catch {}
      const finnhubKeys = getFinnhubKeys(env);
      for (const key of finnhubKeys) {
        try {
          const r = await fetch(`https://finnhub.io/api/v1/stock/insider-transactions?symbol=${ticker}&token=${key}`, { signal: AbortSignal.timeout(6000) });
          if (!r.ok) continue;
          const data = await r.json();
          const txns = data?.data || [];
          if (txns.length > 0) {
            const grouped = {};
            txns.filter(t => t.transactionDate && t.share && t.transactionPrice).forEach(t => {
              const key = `${t.name}_${t.transactionDate}_${t.share > 0 ? 'buy' : 'sell'}`;
              if (!grouped[key]) grouped[key] = { ...t };
              else grouped[key].share = (grouped[key].share || 0) + (t.share || 0);
            });
            const sorted = Object.values(grouped)
              .sort((a, b) => new Date(b.transactionDate) - new Date(a.transactionDate))
              .slice(0, 10);
            try { await env.ALERT_KV.put(kvKey, JSON.stringify(sorted), { expirationTtl: 3600 }); } catch {}
            return new Response(JSON.stringify({ ok: true, items: sorted }), { headers: { ...cors, 'Content-Type': 'application/json' } });
          }
        } catch {}
      }
      return new Response(JSON.stringify({ ok: false, error: 'no data' }), { status: 404, headers: cors });
    }

    if (url.pathname === '/metrics/clear') {
      try {
        const list = await env.ALERT_KV.list({ prefix: 'metrics_' });
        const keys = list.keys.map(k => k.name);
        await Promise.all(keys.map(k => env.ALERT_KV.delete(k).catch(() => {})));
        return new Response(JSON.stringify({ ok: true, deleted: keys.length, keys }), {
          headers: { ...cors, 'Content-Type': 'application/json' }
        });
      } catch(e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), {
          status: 500, headers: { ...cors, 'Content-Type': 'application/json' }
        });
      }
    }

    if (url.pathname === '/metrics') {
      const ticker = validateTicker(url.searchParams.get('t'));
      if (!ticker) return new Response(JSON.stringify({ ok: false, error: 'invalid ticker' }), { status: 400, headers: cors });
      const kvKey = `metrics_${ticker}`;
      try {
        const cached = await env.ALERT_KV.get(kvKey);
        if (cached) return new Response(JSON.stringify({ ok: true, ...JSON.parse(cached), cached: true }), { headers: { ...cors, 'Content-Type': 'application/json' } });
      } catch {}
      const finnhubKeys = getFinnhubKeys(env);
      for (const key of finnhubKeys) {
        try {
          const r = await fetch(`https://finnhub.io/api/v1/stock/metric?symbol=${ticker}&metric=all&token=${key}`, { signal: AbortSignal.timeout(6000) });
          if (!r.ok) continue;
          const d = await r.json();
          const m = d?.metric || {};

          // FIX: ดึง revGrowth + revLatestQ (totalRevenue ไตรมาสล่าสุด) จาก
          // incomeStatementHistoryQuarterly ฝั่ง Worker เลย -- ไม่มีปัญหา CORS
          // (แก้ปัญหา "Revenue (ล่าสุด)" ขึ้น N/A ที่ฝั่งแอปดึงผ่าน proxy แล้วล้มเหลวบ่อย)
          const { revGrowth, revLatestQ } = await getRevenueFromYahoo(ticker);

          const result = {
            pe: m['peNormalizedAnnual']||m['peTTM']||null,
            mktcap: m['marketCapitalization']||null,
            beta: m['beta']||null,
            eps: m['epsBasicExclExtraItemsTTM']||m['epsTTM']||null,
            revGrowth,
            revLatestQ,
            div: m['dividendYieldIndicatedAnnual']||null,
            high52: m['52WeekHigh']||null,
            low52: m['52WeekLow']||null,
            shortFloat: (m['shortInterest']!=null&&m['sharesOutstanding']>0)
              ? +((m['shortInterest']/m['sharesOutstanding']*100).toFixed(2)) : null,
            de: m['totalDebt/totalEquityAnnual']||m['longTermDebt/equityAnnual']||null,
            fcf: m['freeCashFlowTTM']||m['freeCashFlowAnnual']||null,
          };
          try { await env.ALERT_KV.put(kvKey, JSON.stringify(result), { expirationTtl: 86400 }); } catch {}
          return new Response(JSON.stringify({ ok: true, ...result }), { headers: { ...cors, 'Content-Type': 'application/json' } });
        } catch {}
      }
      return new Response(JSON.stringify({ ok: false }), { status: 404, headers: cors });
    }

    if (url.pathname === '/metrics/batch') {
      const tickers = (url.searchParams.get('t') || '').toUpperCase().split(',').filter(Boolean).slice(0, 10);
      if (!tickers.length) return new Response(JSON.stringify({ ok: false }), { status: 400, headers: cors });
      const finnhubKeys = getFinnhubKeys(env);
      const results = {};
      for (const ticker of tickers) {
        const kvKey = `metrics_${ticker}`;
        try {
          const cached = await env.ALERT_KV.get(kvKey);
          if (cached) { results[ticker] = JSON.parse(cached); continue; }
        } catch {}
        for (const key of finnhubKeys) {
          try {
            const r = await fetch(`https://finnhub.io/api/v1/stock/metric?symbol=${ticker}&metric=all&token=${key}`, { signal: AbortSignal.timeout(5000) });
            if (!r.ok) continue;
            const d = await r.json();
            const m = d?.metric || {};

            // FIX: ดึง revGrowth + revLatestQ (totalRevenue ไตรมาสล่าสุด) จาก
            // incomeStatementHistoryQuarterly ฝั่ง Worker เลย -- ไม่มีปัญหา CORS
            // (แก้ปัญหา "Revenue (ล่าสุด)" ขึ้น N/A ที่ฝั่งแอปดึงผ่าน proxy แล้วล้มเหลวบ่อย)
            const { revGrowth, revLatestQ } = await getRevenueFromYahoo(ticker);

            const result = {
              pe: m['peNormalizedAnnual']||m['peTTM']||null,
              mktcap: m['marketCapitalization']||null,
              beta: m['beta']||null,
              eps: m['epsBasicExclExtraItemsTTM']||m['epsTTM']||null,
              revGrowth,
              revLatestQ,
              div: m['dividendYieldIndicatedAnnual']||null,
              high52: m['52WeekHigh']||null,
              low52: m['52WeekLow']||null,
              shortFloat: (m['shortInterest']!=null&&m['sharesOutstanding']>0)
                ? +((m['shortInterest']/m['sharesOutstanding']*100).toFixed(2)) : null,
              de: m['totalDebt/totalEquityAnnual']||m['longTermDebt/equityAnnual']||null,
              fcf: m['freeCashFlowTTM']||m['freeCashFlowAnnual']||null,
            };
            results[ticker] = result;
            try { await env.ALERT_KV.put(`metrics_${ticker}`, JSON.stringify(result), { expirationTtl: 86400 }); } catch {}
            break;
          } catch {}
        }
        await new Promise(r => setTimeout(r, 200));
      }
      return new Response(JSON.stringify({ ok: true, metrics: results }), { headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    if (url.pathname === '/refresh' && req.method === 'POST') {
      try {
        await refreshPriceCache(env);
        const raw = await env.ALERT_KV.get('priceCache');
        const count = raw ? Object.keys(JSON.parse(raw).quotes).length : 0;
        return new Response(JSON.stringify({ ok: true, count }), { headers: { ...cors, 'Content-Type': 'application/json' } });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: cors });
      }
    }

    if (url.pathname === '/signals/save' && req.method === 'POST') {
      try {
        const entry = await req.json();
        if (!entry.ticker || !entry.time) return new Response(JSON.stringify({ok:false}), {status:400, headers:cors});
        const raw = await env.ALERT_KV.get('signal_log');
        const log = raw ? JSON.parse(raw) : [];
        const dup = log.find(e => e.ticker===entry.ticker &&
          Math.abs(new Date(e.time)-new Date(entry.time)) < 5*60*1000);
        if (!dup) {
          log.push(entry);
          await env.ALERT_KV.put('signal_log', JSON.stringify(log.slice(-200)), {expirationTtl: 30*24*3600});
        }
        return new Response(JSON.stringify({ok:true}), {headers:{...cors,'Content-Type':'application/json'}});
      } catch(e) {
        return new Response(JSON.stringify({ok:false,error:e.message}), {status:500, headers:cors});
      }
    }

    if (url.pathname === '/signals/log') {
      try {
        const raw = await env.ALERT_KV.get('signal_log');
        const log = raw ? JSON.parse(raw) : [];
        return new Response(JSON.stringify(log), {
          headers: { ...cors, 'Content-Type': 'application/json' }
        });
      } catch (e) {
        return new Response(JSON.stringify([]), { headers: { ...cors, 'Content-Type': 'application/json' } });
      }
    }

    if (url.pathname === '/health') {
      try {
        const raw = await env.ALERT_KV.get('priceCache');
        const cache = raw ? JSON.parse(raw) : null;
        const age = cache ? Math.floor((Date.now() - cache.ts) / 1000) : null;
        const count = cache ? Object.keys(cache.quotes).length : 0;
        const vixPrice = cache?.quotes?.VIX?.price || null;
        const spyPrice = cache?.quotes?.SPY?.price || null;
        const qqqPrice = cache?.quotes?.QQQ?.price || null;
        const status = !cache ? 'cold' : age > 600 ? 'stale' : 'ok';
        const chunkRaw = await env.ALERT_KV.get('price_chunk_idx').catch(()=>null);
        return new Response(JSON.stringify({
          status,
          cache: { age, count, vix: vixPrice, spy: spyPrice, qqq: qqqPrice, stale: age > 300 },
          chunk: chunkRaw ? parseInt(chunkRaw) : 0,
          mon: monSnapshot(),
          ts: new Date().toISOString(),
        }), { headers: { ...cors, 'Content-Type': 'application/json' } });
      } catch(e) {
        return new Response(JSON.stringify({ status: 'error', error: e.message }), { status: 500, headers: cors });
      }
    }

    if (url.pathname === '/mon') {
      if (!isInternalRequest(req)) {
        return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), { status: 401, headers: cors });
      }
      return new Response(JSON.stringify({ ok: true, ...monSnapshot(), ts: new Date().toISOString() }), {
        headers: { ...cors, 'Content-Type': 'application/json' }
      });
    }

    if (url.pathname === '/person-img') {
      const personId = url.searchParams.get('id') || '';
      const PERSON_WIKI = {
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
        khamenei: 'Mojtaba_Khamenei',
      };
      const PERSON_FALLBACK = {
        xi:       'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a5/Xi_Jinping_2024.jpg/240px-Xi_Jinping_2024.jpg',
        khamenei: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e1/Mojtaba_Khamenei.jpg/240px-Mojtaba_Khamenei.jpg',
        powell:   'https://upload.wikimedia.org/wikipedia/commons/thumb/f/fe/Kevin_Warsh_official_photo.jpg/240px-Kevin_Warsh_official_photo.jpg',
      };
      const wikiName = PERSON_WIKI[personId];
      if (!wikiName) return new Response('unknown person', { status: 404, headers: cors });

      const cacheKey = `person_img_${personId}`;
      try {
        const cached = await env.ALERT_KV.get(cacheKey, { type: 'arrayBuffer' });
        if (cached) {
          return new Response(cached, {
            headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=604800', 'Access-Control-Allow-Origin': '*' }
          });
        }
      } catch {}

      try {
        const apiUrl = `https://en.wikipedia.org/w/api.php?action=query&titles=${wikiName}&prop=pageimages&format=json&pithumbsize=300&pilicense=any`;
        const apiRes = await fetch(apiUrl, {
          headers: { 'User-Agent': 'StockProApp/2.0 (cloudflare-worker)' },
          signal: AbortSignal.timeout(6000),
        });
        if (!apiRes.ok) return new Response('api error ' + apiRes.status, { status: 502, headers: cors });
        const apiData = await apiRes.json();
        const pages = apiData?.query?.pages || {};
        let thumbUrl = '';
        for (const page of Object.values(pages)) {
          thumbUrl = page?.thumbnail?.source || '';
          if (thumbUrl) break;
        }
        if (!thumbUrl) {
          thumbUrl = PERSON_FALLBACK[personId] || '';
          if (!thumbUrl) return new Response('no thumbnail found', { status: 404, headers: cors });
        }

        const imgRes = await fetch(thumbUrl, {
          headers: {
            'User-Agent': 'StockProApp/2.0 (cloudflare-worker)',
            'Referer': 'https://en.wikipedia.org/',
          },
          signal: AbortSignal.timeout(8000),
        });
        if (!imgRes.ok) return new Response('img error ' + imgRes.status, { status: 502, headers: cors });
        const imgData = await imgRes.arrayBuffer();
        const ct = imgRes.headers.get('Content-Type') || 'image/jpeg';

        try { await env.ALERT_KV.put(cacheKey, imgData, { expirationTtl: 604800 }); } catch {}

        return new Response(imgData, {
          headers: { 'Content-Type': ct, 'Cache-Control': 'public, max-age=604800', 'Access-Control-Allow-Origin': '*' }
        });
      } catch (e) {
        return new Response('error: ' + e.message, { status: 500, headers: cors });
      }
    }

    if (url.pathname === '/img') {
      const imgUrl = url.searchParams.get('u');
      if (!imgUrl) return new Response('missing u param', { status: 400, headers: cors });
      let decoded = imgUrl;
      for (let i = 0; i < 3; i++) {
        try {
          const next = decodeURIComponent(decoded);
          if (next === decoded) break;
          decoded = next;
        } catch { break; }
      }
      const allowed = ['upload.wikimedia.org', 'www.federalreserve.gov', 'commons.wikimedia.org'];
      if (!allowed.some(h => decoded.startsWith('https://' + h))) {
        return new Response('not allowed: ' + decoded.slice(0, 80), { status: 403, headers: cors });
      }
      try {
        const r = await fetch(decoded, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
            'Accept': 'image/webp,image/jpeg,image/png,image/*',
            'Referer': 'https://en.wikipedia.org/',
          },
          signal: AbortSignal.timeout(8000),
        });
        if (!r.ok) return new Response('upstream ' + r.status, { status: 502, headers: cors });
        const ct = r.headers.get('Content-Type') || 'image/jpeg';
        const body = await r.arrayBuffer();
        return new Response(body, {
          headers: {
            'Content-Type': ct,
            'Cache-Control': 'public, max-age=604800',
            'Access-Control-Allow-Origin': '*',
          },
        });
      } catch (e) {
        return new Response('fetch error: ' + e.message, { status: 502, headers: cors });
      }
    }

    return new Response('STOCK PRO -- Prices Worker OK', { headers: cors });
  },

  async scheduled(event, env, ctx) {
    if (event.cron === '*/1 * * * *') {
      // [FIX] ตรวจ KV ใน scheduled ด้วย
      if (!env.ALERT_KV) {
        console.error('[scheduled] ALERT_KV binding missing -- skipping');
        return;
      }
      const et = new Date(new Date().toLocaleString('en-US', {timeZone: 'America/New_York'}));
      const day = et.getDay();
      const mins = et.getHours() * 60 + et.getMinutes();
      const isExtendedHours = day >= 1 && day <= 5 && mins >= 240 && mins < 1200;
      if (!isExtendedHours) {
        if (mins % 5 !== 0) return;
      }
      ctx.waitUntil(refreshPriceCache(env));
    }
  }
};
