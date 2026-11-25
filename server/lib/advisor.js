// ─── Profitability Projections, Cost-Effectiveness & Server Sizing Advisor ───
const axios = require('axios');
const { EXCHANGES } = require('./exchanges');
const { getHost, shq } = require('./hosts');
const { getHostSpecs, containerStats } = require('./hummingbot');
const { loadConfig } = require('./config');

// Realistic Hummingbot container resource model (Python/Cython spot arb/XEMM):
//   • Base OS + Docker daemon + logs/monitoring: ~750 MB RAM, ~0.25 vCPU
//   • Each running Hummingbot container: ~300 MB steady / ~450 MB peak RAM, ~0.22 vCPU
const BASE_RAM_GB = 0.75;
const RAM_PER_BOT_GB = 0.45;
const BASE_VCPU = 0.25;
const VCPU_PER_BOT = 0.25;

function calcBotCapacity(vcpu, ramGb, swapGb = 0) {
  const effectiveRam = ramGb + Math.min(swapGb * 0.25, 1.0); // swap protects spikes, not steady load
  const byRam = Math.max(0, Math.floor((effectiveRam - BASE_RAM_GB) / RAM_PER_BOT_GB));
  const byCpu = Math.max(0, Math.floor((vcpu - BASE_VCPU) / VCPU_PER_BOT));
  const maxBots = Math.min(byRam, byCpu);
  const recommendedBots = Math.max(maxBots > 0 ? 1 : 0, Math.floor(maxBots * 0.8));
  const bottleneck = byRam <= byCpu ? 'RAM' : 'CPU';
  return { maxBots, recommendedBots, byRam, byCpu, bottleneck };
}

