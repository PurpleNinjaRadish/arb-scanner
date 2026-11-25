// ─── Arb Scanner v3 Backend ───────────────────────────────────────────────────
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const axios = require('axios');

const { loadConfig, updateConfig, publicConfig, validateServer, DEFAULT_FEES } = require('./lib/config');
const { listHosts, closeAllSsh, HostError } = require('./lib/hosts');
const { EXCHANGES, QUOTES, getQuotes, getOrderBook, health } = require('./lib/exchanges');
const { runScan, summarizeStats, resetStats, listStatKeys, flushStats } = require('./lib/scanner');
const { generateStrategyYaml, parseStrategyYaml } = require('./lib/strategies');
const hb = require('./lib/hummingbot');
const { engine: paperEngine, verifyOpportunity } = require('./lib/paper');
const advisor = require('./lib/advisor');
const provision = require('./lib/provision');
const { alertManager } = require('./lib/alerts');
const portfolio = require('./lib/portfolio');

const app = express();

// CORS: only allow the React dev server and same-origin pages. Requests without an
// Origin header (Android app, curl, ntfy) are unaffected. This stops any random
// website open in your browser from driving the local API (Docker/SSH control).
const DEV_ORIGINS = new Set(['http://localhost:3000', 'http://127.0.0.1:3000']);
app.use(cors((req, cb) => {
  const origin = req.headers.origin;
  const allowed = !origin
    || DEV_ORIGINS.has(origin)
    || origin === `http://${req.headers.host}`
    || origin === `https://${req.headers.host}`;
  cb(null, { origin: allowed });
}));
app.use(express.json({ limit: '2mb' }));

function tokenMatches(given, expected) {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Optional API token guard (enabled automatically if `apiToken` is set in config.json)
app.use('/api', (req, res, next) => {
  const cfg = loadConfig();
  if (cfg.apiToken) {
    const token = req.headers['x-api-token'] || req.query.token;
    if (!tokenMatches(token, cfg.apiToken)) return res.status(401).json({ error: 'Unauthorized: invalid X-API-Token' });
  }
  next();
});

// Helper to wrap async route handlers with clean status codes
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch(err => {
  const status = err instanceof HostError && err.status ? err.status : 500;
  res.status(status).json({ error: err.message || String(err) });
});

// ─── Config, Hosts & VPN ─────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ ok: true, version: '3.0.0', uptimeSec: Math.round(process.uptime()), exchangeHealth: health });
});

app.get('/api/config', (req, res) => res.json({ ...publicConfig(), defaultFees: DEFAULT_FEES, quotes: QUOTES }));

app.post('/api/config', wrap(async (req, res) => {
  const { hbImage, hbPassword, apiToken, local, fees, vpnDedicatedIp } = req.body || {};
  const cfg = updateConfig(c => {
    if (hbImage && /^[\w./:-]+$/.test(hbImage)) c.hbImage = hbImage.trim();
    if (typeof hbPassword === 'string' && hbPassword.length > 0) c.hbPassword = hbPassword;
    if (typeof apiToken === 'string') c.apiToken = apiToken.trim();
    if (local && typeof local === 'object') {
      if (local.mode === 'native' || local.mode === 'wsl') c.local.mode = local.mode;
      if (typeof local.hbDir === 'string' && local.hbDir.trim()) c.local.hbDir = local.hbDir.trim();
      if (typeof local.wslDistro === 'string') c.local.wslDistro = local.wslDistro.trim();
      if (local.monthlyCost != null) c.local.monthlyCost = Math.max(0, Number(local.monthlyCost) || 0);
    }
    if (fees && typeof fees === 'object') {
      for (const [ex, val] of Object.entries(fees)) {
        if (!EXCHANGES[ex] || !val) continue;
        c.fees[ex] = {
          maker: Math.max(0, Math.min(0.1, Number(val.maker) || 0)),
          taker: Math.max(0, Math.min(0.1, Number(val.taker) || 0)),
        };
      }
    }
    if (vpnDedicatedIp !== undefined) c.vpnDedicatedIp = String(vpnDedicatedIp || '').trim();
  });
  res.json({ success: true, config: publicConfig(cfg) });
}));

