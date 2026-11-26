// ─── AI Reviewer: a second opinion on blocked targets ─────────────────────────
// Gathers evidence (live prices on every exchange, order books, deposit /
// withdrawal status, status-page incidents, the ticker audit, scanner history)
// and asks an LLM whether a blocked target is real and tradeable.
//
// The model only supplies a judgement. Whether that judgement may override a
// block is decided here, in code:
//   • It can override the judgement calls: a venue far from the reference price,
//     an implausibly wide gap, scanner/book drift, thin history, and the monthly
//     projection (a one-off opportunity).
//   • It can never override: missing or crossed order books, insufficient depth,
//     a known different coin sharing the ticker, a per-trade LOSS on live books,
//     or the live guard rails.
//   • Live trades need allowLive; approvals expire after validMin minutes; the
//     order size is capped.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const { EXCHANGES } = require('./exchanges');
const { nativeSymbol } = require('./tickers');
const { loadConfig, updateConfig, DEFAULT_AI_REVIEW } = require('./config');

const DATA_DIR = process.env.ARB_DATA_DIR || path.join(__dirname, '..', 'data');
const LOG_FILE = path.join(DATA_DIR, 'ai_reviews.json');
const LIVE_PHRASE = 'AI CAN APPROVE LIVE';
const http = axios.create({ timeout: 8000, headers: { 'User-Agent': 'arb-scanner/3' } });

// Checks the AI may override, and those it never may
const SOFT_CHECKS = new Set(['reference', 'plausible_gap', 'ticker_vs_book', 'scanner_agreement', 'history']);

const STATUS_PAGES = {
  kraken: 'https://status.kraken.com/api/v2/summary.json',
  coinbase: 'https://status.coinbase.com/api/v2/summary.json',
};

function settings(cfg = loadConfig()) {
  const s = { ...DEFAULT_AI_REVIEW, ...(cfg.aiReview || {}) };
  const envKey = s.provider === 'openai' ? process.env.OPENAI_API_KEY : process.env.ANTHROPIC_API_KEY;
  return { ...s, apiKey: s.apiKey || envKey || '' };
}
function publicSettings(cfg = loadConfig()) {
  const s = settings(cfg);
  const { apiKey, ...rest } = s;
  return { ...rest, hasApiKey: !!apiKey, livePhrase: LIVE_PHRASE };
}

let log = null;
function reviews() {
  if (!log) { try { log = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); } catch (_) { log = []; } }
  return log;
}
function saveLog() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(LOG_FILE, JSON.stringify(reviews().slice(0, 200), null, 2)); }
  catch (e) { console.error('aiReview: log write failed:', e.message); }
}

// ─── Evidence ────────────────────────────────────────────────────────────────
async function fundingStatus(ex, sym, quote) {
  const nat = nativeSymbol(ex, sym);
  try {
    if (ex === 'kraken') {
      const r = await http.get('https://api.kraken.com/0/public/Assets', { params: { asset: nat } });
      const a = Object.values((r.data && r.data.result) || {})[0];
      return a ? { assetStatus: a.status, note: 'enabled = deposits and withdrawals on; deposit_only / withdrawal_only / funding_temporarily_disabled mean transfers are restricted' } : { error: 'asset not found' };
    }
    if (ex === 'coinbase') {
      const [c, p] = await Promise.all([
        http.get(`https://api.exchange.coinbase.com/currencies/${nat}`).then(r => r.data).catch(e => ({ error: e.message })),
        http.get(`https://api.exchange.coinbase.com/products/${nat}-${quote}`).then(r => r.data).catch(e => ({ error: e.message })),
      ]);
      return {
        currencyStatus: c.status || c.error, message: c.message || '',
        confirmations: c.details && c.details.network_confirmations,
        networks: (c.supported_networks || []).map(n => ({ id: n.id, status: n.status })),
        product: p.error ? { error: p.error } : { status: p.status, trading_disabled: p.trading_disabled, cancel_only: p.cancel_only, status_message: p.status_message },
      };
    }
    if (ex === 'kucoin') {
      const r = await http.get(`https://api.kucoin.com/api/v3/currencies/${nat}`);
      const d = r.data && r.data.data;
      return d ? { chains: (d.chains || []).map(c => ({ chain: c.chainName, deposit: c.isDepositEnabled, withdraw: c.isWithdrawEnabled, confirms: c.confirms })) } : { error: 'currency not found' };
    }
    return { note: `${EXCHANGES[ex].label} does not publish deposit/withdrawal status without API keys` };
  } catch (e) {
    return { error: e.response ? `HTTP ${e.response.status}` : e.message };
  }
}