// Curated server tiers (approximate 2026 on-demand USD/month pricing)
const SERVER_CATALOG = [
  {
    id: 'local_pc', provider: 'Local Machine', tier: 'Docker Desktop / WSL2',
    vcpu: 4, ramGb: 8, diskGb: 50, monthlyUsd: 0,
    regions: ['Your Home / Office'],
    bestFor: 'Paper trading, strategy development & zero-cost testing',
    pros: ['Free ($0/mo)', 'Fast iteration & local inspection'],
    cons: ['Higher & jittery home ISP latency (40-150ms)', 'Not 24/7 if PC sleeps/reboots', 'Dynamic residential IP breaks exchange IP whitelists'],
    dedicatedCpu: false,
  },
  {
    id: 'hetzner_cpx11', provider: 'Hetzner Cloud', tier: 'CPX11 (AMD)',
    vcpu: 2, ramGb: 2, diskGb: 40, monthlyUsd: 5.5,
    regions: ['Ashburn VA (us-east)', 'Hillsboro OR (us-west)', 'Falkenstein / Nuremberg (EU)'],
    bestFor: '1-2 live bots on a shoestring budget (with 2 GB swap)',
    pros: ['Best $/perf in Ashburn VA (~2-8ms to Coinbase US-East)', '20 TB included traffic', 'Static IPv4 for exchange API whitelists'],
    cons: ['2 GB RAM tight beyond 2 bots without swap'],
    dedicatedCpu: false,
  },
  {
    id: 'hetzner_cpx21', provider: 'Hetzner Cloud', tier: 'CPX21 (AMD)',
    vcpu: 3, ramGb: 4, diskGb: 80, monthlyUsd: 10.5,
    regions: ['Ashburn VA (us-east)', 'Hillsboro OR (us-west)', 'Falkenstein / Helsinki (EU)', 'Singapore (AP)'],
    bestFor: 'Sweet spot for 4-6 Kraken/Coinbase bots — top cost-effectiveness',
    pros: ['Ashburn VA region sits right next to AWS us-east-1 (Coinbase)', 'Handles 5-6 Hummingbot containers smoothly', '~$1.75/bot/mo'],
    cons: ['Shared vCPU (fine for REST/WS bots, not HFT microsecond colocation)'],
    dedicatedCpu: false,
  },
  {
    id: 'hetzner_cpx31', provider: 'Hetzner Cloud', tier: 'CPX31 (AMD)',
    vcpu: 4, ramGb: 8, diskGb: 160, monthlyUsd: 18.5,
    regions: ['Ashburn VA (us-east)', 'Hillsboro OR (us-west)', 'EU', 'Singapore'],
    bestFor: 'Mid-size fleet (8-12 bots) + hosted Arb Scanner dashboard',
    pros: ['Plenty of RAM headroom for 10+ bots + scanner + logs', 'Very low $/bot (~$1.55/bot/mo)'],
    cons: ['Shared vCPU'],
    dedicatedCpu: false,
  },
  {
    id: 'lightsail_4gb', provider: 'AWS Lightsail', tier: '4 GB Bundle',
    vcpu: 2, ramGb: 4, diskGb: 80, monthlyUsd: 24,
    regions: ['us-east-1 (N. Virginia)', 'us-east-2 (Ohio)', 'eu-central-1 (Frankfurt)', 'ap-northeast-1 (Tokyo)'],
    bestFor: 'Simple flat-rate AWS hosting inside AWS backbone',
    pros: ['Inside AWS network (1-5ms to Coinbase in us-east-1)', 'Predictable flat monthly billing + 4 TB transfer'],
    cons: ['Only 2 vCPU caps safe concurrency at ~5-6 bots'],
    dedicatedCpu: false,
  },
  {
    id: 'ec2_t3_medium', provider: 'AWS EC2', tier: 't3.medium (2 vCPU / 4 GB)',
    vcpu: 2, ramGb: 4, diskGb: 30, monthlyUsd: 33,
    regions: ['us-east-1 (N. Virginia)', 'us-east-2 (Ohio)', 'eu-central-1 (Frankfurt)', 'ap-northeast-1 (Tokyo)'],
    bestFor: 'Existing AWS users running 3-5 bots with Elastic IP & Security Groups',
    pros: ['Ultra-low latency inside AWS us-east-1 to Coinbase & Kraken edges', 'Security Group IP locking + IAM'],
    cons: ['Burstable CPU credits can throttle if overloaded', '~3x pricier than Hetzner CPX21'],
    dedicatedCpu: false,
  },
  {
    id: 'ec2_c7i_large', provider: 'AWS EC2', tier: 'c7i.large (2 Ded. vCPU / 4 GB)',
    vcpu: 2, ramGb: 4, diskGb: 30, monthlyUsd: 68,
    regions: ['us-east-1 (N. Virginia)', 'eu-central-1 (Frankfurt)', 'ap-northeast-1 (Tokyo)'],
    bestFor: 'Latency-sensitive live arb where zero CPU steal matters',
    pros: ['Non-burstable Intel Sapphire Rapids cores', 'Sub-3ms RTT to AWS-hosted exchanges in same region'],
    cons: ['Higher monthly cost — requires >$250/mo gross profit to justify'],
    dedicatedCpu: true,
  },
  {
    id: 'ec2_c7i_xlarge', provider: 'AWS EC2', tier: 'c7i.xlarge (4 Ded. vCPU / 8 GB)',
    vcpu: 4, ramGb: 8, diskGb: 50, monthlyUsd: 132,
    regions: ['us-east-1 (N. Virginia)', 'eu-central-1 (Frankfurt)', 'ap-northeast-1 (Tokyo)'],
    bestFor: 'High-volume production fleet (10-14 bots) with dedicated CPU',
    pros: ['Consistent execution latency under heavy WebSocket load', '12.5 Gbps network'],
    cons: ['Only cost-effective once running $20k+ capital or 8+ profitable pairs'],
    dedicatedCpu: true,
  },
  {
    id: 'do_4gb', provider: 'DigitalOcean', tier: 'Premium AMD 4 GB',
    vcpu: 2, ramGb: 4, diskGb: 80, monthlyUsd: 28,
    regions: ['NYC1 / NYC3 (US-East)', 'FRA1 (Frankfurt)', 'SGP1 (Singapore)'],
    bestFor: 'Easy managed UI with strong NYC/FRA proximity',
    pros: ['Clean UI & snapshots', 'NVMe disks', 'Good NYC <-> us-east-1 connectivity'],
    cons: ['More expensive per vCPU than Hetzner'],
    dedicatedCpu: false,
  },
  {
    id: 'vultr_hf_4gb', provider: 'Vultr', tier: 'High Frequency 4 GB',
    vcpu: 2, ramGb: 4, diskGb: 128, monthlyUsd: 24,
    regions: ['New Jersey (EWR)', 'Frankfurt', 'Tokyo', 'Singapore'],
    bestFor: 'Fast single-thread clock speed near NYC/NJ & Tokyo',
    pros: ['3+ GHz high-frequency cores help Python single-thread loop', 'Tokyo & NJ locations available'],
    cons: ['2 vCPU caps fleet at ~5-6 bots'],
    dedicatedCpu: false,
  },
];

