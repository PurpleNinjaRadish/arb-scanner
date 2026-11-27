// ─── RPC Manager ──────────────────────────────────────────────────────────────
// Keeps a list of blockchain RPC endpoints per network, health-checks them
// (latency, block height, chain id, lag behind the best endpoint) and pushes
// the chosen ones into Hummingbot Gateway — the part of Hummingbot that talks
// to blockchains for DEX connectors (Uniswap, Jupiter, Raydium, ...).
//
// Push path, run inside the Gateway container with `docker exec … node`:
//   1. POST /config/update on Gateway's own API (validated against its schema)
//   2. if the API can't be reached, edit conf/*.yml directly (comments kept)
//   3. restart the container, because Gateway caches chain connections
//   4. read back /chains/<chain>/status to confirm the new RPC answers
// CEX strategies (amm_arb on Kraken/Coinbase, XEMM) don't use RPC at all.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const { loadConfig, updateConfig } = require('./config');

const DATA_DIR = process.env.ARB_DATA_DIR || path.join(__dirname, '..', 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'rpc_pushes.json');

// Gateway networks (conf/chains/<chain>/<network>.yml) and their public defaults
const NETWORKS = [
  { id: 'ethereum-mainnet', chain: 'ethereum', network: 'mainnet', label: 'Ethereum', chainId: 1, symbol: 'ETH', defaultUrl: 'https://eth-mainnet.g.alchemy.com/public', infura: 'mainnet', chainstack: true },
  { id: 'ethereum-arbitrum', chain: 'ethereum', network: 'arbitrum', label: 'Arbitrum One', chainId: 42161, symbol: 'ETH', defaultUrl: 'https://arb1.arbitrum.io/rpc', infura: 'arbitrum-mainnet', chainstack: true },
  { id: 'ethereum-base', chain: 'ethereum', network: 'base', label: 'Base', chainId: 8453, symbol: 'ETH', defaultUrl: 'https://mainnet.base.org', infura: 'base-mainnet', chainstack: true },
  { id: 'ethereum-optimism', chain: 'ethereum', network: 'optimism', label: 'Optimism', chainId: 10, symbol: 'ETH', defaultUrl: 'https://mainnet.optimism.io', infura: 'optimism-mainnet', chainstack: true },
  { id: 'ethereum-polygon', chain: 'ethereum', network: 'polygon', label: 'Polygon', chainId: 137, symbol: 'POL', defaultUrl: 'https://rpc.ankr.com/polygon', infura: 'polygon-mainnet', chainstack: true },
  { id: 'ethereum-bsc', chain: 'ethereum', network: 'bsc', label: 'BNB Chain', chainId: 56, symbol: 'BNB', defaultUrl: 'https://bsc-dataseed.bnbchain.org', infura: 'bsc-mainnet', chainstack: true },
  { id: 'ethereum-avalanche', chain: 'ethereum', network: 'avalanche', label: 'Avalanche C-Chain', chainId: 43114, symbol: 'AVAX', defaultUrl: 'https://api.avax.network/ext/bc/C/rpc', infura: 'avalanche-mainnet', chainstack: true },
  { id: 'ethereum-celo', chain: 'ethereum', network: 'celo', label: 'Celo', chainId: 42220, symbol: 'CELO', defaultUrl: 'https://rpc.ankr.com/celo', infura: 'celo-mainnet', chainstack: true },
  { id: 'ethereum-unichain', chain: 'ethereum', network: 'unichain', label: 'Unichain', chainId: 130, symbol: 'ETH', defaultUrl: 'https://mainnet.unichain.org', infura: null, chainstack: false },
  { id: 'ethereum-sepolia', chain: 'ethereum', network: 'sepolia', label: 'Sepolia (testnet)', chainId: 11155111, symbol: 'ETH', defaultUrl: 'https://rpc.ankr.com/eth_sepolia', infura: 'sepolia', chainstack: true, testnet: true },
  { id: 'solana-mainnet-beta', chain: 'solana', network: 'mainnet-beta', label: 'Solana', symbol: 'SOL', genesis: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d', defaultUrl: 'https://api.mainnet-beta.solana.com', infura: 'solana-mainnet', helius: 'mainnet', chainstack: true },
  { id: 'solana-devnet', chain: 'solana', network: 'devnet', label: 'Solana devnet', symbol: 'SOL', genesis: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG', defaultUrl: 'https://api.devnet.solana.com', infura: 'solana-devnet', helius: 'devnet', chainstack: true, testnet: true },
];
const NET = Object.fromEntries(NETWORKS.map(n => [n.id, n]));
const CHAINS = ['ethereum', 'solana'];
const PROVIDERS = {
  url: { label: 'Your URLs (per network)', chains: CHAINS },
  infura: { label: 'Infura', chains: ['ethereum', 'solana'] },
  helius: { label: 'Helius', chains: ['solana'] },
  chainstack: { label: 'Chainstack', chains: ['ethereum', 'solana'] },
};
const KEY_PROVIDERS = ['infura', 'helius', 'chainstack'];

const DEFAULT_RPC = {
  networks: {},              // { [networkId]: { endpoints: [{id,label,url,addedAt}], active: id|null } }
  apiKeys: { infura: '', helius: '', chainstack: '' },
  chainProvider: { ethereum: 'url', solana: 'url' },
  gatewayContainer: '',      // blank = auto-detect
  maxLagBlocks: 5,           // EVM endpoints further behind than this are "lagging"
  maxLagSlots: 50,           // Solana equivalent
  lastTests: {},             // { [networkId]: test result }
};

function rpcErr(msg, status = 400) { const e = new Error(msg); e.status = status; return e; }

function settings(cfg = loadConfig()) {
  const r = { ...DEFAULT_RPC, ...(cfg.rpc || {}) };
  r.apiKeys = { ...DEFAULT_RPC.apiKeys, ...(r.apiKeys || {}) };
  r.chainProvider = { ...DEFAULT_RPC.chainProvider, ...(r.chainProvider || {}) };
  r.networks = r.networks || {};
  r.lastTests = r.lastTests || {};
  return r;
}

// Hide API keys that live inside URLs: long path segments and query values
function maskUrl(url) {
  try {
    const u = new URL(url);
    const hide = s => (s.length >= 16 ? `${s.slice(0, 3)}…${s.slice(-3)}` : s);
    const p = u.pathname.split('/').map(hide).join('/');
    const q = [...u.searchParams.entries()].map(([k, v]) => `${k}=${v.length > 6 ? `${v.slice(0, 3)}…${v.slice(-2)}` : v}`);
    return `${u.protocol}//${u.host}${p === '/' ? '' : p}${q.length ? `?${q.join('&')}` : ''}`;
  } catch (_) { return '(invalid url)'; }
}
const maskKey = k => (k ? `${k.slice(0, 4)}…${k.slice(-3)}` : '');

function publicSettings(cfg = loadConfig()) {
  const r = settings(cfg);
  const networks = NETWORKS.map(n => {
    const s = r.networks[n.id] || { endpoints: [], active: null };
    return {
      ...n,
      provider: r.chainProvider[n.chain] || 'url',
      active: s.active || null,
      endpoints: (s.endpoints || []).map(e => ({ id: e.id, label: e.label, url: maskUrl(e.url), addedAt: e.addedAt, hasSecret: maskUrl(e.url) !== e.url })),
      lastTest: r.lastTests[n.id] || null,
    };
  });
  return {
    networks,
    providers: PROVIDERS,
    chainProvider: r.chainProvider,
    apiKeys: Object.fromEntries(KEY_PROVIDERS.map(k => [k, { set: !!r.apiKeys[k], preview: maskKey(r.apiKeys[k]) }])),
    gatewayContainer: r.gatewayContainer,
    maxLagBlocks: r.maxLagBlocks,
    maxLagSlots: r.maxLagSlots,
  };
}

// ─── Editing ─────────────────────────────────────────────────────────────────
function validUrl(url) {
  let u;
  try { u = new URL(String(url || '').trim()); } catch (_) { throw rpcErr('Enter a full URL, e.g. https://…'); }
  if (!['https:', 'http:', 'wss:', 'ws:'].includes(u.protocol)) throw rpcErr('RPC URL must start with https:// (or http:// for a node on your own network)');
  if (u.protocol.startsWith('ws')) throw rpcErr('Gateway needs the HTTPS RPC URL, not the WebSocket (wss://) one');
  const local = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|host\.docker\.internal$|\[?::1\]?$)/.test(u.hostname);
  if (u.protocol === 'http:' && !local) throw rpcErr('Plain http:// is only allowed for nodes on your own network — use https:// for hosted RPC');
  u.hash = '';
  return u.pathname === '/' && !u.search ? u.origin : u.toString();
}

function netOrThrow(id) {
  const n = NET[id];
  if (!n) throw rpcErr(`Unknown network: ${id}`);
  return n;
}

function addEndpoint({ network, url, label }) {
  const n = netOrThrow(network);
  const clean = validUrl(url);
  let added;
  updateConfig(c => {
    c.rpc = settings(c);
    const s = c.rpc.networks[n.id] || (c.rpc.networks[n.id] = { endpoints: [], active: null });
    if (s.endpoints.some(e => e.url === clean)) throw rpcErr('That endpoint is already in the list');
    if (s.endpoints.length >= 12) throw rpcErr('12 endpoints per network is the limit');
    added = { id: crypto.randomBytes(5).toString('hex'), label: String(label || new URL(clean).hostname).slice(0, 60), url: clean, addedAt: Date.now() };
    s.endpoints.push(added);
    if (!s.active) s.active = added.id;
  });
  return { id: added.id };
}

function removeEndpoint(network, id) {
  netOrThrow(network);
  updateConfig(c => {
    c.rpc = settings(c);
    const s = c.rpc.networks[network];
    if (!s) return;
    s.endpoints = s.endpoints.filter(e => e.id !== id);
    if (s.active === id) s.active = s.endpoints[0] ? s.endpoints[0].id : null;
  });
}

function setActive(network, id) {
  netOrThrow(network);
  updateConfig(c => {
    c.rpc = settings(c);
    const s = c.rpc.networks[network] || (c.rpc.networks[network] = { endpoints: [], active: null });
    if (id && !s.endpoints.some(e => e.id === id)) throw rpcErr('No such endpoint');
    s.active = id || null;
  });
}

function updateSettings(body = {}) {
  updateConfig(c => {
    c.rpc = settings(c);
    if (body.apiKeys && typeof body.apiKeys === 'object') {
      for (const k of KEY_PROVIDERS) {
        const v = body.apiKeys[k];
        if (typeof v !== 'string') continue;
        if (v && !/^[A-Za-z0-9._:-]{8,200}$/.test(v.trim())) throw rpcErr(`${PROVIDERS[k].label} key looks wrong (letters, digits, - _ . : only)`);
        c.rpc.apiKeys[k] = v.trim();
      }
    }
    if (body.chainProvider && typeof body.chainProvider === 'object') {
      for (const ch of CHAINS) {
        const p = body.chainProvider[ch];
        if (p === undefined) continue;
        if (!PROVIDERS[p] || !PROVIDERS[p].chains.includes(ch)) throw rpcErr(`${p} is not a provider for ${ch}`);
        c.rpc.chainProvider[ch] = p;
      }
    }
    if (typeof body.gatewayContainer === 'string') {
      const g = body.gatewayContainer.trim();
      if (g && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(g)) throw rpcErr('Invalid container name');
      c.rpc.gatewayContainer = g;
    }
    if (body.maxLagBlocks !== undefined) c.rpc.maxLagBlocks = Math.max(1, Math.min(500, +body.maxLagBlocks || 5));
    if (body.maxLagSlots !== undefined) c.rpc.maxLagSlots = Math.max(5, Math.min(5000, +body.maxLagSlots || 50));
  });
  return publicSettings();
}

// URL a provider would give Gateway for a network (for testing only; Chainstack
// discovers nodes through its own API, so it can't be built here)
function providerUrl(provider, n, keys) {
  const key = keys[provider];
  if (!key) return null;
  if (provider === 'infura' && n.infura) return `https://${n.infura}.infura.io/v3/${key}`;
  if (provider === 'helius' && n.helius) return `https://${n.helius}.helius-rpc.com/?api-key=${key}`;
  return null;
}

// ─── Health checks ───────────────────────────────────────────────────────────
let rpcId = 1;
async function rpcCall(url, method, params = [], timeout = 8000) {
  const t0 = process.hrtime.bigint();
  const r = await axios.post(url, { jsonrpc: '2.0', id: rpcId++, method, params }, {
    timeout, headers: { 'content-type': 'application/json', 'user-agent': 'arb-scanner-rpc/1' }, validateStatus: () => true,
  });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (r.status === 429) throw Object.assign(new Error('Rate limited (HTTP 429)'), { ms });
  if (r.status === 401 || r.status === 403) throw Object.assign(new Error(`Refused (HTTP ${r.status}) — wrong key, IP not allowed, or region blocked`), { ms });
  if (r.status >= 400) throw Object.assign(new Error(`HTTP ${r.status}`), { ms });
  const body = r.data || {};
  if (body.error) throw Object.assign(new Error(body.error.message || JSON.stringify(body.error)), { ms });
  return { result: body.result, ms };
}

const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };

