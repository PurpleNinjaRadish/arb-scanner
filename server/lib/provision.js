// ─── Streamlined Server Bootstrap & Async Job Runner ─────────────────────────
const crypto = require('crypto');
const yaml = require('js-yaml');
const { loadConfig } = require('./config');
const { getHost, shq } = require('./hosts');
const { DEFAULT_PAPER_EXCHANGES, DEFAULT_PAPER_BALANCES, pullImage } = require('./hummingbot');

const jobs = new Map(); // id -> { id, type, target, status, startedAt, finishedAt, log, error, result }

function startJob(type, target, runner) {
  const id = `job_${crypto.randomBytes(4).toString('hex')}`;
  const job = {
    id, type, target, status: 'running',
    startedAt: Date.now(), finishedAt: null,
    log: `[${new Date().toISOString()}] Starting ${type} on ${target}...\n`,
    error: null, result: null,
  };
  jobs.set(id, job);
  // Keep latest 30 jobs
  if (jobs.size > 30) {
    const oldest = jobs.keys().next().value;
    jobs.delete(oldest);
  }
  const append = (line) => { job.log += `${line}\n`; };
  Promise.resolve().then(() => runner(append))
    .then(res => {
      job.status = 'done';
      job.result = res;
      job.finishedAt = Date.now();
      append(`[${new Date().toISOString()}] Completed successfully.`);
    })
    .catch(err => {
      job.status = 'error';
      job.error = err.message || String(err);
      job.finishedAt = Date.now();
      append(`[${new Date().toISOString()}] ERROR: ${job.error}`);
    });
  return job;
}

function getJob(id) { return jobs.get(id) || null; }
function listJobs() { return [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt); }

// Idempotent Linux server bootstrap script (Ubuntu / Debian / Amazon Linux)
function generateBootstrapScript({
  hbDir = '~/hummingbot',
  hbImage,
  configureSwap = true,
  configureLogRotation = true,
  configureNtp = true,
  pullDockerImage = true,
} = {}) {
  const cfg = loadConfig();
  const img = hbImage || cfg.hbImage;
  const dirExpr = hbDir.startsWith('~') ? `"$HOME/${hbDir.slice(2)}"` : shq(hbDir);
  const defaultClientYaml = yaml.dump({
    paper_trade: {
      paper_trade_exchanges: DEFAULT_PAPER_EXCHANGES,
      paper_trade_account_balance: DEFAULT_PAPER_BALANCES,
    },
  }, { lineWidth: -1, noRefs: true });

  return `#!/usr/bin/env bash
set -euo pipefail

HB_DIR=${dirExpr}
HB_IMAGE=${shq(img)}
SUDO=""
if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1; then SUDO="sudo"; fi

echo "==> [1/6] Checking Docker installation..."
if ! command -v docker >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    $SUDO apt-get update -qq
    $SUDO apt-get install -y -qq ca-certificates curl gnupg
    curl -fsSL https://get.docker.com | $SUDO sh
  elif command -v dnf >/dev/null 2>&1; then
    $SUDO dnf install -y docker
  elif command -v yum >/dev/null 2>&1; then
    $SUDO yum install -y docker
  else
    echo "Unsupported package manager — install Docker manually." >&2; exit 1
  fi
  $SUDO systemctl enable --now docker || true
  $SUDO usermod -aG docker "$USER" || true
  echo "Docker installed."
else
  echo "Docker already present: $(docker --version)"
fi

${configureLogRotation ? `echo "==> [2/6] Configuring Docker log rotation (10m x 3 files)..."
if [ ! -f /etc/docker/daemon.json ]; then
  $SUDO mkdir -p /etc/docker
  printf '{\n  "log-driver": "json-file",\n  "log-opts": { "max-size": "10m", "max-file": "3" }\n}\n' | $SUDO tee /etc/docker/daemon.json >/dev/null
  $SUDO systemctl reload docker 2>/dev/null || $SUDO systemctl restart docker 2>/dev/null || true
  echo "Configured /etc/docker/daemon.json."
else
  echo "/etc/docker/daemon.json already exists — leaving untouched."
fi` : 'echo "==> [2/6] Skipping Docker log rotation."'}

${configureSwap ? `echo "==> [3/6] Checking swap safety net..."
RAM_MB=$(free -m | awk '/^Mem:/{print $2}')
SWAP_MB=$(free -m | awk '/^Swap:/{print $2}')
if [ "$RAM_MB" -le 4500 ] && [ "$SWAP_MB" -lt 1024 ] && [ ! -f /swapfile ]; then
  echo "RAM is \${RAM_MB}MB with \${SWAP_MB}MB swap — creating 2GB /swapfile..."
  ($SUDO fallocate -l 2G /swapfile || $SUDO dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none)
  $SUDO chmod 600 /swapfile
  $SUDO mkswap /swapfile >/dev/null
  $SUDO swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | $SUDO tee -a /etc/fstab >/dev/null
  echo "2GB swap enabled."
else
  echo "Swap OK (\${SWAP_MB}MB swap, \${RAM_MB}MB RAM)."
fi` : 'echo "==> [3/6] Skipping swap setup."'}

${configureNtp ? `echo "==> [4/6] Checking NTP clock sync (critical for exchange API auth)..."
if command -v timedatectl >/dev/null 2>&1; then
  $SUDO timedatectl set-ntp true 2>/dev/null || true
  timedatectl status | grep -E "System clock|NTP" || true
elif command -v chronyc >/dev/null 2>&1; then
  chronyc tracking | head -n 4 || true
fi` : 'echo "==> [4/6] Skipping NTP check."'}

echo "==> [5/6] Preparing Hummingbot directories at $HB_DIR..."
mkdir -p "$HB_DIR/conf/strategies" "$HB_DIR/conf/connectors" "$HB_DIR/conf/scripts" "$HB_DIR/logs" "$HB_DIR/data"
chmod -R u+rwX,g+rwX "$HB_DIR" || true

if [ ! -f "$HB_DIR/conf/conf_client.yml" ]; then
  cat <<'EOF_CLIENT' > "$HB_DIR/conf/conf_client.yml"
${defaultClientYaml.trim()}
EOF_CLIENT
  echo "Seeded default paper-trade conf_client.yml (Kraken + Coinbase enabled)."
else
  echo "Existing conf_client.yml preserved."
fi

${pullDockerImage ? `echo "==> [6/6] Pulling Hummingbot image $HB_IMAGE..."
DOCKER_BIN="docker"
docker ps >/dev/null 2>&1 || DOCKER_BIN="$SUDO docker"
$DOCKER_BIN pull "$HB_IMAGE"` : 'echo "==> [6/6] Skipping image pull."'}

echo "==> Hummingbot host bootstrap complete!"
`;
}

