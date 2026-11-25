// ─── Price Cross-Check, Profitability Gate & Live Guard Rails ─────────────────
// Before a bot launches, prices are cross-referenced from independent sources
// and profitability is computed two ways:
//   1. Per trade  — fresh order-book VWAP on both venues, minus both legs' fees
//                   and a slippage buffer. Must be > 0.
//   2. Monthly    — expected trades/month (observed scanner history, or an
//                   assumption) x net per trade, minus allocated server cost and
//                   rebalancing. Must be > 0.
// A bot launches only when the price data checks pass AND both calculations are
// profitable. Otherwise it needs manual confirmation (typed phrase for live).
//
// Live bots additionally get non-overridable guard rails: a max order size, a
// minimum profitability floor, a Hummingbot kill-switch stop-loss, and a backend
// monitor that stops the container when its realized loss reaches a $ limit.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EXCHANGES, getQuotes, refineQuotes, getOrderBook, vwapFill } = require('./exchanges');
const { summarizeStats } = require('./scanner');
const { estimateServerCost } = require('./advisor');
const { parseStrategyYaml } = require('./strategies');
const { loadConfig, updateConfig, DEFAULT_GUARD } = require('./config');
const { canonical } = require('./tickers');
const { blockedReason } = require('./tickerAudit');

const DATA_DIR = process.env.ARB_DATA_DIR || path.join(__dirname, '..', 'data');
const AUDIT_FILE = path.join(DATA_DIR, 'guard_audit.json');
const BOTS_FILE = path.join(DATA_DIR, 'guard_bots.json');
const REF_TIMEOUT_MS = 6000;
const QUOTE_EQUIV = { USD: ['USD', 'USDC', 'USDT'], USDC: ['USDC', 'USD', 'USDT'], USDT: ['USDT', 'USDC', 'USD'] };

const round = (n, d = 4) => (n == null || !Number.isFinite(n) ? null : Number(n.toFixed(d)));
const pctDiff = (a, b) => (a && b ? Math.abs(a - b) / b * 100 : null);
const median = (xs) => {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};

function guardSettings(cfg = loadConfig()) {
  return { ...DEFAULT_GUARD, ...(cfg.guard || {}) };
}

// Hummingbot connector name -> exchange key (kraken, coinbase, ...)
function exchangeFromConnector(connector) {
  const base = String(connector || '').replace(/_paper_trade$/, '');
  const hit = Object.entries(EXCHANGES).find(([, def]) => def.hbConnector === base);
  return hit ? hit[0] : null;
}