async function testUrl(n, url, { samples = 3, timeout = 8000, call = rpcCall } = {}) {
  const out = { ok: false, latencyMs: null, coldMs: null, head: null, identityOk: null, error: null, samples: 0 };
  try {
    if (n.chain === 'ethereum') {
      const id = await call(url, 'eth_chainId', [], timeout);
      out.coldMs = round(id.ms);
      const got = parseInt(id.result, 16);
      out.identityOk = got === n.chainId;
      if (!out.identityOk) out.error = `Wrong chain: this URL is chain id ${got}, ${n.label} is ${n.chainId}`;
    } else {
      const g = await call(url, 'getGenesisHash', [], timeout);
      out.coldMs = round(g.ms);
      out.identityOk = g.result === n.genesis;
      if (!out.identityOk) out.error = `Wrong cluster: genesis ${String(g.result).slice(0, 8)}… is not ${n.label}`;
    }
    const lat = [];
    for (let i = 0; i < samples; i++) {
      const h = n.chain === 'ethereum'
        ? await call(url, 'eth_blockNumber', [], timeout)
        : await call(url, 'getSlot', [{ commitment: 'confirmed' }], timeout);
      lat.push(h.ms);
      out.head = n.chain === 'ethereum' ? parseInt(h.result, 16) : Number(h.result);
    }
    out.samples = lat.length;
    out.latencyMs = round(median(lat));
    out.ok = !!out.identityOk && Number.isFinite(out.head);
  } catch (e) {
    out.error = e.code === 'ECONNABORTED' ? `Timed out after ${timeout / 1000}s` : (e.code === 'ENOTFOUND' ? 'Host not found' : e.message);
    if (e.ms && out.coldMs === null) out.coldMs = round(e.ms);
  }
  return out;
}
const round = x => (x == null ? null : Math.round(x * 10) / 10);

