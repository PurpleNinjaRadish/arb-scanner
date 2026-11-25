// ─── Complete Hummingbot lifecycle & configuration manager ────────────────────
// Works uniformly across Docker Desktop (Windows), WSL, Linux native, and SSH.
const os = require('os');
const yaml = require('js-yaml');
const { loadConfig } = require('./config');
const { getHost, openTerminalWindow, safeName, safeRel, shq, HostError } = require('./hosts');
const { parseStrategyYaml } = require('./strategies');
const { EXCHANGES } = require('./exchanges');

const DEFAULT_PAPER_EXCHANGES = [
  'kraken', 'coinbase_advanced_trade', 'binance', 'binance_us', 'kucoin', 'bybit', 'okx',
];

const DEFAULT_PAPER_BALANCES = {
  USD: 10000,
  USDT: 10000,
  USDC: 10000,
  BTC: 0.25,
  ETH: 4,
  SOL: 50,
  AVAX: 250,
  LINK: 300,
  XRP: 5000,
  ADA: 10000,
  DOGE: 25000,
};

// Strip ANSI / VT100 escape sequences from Hummingbot TUI docker stdout
function stripAnsi(s) {
  return String(s || '')
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '')
    .replace(/\r/g, '');
}

async function hbVolumeArgs(host) {
  const [conf, logs, data] = await Promise.all([
    host.dockerPath('conf'),
    host.dockerPath('logs'),
    host.dockerPath('data'),
  ]);
  return [
    '-v', `${conf}:/home/hummingbot/conf`,
    '-v', `${logs}:/home/hummingbot/logs`,
    '-v', `${data}:/home/hummingbot/data`,
  ];
}

// ─── Host Diagnostics & System Specs ─────────────────────────────────────────
async function getHostSpecs(host) {
  if (!host.supportsShell()) {
    // Windows native — read local machine stats via Node's os module
    const cpus = os.cpus();
    const totalMemMb = Math.round(os.totalmem() / 1048576);
    const freeMemMb = Math.round(os.freemem() / 1048576);
    return {
      os: `${os.platform()} ${os.release()}`,
      arch: os.arch(),
      vcpu: cpus.length,
      cpuModel: cpus[0] ? cpus[0].model : '',
      ramTotalMb: totalMemMb,
      ramAvailMb: freeMemMb,
      swapTotalMb: 0,
      diskFreeGb: null,
      diskTotalGb: null,
      loadAvg: null,
      ntpSynced: null,
    };
  }
  const script = `
uname -srm
nproc 2>/dev/null || echo 1
free -m 2>/dev/null | awk '/^Mem:/{print $2,$7} /^Swap:/{print $2}' | tr '\\n' ' '
echo ""
df -BG "$HOME" 2>/dev/null | awk 'NR==2{gsub("G",""); print $2,$4}'
cat /proc/loadavg 2>/dev/null | awk '{print $1,$2,$3}'
(timedatectl show -p NTPSynchronized --value 2>/dev/null || (pgrep -x chronyd >/dev/null && echo yes) || echo unknown)
`;
  const r = await host.sh(script, { timeout: 15000 });
  if (r.code !== 0) return null;
  const lines = r.stdout.split('\n').map(l => l.trim());
  const memParts = (lines[2] || '').split(/\s+/).map(Number);
  const diskParts = (lines[3] || '').split(/\s+/).map(Number);
  return {
    os: lines[0] || 'Linux',
    arch: (lines[0] || '').split(/\s+/).pop() || '',
    vcpu: parseInt(lines[1], 10) || 1,
    ramTotalMb: memParts[0] || 0,
    ramAvailMb: memParts[1] || 0,
    swapTotalMb: memParts[2] || 0,
    diskTotalGb: diskParts[0] || null,
    diskFreeGb: diskParts[1] || null,
    loadAvg: lines[4] || null,
    ntpSynced: lines[5] === 'yes' ? true : lines[5] === 'no' ? false : null,
  };
}