app.get('/api/hosts', (req, res) => res.json({ hosts: listHosts() }));

app.post('/api/servers', wrap(async (req, res) => {
  const s = req.body || {};
  const srv = {
    id: String(s.id || '').trim().toLowerCase(),
    name: String(s.name || s.id || '').trim(),
    provider: String(s.provider || 'vps').trim(),
    host: String(s.host || '').trim(),
    port: Math.max(1, Math.min(65535, parseInt(s.port, 10) || 22)),
    username: String(s.username || 'ubuntu').trim(),
    pemPath: String(s.pemPath || '').trim(),
    hbDir: String(s.hbDir || '~/hummingbot').trim(),
    region: String(s.region || '').trim(),
    monthlyCost: Math.max(0, Number(s.monthlyCost) || 0),
  };
  const errors = validateServer(srv);
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });

  const cfg = updateConfig(c => {
    const idx = c.servers.findIndex(x => x.id === srv.id);
    if (idx >= 0) c.servers[idx] = srv; else c.servers.push(srv);
  });
  res.json({ success: true, server: srv, hosts: listHosts(cfg) });
}));

app.delete('/api/servers/:id', wrap(async (req, res) => {
  const id = req.params.id;
  const cfg = updateConfig(c => { c.servers = c.servers.filter(s => s.id !== id); });
  res.json({ success: true, hosts: listHosts(cfg) });
}));

app.get('/api/system/status', wrap(async (req, res) => {
  const hosts = listHosts();
  const statuses = await Promise.all(hosts.map(h => hb.hostStatus(h.id)));
  const byId = Object.fromEntries(statuses.map(s => [s.target, s]));
  const firstRemote = statuses.find(s => s.target !== 'local');
  res.json({
    local: byId.local && byId.local.online ? 'online' : 'offline',
    aws: (byId.aws || firstRemote)?.online ? 'online' : 'offline',
    hosts: statuses,
  });
}));

app.get('/api/host/:target/status', wrap(async (req, res) => {
  res.json(await hb.hostStatus(req.params.target));
}));

app.post('/api/host/:target/test', wrap(async (req, res) => {
  const st = await hb.hostStatus(req.params.target);
  if (!st.online && st.error) return res.status(502).json({ success: false, ...st });
  res.json({ success: true, ...st, message: `Docker ${st.dockerVersion} | ${st.runningCount}/${st.totalCount} bots running` });
}));

app.get('/api/vpn-status', async (req, res) => {
  try {
    const cfg = loadConfig();
    const expectedIp = cfg.vpnDedicatedIp || null;
    const ipRes = await axios.get('https://api.ipify.org?format=json', { timeout: 4000 });
    const currentIp = ipRes.data.ip;
    const connected = expectedIp ? currentIp === expectedIp : null;
    res.json({ currentIp, expectedIp, connected });
  } catch (e) {
    res.status(500).json({ error: 'Could not determine public IP', connected: null });
  }
});

app.post('/api/vpn-status/save', wrap(async (req, res) => {
  const ipRes = await axios.get('https://api.ipify.org?format=json', { timeout: 4000 });
  const currentIp = ipRes.data.ip;
  updateConfig(c => { c.vpnDedicatedIp = currentIp; });
  res.json({ success: true, savedIp: currentIp });
}));

// ─── Scanner & Market Data ───────────────────────────────────────────────────
app.get('/api/scan', wrap(async (req, res) => {
  const cfg = loadConfig();
  const pair = String(req.query.pair || 'kraken_coinbase');
  const [exA, exB] = pair.split('_');
  const quote = QUOTES.includes(String(req.query.quote || 'USD').toUpperCase())
    ? String(req.query.quote || 'USD').toUpperCase() : 'USD';
  const coins = req.query.coins ? String(req.query.coins).split(',').map(s => s.trim().toUpperCase()).filter(Boolean) : null;
  const tradeSize = Math.max(10, Number(req.query.tradeSize) || 1000);
  const slippageBps = Math.max(0, Math.min(200, Number(req.query.slippageBps ?? 5)));
  const feeMode = req.query.feeMode === 'maker_taker' ? 'maker_taker' : 'taker_taker';

  const effFees = feeMode === 'maker_taker'
    ? Object.fromEntries(Object.entries(cfg.fees).map(([k, v]) => [k, { maker: v.maker, taker: (v.maker + v.taker) / 2 }]))
    : cfg.fees;

  const result = await runScan({ exA, exB, quote, coins, tradeSize, slippageBps, fees: effFees, refineTop: 25, record: req.query.record !== '0' });
  res.json(result);
}));

