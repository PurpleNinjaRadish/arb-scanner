// ─── Opportunity engine + observed-opportunity statistics ─────────────────────
// Uses executable prices: BUY at the ask on one venue, SELL at the bid on the
// other, taker fees on both legs and a per-leg slippage allowance.
const fs = require('fs');
const path = require('path');
const { getQuotes, refineQuotes, health, EXCHANGES } = require('./exchanges');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STATS_FILE = path.join(DATA_DIR, 'opportunity_stats.json');
const MAX_GAP_MS = 60000; // gaps longer than this don't count as "observed" time

function evaluate(coin, qa, qb, exA, exB, fees, tradeSize, slippageBps) {
  const aBid = qa.bid || qa.last, aAsk = qa.ask || qa.last;
  const bBid = qb.bid || qb.last, bAsk = qb.ask || qb.last;
  if (!aBid || !aAsk || !bBid || !bAsk) return null;

  const g1 = (bBid - aAsk) / aAsk; // buy A, sell B
  const g2 = (aBid - bAsk) / bAsk; // buy B, sell A
  const buyOn = g1 >= g2 ? exA : exB;
  const sellOn = buyOn === exA ? exB : exA;
  const buyPrice = buyOn === exA ? aAsk : bAsk;
  const sellPrice = sellOn === exA ? aBid : bBid;
  const feeBuy = (fees[buyOn] || {}).taker ?? 0.001;
  const feeSell = (fees[sellOn] || {}).taker ?? 0.001;
  const slip = (slippageBps || 0) / 10000;

  const amount = tradeSize / buyPrice;
  const cost = tradeSize * (1 + feeBuy) * (1 + slip);
  const revenue = amount * sellPrice * (1 - feeSell) * (1 - slip);
  const netDollar = revenue - cost;
  const grossPct = (sellPrice - buyPrice) / buyPrice * 100;
  const midA = (aBid + aAsk) / 2, midB = (bBid + bAsk) / 2;
  const volA = qa.volQuote, volB = qb.volQuote;
  const minVol = volA && volB ? Math.min(volA, volB) : (volA || volB || null);
  const liq = minVol ? Math.min(1.2, Math.max(0.3, Math.log10(minVol) / 7)) : 0.8;
  const netPct = netDollar / tradeSize * 100;

  return {
    symbol: coin,
    priceA: midA, priceB: midB,
    bidA: aBid, askA: aAsk, bidB: bBid, askB: bAsk,
    buyOn, sellOn, buyPrice, sellPrice,
    midSpread: Math.abs(midA - midB) / Math.min(midA, midB) * 100,
    spread: grossPct,                 // executable gross spread (ask->bid)
    feePct: (feeBuy + feeSell) * 100,
    feeBuy, feeSell,
    slippagePct: slip * 2 * 100,
    breakevenPct: (feeBuy + feeSell + 2 * slip) * 100,
    netProfit: netPct,
    grossDollar: amount * (sellPrice - buyPrice),
    feeDollar: tradeSize * feeBuy + amount * sellPrice * feeSell,
    netDollar,
    coinsTraded: amount,
    volA, volB, minVol,
    estimated: !(qa.book && qb.book),
    isViable: netPct > 0,
    score: netPct * liq,
    tradeSize,
  };
}

async function runScan({ exA, exB, quote = 'USD', coins = null, tradeSize = 1000, slippageBps = 5, fees, refineTop = 25, record = true }) {
  if (!EXCHANGES[exA] || !EXCHANGES[exB]) throw new Error('Invalid exchange pair');
  const [ra, rb] = await Promise.all([getQuotes(exA, quote), getQuotes(exB, quote)]);
  const qa = { ...ra.quotes }, qb = { ...rb.quotes };
  const common = Object.keys(qa).filter(c => qb[c]);
  const wanted = coins && coins.length ? coins.filter(c => qa[c] && qb[c]) : common;

  let opps = wanted.map(c => evaluate(c, qa[c], qb[c], exA, exB, fees, tradeSize, slippageBps)).filter(Boolean);

  // Upgrade estimated (last-price) quotes to real bid/ask for the best candidates
  const needRefine = opps.filter(o => o.estimated).sort((x, y) => y.midSpread - x.midSpread).slice(0, refineTop).map(o => o.symbol);
  if (needRefine.length) {
    await Promise.all([refineQuotes(exA, quote, qa, needRefine), refineQuotes(exB, quote, qb, needRefine)]);
    const set = new Set(needRefine);
    opps = opps.map(o => set.has(o.symbol) ? (evaluate(o.symbol, qa[o.symbol], qb[o.symbol], exA, exB, fees, tradeSize, slippageBps) || o) : o);
  }
  opps.sort((x, y) => y.netProfit - x.netProfit);

  const timestamp = Date.now();
  if (record) recordStats(`${exA}_${exB}|${quote}`, opps, timestamp);
  return {
    opportunities: opps,
    meta: {
      exA, exB, quote, timestamp,
      coinsRequested: coins ? coins.length : null,
      coinsAvailable: { [exA]: Object.keys(qa).length, [exB]: Object.keys(qb).length, common: common.length },
      coinsMatched: opps.length,
      refined: needRefine.length,
      errors: { [exA]: ra.error, [exB]: rb.error },
      health: { [exA]: health[exA] || null, [exB]: health[exB] || null },
    },
  };
}