async function hostStatus(target = 'local') {
  const cfg = loadConfig();
  let host;
  try { host = getHost(target, cfg); }
  catch (e) { return { target, online: false, error: e.message }; }

  const out = {
    target,
    name: host.name,
    kind: host.kind,
    hbDir: host.hbDir,
    hbImage: cfg.hbImage,
    online: false,
    dockerVersion: null,
    imagePresent: false,
    runningCount: 0,
    totalCount: 0,
    specs: null,
    error: null,
  };

  try {
    const ver = await host.dockerRaw(['version', '--format', '{{.Server.Version}}'], { timeout: 8000 });
    if (ver.code !== 0) {
      out.error = (ver.stderr || ver.stdout || 'Docker unreachable').trim();
      // Even if Docker is offline, we can still grab OS specs over SSH
      if (host.supportsShell()) { try { out.specs = await getHostSpecs(host); } catch (_) {} }
      return out;
    }
    out.online = true;
    out.dockerVersion = ver.stdout.trim();

    const [imgRes, psRes, specs] = await Promise.all([
      host.dockerRaw(['image', 'inspect', cfg.hbImage, '--format', '{{.Size}}|{{.Created}}'], { timeout: 8000 }),
      host.dockerRaw(['ps', '-a', '--format', '{{.Image}}|{{.Names}}|{{.State}}'], { timeout: 8000 }),
      getHostSpecs(host).catch(() => null),
    ]);

    if (imgRes.code === 0) {
      const [sz, created] = imgRes.stdout.trim().split('|');
      out.imagePresent = true;
      out.imageSizeMb = Math.round((Number(sz) || 0) / 1048576);
      out.imageCreated = created || null;
    }
    if (psRes.code === 0) {
      const hb = psRes.stdout.trim().split('\n').filter(Boolean).filter(l => {
        const [img, name] = l.split('|');
        return /hummingbot/i.test(img) || /^(arb_|hb_)/.test(name);
      });
      out.totalCount = hb.length;
      out.runningCount = hb.filter(l => l.endsWith('|running')).length;
    }
    out.specs = specs;
  } catch (e) {
    out.error = e.message;
  }
  return out;
}

// ─── Containers & Live Stats ─────────────────────────────────────────────────
function parseMemMb(str) {
  const m = /([\d.]+)\s*(B|KiB|MiB|GiB|kB|MB|GB)/i.exec(str || '');
  if (!m) return 0;
  const v = parseFloat(m[1]);
  const u = m[2].toLowerCase();
  if (u === 'gib' || u === 'gb') return v * 1024;
  if (u === 'mib' || u === 'mb') return v;
  if (u === 'kib' || u === 'kb') return v / 1024;
  return v / 1048576;
}

async function containerStats(target = 'local', ids = null) {
  const host = getHost(target);
  const args = ['stats', '--no-stream', '--format', '{{.ID}}|{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}|{{.NetIO}}|{{.PIDs}}'];
  if (ids && ids.length) args.push(...ids.map(id => safeName(id, 'containerId')));
  const r = await host.dockerRaw(args, { timeout: 12000 });
  if (r.code !== 0) return {};
  const map = {};
  for (const line of r.stdout.trim().split('\n').filter(Boolean)) {
    const [id, name, cpu, memUsage, memPct, netIO, pids] = line.split('|');
    const [usedStr, limitStr] = (memUsage || '').split('/').map(s => s.trim());
    map[name] = {
      id,
      cpuPct: parseFloat(cpu) || 0,
      memUsage: memUsage || '',
      memUsedMb: Math.round(parseMemMb(usedStr)),
      memLimitMb: Math.round(parseMemMb(limitStr)),
      memPct: parseFloat(memPct) || 0,
      netIO: netIO || '',
      pids: parseInt(pids, 10) || 0,
    };
  }
  return map;
}

async function listContainers(target = 'local', { includeStats = true } = {}) {
  const host = getHost(target);
  const fmt = '{{.ID}}|{{.Names}}|{{.Image}}|{{.State}}|{{.Status}}|{{.RunningFor}}|{{.Label "arb-scanner.strategy"}}|{{.Label "arb-scanner.paper"}}';
  const out = await host.docker(['ps', '-a', '--format', fmt], { timeout: 12000 });
  if (!out) return [];

  const rows = out.split('\n').filter(Boolean).map(line => {
    const [id, name, image, state, status, runningFor, strategyLabel, paperLabel] = line.split('|');
    return { id, name, image, state, status, runningFor, strategyLabel, paperLabel };
  }).filter(c => /hummingbot/i.test(c.image) || /^(arb_|hb_)/.test(c.name));

  // Fetch env CONFIG_FILE_NAME in one batch docker inspect for containers without labels
  const missingLabel = rows.filter(r => !r.strategyLabel).map(r => r.id);
  const envMap = {};
  if (missingLabel.length) {
    const ins = await host.dockerRaw(['inspect', '--format', '{{.Id}}|{{range .Config.Env}}{{.}};;{{end}}', ...missingLabel], { timeout: 10000 });
    if (ins.code === 0) {
      for (const l of ins.stdout.trim().split('\n').filter(Boolean)) {
        const [fullId, envs] = l.split('|');
        const hit = (envs || '').split(';;').find(e => e.startsWith('CONFIG_FILE_NAME='));
        if (hit) envMap[fullId.slice(0, 12)] = hit.split('=')[1].trim();
      }
    }
  }

  let statsByName = {};
  const runningIds = rows.filter(r => r.state === 'running').map(r => r.id);
  if (includeStats && runningIds.length) {
    try { statsByName = await containerStats(target, runningIds); } catch (_) {}
  }

  return rows.map(r => {
    const configFile = r.strategyLabel
      ? (r.strategyLabel.endsWith('.yml') ? r.strategyLabel : `${r.strategyLabel}.yml`)
      : (envMap[r.id.slice(0, 12)] || '');
    return {
      id: r.id,
      name: r.name,
      image: r.image,
      state: r.state,
      status: r.status,
      runningFor: r.runningFor,
      configFile,
      configName: configFile.replace(/\.ya?ml$/i, ''),
      paper: r.paperLabel === 'true' ? true : r.paperLabel === 'false' ? false : null,
      target,
      stats: statsByName[r.name] || null,
    };
  });
}

