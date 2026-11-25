// ─── Unified Account Holdings & Transactions Watcher ─────────────────────────
// Aggregates:
//   1. Live exchange accounts via CCXT (read-only API keys recommended)
//   2. Hummingbot paper balances (conf/conf_client.yml) & trades (*_trades.csv)
//   3. Built-in Paper Lab virtual wallets & L2-verified paper fills
const crypto = require('crypto');
const { loadConfig, updateConfig } = require('./config');
const { getBulk, EXCHANGES } = require('./exchanges');
const hb = require('./hummingbot');
const { engine: paperEngine } = require('./paper');

const STABLES = new Set(['USD', 'USDT', 'USDC', 'USDG', 'PYUSD', 'DAI', 'USDS', 'FDUSD', 'BUSD', 'TUSD']);

let _ccxt = null;
function getCcxt() {
  if (!_ccxt) _ccxt = require('ccxt');
  return _ccxt;
}

const CCXT_CLASS = {
  kraken: 'kraken',
  coinbase: 'coinbase',
  binance: 'binance',
  binanceus: 'binanceus',
  kucoin: 'kucoin',
  bybit: 'bybit',
  okx: 'okx',
};

// Build a unified USD price lookup table from public Kraken + Coinbase feeds
async function buildUsdPriceMap() {
  const prices = {};
  for (const s of STABLES) prices[s] = 1.0;

  const sources = await Promise.allSettled([getBulk('kraken'), getBulk('coinbase')]);
  for (const r of sources) {
    if (r.status !== 'fulfilled' || !r.value) continue;
    for (const q of ['USD', 'USDT', 'USDC']) {
      const bucket = r.value[q] || {};
      for (const [coin, quote] of Object.entries(bucket)) {
        if (prices[coin]) continue;
        const p = quote.bid && quote.ask ? (quote.bid + quote.ask) / 2 : quote.last;
        if (p && p > 0) prices[coin] = p;
      }
    }
  }
  return prices;
}

function makeCcxtClient(acct) {
  const ccxt = getCcxt();
  const clsName = CCXT_CLASS[acct.exchange];
  if (!clsName || !ccxt[clsName]) throw new Error(`Unsupported exchange: ${acct.exchange}`);
  const opts = {
    apiKey: acct.apiKey,
    secret: String(acct.apiSecret || '').replace(/\\n/g, '\n'),
    enableRateLimit: true,
    timeout: 12000,
  };
  if (acct.passphrase) opts.password = acct.passphrase;
  const ex = new ccxt[clsName](opts);
  if (acct.sandbox && typeof ex.setSandboxMode === 'function') ex.setSandboxMode(true);
  return ex;
}

