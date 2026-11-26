// ─── Hummingbot Latency Test ──────────────────────────────────────────────────
// Measures exchange latency FROM each host where bots run (your PC, each remote
// server over SSH) and compares the hosts.
//
// Preferred method: a throwaway container from your Hummingbot image on that host
// runs a small Python probe, so the numbers include Docker networking exactly as a
// bot sees it. Fallbacks: curl over the host shell (Linux/SSH), or the backend
// itself (Windows PC without the image).
//
// For each exchange it records: DNS lookup, TCP connect (≈ network round trip),
// TLS handshake, a cold first request, and N warm requests on a kept-alive
// connection (what a running bot experiences: median, p90, jitter).
const fs = require('fs');
const path = require('path');
const dns = require('dns');
const net = require('net');
const tls = require('tls');
const http = require('http');
const https = require('https');
const { EXCHANGES } = require('./exchanges');
const { getHost, listHosts, shq } = require('./hosts');
const { loadConfig } = require('./config');

const DATA_DIR = process.env.ARB_DATA_DIR || path.join(__dirname, '..', 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'latency_tests.json');

const PAIRS = [
  { id: 'kraken_coinbase', a: 'kraken', b: 'coinbase', label: 'Kraken × Coinbase' },
  { id: 'binanceus_kraken', a: 'binanceus', b: 'kraken', label: 'Binance.US × Kraken' },
  { id: 'binance_kraken', a: 'binance', b: 'kraken', label: 'Binance × Kraken' },
  { id: 'bybit_kraken', a: 'bybit', b: 'kraken', label: 'Bybit × Kraken' },
  { id: 'okx_coinbase', a: 'okx', b: 'coinbase', label: 'OKX × Coinbase' },
  { id: 'kucoin_kraken', a: 'kucoin', b: 'kraken', label: 'KuCoin × Kraken' },
];
const BLOCKED_STATUS = new Set([403, 451]);

