// ─── Auto-Trader: launch a bot when the Target Watcher finds a target ─────────
// A target becomes a bot only if it passes every built-in check with NO manual
// override: ticker audit, price cross-check, per-trade and monthly profitability,
// and (live mode) the live guard rails. On top of those, the auto-trader keeps its
// own limits: concurrent bots, launches per 24 h, per-coin cooldown and a max
// runtime after which the bot is stopped. Paper mode by default; live mode needs a
// typed confirmation and exchange API keys on the host.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const hb = require('./hummingbot');
const guard = require('./guard');
const { guardedLaunch } = require('./launcher');
const { generateStrategyYaml } = require('./strategies');
const { EXCHANGES } = require('./exchanges');
const { loadConfig, updateConfig, DEFAULT_AUTOTRADE } = require('./config');

const DATA_DIR = process.env.ARB_DATA_DIR || path.join(__dirname, '..', 'data');
const LOG_FILE = path.join(DATA_DIR, 'auto_trades.json');
const LIVE_PHRASE = 'LIVE AUTO-TRADE';
const DAY_MS = 24 * 3600 * 1000;

function readLog() { try { return JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); } catch (_) { return []; } }
function writeLog(list) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(LOG_FILE, JSON.stringify(list.slice(0, 300), null, 2)); }
  catch (e) { console.error('autoTrader: log write failed:', e.message); }
}

function settings(cfg = loadConfig()) { return { ...DEFAULT_AUTOTRADE, ...(cfg.autoTrade || {}) }; }

// Live auto-trading is refused while the API is reachable from the network without a token
function liveBlockers(cfg = loadConfig()) {
  const out = [];
  const bind = process.env.BIND_HOST || '127.0.0.1';
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(bind);
  if (!loopback && !cfg.apiToken) out.push('The API is open to your network without an API token. Generate one in Alerts & Mobile first.');
  const g = guard.guardSettings(cfg);
  if (!(g.liveStopLossPct > 0) || !(g.liveMaxLossUsd > 0)) out.push('Live stop-loss settings are missing (Cross-Check → Guard Rail Settings).');
  return out;
}

class AutoTrader {
  constructor() {
    this.log = readLog();
    this.busy = false;
  }

  record(entry) {
    const e = { id: `at_${crypto.randomBytes(4).toString('hex')}`, ts: Date.now(), ...entry };
    this.log.unshift(e);
    if (this.log.length > 300) this.log.length = 300;
    writeLog(this.log);
    return e;
  }

  activeBots() {
    return guard.monitor.list().filter(b => b.auto && b.status === 'active');
  }

  launchesInLastDay() {
    const since = Date.now() - DAY_MS;
    return this.log.filter(e => e.outcome === 'launched' && e.ts >= since).length;
  }

  async notify(title, message, symbol) {
    const { alertManager } = require('./alerts');
    const cfg = loadConfig();
    await alertManager.recordAndNotify({
      id: `al_${crypto.randomBytes(5).toString('hex')}`, ts: Date.now(), isTest: false, read: false,
      kind: 'auto', symbol, netProfitPct: 1, title, message,
    }, cfg.alerts);
  }

  // Called by the Target Watcher with the targets it just alerted on
  async onTargets(alerts = []) {
    const s = settings();
    if (!s.enabled || this.busy) return [];
    this.busy = true;
    const results = [];
    try {
      for (const alert of alerts) {
        if (alert.isTest) continue;
        const r = await this.consider(alert, s);
        results.push(r);
        if (r.outcome === 'launched') break; // at most one launch per watcher check
      }
    } finally {
      this.busy = false;
    }
    return results;
  }

