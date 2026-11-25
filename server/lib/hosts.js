// ─── Host abstraction ─────────────────────────────────────────────────────────
// Every place Hummingbot can run is a "host":
//   • WinHost    – Docker Desktop on Windows (docker CLI + Windows filesystem)
//   • PosixHost  – Linux/macOS/WSL/SSH: everything done through a POSIX shell
//                  with strictly single-quoted arguments (no shell injection).
// All file paths passed in are RELATIVE to the host's Hummingbot directory.
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const { Client } = require('ssh2');
const { loadConfig } = require('./config');

const TMP_DIR = path.join(__dirname, '..', 'tmp');
const IS_WIN = process.platform === 'win32';

// POSIX single-quote escaping
function shq(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

// Reject traversal / absolute paths in relative file arguments
function safeRel(rel) {
  const norm = path.posix.normalize(String(rel).replace(/\\/g, '/'));
  if (!norm || norm.startsWith('/') || norm.startsWith('..') || norm.includes('/../') || /^[a-zA-Z]:/.test(norm)) {
    throw new Error(`Unsafe path: ${rel}`);
  }
  return norm;
}

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
function safeName(n, what = 'name') {
  if (!NAME_RE.test(String(n || ''))) throw new Error(`Invalid ${what}: ${n}`);
  return String(n);
}

class HostError extends Error {
  constructor(msg, extra = {}) { super(msg); Object.assign(this, extra); }
}

// Simple per-host concurrency limiter (SSH servers default MaxSessions=10)
class Limiter {
  constructor(n) { this.n = n; this.active = 0; this.q = []; }
  async run(fn) {
    if (this.active >= this.n) await new Promise(r => this.q.push(r));
    this.active++;
    try { return await fn(); } finally {
      this.active--;
      const next = this.q.shift(); if (next) next();
    }
  }
}

// ─── Windows native (Docker Desktop) ──────────────────────────────────────────
class WinHost {
  constructor({ id, name, hbDir }) {
    this.id = id; this.name = name; this.kind = 'native-win';
    this.hbDir = hbDir || '~/hummingbot';
  }
  async hbAbs() {
    const d = this.hbDir.startsWith('~') ? path.join(os.homedir(), this.hbDir.slice(1)) : this.hbDir;
    return path.resolve(d);
  }
  // Path form Docker Desktop accepts for bind mounts: C:/Users/x/hummingbot
  async dockerPath(rel = '') {
    const p = path.join(await this.hbAbs(), rel ? safeRel(rel) : '');
    return p.replace(/\\/g, '/');
  }
  dockerRaw(args, { timeout = 30000 } = {}) {
    return new Promise(resolve => {
      execFile('docker', args, { timeout, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
        resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr || (err && err.message) || '') });
      });
    });
  }
  async docker(args, opts) {
    const r = await this.dockerRaw(args, opts);
    if (r.code !== 0) throw new HostError((r.stderr || r.stdout || 'docker failed').trim(), r);
    return r.stdout.trim();
  }
  async abs(rel) { return path.join(await this.hbAbs(), safeRel(rel)); }
  async readFile(rel) {
    try { return await fsp.readFile(await this.abs(rel), 'utf8'); }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  }
  async writeFile(rel, content) {
    const p = await this.abs(rel);
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, content);
  }
  async removeFile(rel) { await fsp.rm(await this.abs(rel), { force: true }); }
  async listDir(rel) {
    const dir = await this.abs(rel);
    let names = [];
    try { names = await fsp.readdir(dir); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    const out = [];
    for (const n of names) {
      try {
        const st = await fsp.stat(path.join(dir, n));
        out.push({ name: n, isDir: st.isDirectory(), size: st.size, mtime: Math.floor(st.mtimeMs / 1000) });
      } catch (_) { /* vanished */ }
    }
    return out;
  }
  async tail(rel, lines = 200) {
    const p = await this.abs(rel);
    let fh;
    try { fh = await fsp.open(p, 'r'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    try {
      const { size } = await fh.stat();
      const len = Math.min(size, 2 * 1024 * 1024);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, size - len);
      return buf.toString('utf8').split(/\r?\n/).slice(-lines).join('\n');
    } finally { await fh.close(); }
  }
  async ensureDirs() {
    for (const d of ['conf/strategies', 'conf/connectors', 'conf/scripts', 'logs', 'data']) {
      await fsp.mkdir(await this.abs(d), { recursive: true });
    }
  }
  supportsShell() { return false; }
  async sh() { throw new HostError('Shell scripts are not supported on the Windows host'); }
  terminalCommand(innerCmd) { return innerCmd; }
}

// ─── POSIX hosts (native Linux, WSL, SSH) ─────────────────────────────────────
class PosixHost {
  constructor({ id, name, hbDir, kind }) {
    this.id = id; this.name = name; this.kind = kind;
    this.hbDir = hbDir || '~/hummingbot';
    this._home = null;
    this._sudo = false;
  }
  // Subclasses implement: _run(script, input, timeout) -> {code, stdout, stderr}
  async sh(script, { input, timeout = 60000 } = {}) { return this._run(script, input, timeout); }
  supportsShell() { return true; }
  async home() {
    if (!this._home) {
      const r = await this._run('printf %s "$HOME"', null, 15000);
      if (r.code !== 0 || !r.stdout) throw new HostError(r.stderr || 'Cannot resolve $HOME', r);
      this._home = r.stdout.trim();
    }
    return this._home;
  }
  async hbAbs() {
    if (this.hbDir.startsWith('~')) return path.posix.join(await this.home(), this.hbDir.slice(1));
    return this.hbDir;
  }
  async dockerPath(rel = '') { return path.posix.join(await this.hbAbs(), rel ? safeRel(rel) : ''); }
  async abs(rel) { return path.posix.join(await this.hbAbs(), safeRel(rel)); }

  async dockerRaw(args, { timeout = 30000 } = {}) {
    const cmd = args.map(shq).join(' ');
    let r = await this._run(`${this._sudo ? 'sudo -n ' : ''}docker ${cmd}`, null, timeout);
    if (r.code !== 0 && !this._sudo && /permission denied.*docker\.sock/i.test(r.stderr)) {
      const r2 = await this._run(`sudo -n docker ${cmd}`, null, timeout);
      if (r2.code === 0 || !/password is required/i.test(r2.stderr)) { this._sudo = true; r = r2; }
    }
    return r;
  }
  async docker(args, opts) {
    const r = await this.dockerRaw(args, opts);
    if (r.code !== 0) throw new HostError((r.stderr || r.stdout || 'docker failed').trim(), r);
    return r.stdout.trim();
  }
  async readFile(rel) {
    const p = await this.abs(rel);
    const r = await this._run(`if [ -f ${shq(p)} ]; then cat ${shq(p)}; else exit 3; fi`, null, 30000);
    if (r.code === 3) return null;
    if (r.code !== 0) throw new HostError(r.stderr || 'read failed', r);
    return r.stdout;
  }
  async writeFile(rel, content) {
    const p = await this.abs(rel);
    const r = await this._run(`mkdir -p ${shq(path.posix.dirname(p))} && cat > ${shq(p)}`, content, 30000);
    if (r.code !== 0) throw new HostError(r.stderr || 'write failed', r);
  }
  async removeFile(rel) {
    const p = await this.abs(rel);
    const r = await this._run(`rm -f ${shq(p)}`, null, 15000);
    if (r.code !== 0) throw new HostError(r.stderr || 'remove failed', r);
  }
  async listDir(rel) {
    const p = await this.abs(rel);
    const script = `cd ${shq(p)} 2>/dev/null || exit 0
for f in * ; do [ -e "$f" ] || continue
  if [ -d "$f" ]; then t=d; else t=f; fi
  s=$(stat -c %s "$f" 2>/dev/null || echo 0); m=$(stat -c %Y "$f" 2>/dev/null || echo 0)
  printf '%s\\t%s\\t%s\\t%s\\n' "$t" "$s" "$m" "$f"
done`;
    const r = await this._run(script, null, 30000);
    if (r.code !== 0) throw new HostError(r.stderr || 'list failed', r);
    return r.stdout.split('\n').filter(Boolean).map(l => {
      const [t, s, m, ...rest] = l.split('\t');
      return { name: rest.join('\t'), isDir: t === 'd', size: +s || 0, mtime: +m || 0 };
    });
  }
  async tail(rel, lines = 200) {
    const p = await this.abs(rel);
    const r = await this._run(`if [ -f ${shq(p)} ]; then tail -n ${parseInt(lines, 10) || 200} ${shq(p)}; else exit 3; fi`, null, 30000);
    if (r.code === 3) return null;
    if (r.code !== 0) throw new HostError(r.stderr || 'tail failed', r);
    return r.stdout;
  }
  async ensureDirs() {
    const base = await this.hbAbs();
    const dirs = ['conf/strategies', 'conf/connectors', 'conf/scripts', 'logs', 'data'].map(d => shq(path.posix.join(base, d))).join(' ');
    const r = await this._run(`mkdir -p ${dirs}`, null, 15000);
    if (r.code !== 0) throw new HostError(r.stderr || 'mkdir failed', r);
  }
}

// Linux/macOS backend running directly on the server
class LocalPosixHost extends PosixHost {
  constructor(o) { super({ ...o, kind: 'native-posix' }); }
  _run(script, input, timeout) {
    return new Promise(resolve => {
      const child = spawn('bash', ['-c', script], { stdio: ['pipe', 'pipe', 'pipe'] });
      collect(child, input, timeout, resolve);
    });
  }
  terminalCommand(innerCmd) { return innerCmd; }
}

// WSL from a Windows backend. Scripts are written to a temp file and executed
// through /mnt/<drive>/... so no Windows<->Linux quoting is ever involved.
class WslHost extends PosixHost {
  constructor(o) { super({ ...o, kind: 'wsl' }); this.distro = o.distro || ''; }
  _distroArgs() { return this.distro ? ['-d', this.distro] : []; }
  async _run(script, input, timeout) {
    await fsp.mkdir(TMP_DIR, { recursive: true });
    const file = path.join(TMP_DIR, `wsl_${crypto.randomBytes(6).toString('hex')}.sh`);
    await fsp.writeFile(file, script.replace(/\r\n/g, '\n'));
    const m = /^([a-zA-Z]):\\(.*)$/.exec(path.resolve(file));
    const linuxPath = m ? `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}` : file;
    try {
      return await new Promise(resolve => {
        const child = spawn('wsl.exe', [...this._distroArgs(), '-e', 'bash', linuxPath], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        collect(child, input, timeout, resolve);
      });
    } finally { fsp.rm(file, { force: true }).catch(() => {}); }
  }
  terminalCommand(innerCmd) { return `wsl.exe ${this.distro ? `-d ${this.distro} ` : ''}-e ${innerCmd}`; }
}

function collect(child, input, timeout, resolve) {
  let stdout = '', stderr = '', done = false;
  const timer = setTimeout(() => { if (!done) { stderr += '\n[timeout]'; child.kill(); } }, timeout);
  child.stdout.on('data', d => { stdout += d; });
  child.stderr.on('data', d => { stderr += d; });
  child.on('error', e => { if (!done) { done = true; clearTimeout(timer); resolve({ code: 127, stdout, stderr: e.message }); } });
  child.on('close', code => { if (!done) { done = true; clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }); } });
  if (input != null) child.stdin.end(input); else child.stdin.end();
}

