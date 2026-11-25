// ─── Persistent configuration (server/config.json) ────────────────────────────
// Holds host definitions, Hummingbot settings and fee schedules. Secrets
// (Hummingbot password, PEM paths) never leave the backend unmasked.
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = process.env.ARB_CONFIG || path.join(__dirname, '..', 'config.json');

// Base-tier spot fees (fractions). These are defaults only — every account's
// real tier differs, so they are editable in the UI and persisted here.
const DEFAULT_FEES = {
  kraken:    { maker: 0.0025, taker: 0.0040 },
  coinbase:  { maker: 0.0060, taker: 0.0120 },
  binance:   { maker: 0.0010, taker: 0.0010 },
  binanceus: { maker: 0.0010, taker: 0.0010 },
  kucoin:    { maker: 0.0010, taker: 0.0010 },
  bybit:     { maker: 0.0010, taker: 0.0010 },
  okx:       { maker: 0.0008, taker: 0.0010 },
};

const DEFAULT_ALERTS = {
  enabled: false,
  pair: 'kraken_coinbase',
  quote: 'USD',
  tradeSize: 1000,
  minNetPct: 0.25,
  minNetDollar: 2.0,
  minVolUsd: 100000,
  feeMode: 'maker_taker', // 'maker_taker' | 'taker_taker'
  verifyOrderBook: true,
  intervalSec: 20,
  cooldownSec: 300,
  ntfyUrl: 'https://ntfy.sh',
  ntfyTopic: '',
  telegramBotToken: '',
  telegramChatId: '',
  webhookUrl: '',
};

// Pre-deploy price cross-check, profitability gate and live-trading guard rails
const DEFAULT_GUARD = {
  slippageBps: 5,               // extra execution buffer per leg, on top of order-book VWAP
  captureRatePct: 50,           // share of observed opportunities a bot actually fills
  fallbackTradesPerDay: 4,      // used until the scanner has >= 1h of history for the pair
  rebalanceMonthlyUsd: 5,       // transfer/withdrawal cost to rebalance inventory
  maxRefDeviationPct: 2,        // venue mid vs median of other exchanges
  maxTickerDriftPct: 0.5,       // scanner ticker vs fresh order book
  maxGrossSpreadPct: 5,         // wider gaps usually mean a different token or a halted market
  liveStopLossPct: 3,           // Hummingbot kill switch: stop when return % <= -3%
  liveMaxLossUsd: 50,           // backend monitor stops a live bot at this realized loss
  liveMaxOrderUsd: 1000,        // hard cap on a live bot's order size
  liveMinProfitabilityPct: 0.1, // live bots must require at least this net edge per trade
  monitorIntervalSec: 60,
  autoRecheckEnabled: true,     // re-run the price cross-check for running live bots
};

const DEFAULTS = {
  hbImage: 'hummingbot/hummingbot:version-2.14.0',
  hbPassword: '',
  apiToken: '',
  local: { mode: 'native', hbDir: '~/hummingbot', monthlyCost: 0 },
  servers: [],
  fees: DEFAULT_FEES,
  vpnDedicatedIp: '',
  alerts: DEFAULT_ALERTS,
  guard: DEFAULT_GUARD,
  watchAccounts: [],
};

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

function migrate(raw) {
  const cfg = { ...DEFAULTS, ...raw };
  cfg.local = { ...DEFAULTS.local, ...(raw.local || {}) };
  cfg.fees = { ...DEFAULT_FEES, ...(raw.fees || {}) };
  cfg.alerts = { ...DEFAULT_ALERTS, ...(raw.alerts || {}) };
  cfg.guard = { ...DEFAULT_GUARD, ...(raw.guard || {}) };
  if (!Array.isArray(cfg.servers)) cfg.servers = [];
  if (!Array.isArray(cfg.watchAccounts)) cfg.watchAccounts = [];

  // v2 -> v3: single `aws` block becomes a server entry with id "aws"
  if (raw.aws && raw.aws.host && !cfg.servers.some(s => s.id === 'aws')) {
    cfg.servers.push({
      id: 'aws', name: 'AWS EC2', provider: 'aws',
      host: raw.aws.host, port: 22,
      username: raw.aws.username || 'ec2-user',
      pemPath: raw.aws.pemPath || '',
      hbDir: raw.aws.hbDir || '~/hummingbot',
      monthlyCost: 0,
    });
  }
  delete cfg.aws;

  // v2 hard-coded CONFIG_PASSWORD=1313 for every container. Preserve it so
  // existing encrypted connector files keep working until the user changes it.
  if (raw.hbPassword === undefined) cfg.hbPassword = '1313';
  return cfg;
}

function loadConfig() {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (_) { /* first run */ }
  return migrate(raw);
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

function updateConfig(mutator) {
  const cfg = loadConfig();
  mutator(cfg);
  saveConfig(cfg);
  return cfg;
}

// Public view: no password / token / API secret values
function publicConfig(cfg = loadConfig()) {
  const a = cfg.alerts || DEFAULT_ALERTS;
  return {
    hbImage: cfg.hbImage,
    hasHbPassword: !!cfg.hbPassword,
    hasApiToken: !!cfg.apiToken,
    local: cfg.local,
    servers: cfg.servers.map(s => ({ ...s })),
    fees: cfg.fees,
    vpnDedicatedIp: cfg.vpnDedicatedIp,
    guard: cfg.guard,
    alerts: {
      ...a,
      telegramBotToken: '',
      hasTelegramToken: !!a.telegramBotToken,
      webhookUrl: a.webhookUrl ? 'configured' : '',
      hasWebhookUrl: !!a.webhookUrl,
    },
    watchAccounts: (cfg.watchAccounts || []).map(w => ({
      id: w.id,
      exchange: w.exchange,
      label: w.label || w.exchange,
      sandbox: !!w.sandbox,
      keyPreview: w.apiKey ? `${String(w.apiKey).slice(0, 6)}...${String(w.apiKey).slice(-4)}` : '',
      hasSecret: !!w.apiSecret,
      hasPassphrase: !!w.passphrase,
    })),
  };
}

function validateServer(s) {
  const errors = [];
  if (!s.id || !ID_RE.test(s.id)) errors.push('id must be lowercase letters/numbers/-/_ (max 32)');
  if (s.id === 'local') errors.push('"local" is reserved');
  if (!s.host || /[\s;&|`$<>]/.test(s.host)) errors.push('valid host required');
  if (!s.username || !/^[a-z_][a-z0-9_.-]*$/i.test(s.username)) errors.push('valid username required');
  if (s.hbDir && !/^[~\/][\w\/.~-]*$/.test(s.hbDir)) errors.push('hbDir must be an absolute or ~ path');
  return errors;
}

module.exports = { loadConfig, saveConfig, updateConfig, publicConfig, validateServer, DEFAULT_FEES, DEFAULT_ALERTS, DEFAULT_GUARD, CONFIG_PATH };