// ─── 1. Pure evaluation (no network) ─────────────────────────────────────────
// input.venues[ex] = { ticker:{bid,ask,last,book}|null, tickerError, book:{bids,asks}|null, bookError }
function evaluateCrossCheck(input) {
  const {
    symbol, quote, exA, exB, strategy = 'amm_arb', fees = {},
    tradeSize: tradeSizeIn, baseAmount: baseAmountIn,
    venues = {}, references = [], stats = null, server = {},
    minProfitabilityPct = null, scannerNetPct = null,
  } = input;
  const g = { ...DEFAULT_GUARD, ...(input.guard || {}) };
  const checks = [];
  const add = (id, label, status, detail) => checks.push({ id, label, status, detail });
  if (Array.isArray(input.tickerBlocks)) {
    add('ticker', 'Ticker is the same coin on both exchanges', input.tickerBlocks.length ? 'fail' : 'pass',
      input.tickerBlocks.length ? input.tickerBlocks.join(' · ') : 'Passed the cross-exchange ticker audit');
  }
  const slip = (Number(g.slippageBps) || 0) / 10000;

  // Prices per venue
  const prices = [exA, exB].map(ex => {
    const v = venues[ex] || {};
    const t = v.ticker || null;
    const b = v.book || null;
    const tBid = t ? (t.bid || t.last) : null;
    const tAsk = t ? (t.ask || t.last) : null;
    const bookBid = b && b.bids && b.bids.length ? b.bids[0][0] : null;
    const bookAsk = b && b.asks && b.asks.length ? b.asks[0][0] : null;
    const bookMid = bookBid && bookAsk ? (bookBid + bookAsk) / 2 : null;
    const tickerMid = tBid && tAsk ? (tBid + tAsk) / 2 : null;
    return {
      ex, label: (EXCHANGES[ex] && EXCHANGES[ex].label) || ex,
      tickerBid: tBid, tickerAsk: tAsk, tickerMid, tickerIsBook: !!(t && t.book),
      bookBid, bookAsk, bookMid,
      bookSpreadPct: bookMid ? round((bookAsk - bookBid) / bookMid * 100) : null,
      driftPct: round(pctDiff(tickerMid, bookMid)),
      refDevPct: null,
      tickerError: v.tickerError || null,
      bookError: v.bookError || null,
    };
  });
  const [pa, pb] = prices;

  // Check: order books available and not crossed
  const booksOk = prices.every(p => p.bookBid && p.bookAsk);
  add('books', 'Live order books fetched on both venues', booksOk ? 'pass' : 'fail',
    booksOk ? 'Fresh L2 books retrieved directly from each exchange'
      : prices.filter(p => !p.bookBid || !p.bookAsk).map(p => `${p.label}: ${p.bookError || 'empty book'}`).join('; '));
  if (booksOk) {
    const crossed = prices.filter(p => p.bookBid >= p.bookAsk);
    add('book_sane', 'Order books are not crossed (bid < ask)', crossed.length ? 'fail' : 'pass',
      crossed.length ? crossed.map(p => `${p.label} bid ${p.bookBid} >= ask ${p.bookAsk}`).join('; ') : 'Both books are well-formed');
  }

  // Check: scanner ticker agrees with fresh book
  const drift = prices.map(p => {
    if (!p.tickerMid) return { p, status: 'warn', text: `${p.label}: no scanner ticker (${p.tickerError || 'not listed'})` };
    if (p.driftPct == null) return { p, status: 'warn', text: `${p.label}: cannot compare` };
    const over = p.driftPct > g.maxTickerDriftPct;
    return { p, status: over ? 'fail' : 'pass', text: `${p.label}: ${p.driftPct.toFixed(3)}%${p.tickerIsBook ? '' : ' (last-trade estimate)'}` };
  });
  const driftStatus = drift.some(d => d.status === 'fail') ? 'fail' : drift.some(d => d.status === 'warn') ? 'warn' : 'pass';
  add('ticker_vs_book', `Scanner price matches live book (max ${g.maxTickerDriftPct}% drift)`, driftStatus, drift.map(d => d.text).join(' · '));

  // Check: venues agree with an independent reference (median of other exchanges)
  const refMid = median(references.map(r => r.mid));
  if (refMid) {
    for (const p of prices) p.refDevPct = round(pctDiff(p.bookMid, refMid));
    const bad = prices.filter(p => p.refDevPct != null && p.refDevPct > g.maxRefDeviationPct);
    add('reference', `Prices match ${references.length} independent exchange(s) (max ${g.maxRefDeviationPct}% off)`,
      bad.length ? 'fail' : 'pass',
      `Reference median ${round(refMid, 8)} · ` + prices.map(p => `${p.label} ${p.refDevPct != null ? p.refDevPct.toFixed(3) + '%' : 'n/a'}`).join(' · ')
      + (bad.length ? ' — possible wrong token, stale feed or halted market' : ''));
  } else {
    add('reference', 'Independent reference price', 'warn', 'No other exchange lists this coin — prices could not be cross-referenced');
  }

  // Check: cross-venue gap is plausible
  if (pa.bookMid && pb.bookMid) {
    const gap = pctDiff(Math.max(pa.bookMid, pb.bookMid), Math.min(pa.bookMid, pb.bookMid));
    const over = gap > g.maxGrossSpreadPct;
    add('plausible_gap', `Venue price gap is plausible (max ${g.maxGrossSpreadPct}%)`, over ? 'fail' : 'pass',
      `Mid prices differ by ${gap.toFixed(3)}%${over ? ' — usually two different tokens sharing a ticker, or a suspended deposit/withdrawal market' : ''}`);
  }

  // ── Calculation 1: per trade on fresh order books ──
  let perTrade = { pass: false, reason: 'Order books unavailable' };
  let refPrice = null;
  if (booksOk) {
    refPrice = (pa.bookMid + pb.bookMid) / 2;
    const evalDir = (buyEx, sellEx) => {
      const buyBook = venues[buyEx].book, sellBook = venues[sellEx].book;
      const bestAsk = buyBook.asks[0][0];
      const base = baseAmountIn > 0 ? Number(baseAmountIn) : (Number(tradeSizeIn) || 1000) / bestAsk;
      const buy = vwapFill(buyBook.asks, base);
      const sell = vwapFill(sellBook.bids, base);
      const isXemm = strategy === 'cross_exchange_market_making' || strategy === 'xemm';
      // XEMM posts the maker order on the buy venue; priced conservatively at the ask VWAP
      const feeBuy = ((fees[buyEx] || {})[isXemm ? 'maker' : 'taker']) ?? 0.001;
      const feeSell = ((fees[sellEx] || {}).taker) ?? 0.001;
      if (!buy.avgPrice || !sell.avgPrice) return { buyEx, sellEx, base, buy, sell, feeBuy, feeSell, net: -Infinity };
      const notional = buy.avgPrice * base;
      const cost = notional * (1 + feeBuy) * (1 + slip);
      const revenue = sell.avgPrice * base * (1 - feeSell) * (1 - slip);
      return { buyEx, sellEx, base, buy, sell, feeBuy, feeSell, notional, cost, revenue, net: revenue - cost };
    };
    const d1 = evalDir(exA, exB), d2 = evalDir(exB, exA);
    const d = d1.net >= d2.net ? d1 : d2;
    const depthOk = d.buy.complete && d.sell.complete;
    add('depth', 'Enough order-book depth to fill the full order on both legs', depthOk ? 'pass' : 'fail',
      `${EXCHANGES[d.buyEx]?.label || d.buyEx} asks filled ${round(d.buy.filled, 8)}/${round(d.base, 8)} · `
      + `${EXCHANGES[d.sellEx]?.label || d.sellEx} bids filled ${round(d.sell.filled, 8)}/${round(d.base, 8)}`);

    if (Number.isFinite(d.net)) {
      const netPct = d.net / d.notional * 100;
      const feeDollar = d.notional * d.feeBuy + d.sell.avgPrice * d.base * d.feeSell;
      const grossDollar = (d.sell.avgPrice - d.buy.avgPrice) * d.base;
      const slipDollar = grossDollar - feeDollar - d.net;
      const pass = depthOk && d.net > 0;
      perTrade = {
        pass,
        buyOn: d.buyEx, sellOn: d.sellEx,
        baseAmount: round(d.base, 8),
        tradeSize: round(d.notional, 2),
        buyVwap: round(d.buy.avgPrice, 8), sellVwap: round(d.sell.avgPrice, 8),
        grossPct: round((d.sell.avgPrice - d.buy.avgPrice) / d.buy.avgPrice * 100),
        grossDollar: round(grossDollar, 4),
        feeBuyPct: round(d.feeBuy * 100), feeSellPct: round(d.feeSell * 100),
        feeDollar: round(feeDollar, 4),
        slippageBps: g.slippageBps,
        slippageDollar: round(slipDollar, 4),
        netDollar: round(d.net, 4),
        netPct: round(netPct),
        breakevenPct: round((d.feeBuy + d.feeSell + 2 * slip) * 100),
        minProfitabilityPct,
        meetsBotThreshold: minProfitabilityPct == null ? null : netPct >= Number(minProfitabilityPct),
        reason: !depthOk ? 'Order book too thin for this order size'
          : pass ? `Nets $${d.net.toFixed(2)} (${netPct.toFixed(3)}%) per trade after fees and slippage`
            : `Loses $${Math.abs(d.net).toFixed(2)} (${netPct.toFixed(3)}%) per trade after fees and slippage`,
      };
    } else {
      perTrade = { pass: false, reason: 'Order book too thin to price this order size' };
    }

    if (scannerNetPct != null && perTrade.netPct != null) {
      const diff = Math.abs(Number(scannerNetPct) - perTrade.netPct);
      add('scanner_agreement', 'Scanner estimate agrees with verified order-book result', diff > 0.25 ? 'warn' : 'pass',
        `Scanner ${Number(scannerNetPct).toFixed(3)}% vs verified ${perTrade.netPct.toFixed(3)}% (diff ${diff.toFixed(3)} pts)`);
    }
  }

  // ── Calculation 2: monthly, including server and transaction costs ──
  const tradeSize = perTrade.tradeSize || Number(tradeSizeIn) || 0;
  const coin = stats && stats.coin ? stats.coin : null;
  const observedHours = stats ? Number(stats.observedHours) || 0 : 0;
  const observed = !!coin && observedHours >= 1;
  const capture = Math.max(0, Math.min(100, Number(g.captureRatePct) || 0)) / 100;
  const tradesPerMonth = observed
    ? coin.episodesPerHour * 24 * 30 * capture
    : (Number(g.fallbackTradesPerDay) || 0) * 30 * capture;
  const netPctForMonthly = observed && coin.episodes > 0 ? coin.avgNetViable : (perTrade.netPct ?? 0);
  // Fee schedule even when books were unavailable (taker both legs unless priced)
  const feePctTotal = perTrade.feeBuyPct != null
    ? perTrade.feeBuyPct + perTrade.feeSellPct
    : ((((fees[exA] || {}).taker) ?? 0.001) + (((fees[exB] || {}).taker) ?? 0.001)) * 100;
  const slipPctTotal = 2 * (Number(g.slippageBps) || 0) / 100;
  const netPerTrade = tradeSize * netPctForMonthly / 100;
  const feesMonthly = tradeSize * feePctTotal / 100 * tradesPerMonth;
  const slippageMonthly = tradeSize * slipPctTotal / 100 * tradesPerMonth;
  const rebalanceMonthly = Math.max(0, Number(g.rebalanceMonthlyUsd) || 0);
  const serverMonthly = Math.max(0, Number(server.allocatedMonthlyUsd) || 0);
  const tradingNetMonthly = netPerTrade * tradesPerMonth;
  const monthlyNet = tradingNetMonthly - rebalanceMonthly - serverMonthly;
  const monthlyPass = tradesPerMonth > 0 && monthlyNet > 0;
  const monthly = {
    pass: monthlyPass,
    source: observed ? 'observed' : 'assumed',
    observedHours: round(observedHours, 2),
    episodesPerHour: observed ? round(coin.episodesPerHour, 3) : null,
    captureRatePct: g.captureRatePct,
    tradesPerMonth: round(tradesPerMonth, 1),
    netPctPerTrade: round(netPctForMonthly),
    netPerTrade: round(netPerTrade, 4),
    tradingNetMonthly: round(tradingNetMonthly, 2),
    feesMonthly: round(feesMonthly, 2),
    slippageMonthly: round(slippageMonthly, 2),
    rebalanceMonthly: round(rebalanceMonthly, 2),
    transactionCostsMonthly: round(feesMonthly + slippageMonthly + rebalanceMonthly, 2),
    serverMonthly: round(serverMonthly, 2),
    serverSource: server.source || 'estimate',
    serverDetail: server.detail || '',
    monthlyNet: round(monthlyNet, 2),
    reason: tradesPerMonth <= 0
      ? `No profitable opportunities seen in ${observedHours.toFixed(1)}h of scanner history for this coin`
      : monthlyPass
        ? `Nets $${monthlyNet.toFixed(2)}/month after $${serverMonthly.toFixed(2)} server and $${rebalanceMonthly.toFixed(2)} rebalancing`
        : `Loses $${Math.abs(monthlyNet).toFixed(2)}/month after $${serverMonthly.toFixed(2)} server and $${rebalanceMonthly.toFixed(2)} rebalancing`,
  };
  if (!observed) {
    add('history', 'Scanner history for this coin (>= 1h)', 'warn',
      `Only ${observedHours.toFixed(2)}h observed — monthly figure assumes ${g.fallbackTradesPerDay} signals/day. Run the Live Scanner longer for real rates.`);
  }

  const dataOk = !checks.some(c => c.status === 'fail');
  const profitableBoth = perTrade.pass && monthly.pass;
  const blockers = [
    ...checks.filter(c => c.status === 'fail').map(c => `${c.label}: ${c.detail}`),
    ...(perTrade.pass ? [] : [`Per-trade: ${perTrade.reason}`]),
    ...(monthly.pass ? [] : [`Monthly: ${monthly.reason}`]),
  ];

  return {
    id: `cc_${crypto.randomBytes(4).toString('hex')}`,
    checkedAt: Date.now(),
    symbol, quote, exA, exB, strategy,
    pair: `${symbol}-${quote}`,
    refPrice: round(refPrice, 8),
    prices,
    reference: { median: round(refMid, 8), sources: references },
    perTrade,
    monthly,
    checks,
    dataOk,
    profitableBoth,
    allowed: dataOk && profitableBoth,
    blockers,
  };
}