async function statusPage(ex, sym) {
  const url = STATUS_PAGES[ex];
  if (!url) return null;
  try {
    const d = (await http.get(url)).data;
    const s = sym.toLowerCase();
    const mentions = (t) => new RegExp(`\\b${s}\\b|\\(${s}\\)`, 'i').test(t || '');
    return {
      overall: d.status && d.status.description,
      incidents: (d.incidents || []).filter(i => mentions(i.name) || (i.incident_updates || []).some(u => mentions(u.body)))
        .map(i => ({ name: i.name, status: i.status, updated: i.updated_at, latest: ((i.incident_updates || [])[0] || {}).body })),
      components: (d.components || []).filter(c => mentions(c.name)).map(c => ({ name: c.name, status: c.status })),
      otherOpenIncidents: (d.incidents || []).length,
    };
  } catch (e) {
    return { error: e.response ? `HTTP ${e.response.status}` : e.message };
  }
}

async function collectEvidence({ symbol, quote, exA, exB, strategy, tradeSize, target, alert }) {
  const guard = require('./guard');
  const tickerAudit = require('./tickerAudit');
  const [check, fA, fB, sA, sB] = await Promise.all([
    guard.runCrossCheck({ symbol, quote, exA, exB, strategy, tradeSize, target, record: false }),
    fundingStatus(exA, symbol, quote), fundingStatus(exB, symbol, quote),
    statusPage(exA, symbol), statusPage(exB, symbol),
  ]);
  const audit = tickerAudit.cachedAudit();
  const auditRow = audit ? audit.symbols.find(x => x.symbol === symbol) : null;
  const stats = guard.statsForCoin(exA, exB, quote, symbol);
  return {
    check,
    evidence: {
      target: { symbol, quote, exchanges: [exA, exB].map(e => EXCHANGES[e].label), strategy, orderSizeUsd: tradeSize, nowUtc: new Date().toISOString() },
      alert: alert ? { netPct: alert.netProfitPct, buyOn: alert.buyOn, sellOn: alert.sellOn, buyPrice: alert.buyPrice, sellPrice: alert.sellPrice, at: new Date(alert.ts).toISOString() } : null,
      safetyChecks: check.checks.map(c => ({ id: c.id, status: c.status, label: c.label, detail: c.detail })),
      blockedBy: check.blockers,
      prices: check.prices.map(p => ({ exchange: p.label, bookBid: p.bookBid, bookAsk: p.bookAsk, bookSpreadPct: p.bookSpreadPct, scannerMid: p.tickerMid, pctFromReference: p.refDevPct })),
      referencePrices: check.reference,
      perTrade: check.perTrade,
      monthly: check.monthly,
      funding: { [EXCHANGES[exA].label]: fA, [EXCHANGES[exB].label]: fB },
      statusPages: { [EXCHANGES[exA].label]: sA, [EXCHANGES[exB].label]: sB },
      tickerAudit: auditRow ? Object.fromEntries(Object.entries(auditRow.listings).map(([e, l]) => [EXCHANGES[e]?.label || e, { ticker: l.native, usd: l.usd, status: l.status }])) : 'not yet run',
      scannerHistory: stats.coin ? { observedHours: stats.observedHours, opportunitiesPerHour: stats.coin.episodesPerHour, avgNetPct: stats.coin.avgNetViable } : { observedHours: stats.observedHours, note: 'no history for this coin' },
    },
  };
}