// ─── Paper Trade Client Config (conf/conf_client.yml) ────────────────────────
async function readClientConfigRaw(host) {
  let raw = await host.readFile('conf/conf_client.yml');
  let filename = 'conf/conf_client.yml';
  if (raw == null) {
    const legacy = await host.readFile('conf/client_config_map.yml');
    if (legacy != null) { raw = legacy; filename = 'conf/client_config_map.yml'; }
  }
  return { raw: raw || '', filename };
}

async function getPaperConfig(target = 'local') {
  const host = getHost(target);
  const { raw, filename } = await readClientConfigRaw(host);
  let doc = {};
  try { doc = (raw && yaml.load(raw)) || {}; } catch (_) { doc = {}; }
  const pt = doc.paper_trade || {};
  return {
    target,
    filename,
    exchanges: Array.isArray(pt.paper_trade_exchanges) ? pt.paper_trade_exchanges : [],
    balances: (pt.paper_trade_account_balance && typeof pt.paper_trade_account_balance === 'object')
      ? pt.paper_trade_account_balance
      : {},
    killSwitchEnabled: !!doc.kill_switch_enabled,
    killSwitchRate: doc.kill_switch_rate ?? -100,
    tickSize: doc.tick_size ?? 1.0,
    rawYaml: raw,
  };
}

async function savePaperConfig(target = 'local', { balances, exchanges, killSwitchEnabled, killSwitchRate, tickSize, rawYaml } = {}) {
  const host = getHost(target);
  await host.ensureDirs();
  if (typeof rawYaml === 'string') {
    yaml.load(rawYaml); // validate YAML syntax
    await host.writeFile('conf/conf_client.yml', rawYaml);
    return getPaperConfig(target);
  }
  const { raw } = await readClientConfigRaw(host);
  let doc = {};
  try { doc = (raw && yaml.load(raw)) || {}; } catch (_) { doc = {}; }
  if (!doc || typeof doc !== 'object') doc = {};
  if (!doc.paper_trade || typeof doc.paper_trade !== 'object') doc.paper_trade = {};

  if (Array.isArray(exchanges)) doc.paper_trade.paper_trade_exchanges = [...new Set(exchanges)];
  if (balances && typeof balances === 'object') {
    const clean = {};
    for (const [k, v] of Object.entries(balances)) {
      const sym = String(k).trim().toUpperCase();
      if (sym) clean[sym] = Number(v) || 0;
    }
    doc.paper_trade.paper_trade_account_balance = clean;
  }
  if (killSwitchEnabled !== undefined) doc.kill_switch_enabled = !!killSwitchEnabled;
  if (killSwitchRate !== undefined) doc.kill_switch_rate = Number(killSwitchRate);
  if (tickSize !== undefined) doc.tick_size = Number(tickSize);

  await host.writeFile('conf/conf_client.yml', yaml.dump(doc, { lineWidth: -1, noRefs: true }));
  return getPaperConfig(target);
}