// ─── 2. Network layer ────────────────────────────────────────────────────────
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

async function fetchVenue(ex, symbol, quote) {
  const out = { ticker: null, tickerError: null, book: null, bookError: null };
  const [q, book] = await Promise.all([
    getQuotes(ex, quote).catch(e => ({ quotes: {}, error: e.message })),
    getOrderBook(ex, symbol, quote).catch(e => ({ error: e.response ? `HTTP ${e.response.status}` : e.message })),
  ]);
  if (q.error) out.tickerError = q.error;
  if (q.quotes && q.quotes[symbol]) {
    const quotes = { [symbol]: { ...q.quotes[symbol] } };
    await refineQuotes(ex, quote, quotes, [symbol]).catch(() => {});
    out.ticker = quotes[symbol];
  } else if (!out.tickerError) out.tickerError = 'not listed in bulk ticker';
  if (book && book.error) out.bookError = book.error;
  else out.book = book;
  return out;
}

async function fetchReferences(symbol, quote, exclude) {
  const others = Object.keys(EXCHANGES).filter(ex => !exclude.includes(ex));
  const quotes = QUOTE_EQUIV[quote] || [quote];
  const res = await Promise.all(others.map(async ex => {
    for (const q of quotes) {
      try {
        const r = await withTimeout(getQuotes(ex, q), REF_TIMEOUT_MS);
        const t = r.quotes && r.quotes[symbol];
        if (!t) continue;
        const bid = t.bid || t.last, ask = t.ask || t.last;
        if (bid && ask) return { ex, label: EXCHANGES[ex].label, quote: q, mid: (bid + ask) / 2 };
      } catch (_) { return null; }
    }
    return null;
  }));
  return res.filter(Boolean);
}