// Exchange-pair optimal datacenter regions
const REGION_GUIDANCE = {
  kraken_coinbase: {
    primaryRegion: 'US-East (Ashburn VA / AWS us-east-1)',
    backupRegion: 'US-East (New Jersey / NYC) or AWS us-east-2 (Ohio)',
    why: 'Coinbase Advanced Trade matching runs in AWS us-east-1 (N. Virginia); Kraken US API edges peer directly in Ashburn/Equinix DC. Deploying in us-east-1 / Ashburn cuts round-trip time from ~50-120ms (home) down to ~2-12ms.',
    expectedRttMs: '2–12 ms',
  },
  binance_kraken: {
    primaryRegion: 'EU-Central (Frankfurt / AWS eu-central-1) or Tokyo (ap-northeast-1)',
    backupRegion: 'Ireland (eu-west-1) / London',
    why: 'Binance global API runs in AWS ap-northeast-1 (Tokyo) with EU edge routing; Kraken matching has primary infrastructure in London/Frankfurt & US-East. Note: US IPs are geo-blocked by Binance.com (use EU/AP VPS or Binance.US).',
    expectedRttMs: '10–45 ms',
  },
  bybit_kraken: {
    primaryRegion: 'Singapore (ap-southeast-1) or Frankfurt (eu-central-1)',
    backupRegion: 'London / Tokyo',
    why: 'Bybit matching runs in Singapore (AWS ap-southeast-1) and is geo-restricted from US IPs; Frankfurt splits the distance cleanly to Kraken.',
    expectedRttMs: '15–60 ms',
  },
  okx_coinbase: {
    primaryRegion: 'US-East (us-east-1) or EU-West (London/Ireland)',
    backupRegion: 'Frankfurt',
    why: 'Coinbase runs in AWS us-east-1 while OKX runs in Hong Kong/Singapore with global edge pops. Verify regional regulatory availability before funding.',
    expectedRttMs: '20–90 ms',
  },
};

