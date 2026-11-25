// ─── Canonical ticker mapping ─────────────────────────────────────────────────
// Exchanges don't always use the same ticker for the same coin, and sometimes use
// the SAME ticker for DIFFERENT coins. Every listing is converted to one canonical
// symbol before two exchanges are compared, and converted back to the exchange's
// own symbol for order books and Hummingbot markets.
//
// Verified 2026-11-25 against each exchange's coin names and live prices
// (see the Ticker Audit in the Cross-Check tab to re-run it).

// Exchange-native ticker -> canonical ticker
const ALIASES = {
  kraken: {
    XBT: 'BTC',
    XDG: 'DOGE',
    LUNA: 'LUNC',   // Kraken "LUNA" is Terra Classic ($0.00004), LUNC everywhere else
    LUNA2: 'LUNA',  // Kraken "LUNA2" is Terra 2.0, LUNA everywhere else
  },
  okx: {
    EDGE: 'EDGEX',  // edgeX; Kraken/Coinbase "EDGE" is a different coin (Definitive)
    LIT: 'LIGHTER', // Lighter; Kraken/Coinbase "LIT" is Litentry
  },
  kucoin: {
    EDGE: 'EDGEX',
    LIT: 'LIGHTER',
  },
};

// Hummingbot's Kraken connector already shows XBT/XDG as BTC/DOGE, so its
// markets use the canonical name for these; every other alias uses the native one.
const HB_TRANSLATES = { kraken: new Set(['XBT', 'XDG']) };

// Same ticker as a different coin elsewhere, with no matching counterpart.
// These listings are never compared across exchanges.
const KNOWN_COLLISIONS = {
  kraken: {
    ONE: 'Kraken ONE (~$0.12) is not Harmony ONE (~$0.001 on Binance, OKX, KuCoin)',
    INIT: 'Kraken INIT (~$0.06) differs from Initia INIT on Binance/KuCoin (~$0.085)',
    SUP: 'Kraken SUP (~$0.00015) is not Superfluid SUP on Coinbase (~$0.0025)',
    HONEY: 'Kraken HONEY price differs ~30% from Coinbase HONEY (Hivemapper); unverified',
    XMN: 'Kraken XMN price differs ~50% from KuCoin XMN; unverified',
  },
  binance: {
    AI: 'Binance AI is Sleepless AI, not Gensyn AI (Coinbase, Kraken, OKX, KuCoin)',
    ACE: 'Binance ACE trades ~2x OKX/KuCoin ACE',
  },
};

// Fiat currencies some exchanges list as "coins" (e.g. Kraken EUR/USD)
const FIAT = new Set(['EUR', 'GBP', 'AUD', 'CAD', 'CHF', 'JPY', 'TRY', 'BRL', 'MXN', 'SGD', 'HKD', 'KRW', 'ZAR', 'PLN', 'NZD', 'ARS', 'COP', 'IDR']);

const NATIVE = {}; // ex -> canonical -> native
for (const [ex, map] of Object.entries(ALIASES)) {
  NATIVE[ex] = {};
  for (const [nat, can] of Object.entries(map)) NATIVE[ex][can] = nat;
}

function canonical(ex, nativeSym) {
  const s = String(nativeSym || '').toUpperCase();
  return (ALIASES[ex] && ALIASES[ex][s]) || s;
}

// Canonical -> exchange-native. A canonical symbol whose native ticker was
// re-mapped to something else (e.g. OKX "EDGEX" doesn't exist; OKX "EDGE" is edgeX)
// still maps to itself; the exchange simply doesn't list it under that name.
function nativeSymbol(ex, canonicalSym) {
  const s = String(canonicalSym || '').toUpperCase();
  return (NATIVE[ex] && NATIVE[ex][s]) || s;
}

function hbSymbol(ex, canonicalSym) {
  const nat = nativeSymbol(ex, canonicalSym);
  return HB_TRANSLATES[ex] && HB_TRANSLATES[ex].has(nat) ? String(canonicalSym).toUpperCase() : nat;
}

// A native ticker that some other exchange's alias table claims, but that this
// exchange did not alias, is shadowed: e.g. Kraken "EDGE" (Definitive) must not be
// matched to OKX "EDGE" (edgeX, canonical EDGEX). Canonical keys keep them apart.
function knownCollision(ex, canonicalSym) {
  const nat = nativeSymbol(ex, canonicalSym);
  return (KNOWN_COLLISIONS[ex] && KNOWN_COLLISIONS[ex][nat]) || null;
}

module.exports = { ALIASES, HB_TRANSLATES, KNOWN_COLLISIONS, FIAT, canonical, nativeSymbol, hbSymbol, knownCollision };
