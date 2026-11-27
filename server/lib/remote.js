// ─── Remote Access ────────────────────────────────────────────────────────────
// Reach the app from anywhere without opening a port on your router.
//
// How it is kept safe:
//  • A SECOND listener (default 127.0.0.1:3002) serves remote traffic. Every
//    /api request that arrives on it must carry a device token — "it came from
//    localhost" means nothing there, because the tunnel itself runs locally.
//    Trust is decided by which socket the request arrived on, never by headers.
//  • Devices get a token by signing in (password + optional authenticator code)
//    or by entering a one-time link code made on the PC (10 min, single use).
//    Tokens are stored only as SHA-256 hashes, expire after N idle days, and
//    can be revoked one by one. The old static API token is NOT accepted here.
//  • Brute force: 5 failures lock an IP for 15 min; 25 failures from anywhere
//    lock every sign-in for 15 min.
//  • Roles: admin (everything) or viewer (read-only). Pairing secrets
//    (/api/mobile/*) are never served remotely.
//  • The tunnel (Cloudflare or Tailscale) provides HTTPS and the public address.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { loadConfig, updateConfig } = require('./config');

const DATA_DIR = process.env.ARB_DATA_DIR || path.join(__dirname, '..', 'data');
const DEVICES_FILE = path.join(DATA_DIR, 'remote_devices.json');
const AUDIT_FILE = path.join(DATA_DIR, 'remote_audit.json');

const DEFAULT_REMOTE = {
  enabled: false,
  port: 3002,
  bind: '127.0.0.1',            // keep on loopback; the tunnel connects locally
  passwordHash: '',
  totp: { enabled: false, secret: '', lastStep: 0 },
  deviceIdleDays: 30,           // a device that hasn't connected for this long must link again
  tunnel: {
    mode: 'none',               // none | cloudflare-quick | cloudflare-named | tailscale
    token: '',                  // Cloudflare named tunnel token
    hostname: '',               // public hostname of the named tunnel (e.g. arb.example.com)
    cloudflaredPath: '',
    tailscalePath: '',
    autoStart: true,
  },
  secret: '',                   // HMAC key for stream tickets (generated)
};

const ROLES = ['admin', 'viewer'];
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_TTL_MIN = 10;
const MIN_PASSWORD = 10;

function remoteErr(msg, status = 400, extra = {}) { return Object.assign(new Error(msg), { status }, extra); }

function settings(cfg = loadConfig()) {
  const r = { ...DEFAULT_REMOTE, ...(cfg.remote || {}) };
  r.totp = { ...DEFAULT_REMOTE.totp, ...(r.totp || {}) };
  r.tunnel = { ...DEFAULT_REMOTE.tunnel, ...(r.tunnel || {}) };
  if (process.env.REMOTE_PORT) r.port = parseInt(process.env.REMOTE_PORT, 10) || r.port;
  if (process.env.REMOTE_BIND) r.bind = process.env.REMOTE_BIND;
  return r;
}

function ensureSecret() {
  const s = settings();
  if (s.secret) return s.secret;
  const secret = crypto.randomBytes(32).toString('hex');
  updateConfig(c => { c.remote = { ...settings(c), secret }; });
  return secret;
}