// Legacy endpoint kept for backwards compatibility
app.get('/api/prices', wrap(async (req, res) => {
  const pair = String(req.query.pair || 'kraken_coinbase');
  const [exA, exB] = pair.split('_');
  const quote = String(req.query.quote || 'USDT').toUpperCase();
  const coinList = req.query.coins ? String(req.query.coins).split(',') : null;
  const [ra, rb] = await Promise.all([getQuotes(exA, quote), getQuotes(exB, quote)]);
  const pick = (q) => {
    const out = {};
    for (const [c, v] of Object.entries(q)) {
      if (!coinList || coinList.includes(c)) out[c] = v.bid && v.ask ? (v.bid + v.ask) / 2 : v.last;
    }
    return out;
  };
  res.json({ exA: pick(ra.quotes), exB: pick(rb.quotes), timestamp: Date.now(), errors: { [exA]: ra.error, [exB]: rb.error } });
}));

app.get('/api/orderbook', wrap(async (req, res) => {
  const { exchange, symbol, quote = 'USD' } = req.query;
  if (!exchange || !symbol) return res.status(400).json({ error: 'exchange and symbol required' });
  const book = await getOrderBook(String(exchange), String(symbol).toUpperCase(), String(quote).toUpperCase());
  res.json({ exchange, symbol, quote, bids: book.bids.slice(0, 20), asks: book.asks.slice(0, 20), timestamp: Date.now() });
}));

app.get('/api/stats', (req, res) => {
  const key = req.query.key;
  if (key) return res.json(summarizeStats(String(key)));
  const keys = listStatKeys();
  res.json({ keys, summaries: Object.fromEntries(keys.map(k => [k, summarizeStats(k)])) });
});

app.post('/api/stats/reset', (req, res) => {
  resetStats(req.body && req.body.key);
  flushStats();
  res.json({ success: true });
});

// ─── Strategy Generator & Library ────────────────────────────────────────────
app.post('/api/strategy/preview', wrap(async (req, res) => {
  const yamlText = generateStrategyYaml(req.body || {});
  res.json({ yaml: yamlText, parsed: parseStrategyYaml(yamlText) });
}));

app.get('/api/strategies', wrap(async (req, res) => {
  const target = req.query.target || 'local';
  res.json({ target, strategies: await hb.listStrategies(target) });
}));

app.get('/api/strategies/:name', wrap(async (req, res) => {
  res.json(await hb.readStrategy(req.query.target || 'local', req.params.name));
}));

app.post('/api/strategies', wrap(async (req, res) => {
  const { target = 'local', name, yaml } = req.body || {};
  res.json(await hb.saveStrategy(target, name, yaml));
}));

app.delete('/api/strategies/:name', wrap(async (req, res) => {
  res.json(await hb.deleteStrategy(req.query.target || 'local', req.params.name));
}));

// ─── Hummingbot Containers, Logs & Images ────────────────────────────────────
app.get('/api/instances', wrap(async (req, res) => {
  const target = req.query.target || 'local';
  const includeStats = req.query.stats !== '0';
  const instances = await hb.listContainers(target, { includeStats });
  res.json({ target, instances });
}));

app.post('/api/deploy', wrap(async (req, res) => {
  const { target = 'local', ...opts } = req.body || {};
  res.json(await hb.deployStrategy(target, opts));
}));

app.post('/api/deploy-base', wrap(async (req, res) => {
  const { target = 'local', name, launchMode } = req.body || {};
  res.json(await hb.deployBase(target, { name, launchMode }));
}));

app.post('/api/instance/:id/action', wrap(async (req, res) => {
  const { target = 'local', action } = req.body || {};
  res.json(await hb.containerAction(target, req.params.id, action));
}));