const round = (n, d = 1) => (n == null || !Number.isFinite(n) ? null : Number(n.toFixed(d)));
const median = (a) => { const v = [...a].sort((x, y) => x - y); const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
const pct = (a, p) => { const v = [...a].sort((x, y) => x - y); const k = (v.length - 1) * p; const f = Math.floor(k); const c = Math.min(f + 1, v.length - 1); return v[f] + (v[c] - v[f]) * (k - f); };
const stdev = (a) => { const m = a.reduce((t, x) => t + x, 0) / a.length; return Math.sqrt(a.reduce((t, x) => t + (x - m) ** 2, 0) / a.length); };

function summarizeWarm(w) {
  if (!w.length) return null;
  return { n: w.length, min: round(Math.min(...w)), median: round(median(w)), p90: round(pct(w, 0.9)), max: round(Math.max(...w)), jitter: round(stdev(w)) };
}

// ─── Probe 1: Python inside a Hummingbot container ──────────────────────────
const PY_PROBE = `
import base64, json, socket, ssl, time, statistics, http.client
from urllib.parse import urlparse
from concurrent.futures import ThreadPoolExecutor
cfg = json.loads(base64.b64decode('__CFG__').decode())
N = int(cfg['n'])
def pct(a, p):
    a = sorted(a); k = (len(a) - 1) * p; f = int(k); c = min(f + 1, len(a) - 1)
    return a[f] + (a[c] - a[f]) * (k - f)
def probe(item):
    ex, url = item
    u = urlparse(url); secure = u.scheme == 'https'
    host = u.hostname; port = u.port or (443 if secure else 80)
    path = (u.path or '/') + ('?' + u.query if u.query else '')
    r = {'ok': False}
    try:
        t0 = time.perf_counter(); ai = socket.getaddrinfo(host, port, 0, socket.SOCK_STREAM); t1 = time.perf_counter()
        ip = ai[0][4][0]; r['ip'] = ip; r['dnsMs'] = (t1 - t0) * 1000
        s = socket.create_connection((ip, port), timeout=6); t2 = time.perf_counter(); r['tcpMs'] = (t2 - t1) * 1000
        if secure:
            s = ssl.create_default_context().wrap_socket(s, server_hostname=host); r['tlsMs'] = (time.perf_counter() - t2) * 1000
        s.close()
        Conn = http.client.HTTPSConnection if secure else http.client.HTTPConnection
        c = Conn(host, port, timeout=8)
        hdr = {'User-Agent': 'arb-scanner-latency/1', 'Accept': 'application/json'}
        a = time.perf_counter(); c.request('GET', path, headers=hdr); resp = c.getresponse(); resp.read()
        r['coldMs'] = (time.perf_counter() - a) * 1000; r['status'] = resp.status
        w = []; reconnects = 0
        for i in range(N):
            time.sleep(0.15)
            if c.sock is None: reconnects += 1
            a = time.perf_counter(); c.request('GET', path, headers=hdr); resp = c.getresponse(); resp.read()
            w.append((time.perf_counter() - a) * 1000); r['status'] = resp.status
        c.close()
        r['warmSamples'] = w; r['reconnects'] = reconnects; r['ok'] = True
    except Exception as e:
        r['error'] = type(e).__name__ + ': ' + str(e)[:160]
    return ex, r
with ThreadPoolExecutor(max_workers=8) as pool:
    out = dict(pool.map(probe, cfg['t'].items()))
print('LATENCY_JSON' + json.dumps(out))
`;

function pythonCommand(targets, samples) {
  const cfg = Buffer.from(JSON.stringify({ t: targets, n: samples })).toString('base64');
  const code = Buffer.from(PY_PROBE.replace('__CFG__', cfg)).toString('base64');
  return `import base64;exec(base64.b64decode('${code}').decode())`;
}

function parseProbeOutput(stdout) {
  const line = String(stdout || '').split(/\r?\n/).find(l => l.startsWith('LATENCY_JSON'));
  if (!line) return null;
  const raw = JSON.parse(line.slice('LATENCY_JSON'.length));
  const out = {};
  for (const [ex, r] of Object.entries(raw)) {
    out[ex] = {
      ok: !!r.ok, error: r.error || null, ip: r.ip || null, status: r.status ?? null,
      dnsMs: round(r.dnsMs), tcpMs: round(r.tcpMs), tlsMs: round(r.tlsMs), coldMs: round(r.coldMs),
      warm: r.warmSamples ? summarizeWarm(r.warmSamples) : null, reconnects: r.reconnects || 0,
    };
  }
  return out;
}

async function runInHummingbot(host, image, targets, samples) {
  const inspect = await host.dockerRaw(['image', 'inspect', image, '--format', '{{.Id}}'], { timeout: 15000 });
  if (inspect.code !== 0) return { skipped: `Hummingbot image ${image} is not on this host` };
  const findPython = 'for p in python3 python /opt/conda/envs/hummingbot/bin/python /opt/conda/bin/python; do if command -v "$p" >/dev/null 2>&1; then exec "$p" -c "$1"; fi; done; echo NO_PYTHON; exit 9';
  const r = await host.dockerRaw(['run', '--rm', '--entrypoint', '/bin/sh', image, '-c', findPython, 'sh', pythonCommand(targets, samples)], { timeout: 120000 });
  const results = parseProbeOutput(r.stdout);
  if (!results) return { skipped: `Probe in Hummingbot container failed: ${(r.stderr || r.stdout || '').trim().slice(0, 200) || `exit ${r.code}`}` };
  return { method: 'hummingbot-container', results };
}

// ─── Probe 2: curl over the host shell (Linux / WSL / SSH) ──────────────────
async function runCurl(host, targets, samples) {
  const fmt = '%{http_code} %{time_namelookup} %{time_connect} %{time_appconnect} %{time_starttransfer} %{remote_ip} %{num_connects}\\n';
  const script = Object.entries(targets).map(([ex, url]) => {
    const urls = Array.from({ length: samples + 1 }, () => `-o /dev/null ${shq(url)}`).join(' ');
    return `curl -s -m 30 -H 'User-Agent: arb-scanner-latency/1' -w ${shq(fmt)} ${urls} 2>/dev/null | sed "s/^/${ex} /" || echo "${ex} 000 0 0 0 0 - 0"`;
  }).join('\n');
  const r = await host.sh(script, { timeout: 120000 });
  const by = {};
  for (const line of r.stdout.split('\n').filter(Boolean)) {
    const [ex, code, dnsS, connS, tlsS, ttfbS, ip, nconn] = line.trim().split(/\s+/);
    (by[ex] = by[ex] || []).push({ code: +code, dns: +dnsS * 1000, conn: +connS * 1000, tls: +tlsS * 1000, ttfb: +ttfbS * 1000, ip, nconn: +nconn });
  }
  const results = {};
  for (const ex of Object.keys(targets)) {
    const rows = by[ex] || [];
    const first = rows[0];
    if (!first || !first.code) { results[ex] = { ok: false, status: null, error: 'unreachable' }; continue; }
    const warm = rows.slice(1).filter(x => x.code).map(x => x.ttfb - (x.nconn ? x.tls || x.conn : 0));
    results[ex] = {
      ok: true, status: first.code, ip: first.ip, error: null,
      dnsMs: round(first.dns), tcpMs: round(first.conn - first.dns), tlsMs: first.tls ? round(first.tls - first.conn) : null, coldMs: round(first.ttfb),
      warm: summarizeWarm(warm.filter(x => x > 0)), reconnects: rows.slice(1).filter(x => x.nconn > 0).length,
    };
  }
  return { method: 'host-curl', results };
}

// ─── Probe 3: the backend itself (same machine as a local Windows PC) ────────
async function nodeProbe(url, samples) {
  const u = new URL(url);
  const secure = u.protocol === 'https:';
  const port = Number(u.port) || (secure ? 443 : 80);
  const r = { ok: false };
  try {
    const t0 = performance.now();
    const { address } = await dns.promises.lookup(u.hostname);
    const t1 = performance.now();
    r.ip = address; r.dnsMs = t1 - t0;
    const sock = await new Promise((res, rej) => { const s = net.connect({ host: address, port, timeout: 6000 }, () => res(s)); s.on('error', rej); s.on('timeout', () => rej(new Error('connect timeout'))); });
    const t2 = performance.now(); r.tcpMs = t2 - t1;
    if (secure) {
      const ts = await new Promise((res, rej) => { const s = tls.connect({ socket: sock, servername: u.hostname }, () => res(s)); s.on('error', rej); });
      r.tlsMs = performance.now() - t2; ts.destroy();
    } else sock.destroy();
    const agent = new (secure ? https : http).Agent({ keepAlive: true, maxSockets: 1 });
    const get = () => new Promise((res, rej) => {
      const a = performance.now();
      const req = (secure ? https : http).get(url, { agent, headers: { 'User-Agent': 'arb-scanner-latency/1', Accept: 'application/json' }, timeout: 8000 }, (resp) => {
        resp.resume(); resp.on('end', () => res({ ms: performance.now() - a, status: resp.statusCode, reused: req.reusedSocket }));
      });
      req.on('error', rej); req.on('timeout', () => req.destroy(new Error('request timeout')));
    });
    const cold = await get(); r.coldMs = cold.ms; r.status = cold.status;
    const w = []; let reconnects = 0;
    for (let i = 0; i < samples; i++) {
      await new Promise(res => setTimeout(res, 150));
      const x = await get(); w.push(x.ms); r.status = x.status; if (!x.reused) reconnects++;
    }
    agent.destroy();
    Object.assign(r, { ok: true, warmSamples: w, reconnects });
  } catch (e) { r.error = e.message; }
  return r;
}

async function runNode(targets, samples) {
  const entries = await Promise.all(Object.entries(targets).map(async ([ex, url]) => [ex, await nodeProbe(url, samples)]));
  const results = {};
  for (const [ex, r] of entries) {
    results[ex] = {
      ok: r.ok, error: r.error || null, ip: r.ip || null, status: r.status ?? null,
      dnsMs: round(r.dnsMs), tcpMs: round(r.tcpMs), tlsMs: round(r.tlsMs), coldMs: round(r.coldMs),
      warm: r.warmSamples ? summarizeWarm(r.warmSamples) : null, reconnects: r.reconnects || 0,
    };
  }
  return { method: 'backend-node', results };
}

// ─── Run on one host ─────────────────────────────────────────────────────────
async function measureHost(target = 'local', { exchanges, samples = 10, method = 'auto', urls } = {}) {
  const cfg = loadConfig();
  const host = getHost(target, cfg);
  const list = (exchanges && exchanges.length ? exchanges : Object.keys(EXCHANGES)).filter(e => EXCHANGES[e]);
  const targets = urls || Object.fromEntries(list.map(e => [e, EXCHANGES[e].timeUrl]));
  const n = Math.max(3, Math.min(50, Number(samples) || 10));
  const started = Date.now();
  const notes = [];
  let out = null;
  try {
    if (method === 'auto' || method === 'hummingbot') {
      const r = await runInHummingbot(host, cfg.hbImage, targets, n).catch(e => ({ skipped: e.message }));
      if (r.skipped) notes.push(r.skipped); else out = r;
    }
    if (!out && host.supportsShell() && method !== 'backend') {
      out = await runCurl(host, targets, n).catch(e => { notes.push(`curl failed: ${e.message}`); return null; });
    }
    if (!out && target === 'local') out = await runNode(targets, n);
    if (!out) throw new Error(notes.join('; ') || 'No way to measure on this host');
  } catch (e) {
    return { target, hostName: host.name, ok: false, error: e.message, notes, at: Date.now(), durationMs: Date.now() - started };
  }
  for (const r of Object.values(out.results)) r.blocked = BLOCKED_STATUS.has(r.status);
  return { target, hostName: host.name, ok: true, method: out.method, image: out.method === 'hummingbot-container' ? cfg.hbImage : null, samples: n, notes, results: out.results, at: Date.now(), durationMs: Date.now() - started };
}

// ─── Compare hosts ───────────────────────────────────────────────────────────
// Per exchange: warm median per host, fastest host, how much slower each other is.
// Per pair: both legs are sent at the same time, so a round = the slower leg.
function compareHosts(runs) {
  const ok = runs.filter(r => r.ok);
  const exList = [...new Set(ok.flatMap(r => Object.keys(r.results)))];
  const usable = (r) => r && r.ok && r.warm && !r.blocked;

  const perExchange = exList.map(ex => {
    const rows = ok.map(r => ({ target: r.target, hostName: r.hostName, res: r.results[ex] }));
    const good = rows.filter(x => usable(x.res)).sort((a, b) => a.res.warm.median - b.res.warm.median);
    const best = good[0];
    return {
      exchange: ex, label: (EXCHANGES[ex] || {}).label || ex,
      bestTarget: best ? best.target : null,
      hosts: rows.map(x => ({
        target: x.target, hostName: x.hostName,
        ok: usable(x.res), blocked: !!(x.res && x.res.blocked), status: x.res ? x.res.status : null,
        error: x.res && !x.res.ok ? x.res.error : null,
        medianMs: x.res && x.res.warm ? x.res.warm.median : null,
        p90Ms: x.res && x.res.warm ? x.res.warm.p90 : null,
        jitterMs: x.res && x.res.warm ? x.res.warm.jitter : null,
        tcpMs: x.res ? x.res.tcpMs : null,
        slowerByMs: best && usable(x.res) ? round(x.res.warm.median - best.res.warm.median) : null,
        slowerByPct: best && usable(x.res) && best.res.warm.median > 0 ? round((x.res.warm.median / best.res.warm.median - 1) * 100, 0) : null,
      })),
    };
  });

  const perPair = PAIRS.filter(p => exList.includes(p.a) && exList.includes(p.b)).map(p => {
    const hosts = ok.map(r => {
      const A = r.results[p.a], B = r.results[p.b];
      const okBoth = usable(A) && usable(B);
      return {
        target: r.target, hostName: r.hostName, ok: okBoth,
        blocked: [p.a, p.b].filter(e => r.results[e] && r.results[e].blocked).map(e => EXCHANGES[e].label),
        roundMs: okBoth ? round(Math.max(A.warm.median, B.warm.median)) : null,
        p90Ms: okBoth ? round(Math.max(A.warm.p90, B.warm.p90)) : null,
        legs: { [p.a]: usable(A) ? A.warm.median : null, [p.b]: usable(B) ? B.warm.median : null },
      };
    });
    const ranked = hosts.filter(h => h.ok).sort((a, b) => a.roundMs - b.roundMs);
    const best = ranked[0];
    for (const h of hosts) {
      h.slowerByMs = best && h.ok ? round(h.roundMs - best.roundMs) : null;
      h.slowerByPct = best && h.ok && best.roundMs > 0 ? round((h.roundMs / best.roundMs - 1) * 100, 0) : null;
    }
    return { pair: p.id, label: p.label, bestTarget: best ? best.target : null, advantageMs: ranked.length > 1 ? round(ranked[1].roundMs - best.roundMs) : null, hosts };
  });

  // Plain-language headline per pair
  const headlines = perPair.filter(p => p.bestTarget && p.hosts.filter(h => h.ok).length > 1).map(p => {
    const best = p.hosts.find(h => h.target === p.bestTarget);
    const next = p.hosts.filter(h => h.ok && h.target !== p.bestTarget).sort((a, b) => a.roundMs - b.roundMs)[0];
    return `${p.label}: ${best.hostName} is fastest at ${best.roundMs} ms per round, ${next.slowerByMs} ms (${next.slowerByPct}%) ahead of ${next.hostName}`;
  });

  const blockedNotes = ok.flatMap(r => Object.entries(r.results).filter(([, x]) => x.blocked)
    .map(([ex, x]) => `${EXCHANGES[ex]?.label || ex} returns HTTP ${x.status} from ${r.hostName} — region-blocked there, bots on that host can't use it`));

  return { perExchange, perPair, headlines, blockedNotes };
}

// ─── Multi-host test + history ───────────────────────────────────────────────
function readHistory() { try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch (_) { return []; } }
function saveHistory(list) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(HISTORY_FILE, JSON.stringify(list.slice(0, 40), null, 1)); }
  catch (e) { console.error('latency: history write failed:', e.message); }
}