async function fetchLiveAccount(acct, priceMap, { includeTransactions = true } = {}) {
  const out = {
    id: acct.id,
    source: 'live',
    exchange: acct.exchange,
    label: acct.label || (EXCHANGES[acct.exchange]?.label || acct.exchange),
    status: 'ok',
    error: null,
    totalUsd: 0,
    holdings: [],
    openOrders: [],
    transactions: [],
  };

  let ex;
  try {
    ex = makeCcxtClient(acct);
    const bal = await ex.fetchBalance();
    const totals = bal.total || {};
    const frees = bal.free || {};
    const useds = bal.used || {};

    for (const [assetRaw, tot] of Object.entries(totals)) {
      const total = Number(tot) || 0;
      if (total <= 1e-10) continue;
      const asset = assetRaw.toUpperCase();
      const priceUsd = priceMap[asset] || 0;
      const valueUsd = total * priceUsd;
      out.totalUsd += valueUsd;
      out.holdings.push({
        asset,
        total,
        free: Number(frees[assetRaw]) || 0,
        used: Number(useds[assetRaw]) || 0,
        priceUsd,
        valueUsd,
      });
    }
    out.holdings.sort((a, b) => b.valueUsd - a.valueUsd || b.total - a.total);
    out.holdings.forEach(h => { h.pct = out.totalUsd > 0 ? (h.valueUsd / out.totalUsd) * 100 : 0; });

    if (includeTransactions) {
      // Open orders
      if (ex.has && ex.has.fetchOpenOrders) {
        try {
          const orders = await ex.fetchOpenOrders(undefined, undefined, 40);
          for (const o of orders || []) {
            out.openOrders.push({
              id: o.id,
              ts: o.timestamp || Date.now(),
              account: out.label,
              exchange: acct.exchange,
              symbol: o.symbol,
              side: String(o.side || '').toUpperCase(),
              type: o.type || 'limit',
              price: Number(o.price) || 0,
              amount: Number(o.amount) || 0,
              filled: Number(o.filled) || 0,
              remaining: Number(o.remaining) || 0,
              status: o.status || 'open',
            });
          }
        } catch (_) { /* exchange may require symbol */ }
      }

      // Recent trades / fills
      if (ex.has && ex.has.fetchMyTrades) {
        try {
          const trades = await ex.fetchMyTrades(undefined, undefined, 50);
          for (const t of trades || []) {
            const feeUsd = t.fee ? (STABLES.has(String(t.fee.currency || '').toUpperCase()) ? Number(t.fee.cost) || 0 : (Number(t.fee.cost) || 0) * (priceMap[String(t.fee.currency || '').toUpperCase()] || 0)) : 0;
            out.transactions.push({
              id: `${acct.id}_tr_${t.id || t.timestamp}`,
              ts: t.timestamp || Date.now(),
              source: 'live',
              account: out.label,
              exchange: acct.exchange,
              type: 'TRADE',
              side: String(t.side || '').toUpperCase(),
              symbol: t.symbol || '',
              amount: Number(t.amount) || 0,
              price: Number(t.price) || 0,
              valueUsd: Number(t.cost) || ((Number(t.amount) || 0) * (Number(t.price) || 0)),
              feeUsd,
              status: 'filled',
            });
          }
        } catch (_) { /* skip if exchange requires explicit symbol */ }
      }

      // Deposits & Withdrawals
      for (const [kind, cap, method] of [['DEPOSIT', 'fetchDeposits', 'fetchDeposits'], ['WITHDRAWAL', 'fetchWithdrawals', 'fetchWithdrawals']]) {
        if (ex.has && ex.has[cap]) {
          try {
            const rows = await ex[method](undefined, undefined, 25);
            for (const tx of rows || []) {
              const asset = String(tx.currency || '').toUpperCase();
              const amt = Number(tx.amount) || 0;
              out.transactions.push({
                id: `${acct.id}_${kind}_${tx.id || tx.timestamp}`,
                ts: tx.timestamp || Date.now(),
                source: 'live',
                account: out.label,
                exchange: acct.exchange,
                type: kind,
                side: kind === 'DEPOSIT' ? 'IN' : 'OUT',
                symbol: asset,
                amount: amt,
                price: priceMap[asset] || 0,
                valueUsd: amt * (priceMap[asset] || 0),
                feeUsd: tx.fee ? (Number(tx.fee.cost) || 0) * (priceMap[asset] || 1) : 0,
                status: tx.status || 'ok',
              });
            }
          } catch (_) { /* permission or unsupported */ }
        }
      }
    }
  } catch (e) {
    out.status = 'error';
    out.error = e.message || String(e);
  }
  return out;
}