// ─── SSH host with connection pooling ─────────────────────────────────────────
const sshPool = new Map(); // id -> { conn, ready, timer }

class SshHost extends PosixHost {
  constructor(o) {
    super({ ...o, kind: 'ssh' });
    this.server = o.server;
    this.limiter = SshHost.limiters[o.id] || (SshHost.limiters[o.id] = new Limiter(6));
  }
  async _conn() {
    const s = this.server;
    const key = `${s.id}|${s.host}|${s.username}|${s.pemPath}|${s.port || 22}`;
    let entry = sshPool.get(s.id);
    if (entry && entry.key !== key) { try { entry.conn.end(); } catch (_) {} sshPool.delete(s.id); entry = null; }
    if (!entry) {
      if (!s.host || !s.username || !s.pemPath) throw new HostError(`Server "${s.name || s.id}" is not fully configured (host, username, PEM path)`);
      let privateKey;
      try { privateKey = fs.readFileSync(s.pemPath); }
      catch (e) { throw new HostError(`Cannot read PEM file "${s.pemPath}": ${e.message}`); }
      const conn = new Client();
      entry = { conn, key };
      entry.ready = new Promise((resolve, reject) => {
        conn.once('ready', resolve);
        conn.once('error', err => { sshPool.delete(s.id); reject(new HostError(`SSH error (${s.host}): ${err.message}`)); });
        conn.once('close', () => sshPool.delete(s.id));
      });
      conn.connect({ host: s.host, port: s.port || 22, username: s.username, privateKey, readyTimeout: 12000, keepaliveInterval: 15000 });
      sshPool.set(s.id, entry);
    }
    await entry.ready;
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => { try { entry.conn.end(); } catch (_) {} sshPool.delete(s.id); }, 120000);
    return entry.conn;
  }
  _run(script, input, timeout) {
    return this.limiter.run(async () => {
      const conn = await this._conn();
      return new Promise((resolve) => {
        conn.exec(`bash -c ${shq(script)}`, (err, stream) => {
          if (err) return resolve({ code: 255, stdout: '', stderr: err.message });
          let stdout = '', stderr = '', done = false;
          const timer = setTimeout(() => { if (!done) { stderr += '\n[timeout]'; try { stream.close(); } catch (_) {} } }, timeout);
          stream.on('data', d => { stdout += d; });
          stream.stderr.on('data', d => { stderr += d; });
          stream.on('close', (code) => { if (!done) { done = true; clearTimeout(timer); resolve({ code: code ?? 0, stdout, stderr }); } });
          if (input != null) stream.end(input); else stream.end();
        });
      });
    });
  }
  terminalCommand(innerCmd) {
    const s = this.server;
    return `ssh -i "${s.pemPath}" -p ${s.port || 22} -o StrictHostKeyChecking=accept-new -t ${s.username}@${s.host} "${innerCmd}"`;
  }
}
SshHost.limiters = {};

