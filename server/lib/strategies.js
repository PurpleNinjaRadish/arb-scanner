// ─── Hummingbot strategy YAML generators & parser ─────────────────────────────
// Supports:
//   1. `amm_arb` — Cross-exchange arbitrage (works CEX<->CEX as well as CEX<->DEX)
//   2. `cross_exchange_market_making` (XEMM) — Maker limit orders hedged by Taker
//
// IMPORTANT Hummingbot v2.x units:
//   • `order_amount` is ALWAYS in BASE asset units (e.g. 0.01 BTC, 10 SOL), NOT USD.
//   • `min_profitability` in both Pydantic XEMM and amm_arb is in PERCENTAGE POINTS
//     (e.g. `0.5` means 0.5%, `1.0` means 1.0%) — NOT a decimal fraction.
const yaml = require('js-yaml');
const { EXCHANGES } = require('./exchanges');
const { hbSymbol, canonical } = require('./tickers');

// Each connector gets the pair as THAT exchange names it (e.g. Lighter is
// LIGHTER-USD on Kraken but LIT-USDT on OKX).
function hbPair(exKey, symbol, quote) {
  return `${hbSymbol(exKey, symbol)}-${String(quote).toUpperCase()}`;
}

function hbConnectorName(exKey, paperTrade = false) {
  const base = (EXCHANGES[exKey] && EXCHANGES[exKey].hbConnector) || exKey;
  return paperTrade ? `${base}_paper_trade` : base;
}

// Choose clean base-asset precision so Hummingbot & exchanges accept the order size
function formatBaseAmount(usdAmount, refPrice) {
  if (!refPrice || refPrice <= 0) return Number(usdAmount) || 1;
  const raw = usdAmount / refPrice;
  const decimals = raw >= 1000 ? 1 : raw >= 10 ? 3 : raw >= 1 ? 4 : raw >= 0.01 ? 5 : 6;
  return Number(raw.toFixed(decimals));
}

function buildAmmArbYaml({
  symbol, quote = 'USD', exA, exB,
  orderAmountBase, tradeSizeUsd, refPrice,
  minProfitabilityPct = 0.5,
  slippageBufferPct = 0.15,
  concurrentOrders = true,
  paperTrade = true,
  netProfitPreview = null,
}) {
  const c1 = hbConnectorName(exA, paperTrade);
  const c2 = hbConnectorName(exB, paperTrade);
  const pair = `${symbol.toUpperCase()}-${quote.toUpperCase()}`;
  const pair1 = hbPair(exA, symbol, quote);
  const pair2 = hbPair(exB, symbol, quote);
  const baseAmt = orderAmountBase > 0 ? Number(orderAmountBase) : formatBaseAmount(tradeSizeUsd || 500, refPrice);
  const minProf = Number(Math.max(Number(minProfitabilityPct) || 0.1, -10).toFixed(4));
  const slipBuf = Number(Math.max(Number(slippageBufferPct) || 0, 0).toFixed(4));

  const doc = {
    strategy: 'amm_arb',
    connector_1: c1,
    market_1: pair1,
    connector_2: c2,
    market_2: pair2,
    pool_id: '',
    order_amount: baseAmt,
    min_profitability: minProf,
    market_1_slippage_buffer: slipBuf,
    market_2_slippage_buffer: slipBuf,
    concurrent_orders_submission: !!concurrentOrders,
    debug_price_shim: false,
    gateway_transaction_cancel_interval: 600,
    rate_oracle_enabled: true,
    quote_conversion_rate: 1.0,
  };

  const header = [
    `# Hummingbot Cross-Exchange Arbitrage (amm_arb) — ARB SCANNER v3`,
    `# Pair: ${pair} | ${c1} (${pair1}) <-> ${c2} (${pair2})`,
    `# Mode: ${paperTrade ? 'PAPER TRADE (simulated)' : 'LIVE TRADING (real funds)'}`,
    `# Order Size: ${baseAmt} ${symbol.toUpperCase()}${refPrice ? ` (~$${(baseAmt * refPrice).toFixed(2)} ${quote} @ $${refPrice})` : ''}`,
    `# Min Profitability: ${minProf}% (percentage points) | Slippage Buffer: ${slipBuf}%`,
    netProfitPreview != null ? `# Snapshot Net Spread at Generation: ${Number(netProfitPreview).toFixed(4)}%` : null,
    `# Generated: ${new Date().toISOString()}`,
  ].filter(Boolean).join('\n') + '\n\n';

  return header + yaml.dump(doc, { lineWidth: -1, noRefs: true });
}