app.post('/api/stop', wrap(async (req, res) => {
  const { containerId, target = 'local', remove = true } = req.body || {};
  await hb.containerAction(target, containerId, 'stop');
  if (remove) await hb.containerAction(target, containerId, 'remove').catch(() => {});
  res.json({ success: true });
}));

app.post('/api/stop-all', wrap(async (req, res) => {
  const { target = 'local', remove = false } = req.body || {};
  res.json(await hb.stopAll(target, { remove }));
}));

app.get('/api/instance/:id/logs', wrap(async (req, res) => {
  const { target = 'local', tail = 250, source = 'auto' } = req.query;
  res.json(await hb.containerLogs(target, req.params.id, { tail, source }));
}));

app.get('/api/instance/:id/config', wrap(async (req, res) => {
  res.json(await hb.getContainerConfig(req.query.target || 'local', req.params.id));
}));

app.post('/api/instance/edit', wrap(async (req, res) => {
  const { target = 'local', containerId, configName, yaml } = req.body || {};
  res.json(await hb.editContainerConfig(target, { containerId, configName, yaml }));
}));

app.post('/api/instance/:id/attach', wrap(async (req, res) => {
  const { target = 'local', open = true } = req.body || {};
  res.json(await hb.getAttachInfo(target, req.params.id, { open }));
}));

app.get('/api/logs', wrap(async (req, res) => {
  const target = req.query.target || 'local';
  res.json({ target, files: await hb.listLogFiles(target) });
}));

app.get('/api/logs/:file', wrap(async (req, res) => {
  res.json(await hb.readLogFile(req.query.target || 'local', req.params.file, req.query.lines || 250));
}));

app.post('/api/image/pull', wrap(async (req, res) => {
  const { target = 'local', image } = req.body || {};
  const job = provision.runPullImageJob(target, image);
  res.json({ success: true, job });
}));

// ─── Connectors, Paper Config & Realized Trades ──────────────────────────────
app.get('/api/connectors', wrap(async (req, res) => {
  const target = req.query.target || 'local';
  res.json({ target, connectors: await hb.listConnectors(target) });
}));

app.post('/api/exchange/add', wrap(async (req, res) => {
  const { target = 'local', exchange, apiKey, apiSecret, passphrase } = req.body || {};
  res.json(await hb.saveConnector(target, { exchange, apiKey, apiSecret, passphrase }));
}));

app.delete('/api/connectors/:exchange', wrap(async (req, res) => {
  res.json(await hb.deleteConnector(req.query.target || 'local', req.params.exchange));
}));

app.post('/api/exchange/terminal', wrap(async (req, res) => {
  const { target = 'local', open = true } = req.body || {};
  res.json(await hb.openConnectTerminal(target, { open }));
}));

app.get('/api/paper-config', wrap(async (req, res) => {
  res.json(await hb.getPaperConfig(req.query.target || 'local'));
}));

app.post('/api/paper-config', wrap(async (req, res) => {
  const { target = 'local', ...body } = req.body || {};
  res.json(await hb.savePaperConfig(target, body));
}));

app.post('/api/paper-config/seed', wrap(async (req, res) => {
  const { target = 'local', extraExchanges = [], pairs = [] } = req.body || {};
  const { getHost } = require('./lib/hosts');
  const host = getHost(target);
  await host.ensureDirs();
  const result = await hb.ensurePaperReady(host, extraExchanges, pairs);
  res.json({ success: true, ...result });
}));

// Backwards-compatible aliases
app.get('/api/paper-balances', wrap(async (req, res) => {
  const pc = await hb.getPaperConfig(req.query.target || 'local');
  res.json({ yaml: pc.rawYaml, ...pc });
}));
app.post('/api/paper-balances', wrap(async (req, res) => {
  const { target = 'local', yaml } = req.body || {};
  const pc = await hb.savePaperConfig(target, { rawYaml: yaml });
  res.json({ success: true, ...pc });
}));

app.get('/api/pnl', wrap(async (req, res) => {
  res.json(await hb.getTradesAndPnl(req.query.target || 'local'));
}));