function statsForCoin(exA, exB, quote, symbol) {
  for (const key of [`${exA}_${exB}|${quote}`, `${exB}_${exA}|${quote}`]) {
    const s = summarizeStats(key);
    if (s && s.scans > 0) return { key, observedHours: s.observedHours, coin: s.coins.find(c => c.coin === symbol) || null };
  }
  return { key: null, observedHours: 0, coin: null };
}

// Server cost allocated to one bot: the host's real monthly cost shared across its
// bots when entered; otherwise the estimated average server cost per bot.
function hostMonthlyCost(cfg, target) {
  if (target === 'local') return Number(cfg.local && cfg.local.monthlyCost) || 0;
  const srv = (cfg.servers || []).find(s => s.id === target);
  return srv ? Number(srv.monthlyCost) || 0 : 0;
}

async function countBotsOnHost(target) {
  try {
    const hb = require('./hummingbot');
    const list = await withTimeout(hb.listContainers(target, { includeStats: false }), 8000);
    return list.filter(c => c.state === 'running' && c.strategyLabel).length;
  } catch (_) { return 0; }
}

async function allocateServerCost(cfg, target = 'local', { pairId, botsOnHost } = {}) {
  const running = botsOnHost != null ? botsOnHost : await countBotsOnHost(target);
  const bots = Math.max(1, running + 1);
  const hostCost = hostMonthlyCost(cfg, target);
  if (hostCost > 0) {
    return {
      allocatedMonthlyUsd: hostCost / bots, source: 'host', botsSharing: bots,
      detail: `$${hostCost}/mo host cost shared by ${bots} bot(s)`,
    };
  }
  const est = estimateServerCost({ bots, pairId });
  return {
    allocatedMonthlyUsd: est.perBotMonthlyUsd, source: 'estimate', botsSharing: bots, estimate: est,
    detail: `Estimated avg server cost $${est.avgMonthlyUsd}/mo for ${bots} bot(s) (${est.basis.map(b => b.name).join(', ')}) → $${est.perBotMonthlyUsd}/bot`,
  };
}