function recommendServers({ targetBots = 4, pairId = 'kraken_coinbase', expectedMonthlyGross = 150, prioritizeLatency = false } = {}) {
  const bots = Math.max(1, parseInt(targetBots, 10) || 4);
  const guidance = REGION_GUIDANCE[pairId] || REGION_GUIDANCE.kraken_coinbase;

  const catalog = SERVER_CATALOG.map(s => {
    const cap = calcBotCapacity(s.vcpu, s.ramGb, s.ramGb <= 2 ? 2 : 0);
    const fits = cap.recommendedBots >= bots;
    const fitsMax = cap.maxBots >= bots;
    const costPerBot = s.monthlyUsd > 0 && cap.recommendedBots > 0 ? s.monthlyUsd / cap.recommendedBots : 0;
    const costPctOfGross = expectedMonthlyGross > 0 ? (s.monthlyUsd / expectedMonthlyGross) * 100 : null;

    let score = 100;
    if (!fitsMax) score -= 60;
    else if (!fits) score -= 20;
    if (s.id === 'local_pc') score -= 15; // fine for testing, not prod 24/7
    if (prioritizeLatency && s.dedicatedCpu) score += 18;
    if (prioritizeLatency && s.provider.startsWith('AWS')) score += 10;
    score -= Math.min(40, s.monthlyUsd * 0.45);
    if (costPctOfGross !== null && costPctOfGross > 25) score -= 20;

    return {
      ...s,
      ...cap,
      fits,
      fitsMax,
      costPerBot: Number(costPerBot.toFixed(2)),
      costPctOfGross: costPctOfGross !== null ? Number(costPctOfGross.toFixed(1)) : null,
      suitabilityScore: Math.round(score),
    };
  }).sort((a, b) => b.suitabilityScore - a.suitabilityScore);

  const topRemote = catalog.find(s => s.id !== 'local_pc' && s.fits) || catalog.find(s => s.id !== 'local_pc' && s.fitsMax) || catalog[0];

  const checklist = [
    { item: 'Operating System', value: 'Ubuntu 24.04 LTS or Amazon Linux 2023 (64-bit x86_64 — matches official Hummingbot Docker image without emulation)' },
    { item: 'Docker Log Rotation', value: 'Set `max-size: "10m"`, `max-file: "3"` in `/etc/docker/daemon.json` so verbose bot logs never exhaust disk.' },
    { item: 'Swap Safety Net', value: 'Configure a 2 GB–4 GB swap file on servers with ≤4 GB RAM to prevent OOM kills during multi-bot startup spikes.' },
    { item: 'NTP Time Sync (Critical)', value: 'Run `chrony` or `systemd-timesyncd`. Kraken & Coinbase reject API signatures if clock drift exceeds ~2–5 seconds.' },
    { item: 'Per-Bot Resource Caps', value: 'Launch each container with `--memory 768m --cpus 1.0 --restart unless-stopped` so one runaway bot cannot starve peers.' },
    { item: 'Network & Security', value: 'Static IPv4 whitelisted on Kraken & Coinbase API keys (withdrawals DISABLED), SSH key-only auth, UFW blocking all ports except 22 (or Tailscale/VPN).' },
    { item: 'Resource Budget Rule', value: `Budget ~${RAM_PER_BOT_GB * 1000} MB RAM + ${VCPU_PER_BOT} vCPU per bot, plus ${BASE_RAM_GB * 1000} MB RAM for OS + Docker. Target ≤80% max utilization.` },
  ];

  return {
    targetBots: bots,
    pairId,
    regionGuidance: guidance,
    recommended: topRemote,
    catalog,
    checklist,
    sizingFormula: {
      baseRamGb: BASE_RAM_GB,
      ramPerBotGb: RAM_PER_BOT_GB,
      baseVcpu: BASE_VCPU,
      vcpuPerBot: VCPU_PER_BOT,
    },
  };
}