// ─── Model call ──────────────────────────────────────────────────────────────
const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['tradeable', 'not_tradeable', 'uncertain'] },
    confidence: { type: 'number', description: '0 to 1' },
    same_asset: { type: 'boolean', description: 'Both exchanges list the same coin' },
    prices_genuine: { type: 'boolean', description: 'The prices are live, executable quotes, not stale or broken data' },
    executable_with_inventory: { type: 'boolean', description: 'A bot already holding the coin on the sell exchange and cash on the buy exchange can capture the spread at this size' },
    gap_cause: { type: 'string', description: 'Most likely reason the gap exists' },
    transfer_status: { type: 'string', description: 'What is known about deposits/withdrawals and transfer times on both exchanges' },
    key_risks: { type: 'array', items: { type: 'string' } },
    recommended_max_order_usd: { type: 'number' },
    summary: { type: 'string', description: 'Two or three sentences for the user' },
  },
  required: ['verdict', 'confidence', 'same_asset', 'prices_genuine', 'executable_with_inventory', 'gap_cause', 'transfer_status', 'key_risks', 'recommended_max_order_usd', 'summary'],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `You review cross-exchange crypto arbitrage targets that a bot's automatic safety checks blocked.
Decide whether the target is real and tradeable by a Hummingbot arbitrage bot that already holds inventory on both exchanges (coin on the sell side, cash on the buy side), so no transfer is needed to execute one round.
Judge from the evidence. Be skeptical: a large gap on a liquid coin usually means suspended deposits/withdrawals, a delisting, different coins sharing a ticker, stale data, or a thin book about to move.
Use what you know about the coin and exchanges (e.g. long confirmation times, recent forks or migrations), but say when you are relying on background knowledge rather than the evidence.
"tradeable" means: same coin, genuine live prices, and the per-trade result after fees is positive at the given size. Otherwise answer "not_tradeable" or "uncertain".
confidence is a number from 0 to 1. recommended_max_order_usd must not exceed the order size given.`;

async function callModel(s, evidence) {
  if (!s.apiKey && !(s.provider === 'openai' && s.baseUrl)) throw Object.assign(new Error('No AI API key set (Cross-Check → AI Reviewer)'), { status: 400 });
  const user = `Review this blocked arbitrage target. Evidence (JSON):\n${JSON.stringify(evidence, null, 1)}`;
  if (s.provider === 'anthropic') {
    const r = await axios.post(`${s.baseUrl || 'https://api.anthropic.com'}/v1/messages`, {
      model: s.model, max_tokens: 2000, system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: user }],
      output_config: { format: { type: 'json_schema', schema: VERDICT_SCHEMA } },
    }, { timeout: 90000, headers: { 'x-api-key': s.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } });
    if (r.data.stop_reason === 'refusal') throw new Error('The model declined to review this target');
    if (r.data.stop_reason === 'max_tokens') throw new Error('The model response was cut off');
    const text = (r.data.content || []).find(b => b.type === 'text');
    return { raw: text && text.text, usage: r.data.usage };
  }
  // OpenAI and OpenAI-compatible servers (LM Studio, Ollama, vLLM)
  const r = await axios.post(`${(s.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '')}/chat/completions`, {
    model: s.model,
    messages: [
      { role: 'system', content: `${SYSTEM_PROMPT}\nRespond with ONLY a JSON object with exactly these keys: ${VERDICT_SCHEMA.required.join(', ')}.` },
      { role: 'user', content: user },
    ],
    response_format: { type: 'json_object' },
  }, { timeout: 120000, headers: { ...(s.apiKey ? { authorization: `Bearer ${s.apiKey}` } : {}), 'content-type': 'application/json' } });
  return { raw: r.data.choices && r.data.choices[0] && r.data.choices[0].message.content, usage: r.data.usage };
}

// Validate the model's JSON ourselves; anything malformed counts as "uncertain"
function parseVerdict(raw, tradeSize) {
  let v;
  try { v = JSON.parse(String(raw || '').replace(/^```(json)?|```$/g, '').trim()); } catch (_) { return null; }
  const verdict = String(v.verdict || '').toLowerCase().replace(/\s+/g, '_');
  const conf = Number(v.confidence);
  return {
    verdict: ['tradeable', 'not_tradeable', 'uncertain'].includes(verdict) ? verdict : 'uncertain',
    confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf > 1 ? conf / 100 : conf)) : 0,
    sameAsset: v.same_asset === true,
    pricesGenuine: v.prices_genuine === true,
    executableWithInventory: v.executable_with_inventory === true,
    gapCause: String(v.gap_cause || ''),
    transferStatus: String(v.transfer_status || ''),
    keyRisks: Array.isArray(v.key_risks) ? v.key_risks.map(String).slice(0, 8) : [],
    recommendedMaxOrderUsd: Math.max(0, Math.min(Number(v.recommended_max_order_usd) || 0, Number(tradeSize) || Infinity)),
    summary: String(v.summary || ''),
  };
}