const history = [];
async function runCrossCheck({
  symbol, quote = 'USD', exA, exB, strategy = 'amm_arb', tradeSize, baseAmount,
  target = 'local', minProfitabilityPct = null, scannerNetPct = null, botsOnHost, record = true,
} = {}) {
  const cfg = loadConfig();
  const sym = String(symbol || '').trim().toUpperCase();
  const q = String(quote || 'USD').trim().toUpperCase();
  if (!sym) throw Object.assign(new Error('symbol required'), { status: 400 });
  if (!EXCHANGES[exA] || !EXCHANGES[exB] || exA === exB) throw Object.assign(new Error('two different supported exchanges required'), { status: 400 });

  const [va, vb, references, server] = await Promise.all([
    fetchVenue(exA, sym, q),
    fetchVenue(exB, sym, q),
    fetchReferences(sym, q, [exA, exB]),
    allocateServerCost(cfg, target, { pairId: `${exA}_${exB}`, botsOnHost }),
  ]);
  const result = evaluateCrossCheck({
    symbol: sym, quote: q, exA, exB, strategy,
    fees: cfg.fees, guard: guardSettings(cfg),
    tradeSize, baseAmount,
    venues: { [exA]: va, [exB]: vb },
    references, stats: statsForCoin(exA, exB, q, sym), server,
    minProfitabilityPct, scannerNetPct,
    tickerBlocks: [blockedReason(exA, sym, q), blockedReason(exB, sym, q)].filter(Boolean),
  });
  result.target = target;
  if (record) {
    history.unshift({
      id: result.id, checkedAt: result.checkedAt, pair: result.pair, exA, exB, strategy, target,
      allowed: result.allowed, dataOk: result.dataOk,
      netPct: result.perTrade.netPct ?? null, monthlyNet: result.monthly.monthlyNet,
    });
    if (history.length > 30) history.length = 30;
  }
  return result;
}

