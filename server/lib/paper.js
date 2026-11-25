// ─── Built-in Paper Trading & Processing Accuracy Simulator ──────────────────
// Validates scanner signals against LIVE L2 order books after a configurable
// execution latency delay, measuring:
//   • Real simulated P&L (after fees + real orderbook VWAP slippage)
//   • Signal-to-fill survival rate (how often opportunities survive latency)
//   • Scanner quote accuracy (predicted vs actual VWAP drift in bps)
//   • Profit capture ratio (actual book-walked profit / predicted top-of-book profit)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getOrderBook, vwapFill } = require('./exchanges');
const { runScan } = require('./scanner');
const { loadConfig } = require('./config');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'paper_state.json');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Single-shot L2 orderbook verification for a specific coin/opportunity
async function verifyOpportunity({
  exA, exB, symbol, quote = 'USD', tradeSize = 1000,
  fees, feeMode = 'taker_taker', simulatedLatencyMs = 250,
  predictedBuyOn = null, predictedSellOn = null,
  predictedBuyPrice = null, predictedSellPrice = null, predictedNetDollar = null,
}) {
  const cfgFees = fees || loadConfig().fees;
  const tStart = Date.now();
  if (simulatedLatencyMs > 0) await sleep(Math.min(simulatedLatencyMs, 5000));
  const tBookStart = Date.now();

  const [bookA, bookB] = await Promise.all([
    getOrderBook(exA, symbol, quote),
    getOrderBook(exB, symbol, quote),
  ]);
  const bookFetchMs = Date.now() - tBookStart;

  if (!bookA.asks.length || !bookA.bids.length || !bookB.asks.length || !bookB.bids.length) {
    throw new Error(`Empty order book on ${exA} or ${exB} for ${symbol}-${quote}`);
  }

  // Decide direction: follow predicted direction if supplied, else pick best executable side
  let buyOn = predictedBuyOn;
  let sellOn = predictedSellOn;
  if (!buyOn || !sellOn) {
    const gAB = (bookB.bids[0][0] - bookA.asks[0][0]) / bookA.asks[0][0];
    const gBA = (bookA.bids[0][0] - bookB.asks[0][0]) / bookB.asks[0][0];
    buyOn = gAB >= gBA ? exA : exB;
    sellOn = buyOn === exA ? exB : exA;
  }

  const buyBook = buyOn === exA ? bookA : bookB;
  const sellBook = sellOn === exA ? bookA : bookB;
  const topBuyAsk = buyBook.asks[0][0];
  const topSellBid = sellBook.bids[0][0];
  const baseAmount = tradeSize / (predictedBuyPrice || topBuyAsk);

  const buyFill = vwapFill(buyBook.asks, baseAmount);
  const sellFill = vwapFill(sellBook.bids, baseAmount);

  const fBuyObj = cfgFees[buyOn] || { maker: 0.001, taker: 0.001 };
  const fSellObj = cfgFees[sellOn] || { maker: 0.001, taker: 0.001 };
  const feeBuy = feeMode === 'maker_taker' ? fBuyObj.maker : fBuyObj.taker;
  const feeSell = fSellObj.taker;

  const actualBuy = buyFill.avgPrice || topBuyAsk;
  const actualSell = sellFill.avgPrice || topSellBid;
  const buyCost = baseAmount * actualBuy * (1 + feeBuy);
  const sellRev = baseAmount * actualSell * (1 - feeSell);
  const actualGrossDollar = baseAmount * (actualSell - actualBuy);
  const actualFeeDollar = baseAmount * actualBuy * feeBuy + baseAmount * actualSell * feeSell;
  const actualNetDollar = sellRev - buyCost;
  const actualNetPct = (actualNetDollar / tradeSize) * 100;

  // Slippage / drift compared to top-of-book & compared to predicted T0 price
  const bookImpactBuyBps = ((actualBuy - topBuyAsk) / topBuyAsk) * 10000;
  const bookImpactSellBps = ((topSellBid - actualSell) / topSellBid) * 10000;
  const driftBuyBps = predictedBuyPrice ? ((actualBuy - predictedBuyPrice) / predictedBuyPrice) * 10000 : bookImpactBuyBps;
  const driftSellBps = predictedSellPrice ? ((predictedSellPrice - actualSell) / predictedSellPrice) * 10000 : bookImpactSellBps;

  // Available depth within 25 bps of top-of-book
  const buyDepthUsd = buyBook.asks.filter(([p]) => p <= topBuyAsk * 1.0025).reduce((s, [p, sz]) => s + p * sz, 0);
  const sellDepthUsd = sellBook.bids.filter(([p]) => p >= topSellBid * 0.9975).reduce((s, [p, sz]) => s + p * sz, 0);

  return {
    symbol, quote, buyOn, sellOn, tradeSize, baseAmount, feeMode,
    simulatedLatencyMs,
    bookFetchMs,
    totalProcessingMs: Date.now() - tStart,
    predicted: predictedBuyPrice ? {
      buyPrice: predictedBuyPrice,
      sellPrice: predictedSellPrice,
      netDollar: predictedNetDollar,
    } : null,
    topOfBook: { buyAsk: topBuyAsk, sellBid: topSellBid },
    actual: {
      buyVwap: actualBuy,
      sellVwap: actualSell,
      buyLevels: buyFill.levelsUsed,
      sellLevels: sellFill.levelsUsed,
      complete: buyFill.complete && sellFill.complete,
      feeBuy, feeSell,
      grossDollar: actualGrossDollar,
      feeDollar: actualFeeDollar,
      netDollar: actualNetDollar,
      netPct: actualNetPct,
    },
    accuracy: {
      bookImpactBps: bookImpactBuyBps + bookImpactSellBps,
      totalDriftBps: driftBuyBps + driftSellBps,
      driftBuyBps,
      driftSellBps,
      profitErrorDollar: predictedNetDollar != null ? actualNetDollar - predictedNetDollar : null,
      stillProfitable: actualNetDollar > 0 && buyFill.complete && sellFill.complete,
      buyDepth25bpsUsd: Math.round(buyDepthUsd),
      sellDepth25bpsUsd: Math.round(sellDepthUsd),
    },
    timestamp: Date.now(),
  };
}

