// ─── Profitable Target Watcher & Multi-Channel Push Notifications ────────────
// Continuously watches for profitable arbitrage opportunities, optionally
// verifies them against live L2 order books, persists alert history, broadcasts
// via SSE to web/Android clients, and dispatches push notifications via:
//   • ntfy.sh (instant native Android push with zero Firebase setup)
//   • Telegram Bot API
//   • Discord / Custom Webhook
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const { loadConfig, updateConfig } = require('./config');
const { EXCHANGES } = require('./exchanges');
const { runScan } = require('./scanner');
const { verifyOpportunity } = require('./paper');

const DATA_DIR = path.join(__dirname, '..', 'data');
const ALERTS_FILE = path.join(DATA_DIR, 'alerts.json');

class AlertManager {
  constructor() {
    this.alerts = [];
    this.subscribers = new Set(); // Express SSE `res` objects
    this.cooldowns = new Map();   // key -> ts
    this.timer = null;
    this.checking = false;
    this.lastCheckAt = null;
    this.lastError = null;
    this.checksCount = 0;
    this._load();
  }

  _load() {
    try {
      const saved = JSON.parse(fs.readFileSync(ALERTS_FILE, 'utf8'));
      if (Array.isArray(saved)) this.alerts = saved.slice(0, 200);
    } catch (_) { this.alerts = []; }
  }

