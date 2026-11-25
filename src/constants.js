// ─── Exchange Metadata, Pairs & Presets ──────────────────────────────────────
export const EXCHANGES = {
  kraken:    { label: 'Kraken',       short: 'KRK', color: '#7a63ff', hbConnector: 'kraken' },
  coinbase:  { label: 'Coinbase Adv', short: 'CB',  color: '#2e7bff', hbConnector: 'coinbase_advanced_trade' },
  binance:   { label: 'Binance',      short: 'BIN', color: '#f0b90b', hbConnector: 'binance' },
  binanceus: { label: 'Binance.US',   short: 'BUS', color: '#e5a900', hbConnector: 'binance_us' },
  kucoin:    { label: 'KuCoin',       short: 'KUC', color: '#00c48c', hbConnector: 'kucoin' },
  bybit:     { label: 'Bybit',        short: 'BYB', color: '#f7a600', hbConnector: 'bybit' },
  okx:       { label: 'OKX',          short: 'OKX', color: '#9ab0c9', hbConnector: 'okx' },
};

export const EXCHANGE_PAIRS = [
  { id: 'kraken_coinbase', a: 'kraken',    b: 'coinbase', label: 'Kraken × Coinbase',  defaultQuote: 'USD',  priority: true },
  { id: 'binanceus_kraken',a: 'binanceus', b: 'kraken',   label: 'Binance.US × Kraken',defaultQuote: 'USD',  priority: true },
  { id: 'binance_kraken',  a: 'binance',   b: 'kraken',   label: 'Binance × Kraken',   defaultQuote: 'USDT', priority: false },
  { id: 'bybit_kraken',    a: 'bybit',     b: 'kraken',   label: 'Bybit × Kraken',     defaultQuote: 'USDT', priority: false },
  { id: 'okx_coinbase',    a: 'okx',       b: 'coinbase', label: 'OKX × Coinbase',     defaultQuote: 'USDT', priority: false },
  { id: 'kucoin_kraken',   a: 'kucoin',    b: 'kraken',   label: 'KuCoin × Kraken',    defaultQuote: 'USDT', priority: false },
];

export const QUOTES = ['USD', 'USDT', 'USDC'];

export const COIN_GROUPS = {
  'All Common': null, // dynamically scans EVERY overlapping pair between the two exchanges!
  'Majors':  ['BTC', 'ETH', 'SOL', 'XRP', 'ADA', 'DOGE', 'AVAX', 'LINK', 'DOT', 'LTC', 'BCH', 'XLM'],
  'Layer 1': ['SOL', 'AVAX', 'ATOM', 'NEAR', 'ALGO', 'APT', 'SUI', 'SEI', 'TIA', 'ICP', 'HBAR', 'TON'],
  'Layer 2': ['ARB', 'OP', 'POL', 'IMX', 'STRK', 'ZK', 'MNT'],
  'DeFi':    ['LINK', 'UNI', 'AAVE', 'CRV', 'LDO', 'SNX', 'COMP', 'MKR', 'SUSHI', 'PENDLE', 'ONDO', 'ENA', 'JUP'],
  'AI/Data': ['FET', 'GRT', 'RENDER', 'WLD', 'TAO', 'FIL', 'AR', 'PYTH', 'VIRTUAL'],
  'Memes':   ['DOGE', 'SHIB', 'PEPE', 'BONK', 'WIF', 'FLOKI', 'PENGU', 'TRUMP', 'FARTCOIN'],
};

export const TRADE_SIZES = [250, 500, 1000, 2500, 5000, 10000];

export function getTradeUrl(exchange, symbol, quote = 'USD') {
  const s = symbol.toUpperCase();
  const q = quote.toUpperCase();
  switch (exchange) {
    case 'kraken':    return `https://pro.kraken.com/app/trade/${s}-${q}`;
    case 'coinbase':  return `https://www.coinbase.com/advanced-trade/spot/${s}-${q}`;
    case 'binance':   return `https://www.binance.com/en/trade/${s}_${q}`;
    case 'binanceus': return `https://www.binance.us/spot-trade/${s}_${q}`;
    case 'kucoin':    return `https://www.kucoin.com/trade/${s}-${q}`;
    case 'bybit':     return `https://www.bybit.com/trade/spot/${s}/${q}`;
    case 'okx':       return `https://www.okx.com/trade-spot/${s.toLowerCase()}-${q.toLowerCase()}`;
    default: return '#';
  }
}

export function fmtUsd(n, decimals = 2) {
  if (n == null || Number.isNaN(n)) return '—';
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}

export function fmtPrice(v) {
  if (v == null || Number.isNaN(v)) return '—';
  if (v < 0.001) return `$${v.toFixed(7)}`;
  if (v < 0.1)   return `$${v.toFixed(5)}`;
  if (v < 10)    return `$${v.toFixed(4)}`;
  if (v < 1000)  return `$${v.toFixed(3)}`;
  return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function fmtVol(v) {
  if (!v) return '—';
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}k`;
  return `$${v.toFixed(0)}`;
}