function buildXemmYaml({
  symbol, quote = 'USD', makerEx, takerEx,
  orderAmountBase, tradeSizeUsd, refPrice,
  minProfitabilityPct = 0.5,
  topDepthTolerance = 0.0,
  antiHysteresisDuration = 60.0,
  orderSizeTakerVolumeFactor = 25.0,
  orderSizeTakerBalanceFactor = 99.5,
  orderSizePortfolioRatioLimit = 30.0,
  adjustOrderEnabled = true,
  paperTrade = true,
  netProfitPreview = null,
}) {
  const mEx = hbConnectorName(makerEx, paperTrade);
  const tEx = hbConnectorName(takerEx, paperTrade);
  const pair = `${symbol.toUpperCase()}-${quote.toUpperCase()}`;
  const makerPair = hbPair(makerEx, symbol, quote);
  const takerPair = hbPair(takerEx, symbol, quote);
  const baseAmt = orderAmountBase > 0 ? Number(orderAmountBase) : formatBaseAmount(tradeSizeUsd || 500, refPrice);
  const minProf = Number(Math.max(Number(minProfitabilityPct) || 0.1, -10).toFixed(4));

  const doc = {
    strategy: 'cross_exchange_market_making',
    maker_market: mEx,
    taker_market: tEx,
    maker_market_trading_pair: makerPair,
    taker_market_trading_pair: takerPair,
    min_profitability: minProf,
    order_amount: baseAmt,
    adjust_order_enabled: !!adjustOrderEnabled,
    order_refresh_mode: {
      active_order_refresh: {},
    },
    top_depth_tolerance: Number(topDepthTolerance) || 0.0,
    anti_hysteresis_duration: Number(antiHysteresisDuration) || 60.0,
    order_size_taker_volume_factor: Number(orderSizeTakerVolumeFactor) || 25.0,
    order_size_taker_balance_factor: Number(orderSizeTakerBalanceFactor) || 99.5,
    order_size_portfolio_ratio_limit: Number(orderSizePortfolioRatioLimit) || 30.0,
    conversion_rate_mode: {
      rate_oracle_conversion_rate: {},
    },
    taker_to_maker_base_conversion_rate: 1.0,
    taker_to_maker_quote_conversion_rate: 1.0,
    slippage_buffer: 5.0,
    debug_csv_path: 'path_to_csv',
    min_order_amount: 0.0,
  };

  const header = [
    `# Hummingbot Cross-Exchange Market Making (XEMM) — ARB SCANNER v3`,
    `# Pair: ${pair} | Maker: ${mEx} (${makerPair}) -> Taker Hedge: ${tEx} (${takerPair})`,
    `# Mode: ${paperTrade ? 'PAPER TRADE (simulated)' : 'LIVE TRADING (real funds)'}`,
    `# Order Size: ${baseAmt} ${symbol.toUpperCase()}${refPrice ? ` (~$${(baseAmt * refPrice).toFixed(2)} ${quote} @ $${refPrice})` : ''}`,
    `# Min Profitability: ${minProf}% (percentage points)`,
    netProfitPreview != null ? `# Snapshot Net Spread at Generation: ${Number(netProfitPreview).toFixed(4)}%` : null,
    `# Generated: ${new Date().toISOString()}`,
  ].filter(Boolean).join('\n') + '\n\n';

  return header + yaml.dump(doc, { lineWidth: -1, noRefs: true });
}

function generateStrategyYaml(params) {
  const kind = params.strategy || 'amm_arb';
  if (kind === 'cross_exchange_market_making' || kind === 'xemm') {
    return buildXemmYaml({
      ...params,
      makerEx: params.makerEx || params.exA,
      takerEx: params.takerEx || params.exB,
    });
  }
  return buildAmmArbYaml(params);
}

// Extract structured metadata + validation warnings from any Hummingbot strategy YAML
function parseStrategyYaml(raw) {
  try {
    const doc = yaml.load(raw);
    if (!doc || typeof doc !== 'object') return { valid: false, error: 'Empty or non-object YAML' };
    const strategy = doc.strategy || 'unknown';
    const connectors = [];
    if (doc.connector_1) connectors.push(doc.connector_1);
    if (doc.connector_2) connectors.push(doc.connector_2);
    if (doc.maker_market) connectors.push(doc.maker_market);
    if (doc.taker_market) connectors.push(doc.taker_market);
    if (doc.exchange) connectors.push(doc.exchange);

    const pair = doc.market_1 || doc.maker_market_trading_pair || doc.market || '';
    const paper = connectors.some(c => String(c).endsWith('_paper_trade'));
    const paperBaseConnectors = connectors
      .filter(c => String(c).endsWith('_paper_trade'))
      .map(c => String(c).replace(/_paper_trade$/, ''));

    const warnings = [];
    if (doc.min_profitability != null && Number(doc.min_profitability) > 0 && Number(doc.min_profitability) < 0.02) {
      warnings.push(`min_profitability=${doc.min_profitability}% is very low (Hummingbot uses percentage points, e.g. 0.5 = 0.5%)`);
    }
    if (!doc.strategy) warnings.push('Missing `strategy` field');

    return {
      valid: true,
      strategy,
      connectors,
      pair,
      paper,
      paperBaseConnectors,
      orderAmount: doc.order_amount ?? null,
      minProfitability: doc.min_profitability ?? null,
      warnings,
      doc,
    };
  } catch (e) {
    return { valid: false, error: e.message };
  }
}

module.exports = {
  hbConnectorName,
  hbPair,
  formatBaseAmount,
  buildAmmArbYaml,
  buildXemmYaml,
  generateStrategyYaml,
  parseStrategyYaml,
};