  _save() {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(ALERTS_FILE, JSON.stringify(this.alerts.slice(0, 200), null, 2));
    } catch (e) { console.error('alerts save failed:', e.message); }
  }

  subscribe(res) {
    this.subscribers.add(res);
    res.on('close', () => this.subscribers.delete(res));
  }

  broadcast(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.subscribers) {
      try { res.write(payload); } catch (_) { this.subscribers.delete(res); }
    }
  }

  list({ since = 0, limit = 100 } = {}) {
    const s = Number(since) || 0;
    const lim = Math.min(200, Math.max(1, Number(limit) || 100));
    const items = s > 0 ? this.alerts.filter(a => a.ts > s) : this.alerts;
    return items.slice(0, lim);
  }

  markRead(id) {
    if (id === 'all') {
      this.alerts.forEach(a => { a.read = true; });
    } else {
      const hit = this.alerts.find(a => a.id === id);
      if (hit) hit.read = true;
    }
    this._save();
  }

  clear() {
    this.alerts = [];
    this.cooldowns.clear();
    this._save();
  }

  async dispatchPush(alert, alertCfg) {
    const results = {};
    const title = alert.title;
    const body = alert.message;

    // 1. ntfy.sh (free instant Android push app — https://ntfy.sh)
    if (alertCfg.ntfyTopic) {
      const base = String(alertCfg.ntfyUrl || 'https://ntfy.sh').replace(/\/+$/, '');
      const url = `${base}/${encodeURIComponent(alertCfg.ntfyTopic.trim())}`;
      try {
        await axios.post(url, body, {
          timeout: 6000,
          headers: {
            'Title': title.replace(/[^\x20-\x7E]/g, ''),
            'Priority': alert.netProfitPct >= 0.5 ? 'high' : 'default',
            'Tags': alert.isTest ? 'bell,white_check_mark' : 'money_with_wings,chart_with_upwards_trend',
          },
        });
        results.ntfy = { ok: true };
      } catch (e) { results.ntfy = { ok: false, error: e.message }; }
    }

    // 2. Telegram Bot
    if (alertCfg.telegramBotToken && alertCfg.telegramChatId) {
      try {
        await axios.post(`https://api.telegram.org/bot${alertCfg.telegramBotToken}/sendMessage`, {
          chat_id: alertCfg.telegramChatId,
          text: `*${title}*\n${body}`,
          parse_mode: 'Markdown',
        }, { timeout: 6000 });
        results.telegram = { ok: true };
      } catch (e) { results.telegram = { ok: false, error: e.message }; }
    }

    // 3. Discord / Custom Webhook
    if (alertCfg.webhookUrl) {
      try {
        const isDiscord = /discord\.com\/api\/webhooks/i.test(alertCfg.webhookUrl);
        const payload = isDiscord
          ? { content: `**${title}**\n${body}` }
          : { event: 'profitable_target', alert };
        await axios.post(alertCfg.webhookUrl, payload, { timeout: 6000 });
        results.webhook = { ok: true };
      } catch (e) { results.webhook = { ok: false, error: e.message }; }
    }

    return results;
  }

  async recordAndNotify(alert, alertCfg) {
    this.alerts.unshift(alert);
    if (this.alerts.length > 200) this.alerts.length = 200;
    const delivery = await this.dispatchPush(alert, alertCfg);
    alert.delivery = delivery;
    this._save();
    this.broadcast('alert', alert);
    return alert;
  }

  async sendTest() {
    const cfg = loadConfig();
    const a = cfg.alerts;
    const alert = {
      id: `al_${crypto.randomBytes(5).toString('hex')}`,
      ts: Date.now(),
      isTest: true,
      read: false,
      symbol: 'SOL',
      quote: a.quote || 'USD',
      pair: a.pair || 'kraken_coinbase',
      buyOn: 'kraken',
      sellOn: 'coinbase',
      buyPrice: 142.10,
      sellPrice: 143.55,
      tradeSize: a.tradeSize || 1000,
      spreadPct: 1.02,
      netProfitPct: 0.48,
      netDollar: 4.80,
      verifiedL2: true,
      title: 'TEST TARGET: SOL-USD +0.48% (+$4.80)',
      message: `Route: Buy Kraken @ $142.10 -> Sell Coinbase Adv @ $143.55\nSize: $${a.tradeSize || 1000} | L2 Verified: YES\nThis is a test alert from Arb Scanner v3.`,
    };
    return this.recordAndNotify(alert, a);
  }

  async runCheck({ force = false } = {}) {
    if (this.checking) return { skipped: true };
    const cfg = loadConfig();
    const a = cfg.alerts;
    if (!force && !a.enabled) return { disabled: true };

    this.checking = true;
    try {
      const [exA, exB] = String(a.pair || 'kraken_coinbase').split('_');
      const effFees = a.feeMode === 'maker_taker'
        ? Object.fromEntries(Object.entries(cfg.fees).map(([k, v]) => [k, { maker: v.maker, taker: (v.maker + v.taker) / 2 }]))
        : cfg.fees;

      const scan = await runScan({
        exA, exB, quote: a.quote || 'USD',
        tradeSize: Number(a.tradeSize) || 1000,
        slippageBps: 5,
        fees: effFees,
        refineTop: 25,
        record: true,
      });

      this.checksCount++;
      this.lastCheckAt = Date.now();
      this.lastError = null;

      const now = Date.now();
      const cooldownMs = Math.max(15, Number(a.cooldownSec) || 300) * 1000;
      const minNetPct = Number(a.minNetPct) || 0.2;
      const minNetDollar = Number(a.minNetDollar) || 0;
      const minVolUsd = Number(a.minVolUsd) || 0;

      const hits = scan.opportunities.filter(o =>
        !o.estimated &&
        o.netProfit >= minNetPct &&
        o.netDollar >= minNetDollar &&
        (!minVolUsd || !o.minVol || o.minVol >= minVolUsd)
      );

      const triggered = [];
      for (const opp of hits.slice(0, 3)) {
        const key = `${a.pair}|${a.quote}|${opp.symbol}`;
        if (!force && (now - (this.cooldowns.get(key) || 0)) < cooldownMs) continue;

        let verifiedL2 = false;
        let finalNetPct = opp.netProfit;
        let finalNetDollar = opp.netDollar;
        let finalBuy = opp.buyPrice;
        let finalSell = opp.sellPrice;

        if (a.verifyOrderBook) {
          try {
            const v = await verifyOpportunity({
              exA, exB, symbol: opp.symbol, quote: a.quote || 'USD',
              tradeSize: Number(a.tradeSize) || 1000,
              fees: cfg.fees, feeMode: a.feeMode || 'maker_taker',
              simulatedLatencyMs: 0,
              predictedBuyOn: opp.buyOn, predictedSellOn: opp.sellOn,
              predictedBuyPrice: opp.buyPrice, predictedSellPrice: opp.sellPrice,
              predictedNetDollar: opp.netDollar,
            });
            if (!v.actual.complete || v.actual.netPct < minNetPct || v.actual.netDollar < minNetDollar) {
              continue; // did not hold up in L2 order book — suppress false alarm!
            }
            verifiedL2 = true;
            finalNetPct = v.actual.netPct;
            finalNetDollar = v.actual.netDollar;
            finalBuy = v.actual.buyVwap;
            finalSell = v.actual.sellVwap;
          } catch (_) { continue; }
        }

        this.cooldowns.set(key, now);
        const buyLbl = EXCHANGES[opp.buyOn]?.label || opp.buyOn;
        const sellLbl = EXCHANGES[opp.sellOn]?.label || opp.sellOn;
        const alert = {
          id: `al_${crypto.randomBytes(5).toString('hex')}`,
          ts: Date.now(),
          isTest: false,
          read: false,
          symbol: opp.symbol,
          quote: a.quote || 'USD',
          pair: a.pair,
          buyOn: opp.buyOn,
          sellOn: opp.sellOn,
          buyPrice: finalBuy,
          sellPrice: finalSell,
          tradeSize: Number(a.tradeSize) || 1000,
          spreadPct: opp.spread,
          netProfitPct: Number(finalNetPct.toFixed(4)),
          netDollar: Number(finalNetDollar.toFixed(2)),
          minVol: opp.minVol,
          verifiedL2,
          title: `TARGET: ${opp.symbol}-${a.quote || 'USD'} +${finalNetPct.toFixed(2)}% (+$${finalNetDollar.toFixed(2)})`,
          message: `Buy ${buyLbl} @ $${finalBuy} -> Sell ${sellLbl} @ $${finalSell}\nSize: $${a.tradeSize || 1000} | Spread: ${opp.spread.toFixed(2)}% | ${verifiedL2 ? 'L2 Book Verified' : 'Top-of-Book'}`,
        };
        await this.recordAndNotify(alert, a);
        triggered.push(alert);
      }

      return { checked: scan.opportunities.length, triggeredCount: triggered.length, triggered };
    } catch (e) {
      this.lastError = e.message;
      return { error: e.message };
    } finally {
      this.checking = false;
    }
  }

  syncTimer() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    const cfg = loadConfig();
    if (!cfg.alerts.enabled) return;
    const ms = Math.max(10, Number(cfg.alerts.intervalSec) || 20) * 1000;
    this.timer = setInterval(() => { this.runCheck().catch(() => {}); }, ms);
    this.timer.unref();
  }

  updateSettings(patch) {
    const cfg = updateConfig(c => {
      const a = c.alerts;
      if (patch.enabled !== undefined) a.enabled = !!patch.enabled;
      if (patch.pair) a.pair = String(patch.pair);
      if (patch.quote) a.quote = String(patch.quote).toUpperCase();
      if (patch.tradeSize != null) a.tradeSize = Math.max(10, Number(patch.tradeSize) || 1000);
      if (patch.minNetPct != null) a.minNetPct = Number(patch.minNetPct);
      if (patch.minNetDollar != null) a.minNetDollar = Number(patch.minNetDollar) || 0;
      if (patch.minVolUsd != null) a.minVolUsd = Math.max(0, Number(patch.minVolUsd) || 0);
      if (patch.feeMode === 'maker_taker' || patch.feeMode === 'taker_taker') a.feeMode = patch.feeMode;
      if (patch.verifyOrderBook !== undefined) a.verifyOrderBook = !!patch.verifyOrderBook;
      if (patch.intervalSec != null) a.intervalSec = Math.max(10, Math.min(3600, Number(patch.intervalSec) || 20));
      if (patch.cooldownSec != null) a.cooldownSec = Math.max(15, Math.min(86400, Number(patch.cooldownSec) || 300));
      if (patch.ntfyUrl !== undefined) a.ntfyUrl = String(patch.ntfyUrl || 'https://ntfy.sh').trim();
      if (patch.ntfyTopic !== undefined) a.ntfyTopic = String(patch.ntfyTopic || '').trim();
      if (patch.telegramChatId !== undefined) a.telegramChatId = String(patch.telegramChatId || '').trim();
      if (patch.telegramBotToken) a.telegramBotToken = String(patch.telegramBotToken).trim();
      if (patch.clearTelegramToken) a.telegramBotToken = '';
      if (patch.webhookUrl && patch.webhookUrl !== 'configured') a.webhookUrl = String(patch.webhookUrl).trim();
      if (patch.clearWebhookUrl) a.webhookUrl = '';
    });
    this.syncTimer();
    return cfg.alerts;
  }

  getStatus() {
    const cfg = loadConfig();
    const unread = this.alerts.filter(a => !a.read).length;
    return {
      enabled: !!cfg.alerts.enabled,
      checking: this.checking,
      checksCount: this.checksCount,
      lastCheckAt: this.lastCheckAt,
      lastError: this.lastError,
      unreadCount: unread,
      totalAlerts: this.alerts.length,
      subscribers: this.subscribers.size,
      ntfyTopic: cfg.alerts.ntfyTopic || '',
    };
  }
}

const alertManager = new AlertManager();

module.exports = { alertManager };