// ─── Passwords (scrypt) ──────────────────────────────────────────────────────
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(pw), salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${h.toString('base64')}`;
}
function verifyPassword(pw, stored) {
  if (typeof pw !== 'string' || !stored) return false;
  const [kind, N, r, p, salt, hash] = stored.split('$');
  if (kind !== 'scrypt') return false;
  const expect = Buffer.from(hash, 'base64');
  const got = crypto.scryptSync(pw, Buffer.from(salt, 'base64'), expect.length, { N: +N, r: +r, p: +p, maxmem: SCRYPT.maxmem });
  return crypto.timingSafeEqual(got, expect);
}
function checkPasswordStrength(pw) {
  if (typeof pw !== 'string' || pw.length < MIN_PASSWORD) throw remoteErr(`Use at least ${MIN_PASSWORD} characters`);
  if (pw.length > 200) throw remoteErr('Password is too long');
  if (/^(.)\1+$/.test(pw) || /^(password|1234567890|qwertyuiop)/i.test(pw)) throw remoteErr('That password is too easy to guess');
}

// ─── TOTP (RFC 6238: 30 s steps, 6 digits, SHA-1 — what authenticator apps use)
function base32Encode(buf) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, val = 0, out = '';
  for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += A[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += A[(val << (5 - bits)) & 31];
  return out;
}
function base32Decode(s) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = String(s).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, val = 0; const out = [];
  for (const ch of clean) { val = (val << 5) | A.indexOf(ch); bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
function hotp(secret, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const code = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(code % 1e6).padStart(6, '0');
}
// Returns the matched time step, or 0. Steps at or before `lastStep` are refused (no replay).
function verifyTotp(secret, code, { now = Date.now(), lastStep = 0, window = 1 } = {}) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c) || !secret) return 0;
  const step = Math.floor(now / 30000);
  for (let d = -window; d <= window; d++) {
    const s = step + d;
    if (s <= lastStep) continue;
    const a = Buffer.from(hotp(secret, s)); const b = Buffer.from(c);
    if (crypto.timingSafeEqual(a, b)) return s;
  }
  return 0;
}

// ─── Brute-force protection ──────────────────────────────────────────────────
const LOCK_MS = 15 * 60 * 1000;
const PER_IP = 5;
const GLOBAL = 25;
const failsByIp = new Map();
let globalFails = [];
let globalLockUntil = 0;

function lockState(ip, now = Date.now()) {
  if (globalLockUntil > now) return { locked: true, until: globalLockUntil, scope: 'all' };
  const f = failsByIp.get(ip);
  if (f && f.lockedUntil > now) return { locked: true, until: f.lockedUntil, scope: 'ip' };
  return { locked: false };
}
function noteFail(ip, now = Date.now()) {
  const f = failsByIp.get(ip) || { times: [], lockedUntil: 0 };
  f.times = f.times.filter(t => now - t < LOCK_MS).concat(now);
  if (f.times.length >= PER_IP) { f.lockedUntil = now + LOCK_MS; f.times = []; }
  failsByIp.set(ip, f);
  globalFails = globalFails.filter(t => now - t < LOCK_MS).concat(now);
  if (globalFails.length >= GLOBAL) { globalLockUntil = now + LOCK_MS; globalFails = []; audit('lockout', { ip, scope: 'all' }); }
  else if (f.lockedUntil > now) audit('lockout', { ip, scope: 'ip' });
}
function noteSuccess(ip) { failsByIp.delete(ip); }
function resetLimits() { failsByIp.clear(); globalFails = []; globalLockUntil = 0; }
function assertNotLocked(ip) {
  const l = lockState(ip);
  if (l.locked) {
    const min = Math.ceil((l.until - Date.now()) / 60000);
    throw remoteErr(l.scope === 'all'
      ? `Too many failed sign-ins from the internet — all sign-ins are paused for ${min} min`
      : `Too many failed attempts — try again in ${min} min`, 429);
  }
}

// ─── Devices & audit log ─────────────────────────────────────────────────────
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; } }
function writeJson(file, v) { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(file, JSON.stringify(v, null, 1), { mode: 0o600 }); }
const loadDevices = () => readJson(DEVICES_FILE, []);
const saveDevices = d => writeJson(DEVICES_FILE, d);

function audit(event, info = {}) {
  const list = readJson(AUDIT_FILE, []);
  list.unshift({ at: Date.now(), event, ...info });
  try { writeJson(AUDIT_FILE, list.slice(0, 300)); } catch (_) {}
}
const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');

function cleanName(n, fallback) { return String(n || fallback).replace(/[^\w .,'()@+-]/g, '').trim().slice(0, 48) || fallback; }

function issueDevice({ name, role, via, ip, userAgent }) {
  const id = crypto.randomBytes(6).toString('hex');
  const secret = crypto.randomBytes(32).toString('base64url');
  const token = `arbd_${id}_${secret}`;
  const now = Date.now();
  const dev = { id, name: cleanName(name, 'Device'), role, via, tokenHash: sha256(token), createdAt: now, lastSeenAt: now, lastIp: ip || '', userAgent: String(userAgent || '').slice(0, 120) };
  const list = loadDevices();
  if (list.length >= 50) throw remoteErr('50 linked devices is the limit — revoke some first', 409);
  list.push(dev);
  saveDevices(list);
  audit('device-linked', { device: dev.name, deviceId: id, role, via, ip });
  return { token, device: publicDevice(dev) };
}
function publicDevice(d) { const { tokenHash, ...rest } = d; return rest; }

// Look up a token; returns the device (and refreshes last-seen) or null
function deviceForToken(token, { ip, now = Date.now() } = {}) {
  const m = /^arbd_([0-9a-f]{12})_[A-Za-z0-9_-]{43}$/.exec(String(token || ''));
  if (!m) return null;
  const list = loadDevices();
  const dev = list.find(d => d.id === m[1]);
  if (!dev) return null;
  const a = Buffer.from(dev.tokenHash, 'hex'); const b = Buffer.from(sha256(token), 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const idleMs = settings().deviceIdleDays * 86400000;
  if (now - dev.lastSeenAt > idleMs) {
    saveDevices(list.filter(d => d.id !== dev.id));
    audit('device-expired', { device: dev.name, deviceId: dev.id });
    return null;
  }
  if (now - dev.lastSeenAt > 5 * 60000 || (ip && ip !== dev.lastIp)) {
    dev.lastSeenAt = now; if (ip) dev.lastIp = ip;
    saveDevices(list);
  }
  return dev;
}

function revokeDevice(id, by = 'pc') {
  const list = loadDevices();
  const dev = list.find(d => d.id === id);
  if (!dev) throw remoteErr('No such device', 404);
  saveDevices(list.filter(d => d.id !== id));
  audit('device-revoked', { device: dev.name, deviceId: id, by });
}
function revokeAll(by = 'pc') { const n = loadDevices().length; saveDevices([]); audit('all-devices-revoked', { count: n, by }); return n; }

// Stream tickets: EventSource can't send headers, so the UI gets a signed,
// read-only ticket for /api/alerts/stream instead of putting its token in a URL
function streamTicket(dev, ttlMs = 12 * 3600000) {
  const exp = Date.now() + ttlMs;
  const sig = crypto.createHmac('sha256', ensureSecret()).update(`${dev.id}.${exp}`).digest('base64url');
  return `st_${dev.id}.${exp}.${sig}`;
}
function deviceForTicket(ticket) {
  const m = /^st_([0-9a-f]{12})\.(\d+)\.([A-Za-z0-9_-]{43})$/.exec(String(ticket || ''));
  if (!m || +m[2] < Date.now()) return null;
  const expect = crypto.createHmac('sha256', ensureSecret()).update(`${m[1]}.${m[2]}`).digest('base64url');
  if (!crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(m[3]))) return null;
  return loadDevices().find(d => d.id === m[1]) || null;
}

// ─── Link codes (one-time, short-lived) ──────────────────────────────────────
const linkCodes = new Map(); // sha256(code) -> { role, name, expiresAt, createdAt }
function normalizeCode(c) { return String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
function createLinkCode({ role = 'admin', name = '', ttlMin = CODE_TTL_MIN } = {}) {
  if (!ROLES.includes(role)) throw remoteErr('Role must be admin or viewer');
  const now = Date.now();
  for (const [k, v] of linkCodes) if (v.expiresAt < now) linkCodes.delete(k);
  if (linkCodes.size >= 5) throw remoteErr('5 unused link codes are already waiting — let them expire or cancel them', 409);
  let raw = '';
  const bytes = crypto.randomBytes(8);
  for (let i = 0; i < 8; i++) raw += CODE_ALPHABET[bytes[i] % 32];
  const ttl = Math.max(2, Math.min(30, +ttlMin || CODE_TTL_MIN)) * 60000;
  const entry = { role, name: name ? cleanName(name, '') : '', createdAt: now, expiresAt: now + ttl };
  linkCodes.set(sha256(raw), entry);
  audit('link-code-created', { role, expiresAt: entry.expiresAt });
  return { code: `${raw.slice(0, 4)}-${raw.slice(4)}`, ...entry };
}
function cancelLinkCodes() { const n = linkCodes.size; linkCodes.clear(); return n; }
function pendingCodes() {
  const now = Date.now();
  return [...linkCodes.values()].filter(v => v.expiresAt > now).map(v => ({ role: v.role, expiresAt: v.expiresAt }));
}

function redeemLinkCode({ code, deviceName, ip, userAgent }) {
  assertNotLocked(ip);
  const key = sha256(normalizeCode(code));
  const entry = linkCodes.get(key);
  if (!entry || entry.expiresAt < Date.now()) {
    noteFail(ip); audit('link-failed', { ip });
    throw remoteErr('That code is wrong or has expired — make a new one on the PC', 401);
  }
  linkCodes.delete(key);
  noteSuccess(ip);
  return issueDevice({ name: deviceName || entry.name || 'Linked device', role: entry.role, via: 'link-code', ip, userAgent });
}

function login({ password, totp, deviceName, ip, userAgent }) {
  assertNotLocked(ip);
  const s = settings();
  if (!s.passwordHash) throw remoteErr('No remote password is set — set one on the PC, or use a link code', 409);
  const pwOk = verifyPassword(String(password || ''), s.passwordHash);
  let step = 0;
  if (pwOk && s.totp.enabled) {
    if (!totp) throw remoteErr('Enter the 6-digit code from your authenticator app', 401, { needsTotp: true });
    step = verifyTotp(s.totp.secret, totp, { lastStep: s.totp.lastStep });
  }
  if (!pwOk || (s.totp.enabled && !step)) {
    noteFail(ip); audit('login-failed', { ip, reason: pwOk ? 'authenticator code' : 'password' });
    throw remoteErr(pwOk ? 'Authenticator code is wrong' : 'Wrong password', 401, { needsTotp: pwOk && s.totp.enabled });
  }
  if (step) updateConfig(c => { const r = settings(c); r.totp.lastStep = step; c.remote = r; });
  noteSuccess(ip);
  return issueDevice({ name: deviceName || 'Browser', role: 'admin', via: 'password', ip, userAgent });
}

// ─── Settings changes ────────────────────────────────────────────────────────
function setPassword({ current, next }, { remote = false } = {}) {
  const s = settings();
  // On the PC itself you can reset a forgotten password; from outside you must know it
  if (remote && s.passwordHash && !verifyPassword(String(current || ''), s.passwordHash)) throw remoteErr('Current password is wrong', 401);
  checkPasswordStrength(next);
  updateConfig(c => { const r = settings(c); r.passwordHash = hashPassword(next); c.remote = r; });
  audit('password-changed', { from: remote ? 'remote' : 'pc' });
}

function totpSetup() {
  const secret = base32Encode(crypto.randomBytes(20));
  updateConfig(c => { const r = settings(c); r.totp = { ...r.totp, pendingSecret: secret }; c.remote = r; });
  const label = encodeURIComponent(`Arb Scanner (${os.hostname()})`);
  return { secret, uri: `otpauth://totp/${label}?secret=${secret}&issuer=Arb%20Scanner&algorithm=SHA1&digits=6&period=30` };
}
function totpEnable(code) {
  const s = settings();
  const secret = s.totp.pendingSecret;
  if (!secret) throw remoteErr('Start authenticator setup first');
  const step = verifyTotp(secret, code);
  if (!step) throw remoteErr('That code does not match — check the phone clock and try the next code', 401);
  updateConfig(c => { const r = settings(c); r.totp = { enabled: true, secret, lastStep: step }; c.remote = r; });
  audit('totp-enabled');
}
function totpDisable(code, { remote = false } = {}) {
  const s = settings();
  if (!s.totp.enabled) return;
  if (remote && !verifyTotp(s.totp.secret, code, { lastStep: s.totp.lastStep })) throw remoteErr('Enter a current authenticator code to turn it off', 401);
  updateConfig(c => { const r = settings(c); r.totp = { enabled: false, secret: '', lastStep: 0 }; c.remote = r; });
  audit('totp-disabled', { from: remote ? 'remote' : 'pc' });
}