// Automatically ensures paper connectors and starter balances exist before a paper bot starts
async function ensurePaperReady(host, extraExchanges = [], seedPairs = []) {
  const { raw } = await readClientConfigRaw(host);
  let doc = {};
  try { doc = (raw && yaml.load(raw)) || {}; } catch (_) { doc = {}; }
  if (!doc || typeof doc !== 'object') doc = {};
  if (!doc.paper_trade || typeof doc.paper_trade !== 'object') doc.paper_trade = {};

  let changed = false;
  const curEx = Array.isArray(doc.paper_trade.paper_trade_exchanges) ? [...doc.paper_trade.paper_trade_exchanges] : [];
  for (const ex of [...DEFAULT_PAPER_EXCHANGES, ...extraExchanges]) {
    if (ex && !curEx.includes(ex)) { curEx.push(ex); changed = true; }
  }
  doc.paper_trade.paper_trade_exchanges = curEx;

  const curBal = (doc.paper_trade.paper_trade_account_balance && typeof doc.paper_trade.paper_trade_account_balance === 'object')
    ? { ...doc.paper_trade.paper_trade_account_balance }
    : {};
  if (Object.keys(curBal).length === 0) {
    Object.assign(curBal, DEFAULT_PAPER_BALANCES);
    changed = true;
  }
  for (const p of seedPairs) {
    const [base, quote] = String(p || '').split('-');
    if (quote && curBal[quote] == null) { curBal[quote] = 10000; changed = true; }
    if (base && curBal[base] == null) { curBal[base] = 100; changed = true; }
  }
  doc.paper_trade.paper_trade_account_balance = curBal;

  if (changed || !raw) {
    await host.writeFile('conf/conf_client.yml', yaml.dump(doc, { lineWidth: -1, noRefs: true }));
  }
  return { changed, exchanges: curEx, balances: curBal };
}

// ─── Deploy & Manage Strategies ──────────────────────────────────────────────
async function deployStrategy(target = 'local', {
  configName, yaml: yamlText, launchMode = 'detached',
  autoStart = true, memLimit = '768m', cpuLimit = '1.0',
  restartPolicy = 'unless-stopped', networkHost = false,
} = {}) {
  const cfg = loadConfig();
  const host = getHost(target, cfg);
  const cleanName = safeName(String(configName || '').replace(/\.ya?ml$/i, ''), 'configName');
  const parsed = parseStrategyYaml(yamlText);
  if (!parsed.valid) throw new HostError(`Invalid strategy YAML: ${parsed.error}`, { status: 400 });

  await host.ensureDirs();
  let paperSetup = null;
  if (parsed.paper) {
    paperSetup = await ensurePaperReady(host, parsed.paperBaseConnectors, parsed.pair ? [parsed.pair] : []);
  }

  const relFile = `conf/strategies/${cleanName}.yml`;
  await host.writeFile(relFile, yamlText);

  if (!autoStart) {
    return { success: true, savedOnly: true, configName: cleanName, target, parsed, paperSetup };
  }

  const containerName = safeName(cleanName.startsWith('arb_') ? cleanName : `arb_${cleanName}`, 'containerName');
  // Remove any stale exited/conflicting container with the same name
  await host.dockerRaw(['rm', '-f', containerName], { timeout: 15000 });

  const volArgs = await hbVolumeArgs(host);
  const envArgs = ['-e', `CONFIG_FILE_NAME=${cleanName}.yml`];
  if (cfg.hbPassword) envArgs.push('-e', `CONFIG_PASSWORD=${cfg.hbPassword}`);

  const labelArgs = [
    '--label', 'arb-scanner.managed=true',
    '--label', `arb-scanner.strategy=${cleanName}`,
    '--label', `arb-scanner.paper=${parsed.paper ? 'true' : 'false'}`,
  ];
  const limitArgs = [];
  if (memLimit) limitArgs.push('--memory', String(memLimit));
  if (cpuLimit) limitArgs.push('--cpus', String(cpuLimit));
  if (networkHost) limitArgs.push('--network', 'host');

  if (launchMode === 'interactive') {
    const args = ['run', '-it', '--rm', '--name', containerName, ...volArgs, ...envArgs, ...labelArgs, cfg.hbImage];
    const dockerCmd = `docker ${args.map(a => /\s/.test(a) ? `"${a}"` : a).join(' ')}`;
    const cmd = host.terminalCommand(dockerCmd);
    const opened = openTerminalWindow(cmd, `HB ${containerName}`);
    return {
      success: true, containerId: 'interactive', containerName, configName: cleanName,
      target, opened, command: cmd, paperSetup,
      message: opened ? `Launched interactive window for ${containerName}` : 'Run the command below in a terminal',
    };
  }

  const args = [
    'run', '-dt',
    '--restart', restartPolicy,
    '--name', containerName,
    ...limitArgs, ...volArgs, ...envArgs, ...labelArgs,
    cfg.hbImage,
  ];
  const cid = await host.docker(args, { timeout: 30000 });
  return {
    success: true,
    containerId: cid.trim(),
    containerName,
    configName: cleanName,
    target,
    paper: parsed.paper,
    paperSetup,
    warnings: parsed.warnings,
    message: `Deployed ${containerName} (${parsed.paper ? 'PAPER' : 'LIVE'}) on ${host.name}`,
  };
}

