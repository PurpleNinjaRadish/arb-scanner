// ─── Exchange market data (public REST, no API keys) ──────────────────────────
// Normalised output per exchange:  quotes[QUOTE][COIN] = { bid, ask, last, volQuote, book }
//   book=true  → bid/ask are real top-of-book prices
//   book=false → only a last-trade price is known (refineQuotes() can upgrade it)
const axios = require('axios');
const { canonical, nativeSymbol } = require('./tickers');

const http = axios.create({ timeout: 8000, headers: { 'User-Agent': 'arb-scanner/3.0' } });
const QUOTES = ['USD', 'USDT', 'USDC'];
const BULK_TTL_MS = 4000;

const health = {}; // exchange -> { ok, latencyMs, error, at }

function num(x) { const n = parseFloat(x); return Number.isFinite(n) && n > 0 ? n : null; }
function emptyQuotes() { return Object.fromEntries(QUOTES.map(q => [q, {}])); }
// Store a listing under its canonical ticker (see tickers.js). If an exchange lists
// a coin natively under a name another of its tickers is aliased to, the native
// listing wins and the aliased one is dropped rather than overwriting it.
function put(out, quote, coin, q, ex) {
  if (!out[quote] || !coin) return;
  if (!q.bid && !q.ask && !q.last) return;
  const nat = String(coin).toUpperCase();
  const can = ex ? canonical(ex, nat) : nat;
  const prev = out[quote][can];
  if (prev && prev.native === can && nat !== can) return;
  out[quote][can] = { ...q, native: nat };
}
// Split a concatenated symbol (BTCUSDT) using the known quote list (longest first)
function splitConcat(sym) {
  for (const q of ['USDT', 'USDC', 'USD']) if (sym.endsWith(q) && sym.length > q.length) return [sym.slice(0, -q.length), q];
  return [null, null];
}

// ─── Kraken ──────────────────────────────────────────────────────────────────
let krakenPairs = null, krakenPairsAt = 0; // pairId -> {coin, quote}; and reverse
async function krakenPairMap() {
  if (krakenPairs && Date.now() - krakenPairsAt < 3600e3) return krakenPairs;
  const r = await http.get('https://api.kraken.com/0/public/AssetPairs');
  if (r.data.error && r.data.error.length) throw new Error(r.data.error.join(', '));
  const byId = {}, byCoin = {};
  for (const [id, p] of Object.entries(r.data.result || {})) {
    if (!p.wsname || (p.status && p.status !== 'online')) continue;
    let [b, q] = p.wsname.split('/');
    const nativeBase = b;
    b = canonical('kraken', b); q = canonical('kraken', q);
    if (!QUOTES.includes(q)) continue;
    byId[id] = { coin: b, native: nativeBase, quote: q };
    byCoin[`${b}-${q}`] = id;
  }
  krakenPairs = { byId, byCoin }; krakenPairsAt = Date.now();
  return krakenPairs;
}
async function krakenBulk() {
  const { byId } = await krakenPairMap();
  const r = await http.get('https://api.kraken.com/0/public/Ticker');
  if (r.data.error && r.data.error.length) throw new Error(r.data.error.join(', '));
  const out = emptyQuotes();
  for (const [id, t] of Object.entries(r.data.result || {})) {
    const m = byId[id]; if (!m) continue;
    const vwap = num(t.p && t.p[1]), vol = num(t.v && t.v[1]);
    put(out, m.quote, m.native, { bid: num(t.b[0]), ask: num(t.a[0]), last: num(t.c[0]), volQuote: vwap && vol ? vwap * vol : null, book: true }, 'kraken');
  }
  return out;
}
async function krakenBook(coin, quote) {
  const { byCoin } = await krakenPairMap();
  const id = byCoin[`${coin}-${quote}`]; if (!id) throw new Error(`Kraken has no ${coin}-${quote}`);
  const r = await http.get('https://api.kraken.com/0/public/Depth', { params: { pair: id, count: 100 } });
  if (r.data.error && r.data.error.length) throw new Error(r.data.error.join(', '));
  const b = Object.values(r.data.result || {})[0] || {};
  return { bids: (b.bids || []).map(l => [+l[0], +l[1]]), asks: (b.asks || []).map(l => [+l[0], +l[1]]) };
}