// ─── Continuous Paper Trading Engine (singleton session manager) ─────────────
class PaperEngine {
  constructor() {
    this.session = null;
    this.timer = null;
    this.ticking = false;
    this.cooldowns = new Map();
    this._load();
  }

  _load() {
    try {
      const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (saved && saved.id) {
        saved.running = false; // never auto-resume blindly after server restart
        this.session = saved;
      }
    } catch (_) { /* fresh */ }
  }

  _save() {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(STATE_FILE, JSON.stringify(this.session, null, 2));
    } catch (e) { console.error('paper state save failed:', e.message); }
  }

  start(opts = {}) {
    this.stop();
    const cfg = loadConfig();
    const exA = opts.exA || 'kraken';
    const exB = opts.exB || 'coinbase';
    const quote = opts.quote || 'USD';
    const startBal = Math.max(100, Number(opts.startingBalancePerEx) || 5000);

    this.session = {
      id: `paper_${crypto.randomBytes(4).toString('hex')}`,
      running: true,
      startedAt: Date.now(),
      stoppedAt: null,
      lastTickAt: null,
      tickCount: 0,
      lastError: null,
      config: {
        exA, exB, quote,
        coins: Array.isArray(opts.coins) && opts.coins.length ? opts.coins : null,
        tradeSize: Math.max(25, Number(opts.tradeSize) || 500),
        startingBalancePerEx: startBal,
        minNetProfitPct: Number.isFinite(Number(opts.minNetProfitPct)) ? Number(opts.minNetProfitPct) : 0.05,
        simulatedLatencyMs: Math.max(0, Math.min(5000, Number(opts.simulatedLatencyMs) || 350)),
        pollIntervalMs: Math.max(5000, Math.min(120000, Number(opts.pollIntervalMs) || 12000)),
        feeMode: opts.feeMode === 'maker_taker' ? 'maker_taker' : 'taker_taker',
        abortOnDecay: opts.abortOnDecay !== false,
        autoRebalance: opts.autoRebalance !== false,
        maxTradesPerTick: Math.max(1, Math.min(5, Number(opts.maxTradesPerTick) || 2)),
        fees: opts.fees || cfg.fees,
      },
      balances: {
        [exA]: startBal,
        [exB]: startBal,
      },
      stats: {
        signalsDetected: 0,
        filledTrades: 0,
        decayedSignals: 0,
        insufficientDepth: 0,
        insufficientBalance: 0,
        predictedProfitTotal: 0,
        actualProfitTotal: 0,
        blindExecutionProfitTotal: 0,
        totalFees: 0,
        totalVolume: 0,
        sumDriftBps: 0,
        sumBookImpactBps: 0,
        sumProcessingMs: 0,
        verifiedCount: 0,
      },
      equityCurve: [{ ts: Date.now(), pnl: 0, equity: startBal * 2, trades: 0 }],
      trades: [],
    };
    this.cooldowns.clear();
    this._save();
    this._schedule();
    return this.getState();
  }

  resume() {
    if (!this.session) throw new Error('No paper session exists to resume');
    this.session.running = true;
    this.session.stoppedAt = null;
    this._save();
    this._schedule();
    return this.getState();
  }

  stop() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.session) {
      this.session.running = false;
      this.session.stoppedAt = Date.now();
      this._save();
    }
    return this.getState();
  }

  reset() {
    this.stop();
    this.session = null;
    try { fs.rmSync(STATE_FILE, { force: true }); } catch (_) {}
    return this.getState();
  }

  _schedule() {
    if (this.timer) clearTimeout(this.timer);
    if (!this.session || !this.session.running) return;
    this.runTick().finally(() => {
      if (this.session && this.session.running) {
        this.timer = setTimeout(() => this._schedule(), this.session.config.pollIntervalMs);
        this.timer.unref();
      }
    });
  }

  async runTick({ forceTestTop = false } = {}) {
    if (!this.session || this.ticking) return this.getState();
    this.ticking = true;
    const s = this.session;
    const c = s.config;
    try {
      const scanFees = c.feeMode === 'maker_taker'
        ? Object.fromEntries(Object.entries(c.fees).map(([k, v]) => [k, { maker: v.maker, taker: (v.maker + v.taker) / 2 }]))
        : c.fees;

      const scan = await runScan({
        exA: c.exA, exB: c.exB, quote: c.quote, coins: c.coins,
        tradeSize: c.tradeSize, slippageBps: 0, fees: scanFees, refineTop: 20, record: true,
      });
      s.tickCount++;
      s.lastTickAt = Date.now();
      s.lastError = null;

      const now = Date.now();
      let candidates = scan.opportunities.filter(o => !o.estimated && o.netProfit >= c.minNetProfitPct);
      if (forceTestTop && candidates.length === 0 && scan.opportunities.length > 0) {
        candidates = [scan.opportunities[0]]; // explicit accuracy test tick
      }
      candidates = candidates.filter(o => (now - (this.cooldowns.get(o.symbol) || 0)) >= 20000).slice(0, c.maxTradesPerTick);

      for (const opp of candidates) {
        this.cooldowns.set(opp.symbol, now);
        s.stats.signalsDetected++;
        try {
          const check = await verifyOpportunity({
            exA: c.exA, exB: c.exB, symbol: opp.symbol, quote: c.quote,
            tradeSize: c.tradeSize, fees: c.fees, feeMode: c.feeMode,
            simulatedLatencyMs: c.simulatedLatencyMs,
            predictedBuyOn: opp.buyOn, predictedSellOn: opp.sellOn,
            predictedBuyPrice: opp.buyPrice, predictedSellPrice: opp.sellPrice,
            predictedNetDollar: opp.netDollar,
          });

          s.stats.verifiedCount++;
          s.stats.sumDriftBps += check.accuracy.totalDriftBps;
          s.stats.sumBookImpactBps += check.accuracy.bookImpactBps;
          s.stats.sumProcessingMs += check.totalProcessingMs;
          s.stats.predictedProfitTotal += opp.netDollar;

          let outcome = 'FILLED';
          let realizedDelta = 0;

          if (!check.actual.complete) {
            outcome = 'INSUFFICIENT_DEPTH';
            s.stats.insufficientDepth++;
          } else if (!c.autoRebalance && (s.balances[check.buyOn] || 0) < c.tradeSize) {
            outcome = 'INSUFFICIENT_BALANCE';
            s.stats.insufficientBalance++;
          } else {
            s.stats.blindExecutionProfitTotal += check.actual.netDollar;
            if (c.abortOnDecay && check.actual.netDollar <= 0 && !forceTestTop) {
              outcome = 'DECAYED';
              s.stats.decayedSignals++;
            } else {
              outcome = check.actual.netDollar > 0 ? 'FILLED' : 'FILLED_LOSS';
              realizedDelta = check.actual.netDollar;
              s.stats.filledTrades++;
              s.stats.actualProfitTotal += realizedDelta;
              s.stats.totalFees += check.actual.feeDollar;
              s.stats.totalVolume += c.tradeSize * 2;
              if (c.autoRebalance) {
                s.balances[c.exA] += realizedDelta / 2;
                s.balances[c.exB] += realizedDelta / 2;
              } else {
                s.balances[check.buyOn] -= check.baseAmount * check.actual.buyVwap * (1 + check.actual.feeBuy);
                s.balances[check.sellOn] += check.baseAmount * check.actual.sellVwap * (1 - check.actual.feeSell);
              }
            }
          }

          s.trades.unshift({
            id: crypto.randomBytes(4).toString('hex'),
            ts: check.timestamp,
            symbol: opp.symbol,
            quote: c.quote,
            buyOn: check.buyOn,
            sellOn: check.sellOn,
            tradeSize: c.tradeSize,
            baseAmount: check.baseAmount,
            predictedBuy: opp.buyPrice,
            predictedSell: opp.sellPrice,
            predictedNetPct: opp.netProfit,
            predictedNetDollar: opp.netDollar,
            actualBuyVwap: check.actual.buyVwap,
            actualSellVwap: check.actual.sellVwap,
            actualNetPct: check.actual.netPct,
            actualNetDollar: check.actual.netDollar,
            feeDollar: check.actual.feeDollar,
            driftBps: check.accuracy.totalDriftBps,
            bookImpactBps: check.accuracy.bookImpactBps,
            processingMs: check.totalProcessingMs,
            outcome,
            realizedDelta,
          });
          if (s.trades.length > 250) s.trades.length = 250;

          const totalEq = Object.values(s.balances).reduce((a, b) => a + b, 0);
          s.equityCurve.push({ ts: check.timestamp, pnl: s.stats.actualProfitTotal, equity: totalEq, trades: s.stats.filledTrades });
          if (s.equityCurve.length > 300) s.equityCurve.shift();
        } catch (err) {
          s.lastError = `${opp.symbol}: ${err.message}`;
        }
      }
      this._save();
    } catch (e) {
      s.lastError = e.message;
    } finally {
      this.ticking = false;
    }
    return this.getState();
  }

  getState() {
    if (!this.session) return { active: false, session: null };
    const st = this.session.stats;
    const verified = st.verifiedCount || 0;
    const survived = this.session.trades.filter(t => t.actualNetDollar > 0).length;
    const startingTotal = this.session.config.startingBalancePerEx * 2;
    const currentTotal = Object.values(this.session.balances).reduce((a, b) => a + b, 0);
    const runtimeHours = Math.max((Date.now() - this.session.startedAt) / 3.6e6, 0.001);

    return {
      active: true,
      session: this.session,
      derived: {
        startingEquity: startingTotal,
        currentEquity: currentTotal,
        roiPct: startingTotal > 0 ? ((currentTotal - startingTotal) / startingTotal) * 100 : 0,
        runtimeHours,
        tradesPerDayRate: (st.filledTrades / runtimeHours) * 24,
        signalSurvivalPct: verified > 0 ? (survived / Math.min(verified, this.session.trades.length || 1)) * 100 : null,
        avgDriftBps: verified > 0 ? st.sumDriftBps / verified : null,
        avgBookImpactBps: verified > 0 ? st.sumBookImpactBps / verified : null,
        avgProcessingMs: verified > 0 ? Math.round(st.sumProcessingMs / verified) : null,
        profitCapturePct: st.predictedProfitTotal > 0 ? (st.actualProfitTotal / st.predictedProfitTotal) * 100 : null,
      },
    };
  }
}

const engine = new PaperEngine();

module.exports = { engine, verifyOpportunity };