async function deployBase(target = 'local', { name, launchMode = 'detached' } = {}) {
  const cfg = loadConfig();
  const host = getHost(target, cfg);
  await host.ensureDirs();
  const containerName = safeName(name || `hb_base_${Date.now()}`, 'containerName');
  const volArgs = await hbVolumeArgs(host);
  const envArgs = cfg.hbPassword ? ['-e', `CONFIG_PASSWORD=${cfg.hbPassword}`] : [];
  const labelArgs = ['--label', 'arb-scanner.managed=true', '--label', 'arb-scanner.base=true'];

  if (launchMode === 'interactive') {
    const args = ['run', '-it', '--rm', '--name', containerName, ...volArgs, ...envArgs, ...labelArgs, cfg.hbImage];
    const dockerCmd = `docker ${args.map(a => /\s/.test(a) ? `"${a}"` : a).join(' ')}`;
    const cmd = host.terminalCommand(dockerCmd);
    const opened = openTerminalWindow(cmd, containerName);
    return { success: true, containerId: 'interactive', containerName, opened, command: cmd, message: opened ? 'Base Hummingbot opened in terminal' : cmd };
  }

  const cid = await host.docker(['run', '-dt', '--restart', 'unless-stopped', '--name', containerName, ...volArgs, ...envArgs, ...labelArgs, cfg.hbImage], { timeout: 30000 });
  return { success: true, containerId: cid.trim(), containerName, message: `Base Hummingbot started (${cid.trim().slice(0, 12)})` };
}

async function containerAction(target = 'local', containerId, action) {
  const host = getHost(target);
  const id = safeName(containerId, 'containerId');
  const allowed = {
    start:   ['start', id],
    stop:    ['stop', '-t', '10', id],
    restart: ['restart', '-t', '10', id],
    pause:   ['pause', id],
    unpause: ['unpause', id],
    remove:  ['rm', '-f', id],
  };
  const args = allowed[action];
  if (!args) throw new HostError(`Unsupported action: ${action}`, { status: 400 });
  await host.docker(args, { timeout: 30000 });
  return { success: true, id, action, target };
}

async function stopAll(target = 'local', { remove = false } = {}) {
  const list = await listContainers(target, { includeStats: false });
  const host = getHost(target);
  const running = list.filter(c => c.state === 'running' || c.state === 'paused').map(c => c.id);
  if (running.length) await host.docker(['stop', '-t', '10', ...running], { timeout: 60000 });
  if (remove && list.length) await host.docker(['rm', '-f', ...list.map(c => c.id)], { timeout: 60000 });
  return { success: true, stopped: running.length, removed: remove ? list.length : 0 };
}

async function containerLogs(target = 'local', containerId, { tail = 250, source = 'auto' } = {}) {
  const host = getHost(target);
  const id = safeName(containerId, 'containerId');
  const n = Math.min(Math.max(parseInt(tail, 10) || 250, 20), 2000);

  // Try to locate the strategy log file (logs/logs_<configName>.log) which is far cleaner than TUI stdout
  let strategyLog = null;
  let logFile = null;
  if (source !== 'docker') {
    const ins = await host.dockerRaw(['inspect', '--format', '{{index .Config.Labels "arb-scanner.strategy"}}|{{range .Config.Env}}{{.}};;{{end}}', id], { timeout: 8000 });
    if (ins.code === 0) {
      const [lbl, envs] = ins.stdout.trim().split('|');
      let cfgName = lbl;
      if (!cfgName) {
        const hit = (envs || '').split(';;').find(e => e.startsWith('CONFIG_FILE_NAME='));
        if (hit) cfgName = hit.split('=')[1].trim().replace(/\.ya?ml$/i, '');
      }
      if (cfgName) {
        const candidate = `logs/logs_${cfgName}.log`;
        const content = await host.tail(candidate, n).catch(() => null);
        if (content != null) { strategyLog = content; logFile = candidate; }
      }
    }
  }

  if (source === 'file') {
    return { logs: strategyLog ?? 'No strategy log file found yet for this container.', source: 'file', logFile };
  }
  if (source === 'auto' && strategyLog) {
    return { logs: strategyLog, source: 'file', logFile };
  }

  const r = await host.dockerRaw(['logs', '--tail', String(n), id], { timeout: 15000 });
  const raw = (r.stdout || '') + (r.stderr ? `\n${r.stderr}` : '');
  return { logs: stripAnsi(raw).trim() || '(no output yet)', source: 'docker', logFile };
}