function updateSettings(body = {}, { remote = false } = {}) {
  updateConfig(c => {
    const r = settings(c);
    if (body.enabled !== undefined) {
      const on = !!body.enabled;
      if (on && !r.passwordHash) throw remoteErr('Set a remote password first (needed to sign in from a browser)');
      r.enabled = on;
    }
    if (body.port !== undefined) {
      const p = parseInt(body.port, 10);
      if (!(p >= 1024 && p <= 65535)) throw remoteErr('Port must be 1024–65535');
      if (p === (parseInt(process.env.PORT, 10) || 3001)) throw remoteErr('Remote port must differ from the main app port');
      r.port = p;
    }
    if (body.bind !== undefined) {
      if (remote) throw remoteErr('The listen address can only be changed on the PC');
      if (!['127.0.0.1', '0.0.0.0'].includes(body.bind)) throw remoteErr('Listen address must be 127.0.0.1 or 0.0.0.0');
      r.bind = body.bind;
    }
    if (body.deviceIdleDays !== undefined) r.deviceIdleDays = Math.max(1, Math.min(365, parseInt(body.deviceIdleDays, 10) || 30));
    if (body.tunnel && typeof body.tunnel === 'object') {
      const t = body.tunnel;
      if (t.mode !== undefined) {
        if (!['none', 'cloudflare-quick', 'cloudflare-named', 'tailscale'].includes(t.mode)) throw remoteErr('Unknown tunnel type');
        r.tunnel.mode = t.mode;
      }
      if (typeof t.token === 'string' && t.token !== '') {
        if (!/^[A-Za-z0-9+/=_-]{40,4000}$/.test(t.token.trim())) throw remoteErr('That does not look like a Cloudflare tunnel token');
        r.tunnel.token = t.token.trim();
      }
      if (typeof t.hostname === 'string') {
        const h = t.hostname.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
        if (h && !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(h)) throw remoteErr('Hostname should look like arb.example.com');
        r.tunnel.hostname = h;
      }
      for (const k of ['cloudflaredPath', 'tailscalePath']) {
        if (typeof t[k] === 'string') {
          if (remote) throw remoteErr('Program paths can only be changed on the PC');
          r.tunnel[k] = t[k].trim();
        }
      }
      if (t.autoStart !== undefined) r.tunnel.autoStart = !!t.autoStart;
    }
    c.remote = r;
  });
  audit('settings-changed', { from: remote ? 'remote' : 'pc', keys: Object.keys(body) });
}