// ─── Coinbase Advanced Trade (public market endpoints) ───────────────────────
const CB = 'https://api.coinbase.com/api/v3/brokerage/market';
async function coinbaseBulk() {
  const r = await http.get(`${CB}/products`, { params: { product_type: 'SPOT' } });
  const out = emptyQuotes();
  for (const p of r.data.products || []) {
    if (p.is_disabled || p.trading_disabled || p.cancel_only || (p.status && p.status !== 'online')) continue;
    const coin = p.base_currency_id || (p.product_id || '').split('-')[0];
    const quote = p.quote_currency_id || (p.product_id || '').split('-')[1];
    const last = num(p.price);
    const volQuote = num(p.approximate_quote_24h_volume) || (num(p.volume_24h) && last ? num(p.volume_24h) * last : null);
    put(out, quote, coin, { bid: null, ask: null, last, volQuote, book: false }, 'coinbase');
  }
  return out;
}
const cbTickerCache = new Map(); // product -> {at, bid, ask}
async function coinbaseTicker(coin, quote) {
  const id = `${nativeSymbol('coinbase', coin)}-${quote}`;
  const c = cbTickerCache.get(id);
  if (c && Date.now() - c.at < 3000) return c;
  const r = await http.get(`${CB}/products/${encodeURIComponent(id)}/ticker`, { params: { limit: 1 } });
  const v = { at: Date.now(), bid: num(r.data.best_bid), ask: num(r.data.best_ask) };
  cbTickerCache.set(id, v);
  return v;
}
async function coinbaseBook(coin, quote) {
  const r = await http.get(`${CB}/product_book`, { params: { product_id: `${nativeSymbol('coinbase', coin)}-${quote}`, limit: 100 } });
  const pb = r.data.pricebook || {};
  return { bids: (pb.bids || []).map(l => [+l.price, +l.size]), asks: (pb.asks || []).map(l => [+l.price, +l.size]) };
}

// ─── Binance / Binance.US ────────────────────────────────────────────────────
function binanceBulk(base, ex) {
  return async () => {
    const r = await http.get(`${base}/api/v3/ticker/bookTicker`);
    const out = emptyQuotes();
    for (const t of r.data || []) {
      const [coin, quote] = splitConcat(t.symbol); if (!coin) continue;
      const bid = num(t.bidPrice), ask = num(t.askPrice);
      put(out, quote, coin, { bid, ask, last: bid && ask ? (bid + ask) / 2 : null, volQuote: null, book: true }, ex);
    }
    return out;
  };
}
function binanceBook(base, ex) {
  return async (coin, quote) => {
    const r = await http.get(`${base}/api/v3/depth`, { params: { symbol: `${nativeSymbol(ex, coin)}${quote}`, limit: 100 } });
    return { bids: r.data.bids.map(l => [+l[0], +l[1]]), asks: r.data.asks.map(l => [+l[0], +l[1]]) };
  };
}

// ─── KuCoin / Bybit / OKX ────────────────────────────────────────────────────
async function kucoinBulk() {
  const r = await http.get('https://api.kucoin.com/api/v1/market/allTickers');
  const out = emptyQuotes();
  for (const t of (r.data.data && r.data.data.ticker) || []) {
    const [coin, quote] = t.symbol.split('-');
    put(out, quote, coin, { bid: num(t.buy), ask: num(t.sell), last: num(t.last), volQuote: num(t.volValue), book: true }, 'kucoin');
  }
  return out;
}
async function kucoinBook(coin, quote) {
  const r = await http.get('https://api.kucoin.com/api/v1/market/orderbook/level2_100', { params: { symbol: `${nativeSymbol('kucoin', coin)}-${quote}` } });
  const d = r.data.data || {};
  return { bids: (d.bids || []).map(l => [+l[0], +l[1]]), asks: (d.asks || []).map(l => [+l[0], +l[1]]) };
}
async function bybitBulk() {
  const r = await http.get('https://api.bybit.com/v5/market/tickers', { params: { category: 'spot' } });
  const out = emptyQuotes();
  for (const t of (r.data.result && r.data.result.list) || []) {
    const [coin, quote] = splitConcat(t.symbol); if (!coin) continue;
    put(out, quote, coin, { bid: num(t.bid1Price), ask: num(t.ask1Price), last: num(t.lastPrice), volQuote: num(t.turnover24h), book: true }, 'bybit');
  }
  return out;
}
async function bybitBook(coin, quote) {
  const r = await http.get('https://api.bybit.com/v5/market/orderbook', { params: { category: 'spot', symbol: `${nativeSymbol('bybit', coin)}${quote}`, limit: 50 } });
  const d = r.data.result || {};
  return { bids: (d.b || []).map(l => [+l[0], +l[1]]), asks: (d.a || []).map(l => [+l[0], +l[1]]) };
}
async function okxBulk() {
  const r = await http.get('https://www.okx.com/api/v5/market/tickers', { params: { instType: 'SPOT' } });
  const out = emptyQuotes();
  for (const t of r.data.data || []) {
    const [coin, quote] = t.instId.split('-');
    put(out, quote, coin, { bid: num(t.bidPx), ask: num(t.askPx), last: num(t.last), volQuote: num(t.volCcy24h), book: true }, 'okx');
  }
  return out;
}
async function okxBook(coin, quote) {
  const r = await http.get('https://www.okx.com/api/v5/market/books', { params: { instId: `${nativeSymbol('okx', coin)}-${quote}`, sz: 100 } });
  const d = (r.data.data && r.data.data[0]) || {};
  return { bids: (d.bids || []).map(l => [+l[0], +l[1]]), asks: (d.asks || []).map(l => [+l[0], +l[1]]) };
}