async function listLogFiles(target = 'local') {
  const host = getHost(target);
  const files = await host.listDir('logs');
  return files.filter(f => !f.isDir && /\.log(\.\d+)?$/i.test(f.name)).sort((a, b) => b.mtime - a.mtime);
}

async function readLogFile(target = 'local', fileName, lines = 250) {
  const host = getHost(target);
  const clean = safeRel(`logs/${safeName(fileName, 'fileName')}`);
  const content = await host.tail(clean, Math.min(Math.max(parseInt(lines, 10) || 250, 20), 2000));
  if (content == null) throw new HostError(`Log file not found: ${fileName}`, { status: 404 });
  return { fileName, logs: content };
}

async function getAttachInfo(target = 'local', containerId, { open = false } = {}) {
  const host = getHost(target);
  const id = safeName(containerId, 'containerId');
  const cmd = host.terminalCommand(`docker attach ${id}`);
  const opened = open ? openTerminalWindow(cmd, `Attach ${id.slice(0, 12)}`) : false;
  return { command: cmd, opened, hint: 'Detach cleanly without stopping the bot using Ctrl+P then Ctrl+Q.' };
}

// ─── Strategy Library (conf/strategies/*.yml) ────────────────────────────────
async function listStrategies(target = 'local') {
  const host = getHost(target);
  const [files, containers] = await Promise.all([
    host.listDir('conf/strategies'),
    listContainers(target, { includeStats: false }).catch(() => []),
  ]);
  const byConfig = new Map();
  for (const c of containers) if (c.configName) byConfig.set(c.configName, c);

  const out = [];
  for (const f of files.filter(x => !x.isDir && /\.ya?ml$/i.test(x.name)).sort((a, b) => b.mtime - a.mtime)) {
    const raw = await host.readFile(`conf/strategies/${f.name}`).catch(() => '');
    const parsed = parseStrategyYaml(raw || '');
    const name = f.name.replace(/\.ya?ml$/i, '');
    const c = byConfig.get(name);
    out.push({
      name,
      fileName: f.name,
      size: f.size,
      mtime: f.mtime,
      strategy: parsed.strategy || 'unknown',
      pair: parsed.pair || '',
      connectors: parsed.connectors || [],
      paper: !!parsed.paper,
      orderAmount: parsed.orderAmount,
      minProfitability: parsed.minProfitability,
      valid: parsed.valid,
      warnings: parsed.warnings || [],
      container: c ? { id: c.id, name: c.name, state: c.state, status: c.status } : null,
    });
  }
  return out;
}

async function readStrategy(target = 'local', name) {
  const host = getHost(target);
  const clean = safeName(String(name).replace(/\.ya?ml$/i, ''), 'strategy');
  const raw = await host.readFile(`conf/strategies/${clean}.yml`);
  if (raw == null) throw new HostError(`Strategy not found: ${clean}`, { status: 404 });
  return { name: clean, yaml: raw, parsed: parseStrategyYaml(raw) };
}

async function saveStrategy(target = 'local', name, yamlText) {
  const host = getHost(target);
  const clean = safeName(String(name).replace(/\.ya?ml$/i, ''), 'strategy');
  const parsed = parseStrategyYaml(yamlText);
  if (!parsed.valid) throw new HostError(`Invalid YAML: ${parsed.error}`, { status: 400 });
  await host.ensureDirs();
  await host.writeFile(`conf/strategies/${clean}.yml`, yamlText);
  return { success: true, name: clean, parsed };
}

async function deleteStrategy(target = 'local', name) {
  const host = getHost(target);
  const clean = safeName(String(name).replace(/\.ya?ml$/i, ''), 'strategy');
  await host.removeFile(`conf/strategies/${clean}.yml`);
  return { success: true, name: clean };
}

async function getContainerConfig(target = 'local', containerId) {
  const host = getHost(target);
  const id = safeName(containerId, 'containerId');
  const ins = await host.docker(['inspect', '--format', '{{index .Config.Labels "arb-scanner.strategy"}}|{{range .Config.Env}}{{.}};;{{end}}', id], { timeout: 10000 });
  const [lbl, envs] = ins.split('|');
  let cfgName = lbl;
  if (!cfgName) {
    const hit = (envs || '').split(';;').find(e => e.startsWith('CONFIG_FILE_NAME='));
    if (hit) cfgName = hit.split('=')[1].trim().replace(/\.ya?ml$/i, '');
  }
  if (!cfgName) throw new HostError('This container has no CONFIG_FILE_NAME (base Hummingbot instance)', { status: 404 });
  const { yaml: raw, parsed } = await readStrategy(target, cfgName);
  return { configName: cfgName, yaml: raw, parsed };
}