// ─── Profitability & Cost-Effectiveness Projection Model ─────────────────────
function projectProfitability({
  capital = 5000,
  tradeSize = 500,
  botsCount = 3,
  tradesPerDayPerBot = 8,
  avgGrossSpreadPct = 0.85,
  feeBuyPct = 0.25,     // e.g. Kraken maker 0.25% or taker 0.40%
  feeSellPct = 0.60,    // e.g. Coinbase maker 0.60% or taker 1.20%
  slippageBps = 8,      // total round-trip slippage in bps (both legs combined)
  captureRatePct = 70,  // % of detected opportunities that survive latency & fill
  serverMonthlyUsd = 10.5,
  rebalanceMonthlyUsd = 5,
  strategyMode = 'xemm', // 'xemm' | 'amm_arb'
} = {}) {
  const cap = Math.max(100, Number(capital) || 5000);
  const sz = Math.max(10, Number(tradeSize) || 500);
  const bots = Math.max(1, Number(botsCount) || 1);
  const tpdBot = Math.max(0, Number(tradesPerDayPerBot) || 0);
  const grossPct = Number(avgGrossSpreadPct) || 0;
  const feeTotalPct = (Number(feeBuyPct) || 0) + (Number(feeSellPct) || 0);
  const slipPct = (Number(slippageBps) || 0) / 100; // bps -> %
  const capture = Math.max(0, Math.min(100, Number(captureRatePct) || 0)) / 100;
  const fixedMonthly = (Number(serverMonthlyUsd) || 0) + (Number(rebalanceMonthlyUsd) || 0);

  const runScenario = (captureMult, spreadMult, label) => {
    const effGrossPct = grossPct * spreadMult;
    const effTradesDay = bots * tpdBot * Math.min(1, capture * captureMult);
    const netPctPerTrade = effGrossPct - feeTotalPct - slipPct;
    const grossDollarTrade = sz * (effGrossPct / 100);
    const feeDollarTrade = sz * (feeTotalPct / 100);
    const slipDollarTrade = sz * (slipPct / 100);
    const netDollarTrade = grossDollarTrade - feeDollarTrade - slipDollarTrade;

    const dailyNetBeforeServer = netDollarTrade * effTradesDay;
    const monthlyNetBeforeServer = dailyNetBeforeServer * 30;
    const monthlyNetAfterServer = monthlyNetBeforeServer - fixedMonthly;
    const annualNetAfterServer = monthlyNetAfterServer * 12;
    const monthlyVolume = sz * 2 * effTradesDay * 30;
    const monthlyFees = feeDollarTrade * effTradesDay * 30;
    const monthlyRoiPct = (monthlyNetAfterServer / cap) * 100;
    const annualRoiPct = monthlyRoiPct * 12;
    const serverCostPct = monthlyNetBeforeServer > 0 ? (fixedMonthly / monthlyNetBeforeServer) * 100 : null;
    const breakevenTradesPerDay = netDollarTrade > 0 ? (fixedMonthly / 30) / netDollarTrade : null;

    return {
      label,
      effTradesDay: Number(effTradesDay.toFixed(1)),
      effGrossPct: Number(effGrossPct.toFixed(4)),
      netPctPerTrade: Number(netPctPerTrade.toFixed(4)),
      grossDollarTrade: Number(grossDollarTrade.toFixed(2)),
      feeDollarTrade: Number(feeDollarTrade.toFixed(2)),
      slipDollarTrade: Number(slipDollarTrade.toFixed(2)),
      netDollarTrade: Number(netDollarTrade.toFixed(2)),
      dailyNet: Number((dailyNetBeforeServer - fixedMonthly / 30).toFixed(2)),
      weeklyNet: Number((dailyNetBeforeServer * 7 - (fixedMonthly / 30) * 7).toFixed(2)),
      monthlyBeforeServer: Number(monthlyNetBeforeServer.toFixed(2)),
      monthlyNet: Number(monthlyNetAfterServer.toFixed(2)),
      annualNet: Number(annualNetAfterServer.toFixed(2)),
      monthlyVolume: Math.round(monthlyVolume),
      monthlyFees: Number(monthlyFees.toFixed(2)),
      monthlyRoiPct: Number(monthlyRoiPct.toFixed(2)),
      annualRoiPct: Number(annualRoiPct.toFixed(1)),
      serverCostPct: serverCostPct !== null ? Number(serverCostPct.toFixed(1)) : null,
      breakevenTradesPerDay: breakevenTradesPerDay !== null ? Number(breakevenTradesPerDay.toFixed(1)) : null,
      costEffective: monthlyNetAfterServer > 0 && (serverCostPct === null || serverCostPct < 25),
    };
  };

  const base = runScenario(1.0, 1.0, 'Base Case');
  const conservative = runScenario(0.55, 0.85, 'Conservative');
  const optimistic = runScenario(1.2, 1.15, 'Optimistic');

  // Fee-tier comparison for Kraken × Coinbase so user sees why fee tiers dominate P&L
  const feeTierComparison = [
    { name: 'Intro Taker+Taker (Kraken 0.40% + CB 1.20%)', feePct: 1.60 },
    { name: 'XEMM Intro Maker+Taker (Kraken 0.25% + CB 0.60%)', feePct: 0.85 },
    { name: 'Mid Volume Tier ($50k+/mo: 0.16% + 0.25%)', feePct: 0.41 },
    { name: 'Active Tier ($100k+/mo: 0.12% + 0.15%)', feePct: 0.27 },
    { name: 'VIP / Binance+Kraken Maker (0.10% + 0.14%)', feePct: 0.24 },
  ].map(t => {
    const netPct = grossPct - t.feePct - slipPct;
    const effTrades = bots * tpdBot * capture;
    const monthlyNet = (sz * (netPct / 100) * effTrades * 30) - fixedMonthly;
    return {
      ...t,
      breakevenSpreadPct: Number((t.feePct + slipPct).toFixed(3)),
      netPctPerTrade: Number(netPct.toFixed(3)),
      monthlyNet: Number(monthlyNet.toFixed(2)),
      profitable: monthlyNet > 0,
    };
  });

  // Capital adequacy check (need ~2x tradeSize per concurrent bot to hold both base & quote on both venues)
  const recommendedCapital = sz * bots * 2.5;
  const warnings = [];
  if (grossPct <= feeTotalPct + slipPct) {
    warnings.push(`Break-even spread is ${(feeTotalPct + slipPct).toFixed(3)}% (fees ${feeTotalPct.toFixed(2)}% + slippage ${slipPct.toFixed(2)}%). At ${grossPct.toFixed(2)}% gross spread, each trade loses money — use XEMM maker fees, higher volume tiers, or wider-spread altcoins.`);
  }
  if (cap < recommendedCapital) {
    warnings.push(`Running ${bots} bots at $${sz} order size ideally needs ~$${recommendedCapital.toLocaleString()} total capital (quote + base inventory across both exchanges) to avoid constant rebalancing.`);
  }
  if (base.serverCostPct !== null && base.serverCostPct > 20) {
    warnings.push(`Server & rebalance costs ($${fixedMonthly}/mo) consume ${base.serverCostPct}% of pre-server profit. Consider a lower-cost VPS (e.g., Hetzner CPX21 at $10.50/mo) until volume scales.`);
  }

  return {
    inputs: { capital: cap, tradeSize: sz, botsCount: bots, tradesPerDayPerBot: tpdBot, avgGrossSpreadPct: grossPct, feeBuyPct, feeSellPct, slippageBps, captureRatePct, serverMonthlyUsd, rebalanceMonthlyUsd, strategyMode },
    breakevenSpreadPct: Number((feeTotalPct + slipPct).toFixed(4)),
    recommendedCapital,
    scenarios: { conservative, base, optimistic },
    feeTierComparison,
    warnings,
  };
}

