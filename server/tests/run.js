// ─── Backend Unit & Integration Tests (zero external network required) ───────
const assert = require('assert');
const { evaluate } = require('../lib/scanner');
const { vwapFill } = require('../lib/exchanges');
const { generateStrategyYaml, parseStrategyYaml, formatBaseAmount } = require('../lib/strategies');
const { safeRel, safeName, shq } = require('../lib/hosts');
const { validateServer, DEFAULT_FEES } = require('../lib/config');
const { calcBotCapacity, recommendServers, projectProfitability } = require('../lib/advisor');
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

  console.log(`\nCompleted: ${passed} test(s) passed.\n`);
})();