function generateComposeFile({ hbDir = './hummingbot', hbImage, configPassword = 'CHANGE_ME' } = {}) {
  const cfg = loadConfig();
  const img = hbImage || cfg.hbImage;
  return `# Docker Compose bundle for Hummingbot + Arb Scanner v3
# Launch locally or on a remote VPS with:  docker compose up -d
services:
  arb-scanner:
    build: .
    container_name: arb_scanner_v3
    restart: unless-stopped
    ports:
      - "127.0.0.1:3001:3001"
    environment:
      - PORT=3001
      - BIND_HOST=0.0.0.0
      - ARB_SERVE_UI=1
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ${hbDir}:/root/hummingbot
      - ./server/config.json:/app/server/config.json
      - ./server/data:/app/server/data

  # Optional base Hummingbot container (managed bots are spawned dynamically by Arb Scanner)
  hummingbot-base:
    image: ${img}
    container_name: hb_base
    profiles: ["base"]
    stdin_open: true
    tty: true
    restart: unless-stopped
    mem_limit: 768m
    cpus: 1.0
    environment:
      - CONFIG_PASSWORD=${configPassword}
    volumes:
      - ${hbDir}/conf:/home/hummingbot/conf
      - ${hbDir}/logs:/home/hummingbot/logs
      - ${hbDir}/data:/home/hummingbot/data
`;
}

function runProvisionJob(target, opts = {}) {
  const cfg = loadConfig();
  const host = getHost(target, cfg);
  if (!host.supportsShell()) {
    throw new Error('Automated shell bootstrap is for Linux/WSL/SSH hosts. On Windows Docker Desktop, ensure Docker Desktop is running and use "Pull Image" + "Seed Paper Config".');
  }
  const script = generateBootstrapScript({
    hbDir: host.hbDir,
    hbImage: opts.hbImage || cfg.hbImage,
    configureSwap: opts.configureSwap !== false,
    configureLogRotation: opts.configureLogRotation !== false,
    configureNtp: opts.configureNtp !== false,
    pullDockerImage: opts.pullDockerImage !== false,
  });
  return startJob('provision', target, async (log) => {
    log(`Running bootstrap script on ${host.name} (${host.hbDir})...`);
    const r = await host.sh(script, { timeout: 600000 });
    if (r.stdout) log(r.stdout.trim());
    if (r.stderr) log(`[stderr]\n${r.stderr.trim()}`);
    if (r.code !== 0) throw new Error(`Bootstrap exited with code ${r.code}`);
    return { exitCode: r.code };
  });
}

function runPullImageJob(target, image) {
  return startJob('pull-image', target, async (log) => {
    const res = await pullImage(target, image);
    if (res.output) log(res.output);
    return res;
  });
}

module.exports = {
  startJob,
  getJob,
  listJobs,
  generateBootstrapScript,
  generateComposeFile,
  runProvisionJob,
  runPullImageJob,
};