// ─── 3. Deploy gate ──────────────────────────────────────────────────────────
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}
function writeJson(file, data) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(file, JSON.stringify(data, null, 2)); }
  catch (e) { console.error(`guard: write ${path.basename(file)} failed:`, e.message); }
}
function audit(entry) {
  const list = readJson(AUDIT_FILE, []);
  list.unshift({ ts: Date.now(), ...entry });
  writeJson(AUDIT_FILE, list.slice(0, 200));
}

class GateError extends Error {
  constructor(message, status, extra = {}) { super(message); this.status = status; Object.assign(this, extra); }
}

function describeStrategy(parsed) {
  const doc = parsed.doc || {};
  const isXemm = parsed.strategy === 'cross_exchange_market_making';
  const [c1, c2] = isXemm ? [doc.maker_market, doc.taker_market] : [doc.connector_1, doc.connector_2];
  const [symbol, quote] = String(parsed.pair || '').split('-');
  const exA = exchangeFromConnector(c1);
  return {
    strategy: parsed.strategy,
    supported: parsed.strategy === 'amm_arb' || isXemm,
    exA,
    exB: exchangeFromConnector(c2),
    // market_1 is named the way connector 1's exchange names it; compare on the canonical ticker
    symbol: exA ? canonical(exA, symbol || '') : (symbol || '').toUpperCase(),
    quote: (quote || '').toUpperCase(),
    baseAmount: Number(parsed.orderAmount) || 0,
    minProfitabilityPct: parsed.minProfitability != null ? Number(parsed.minProfitability) : null,
    live: !parsed.paper,
  };
}

function confirmationPhrase(info) {
  return `${info.symbol}-${info.quote} LIVE`;
}

// Hard rules for live bots. These cannot be overridden from the deploy dialog;
// change them deliberately in the guard-rail settings instead.
function liveGuardViolations(info, refPrice, g) {
  const v = [];
  const notional = refPrice ? info.baseAmount * refPrice : null;
  if (notional != null && notional > g.liveMaxOrderUsd) {
    v.push(`Order size ~$${notional.toFixed(2)} exceeds the live max of $${g.liveMaxOrderUsd}`);
  }
  if (info.minProfitabilityPct == null || info.minProfitabilityPct < g.liveMinProfitabilityPct) {
    v.push(`min_profitability ${info.minProfitabilityPct ?? 'unset'}% is below the live floor of ${g.liveMinProfitabilityPct}%`);
  }
  if (!(Number(g.liveStopLossPct) > 0 && Number(g.liveStopLossPct) <= 50)) v.push('Live stop-loss % must be between 0 and 50');
  if (!(Number(g.liveMaxLossUsd) > 0)) v.push('Live max loss ($) must be greater than 0');
  return v;
}