async function editContainerConfig(target = 'local', { containerId, configName, yaml: yamlText }) {
  if (containerId) {
    await containerAction(target, containerId, 'remove').catch(() => {});
  }
  return deployStrategy(target, { configName, yaml: yamlText, launchMode: 'detached', autoStart: true });
}

// ─── Connectors / API Keys (conf/connectors/*.yml) ───────────────────────────
async function listConnectors(target = 'local') {
  const host = getHost(target);
  const files = await host.listDir('conf/connectors');
  const out = [];
  for (const f of files.filter(x => !x.isDir && /\.ya?ml$/i.test(x.name))) {
    const raw = await host.readFile(`conf/connectors/${f.name}`).catch(() => '');
    const encrypted = /!encrypted|gAAAAAB/.test(raw || '');
    out.push({
      exchange: f.name.replace(/\.ya?ml$/i, ''),
      fileName: f.name,
      encrypted,
      mtime: f.mtime,
    });
  }
  return out.sort((a, b) => a.exchange.localeCompare(b.exchange));
}

async function saveConnector(target = 'local', { exchange, apiKey, apiSecret, passphrase = '' }) {
  const host = getHost(target);
  const exKey = (EXCHANGES[exchange] && EXCHANGES[exchange].hbConnector) || exchange;
  const cleanEx = safeName(exKey, 'exchange');
  if (!apiKey || !apiSecret) throw new HostError('apiKey and apiSecret are required', { status: 400 });

  const confObj = {
    connector: cleanEx,
    [`${cleanEx}_api_key`]: apiKey,
    [`${cleanEx}_api_secret`]: apiSecret,
  };
  if (passphrase) confObj[`${cleanEx}_api_passphrase`] = passphrase;

  await host.ensureDirs();
  await host.writeFile(`conf/connectors/${cleanEx}.yml`, yaml.dump(confObj, { lineWidth: -1 }));
  return {
    success: true,
    exchange: cleanEx,
    note: 'Saved connector file. For encrypted storage via Hummingbot keystore, use the interactive `connect` terminal.',
  };
}

async function deleteConnector(target = 'local', exchange) {
  const host = getHost(target);
  const cleanEx = safeName(exchange, 'exchange');
  await host.removeFile(`conf/connectors/${cleanEx}.yml`);
  return { success: true, exchange: cleanEx };
}

async function openConnectTerminal(target = 'local', { open = true } = {}) {
  const cfg = loadConfig();
  const host = getHost(target, cfg);
  await host.ensureDirs();
  const volArgs = await hbVolumeArgs(host);
  const args = ['run', '-it', '--rm', '--name', `hb_connect_${Date.now()}`, ...volArgs, cfg.hbImage];
  const dockerCmd = `docker ${args.map(a => /\s/.test(a) ? `"${a}"` : a).join(' ')}`;
  const cmd = host.terminalCommand(dockerCmd);
  const opened = open ? openTerminalWindow(cmd, `Hummingbot Connect (${host.name})`) : false;
  return { success: true, command: cmd, opened };
}

// ─── Docker Image Management ─────────────────────────────────────────────────
async function pullImage(target = 'local', image) {
  const cfg = loadConfig();
  const host = getHost(target, cfg);
  const img = String(image || cfg.hbImage).trim();
  if (!/^[\w./:-]+$/.test(img)) throw new HostError(`Invalid Docker image: ${img}`, { status: 400 });
  const out = await host.docker(['pull', img], { timeout: 600000 });
  return { success: true, image: img, output: out };
}