// ─── Policy (code decides, not the model) ───────────────────────────────────
function applyPolicy(verdict, check, s, live) {
  const reasons = [];
  const hardFails = check.checks.filter(c => c.status === 'fail' && !SOFT_CHECKS.has(c.id));
  if (!s.enabled) reasons.push('AI reviewer is turned off');
  if (!verdict) reasons.push('The model did not return a valid verdict');
  else {
    if (verdict.verdict !== 'tradeable') reasons.push(`AI verdict: ${verdict.verdict.replace('_', ' ')}`);
    if (verdict.confidence < s.minConfidence) reasons.push(`AI confidence ${verdict.confidence.toFixed(2)} is below ${s.minConfidence}`);
    if (!verdict.sameAsset) reasons.push('AI could not confirm it is the same coin on both exchanges');
    if (!verdict.pricesGenuine) reasons.push('AI could not confirm the prices are genuine');
    if (!verdict.executableWithInventory) reasons.push('AI does not think it can be executed');
  }
  if (hardFails.length) reasons.push(`Hard checks failed (never overridable): ${hardFails.map(c => c.label).join('; ')}`);
  if (!check.perTrade.pass) reasons.push(`Not profitable per trade on live books: ${check.perTrade.reason}`);
  if (live && !s.allowLive) reasons.push('AI approvals are paper-only (allow live in AI Reviewer settings)');
  const overridden = check.checks.filter(c => c.status === 'fail' && SOFT_CHECKS.has(c.id)).map(c => c.label);
  if (!check.monthly.pass) overridden.push('Monthly projection (treated as a one-off opportunity)');
  const maxOrderUsd = Math.min(s.maxOrderUsd, verdict && verdict.recommendedMaxOrderUsd > 0 ? verdict.recommendedMaxOrderUsd : s.maxOrderUsd);
  return { approved: reasons.length === 0, reasons, overrides: overridden, maxOrderUsd: Math.round(maxOrderUsd * 100) / 100 };
}

// ─── Review ──────────────────────────────────────────────────────────────────
async function review({ symbol, quote = 'USD', exA, exB, strategy = 'amm_arb', tradeSize = 1000, target = 'local', live = false, alert = null, source = 'manual' }, deps = {}) {
  const s = settings();
  if (!s.enabled) throw Object.assign(new Error('AI reviewer is turned off (Cross-Check → AI Reviewer)'), { status: 400 });
  const sym = String(symbol || '').toUpperCase();
  const q = String(quote).toUpperCase();
  const hourAgo = Date.now() - 3600 * 1000;
  if (reviews().filter(r => r.at >= hourAgo && !r.cached).length >= s.maxPerHour) {
    throw Object.assign(new Error(`AI review limit reached (${s.maxPerHour} per hour)`), { status: 429 });
  }

  const { check, evidence } = await (deps.collectEvidence || module.exports.collectEvidence)({ symbol: sym, quote: q, exA, exB, strategy, tradeSize, target, alert });
  let verdict = null, usage = null, error = null;
  try {
    const out = await (deps.callModel || module.exports.callModel)(s, evidence);
    usage = out.usage || null;
    verdict = parseVerdict(out.raw, tradeSize);
  } catch (e) {
    error = e.response ? `${s.provider} HTTP ${e.response.status}: ${(e.response.data && (e.response.data.error && (e.response.data.error.message || e.response.data.error))) || ''}` : e.message;
  }
  const policy = applyPolicy(verdict, check, s, live);
  if (error) policy.reasons.unshift(`AI call failed: ${error}`), policy.approved = false;

  const rec = {
    id: `ai_${crypto.randomBytes(5).toString('hex')}`,
    at: Date.now(), source, target, live,
    pair: `${sym}-${q}`, symbol: sym, quote: q, exA, exB, strategy, tradeSize,
    provider: s.provider, model: s.model,
    verdict, error, usage,
    policy,
    check: {
      allowed: check.allowed, dataOk: check.dataOk,
      failed: check.checks.filter(c => c.status === 'fail').map(c => c.id),
      netPct: check.perTrade.netPct ?? null, netDollar: check.perTrade.netDollar ?? null,
      buyOn: check.perTrade.buyOn, sellOn: check.perTrade.sellOn,
      monthlyNet: check.monthly.monthlyNet, refPrice: check.refPrice,
    },
  };
  reviews().unshift(rec);
  saveLog();
  return rec;
}