// ─── Live Host Capacity & Measured Exchange Latency ──────────────────────────
async function inspectHostCapacity(target = 'local') {
  const host = getHost(target);
  const [specs, stats] = await Promise.all([
    getHostSpecs(host).catch(() => null),
    containerStats(target).catch(() => ({})),
  ]);
  if (!specs) return { target, available: false, error: 'Unable to read host specs' };

  const ramGb = specs.ramTotalMb / 1024;
  const swapGb = (specs.swapTotalMb || 0) / 1024;
  const cap = calcBotCapacity(specs.vcpu, ramGb, swapGb);
  const statList = Object.values(stats);
  const runningBots = statList.length;
  const botsRamMb = statList.reduce((s, x) => s + (x.memUsedMb || 0), 0);
  const botsCpuPct = statList.reduce((s, x) => s + (x.cpuPct || 0), 0);
  const avgRamPerBotMb = runningBots > 0 ? Math.round(botsRamMb / runningBots) : Math.round(RAM_PER_BOT_GB * 1024);
  const freeRamMb = Math.max(0, (specs.ramAvailMb || 0) - 512);
  const remainingByLiveRam = Math.floor(freeRamMb / Math.max(300, avgRamPerBotMb));

  return {
    target,
    available: true,
    specs: { ...specs, ramGb: Number(ramGb.toFixed(1)), swapGb: Number(swapGb.toFixed(1)) },
    capacity: {
      ...cap,
      runningBots,
      botsRamMb,
      botsCpuPct: Number(botsCpuPct.toFixed(1)),
      avgRamPerBotMb,
      remainingSafeSlots: Math.max(0, Math.min(cap.recommendedBots - runningBots, remainingByLiveRam)),
    },
  };
}