async function getPortfolioSnapshot({ target = 'local', includeLive = true, includePaper = true } = {}) {
  const cfg = loadConfig();
  const priceMap = await buildUsdPriceMap();
  const accounts = [];
  const openOrders = [];
  const transactions = [];

  // 1. Live Exchange Watch Accounts (via CCXT)
  if (includeLive && Array.isArray(cfg.watchAccounts) && cfg.watchAccounts.length > 0) {
    const liveRes = await Promise.all(cfg.watchAccounts.map(a => fetchLiveAccount(a, priceMap)));
    for (const r of liveRes) {
      accounts.push({
        id: r.id, source: r.source, exchange: r.exchange, label: r.label,
        status: r.status, error: r.error, totalUsd: r.totalUsd, holdings: r.holdings,
      });
      openOrders.push(...r.openOrders);
      transactions.push(...r.transactions);
    }
  }

  // 2. Hummingbot Paper Balances + Trades on selected host
  if (includePaper) {
    try {
      const pc = await hb.getPaperConfig(target);
      const hbHoldings = [];
      let hbTotal = 0;
      for (const [assetRaw, amtRaw] of Object.entries(pc.balances || {})) {
        const total = Number(amtRaw) || 0;
        if (total <= 0) continue;
        const asset = assetRaw.toUpperCase();
        const priceUsd = priceMap[asset] || 0;
        const valueUsd = total * priceUsd;
        hbTotal += valueUsd;
        hbHoldings.push({ asset, total, free: total, used: 0, priceUsd, valueUsd });
      }
      hbHoldings.sort((a, b) => b.valueUsd - a.valueUsd);
      hbHoldings.forEach(h => { h.pct = hbTotal > 0 ? (h.valueUsd / hbTotal) * 100 : 0; });
      if (hbHoldings.length > 0) {
        accounts.push({
          id: `hb_paper_${target}`, source: 'hb_paper', exchange: 'hummingbot',
          label: `Hummingbot Paper (${target})`, status: 'ok', error: null,
          totalUsd: hbTotal, holdings: hbHoldings,
        });
      }
    } catch (_) { /* host offline or uninitialized */ }

    try {
      const pnl = await hb.getTradesAndPnl(target);
      for (const t of pnl.trades || []) {
        const parsedTs = Date.parse(t.timestamp) || Date.now();
        transactions.push({
          id: `hb_${t.file}_${parsedTs}_${t.amount}`,
          ts: parsedTs,
          source: t.paper ? 'hb_paper' : 'hb_live',
          account: `Hummingbot (${target})`,
          exchange: t.market,
          type: t.paper ? 'PAPER_TRADE' : 'TRADE',
          side: t.side,
          symbol: t.pair,
          amount: t.amount,
          price: t.price,
          valueUsd: t.notional,
          feeUsd: t.feeQuote,
          status: 'filled',
        });
      }
    } catch (_) { /* ignore */ }

    // 3. Built-in Paper Lab virtual wallets + executions
    const sim = paperEngine.getState();
    if (sim.active && sim.session) {
      const s = sim.session;
      const quote = s.config.quote || 'USD';
      const labHoldings = Object.entries(s.balances || {}).map(([ex, amt]) => ({
        asset: `${quote} (${EXCHANGES[ex]?.short || ex.toUpperCase()})`,
        total: Number(amt) || 0,
        free: Number(amt) || 0,
        used: 0,
        priceUsd: 1,
        valueUsd: Number(amt) || 0,
      }));
      const labTotal = labHoldings.reduce((acc, h) => acc + h.valueUsd, 0);
      labHoldings.forEach(h => { h.pct = labTotal > 0 ? (h.valueUsd / labTotal) * 100 : 0; });
      accounts.push({
        id: 'paper_lab', source: 'paper_lab', exchange: 'paper_lab',
        label: `Paper Accuracy Lab (${s.running ? 'RUNNING' : 'PAUSED'})`,
        status: 'ok', error: null, totalUsd: labTotal, holdings: labHoldings,
      });
      for (const tr of s.trades || []) {
        transactions.push({
          id: `lab_${tr.id}`,
          ts: tr.ts,
          source: 'paper_lab',
          account: 'Paper Lab',
          exchange: `${tr.buyOn}->${tr.sellOn}`,
          type: 'PAPER_TRADE',
          side: tr.outcome,
          symbol: `${tr.symbol}-${tr.quote}`,
          amount: tr.baseAmount,
          price: tr.actualBuyVwap,
          valueUsd: tr.tradeSize,
          feeUsd: tr.feeDollar,
          pnlUsd: tr.realizedDelta,
          status: tr.outcome,
        });
      }
    }
  }

  // Consolidated holdings across live accounts (or all if no live accounts)
  const consolidationPool = accounts.some(a => a.source === 'live')
    ? accounts.filter(a => a.source === 'live')
    : accounts;
  const assetMap = {};
  for (const a of consolidationPool) {
    for (const h of a.holdings) {
      const cur = assetMap[h.asset] || (assetMap[h.asset] = { asset: h.asset, total: 0, priceUsd: h.priceUsd, valueUsd: 0, sources: [] });
      cur.total += h.total;
      cur.valueUsd += h.valueUsd;
      if (!cur.sources.includes(a.label)) cur.sources.push(a.label);
    }
  }
  const byAsset = Object.values(assetMap).sort((a, b) => b.valueUsd - a.valueUsd);
  const poolTotal = byAsset.reduce((s, x) => s + x.valueUsd, 0);
  byAsset.forEach(x => { x.pct = poolTotal > 0 ? (x.valueUsd / poolTotal) * 100 : 0; });

  transactions.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  openOrders.sort((a, b) => (b.ts || 0) - (a.ts || 0));

  const liveUsd = accounts.filter(a => a.source === 'live').reduce((s, a) => s + a.totalUsd, 0);
  const paperHummingbotUsd = accounts.filter(a => a.source === 'hb_paper').reduce((s, a) => s + a.totalUsd, 0);
  const paperLabUsd = accounts.filter(a => a.source === 'paper_lab').reduce((s, a) => s + a.totalUsd, 0);

  return {
    timestamp: Date.now(),
    target,
    summary: {
      totalUsd: liveUsd > 0 ? liveUsd : (paperHummingbotUsd + paperLabUsd),
      liveUsd,
      paperHummingbotUsd,
      paperLabUsd,
      liveAccountCount: accounts.filter(a => a.source === 'live').length,
      assetCount: byAsset.length,
      openOrderCount: openOrders.length,
      txCount: transactions.length,
    },
    accounts,
    byAsset,
    openOrders: openOrders.slice(0, 100),
    transactions: transactions.slice(0, 200),
  };
}