// ─── Built-in Paper Mode & Processing Accuracy Simulator ─────────────────────
app.get('/api/paper-sim/state', (req, res) => res.json(paperEngine.getState()));
app.post('/api/paper-sim/start', wrap(async (req, res) => res.json(paperEngine.start(req.body || {}))));
app.post('/api/paper-sim/stop', (req, res) => res.json(paperEngine.stop()));
app.post('/api/paper-sim/resume', wrap(async (req, res) => res.json(paperEngine.resume())));
app.post('/api/paper-sim/reset', (req, res) => res.json(paperEngine.reset()));
app.post('/api/paper-sim/tick', wrap(async (req, res) => res.json(await paperEngine.runTick({ forceTestTop: !!(req.body && req.body.forceTestTop) }))));

app.post('/api/paper-sim/verify', wrap(async (req, res) => {
  res.json(await verifyOpportunity(req.body || {}));
}));

// ─── Profitability Projections, Server Advisor & Provisioning ────────────────
app.post('/api/advisor/projections', (req, res) => {
  res.json(advisor.projectProfitability(req.body || {}));
});

app.get('/api/advisor/servers', (req, res) => {
  res.json(advisor.recommendServers({
    targetBots: req.query.bots,
    pairId: req.query.pair,
    expectedMonthlyGross: Number(req.query.gross) || 150,
    prioritizeLatency: req.query.latency === '1',
  }));
});

app.get('/api/advisor/capacity', wrap(async (req, res) => {
  res.json(await advisor.inspectHostCapacity(req.query.target || 'local'));
}));

app.post('/api/advisor/latency', wrap(async (req, res) => {
  const { target = 'local', exchanges } = req.body || {};
  res.json(await advisor.measureExchangeLatency(target, exchanges));
}));

app.get('/api/provision/script', (req, res) => {
  const script = provision.generateBootstrapScript({
    hbDir: req.query.hbDir || '~/hummingbot',
    hbImage: req.query.hbImage,
  });
  res.json({ script });
});

app.get('/api/provision/compose', (req, res) => {
  const compose = provision.generateComposeFile({
    hbDir: req.query.hbDir || './hummingbot',
    hbImage: req.query.hbImage,
  });
  res.json({ compose });
});

app.post('/api/provision/run', wrap(async (req, res) => {
  const { target, ...opts } = req.body || {};
  if (!target) return res.status(400).json({ error: 'target is required' });
  const job = provision.runProvisionJob(target, opts);
  res.json({ success: true, job });
}));

app.get('/api/jobs', (req, res) => res.json({ jobs: provision.listJobs() }));
app.get('/api/jobs/:id', (req, res) => {
  const j = provision.getJob(req.params.id);
  if (!j) return res.status(404).json({ error: 'Job not found' });
  res.json(j);
});

// ─── Profitable Target Alerts & Push Notifications ──────────────────────────
app.get('/api/alerts/status', (req, res) => {
  res.json({ status: alertManager.getStatus(), settings: publicConfig().alerts });
});

app.get('/api/alerts', (req, res) => {
  res.json({
    status: alertManager.getStatus(),
    alerts: alertManager.list({ since: req.query.since, limit: req.query.limit }),
  });
});

app.get('/api/alerts/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders && res.flushHeaders();
  res.write(`event: hello\ndata: ${JSON.stringify({ status: alertManager.getStatus() })}\n\n`);
  alertManager.subscribe(res);
  const hbTimer = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 25000);
  req.on('close', () => clearInterval(hbTimer));
});

app.post('/api/alerts/settings', wrap(async (req, res) => {
  alertManager.updateSettings(req.body || {});
  res.json({ success: true, status: alertManager.getStatus(), settings: publicConfig().alerts });
}));

app.post('/api/alerts/check', wrap(async (req, res) => {
  const out = await alertManager.runCheck({ force: true });
  res.json({ success: true, ...out, status: alertManager.getStatus() });
}));

app.post('/api/alerts/test', wrap(async (req, res) => {
  const alert = await alertManager.sendTest();
  res.json({ success: true, alert });
}));

app.post('/api/alerts/read', (req, res) => {
  alertManager.markRead((req.body && req.body.id) || 'all');
  res.json({ success: true, status: alertManager.getStatus() });
});

app.delete('/api/alerts', (req, res) => {
  alertManager.clear();
  res.json({ success: true, status: alertManager.getStatus() });
});