// ─── Stats ───────────────────────────────────────────────────────────────────
let stats = {};
let dirty = false;
try { stats = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')); } catch (_) { stats = {}; }

function recordStats(key, opps, ts) {
  const s = stats[key] || (stats[key] = { scans: 0, firstAt: ts, lastAt: 0, observedMs: 0, coins: {} });
  const gap = s.lastAt ? ts - s.lastAt : 0;
  const counted = gap > 0 && gap <= MAX_GAP_MS ? gap : 0;
  s.scans++; s.observedMs += counted; s.lastAt = ts;
  for (const o of opps) {
    const c = s.coins[o.symbol] || (s.coins[o.symbol] = { samples: 0, viable: 0, episodes: 0, inEpisode: false, sumNetViable: 0, maxNet: -Infinity, viableMs: 0, sumSpread: 0, lastViableAt: 0 });
    c.samples++; c.sumSpread += o.midSpread;
    c.maxNet = Math.max(c.maxNet, o.netProfit);
    if (o.isViable && !o.estimated) {
      c.viable++; c.sumNetViable += o.netProfit; c.lastViableAt = ts;
      if (c.inEpisode) c.viableMs += counted; else { c.episodes++; c.inEpisode = true; }
    } else c.inEpisode = false;
  }
  dirty = true;
}

function summarizeStats(key) {
  const s = stats[key];
  if (!s) return { key, scans: 0, observedHours: 0, coins: [], totals: { episodesPerHour: 0, avgNetViable: 0 } };
  const hours = s.observedMs / 3.6e6;
  const coins = Object.entries(s.coins).map(([coin, c]) => ({
    coin, samples: c.samples, viablePct: c.samples ? c.viable / c.samples * 100 : 0,
    episodes: c.episodes, episodesPerHour: hours > 0 ? c.episodes / hours : 0,
    avgNetViable: c.viable ? c.sumNetViable / c.viable : 0,
    maxNet: Number.isFinite(c.maxNet) ? c.maxNet : null,
    avgMidSpread: c.samples ? c.sumSpread / c.samples : 0,
    viableMinutes: c.viableMs / 60000,
  })).sort((a, b) => b.episodes - a.episodes || b.maxNet - a.maxNet);
  const viableCoins = coins.filter(c => c.episodes > 0);
  const totalEpisodes = viableCoins.reduce((t, c) => t + c.episodes, 0);
  const avgNetViable = totalEpisodes ? viableCoins.reduce((t, c) => t + c.avgNetViable * c.episodes, 0) / totalEpisodes : 0;
  return {
    key, scans: s.scans, firstAt: s.firstAt, lastAt: s.lastAt, observedHours: hours,
    coins,
    totals: { episodes: totalEpisodes, episodesPerHour: hours > 0 ? totalEpisodes / hours : 0, avgNetViable, viableCoins: viableCoins.length },
  };
}

function resetStats(key) { if (key) delete stats[key]; else stats = {}; dirty = true; }
function listStatKeys() { return Object.keys(stats); }

function flushStats() {
  if (!dirty) return;
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(STATS_FILE, JSON.stringify(stats)); dirty = false; } catch (e) { console.error('stats flush failed', e.message); }
}
setInterval(flushStats, 30000).unref();

module.exports = { evaluate, runScan, summarizeStats, resetStats, listStatKeys, flushStats };