function saveWatchAccount({ id, exchange, label, apiKey, apiSecret, passphrase = '', sandbox = false }) {
  if (!CCXT_CLASS[exchange]) throw new Error(`Unsupported exchange: ${exchange}`);
  if (!apiKey || !apiSecret) throw new Error('apiKey and apiSecret are required');
  const acctId = String(id || `${exchange}_${crypto.randomBytes(3).toString('hex')}`).toLowerCase().replace(/[^a-z0-9_-]/g, '');
  const entry = {
    id: acctId,
    exchange,
    label: String(label || EXCHANGES[exchange]?.label || exchange).trim(),
    apiKey: String(apiKey).trim(),
    apiSecret: String(apiSecret).trim(),
    passphrase: String(passphrase || '').trim(),
    sandbox: !!sandbox,
  };
  updateConfig(c => {
    const idx = c.watchAccounts.findIndex(w => w.id === acctId);
    if (idx >= 0) c.watchAccounts[idx] = entry; else c.watchAccounts.push(entry);
  });
  return { id: acctId, exchange, label: entry.label };
}

function deleteWatchAccount(id) {
  updateConfig(c => { c.watchAccounts = c.watchAccounts.filter(w => w.id !== id); });
  return { success: true, id };
}

async function testWatchAccount(id) {
  const cfg = loadConfig();
  const acct = (cfg.watchAccounts || []).find(w => w.id === id);
  if (!acct) throw new Error('Account not found');
  const priceMap = await buildUsdPriceMap();
  const res = await fetchLiveAccount(acct, priceMap, { includeTransactions: false });
  if (res.status !== 'ok') throw new Error(res.error);
  return { success: true, label: res.label, totalUsd: res.totalUsd, assetCount: res.holdings.length };
}

module.exports = {
  getPortfolioSnapshot,
  saveWatchAccount,
  deleteWatchAccount,
  testWatchAccount,
  buildUsdPriceMap,
};
