// ─── Live Ticker Audit ────────────────────────────────────────────────────────
// Pulls every spot listing (USD / USDC / USDT) from every reachable exchange,
// converts tickers to canonical symbols, and checks each listing's price against
// the median of all exchanges. A ticker more than 20% away from the others is
// almost always a different coin sharing the name (or a dead/stale market), so the
// scanner never compares it. Results are cached and refreshed every 30 minutes.
const { EXCHANGES, QUOTES, getBulk, binanceMirrorBulk } = require('./exchanges');
const { ALIASES, KNOWN_COLLISIONS, FIAT, nativeSymbol, knownCollision } = require('./tickers');

const TTL_MS = 30 * 60 * 1000;
const MISMATCH_RATIO = 1.2;  // > 20% from the cross-exchange median
const SUSPECT_RATIO = 1.05;  // 5–20%: thin or stale book, still compared but flagged
const STABLE = new Set(['USDT', 'USDC', 'DAI', 'TUSD', 'USDP', 'PYUSD', 'FDUSD', 'USDE', 'USDS', 'USDD', 'USD1', 'USDG', 'RLUSD', 'EURC', 'AUSD', 'GUSD', 'LUSD', 'USDQ', 'BUSD']);

const mid = (q) => {
  const b = q.bid || q.last, a = q.ask || q.last;
  if (!(b > 0 && a > 0) || a < b) return null;
  if ((a - b) / ((a + b) / 2) > 0.2) return null; // >20% wide book: not a usable price
  return (a + b) / 2;
};
const median = (xs) => {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};
const ratio = (a, b) => Math.max(a, b) / Math.min(a, b);
const round = (n, d = 6) => (n == null || !Number.isFinite(n) ? null : Number(n.toPrecision(d)));

// Pure evaluation. bulks[ex] = { USD:{COIN:{bid,ask,last,native}}, USDC:{...}, USDT:{...} }
function evaluateAudit(bulks, sources = {}) {
  const table = {}; // sym -> ex -> { native, quotes:{Q:mid}, usd }
  for (const [ex, byQuote] of Object.entries(bulks)) {
    if (!byQuote) continue;
    for (const quote of QUOTES) {
      for (const [sym, q] of Object.entries(byQuote[quote] || {})) {
        const m = mid(q);
        const row = (table[sym] = table[sym] || {});
        const l = (row[ex] = row[ex] || { native: q.native || nativeSymbol(ex, sym), quotes: {} });
        l.quotes[quote] = m == null ? null : m;
      }
    }
  }

  const symbols = [];
  const flagged = [];
  for (const [sym, byEx] of Object.entries(table)) {
    const kind = FIAT.has(sym) ? 'fiat' : STABLE.has(sym) ? 'stablecoin' : 'crypto';
    // Each listing's price = its quote market closest to the median of ALL markets,
    // so one stale quote market (e.g. a dead USDC book) can't drag the listing off
    const ref0 = median(Object.values(byEx).flatMap(l => Object.values(l.quotes).filter(x => x != null)));
    for (const l of Object.values(byEx)) {
      const v = Object.values(l.quotes).filter(x => x != null);
      l.usd = v.length ? v.reduce((best, x) => (ratio(x, ref0) < ratio(best, ref0) ? x : best)) : null;
    }
    // Known different coins and fiat never count toward the reference price
    const priced = Object.entries(byEx).filter(([ex, l]) => l.usd != null && kind !== 'fiat' && !knownCollision(ex, sym));
    const ref = median(priced.map(([, l]) => l.usd));
    const nSources = priced.length;

    for (const [ex, l] of Object.entries(byEx)) {
      const collision = knownCollision(ex, sym);
      l.devPct = l.usd != null && ref ? round((ratio(l.usd, ref) - 1) * 100, 4) : null;
      if (kind === 'fiat') l.status = 'fiat';
      else if (collision) { l.status = 'collision'; l.reason = collision; }
      else if (l.usd == null) { l.status = 'no_price'; l.reason = 'No usable bid/ask (book empty, one-sided or >20% wide)'; }
      else if (nSources < 2) l.status = 'single';
      else {
        const others = priced.filter(([e]) => e !== ex).map(([, o]) => o.usd);
        const refOthers = median(others);
        const r = ratio(l.usd, nSources >= 3 ? ref : refOthers);
        if (r > MISMATCH_RATIO) {
          l.status = nSources >= 3 ? 'mismatch' : 'conflict';
          l.reason = nSources >= 3
            ? `Price ${round(l.usd)} is ${((r - 1) * 100).toFixed(0)}% from the ${nSources}-exchange median ${round(ref)} — likely a different coin or a dead market`
            : `Only 2 exchanges list it and prices differ ${((r - 1) * 100).toFixed(0)}% — can't tell which is right`;
        } else if (r > SUSPECT_RATIO) {
          l.status = 'suspect';
          l.reason = `Price ${((r - 1) * 100).toFixed(1)}% from the others — thin or stale book`;
        } else l.status = 'ok';
      }
      // Per-quote check: a single stale quote market on an otherwise fine listing
      l.badQuotes = [];
      if (kind !== 'fiat' && ref) {
        for (const [qq, m] of Object.entries(l.quotes)) {
          if (m != null && ratio(m, ref) > MISMATCH_RATIO && (l.status === 'ok' || l.status === 'suspect')) {
            l.badQuotes.push(qq);
          }
        }
        if (l.badQuotes.length) {
          l.status = 'bad_quote';
          l.reason = `${l.badQuotes.join(', ')} market is >20% off; other quotes are fine`;
        }
      }
      if (['mismatch', 'conflict', 'collision', 'bad_quote'].includes(l.status)) {
        flagged.push({ symbol: sym, exchange: ex, native: l.native, status: l.status, reason: l.reason, usd: round(l.usd), medianUsd: round(ref), badQuotes: l.badQuotes });
      }
    }

    const listings = Object.fromEntries(Object.entries(byEx).map(([ex, l]) => [ex, {
      native: l.native, quotes: Object.fromEntries(Object.entries(l.quotes).map(([q, m]) => [q, round(m)])),
      usd: round(l.usd), devPct: l.devPct, status: l.status, reason: l.reason || null, badQuotes: l.badQuotes,
    }]));
    const statuses = Object.values(listings).map(l => l.status);
    symbols.push({
      symbol: sym, kind, medianUsd: round(ref), exchanges: Object.keys(byEx).length,
      status: statuses.some(s => ['mismatch', 'conflict', 'collision'].includes(s)) ? 'flagged'
        : statuses.includes('bad_quote') || statuses.includes('suspect') ? 'warn'
          : Object.keys(byEx).length < 2 ? 'single' : 'ok',
      listings,
    });
  }
  symbols.sort((a, b) => b.exchanges - a.exchanges || a.symbol.localeCompare(b.symbol));
  flagged.sort((a, b) => a.symbol.localeCompare(b.symbol) || a.exchange.localeCompare(b.exchange));

  const exchanges = Object.fromEntries(Object.keys(EXCHANGES).map(ex => {
    const b = bulks[ex];
    const coins = b ? new Set(QUOTES.flatMap(q => Object.keys(b[q] || {}))) : new Set();
    return [ex, {
      label: EXCHANGES[ex].label,
      ok: !!b,
      source: (sources[ex] && sources[ex].source) || (b ? 'live' : null),
      error: (sources[ex] && sources[ex].error) || null,
      coins: coins.size,
      markets: b ? QUOTES.reduce((t, q) => t + Object.keys(b[q] || {}).length, 0) : 0,
      flagged: flagged.filter(f => f.exchange === ex).length,
    }];
  }));

  return {
    at: Date.now(),
    exchanges,
    totals: {
      symbols: symbols.length,
      multiListed: symbols.filter(s => s.exchanges > 1).length,
      flaggedListings: flagged.length,
      flaggedSymbols: new Set(flagged.map(f => f.symbol)).size,
    },
    flagged,
    symbols,
    aliases: ALIASES,
    knownCollisions: KNOWN_COLLISIONS,
  };
}