// ─── Request gate (mounted before every route) ───────────────────────────────
const PUBLIC_ROUTES = new Set(['POST /api/remote/login', 'POST /api/remote/link', 'GET /api/remote/session']);
const LOCAL_ONLY = [/^\/api\/mobile\//];
const VIEWER_WRITES = new Set(['POST /api/remote/logout', 'POST /api/remote/ticket']);

function isLoopback(addr) { return /^(127\.|::1$|::ffff:127\.)/.test(String(addr || '')); }
function clientIp(req) {
  const sock = (req.socket && req.socket.remoteAddress) || '';
  // Only a process on this machine (the tunnel) can reach a loopback listener,
  // so its forwarding headers can be believed. From anywhere else they can't.
  if (req.arbRemote && (isLoopback(sock) || process.env.REMOTE_TRUST_PROXY === '1')) {
    const h = req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (h) return h.slice(0, 64);
  }
  return sock.replace(/^::ffff:/, '') || 'unknown';
}

function bearer(req) {
  const a = req.headers.authorization || '';
  if (a.startsWith('Bearer ')) return a.slice(7).trim();
  return req.headers['x-api-token'] || '';
}

function setSecurityHeaders(req, res) {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (req.headers['x-forwarded-proto'] === 'https' || req.headers['cf-visitor']) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
}

function gate(req, res, next) {
  if (!req.arbRemote) return next();
  setSecurityHeaders(req, res);
  if (!settings().enabled) return res.status(503).json({ error: 'Remote access is turned off on the PC' });
  if (!req.path.startsWith('/api/')) return next(); // the web app itself (static files)
  const key = `${req.method} ${req.path}`;
  if (PUBLIC_ROUTES.has(key)) return next();
  if (LOCAL_ONLY.some(rx => rx.test(req.path))) return res.status(403).json({ error: 'Only available on the PC itself' });

  const ip = clientIp(req);
  let dev = deviceForToken(bearer(req), { ip });
  if (!dev && req.method === 'GET' && req.path === '/api/alerts/stream') dev = deviceForTicket(req.query.ticket);
  if (!dev) return res.status(401).json({ error: 'Sign in required', auth: true });
  req.arbDevice = dev;
  if (dev.role === 'viewer' && !['GET', 'HEAD'].includes(req.method) && !VIEWER_WRITES.has(key)) {
    return res.status(403).json({ error: 'This device is view-only' });
  }
  next();
}

// ─── Remote listener ─────────────────────────────────────────────────────────
let listener = null;      // { server, port, bind }
let appRef = null;
let listenError = null;

function handler(req, res) { req.arbRemote = true; appRef(req, res); }

function stopListener() {
  return new Promise(resolve => {
    if (!listener) return resolve();
    const s = listener.server; listener = null;
    s.close(() => resolve());
    if (typeof s.closeAllConnections === 'function') s.closeAllConnections();
  });
}

async function syncListener(app) {
  if (app) appRef = app;
  if (!appRef) return;
  const s = settings();
  if (!s.enabled) { await stopListener(); listenError = null; return; }
  if (listener && listener.port === s.port && listener.bind === s.bind) return;
  await stopListener();
  await new Promise(resolve => {
    const server = http.createServer(handler);
    server.headersTimeout = 30000;
    server.requestTimeout = 0; // SSE alert stream stays open
    server.once('error', e => { listenError = `Could not listen on ${s.bind}:${s.port} — ${e.code || e.message}`; resolve(); });
    server.listen(s.port, s.bind, () => { listener = { server, port: s.port, bind: s.bind }; listenError = null; resolve(); });
  });
}

// ─── Tunnels ─────────────────────────────────────────────────────────────────
const IS_WIN = process.platform === 'win32';
const tunnel = { proc: null, mode: null, publicUrl: '', connected: false, startedAt: 0, lastError: '', log: [], restarts: [], wanted: false, timer: null };

function tlog(line) {
  const clean = String(line).replace(/(token|eyJ)[A-Za-z0-9+/=_.-]{20,}/g, '$1…').trim();
  if (!clean) return;
  tunnel.log.push(`${new Date().toISOString().slice(11, 19)} ${clean}`);
  if (tunnel.log.length > 80) tunnel.log.splice(0, tunnel.log.length - 80);
}

function run(bin, args, { timeout = 15000, env } = {}) {
  return new Promise(resolve => {
    execFile(bin, args, { timeout, windowsHide: true, env: env ? { ...process.env, ...env } : process.env }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout: String(stdout || ''), stderr: String(stderr || (err && err.message) || ''), missing: !!(err && err.code === 'ENOENT') });
    });
  });
}