  async consider(alert, s = settings()) {
    const cfg = loadConfig();
    const g = guard.guardSettings(cfg);
    const live = s.mode === 'live';
    const sym = String(alert.symbol || '').toUpperCase();
    const quote = String(alert.quote || 'USD').toUpperCase();
    const [exA, exB] = String(alert.pair || 'kraken_coinbase').split('_');
    const base = { symbol: sym, quote, pair: `${sym}-${quote}`, exchanges: `${exA}/${exB}`, mode: s.mode, target: s.target, netPct: alert.netProfitPct };
    const skip = (reason, extra = {}) => this.record({ ...base, outcome: 'skipped', reason, ...extra });

    // Auto-trader limits
    const active = this.activeBots();
    if (active.some(b => b.symbol === sym && b.quote === quote)) return skip('An auto bot for this coin is already running');
    if (active.length >= s.maxConcurrent) return skip(`${active.length} auto bots already running (max ${s.maxConcurrent})`);
    if (this.launchesInLastDay() >= s.maxPerDay) return skip(`Daily limit reached (${s.maxPerDay} launches in 24 h)`);
    const lastSame = this.log.find(e => e.outcome === 'launched' && e.symbol === sym && e.quote === quote);
    if (lastSame && Date.now() - lastSame.ts < s.symbolCooldownMin * 60000) {
      return skip(`Cooldown: ${sym} was auto-launched ${Math.round((Date.now() - lastSame.ts) / 60000)} min ago (wait ${s.symbolCooldownMin} min)`);
    }

    // Live preconditions
    if (live) {
      const blockers = liveBlockers(cfg);
      if (blockers.length) return skip(blockers.join(' '));
      try {
        const conns = (await hb.listConnectors(s.target)).map(c => c.exchange);
        const missing = [exA, exB].filter(ex => !conns.includes((EXCHANGES[ex] || {}).hbConnector));
        if (missing.length) return skip(`No Hummingbot API keys on ${s.target} for ${missing.map(m => EXCHANGES[m]?.label || m).join(', ')}`);
      } catch (e) { return skip(`Could not read Hummingbot connectors on ${s.target}: ${e.message}`); }
    }

    // Strategy
    const tradeSizeUsd = Math.max(10, Math.min(Number(alert.tradeSize) || s.maxOrderUsd, s.maxOrderUsd, live ? g.liveMaxOrderUsd : Infinity));
    const minProfitabilityPct = Math.max(s.minProfitabilityPct, live ? g.liveMinProfitabilityPct : 0);
    const yaml = generateStrategyYaml({
      strategy: s.strategy, symbol: sym, quote, exA, exB,
      makerEx: alert.buyOn, takerEx: alert.sellOn,
      tradeSizeUsd, refPrice: alert.buyPrice, minProfitabilityPct,
      paperTrade: !live, netProfitPreview: alert.netProfitPct,
    });
    const configName = `auto_${sym.toLowerCase().replace(/[^a-z0-9]/g, '')}_${quote.toLowerCase()}_${Date.now().toString(36).slice(-6)}`;

    try {
      const res = await guardedLaunch(s.target, { configName, yaml, auto: { maxRuntimeMin: s.maxRuntimeMin } },
        () => hb.deployStrategy(s.target, { configName, yaml, launchMode: 'detached', autoStart: true }));
      const t = res.guard.check ? res.guard.check.perTrade : {};
      const m = res.guard.check ? res.guard.check.monthly : {};
      const entry = this.record({
        ...base, outcome: 'launched', containerName: res.containerName, configName, tradeSizeUsd,
        verifiedNetPct: t.netPct ?? null, monthlyNet: m.monthlyNet ?? null,
      });
      await this.notify(
        `AUTO BOT (${live ? 'LIVE' : 'PAPER'}): ${sym}-${quote} launched`,
        `${res.containerName} on ${s.target}: buy ${EXCHANGES[alert.buyOn]?.label || alert.buyOn} → sell ${EXCHANGES[alert.sellOn]?.label || alert.sellOn}, $${tradeSizeUsd} orders. `
        + `Verified ${t.netPct != null ? t.netPct.toFixed(3) : '?'}%/trade, ${m.monthlyNet != null ? '$' + m.monthlyNet + '/mo' : ''}. Stops after ${s.maxRuntimeMin} min.`,
        sym,
      ).catch(() => {});
      return entry;
    } catch (e) {
      if (e instanceof guard.GateError) {
        const reasons = e.reasons || e.guardViolations || [];
        return skip(`Failed safety checks: ${reasons.slice(0, 3).join(' | ') || e.message}`, {
          verifiedNetPct: e.check ? e.check.perTrade.netPct ?? null : null,
          monthlyNet: e.check ? e.check.monthly.monthlyNet : null,
        });
      }
      return this.record({ ...base, outcome: 'error', reason: e.message });
    }
  }

  updateSettings(patch = {}) {
    const cfg = loadConfig();
    const cur = settings(cfg);
    if (patch.mode === 'live' && cur.mode !== 'live') {
      if (String(patch.confirmPhrase || '').trim().toUpperCase() !== LIVE_PHRASE) {
        throw Object.assign(new Error(`Type ${LIVE_PHRASE} to switch auto-trading to real funds`), { status: 400 });
      }
      const blockers = liveBlockers(cfg);
      if (blockers.length) throw Object.assign(new Error(blockers.join(' ')), { status: 400 });
    }
    const num = (v, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : undefined; };
    const limits = {
      maxOrderUsd: [10, 1e7], minProfitabilityPct: [0.01, 10], maxConcurrent: [1, 20],
      maxPerDay: [1, 200], maxRuntimeMin: [5, 10080], symbolCooldownMin: [0, 10080],
    };
    const next = updateConfig(c => {
      c.autoTrade = { ...DEFAULT_AUTOTRADE, ...(c.autoTrade || {}) };
      const a = c.autoTrade;
      if (patch.enabled !== undefined) a.enabled = !!patch.enabled;
      if (patch.mode === 'paper' || patch.mode === 'live') a.mode = patch.mode;
      if (patch.target) a.target = String(patch.target);
      if (patch.strategy === 'amm_arb' || patch.strategy === 'cross_exchange_market_making') a.strategy = patch.strategy;
      for (const [k, [lo, hi]] of Object.entries(limits)) {
        if (patch[k] !== undefined && patch[k] !== '') { const n = num(patch[k], lo, hi); if (n !== undefined) a[k] = n; }
      }
      // Auto-trading rides on the Target Watcher, so turning it on turns the watcher on
      if (patch.enabled === true) c.alerts.enabled = true;
    });
    if (patch.enabled === true) { const { alertManager } = require('./alerts'); alertManager.syncTimer(); }
    if (patch.mode && patch.mode !== cur.mode) {
      this.record({ outcome: 'mode_change', mode: patch.mode, reason: `Auto-trade mode changed ${cur.mode} → ${patch.mode}` });
    }
    return settings(next);
  }

  status() {
    const cfg = loadConfig();
    return {
      settings: settings(cfg),
      livePhrase: LIVE_PHRASE,
      liveBlockers: liveBlockers(cfg),
      watcher: { enabled: !!cfg.alerts.enabled, pair: cfg.alerts.pair, quote: cfg.alerts.quote, minNetPct: cfg.alerts.minNetPct, tradeSize: cfg.alerts.tradeSize, intervalSec: cfg.alerts.intervalSec },
      activeBots: this.activeBots(),
      launchesLast24h: this.launchesInLastDay(),
      log: this.log.slice(0, 50),
    };
  }
}

const autoTrader = new AutoTrader();

module.exports = { autoTrader, LIVE_PHRASE, liveBlockers };