// ─── Portfolio Holdings & Transactions Watcher ──────────────────────────────
app.get('/api/portfolio', wrap(async (req, res) => {
  const target = req.query.target || 'local';
  const includeLive = req.query.live !== '0';
  const includePaper = req.query.paper !== '0';
  res.json(await portfolio.getPortfolioSnapshot({ target, includeLive, includePaper }));
}));

app.post('/api/portfolio/accounts', wrap(async (req, res) => {
  const saved = portfolio.saveWatchAccount(req.body || {});
  res.json({ success: true, account: saved, accounts: publicConfig().watchAccounts });
}));

app.delete('/api/portfolio/accounts/:id', wrap(async (req, res) => {
  res.json(portfolio.deleteWatchAccount(req.params.id));
}));

app.post('/api/portfolio/accounts/:id/test', wrap(async (req, res) => {
  res.json(await portfolio.testWatchAccount(req.params.id));
}));

// ─── Android Mobile Pairing Helpers ─────────────────────────────────────────
app.get('/api/mobile/pairing', (req, res) => {
  const cfg = loadConfig();
  const nets = os.networkInterfaces();
  const lanIps = [];
  for (const [name, list] of Object.entries(nets)) {
    for (const iface of list || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        lanIps.push({ name, address: iface.address });
      }
    }
  }
  const primaryIp = (lanIps.find(x => /^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[01])\./.test(x.address)) || lanIps[0])?.address || '127.0.0.1';
  const recommendedUrl = `http://${primaryIp}:${PORT}`;
  res.json({
    bindHost: BIND_HOST,
    port: PORT,
    lanAccessible: BIND_HOST === '0.0.0.0',
    lanIps,
    recommendedUrl,
    hasApiToken: !!cfg.apiToken,
    ntfyUrl: cfg.alerts.ntfyUrl || 'https://ntfy.sh',
    ntfyTopic: cfg.alerts.ntfyTopic || '',
    pairingJson: JSON.stringify({
      url: recommendedUrl,
      token: cfg.apiToken || '',
      ntfyUrl: cfg.alerts.ntfyUrl || 'https://ntfy.sh',
      ntfyTopic: cfg.alerts.ntfyTopic || '',
    }),
  });
});

app.post('/api/mobile/token/generate', (req, res) => {
  const token = `arb_${crypto.randomBytes(18).toString('hex')}`;
  updateConfig(c => { c.apiToken = token; });
  res.json({ success: true, token });
});

// ─── Optional Static UI Hosting (single-process production mode) ─────────────
const BUILD_DIR = path.join(__dirname, '..', 'build');
if (fs.existsSync(path.join(BUILD_DIR, 'index.html'))) {
  app.use(express.static(BUILD_DIR));
  app.get(/^(?!\/api\/).*/, (req, res) => res.sendFile(path.join(BUILD_DIR, 'index.html')));
}

// ─── Boot & Graceful Shutdown ────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT, 10) || 3001;
const BIND_HOST = process.env.BIND_HOST || '127.0.0.1';

if (require.main === module) {
  const server = app.listen(PORT, BIND_HOST, () => {
    const cfg = loadConfig();
    alertManager.syncTimer();
    console.log(`Arb Scanner v3 API running at http://${BIND_HOST}:${PORT}`);
    console.log(`Configured hosts: local (${cfg.local.mode}) + ${cfg.servers.length} remote server(s)`);
    console.log(`Hummingbot image: ${cfg.hbImage} | Target Alerts: ${cfg.alerts.enabled ? 'ACTIVE' : 'OFF'}`);
    const loopback = ['127.0.0.1', 'localhost', '::1'].includes(BIND_HOST);
    if (!loopback && !cfg.apiToken) {
      console.warn('\n  WARNING: API is reachable from your network with NO API token set.');
      console.warn('  Anyone on this network can control your Hummingbot containers and SSH servers.');
      console.warn('  Generate a token in the UI: Alerts & Mobile -> Generate API Token.\n');
    }
  });

  const shutdown = () => {
    flushStats();
    paperEngine.stop();
    if (alertManager.timer) clearInterval(alertManager.timer);
    closeAllSsh();
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { app };