async function measureExchangeLatency(target = 'local', exchanges = ['kraken', 'coinbase', 'binance', 'bybit', 'okx', 'kucoin']) {
  const cfg = loadConfig();
  const host = getHost(target, cfg);
  const list = exchanges.filter(e => EXCHANGES[e]);

  // Run directly from backend process for local native Windows/Linux, or over SSH/WSL for remote hosts
  if (target === 'local' && !host.supportsShell()) {
    const results = {};
    await Promise.all(list.map(async ex => {
      const url = EXCHANGES[ex].timeUrl;
      const samples = [];
      let err = null;
      for (let i = 0; i < 3; i++) {
        const t0 = Date.now();
        try {
          await axios.get(url, { timeout: 5000 });
          samples.push(Date.now() - t0);
        } catch (e) {
          err = e.response ? `HTTP ${e.response.status}` : e.message;
          break;
        }
      }
      results[ex] = samples.length
        ? { ok: true, minMs: Math.min(...samples), avgMs: Math.round(samples.reduce((a, b) => a + b, 0) / samples.length), samples }
        : { ok: false, error: err };
    }));
    return { target, measuredFrom: host.name, results, timestamp: Date.now() };
  }

  // POSIX/SSH: run curl directly FROM the target host so we measure that server's real proximity!
  const lines = list.map(ex => {
    const url = EXCHANGES[ex].timeUrl;
    return `r=$(curl -o /dev/null -s -m 5 -w "%{http_code} %{time_starttransfer}" ${shq(url)} 2>/dev/null || echo "000 0"); printf '%s %s\\n' ${shq(ex)} "$r"`;
  }).join('\n');
  const script = `for i in 1 2; do\n${lines}\ndone`;
  const res = await host.sh(script, { timeout: 30000 });
  const raw = {};
  for (const line of res.stdout.split('\n').filter(Boolean)) {
    const [ex, codeStr, secStr] = line.trim().split(/\s+/);
    const code = parseInt(codeStr, 10);
    const ms = Math.round((parseFloat(secStr) || 0) * 1000);
    if (!raw[ex]) raw[ex] = { codes: [], samples: [] };
    raw[ex].codes.push(code);
    if (code >= 200 && code < 400 && ms > 0) raw[ex].samples.push(ms);
  }
  const results = {};
  for (const ex of list) {
    const d = raw[ex] || { codes: [], samples: [] };
    if (d.samples.length) {
      results[ex] = {
        ok: true,
        minMs: Math.min(...d.samples),
        avgMs: Math.round(d.samples.reduce((a, b) => a + b, 0) / d.samples.length),
        samples: d.samples,
      };
    } else {
      const code = d.codes[0];
      results[ex] = { ok: false, error: code ? `HTTP ${code}` : 'unreachable' };
    }
  }
  return { target, measuredFrom: host.name, results, timestamp: Date.now() };
}

module.exports = {
  calcBotCapacity,
  recommendServers,
  projectProfitability,
  inspectHostCapacity,
  measureExchangeLatency,
  SERVER_CATALOG,
  REGION_GUIDANCE,
};
