// ─── Backend Unit & Integration Tests (zero external network required) ───────
// Isolate tests from your real config, alert history, audit log and push channels
const fs = require('fs');
const os = require('os');
const path = require('path');
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'arb-scanner-test-'));
process.env.ARB_CONFIG = path.join(TEST_DIR, 'config.json');
process.env.ARB_DATA_DIR = path.join(TEST_DIR, 'data');
process.on('exit', () => { try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch (_) {} });

const assert = require('assert');
const { evaluate } = require('../lib/scanner');
const { vwapFill } = require('../lib/exchanges');
const { generateStrategyYaml, parseStrategyYaml, formatBaseAmount } = require('../lib/strategies');
const { safeRel, safeName, shq } = require('../lib/hosts');
const { validateServer, DEFAULT_FEES } = require('../lib/config');
const { calcBotCapacity, recommendServers, projectProfitability, estimateServerCost } = require('../lib/advisor');
const guard = require('../lib/guard');
const tickers = require('../lib/tickers');
const tickerAudit = require('../lib/tickerAudit');
const { readKillSwitch } = require('../lib/hummingbot');
const { generateBootstrapScript, generateComposeFile } = require('../lib/provision');
const { app } = require('../index');

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (e) {
    console.error(`  [FAIL] ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

const { EventEmitter } = require('events');

// Invoke Express app in-process (works even in socket-restricted sandboxes)
function invokeApp(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter();
    req.method = method;
    req.url = urlPath;
    req.headers = { 'content-type': 'application/json' };
    req.connection = {};
    req.socket = {};
    req.body = body || {};
    req._body = body !== undefined;

    const headers = {};
    let statusCode = 200;
    let raw = '';
    const res = new EventEmitter();
    res.statusCode = 200;
    res.setHeader = (k, v) => { headers[k.toLowerCase()] = v; };
    res.getHeader = (k) => headers[k.toLowerCase()];
    res.removeHeader = (k) => { delete headers[k.toLowerCase()]; };
    res.writeHead = (s) => { statusCode = s; res.statusCode = s; };
    res.write = (chunk) => { raw += chunk; };
    res.end = (chunk) => {
      if (chunk) raw += chunk;
      statusCode = res.statusCode;
      let parsed = {};
      try { parsed = raw ? JSON.parse(raw) : {}; } catch (_) { parsed = { raw }; }
      resolve({ status: statusCode, body: parsed });
    };

    app.handle(req, res, (err) => {
      if (err) reject(err);
      else resolve({ status: 404, body: {} });
    });
  });
}

(async () => {
  console.log('\nRunning Arb Scanner v3 Backend Test Suite...\n');

  await test('hosts: safeRel blocks traversal and absolute paths', () => {
    assert.strictEqual(safeRel('conf/strategies/test.yml'), 'conf/strategies/test.yml');
    assert.throws(() => safeRel('../etc/passwd'));
    assert.throws(() => safeRel('/etc/passwd'));
    assert.throws(() => safeRel('C:\\Windows\\System32'));
  });

  await test('hosts: safeName blocks shell metacharacters', () => {
    assert.strictEqual(safeName('arb_sol_123'), 'arb_sol_123');
    assert.throws(() => safeName('arb; rm -rf /'));
    assert.throws(() => safeName('$(whoami)'));
    assert.strictEqual(shq("a'b"), "'a'\\''b'");
  });

  await test('config: validateServer catches invalid IDs and shell chars', () => {
    assert.strictEqual(validateServer({ id: 'hetzner1', host: '1.2.3.4', username: 'ubuntu', hbDir: '~/hummingbot' }).length, 0);
    assert.ok(validateServer({ id: 'local', host: '1.2.3.4', username: 'ubuntu' }).length > 0);
    assert.ok(validateServer({ id: 'bad id', host: '1.2.3.4;rm', username: 'root' }).length > 0);
  });

  await test('strategies: amm_arb generates base-asset order_amount & percentage min_profitability', () => {
    const yml = generateStrategyYaml({
      strategy: 'amm_arb', symbol: 'BTC', quote: 'USD',
      exA: 'kraken', exB: 'coinbase', tradeSizeUsd: 1000, refPrice: 100000,
      minProfitabilityPct: 0.45, paperTrade: true,
    });
    const parsed = parseStrategyYaml(yml);
    assert.strictEqual(parsed.valid, true);
    assert.strictEqual(parsed.strategy, 'amm_arb');
    assert.strictEqual(parsed.paper, true);
    assert.strictEqual(parsed.orderAmount, 0.01); // $1000 / $100,000 = 0.01 BTC (NOT 1000 BTC!)
    assert.strictEqual(parsed.minProfitability, 0.45); // 0.45% (NOT 0.0045!)
    assert.ok(parsed.connectors.includes('coinbase_advanced_trade_paper_trade'));
    assert.ok(parsed.connectors.includes('kraken_paper_trade'));
    assert.ok(!/^  strategy:/m.test(yml), 'YAML top-level keys must not be indented');
  });

  await test('strategies: XEMM generates valid Pydantic config with active_order_refresh', () => {
    const yml = generateStrategyYaml({
      strategy: 'cross_exchange_market_making', symbol: 'SOL', quote: 'USD',
      makerEx: 'kraken', takerEx: 'coinbase', tradeSizeUsd: 500, refPrice: 100,
      minProfitabilityPct: 0.6, paperTrade: false,
    });
    const parsed = parseStrategyYaml(yml);
    assert.strictEqual(parsed.valid, true);
    assert.strictEqual(parsed.strategy, 'cross_exchange_market_making');
    assert.strictEqual(parsed.paper, false);
    assert.strictEqual(parsed.orderAmount, 5);
    assert.strictEqual(formatBaseAmount(500, 100), 5);
  });

  await test('scanner: evaluate uses executable Ask->Bid prices (not misleading mid-price)', () => {
    // Mid prices differ by 1%, but wide bid/ask spreads eliminate executable profit!
    const qa = { bid: 99.0, ask: 100.5, last: 99.75, book: true, volQuote: 2e6 };
    const qb = { bid: 100.2, ask: 101.5, last: 100.85, book: true, volQuote: 2e6 };
    const r = evaluate('SOL', qa, qb, 'kraken', 'coinbase', DEFAULT_FEES, 1000, 5);
    assert.strictEqual(r.buyOn, 'kraken');
    assert.strictEqual(r.sellOn, 'coinbase');
    assert.strictEqual(r.buyPrice, 100.5); // Buy at Ask
    assert.strictEqual(r.sellPrice, 100.2); // Sell at Bid -> negative exec spread!
    assert.ok(r.spread < 0);
    assert.strictEqual(r.isViable, false);

    // Clearly profitable executable ask->bid
    const qa2 = { bid: 99.5, ask: 100.0, book: true, volQuote: 5e6 };
    const qb2 = { bid: 103.0, ask: 103.5, book: true, volQuote: 5e6 };
    const r2 = evaluate('SOL', qa2, qb2, 'kraken', 'coinbase', DEFAULT_FEES, 1000, 5);
    assert.strictEqual(r2.isViable, true);
    assert.ok(r2.netDollar > 10);
  });

  await test('exchanges: vwapFill computes multi-level VWAP & partial fill detection', () => {
    const asks = [[100, 2], [101, 3], [105, 5]];
    const full = vwapFill(asks, 5);
    assert.strictEqual(full.complete, true);
    assert.strictEqual(full.levelsUsed, 2);
    assert.ok(Math.abs(full.avgPrice - (200 + 303) / 5) < 1e-9);

    const partial = vwapFill(asks, 15);
    assert.strictEqual(partial.complete, false);
    assert.strictEqual(partial.filled, 10);
  });

  await test('advisor: bot capacity sizing & server recommendations', () => {
    const cap2 = calcBotCapacity(2, 2, 2);
    const cap4 = calcBotCapacity(4, 8, 0);
    assert.ok(cap2.maxBots >= 2 && cap2.maxBots <= 4);
    assert.ok(cap4.recommendedBots >= 10);

    const rec = recommendServers({ targetBots: 4, pairId: 'kraken_coinbase', expectedMonthlyGross: 200 });
    assert.ok(rec.recommended && rec.recommended.fits);
    assert.ok(rec.regionGuidance.primaryRegion.includes('US-East'));
    assert.ok(rec.checklist.length >= 5);
  });

  await test('advisor: profitability projections & fee tier comparison', () => {
    const p = projectProfitability({
      capital: 5000, tradeSize: 500, botsCount: 3, tradesPerDayPerBot: 10,
      avgGrossSpreadPct: 1.2, feeBuyPct: 0.25, feeSellPct: 0.60, slippageBps: 5,
      captureRatePct: 75, serverMonthlyUsd: 10.5, rebalanceMonthlyUsd: 5,
    });
    assert.ok(p.scenarios.base.monthlyNet > 0);
    assert.ok(p.scenarios.optimistic.monthlyNet > p.scenarios.base.monthlyNet);
    assert.ok(p.scenarios.conservative.monthlyNet < p.scenarios.base.monthlyNet);
    assert.strictEqual(p.feeTierComparison.length, 5);
  });

  await test('provision: bootstrap script & compose template generation', () => {
    const sh = generateBootstrapScript({ hbDir: '~/hummingbot' });
    assert.ok(sh.includes('conf_client.yml') && sh.includes('coinbase_advanced_trade') && sh.includes('daemon.json'));
    const yml = generateComposeFile({});
    assert.ok(yml.includes('arb-scanner:') && yml.includes('hummingbot-base:'));
  });

  await test('Express API routing: /api/health, /api/config, /api/strategy/preview, /api/advisor/*, /api/paper-sim/state', async () => {
    const h = await invokeApp('GET', '/api/health');
    assert.strictEqual(h.status, 200);
    assert.strictEqual(h.body.ok, true);

    const cfg = await invokeApp('GET', '/api/config');
    assert.strictEqual(cfg.status, 200);
    assert.strictEqual(cfg.body.hbPassword, undefined, 'Password must never leak in GET /api/config');

    const prev = await invokeApp('POST', '/api/strategy/preview', {
      strategy: 'amm_arb', symbol: 'ETH', quote: 'USD', exA: 'kraken', exB: 'coinbase', tradeSizeUsd: 1000, refPrice: 2500, minProfitabilityPct: 0.5, paperTrade: true,
    });
    assert.strictEqual(prev.status, 200);
    assert.strictEqual(prev.body.parsed.orderAmount, 0.4);

    const rec = await invokeApp('GET', '/api/advisor/servers?bots=5&pair=kraken_coinbase');
    assert.strictEqual(rec.status, 200);
    assert.ok(rec.body.catalog.length >= 8);

    const proj = await invokeApp('POST', '/api/advisor/projections', { capital: 5000, tradeSize: 500, avgGrossSpreadPct: 1.1 });
    assert.strictEqual(proj.status, 200);
    assert.ok(proj.body.scenarios.base);

    const sim = await invokeApp('GET', '/api/paper-sim/state');
    assert.strictEqual(sim.status, 200);
    assert.ok('active' in sim.body);

    const boot = await invokeApp('GET', '/api/provision/script');
    assert.strictEqual(boot.status, 200);
    assert.ok(boot.body.script.includes('conf_client.yml'));

    const alSt = await invokeApp('GET', '/api/alerts/status');
    assert.strictEqual(alSt.status, 200);
    assert.ok('enabled' in alSt.body.status);
    assert.strictEqual(alSt.body.settings.telegramBotToken, '', 'Telegram token must be masked');

    const alList = await invokeApp('GET', '/api/alerts');
    assert.strictEqual(alList.status, 200);
    assert.ok(Array.isArray(alList.body.alerts));

    const testAl = await invokeApp('POST', '/api/alerts/test');
    assert.strictEqual(testAl.status, 200);
    assert.strictEqual(testAl.body.alert.isTest, true);

    const pairInfo = await invokeApp('GET', '/api/mobile/pairing');
    assert.strictEqual(pairInfo.status, 200);
    assert.ok(pairInfo.body.recommendedUrl.includes(':3001'));
  });

  // ─── Pre-deploy cross-check, profitability gate & guard rails ──────────────
  const mkBook = (mid, spread, levels = 20, size = 0.5) => ({
    bids: Array.from({ length: levels }, (_, i) => [mid * (1 - spread / 2 - i * 0.0002), size]),
    asks: Array.from({ length: levels }, (_, i) => [mid * (1 + spread / 2 + i * 0.0002), size]),
  });
  const venue = (mid, opts = {}) => ({
    ticker: { bid: mid * 0.9997, ask: mid * 1.0003, book: true },
    book: mkBook(mid, 0.0006, opts.levels, opts.size),
  });
  const baseCheck = {
    symbol: 'SOL', quote: 'USD', exA: 'kraken', exB: 'coinbase', fees: DEFAULT_FEES, tradeSize: 500,
    references: [{ ex: 'binanceus', label: 'Binance.US', mid: 151.8 }, { ex: 'okx', label: 'OKX', mid: 151.7 }],
    server: { allocatedMonthlyUsd: 11.5, source: 'estimate' },
    stats: { observedHours: 5, coin: { coin: 'SOL', episodes: 30, episodesPerHour: 6, avgNetViable: 0.4 } },
  };

  await test('advisor: estimated avg server cost follows Server Suggestions and prices fleets', () => {
    const one = estimateServerCost({ bots: 1 });
    assert.strictEqual(one.basis.length, 3);
    assert.ok(one.avgMonthlyUsd > 0 && one.avgMonthlyUsd < 30, `1 bot avg ${one.avgMonthlyUsd}`);
    assert.ok(!one.basis.some(b => /c7i/.test(b.id)), 'dedicated-CPU tiers excluded unless latency prioritised');
    const many = estimateServerCost({ bots: 20 });
    assert.ok(many.avgMonthlyUsd > one.avgMonthlyUsd, 'a 20-bot fleet must cost more than 1 bot');
    assert.ok(many.basis.some(b => /×/.test(b.name)), 'fleet of several servers when none fits alone');
    const p = projectProfitability({ botsCount: 1 });
    assert.strictEqual(p.serverCost.source, 'estimate');
    assert.strictEqual(p.serverCost.monthlyUsd, one.avgMonthlyUsd);
    const manual = projectProfitability({ botsCount: 1, serverMonthlyUsd: 0 });
    assert.strictEqual(manual.serverCost.source, 'input');
    assert.strictEqual(manual.serverCost.monthlyUsd, 0);
  });

  await test('advisor: projections report transaction costs and both profitability checks', () => {
    const good = projectProfitability({ tradeSize: 1000, avgGrossSpreadPct: 2.5, feeBuyPct: 0.25, feeSellPct: 0.6, tradesPerDayPerBot: 10, botsCount: 1 });
    assert.ok(good.profitabilityChecks.profitableBoth);
    const s = good.scenarios.base;
    assert.ok(Math.abs(s.monthlyTransactionCosts - (s.monthlyFees + s.monthlySlippage + 5)) < 0.05);
    const thin = projectProfitability({ tradeSize: 100, avgGrossSpreadPct: 0.9, feeBuyPct: 0.25, feeSellPct: 0.6, slippageBps: 0, tradesPerDayPerBot: 1, captureRatePct: 50, botsCount: 1 });
    assert.ok(thin.profitabilityChecks.perTrade.pass, 'per-trade positive');
    assert.ok(!thin.profitabilityChecks.monthly.pass, 'but server + rebalance costs make the month negative');
    assert.ok(!thin.profitabilityChecks.profitableBoth);
  });

  await test('guard: real cross-venue gap passes both calculations', () => {
    const r = guard.evaluateCrossCheck({ ...baseCheck, venues: { kraken: venue(150), coinbase: venue(153.5) } });
    assert.ok(r.dataOk, JSON.stringify(r.checks.filter(c => c.status === 'fail')));
    assert.ok(r.perTrade.pass && r.perTrade.netDollar > 0);
    assert.strictEqual(r.perTrade.buyOn, 'kraken');
    // net = gross - fees - slippage, to the cent
    assert.ok(Math.abs(r.perTrade.grossDollar - r.perTrade.feeDollar - r.perTrade.slippageDollar - r.perTrade.netDollar) < 1e-3);
    assert.ok(r.monthly.pass && r.monthly.source === 'observed');
    assert.strictEqual(r.monthly.serverMonthly, 11.5);
    assert.ok(Math.abs(r.monthly.monthlyNet - (r.monthly.tradingNetMonthly - r.monthly.rebalanceMonthly - r.monthly.serverMonthly)) < 0.02);
    assert.ok(r.allowed);
  });

  await test('guard: ordinary market (spread below fees) is blocked per trade', () => {
    const r = guard.evaluateCrossCheck({ ...baseCheck, references: [{ ex: 'okx', label: 'OKX', mid: 150 }], venues: { kraken: venue(150), coinbase: venue(150.1) } });
    assert.ok(r.dataOk);
    assert.ok(!r.perTrade.pass && r.perTrade.netDollar < 0);
    assert.ok(!r.allowed);
    assert.ok(r.blockers.some(b => b.startsWith('Per-trade')));
  });

  await test('guard: same ticker for two different tokens fails the price cross-reference', () => {
    const r = guard.evaluateCrossCheck({ ...baseCheck, references: [{ ex: 'okx', label: 'OKX', mid: 150 }], venues: { kraken: venue(150), coinbase: venue(300) } });
    assert.ok(!r.dataOk && !r.allowed);
    const failed = r.checks.filter(c => c.status === 'fail').map(c => c.id);
    assert.ok(failed.includes('reference') && failed.includes('plausible_gap'), failed.join(','));
  });

  await test('guard: stale scanner price, thin book and missing book all fail', () => {
    const stale = guard.evaluateCrossCheck({ ...baseCheck, venues: { kraken: { ...venue(150), ticker: { bid: 146, ask: 146.1, book: true } }, coinbase: venue(153.5) } });
    assert.strictEqual(stale.checks.find(c => c.id === 'ticker_vs_book').status, 'fail');
    const thin = guard.evaluateCrossCheck({ ...baseCheck, tradeSize: 50000, venues: { kraken: venue(150, { levels: 3, size: 0.1 }), coinbase: venue(153.5, { levels: 3, size: 0.1 }) } });
    assert.strictEqual(thin.checks.find(c => c.id === 'depth').status, 'fail');
    assert.ok(!thin.perTrade.pass);
    const missing = guard.evaluateCrossCheck({ ...baseCheck, venues: { kraken: venue(150), coinbase: { ticker: null, book: null, bookError: 'HTTP 503' } } });
    assert.strictEqual(missing.checks.find(c => c.id === 'books').status, 'fail');
    assert.ok(!missing.allowed);
  });

  await test('guard: profitable per trade but not per month after server + rebalancing is blocked', () => {
    const r = guard.evaluateCrossCheck({
      ...baseCheck,
      stats: { observedHours: 10, coin: { coin: 'SOL', episodes: 1, episodesPerHour: 0.1, avgNetViable: 0.05 } },
      venues: { kraken: venue(150), coinbase: venue(153.5) },
    });
    assert.ok(r.perTrade.pass);
    assert.ok(!r.monthly.pass && r.monthly.monthlyNet < 0);
    assert.ok(!r.allowed);
    const none = guard.evaluateCrossCheck({ ...baseCheck, stats: { observedHours: 12, coin: { coin: 'SOL', episodes: 0, episodesPerHour: 0, avgNetViable: 0 } }, venues: { kraken: venue(150), coinbase: venue(153.5) } });
    assert.strictEqual(none.monthly.tradesPerMonth, 0);
    assert.ok(/No profitable opportunities/.test(none.monthly.reason));
    const fresh = guard.evaluateCrossCheck({ ...baseCheck, stats: null, venues: { kraken: venue(150), coinbase: venue(153.5) } });
    assert.strictEqual(fresh.monthly.source, 'assumed');
    assert.strictEqual(fresh.checks.find(c => c.id === 'history').status, 'warn');
  });

  await test('guard: strategy YAML → exchanges, and live guard rails', () => {
    const yml = generateStrategyYaml({ strategy: 'amm_arb', symbol: 'ETH', quote: 'USD', exA: 'kraken', exB: 'coinbase', tradeSizeUsd: 1000, refPrice: 2500, minProfitabilityPct: 0.5, paperTrade: false });
    const info = guard.describeStrategy(parseStrategyYaml(yml));
    assert.deepStrictEqual([info.exA, info.exB, info.symbol, info.quote, info.live, info.supported], ['kraken', 'coinbase', 'ETH', 'USD', true, true]);
    assert.strictEqual(guard.exchangeFromConnector('coinbase_advanced_trade_paper_trade'), 'coinbase');
    const g = { ...guard.guardSettings(), liveMaxOrderUsd: 1000, liveMinProfitabilityPct: 0.1, liveStopLossPct: 3, liveMaxLossUsd: 50 };
    assert.deepStrictEqual(guard.liveGuardViolations(info, 2500, g), []);
    assert.ok(guard.liveGuardViolations({ ...info, baseAmount: 1 }, 2500, g).some(v => /exceeds the live max/.test(v)));
    assert.ok(guard.liveGuardViolations({ ...info, minProfitabilityPct: -1 }, 2500, g).some(v => /below the live floor/.test(v)));
    assert.ok(guard.liveGuardViolations(info, 2500, { ...g, liveStopLossPct: 0 }).some(v => /stop-loss/i.test(v)));
  });

  await test('guard: Hummingbot 2.x kill switch format is read (and 1.x keys still understood)', () => {
    assert.deepStrictEqual(readKillSwitch({ kill_switch_mode: { kill_switch_rate: -3 } }), { killSwitchEnabled: true, killSwitchRate: -3 });
    assert.deepStrictEqual(readKillSwitch({ kill_switch_enabled: true, kill_switch_rate: -5 }), { killSwitchEnabled: true, killSwitchRate: -5 });
    assert.strictEqual(readKillSwitch({ kill_switch_mode: {} }).killSwitchEnabled, false);
  });

  await test('guard: deploy gate needs confirmation (typed phrase for live) and enforces live rails', async () => {
    // A strategy the cross-check can't price (no network needed) is never auto-approved
    const pmm = (live, minProf) => `strategy: pure_market_making\nexchange: ${live ? 'kraken' : 'kraken_paper_trade'}\nmarket: BTC-USD\norder_amount: 0.001\n${minProf != null ? `min_profitability: ${minProf}\n` : ''}`;
    const paperBlocked = await invokeApp('POST', '/api/deploy', { target: 'local', configName: 'gate_test', yaml: pmm(false) });
    assert.strictEqual(paperBlocked.status, 409);
    assert.ok(paperBlocked.body.blocked);
    assert.strictEqual(paperBlocked.body.requiresConfirmation.phrase, null);

    const paperOk = await guard.gateDeploy('local', { configName: 'gate_test', yaml: pmm(false), override: { confirmed: true } });
    assert.ok(paperOk.overridden);

    const liveNoFloor = await invokeApp('POST', '/api/deploy', { target: 'local', configName: 'gate_test', yaml: pmm(true) });
    assert.strictEqual(liveNoFloor.status, 400, 'live bot without min_profitability violates a hard rail');
    assert.ok(liveNoFloor.body.guardViolations.length > 0);

    const liveNeedsPhrase = await invokeApp('POST', '/api/deploy', { target: 'local', configName: 'gate_test', yaml: pmm(true, 0.5), override: { confirmed: true, phrase: 'yes' } });
    assert.strictEqual(liveNeedsPhrase.status, 409);
    assert.strictEqual(liveNeedsPhrase.body.requiresConfirmation.phrase, 'BTC-USD LIVE');

    const liveOk = await guard.gateDeploy('local', { configName: 'gate_test', yaml: pmm(true, 0.5), override: { confirmed: true, phrase: 'btc-usd live' } });
    assert.ok(liveOk.overridden && liveOk.info.live);

    const saveOnly = await invokeApp('POST', '/api/strategy/preview', { strategy: 'amm_arb', symbol: 'ETH', quote: 'USD', exA: 'kraken', exB: 'coinbase', tradeSizeUsd: 100, refPrice: 2500, paperTrade: true });
    assert.strictEqual(saveOnly.status, 200);

    const g = await invokeApp('GET', '/api/guard');
    assert.strictEqual(g.status, 200);
    assert.ok(g.body.settings.liveStopLossPct > 0);
    assert.ok(g.body.audit.some(a => a.action === 'override' && a.live));
    const bad = await invokeApp('POST', '/api/guard/settings', { liveStopLossPct: 999 });
    assert.strictEqual(bad.body.settings.liveStopLossPct, 50, 'settings are clamped to safe ranges');
    await invokeApp('POST', '/api/guard/settings', { liveStopLossPct: 3 });
  });

  await test('guard: stop-loss monitor stops a live bot at its $ loss limit and alerts', async () => {
    const hbPath = require.resolve('../lib/hummingbot');
    const realHb = require.cache[hbPath].exports;
    let pnl = 0; const stopped = [];
    require.cache[hbPath].exports = {
      ...realHb,
      listContainers: async () => [{ name: 'arb_sl_test', state: stopped.length ? 'exited' : 'running', strategyLabel: 'sl_test' }],
      getTradesAndPnl: async () => ({ byPairLive: { 'SOL-USD': { netMatchedPnl: pnl } } }),
      containerAction: async (target, name, action) => { stopped.push(`${target}:${name}:${action}`); return { success: true }; },
    };
    const prevAuto = guard.guardSettings().autoRecheckEnabled;
    guard.updateGuardSettings({ autoRecheckEnabled: false, liveMaxLossUsd: 25 });
    try {
      pnl = -10; // pre-existing history becomes the baseline
      const info = { symbol: 'SOL', quote: 'USD', exA: 'kraken', exB: 'coinbase', strategy: 'amm_arb' };
      await guard.monitor.register({ target: 'local', containerName: 'arb_sl_test', configName: 'sl_test', info });
      const key = 'local:arb_sl_test';
      assert.strictEqual(guard.monitor.bots[key].baselinePnl, -10);

      pnl = -30; // session loss $20 < $25 limit
      await guard.monitor.tick();
      assert.strictEqual(guard.monitor.bots[key].status, 'active');
      assert.strictEqual(guard.monitor.bots[key].sessionPnl, -20);
      assert.strictEqual(stopped.length, 0);

      pnl = -36; // session loss $26 >= $25 limit → stop
      await guard.monitor.tick();
      assert.strictEqual(guard.monitor.bots[key].status, 'tripped');
      assert.deepStrictEqual(stopped, ['local:arb_sl_test:stop']);
      const { alertManager } = require('../lib/alerts');
      assert.ok(alertManager.list({ limit: 5 }).some(a => a.kind === 'guard' && /STOP-LOSS: SOL-USD/.test(a.title)));
      assert.ok(guard.readAudit().some(a => a.action === 'stop_loss' && a.pair === 'SOL-USD'));

      await guard.monitor.tick(); // tripped bots are not acted on again
      assert.strictEqual(stopped.length, 1);
      guard.monitor.remove(key);
    } finally {
      require.cache[hbPath].exports = realHb;
      guard.updateGuardSettings({ autoRecheckEnabled: prevAuto, liveMaxLossUsd: 50 });
    }
  });

  // ─── Ticker audit (prices captured live from the exchanges on 2026-11-25) ────
  // bulk(ex, { NATIVE: [usdMid, quote?] }) builds a parsed bulk the way exchanges.js does
  const mkBulk = (ex, coins) => {
    const out = { USD: {}, USDC: {}, USDT: {} };
    for (const [nat, [m, q = 'USD']] of Object.entries(coins)) {
      const can = tickers.canonical(ex, nat);
      out[q][can] = { bid: m * 0.9995, ask: m * 1.0005, last: m, native: nat, book: true };
    }
    return out;
  };
  const liveBulks = {
    kraken: mkBulk('kraken', { BTC: [59903], LUNA: [0.00004538], ONE: [0.1204], EDGE: [0.07134], EDGEX: [0.271], LIT: [0.0857], LIGHTER: [2.386], AI: [0.01643], INIT: [0.05945], SUP: [0.00015], EUR: [1.0976], GMT: [0.00516], SOL: [70.19] }),
    coinbase: mkBulk('coinbase', { BTC: [59950], EDGE: [0.07133], EDGEX: [0.27], LIT: [0.0857], LIGHTER: [2.386], AI: [0.01645], SUP: [0.002451], GMT: [0.005195], SOL: [70.2] }),
    okx: mkBulk('okx', { BTC: [59960, 'USDT'], EDGE: [0.271, 'USDT'], LIT: [2.384, 'USDT'], LUNA: [0.03167, 'USDT'], ONE: [0.000951, 'USDT'], AI: [0.01645, 'USDT'], GMT: [0.005083, 'USDT'], SOL: [70.25, 'USDT'] }),
    kucoin: mkBulk('kucoin', { BTC: [59956, 'USDT'], EDGE: [0.2717, 'USDT'], LIT: [2.385, 'USDT'], LUNA: [0.0317, 'USDT'], LUNC: [0.0000443, 'USDT'], ONE: [0.0009515, 'USDT'], INIT: [0.0833, 'USDT'], GMT: [0.00513, 'USDT'], SOL: [70.255, 'USDT'] }),
    binance: mkBulk('binance', { BTC: [59940, 'USDT'], LUNC: [0.00004418, 'USDT'], AI: [0.01275, 'USDT'], INIT: [0.08582, 'USDT'], GMT: [0.005065, 'USDT'] }),
  };
  // KuCoin's GMT-USDC market was stale (0.01721 vs 0.00513 on USDT)
  liveBulks.kucoin.USDC.GMT = { bid: 0.0172, ask: 0.01722, last: 0.01721, native: 'GMT', book: true };

  await test('tickers: renamed coins map to one canonical ticker and back to each exchange\'s own', () => {
    assert.strictEqual(tickers.canonical('kraken', 'XBT'), 'BTC');
    assert.strictEqual(tickers.canonical('kraken', 'LUNA'), 'LUNC');
    assert.strictEqual(tickers.canonical('okx', 'LIT'), 'LIGHTER');
    assert.strictEqual(tickers.canonical('coinbase', 'LIT'), 'LIT', 'Coinbase LIT is Litentry, not Lighter');
    assert.strictEqual(tickers.nativeSymbol('kucoin', 'EDGEX'), 'EDGE');
    assert.strictEqual(tickers.nativeSymbol('kraken', 'LUNC'), 'LUNA');
    assert.strictEqual(tickers.hbSymbol('kraken', 'BTC'), 'BTC', "Hummingbot's Kraken connector already shows XBT as BTC");
    assert.strictEqual(tickers.hbSymbol('okx', 'LIGHTER'), 'LIT');
    const y = generateStrategyYaml({ strategy: 'amm_arb', symbol: 'LIGHTER', quote: 'USDT', exA: 'kraken', exB: 'okx', tradeSizeUsd: 100, refPrice: 2.4, minProfitabilityPct: 0.5, paperTrade: true });
    const doc = parseStrategyYaml(y).doc;
    assert.strictEqual(doc.market_1, 'LIGHTER-USDT');
    assert.strictEqual(doc.market_2, 'LIT-USDT');
    const x = parseStrategyYaml(generateStrategyYaml({ strategy: 'xemm', symbol: 'EDGEX', quote: 'USDT', makerEx: 'kucoin', takerEx: 'kraken', tradeSizeUsd: 100, refPrice: 0.27, paperTrade: true })).doc;
    assert.strictEqual(x.maker_market_trading_pair, 'EDGE-USDT');
    assert.strictEqual(x.taker_market_trading_pair, 'EDGEX-USDT');
    assert.strictEqual(guard.describeStrategy(parseStrategyYaml(generateStrategyYaml({ strategy: 'amm_arb', symbol: 'LIGHTER', quote: 'USDT', exA: 'okx', exB: 'kraken', tradeSizeUsd: 100, refPrice: 2.4, minProfitabilityPct: 0.5, paperTrade: true }))).symbol, 'LIGHTER');
  });

  await test('ticker audit: real same-ticker/different-coin cases are flagged, renames line up', () => {
    const a = tickerAudit.evaluateAudit(liveBulks);
    const st = (sym, ex) => (a.symbols.find(s => s.symbol === sym) || { listings: {} }).listings[ex]?.status;
    // Renames now compare the same coin
    for (const ex of ['kraken', 'coinbase', 'okx', 'kucoin']) assert.strictEqual(st('EDGEX', ex), 'ok', `EDGEX on ${ex}`);
    for (const ex of ['kraken', 'coinbase', 'okx', 'kucoin']) assert.strictEqual(st('LIGHTER', ex), 'ok', `LIGHTER on ${ex}`);
    for (const ex of ['kraken', 'kucoin', 'binance']) assert.strictEqual(st('LUNC', ex), 'ok', `LUNC on ${ex}`);
    assert.strictEqual(st('LUNA', 'okx'), 'ok', 'Terra 2.0 (OKX, KuCoin) no longer collides with Kraken Terra Classic');
    assert.strictEqual(st('LUNA', 'kraken'), undefined, 'Kraken Terra Classic is filed under LUNC');
    // Different coins sharing a ticker
    assert.strictEqual(st('ONE', 'kraken'), 'collision');
    assert.strictEqual(st('ONE', 'okx'), 'ok');
    assert.strictEqual(st('AI', 'binance'), 'collision');
    assert.strictEqual(st('INIT', 'kraken'), 'collision');
    assert.strictEqual(st('SUP', 'kraken'), 'collision');
    assert.strictEqual(st('SUP', 'coinbase'), 'single', "Coinbase's real SUP isn't penalised by Kraken's different SUP");
    assert.deepStrictEqual(a.flagged.find(f => f.symbol === 'ONE' && f.exchange === 'kraken').badQuotes, [], 'no redundant stale-quote note on excluded coins');
    // Stale quote market on an otherwise fine listing
    assert.strictEqual(st('GMT', 'kucoin'), 'bad_quote');
    const gmt = a.flagged.find(f => f.symbol === 'GMT' && f.exchange === 'kucoin');
    assert.deepStrictEqual(gmt.badQuotes, ['USDC']);
    assert.strictEqual(st('EUR', 'kraken'), 'fiat');
    for (const ex of ['kraken', 'coinbase', 'okx', 'kucoin', 'binance']) assert.strictEqual(st('BTC', ex), 'ok');
  });

  await test('ticker audit: unknown collisions are caught by price alone', () => {
    const b = {
      kraken: mkBulk('kraken', { ZZZ: [1.0] }), coinbase: mkBulk('coinbase', { ZZZ: [1.01] }),
      okx: mkBulk('okx', { ZZZ: [3.5, 'USDT'] }), kucoin: mkBulk('kucoin', { ZZZ: [0.99, 'USDT'], YYY: [2, 'USDT'] }),
      binance: mkBulk('binance', { YYY: [5, 'USDT'] }),
    };
    const a = tickerAudit.evaluateAudit(b);
    const z = a.symbols.find(s => s.symbol === 'ZZZ');
    assert.strictEqual(z.listings.okx.status, 'mismatch');
    assert.strictEqual(z.listings.kraken.status, 'ok');
    const y = a.symbols.find(s => s.symbol === 'YYY');
    assert.strictEqual(y.listings.kucoin.status, 'conflict', 'two sources disagreeing: both flagged');
    assert.strictEqual(y.listings.binance.status, 'conflict');
  });

  await test('scanner: flagged tickers are excluded from results (never alert or deploy)', async () => {
    tickerAudit._setCacheForTests(tickerAudit.evaluateAudit(liveBulks));
    const { blockedReason } = tickerAudit;
    assert.ok(blockedReason('kraken', 'ONE', 'USD'));
    assert.ok(!blockedReason('okx', 'ONE', 'USDT'));
    assert.ok(blockedReason('kucoin', 'GMT', 'USDC'), 'stale USDC market blocked');
    assert.ok(!blockedReason('kucoin', 'GMT', 'USDT'), 'USDT market on the same coin still fine');
    assert.ok(blockedReason('kraken', 'EUR', 'USD'), 'fiat never scanned as crypto');
    assert.ok(!blockedReason('kraken', 'BTC', 'USD'));
    const chk = guard.evaluateCrossCheck({ ...baseCheck, tickerBlocks: [blockedReason('kraken', 'ONE', 'USD')].filter(Boolean), venues: { kraken: venue(150), coinbase: venue(153.5) } });
    assert.strictEqual(chk.checks.find(c => c.id === 'ticker').status, 'fail');
    assert.ok(!chk.allowed);
    tickerAudit._setCacheForTests(null);
  });

  // ─── Auto-trader (Target Watcher → bot) ─────────────────────────────────────
  await test('auto-trader: launches only when every check passes, never overrides, respects its limits', async () => {
    const { autoTrader } = require('../lib/autoTrader');
    const hbMod = require('../lib/hummingbot');
    const saved = { deployStrategy: hbMod.deployStrategy, listContainers: hbMod.listContainers, containerAction: hbMod.containerAction, listConnectors: hbMod.listConnectors, ensureKillSwitch: hbMod.ensureKillSwitch, getTradesAndPnl: hbMod.getTradesAndPnl };
    const savedGate = guard.gateDeploy;
    const deployed = [], stopped = [];
    let gateMode = 'pass';
    hbMod.deployStrategy = async (target, o) => { deployed.push(o); return { success: true, containerId: 'c' + deployed.length, containerName: `arb_${o.configName}`, configName: o.configName }; };
    hbMod.listContainers = async () => deployed.map(o => ({ name: `arb_${o.configName}`, state: 'running', strategyLabel: o.configName }));
    hbMod.containerAction = async (t, name, action) => { stopped.push(`${name}:${action}`); return { success: true }; };
    hbMod.listConnectors = async () => [{ exchange: 'kraken' }];
    hbMod.ensureKillSwitch = async () => ({ changed: true, killSwitchRate: -3 });
    hbMod.getTradesAndPnl = async () => ({ byPairLive: {} });
    guard.gateDeploy = async (target, o) => {
      const info = guard.describeStrategy(parseStrategyYaml(o.yaml));
      if (gateMode === 'block') throw new guard.GateError('Blocked: not verified profitable.', 409, { blocked: true, reasons: ['Per-trade: Loses $1.20 per trade'] });
      assert.strictEqual(o.override, undefined, 'auto launches never carry an override');
      return { info, overridden: false, check: { allowed: true, perTrade: { netPct: 0.41 }, monthly: { monthlyNet: 22.5 } } };
    };
    const target = (symbol, extra = {}) => ({ id: 'al_' + symbol, isTest: false, symbol, quote: 'USD', pair: 'kraken_coinbase', buyOn: 'kraken', sellOn: 'coinbase', buyPrice: 100, sellPrice: 101.5, tradeSize: 1000, netProfitPct: 0.5, ...extra });
    try {
      // Off → nothing happens
      assert.deepStrictEqual(await autoTrader.onTargets([target('SOL')]), []);

      autoTrader.updateSettings({ enabled: true, maxConcurrent: 2, maxPerDay: 3, symbolCooldownMin: 60, maxRuntimeMin: 30, maxOrderUsd: 400 });
      assert.strictEqual(guard.guardSettings && require('../lib/config').loadConfig().alerts.enabled, true, 'enabling auto-trade turns the Target Watcher on');

      // Pass → paper bot launched, capped order size, registered for max runtime
      let r = await autoTrader.onTargets([target('SOL')]);
      assert.strictEqual(r[0].outcome, 'launched');
      assert.strictEqual(deployed.length, 1);
      assert.ok(/_paper_trade/.test(deployed[0].yaml), 'paper by default');
      assert.strictEqual(r[0].tradeSizeUsd, 400, 'order size capped at maxOrderUsd');
      const bot = guard.monitor.list().find(b => b.containerName === r[0].containerName);
      assert.ok(bot && bot.auto && bot.live === false && bot.stopAt > Date.now());
      const { alertManager } = require('../lib/alerts');
      assert.ok(alertManager.list({ limit: 3 }).some(a => a.kind === 'auto' && /AUTO BOT \(PAPER\): SOL-USD/.test(a.title)));

      // Same coin while running → skipped
      r = await autoTrader.onTargets([target('SOL')]);
      assert.strictEqual(r[0].outcome, 'skipped');
      assert.ok(/already running/.test(r[0].reason));

      // Failed safety checks → skipped, nothing deployed
      gateMode = 'block';
      r = await autoTrader.onTargets([target('ETH')]);
      assert.strictEqual(r[0].outcome, 'skipped');
      assert.ok(/Failed safety checks: Per-trade/.test(r[0].reason));
      assert.strictEqual(deployed.length, 1);
      gateMode = 'pass';

      // Second coin launches; third hits the concurrent limit
      r = await autoTrader.onTargets([target('ETH')]);
      assert.strictEqual(r[0].outcome, 'launched');
      r = await autoTrader.onTargets([target('ADA')]);
      assert.ok(/max 2/.test(r[0].reason));

      // Max runtime: monitor stops auto bots when their time is up
      for (const b of guard.monitor.list().filter(b => b.auto)) { guard.monitor.bots[b.key].stopAt = Date.now() - 1000; }
      guard.updateGuardSettings({ autoRecheckEnabled: false });
      await guard.monitor.tick();
      assert.strictEqual(stopped.length, 2);
      assert.ok(guard.monitor.list().filter(b => b.auto).every(b => b.status === 'completed'));

      // Cooldown blocks an immediate relaunch of the same coin
      r = await autoTrader.onTargets([target('SOL')]);
      assert.ok(/Cooldown/.test(r[0].reason));

      // Daily cap (3): ADA launches (3rd), BTC is refused
      r = await autoTrader.onTargets([target('ADA')]);
      assert.strictEqual(r[0].outcome, 'launched');
      for (const b of guard.monitor.list().filter(b => b.auto && b.status === 'active')) guard.monitor.bots[b.key].status = 'completed';
      r = await autoTrader.onTargets([target('BTC')]);
      assert.ok(/Daily limit/.test(r[0].reason));
    } finally {
      Object.assign(hbMod, saved);
      guard.gateDeploy = savedGate;
      for (const b of guard.monitor.list()) guard.monitor.remove(b.key);
    }
  });

  await test('auto-trader: live needs typed confirmation, a token on LAN, and exchange keys', async () => {
    const { autoTrader, LIVE_PHRASE } = require('../lib/autoTrader');
    const hbMod = require('../lib/hummingbot');
    const savedConn = hbMod.listConnectors;
    const prevBind = process.env.BIND_HOST;
    try {
      assert.throws(() => autoTrader.updateSettings({ mode: 'live' }), /Type LIVE AUTO-TRADE/);
      process.env.BIND_HOST = '0.0.0.0';
      assert.throws(() => autoTrader.updateSettings({ mode: 'live', confirmPhrase: LIVE_PHRASE }), /without an API token/);
      process.env.BIND_HOST = '127.0.0.1';
      const st = autoTrader.updateSettings({ mode: 'live', confirmPhrase: 'live auto-trade' });
      assert.strictEqual(st.mode, 'live');
      assert.ok(autoTrader.status().log.some(e => e.outcome === 'mode_change' && e.mode === 'live'));

      hbMod.listConnectors = async () => [{ exchange: 'kraken' }]; // no Coinbase keys
      autoTrader.log = autoTrader.log.filter(e => e.outcome !== 'launched');
      const r = await autoTrader.consider({ symbol: 'SOL', quote: 'USD', pair: 'kraken_coinbase', buyOn: 'kraken', sellOn: 'coinbase', buyPrice: 100, tradeSize: 500, netProfitPct: 0.5 }, autoTrader.status().settings);
      assert.strictEqual(r.outcome, 'skipped');
      assert.ok(/No Hummingbot API keys .* Coinbase/.test(r.reason));

      assert.strictEqual(autoTrader.updateSettings({ mode: 'paper', enabled: false }).mode, 'paper', 'back to paper needs no confirmation');
    } finally {
      hbMod.listConnectors = savedConn;
      if (prevBind === undefined) delete process.env.BIND_HOST; else process.env.BIND_HOST = prevBind;
    }
  });

  await test('guard: an auto launch cannot use a manual override', async () => {
    const pmm = 'strategy: pure_market_making\nexchange: kraken_paper_trade\nmarket: BTC-USD\norder_amount: 0.001\n';
    await assert.rejects(guard.gateDeploy('local', { configName: 'auto_x', yaml: pmm, override: { confirmed: true }, auto: true }), e => e.status === 409);
    const ok = await guard.gateDeploy('local', { configName: 'manual_x', yaml: pmm, override: { confirmed: true } });
    assert.ok(ok.overridden, 'the same override works for a manual launch');
  });

  // ─── AI reviewer (model + market data stubbed; the ETC case from 2026-11-25) ─
  const aiReview = require('../lib/aiReview');
  const ev = (m, o = {}) => venue(m, { size: 60, ...o }); // ETC books with real depth
  // Kraken ETC ~5.9% above Coinbase, OKX and Binance; real live books on both sides
  const etcCheck = (over = {}) => guard.evaluateCrossCheck({
    symbol: 'ETC', quote: 'USD', exA: 'kraken', exB: 'coinbase', fees: DEFAULT_FEES, tradeSize: 250,
    references: [{ ex: 'okx', label: 'OKX', mid: 5.9635 }, { ex: 'binance', label: 'Binance', mid: 5.965 }, { ex: 'binanceus', label: 'Binance.US', mid: 5.96 }],
    server: { allocatedMonthlyUsd: 11.5, source: 'estimate' }, stats: null,
    venues: { kraken: ev(6.3155), coinbase: ev(5.957) }, tickerBlocks: [], ...over,
  });
  const verdictJson = (o = {}) => JSON.stringify({ verdict: 'tradeable', confidence: 0.82, same_asset: true, prices_genuine: true, executable_with_inventory: true, gap_cause: 'Kraken-only premium; ETC deposits need ~12 h of confirmations', transfer_status: 'Deposits and withdrawals enabled on both', key_risks: ['Thin Kraken book'], recommended_max_order_usd: 200, summary: 'Real Kraken premium; capturable with ETC already on Kraken.', ...o });

  await test('ai: policy lets the AI override judgement checks only, never the math or hard rules', () => {
    const s = { ...aiReview.settings(), enabled: true, minConfidence: 0.75, maxOrderUsd: 250, allowLive: false };
    const v = aiReview.parseVerdict(verdictJson(), 250);
    const chk = etcCheck();
    const failed = chk.checks.filter(c => c.status === 'fail').map(c => c.id);
    assert.ok(failed.includes('reference'), 'the ETC case is blocked by the reference check');
    assert.ok(chk.perTrade.pass, 'and is profitable per trade on the live books');
    const ok = aiReview.applyPolicy(v, chk, s, false);
    assert.ok(ok.approved, ok.reasons.join('; '));
    assert.strictEqual(ok.maxOrderUsd, 200, 'AI-recommended size lowers the cap');

    assert.ok(!aiReview.applyPolicy(v, chk, s, true).approved, 'paper-only unless allowLive');
    assert.ok(aiReview.applyPolicy(v, chk, { ...s, allowLive: true }, true).approved);
    assert.ok(!aiReview.applyPolicy(aiReview.parseVerdict(verdictJson({ confidence: 0.6 }), 250), chk, s, false).approved, 'low confidence');
    assert.ok(!aiReview.applyPolicy(aiReview.parseVerdict(verdictJson({ verdict: 'uncertain' }), 250), chk, s, false).approved);
    assert.ok(!aiReview.applyPolicy(aiReview.parseVerdict(verdictJson({ same_asset: false }), 250), chk, s, false).approved);
    // Hard rules: different coin, thin book, per-trade loss — never overridable
    const diffCoin = etcCheck({ tickerBlocks: ['Kraken ETC: known different coin'] });
    assert.match(aiReview.applyPolicy(v, diffCoin, s, false).reasons.join(' '), /never overridable/);
    const thin = etcCheck({ tradeSize: 50000, venues: { kraken: ev(6.3155, { levels: 2, size: 1 }), coinbase: ev(5.957) } });
    assert.ok(!aiReview.applyPolicy(v, thin, s, false).approved);
    const loss = etcCheck({ venues: { kraken: ev(5.96), coinbase: ev(5.957) } });
    assert.ok(!loss.perTrade.pass);
    assert.match(aiReview.applyPolicy(v, loss, s, false).reasons.join(' '), /Not profitable per trade/);
    // Malformed model output counts as no verdict
    assert.strictEqual(aiReview.parseVerdict('not json', 250), null);
    assert.ok(!aiReview.applyPolicy(null, chk, s, false).approved);
    assert.strictEqual(aiReview.parseVerdict(verdictJson({ confidence: 85, verdict: 'Tradeable' }), 250).confidence, 0.85, 'percent confidence and enum case normalised');
  });

  await test('ai: review → deploy gate accepts a fresh approval, re-checks at launch, rejects stale/mismatched', async () => {
    const savedEv = aiReview.collectEvidence, savedModel = aiReview.callModel, savedCC = guard.runCrossCheck;
    let liveCheck = etcCheck();
    aiReview.collectEvidence = async () => ({ check: liveCheck, evidence: { stub: true } });
    aiReview.callModel = async () => ({ raw: verdictJson() });
    guard.runCrossCheck = async () => liveCheck;
    aiReview.updateSettings({ enabled: true, maxOrderUsd: 250, validMin: 10, allowLive: false });
    const yml = (paper = true, usd = 200) => generateStrategyYaml({ strategy: 'amm_arb', symbol: 'ETC', quote: 'USD', exA: 'kraken', exB: 'coinbase', tradeSizeUsd: usd, refPrice: 6.13, minProfitabilityPct: 0.5, paperTrade: paper });
    try {
      await assert.rejects(guard.gateDeploy('local', { configName: 'etc', yaml: yml() }), e => e.status === 409, 'blocked without approval');
      const rec = await aiReview.review({ symbol: 'ETC', quote: 'USD', exA: 'kraken', exB: 'coinbase', tradeSize: 250 });
      assert.ok(rec.policy.approved, rec.policy.reasons.join('; '));
      assert.ok(rec.policy.overrides.some(o => /independent exchange/i.test(o)), rec.policy.overrides.join("; "));

      const g = await guard.gateDeploy('local', { configName: 'etc', yaml: yml(), override: { aiReviewId: rec.id } });
      assert.strictEqual(g.overridden, 'ai');
      assert.ok(guard.readAudit().some(a => a.action === 'ai_override' && a.aiReviewId === rec.id));
      // Auto launches may carry an AI approval (but not a manual one)
      assert.strictEqual((await guard.gateDeploy('local', { configName: 'etc', yaml: yml(), auto: true, override: { aiReviewId: rec.id, confirmed: true } })).overridden, 'ai');

      // Order above the AI cap
      await assert.rejects(guard.gateDeploy('local', { configName: 'etc', yaml: yml(true, 1000), override: { aiReviewId: rec.id } }), e => /AI-approved max/.test(e.message));
      // Conditions changed at launch (book thinned out) → hard rule re-applied
      liveCheck = etcCheck({ tradeSize: 50000, venues: { kraken: ev(6.3155, { levels: 2, size: 1 }), coinbase: ev(5.957) } });
      await assert.rejects(guard.gateDeploy('local', { configName: 'etc', yaml: yml(), override: { aiReviewId: rec.id } }), e => /Conditions changed/.test(e.message));
      liveCheck = etcCheck();
      // Paper approval can't launch live
      await assert.rejects(guard.gateDeploy('local', { configName: 'etc', yaml: yml(false), override: { aiReviewId: rec.id, phrase: 'ETC-USD LIVE' } }), e => /paper trading/.test(e.message));
      // Expired
      const r = aiReview.list().find(x => x.id === rec.id);
      require('../lib/aiReview');
      const stale = (await aiReview.review({ symbol: 'ETC', quote: 'USD', exA: 'kraken', exB: 'coinbase', tradeSize: 250 }));
      const stored = (function find(id) { return require('../lib/aiReview').list().find(x => x.id === id); })(stale.id);
      assert.ok(stored && r);
      // Age the stored record (list() returns copies) by validating against a short window
      aiReview.updateSettings({ validMin: 1 });
      const realNow = Date.now; Date.now = () => realNow() + 2 * 60000;
      try { await assert.rejects(guard.gateDeploy('local', { configName: 'etc', yaml: yml(), override: { aiReviewId: stale.id } }), e => /expired/.test(e.message)); }
      finally { Date.now = realNow; aiReview.updateSettings({ validMin: 10 }); }

      // Live needs allowLive (typed confirmation) and, for manual launches, the live phrase
      assert.throws(() => aiReview.updateSettings({ allowLive: true }), /AI CAN APPROVE LIVE/);
      aiReview.updateSettings({ allowLive: true, confirmPhrase: 'ai can approve live' });
      const liveRec = await aiReview.review({ symbol: 'ETC', quote: 'USD', exA: 'kraken', exB: 'coinbase', tradeSize: 250, live: true });
      assert.ok(liveRec.policy.approved);
      await assert.rejects(guard.gateDeploy('local', { configName: 'etc', yaml: yml(false), override: { aiReviewId: liveRec.id } }), e => /Type ETC-USD LIVE/.test(e.message));
      assert.strictEqual((await guard.gateDeploy('local', { configName: 'etc', yaml: yml(false), override: { aiReviewId: liveRec.id, phrase: 'ETC-USD LIVE' } })).overridden, 'ai');

      // A rejected review never unlocks the gate
      aiReview.callModel = async () => ({ raw: verdictJson({ verdict: 'not_tradeable', summary: 'Deposits suspended on Kraken' }) });
      const no = await aiReview.review({ symbol: 'ETC', quote: 'USD', exA: 'kraken', exB: 'coinbase', tradeSize: 250 });
      assert.ok(!no.policy.approved);
      await assert.rejects(guard.gateDeploy('local', { configName: 'etc', yaml: yml(), override: { aiReviewId: no.id } }), e => /AI did not approve/.test(e.message));
      // Model errors are recorded, not thrown into the gate
      aiReview.callModel = async () => { throw Object.assign(new Error('bad key'), { response: { status: 401, data: { error: { message: 'invalid x-api-key' } } } }); };
      const err = await aiReview.review({ symbol: 'ETC', quote: 'USD', exA: 'kraken', exB: 'coinbase', tradeSize: 250 });
      assert.ok(!err.policy.approved && /HTTP 401/.test(err.policy.reasons[0]));
    } finally {
      aiReview.collectEvidence = savedEv; aiReview.callModel = savedModel; guard.runCrossCheck = savedCC;
      aiReview.updateSettings({ enabled: false, allowLive: false });
      const { updateConfig } = require('../lib/config'); updateConfig(c => { c.aiReview.allowLive = false; });
    }
  });

  await test('ai: auto-trader asks the AI when a target is blocked and launches only on approval', async () => {
    const { autoTrader } = require('../lib/autoTrader');
    const hbMod = require('../lib/hummingbot');
    const saved = { deployStrategy: hbMod.deployStrategy, listContainers: hbMod.listContainers, ensureKillSwitch: hbMod.ensureKillSwitch };
    const savedEv = aiReview.collectEvidence, savedModel = aiReview.callModel, savedCC = guard.runCrossCheck;
    const deployed = [];
    hbMod.deployStrategy = async (t, o) => { deployed.push(o); return { success: true, containerId: 'x', containerName: `arb_${o.configName}`, configName: o.configName }; };
    hbMod.listContainers = async () => [];
    hbMod.ensureKillSwitch = async () => ({ changed: false, killSwitchRate: -3 });
    aiReview.collectEvidence = async () => ({ check: etcCheck(), evidence: {} });
    guard.runCrossCheck = async () => etcCheck();
    autoTrader.log = [];
    for (const b of guard.monitor.list()) guard.monitor.remove(b.key);
    const alert = { symbol: 'ETC', quote: 'USD', pair: 'kraken_coinbase', buyOn: 'coinbase', sellOn: 'kraken', buyPrice: 5.957, sellPrice: 6.28, tradeSize: 1000, netProfitPct: 2.57 };
    try {
      autoTrader.updateSettings({ enabled: true, mode: 'paper', maxOrderUsd: 500, maxRuntimeMin: 60, maxPerDay: 10, symbolCooldownMin: 0 });
      // AI off → blocked target is skipped
      aiReview.updateSettings({ enabled: false });
      let r = await autoTrader.consider(alert);
      assert.strictEqual(r.outcome, 'skipped');
      assert.strictEqual(deployed.length, 0);

      // AI says not tradeable → still skipped, with the AI's reason
      aiReview.updateSettings({ enabled: true, autoOverride: true, maxOrderUsd: 250, maxRuntimeMin: 30 });
      aiReview.callModel = async () => ({ raw: verdictJson({ verdict: 'not_tradeable' }) });
      r = await autoTrader.consider(alert);
      assert.strictEqual(r.outcome, 'skipped');
      assert.match(r.reason, /AI review: AI verdict: not tradeable/);
      assert.strictEqual(deployed.length, 0);

      // AI approves → launched with the AI order cap (200) and the shorter run time (30 min)
      aiReview.callModel = async () => ({ raw: verdictJson() });
      r = await autoTrader.consider(alert);
      assert.strictEqual(r.outcome, 'launched', r.reason);
      assert.strictEqual(r.tradeSizeUsd, 200);
      assert.ok(r.aiReviewId && /AI override/.test(r.reason));
      const bot = guard.monitor.list().find(b => b.containerName === r.containerName);
      assert.ok(bot.stopAt - bot.registeredAt <= 30 * 60000 + 1000);

      // autoOverride off → AI not consulted
      aiReview.updateSettings({ autoOverride: false });
      for (const b of guard.monitor.list()) guard.monitor.remove(b.key);
      r = await autoTrader.consider(alert);
      assert.strictEqual(r.outcome, 'skipped');
      assert.ok(!/AI review/.test(r.reason));
    } finally {
      Object.assign(hbMod, saved);
      aiReview.collectEvidence = savedEv; aiReview.callModel = savedModel; guard.runCrossCheck = savedCC;
      aiReview.updateSettings({ enabled: false, autoOverride: true });
      autoTrader.updateSettings({ enabled: false });
      for (const b of guard.monitor.list()) guard.monitor.remove(b.key);
    }
  });

  // ─── Hummingbot latency test ──────────────────────────────────────────────
  const latency = require('../lib/latency');
  const res = (median, extra = {}) => ({ ok: true, status: 200, blocked: false, tcpMs: median / 2, warm: { n: 10, min: median - 1, median, p90: median + 4, max: median + 6, jitter: 1.5 }, ...extra });

  await test('latency: compares hosts per exchange and per pair (slower leg), handles region blocks', () => {
    const runs = [
      { target: 'local', hostName: 'Local PC', ok: true, results: { kraken: res(45), coinbase: res(30), bybit: { ...res(12), status: 403, blocked: true } } },
      { target: 'vps1', hostName: 'Hetzner Ashburn', ok: true, results: { kraken: res(8), coinbase: res(22), bybit: res(15) } },
      { target: 'vps2', hostName: 'Broken', ok: false, error: 'SSH timeout' },
    ];
    const c = latency.compareHosts(runs);
    const kr = c.perExchange.find(e => e.exchange === 'kraken');
    assert.strictEqual(kr.bestTarget, 'vps1');
    assert.strictEqual(kr.hosts.find(h => h.target === 'local').slowerByMs, 37);
    const kc = c.perPair.find(p => p.pair === 'kraken_coinbase');
    assert.strictEqual(kc.hosts.find(h => h.target === 'local').roundMs, 45, 'a round = the slower leg (Kraken 45 > Coinbase 30)');
    assert.strictEqual(kc.hosts.find(h => h.target === 'vps1').roundMs, 22);
    assert.strictEqual(kc.bestTarget, 'vps1');
    assert.strictEqual(kc.advantageMs, 23);
    const bk = c.perPair.find(p => p.pair === 'bybit_kraken');
    assert.strictEqual(bk.hosts.find(h => h.target === 'local').ok, false);
    assert.deepStrictEqual(bk.hosts.find(h => h.target === 'local').blocked, ['Bybit']);
    assert.strictEqual(bk.bestTarget, 'vps1');
    assert.strictEqual(bk.advantageMs, null, 'only one host can trade it');
    assert.ok(c.blockedNotes.some(n => /Bybit returns HTTP 403 from Local PC/.test(n)));
    assert.ok(c.headlines.includes('Kraken × Coinbase: Hetzner Ashburn is fastest at 22 ms per round, 23 ms (105%) ahead of Local PC'), c.headlines.join(' | '));
  });

  await test('latency: multi-host test runs every host, keeps failures, saves history', async () => {
    const t = await latency.runLatencyTest({ targets: ['local'], exchanges: ['kraken', 'coinbase'], samples: 5 }, {
      measureHost: async (target) => ({ target, hostName: 'Local PC', ok: true, method: 'backend-node', samples: 5, notes: [], durationMs: 10, results: { kraken: res(40), coinbase: res(25) } }),
    });
    assert.strictEqual(t.runs.length, 1);
    assert.strictEqual(t.comparison.perPair.find(p => p.pair === 'kraken_coinbase').hosts[0].roundMs, 40);
    assert.strictEqual(latency.history()[0].id, t.id);
    await assert.rejects(latency.runLatencyTest({ targets: ['nope'] }), /No hosts selected/);
  });

  await test('latency: probes time a kept-alive connection (Node fallback, and the Python probe used in the container)', async () => {
    const httpMod = require('http');
    const srv = httpMod.createServer((q, r) => setTimeout(() => { r.statusCode = q.url.includes('geo') ? 451 : 200; r.end('{}'); }, q.url.includes('slow') ? 40 : 3));
    srv.keepAliveTimeout = 10000;
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    const targets = { fast: `http://127.0.0.1:${port}/t`, slow: `http://127.0.0.1:${port}/slow`, dead: 'http://127.0.0.1:1/' };
    try {
      const n = await latency.runNode(targets, 4);
      assert.ok(n.results.fast.ok && n.results.fast.warm.n === 4);
      assert.strictEqual(n.results.fast.reconnects, 0, 'requests reuse one connection');
      assert.ok(n.results.slow.warm.median >= 38 && n.results.slow.warm.median > n.results.fast.warm.median + 25);
      assert.strictEqual(n.results.dead.ok, false);

      const { execFile } = require('child_process');
      const py = await new Promise(resolve => execFile(process.platform === 'win32' ? 'python' : 'python3', ['-c', latency.pythonCommand(targets, 4)], { encoding: 'utf8', timeout: 30000 }, (e, out) => resolve(e ? null : out)));
      if (py) {
        const r = latency.parseProbeOutput(py);
        assert.ok(r.fast.ok && r.fast.warm.n === 4 && r.fast.reconnects === 0);
        assert.ok(r.slow.warm.median >= 38);
        assert.strictEqual(r.dead.ok, false);
      } else {
        console.log('        (python not installed here — container probe check skipped)');
      }
      assert.strictEqual(latency.parseProbeOutput('docker: error'), null);
    } finally { srv.close(); }
  });


  // ─── RPC manager ──────────────────────────────────────────────────────────
  const rpc = require('../lib/rpc');
  const httpMod2 = require('http');
  const { execFile: execFile2 } = require('child_process');
  // Tiny JSON-RPC node: answers like an EVM node (chainId/blockNumber) or Solana (genesis/slot)
  function fakeNode({ chainId = 1, head = 1000, genesis = null, delay = 0 } = {}) {
    const srv = httpMod2.createServer((q, r) => {
      let d = ''; q.on('data', c => { d += c; }); q.on('end', () => setTimeout(() => {
        const { id, method } = JSON.parse(d || '{}');
        const result = { eth_chainId: '0x' + chainId.toString(16), eth_blockNumber: '0x' + head.toString(16), getGenesisHash: genesis, getSlot: head }[method];
        r.setHeader('content-type', 'application/json');
        r.end(JSON.stringify(result === undefined ? { jsonrpc: '2.0', id, error: { message: 'no method' } } : { jsonrpc: '2.0', id, result }));
      }, delay));
    });
    return new Promise(res => srv.listen(0, '127.0.0.1', () => res({ srv, url: `http://127.0.0.1:${srv.address().port}` })));
  }

  await test('rpc: URLs are validated and API keys masked', () => {
    assert.strictEqual(rpc.validUrl('https://mainnet.base.org/'), 'https://mainnet.base.org');
    assert.throws(() => rpc.validUrl('http://rpc.ankr.com/eth'), /only allowed for nodes on your own network/);
    assert.throws(() => rpc.validUrl('wss://x.io'), /WebSocket/);
    assert.strictEqual(rpc.validUrl('http://192.168.1.20:8545'), 'http://192.168.1.20:8545');
    assert.strictEqual(rpc.maskUrl('https://mainnet.infura.io/v3/abcdef0123456789abcdef'), 'https://mainnet.infura.io/v3/abc…def');
    assert.ok(!rpc.maskUrl('https://mainnet.helius-rpc.com/?api-key=1234-5678-abcd').includes('5678'));
  });

  await test('rpc: health check confirms the chain and flags endpoints that lag behind', async () => {
    const good = await fakeNode({ chainId: 1, head: 2000 });
    const behind = await fakeNode({ chainId: 1, head: 1990 });
    const wrong = await fakeNode({ chainId: 8453, head: 2000 });
    try {
      const n = rpc.NETWORKS.find(x => x.id === 'ethereum-mainnet');
      const t = await rpc.testUrl(n, good.url, { samples: 2 });
      assert.ok(t.ok && t.head === 2000 && t.identityOk && t.samples === 2);
      const w = await rpc.testUrl(n, wrong.url);
      assert.ok(!w.ok && /Wrong chain/.test(w.error));
      const sol = await fakeNode({ genesis: 'not-mainnet', head: 5 });
      const s = await rpc.testUrl(rpc.NETWORKS.find(x => x.id === 'solana-mainnet-beta'), sol.url);
      assert.ok(!s.ok && /Wrong cluster/.test(s.error));
      sol.srv.close();

      rpc.addEndpoint({ network: 'ethereum-mainnet', url: behind.url, label: 'Behind' });
      rpc.addEndpoint({ network: 'ethereum-mainnet', url: good.url, label: 'Good' });
      assert.throws(() => rpc.addEndpoint({ network: 'ethereum-mainnet', url: good.url }), /already/);
      const r = await rpc.testNetwork('ethereum-mainnet', { samples: 1 });
      const byLabel = Object.fromEntries(r.results.map(x => [x.label, x]));
      assert.ok(byLabel.Behind.lagging && byLabel.Behind.lag === 10);
      assert.ok(byLabel.Good.healthy);
      assert.strictEqual(r.activeHealthy, false, 'first added endpoint became active and it lags');
      const f = await rpc.pickFastest('ethereum-mainnet');
      assert.strictEqual(f.activeId, byLabel.Good.id);
      assert.ok(rpc.publicSettings().networks.find(x => x.id === 'ethereum-mainnet').lastTest);
    } finally { good.srv.close(); behind.srv.close(); wrong.srv.close(); }
  });

  // Fake Gateway: conf folder + its HTTP API
  function fakeGatewayDir(port) {
    const dir = fs.mkdtempSync(path.join(TEST_DIR, 'gw-'));
    const conf = path.join(dir, 'conf');
    fs.mkdirSync(path.join(conf, 'chains', 'ethereum'), { recursive: true });
    fs.writeFileSync(path.join(conf, 'server.yml'), `# Port on which to run\nport: ${port}\n`);
    fs.writeFileSync(path.join(conf, 'apiKeys.yml'), "# keys\nhelius: ''\ninfura: ''\n");
    fs.writeFileSync(path.join(conf, 'chains', 'ethereum.yml'), "defaultNetwork: mainnet\n# RPC provider\nrpcProvider: url\n");
    fs.writeFileSync(path.join(conf, 'chains', 'solana.yml'), 'defaultNetwork: mainnet-beta\nrpcProvider: url\n');
    fs.writeFileSync(path.join(conf, 'chains', 'ethereum', 'mainnet.yml'), "chainID: 1\nnodeURL: https://eth-mainnet.g.alchemy.com/public # default\nnativeCurrencySymbol: ETH\n");
    return { dir, conf };
  }
  function fakeGatewayApi(port, calls) {
    const srv = httpMod2.createServer((q, r) => {
      let d = ''; q.on('data', c => { d += c; }); q.on('end', () => {
        calls.push(`${q.method} ${q.url}`);
        r.setHeader('content-type', 'application/json');
        if (q.url === '/') return r.end('{"status":"ok"}');
        if (q.url === '/config/update') {
          const b = JSON.parse(d);
          if (b.namespace === 'solana') { r.statusCode = 404; return r.end('{"message":"Namespace not found"}'); }
          return r.end('{"message":"ok"}');
        }
        if (q.url.startsWith('/chains/ethereum/status')) return r.end('{"rpcUrl":"https://node.example/v3/abcdef0123456789abcdef","currentBlockNumber":2000}');
        r.statusCode = 404; r.end('{}');
      });
    });
    return new Promise(res => srv.listen(port, '127.0.0.1', () => res(srv)));
  }
  const freePort = () => new Promise(res => { const s = httpMod2.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

  await test('rpc: Gateway agent uses the API when it answers and edits YAML (keeping comments) when it does not', async () => {
    const port = await freePort();
    const { conf } = fakeGatewayDir(port);
    const calls = [];
    const prevDev = process.env.DEV; process.env.DEV = 'true';
    try {
      const srv = await fakeGatewayApi(port, calls);
      const ups = [
        { namespace: 'ethereum-mainnet', path: 'nodeURL', value: 'https://a.example/x', file: 'chains/ethereum/mainnet.yml' },
        { namespace: 'solana', path: 'rpcProvider', value: 'helius', file: 'chains/solana.yml' },
      ];
      const r1 = await rpc.gatewayAgent({ action: 'push', confDir: conf, updates: ups });
      assert.ok(r1.ok && r1.api.reachable);
      assert.deepStrictEqual(r1.results.map(x => x.via), ['api', 'file'], 'API refusal falls back to the file');
      assert.ok(fs.readFileSync(path.join(conf, 'chains', 'solana.yml'), 'utf8').includes("rpcProvider: 'helius'"));
      assert.ok(calls.includes('POST /config/update'));
      srv.close();

      const r2 = await rpc.gatewayAgent({ action: 'push', confDir: conf, updates: [ups[0], { namespace: 'apiKeys', path: 'chainstack', value: "k'ey12345", file: 'apiKeys.yml', create: true }] });
      assert.ok(r2.ok && !r2.api.reachable && r2.restartNeeded);
      const net = fs.readFileSync(path.join(conf, 'chains', 'ethereum', 'mainnet.yml'), 'utf8');
      assert.ok(net.includes("nodeURL: 'https://a.example/x'") && net.startsWith('chainID: 1\n') && net.includes('nativeCurrencySymbol: ETH'));
      assert.ok(fs.readFileSync(path.join(conf, 'apiKeys.yml'), 'utf8').includes("chainstack: 'k''ey12345'"), 'appended & YAML-escaped');

      const rd = await rpc.gatewayAgent({ action: 'read', confDir: conf, networks: rpc.NETWORKS });
      assert.strictEqual(rd.read.networks['ethereum-mainnet'].nodeURL, 'https://a.example/x');
      assert.strictEqual(rd.read.chains.solana.rpcProvider, 'helius');
      assert.strictEqual(rd.read.networks['ethereum-base'].present, false);
      assert.strictEqual(rd.read.apiKeys.chainstack, "k'ey…345");
    } finally { if (prevDev === undefined) delete process.env.DEV; else process.env.DEV = prevDev; }
  });

  await test('rpc: push tests the endpoint, runs the agent in the container, restarts and verifies', async () => {
    const port = await freePort();
    const { dir, conf } = fakeGatewayDir(port);
    const calls = [];
    const srv = await fakeGatewayApi(port, calls);
    const node = await fakeNode({ chainId: 1, head: 2000 });
    const dockerCalls = [];
    const host = {
      name: 'Test PC',
      dockerRaw: (args) => {
        dockerCalls.push(args[0]);
        if (args[0] === 'ps') return Promise.resolve({ code: 0, stdout: 'hb_base|hummingbot/hummingbot:2.14.0|running|Up\ngateway|hummingbot/gateway:latest|running|Up 2 hours\n', stderr: '' });
        if (args[0] === 'restart') return Promise.resolve({ code: 0, stdout: 'gateway', stderr: '' });
        if (args[0] === 'exec') {
          // run exactly what `docker exec gateway node -e <code> <payload>` would run
          return new Promise(res => execFile2(process.execPath, args.slice(3), { cwd: dir, env: { ...process.env, DEV: 'true' }, timeout: 30000 }, (e, out, err) => res({ code: e ? 1 : 0, stdout: out, stderr: err })));
        }
        return Promise.resolve({ code: 1, stdout: '', stderr: 'unexpected' });
      },
    };
    try {
      const { updateConfig } = require('../lib/config');
      updateConfig(c => { c.rpc = { ...rpc.settings(c), networks: {} }; });
      const added = rpc.addEndpoint({ network: 'ethereum-mainnet', url: node.url + '/v3/abcdef0123456789abcdef', label: 'Mine' });
      const d = { getHost: () => host, sleep: async () => {} };
      const rec = await rpc.pushToGateway({ target: 'local', includeKeys: false }, d);
      assert.ok(rec.ok, JSON.stringify(rec.results));
      assert.strictEqual(rec.container, 'gateway');
      assert.ok(rec.restarted && rec.verify['ethereum-mainnet'].ok && rec.verify['ethereum-mainnet'].block === 2000);
      assert.ok(!JSON.stringify(rec).includes('0123456789'), 'no API key in the push record');
      assert.deepStrictEqual(rec.results.map(x => x.namespace), ['ethereum-mainnet', 'ethereum', 'solana']);
      assert.ok(dockerCalls.includes('restart'));

      const st = await rpc.gatewayStatus('local', d);
      assert.ok(st.running && st.networks['ethereum-mainnet'].present);

      // A failing active endpoint blocks the push unless forced
      node.srv.close();
      updateConfig(c => { const r = rpc.settings(c); r.networks['ethereum-mainnet'].active = added.id; c.rpc = r; });
      await assert.rejects(rpc.pushToGateway({ target: 'local' }, d), /failed its check/);
      // A provider without a key is refused
      updateConfig(c => { const r = rpc.settings(c); r.chainProvider.solana = 'helius'; c.rpc = r; });
      await assert.rejects(rpc.pushToGateway({ target: 'local', force: true }, d), /no Helius API key/);
    } finally { srv.close(); try { node.srv.close(); } catch (_) {} }
  });

  // ─── Remote access ────────────────────────────────────────────────────────
  const remote = require('../lib/remote');
  await test('remote: passwords hash with scrypt and TOTP matches the RFC 6238 vector (no replay)', () => {
    const h = remote.hashPassword('correct horse battery');
    assert.ok(h.startsWith('scrypt$') && remote.verifyPassword('correct horse battery', h) && !remote.verifyPassword('nope', h));
    const secret = remote.base32Encode(Buffer.from('12345678901234567890'));
    assert.strictEqual(secret, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    assert.strictEqual(remote.hotp(secret, 1), '287082');
    assert.strictEqual(remote.verifyTotp(secret, '287082', { now: 59000 }), 1);
    assert.strictEqual(remote.verifyTotp(secret, '287082', { now: 59000, lastStep: 1 }), 0, 'same code twice is refused');
    assert.strictEqual(remote.verifyTotp(secret, '000000', { now: 59000 }), 0);
  });

  await test('remote: tunnel listener demands a device token; link codes, roles, lockout and revoke work', async () => {
    const port = await freePort();
    process.env.REMOTE_PORT = String(port);
    const { updateConfig } = require('../lib/config');
    updateConfig(c => { c.apiToken = 'arb_legacy_static_token_123'; });
    remote.setPassword({ next: 'tunnel-pass-2026!' });
    remote.updateSettings({ enabled: true });
    await remote.syncListener(app);
    const call = (method, p, { token, body, headers = {} } = {}) => new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : null;
      const q = httpMod2.request({ host: '127.0.0.1', port, path: p, method, headers: { ...(data ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } }, r => {
        let d = ''; r.on('data', c => { d += c; }); r.on('end', () => { let j = {}; try { j = JSON.parse(d); } catch (_) {} resolve({ status: r.statusCode, body: j, headers: r.headers }); });
      });
      q.on('error', reject); if (data) q.write(data); q.end();
    });
    try {
      let r = await call('GET', '/api/health');
      assert.strictEqual(r.status, 401, 'no token, even though the request comes from localhost');
      assert.strictEqual(r.headers['x-frame-options'], 'DENY');
      r = await call('GET', '/api/health', { headers: { 'x-api-token': 'arb_legacy_static_token_123' } });
      assert.strictEqual(r.status, 401, 'the old static LAN token is not valid through the tunnel');
      r = await call('GET', '/api/remote/session');
      assert.ok(r.status === 200 && r.body.remote && !r.body.authenticated && r.body.passwordSet);

      // brute force: 5 wrong passwords from one client IP lock it, others still get in
      remote.resetLimits();
      for (let i = 0; i < 5; i++) {
        r = await call('POST', '/api/remote/login', { body: { password: 'wrong-guess-' + i }, headers: { 'cf-connecting-ip': '203.0.113.9' } });
        assert.strictEqual(r.status, 401);
      }
      r = await call('POST', '/api/remote/login', { body: { password: 'tunnel-pass-2026!' }, headers: { 'cf-connecting-ip': '203.0.113.9' } });
      assert.strictEqual(r.status, 429, 'locked even with the right password');
      r = await call('POST', '/api/remote/login', { body: { password: 'tunnel-pass-2026!', deviceName: 'Laptop' }, headers: { 'cf-connecting-ip': '198.51.100.4' } });
      assert.strictEqual(r.status, 200);
      const admin = r.body.token;
      const ticket = r.body.ticket;
      assert.ok(/^arbd_/.test(admin) && r.body.device.role === 'admin' && r.body.ticket);
      assert.ok(!JSON.stringify(remote.loadDevices()).includes(admin), 'only the hash is stored');

      r = await call('GET', '/api/health', { token: admin });
      assert.strictEqual(r.status, 200);
      r = await call('GET', '/api/mobile/pairing', { token: admin });
      assert.strictEqual(r.status, 403, 'pairing secrets never leave the PC');
      r = await call('GET', `/api/health?ticket=${encodeURIComponent(ticket)}`);
      assert.strictEqual(r.status, 401, 'stream tickets only open the alert stream');
      const stream = await new Promise((resolve, reject) => {
        const q = httpMod2.get({ host: '127.0.0.1', port, path: `/api/alerts/stream?ticket=${encodeURIComponent(ticket)}` }, res => { resolve(res.statusCode); res.destroy(); });
        q.on('error', e => (e.code === 'ECONNRESET' ? null : reject(e)));
      });
      assert.strictEqual(stream, 200, 'ticket opens the alert stream');

      // link code -> viewer device (read-only), single use
      r = await call('POST', '/api/remote/link-code', { token: admin, body: { role: 'viewer' } });
      assert.ok(r.status === 200 && /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(r.body.code) && r.body.qrApp.startsWith('data:image/png'));
      const code = r.body.code;
      r = await call('POST', '/api/remote/link', { body: { code: code.toLowerCase().replace('-', ' '), deviceName: 'Pixel 9' } });
      assert.ok(r.status === 200 && r.body.device.role === 'viewer');
      const viewer = r.body.token;
      r = await call('POST', '/api/remote/link', { body: { code } });
      assert.strictEqual(r.status, 401, 'a code works once');
      r = await call('GET', '/api/config', { token: viewer });
      assert.strictEqual(r.status, 200);
      r = await call('POST', '/api/guard/settings', { token: viewer, body: {} });
      assert.strictEqual(r.status, 403);
      r = await call('GET', '/api/remote/status', { token: viewer });
      assert.strictEqual(r.status, 403);

      // remote password change needs the current password
      r = await call('POST', '/api/remote/password', { token: admin, body: { next: 'another-pass-2026' } });
      assert.strictEqual(r.status, 401);

      // revoke + idle expiry
      const vid = remote.loadDevices().find(d => d.role === 'viewer').id;
      r = await call('DELETE', `/api/remote/devices/${vid}`, { token: admin });
      assert.strictEqual(r.status, 200);
      r = await call('GET', '/api/health', { token: viewer });
      assert.strictEqual(r.status, 401);
      const fsx = require('fs'); const devFile = path.join(process.env.ARB_DATA_DIR, 'remote_devices.json');
      const list = JSON.parse(fsx.readFileSync(devFile, 'utf8')); list[0].lastSeenAt = Date.now() - 31 * 86400000; fsx.writeFileSync(devFile, JSON.stringify(list));
      r = await call('GET', '/api/health', { token: admin });
      assert.strictEqual(r.status, 401, 'idle device expired');

      // local listener still works with the LAN token, and turning remote off closes the door
      const local = await invokeApp('GET', '/api/remote/session');
      assert.strictEqual(local.body.remote, false);
      remote.updateSettings({ enabled: false });
      await remote.syncListener(app);
      await assert.rejects(call('GET', '/api/health'), /ECONNREFUSED/);
    } finally {
      await remote.stopListener();
      updateConfig(c => { c.apiToken = ''; });
      delete process.env.REMOTE_PORT;
    }
  });

  await test('remote: authenticator code is required once enabled', async () => {
    remote.resetLimits();
    const { secret } = remote.totpSetup();
    remote.totpEnable(remote.hotp(secret, Math.floor(Date.now() / 30000)));
    assert.throws(() => remote.login({ password: 'tunnel-pass-2026!', ip: '1.1.1.1' }), e => e.needsTotp === true);
    const step = Math.floor(Date.now() / 30000) + 1; // next code (current one was used to enable)
    const ok = remote.login({ password: 'tunnel-pass-2026!', totp: remote.hotp(secret, step), ip: '1.1.1.1' });
    assert.ok(ok.token);
    assert.throws(() => remote.login({ password: 'tunnel-pass-2026!', totp: remote.hotp(secret, step), ip: '1.1.1.1' }), /Authenticator code is wrong/);
    remote.totpDisable();
    remote.resetLimits();
  });

  console.log(`\nCompleted: ${passed} test(s) passed.\n`);
})();