// Returns { check, info, overridden } or throws GateError (409 = needs confirmation, 400 = hard rule)
async function gateDeploy(target, { configName, yaml: yamlText, override } = {}) {
  const cfg = loadConfig();
  const g = guardSettings(cfg);
  const parsed = parseStrategyYaml(yamlText);
  if (!parsed.valid) throw new GateError(`Invalid strategy YAML: ${parsed.error}`, 400);
  const info = describeStrategy(parsed);
  const phrase = confirmationPhrase(info);

  let check = null;
  let reasons = [];
  if (!info.supported || !info.exA || !info.exB || !info.symbol || !info.quote) {
    reasons = [`Cannot cross-check this strategy automatically (${info.strategy}; connectors ${info.exA || '?'} / ${info.exB || '?'})`];
  } else {
    check = await runCrossCheck({
      symbol: info.symbol, quote: info.quote, exA: info.exA, exB: info.exB,
      strategy: info.strategy, baseAmount: info.baseAmount, target,
      minProfitabilityPct: info.minProfitabilityPct,
    });
    reasons = check.blockers;
  }

  if (info.live) {
    const violations = liveGuardViolations(info, check && check.refPrice, g);
    if (violations.length) {
      audit({ action: 'blocked_guard_rail', target, configName, pair: `${info.symbol}-${info.quote}`, live: true, reasons: violations });
      throw new GateError(`Live guard rails: ${violations.join('; ')}`, 400, { guardViolations: violations, check });
    }
  }

  const allowed = !!(check && check.allowed);
  let overridden = false;
  if (!allowed) {
    const ok = override && override.confirmed === true
      && (!info.live || String(override.phrase || '').trim().toUpperCase() === phrase.toUpperCase());
    if (!ok) {
      audit({ action: 'blocked', target, configName, pair: `${info.symbol}-${info.quote}`, live: info.live, reasons });
      throw new GateError(
        `Blocked: not verified profitable. ${reasons.slice(0, 3).join(' | ')}`,
        409,
        { blocked: true, check, reasons, requiresConfirmation: { live: info.live, phrase: info.live ? phrase : null } },
      );
    }
    overridden = true;
  }
  audit({
    action: overridden ? 'override' : 'allowed', target, configName, pair: `${info.symbol}-${info.quote}`,
    live: info.live, reasons: overridden ? reasons : [],
    netPct: check ? check.perTrade.netPct ?? null : null, monthlyNet: check ? check.monthly.monthlyNet : null,
  });
  return { check, info, overridden };
}

// ─── 4. Live stop-loss monitor ───────────────────────────────────────────────
class GuardMonitor {
  constructor() {
    this.bots = readJson(BOTS_FILE, {});
    this.timer = null;
    this.running = false;
    this.lastRunAt = null;
    this.lastError = null;
  }

  save() { writeJson(BOTS_FILE, this.bots); }
  list() { return Object.values(this.bots).sort((a, b) => b.registeredAt - a.registeredAt); }

  async register({ target, containerName, configName, info }) {
    const g = guardSettings();
    let baselinePnl = 0;
    try {
      const hb = require('./hummingbot');
      const pnl = await hb.getTradesAndPnl(target);
      baselinePnl = (pnl.byPairLive[`${info.symbol}-${info.quote}`] || {}).netMatchedPnl || 0;
    } catch (_) { /* no trade files yet */ }
    const key = `${target}:${containerName}`;
    this.bots[key] = {
      key, target, containerName, configName,
      pair: `${info.symbol}-${info.quote}`, symbol: info.symbol, quote: info.quote,
      exA: info.exA, exB: info.exB, strategy: info.strategy,
      maxLossUsd: g.liveMaxLossUsd, stopLossPct: g.liveStopLossPct,
      baselinePnl, sessionPnl: 0, status: 'active',
      registeredAt: Date.now(), lastCheckAt: null, lastPriceAlertAt: 0, lastNote: '',
    };
    this.save();
    this.sync();
    return this.bots[key];
  }

  remove(key) { delete this.bots[key]; this.save(); this.sync(); }