// ─── Registry ────────────────────────────────────────────────────────────────
const EXCHANGES = {
  kraken:    { label: 'Kraken',       hbConnector: 'kraken',                  bulk: krakenBulk,   book: krakenBook,   timeUrl: 'https://api.kraken.com/0/public/Time' },
  coinbase:  { label: 'Coinbase Adv', hbConnector: 'coinbase_advanced_trade', bulk: coinbaseBulk, book: coinbaseBook, timeUrl: 'https://api.coinbase.com/api/v3/brokerage/time' },
  binance:   { label: 'Binance',      hbConnector: 'binance',                 bulk: binanceBulk('https://api.binance.com', 'binance'), book: binanceBook('https://api.binance.com', 'binance'), timeUrl: 'https://api.binance.com/api/v3/time' },
  binanceus: { label: 'Binance.US',   hbConnector: 'binance_us',              bulk: binanceBulk('https://api.binance.us', 'binanceus'),  book: binanceBook('https://api.binance.us', 'binanceus'),  timeUrl: 'https://api.binance.us/api/v3/time' },
  kucoin:    { label: 'KuCoin',       hbConnector: 'kucoin',                  bulk: kucoinBulk,   book: kucoinBook,   timeUrl: 'https://api.kucoin.com/api/v1/timestamp' },
  bybit:     { label: 'Bybit',        hbConnector: 'bybit',                   bulk: bybitBulk,    book: bybitBook,    timeUrl: 'https://api.bybit.com/v5/market/time' },
  okx:       { label: 'OKX',          hbConnector: 'okx',                     bulk: okxBulk,      book: okxBook,      timeUrl: 'https://www.okx.com/api/v5/public/time' },
};

const bulkCache = new Map(); // ex -> { at, data, promise }
async function getBulk(ex, { force = false } = {}) {
  const def = EXCHANGES[ex]; if (!def) throw new Error(`Unknown exchange ${ex}`);
  const c = bulkCache.get(ex);
  if (!force && c && c.data && Date.now() - c.at < BULK_TTL_MS) return c.data;
  if (c && c.promise) return c.promise;
  const t0 = Date.now();
  const promise = def.bulk().then(data => {
    health[ex] = { ok: true, latencyMs: Date.now() - t0, error: null, at: Date.now() };
    bulkCache.set(ex, { at: Date.now(), data });
    return data;
  }).catch(e => {
    const msg = e.response ? `HTTP ${e.response.status}${e.response.status === 451 || e.response.status === 403 ? ' (region blocked?)' : ''}` : e.message;
    health[ex] = { ok: false, latencyMs: Date.now() - t0, error: msg, at: Date.now() };
    bulkCache.delete(ex);
    throw new Error(`${def.label}: ${msg}`);
  });
  bulkCache.set(ex, { ...(c || {}), promise });
  return promise;
}

// Quotes for a quote currency; { quotes:{COIN:{...}}, error }
async function getQuotes(ex, quote, opts) {
  try {
    const all = await getBulk(ex, opts);
    return { quotes: all[quote] || {}, error: null };
  } catch (e) { return { quotes: {}, error: e.message }; }
}

// Upgrade last-price-only quotes (Coinbase) to real bid/ask for chosen coins
async function refineQuotes(ex, quote, quotes, coins, concurrency = 6) {
  if (ex !== 'coinbase') return quotes;
  const todo = coins.filter(c => quotes[c] && !quotes[c].book);
  let i = 0;
  const worker = async () => {
    while (i < todo.length) {
      const coin = todo[i++];
      try {
        const t = await coinbaseTicker(coin, quote);
        if (t.bid && t.ask) quotes[coin] = { ...quotes[coin], bid: t.bid, ask: t.ask, book: true };
      } catch (_) { /* keep estimate */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));
  return quotes;
}

async function getOrderBook(ex, coin, quote) {
  const def = EXCHANGES[ex]; if (!def) throw new Error(`Unknown exchange ${ex}`);
  const b = await def.book(coin, quote);
  b.bids.sort((x, y) => y[0] - x[0]);
  b.asks.sort((x, y) => x[0] - y[0]);
  return b;
}

// Walk the book to fill `baseAmount`. Returns VWAP and whether depth sufficed.
function vwapFill(levels, baseAmount) {
  let remaining = baseAmount, cost = 0, used = 0;
  for (const [p, s] of levels) {
    if (remaining <= 0) break;
    const take = Math.min(s, remaining);
    cost += take * p; remaining -= take; used++;
  }
  const filled = baseAmount - remaining;
  return { avgPrice: filled > 0 ? cost / filled : null, filled, complete: remaining <= 1e-12, levelsUsed: used, worstPrice: used ? levels[used - 1][0] : null };
}

// Binance's public market-data mirror answers where api.binance.com is geo-blocked.
// Used only as a price reference for the ticker audit, never for trading.
const binanceMirrorBulk = binanceBulk('https://data-api.binance.vision', 'binance');

module.exports = { EXCHANGES, QUOTES, getQuotes, refineQuotes, getOrderBook, vwapFill, health, getBulk, binanceMirrorBulk };