// ─── Live fetch + cache ──────────────────────────────────────────────────────
let cache = null;
let inflight = null;

async function fetchAll() {
  const bulks = {}, sources = {};
  await Promise.all(Object.keys(EXCHANGES).map(async ex => {
    try {
      bulks[ex] = await getBulk(ex);
      sources[ex] = { source: 'live' };
    } catch (e) {
      sources[ex] = { error: e.message };
      if (ex === 'binance') {
        // Geo-blocked: use Binance's public data mirror as a price reference only
        try { bulks[ex] = await binanceMirrorBulk(); sources[ex] = { source: 'mirror (reference only)', error: e.message }; }
        catch (_) { /* keep error */ }
      }
    }
  }));
  return { bulks, sources };
}

async function runTickerAudit({ force = false } = {}) {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache;
  if (inflight) return inflight;
  inflight = fetchAll()
    .then(({ bulks, sources }) => { cache = evaluateAudit(bulks, sources); return cache; })
    .finally(() => { inflight = null; });
  return inflight;
}

function cachedAudit() {
  if (!cache || Date.now() - cache.at > TTL_MS) runTickerAudit().catch(() => {});
  return cache;
}

// Why a listing must not be compared (null = fine). Known collisions always apply;
// live findings apply once the audit has run.
function blockedReason(ex, sym, quote) {
  const s = String(sym || '').toUpperCase();
  if (FIAT.has(s)) return 'Fiat currency, not a crypto asset';
  const known = knownCollision(ex, s);
  if (known) return known;
  const a = cachedAudit();
  if (!a) return null;
  const hit = a.flagged.find(f => f.exchange === ex && f.symbol === s);
  if (!hit) return null;
  if (hit.status === 'bad_quote') return hit.badQuotes.includes(quote) ? `${EXCHANGES[ex].label} ${s}-${quote}: ${hit.reason}` : null;
  return `${EXCHANGES[ex].label} ${s}: ${hit.reason}`;
}

function _setCacheForTests(c) { cache = c; }

module.exports = { evaluateAudit, runTickerAudit, cachedAudit, blockedReason, _setCacheForTests, MISMATCH_RATIO };