  sync() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (!Object.values(this.bots).some(b => b.status === 'active')) return;
    const ms = Math.max(15, Number(guardSettings().monitorIntervalSec) || 60) * 1000;
    this.timer = setInterval(() => { this.tick().catch(e => { this.lastError = e.message; }); }, ms);
    this.timer.unref();
  }

  async notify(title, message, symbol) {
    const { alertManager } = require('./alerts');
    const cfg = loadConfig();
    await alertManager.recordAndNotify({
      id: `al_${crypto.randomBytes(5).toString('hex')}`, ts: Date.now(), isTest: false, read: false,
      kind: 'guard', symbol, netProfitPct: 1, title, message,
    }, cfg.alerts);
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    const hb = require('./hummingbot');
    const g = guardSettings();
    try {
      const active = Object.values(this.bots).filter(b => b.status === 'active');
      const byTarget = {};
      for (const b of active) (byTarget[b.target] = byTarget[b.target] || []).push(b);

      for (const [target, bots] of Object.entries(byTarget)) {
        let containers = [], pnl = null;
        try { containers = await hb.listContainers(target, { includeStats: false }); } catch (e) { this.lastError = e.message; continue; }
        try { pnl = await hb.getTradesAndPnl(target); } catch (_) { pnl = null; }

        for (const b of bots) {
          b.lastCheckAt = Date.now();
          const c = containers.find(x => x.name === b.containerName);
          if (!c || c.state !== 'running') { b.status = 'stopped'; b.lastNote = 'Container is no longer running'; continue; }

          const cur = pnl ? ((pnl.byPairLive[b.pair] || {}).netMatchedPnl || 0) : null;
          if (cur != null) b.sessionPnl = Number((cur - b.baselinePnl).toFixed(4));
          if (cur != null && b.sessionPnl <= -Math.abs(b.maxLossUsd)) {
            try { await hb.containerAction(target, b.containerName, 'stop'); b.lastNote = 'Stopped by stop-loss'; }
            catch (e) { b.lastNote = `Stop-loss hit but stop failed: ${e.message}`; }
            b.status = 'tripped';
            b.trippedAt = Date.now();
            audit({ action: 'stop_loss', target, configName: b.configName, pair: b.pair, live: true, reasons: [`Realized loss $${b.sessionPnl} reached limit -$${b.maxLossUsd}`] });
            await this.notify(`STOP-LOSS: ${b.pair} bot stopped`,
              `${b.containerName} on ${target} lost $${Math.abs(b.sessionPnl).toFixed(2)} (limit $${b.maxLossUsd}). Container stopped. Review before restarting.`, b.symbol).catch(() => {});
            continue;
          }

          if (g.autoRecheckEnabled && b.exA && b.exB) {
            try {
              const chk = await runCrossCheck({ symbol: b.symbol, quote: b.quote, exA: b.exA, exB: b.exB, strategy: b.strategy, target, record: false });
              b.lastDataOk = chk.dataOk;
              b.lastNetPct = chk.perTrade.netPct ?? null;
              if (!chk.dataOk && Date.now() - (b.lastPriceAlertAt || 0) > 30 * 60 * 1000) {
                b.lastPriceAlertAt = Date.now();
                const failed = chk.checks.filter(x => x.status === 'fail').map(x => x.label).join('; ');
                await this.notify(`PRICE CHECK FAILED: ${b.pair} (live bot running)`,
                  `${b.containerName} on ${target}: ${failed}. The bot is still running — check prices and stop it if needed.`, b.symbol).catch(() => {});
              }
            } catch (e) { b.lastNote = `Price re-check error: ${e.message}`; }
          }
        }
      }
      this.lastRunAt = Date.now();
      this.lastError = null;
    } finally {
      this.running = false;
      this.save();
      this.sync();
    }
  }

  status() {
    return { bots: this.list(), lastRunAt: this.lastRunAt, lastError: this.lastError, intervalSec: guardSettings().monitorIntervalSec };
  }
}

const monitor = new GuardMonitor();
monitor.sync();

function updateGuardSettings(patch = {}) {
  const num = (v, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : undefined; };
  const limits = {
    slippageBps: [0, 200], captureRatePct: [1, 100], fallbackTradesPerDay: [0, 500], rebalanceMonthlyUsd: [0, 10000],
    maxRefDeviationPct: [0.1, 50], maxTickerDriftPct: [0.05, 20], maxGrossSpreadPct: [0.5, 100],
    liveStopLossPct: [0.5, 50], liveMaxLossUsd: [1, 1e6], liveMaxOrderUsd: [10, 1e7],
    liveMinProfitabilityPct: [0.01, 10], monitorIntervalSec: [15, 3600],
  };
  const cfg = updateConfig(c => {
    c.guard = { ...DEFAULT_GUARD, ...(c.guard || {}) };
    for (const [k, [lo, hi]] of Object.entries(limits)) {
      if (patch[k] !== undefined && patch[k] !== '') { const n = num(patch[k], lo, hi); if (n !== undefined) c.guard[k] = n; }
    }
    if (patch.autoRecheckEnabled !== undefined) c.guard.autoRecheckEnabled = !!patch.autoRecheckEnabled;
  });
  monitor.sync();
  return cfg.guard;
}

module.exports = {
  evaluateCrossCheck,
  runCrossCheck,
  gateDeploy,
  liveGuardViolations,
  describeStrategy,
  exchangeFromConnector,
  confirmationPhrase,
  allocateServerCost,
  updateGuardSettings,
  guardSettings,
  monitor,
  history,
  readAudit: () => readJson(AUDIT_FILE, []),
  GateError,
};