// ─── Realized Trades & P&L Parser (data/*_trades.csv) ────────────────────────
function parseCsvLine(line) {
  const out = []; let cur = ''; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { if (inQ && line[i + 1] === '"') { cur += '"'; i++; } else inQ = !inQ; }
    else if (ch === ',' && !inQ) { out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

async function getTradesAndPnl(target = 'local') {
  const host = getHost(target);
  const files = await host.listDir('data');
  const csvFiles = files.filter(f => !f.isDir && /trades.*\.csv$/i.test(f.name)).sort((a, b) => b.mtime - a.mtime);

  const trades = [];
  const rawChunks = [];

  for (const f of csvFiles) {
    const content = await host.readFile(`data/${f.name}`).catch(() => null);
    if (!content || !content.trim()) continue;
    rawChunks.push(`# ${f.name}\n${content.trim()}`);
    const lines = content.split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) continue;
    const headers = parseCsvLine(lines[0]).map(h => h.toLowerCase().replace(/\s+/g, '_'));
    const idx = (...names) => {
      for (const n of names) { const i = headers.indexOf(n); if (i !== -1) return i; }
      return -1;
    };
    const iTs = idx('timestamp', 'time', 'trade_timestamp');
    const iMkt = idx('market', 'exchange');
    const iPair = idx('symbol', 'trading_pair', 'market_trading_pair');
    const iSide = idx('trade_type', 'side', 'order_side');
    const iPrice = idx('price');
    const iAmt = idx('amount', 'quantity');
    const iFee = idx('trade_fee_in_quote', 'fee_paid', 'fee_in_quote');

    for (let k = 1; k < lines.length; k++) {
      const cols = parseCsvLine(lines[k]);
      if (cols.length < 4) continue;
      const price = parseFloat(cols[iPrice]) || 0;
      const amount = parseFloat(cols[iAmt]) || 0;
      if (!price || !amount) continue;
      const side = String(cols[iSide] || '').toUpperCase().includes('BUY') ? 'BUY' : 'SELL';
      const feeQuote = parseFloat(cols[iFee]) || 0;
      const notional = price * amount;
      trades.push({
        file: f.name,
        timestamp: cols[iTs] || '',
        market: cols[iMkt] || '',
        pair: cols[iPair] || '',
        side,
        price,
        amount,
        notional,
        feeQuote,
        paper: /_paper_trade/i.test(cols[iMkt] || '') || /paper/i.test(f.name),
      });
    }
  }

  // Aggregate by pair (matched buy/sell volume gives realized arbitrage P&L)
  const byPair = {};
  let totalVolume = 0, totalFees = 0;
  for (const t of trades) {
    totalVolume += t.notional;
    totalFees += t.feeQuote;
    const g = byPair[t.pair] || (byPair[t.pair] = { pair: t.pair, buys: 0, sells: 0, buyQty: 0, sellQty: 0, buyCost: 0, sellRev: 0, fees: 0 });
    g.fees += t.feeQuote;
    if (t.side === 'BUY') { g.buys++; g.buyQty += t.amount; g.buyCost += t.notional; }
    else { g.sells++; g.sellQty += t.amount; g.sellRev += t.notional; }
  }

  let realizedPnl = 0;
  const pairSummary = Object.values(byPair).map(g => {
    const avgBuy = g.buyQty ? g.buyCost / g.buyQty : 0;
    const avgSell = g.sellQty ? g.sellRev / g.sellQty : 0;
    const matchedQty = Math.min(g.buyQty, g.sellQty);
    const grossMatchedPnl = matchedQty * (avgSell - avgBuy);
    const netMatchedPnl = grossMatchedPnl - g.fees;
    realizedPnl += netMatchedPnl;
    return {
      ...g,
      avgBuy,
      avgSell,
      matchedQty,
      inventoryDelta: g.buyQty - g.sellQty,
      grossMatchedPnl,
      netMatchedPnl,
    };
  }).sort((a, b) => Math.abs(b.netMatchedPnl) - Math.abs(a.netMatchedPnl));

  return {
    target,
    files: csvFiles.map(f => ({ name: f.name, size: f.size, mtime: f.mtime })),
    summary: {
      totalTrades: trades.length,
      buyCount: trades.filter(t => t.side === 'BUY').length,
      sellCount: trades.filter(t => t.side === 'SELL').length,
      totalVolume,
      totalFees,
      realizedPnl,
      netBps: totalVolume > 0 ? (realizedPnl / (totalVolume / 2)) * 10000 : 0,
    },
    byPair: pairSummary,
    trades: trades.slice(-250).reverse(),
    csvData: rawChunks.join('\n\n'),
  };
}

module.exports = {
  hostStatus,
  getHostSpecs,
  listContainers,
  containerStats,
  deployStrategy,
  deployBase,
  containerAction,
  stopAll,
  containerLogs,
  listLogFiles,
  readLogFile,
  getAttachInfo,
  listStrategies,
  readStrategy,
  saveStrategy,
  deleteStrategy,
  getContainerConfig,
  editContainerConfig,
  listConnectors,
  saveConnector,
  deleteConnector,
  openConnectTerminal,
  getPaperConfig,
  savePaperConfig,
  ensurePaperReady,
  pullImage,
  getTradesAndPnl,
  DEFAULT_PAPER_EXCHANGES,
  DEFAULT_PAPER_BALANCES,
};