function candidates(kind) {
  const s = settings();
  if (kind === 'cloudflared') {
    return [s.tunnel.cloudflaredPath, 'cloudflared',
      ...(IS_WIN ? ['C:\\Program Files (x86)\\cloudflared\\cloudflared.exe', 'C:\\Program Files\\cloudflared\\cloudflared.exe', path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links', 'cloudflared.exe')] : ['/usr/local/bin/cloudflared', '/opt/homebrew/bin/cloudflared'])].filter(Boolean);
  }
  return [s.tunnel.tailscalePath, 'tailscale',
    ...(IS_WIN ? ['C:\\Program Files\\Tailscale\\tailscale.exe'] : ['/usr/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'])].filter(Boolean);
}

async function findBinary(kind) {
  for (const bin of candidates(kind)) {
    const r = await run(bin, ['version'], { timeout: 8000 });
    if (!r.missing && (r.code === 0 || /version/i.test(r.stdout + r.stderr))) {
      return { bin, version: (r.stdout || r.stderr).split('\n')[0].trim().slice(0, 80) };
    }
  }
  return null;
}

async function detectTools() {
  const [cf, ts] = await Promise.all([findBinary('cloudflared'), findBinary('tailscale')]);
  return {
    cloudflared: cf ? { installed: true, ...cf } : { installed: false, install: IS_WIN ? 'winget install --id Cloudflare.cloudflared' : 'see developers.cloudflare.com → cloudflared downloads' },
    tailscale: ts ? { installed: true, ...ts } : { installed: false, install: IS_WIN ? 'winget install --id Tailscale.Tailscale' : 'curl -fsSL https://tailscale.com/install.sh | sh' },
  };
}

function localTarget() { return `http://127.0.0.1:${settings().port}`; }

async function startCloudflared(mode) {
  const s = settings();
  const found = await findBinary('cloudflared');
  if (!found) throw remoteErr(`cloudflared is not installed. Install it with: ${IS_WIN ? 'winget install --id Cloudflare.cloudflared' : 'your package manager'} — then press Start again`, 409);
  let args; const env = { ...process.env };
  if (mode === 'cloudflare-quick') {
    args = ['tunnel', '--no-autoupdate', '--url', localTarget()];
  } else {
    if (!s.tunnel.token) throw remoteErr('Paste the tunnel token from the Cloudflare dashboard first', 409);
    if (!s.tunnel.hostname) throw remoteErr('Enter the public hostname you gave the tunnel (e.g. arb.example.com)', 409);
    args = ['tunnel', '--no-autoupdate', 'run'];
    env.TUNNEL_TOKEN = s.tunnel.token; // kept out of the process list
  }
  const proc = spawn(found.bin, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  Object.assign(tunnel, { proc, mode, connected: false, startedAt: Date.now(), lastError: '', publicUrl: mode === 'cloudflare-named' ? `https://${s.tunnel.hostname}` : '' });
  const onData = buf => {
    for (const line of String(buf).split('\n')) {
      tlog(line);
      const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(line);
      if (m && mode === 'cloudflare-quick') { tunnel.publicUrl = m[0]; }
      if (/Registered tunnel connection|Connection [a-f0-9-]+ registered/i.test(line)) tunnel.connected = true;
      if (/ERR .*(Unauthorized|invalid token|failed to unmarshal)/i.test(line)) tunnel.lastError = 'Cloudflare rejected the tunnel token';
    }
  };
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);
  proc.on('error', e => { tunnel.lastError = e.message; });
  proc.on('exit', (code) => {
    if (tunnel.proc !== proc) return;
    tunnel.proc = null; tunnel.connected = false;
    tlog(`cloudflared exited (${code})`);
    if (tunnel.wanted) scheduleRestart(mode);
  });
}

function scheduleRestart(mode) {
  const now = Date.now();
  tunnel.restarts = tunnel.restarts.filter(t => now - t < 3600000);
  if (tunnel.restarts.length >= 6) { tunnel.lastError = 'Tunnel keeps stopping — gave up after 6 restarts this hour. Check the log.'; tunnel.wanted = false; return; }
  tunnel.restarts.push(now);
  const wait = [5000, 15000, 30000, 60000, 120000, 300000][tunnel.restarts.length - 1];
  clearTimeout(tunnel.timer);
  tunnel.timer = setTimeout(() => { if (tunnel.wanted && !tunnel.proc) startCloudflared(mode).catch(e => { tunnel.lastError = e.message; }); }, wait);
}

async function tailscaleUrl(bin) {
  const r = await run(bin, ['status', '--json'], { timeout: 10000 });
  try { const j = JSON.parse(r.stdout); const n = j.Self && j.Self.DNSName; return n ? `https://${n.replace(/\.$/, '')}` : ''; } catch (_) { return ''; }
}

async function startTunnel() {
  const s = settings();
  if (!s.enabled) throw remoteErr('Turn remote access on first', 409);
  if (s.tunnel.mode === 'none') throw remoteErr('Choose a tunnel type first', 409);
  await stopTunnel({ keepWanted: false });
  tunnel.wanted = true; tunnel.restarts = []; tunnel.log = [];
  if (s.tunnel.mode === 'tailscale') {
    const found = await findBinary('tailscale');
    if (!found) throw remoteErr('Tailscale is not installed on this PC', 409);
    const r = await run(found.bin, ['serve', '--bg', '--https=443', localTarget()], { timeout: 30000 });
    tlog(r.stdout); tlog(r.stderr);
    if (r.code !== 0) { tunnel.wanted = false; throw remoteErr(`tailscale serve failed: ${(r.stderr || r.stdout).trim().slice(0, 200)}`, 502); }
    Object.assign(tunnel, { mode: 'tailscale', connected: true, startedAt: Date.now(), publicUrl: await tailscaleUrl(found.bin), lastError: '' });
  } else {
    await startCloudflared(s.tunnel.mode);
  }
  audit('tunnel-started', { mode: s.tunnel.mode });
  return tunnelStatus();
}

async function stopTunnel({ keepWanted = false } = {}) {
  if (!keepWanted) tunnel.wanted = false;
  clearTimeout(tunnel.timer);
  if (tunnel.proc) { const p = tunnel.proc; tunnel.proc = null; try { p.kill(); } catch (_) {} }
  if (tunnel.mode === 'tailscale') {
    const found = await findBinary('tailscale');
    if (found) await run(found.bin, ['serve', '--https=443', 'off'], { timeout: 20000 });
  }
  Object.assign(tunnel, { connected: false, publicUrl: '', mode: null });
}

function tunnelStatus() {
  const s = settings();
  return {
    mode: s.tunnel.mode,
    running: tunnel.mode === 'tailscale' ? tunnel.connected : !!tunnel.proc,
    connected: tunnel.connected,
    publicUrl: tunnel.publicUrl,
    startedAt: tunnel.startedAt || null,
    lastError: tunnel.lastError,
    log: tunnel.log.slice(-25),
    privateOnly: s.tunnel.mode === 'tailscale',
  };
}

// Called once at boot and after every settings change
async function sync(app) {
  await syncListener(app);
  const s = settings();
  if (!s.enabled) { if (tunnel.wanted || tunnel.proc) await stopTunnel(); return; }
  if (s.tunnel.autoStart && s.tunnel.mode !== 'none' && !tunnel.wanted) {
    try { await startTunnel(); } catch (e) { tunnel.lastError = e.message; }
  }
}

function publicUrl() { return tunnel.publicUrl || ''; }

// Everything the settings panel shows (never secrets)
function status() {
  const s = settings();
  return {
    enabled: s.enabled,
    port: s.port,
    bind: s.bind,
    listening: !!listener,
    listenError,
    passwordSet: !!s.passwordHash,
    totpEnabled: !!s.totp.enabled,
    totpPending: !!s.totp.pendingSecret && !s.totp.enabled,
    deviceIdleDays: s.deviceIdleDays,
    tunnel: { ...tunnelStatus(), hostname: s.tunnel.hostname, hasToken: !!s.tunnel.token, autoStart: s.tunnel.autoStart, cloudflaredPath: s.tunnel.cloudflaredPath, tailscalePath: s.tunnel.tailscalePath },
    devices: loadDevices().map(publicDevice).sort((a, b) => b.lastSeenAt - a.lastSeenAt),
    pendingCodes: pendingCodes(),
    audit: readJson(AUDIT_FILE, []).slice(0, 60),
  };
}

function linkUrls(code, base = publicUrl()) {
  const c = encodeURIComponent(code);
  return {
    web: base ? `${base}/#link=${c}` : '',
    app: base ? `arbscanner://link?url=${encodeURIComponent(base)}&code=${c}` : `arbscanner://link?code=${c}`,
  };
}

async function qr(text) {
  try { return await require('qrcode').toDataURL(text, { margin: 1, width: 220, errorCorrectionLevel: 'M' }); } catch (_) { return ''; }
}

module.exports = {
  DEFAULT_REMOTE, ROLES, settings, status, updateSettings, sync, syncListener, stopListener,
  gate, clientIp, isLoopback, bearer,
  hashPassword, verifyPassword, setPassword, login,
  base32Encode, base32Decode, hotp, verifyTotp, totpSetup, totpEnable, totpDisable,
  createLinkCode, redeemLinkCode, cancelLinkCodes, normalizeCode,
  issueDevice, deviceForToken, revokeDevice, revokeAll, streamTicket, deviceForTicket, loadDevices,
  lockState, noteFail, resetLimits,
  startTunnel, stopTunnel, tunnelStatus, detectTools, publicUrl, linkUrls, qr, audit,
};