// Test every candidate for a network: your endpoints, the provider URL and the public default
async function testNetwork(networkId, opts = {}) {
  const n = netOrThrow(networkId);
  const r = settings();
  const s = r.networks[n.id] || { endpoints: [], active: null };
  const cands = s.endpoints.map(e => ({ kind: 'endpoint', id: e.id, label: e.label, url: e.url }));
  for (const p of ['infura', 'helius']) {
    const u = providerUrl(p, n, r.apiKeys);
    if (u) cands.push({ kind: 'provider', id: `provider:${p}`, label: `${PROVIDERS[p].label} (API key)`, url: u });
  }
  if (!cands.some(c => c.url === n.defaultUrl)) cands.push({ kind: 'default', id: 'default', label: 'Gateway default (public)', url: n.defaultUrl });

  const results = await Promise.all(cands.map(async c => ({ ...c, url: maskUrl(c.url), ...(await testUrl(n, c.url, opts)) })));
  const best = Math.max(...results.filter(x => x.ok).map(x => x.head), -Infinity);
  const maxLag = n.chain === 'ethereum' ? r.maxLagBlocks : r.maxLagSlots;
  for (const x of results) {
    x.lag = x.ok && Number.isFinite(best) ? best - x.head : null;
    x.lagging = x.lag != null && x.lag > maxLag;
    x.healthy = x.ok && !x.lagging;
  }
  results.sort((a, b) => (b.healthy - a.healthy) || ((a.latencyMs ?? 1e9) - (b.latencyMs ?? 1e9)));
  const fastest = results.find(x => x.healthy) || null;
  const test = {
    at: Date.now(), network: n.id, unit: n.chain === 'ethereum' ? 'blocks' : 'slots', maxLag,
    results, fastestId: fastest ? fastest.id : null,
    activeId: s.active || null,
    activeHealthy: s.active ? !!(results.find(x => x.id === s.active) || {}).healthy : null,
  };
  if (!opts.noSave) updateConfig(c => { c.rpc = settings(c); c.rpc.lastTests[n.id] = test; });
  return test;
}