// Called by the deploy gate: may this AI review stand in for a manual override now?
function validateForGate(reviewId, check, info) {
  const s = settings();
  const rec = reviews().find(r => r.id === reviewId);
  if (!rec) return { ok: false, reason: 'AI review not found' };
  if (!s.enabled) return { ok: false, reason: 'AI reviewer is turned off' };
  if (Date.now() - rec.at > s.validMin * 60000) return { ok: false, reason: `AI approval expired (older than ${s.validMin} min)` };
  if (rec.pair !== `${info.symbol}-${info.quote}`) return { ok: false, reason: 'AI review was for a different coin' };
  if (![info.exA, info.exB].every(e => [rec.exA, rec.exB].includes(e))) return { ok: false, reason: 'AI review was for different exchanges' };
  if (!!rec.live !== !!info.live) return { ok: false, reason: `AI review was for ${rec.live ? 'live' : 'paper'} trading` };
  if (!rec.policy.approved) return { ok: false, reason: `AI did not approve: ${rec.policy.reasons[0] || 'not tradeable'}` };
  // Re-apply the hard rules to the fresh check made at launch
  const now = applyPolicy(rec.verdict, check, s, info.live);
  if (!now.approved) return { ok: false, reason: `Conditions changed since the AI review: ${now.reasons[0]}` };
  const notional = check.refPrice ? info.baseAmount * check.refPrice : null;
  if (notional != null && notional > rec.policy.maxOrderUsd * 1.05) {
    return { ok: false, reason: `Order ~$${notional.toFixed(2)} is above the AI-approved max of $${rec.policy.maxOrderUsd}` };
  }
  return { ok: true, review: rec };
}

function updateSettings(patch = {}) {
  const cur = settings();
  if (patch.allowLive === true && !cur.allowLive && String(patch.confirmPhrase || '').trim().toUpperCase() !== LIVE_PHRASE) {
    throw Object.assign(new Error(`Type ${LIVE_PHRASE} to let AI approvals launch live bots`), { status: 400 });
  }
  const num = (v, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : undefined; };
  const limits = { minConfidence: [0.5, 1], maxOrderUsd: [10, 1e6], maxRuntimeMin: [5, 1440], maxPerHour: [1, 500], validMin: [1, 60] };
  updateConfig(c => {
    c.aiReview = { ...DEFAULT_AI_REVIEW, ...(c.aiReview || {}) };
    const a = c.aiReview;
    for (const k of ['enabled', 'autoOverride', 'allowLive']) if (patch[k] !== undefined) a[k] = !!patch[k];
    if (patch.provider === 'anthropic' || patch.provider === 'openai') a.provider = patch.provider;
    if (typeof patch.model === 'string' && patch.model.trim()) a.model = patch.model.trim();
    if (typeof patch.baseUrl === 'string') a.baseUrl = patch.baseUrl.trim();
    if (typeof patch.apiKey === 'string' && patch.apiKey.trim()) a.apiKey = patch.apiKey.trim();
    if (patch.clearApiKey) a.apiKey = '';
    for (const [k, [lo, hi]] of Object.entries(limits)) {
      if (patch[k] !== undefined && patch[k] !== '') { const n = num(patch[k], lo, hi); if (n !== undefined) a[k] = n; }
    }
  });
  return publicSettings();
}

// Small round trip to confirm the key, model and endpoint work
async function testConnection() {
  const s = settings();
  const out = await callModel({ ...s }, { test: 'Connection test. Return verdict "uncertain", confidence 0, all booleans false, empty strings, empty risks, 0 for order size, summary "ok".' });
  const v = parseVerdict(out.raw, 0);
  return { ok: !!v, provider: s.provider, model: s.model, sample: v };
}

module.exports = {
  review, validateForGate, applyPolicy, parseVerdict, collectEvidence, callModel,
  settings, publicSettings, updateSettings, testConnection,
  list: () => reviews().slice(0, 50).map(r => ({ ...r })),
  SOFT_CHECKS, LIVE_PHRASE, VERDICT_SCHEMA,
  _reset: () => { log = []; },
};