async function runLatencyTest({ targets, exchanges, samples = 10, method = 'auto' } = {}, deps = {}) {
  const cfg = loadConfig();
  const all = listHosts(cfg).map(h => h.id);
  const ids = (targets && targets.length ? targets : all).filter(t => all.includes(t));
  if (!ids.length) throw Object.assign(new Error('No hosts selected'), { status: 400 });
  const measure = deps.measureHost || measureHost;
  const runs = await Promise.all(ids.map(t => measure(t, { exchanges, samples, method }).catch(e => ({ target: t, ok: false, error: e.message }))));
  const test = { id: `lat_${Date.now().toString(36)}`, at: Date.now(), samples, runs, comparison: compareHosts(runs) };
  const hist = readHistory();
  hist.unshift(test);
  saveHistory(hist);
  return test;
}

function history() {
  return readHistory().map(t => ({
    id: t.id, at: t.at,
    hosts: t.runs.map(r => r.hostName || r.target),
    pairs: (t.comparison.perPair || []).map(p => ({ pair: p.pair, label: p.label, hosts: p.hosts.map(h => ({ target: h.target, hostName: h.hostName, roundMs: h.roundMs })) })),
  }));
}

module.exports = { measureHost, runLatencyTest, compareHosts, history, parseProbeOutput, pythonCommand, runNode, PY_PROBE, PAIRS };