// ─── Factory ─────────────────────────────────────────────────────────────────
function listHosts(cfg = loadConfig()) {
  const localKind = cfg.local.mode === 'wsl' ? 'wsl' : (IS_WIN ? 'native-win' : 'native-posix');
  return [
    { id: 'local', name: cfg.local.mode === 'wsl' ? 'Local (WSL)' : (IS_WIN ? 'Local (Docker Desktop)' : 'Local'), kind: localKind, hbDir: cfg.local.hbDir, monthlyCost: cfg.local.monthlyCost || 0 },
    ...cfg.servers.map(s => ({ id: s.id, name: s.name || s.id, kind: 'ssh', host: s.host, hbDir: s.hbDir, provider: s.provider, monthlyCost: s.monthlyCost || 0 })),
  ];
}

function getHost(target = 'local', cfg = loadConfig()) {
  if (!target || target === 'local') {
    const o = { id: 'local', name: 'Local', hbDir: cfg.local.hbDir };
    if (cfg.local.mode === 'wsl') return new WslHost({ ...o, distro: cfg.local.wslDistro });
    return IS_WIN ? new WinHost(o) : new LocalPosixHost(o);
  }
  const s = cfg.servers.find(x => x.id === target);
  if (!s) throw new HostError(`Unknown host "${target}"`, { status: 404 });
  return new SshHost({ id: s.id, name: s.name, hbDir: s.hbDir, server: s });
}

// Open an interactive terminal window on the machine running the backend
function openTerminalWindow(command, title = 'Hummingbot') {
  if (!IS_WIN) return false;
  const safeTitle = title.replace(/[^\w .-]/g, '');
  // `start` needs a quoted title as its first argument, so build the line verbatim.
  spawn('cmd.exe', ['/c', `start "${safeTitle}" cmd.exe /k ${command}`], {
    detached: true, stdio: 'ignore', windowsHide: false, windowsVerbatimArguments: true,
  }).unref();
  return true;
}

function closeAllSsh() { for (const [, e] of sshPool) { try { e.conn.end(); } catch (_) {} } sshPool.clear(); }

module.exports = { getHost, listHosts, openTerminalWindow, shq, safeRel, safeName, HostError, closeAllSsh, IS_WIN };