async function testAll(opts = {}) {
  const r = settings();
  const ids = opts.networks && opts.networks.length ? opts.networks : NETWORKS.filter(n => (r.networks[n.id] || {}).endpoints?.length).map(n => n.id);
  const out = {};
  for (const id of ids) out[id] = await testNetwork(id, opts); // sequential: be polite to free RPCs
  return out;
}

// Make the fastest healthy endpoint active (only your own endpoints, never a provider or default)
async function pickFastest(networkId) {
  const t = await testNetwork(networkId);
  const own = t.results.find(x => x.healthy && x.kind === 'endpoint');
  if (!own) throw rpcErr('None of your endpoints for this network passed the test', 409);
  setActive(networkId, own.id);
  return { activeId: own.id, test: t };
}

// ─── Hummingbot Gateway (runs inside the Gateway container) ──────────────────
// Self-contained: serialized with toString() and executed by `node -e`, so it
// can't use anything from this file. Prints one line: @@RPC@@<json>.
/* eslint-disable */
async function gatewayAgent(p) {
  const fs = require('fs'), path = require('path'), http = require('http'), https = require('https');
  const out = { ok: true, confDir: null, api: null, results: [], restartNeeded: false };
  const dirs = [p.confDir, '/home/gateway/conf', path.join(process.cwd(), 'conf'), '/usr/src/app/conf'].filter(Boolean);
  const confDir = dirs.find(d => { try { return fs.existsSync(path.join(d, 'server.yml')); } catch (_) { return false; } });
  if (!confDir) return { ok: false, error: 'Could not find Gateway conf folder (server.yml) in the container' };
  out.confDir = confDir;
  const rd = f => { try { return fs.readFileSync(path.join(confDir, f), 'utf8'); } catch (_) { return null; } };
  const esc = k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const topVal = (text, key) => {
    const m = text && text.match(new RegExp('^' + esc(key) + ':[ \\t]*(.*)$', 'm'));
    if (!m) return null;
    let v = m[1].trim();
    if (/^'.*'$/.test(v)) return v.slice(1, -1).replace(/''/g, "'");
    if (/^".*"$/.test(v)) { try { return JSON.parse(v); } catch (_) { return v.slice(1, -1); } }
    return v.replace(/\s+#.*$/, '').trim();
  };
  const q = v => (typeof v === 'number' || typeof v === 'boolean') ? String(v) : "'" + String(v).replace(/'/g, "''") + "'";
  const setTop = (text, key, value) => {
    const re = new RegExp('^' + esc(key) + ':[ \\t]*.*$', 'm');
    const line = key + ': ' + q(value);
    return re.test(text) ? text.replace(re, () => line) : text.replace(/\s*$/, '\n') + line + '\n';
  };
  const port = Number(topVal(rd('server.yml'), 'port')) || 15888;
  const certDir = [p.certDir, '/home/gateway/certs', path.join(confDir, '..', 'certs')].find(d => d && fs.existsSync(path.join(d, 'client_cert.pem')));
  const devMode = process.env.DEV === 'true' || process.env.GATEWAY_TEST_MODE === 'dev';
  function request(useHttps, method, urlPath, body) {
    return new Promise(resolve => {
      const headers = { 'content-type': 'application/json' };
      if (process.env.GATEWAY_API_KEY) headers.authorization = 'Bearer ' + process.env.GATEWAY_API_KEY;
      const o = { host: '127.0.0.1', port, path: urlPath, method, headers, timeout: 10000 };
      let mod = http;
      if (useHttps) {
        if (!certDir) return resolve({ error: 'HTTPS mode but no client certificates found' });
        mod = https;
        try {
          Object.assign(o, {
            ca: fs.readFileSync(path.join(certDir, 'ca_cert.pem')), cert: fs.readFileSync(path.join(certDir, 'client_cert.pem')),
            key: fs.readFileSync(path.join(certDir, 'client_key.pem')), passphrase: process.env.GATEWAY_PASSPHRASE || undefined,
            servername: 'localhost', checkServerIdentity: () => undefined,
          });
        } catch (e) { return resolve({ error: 'Could not load client certificates: ' + e.message }); }
      }
      const rq = mod.request(o, res => {
        let d = ''; res.on('data', c => { d += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (_) {} resolve({ status: res.statusCode, body: j, text: d.slice(0, 300) }); });
      });
      rq.on('timeout', () => rq.destroy(new Error('timeout')));
      rq.on('error', e => resolve({ error: e.message }));
      if (body) rq.write(JSON.stringify(body));
      rq.end();
    });
  }
  let scheme = null;
  async function api(method, urlPath, body) {
    const order = scheme ? [scheme] : (devMode ? ['http'] : ['https', 'http']);
    let last = null;
    for (const s of order) {
      const r = await request(s === 'https', method, urlPath, body);
      if (!r.error) { scheme = s; return r; }
      last = r;
    }
    return last;
  }

  if (p.action === 'read') {
    const nets = {};
    for (const n of p.networks) {
      const t = rd('chains/' + n.chain + '/' + n.network + '.yml');
      nets[n.id] = t == null ? { present: false } : { present: true, nodeURL: topVal(t, 'nodeURL'), chainID: topVal(t, 'chainID') };
    }
    const chains = {};
    for (const c of ['ethereum', 'solana']) { const t = rd('chains/' + c + '.yml'); chains[c] = t == null ? null : { rpcProvider: topVal(t, 'rpcProvider') || 'url', defaultNetwork: topVal(t, 'defaultNetwork') }; }
    const keysText = rd('apiKeys.yml');
    const apiKeys = {};
    for (const k of ['infura', 'helius', 'chainstack']) { const v = topVal(keysText, k); apiKeys[k] = v ? v.slice(0, 4) + '…' + v.slice(-3) : ''; }
    out.read = { networks: nets, chains, apiKeys, hasApiKeysFile: keysText != null };
    const ping = await api('GET', '/', null);
    out.api = ping.error ? { reachable: false, error: ping.error } : { reachable: true, scheme, status: ping.status };
    return out;
  }

  if (p.action === 'push') {
    const ping = await api('GET', '/', null);
    const apiOk = !ping.error && ping.status < 500;
    out.api = apiOk ? { reachable: true, scheme } : { reachable: false, error: ping.error || ('HTTP ' + ping.status) };
    for (const u of p.updates) {
      const res = { namespace: u.namespace, path: u.path, file: u.file, via: null, ok: false };
      if (apiOk) {
        const r = await api('POST', '/config/update', { namespace: u.namespace, path: u.path, value: u.value });
        if (!r.error && r.status === 200) { res.via = 'api'; res.ok = true; }
        else res.apiError = r.error || ((r.body && r.body.message) || ('HTTP ' + r.status));
      }
      if (!res.ok) {
        const t = rd(u.file);
        if (t == null && !u.create) { res.error = u.file + ' does not exist in ' + confDir; }
        else {
          try {
            const full = path.join(confDir, u.file);
            const next = setTop(t || '', u.key || u.path, u.value);
            fs.writeFileSync(full + '.arbtmp', next);
            fs.renameSync(full + '.arbtmp', full);
            res.via = 'file'; res.ok = true;
          } catch (e) { res.error = 'Write failed: ' + e.message; }
        }
      }
      out.results.push(res);
    }
    out.ok = out.results.every(r => r.ok);
    out.restartNeeded = out.results.some(r => r.ok);
    return out;
  }

  if (p.action === 'status') {
    const st = {};
    for (const n of p.networks) {
      const r = await api('GET', '/chains/' + n.chain + '/status?network=' + encodeURIComponent(n.network), null);
      st[n.id] = r.error ? { ok: false, error: r.error } : (r.status === 200 && r.body ? { ok: true, rpcUrl: r.body.rpcUrl, block: r.body.currentBlockNumber } : { ok: false, error: (r.body && r.body.message) || ('HTTP ' + r.status) });
    }
    out.status = st;
    out.api = { reachable: Object.values(st).some(s => s.ok || !/ECONNREFUSED|socket hang up|timeout/.test(s.error || '')), scheme };
    return out;
  }
  return { ok: false, error: 'unknown action' };
}
/* eslint-enable */

function agentCommand(payload) {
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64');
  const code = `(${gatewayAgent.toString()})(JSON.parse(Buffer.from(process.argv[1],'base64').toString())).then(r=>console.log('@@RPC@@'+JSON.stringify(r)),e=>console.log('@@RPC@@'+JSON.stringify({ok:false,error:String(e&&e.message||e)})))`;
  return { code, b64 };
}

function parseAgentOutput(stdout) {
  const line = String(stdout || '').split('\n').reverse().find(l => l.startsWith('@@RPC@@'));
  if (!line) return null;
  try { return JSON.parse(line.slice(7)); } catch (_) { return null; }
}

async function findGateway(host, preferred) {
  const r = await host.dockerRaw(['ps', '-a', '--format', '{{.Names}}|{{.Image}}|{{.State}}|{{.Status}}'], { timeout: 20000 });
  if (r.code !== 0) throw rpcErr(`Docker isn't reachable on ${host.name}: ${(r.stderr || '').trim().slice(0, 160)}`, 502);
  const rows = r.stdout.split('\n').filter(Boolean).map(l => { const [name, image, state, status] = l.split('|'); return { name, image, state, status }; });
  const pick = (preferred && rows.find(x => x.name === preferred))
    || rows.find(x => /hummingbot\/gateway/.test(x.image) && x.state === 'running')
    || rows.find(x => x.name === 'gateway')
    || rows.find(x => /hummingbot\/gateway/.test(x.image));
  if (!pick) {
    throw rpcErr(preferred
      ? `No container named "${preferred}" on ${host.name}`
      : `No Hummingbot Gateway container found on ${host.name}. Gateway is only needed for DEX connectors — start it with Hummingbot's docker compose (gateway service) and try again.`, 404);
  }
  return pick;
}

async function runAgent(host, container, payload, timeout = 60000) {
  const { code, b64 } = agentCommand(payload);
  const r = await host.dockerRaw(['exec', container, 'node', '-e', code, b64], { timeout });
  const parsed = parseAgentOutput(r.stdout);
  if (!parsed) throw rpcErr(`Gateway agent failed in ${container}: ${(r.stderr || r.stdout || `exit ${r.code}`).trim().slice(0, 240)}`, 502);
  return parsed;
}

function deps(over = {}) {
  return { getHost: require('./hosts').getHost, sleep: ms => new Promise(r => setTimeout(r, ms)), ...over };
}

async function gatewayStatus(target = 'local', d = deps()) {
  const host = d.getHost(target);
  const r = settings();
  const gw = await findGateway(host, r.gatewayContainer);
  if (gw.state !== 'running') return { host: host.name, container: gw.name, image: gw.image, running: false, state: gw.status };
  const res = await runAgent(host, gw.name, { action: 'read', networks: NETWORKS });
  const read = res.read || { networks: {}, chains: {}, apiKeys: {} };
  const networks = {};
  for (const n of NETWORKS) {
    const g = read.networks[n.id] || {};
    const own = (r.networks[n.id] || { endpoints: [] });
    const active = own.endpoints.find(e => e.id === own.active);
    networks[n.id] = {
      present: !!g.present,
      nodeURL: g.nodeURL ? maskUrl(g.nodeURL) : null,
      matchesActive: active ? g.nodeURL === active.url : null,
      isDefault: g.nodeURL === n.defaultUrl,
    };
  }
  return { host: host.name, container: gw.name, image: gw.image, running: true, confDir: res.confDir, api: res.api, chains: read.chains, apiKeys: read.apiKeys, networks };
}

// Copy Gateway's current nodeURLs into the manager (so nothing is lost before a push)
async function importFromGateway(target = 'local', d = deps()) {
  const host = d.getHost(target);
  const r = settings();
  const gw = await findGateway(host, r.gatewayContainer);
  const res = await runAgent(host, gw.name, { action: 'read', networks: NETWORKS });
  let imported = 0;
  updateConfig(c => {
    c.rpc = settings(c);
    for (const n of NETWORKS) {
      const url = res.read && res.read.networks[n.id] && res.read.networks[n.id].nodeURL;
      if (!url || url === n.defaultUrl) continue;
      let clean; try { clean = validUrl(url); } catch (_) { continue; }
      const s = c.rpc.networks[n.id] || (c.rpc.networks[n.id] = { endpoints: [], active: null });
      if (s.endpoints.some(e => e.url === clean)) continue;
      const e = { id: crypto.randomBytes(5).toString('hex'), label: `From Gateway (${host.name})`, url: clean, addedAt: Date.now() };
      s.endpoints.push(e);
      if (!s.active) s.active = e.id;
      imported++;
    }
  });
  return { imported, container: gw.name };
}

function buildUpdates(r, networkIds, { includeKeys = true, includeProviders = true } = {}) {
  const updates = [];
  const skipped = [];
  for (const id of networkIds) {
    const n = netOrThrow(id);
    const s = r.networks[id] || { endpoints: [] };
    const e = s.endpoints.find(x => x.id === s.active);
    if (!e) { skipped.push({ network: id, reason: 'no active endpoint' }); continue; }
    updates.push({ namespace: id, path: 'nodeURL', value: e.url, file: `chains/${n.chain}/${n.network}.yml`, network: id });
  }
  if (includeKeys) {
    for (const k of KEY_PROVIDERS) if (r.apiKeys[k]) updates.push({ namespace: 'apiKeys', path: k, value: r.apiKeys[k], file: 'apiKeys.yml', create: true });
  }
  if (includeProviders) {
    for (const ch of CHAINS) {
      const p = r.chainProvider[ch] || 'url';
      if (p !== 'url' && !r.apiKeys[p]) throw rpcErr(`${ch} is set to use ${PROVIDERS[p].label} but no ${PROVIDERS[p].label} API key is saved`);
      updates.push({ namespace: ch, path: 'rpcProvider', value: p, file: `chains/${ch}.yml` });
    }
  }
  return { updates, skipped };
}

// Push active endpoints (and provider settings) into Gateway on a host
async function pushToGateway({ target = 'local', networks, includeKeys = true, includeProviders = true, restart = true, force = false } = {}, d = deps()) {
  const r = settings();
  const ids = (networks && networks.length ? networks : NETWORKS.filter(n => (r.networks[n.id] || {}).active).map(n => n.id));
  if (!ids.length && !includeProviders && !includeKeys) throw rpcErr('Nothing to push — pick an active endpoint for at least one network');

  // Never push an endpoint that just failed its health check, unless forced
  const tests = {};
  if (!force) {
    for (const id of ids) {
      const t = await testNetwork(id, { samples: 1 });
      tests[id] = t;
      if (t.activeHealthy === false) {
        const a = t.results.find(x => x.id === t.activeId);
        throw rpcErr(`${NET[id].label}: the active endpoint failed its check (${(a && (a.error || (a.lagging ? `${a.lag} ${t.unit} behind` : 'unhealthy'))) || 'no answer'}). Pick another or push with force.`, 409);
      }
    }
  }
  const { updates, skipped } = buildUpdates(r, ids, { includeKeys, includeProviders });
  const host = d.getHost(target);
  const gw = await findGateway(host, r.gatewayContainer);
  if (gw.state !== 'running') throw rpcErr(`Gateway container ${gw.name} is not running (${gw.status})`, 409);

  const res = await runAgent(host, gw.name, { action: 'push', updates: updates.map(({ network, ...u }) => u) });
  const results = res.results.map((x, i) => ({ ...x, network: updates[i].network || null, value: x.path === 'nodeURL' ? maskUrl(updates[i].value) : (KEY_PROVIDERS.includes(x.path) ? maskKey(updates[i].value) : updates[i].value) }));
  const record = {
    id: crypto.randomBytes(5).toString('hex'), at: Date.now(), target, host: host.name, container: gw.name,
    ok: res.ok, api: res.api, results, skipped, restarted: false, verify: null,
  };

  if (restart && res.restartNeeded) {
    const rr = await host.dockerRaw(['restart', gw.name], { timeout: 90000 });
    record.restarted = rr.code === 0;
    if (rr.code !== 0) record.restartError = (rr.stderr || '').trim().slice(0, 200);
    else {
      // Gateway takes a few seconds to come back; then confirm each network answers
      const nets = ids.map(id => NET[id]);
      for (let i = 0; i < 8 && nets.length; i++) {
        await d.sleep(i === 0 ? 4000 : 3000);
        try {
          const st = await runAgent(host, gw.name, { action: 'status', networks: nets }, 60000);
          if (st.api && st.api.reachable) { record.verify = st.status; break; }
        } catch (_) { /* still starting */ }
      }
    }
  }
  if (record.verify) {
    for (const [id, v] of Object.entries(record.verify)) if (v.rpcUrl) v.rpcUrl = maskUrl(v.rpcUrl);
  }
  saveHistory(record);
  return record;
}

function history() {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch (_) { return []; }
}
function saveHistory(rec) {
  const list = [rec, ...history()].slice(0, 30);
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(HISTORY_FILE, JSON.stringify(list, null, 1)); } catch (_) {}
}

module.exports = {
  NETWORKS, PROVIDERS, settings, publicSettings, maskUrl, validUrl,
  addEndpoint, removeEndpoint, setActive, updateSettings,
  testUrl, testNetwork, testAll, pickFastest,
  gatewayAgent, agentCommand, parseAgentOutput, findGateway, buildUpdates,
  gatewayStatus, importFromGateway, pushToGateway, history,
};
