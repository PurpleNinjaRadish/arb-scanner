// ─── Live Executable Bid/Ask Arbitrage Scanner Tab ───────────────────────────
import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../api';
import { EXCHANGES, EXCHANGE_PAIRS, QUOTES, COIN_GROUPS, TRADE_SIZES, fmtPrice, fmtUsd, fmtVol } from '../constants';
import { C, S, Badge, MetricCard, ExBadge, PriceTick, Notice, Modal } from '../ui';
import AutoTradePanel from './AutoTradePanel';

const SORT_OPTS = [
  { k: 'netProfit', l: 'Net %' },
  { k: 'netDollar', l: 'Net $' },
  { k: 'spread',    l: 'Exec Spread' },
  { k: 'midSpread', l: 'Mid Spread' },
  { k: 'minVol',    l: '24h Volume' },
  { k: 'score',     l: 'Score' },
];

function VerifyFillModal({ opp, pair, quote, feeMode, onClose }) {
  const [latencyMs, setLatencyMs] = useState(250);
  const [loading, setLoading] = useState(false);
  const [res, setRes] = useState(null);
  const [err, setErr] = useState('');

  const runCheck = useCallback(async (ms) => {
    setLoading(true); setErr('');
    try {
      const data = await api('/api/paper-sim/verify', {
        method: 'POST',
        body: {
          exA: pair.a, exB: pair.b, symbol: opp.symbol, quote,
          tradeSize: opp.tradeSize, feeMode, simulatedLatencyMs: ms,
          predictedBuyOn: opp.buyOn, predictedSellOn: opp.sellOn,
          predictedBuyPrice: opp.buyPrice, predictedSellPrice: opp.sellPrice,
          predictedNetDollar: opp.netDollar,
        },
      });
      setRes(data);
    } catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  }, [pair.a, pair.b, opp, quote, feeMode]);

  useEffect(() => { runCheck(latencyMs); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Modal
      title={`L2 ORDER-BOOK ACCURACY CHECK · ${opp.symbol}-${quote}`}
      subtitle={`Walks real depth on ${EXCHANGES[opp.buyOn]?.label} (Asks) & ${EXCHANGES[opp.sellOn]?.label} (Bids) for ${fmtUsd(opp.tradeSize, 0)}`}
      onClose={onClose}
      maxWidth={680}
    >
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', marginBottom: 14, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 180 }}>
          <label style={S.lbl}>Simulated Execution Latency (ms)</label>
          <input type="number" min="0" max="5000" step="50" style={S.inp} value={latencyMs} onChange={e => setLatencyMs(Number(e.target.value) || 0)} />
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {[50, 250, 600, 1200].map(ms => (
            <button key={ms} className="tbtn" onClick={() => { setLatencyMs(ms); runCheck(ms); }}
              style={latencyMs === ms ? S.btn(C.cyan, true) : S.btnMuted}>{ms}ms</button>
          ))}
        </div>
        <button className="tbtn" disabled={loading} onClick={() => runCheck(latencyMs)} style={S.btn(C.green, true)}>
          {loading ? 'Walking Books...' : '↻ Re-Test Now'}
        </button>
      </div>

      {err && <Notice tone="error">✗ {err}</Notice>}
      {loading && !res && <div style={{ padding: 30, textAlign: 'center', color: C.muted }}>Waiting {latencyMs}ms then fetching L2 order books...</div>}

      {res && (
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 14 }}>
            <MetricCard label="Signal Survived" value={res.accuracy.stillProfitable ? 'YES' : 'NO'} color={res.accuracy.stillProfitable ? C.green : C.red} />
            <MetricCard label="Actual Net $" value={`${res.actual.netDollar >= 0 ? '+' : ''}${fmtUsd(res.actual.netDollar)}`} sub={`${res.actual.netPct.toFixed(3)}%`} color={res.actual.netDollar >= 0 ? C.green : C.red} />
            <MetricCard label="Price Drift" value={`${res.accuracy.totalDriftBps.toFixed(1)} bps`} sub={`Book impact ${res.accuracy.bookImpactBps.toFixed(1)} bps`} color={res.accuracy.totalDriftBps > 15 ? C.red : C.yellow} />
            <MetricCard label="Processing" value={`${res.totalProcessingMs} ms`} sub={`Book fetch ${res.bookFetchMs} ms`} color={C.cyan} />
          </div>

          <div style={{ ...S.card, marginBottom: 12 }}>
            <div style={S.sectionTitle}>Predicted (T0 Scanner) vs Real L2 Fill (T1 After {res.simulatedLatencyMs}ms)</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, fontSize: 12 }}>
              <div><div style={S.lbl}>Predicted Buy Ask</div>{fmtPrice(res.predicted?.buyPrice)}</div>
              <div><div style={S.lbl}>Actual Buy VWAP ({res.actual.buyLevels} lvls)</div><span style={{ color: C.cyan }}>{fmtPrice(res.actual.buyVwap)}</span></div>
              <div><div style={S.lbl}>Buy Depth (±25bps)</div>{fmtUsd(res.accuracy.buyDepth25bpsUsd, 0)}</div>
              <div><div style={S.lbl}>Predicted Sell Bid</div>{fmtPrice(res.predicted?.sellPrice)}</div>
              <div><div style={S.lbl}>Actual Sell VWAP ({res.actual.sellLevels} lvls)</div><span style={{ color: C.cyan }}>{fmtPrice(res.actual.sellVwap)}</span></div>
              <div><div style={S.lbl}>Sell Depth (±25bps)</div>{fmtUsd(res.accuracy.sellDepth25bpsUsd, 0)}</div>
              <div><div style={S.lbl}>Predicted Net</div>{fmtUsd(res.predicted?.netDollar)}</div>
              <div><div style={S.lbl}>Actual Net (after {fmtUsd(res.actual.feeDollar)} fees)</div><span style={{ color: res.actual.netDollar >= 0 ? C.green : C.red }}>{fmtUsd(res.actual.netDollar)}</span></div>
              <div><div style={S.lbl}>Profit Delta</div><span style={{ color: (res.accuracy.profitErrorDollar || 0) >= 0 ? C.green : C.red }}>{fmtUsd(res.accuracy.profitErrorDollar)}</span></div>
            </div>
          </div>
          {!res.actual.complete && <Notice tone="warn">Order book did not have enough liquidity within top 100 levels to fill the full {fmtUsd(res.tradeSize, 0)}.</Notice>}
        </div>
      )}
    </Modal>
  );
}

export default function ScannerTab({
  hosts = [],
  activePairId, setActivePairId, quote, setQuote,
  tradeSize, setTradeSize, onDeploy, onProject,
}) {
  const [activeGroup, setActiveGroup] = useState('All Common');
  const [feeMode, setFeeMode] = useState('taker_taker'); // 'taker_taker' | 'maker_taker'
  const [slippageBps, setSlippageBps] = useState(5);
  const [viableOnly, setViableOnly] = useState(false);
  const [bookOnly, setBookOnly] = useState(false);
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState('netProfit');
  const [isLive, setIsLive] = useState(false);
  const [status, setStatus] = useState('idle');
  const [errMsg, setErrMsg] = useState('');
  const [meta, setMeta] = useState(null);
  const [opps, setOpps] = useState([]);
  const [prevPrices, setPrevPrices] = useState({});
  const [selected, setSelected] = useState(null);
  const [verifyOpp, setVerifyOpp] = useState(null);
  const [fetchCount, setFetchCount] = useState(0);
  const [lastUpdate, setLastUpdate] = useState(null);

  const oppsRef = useRef([]);
  const activePair = EXCHANGE_PAIRS.find(p => p.id === activePairId) || EXCHANGE_PAIRS[0];

  const doScan = useCallback(async () => {
    setStatus('loading');
    try {
      const coins = COIN_GROUPS[activeGroup];
      const data = await api('/api/scan', {
        params: {
          pair: activePairId,
          quote,
          coins: coins ? coins.join(',') : '',
          tradeSize,
          slippageBps,
          feeMode,
        },
      });
      const prevMap = {};
      oppsRef.current.forEach(o => { prevMap[o.symbol] = { a: o.priceA, b: o.priceB }; });
      setPrevPrices(prevMap);
      oppsRef.current = data.opportunities || [];
      setOpps(oppsRef.current);
      setMeta(data.meta || null);
      setFetchCount(n => n + 1);
      setLastUpdate(new Date());
      setStatus('live');
      setErrMsg('');
    } catch (e) {
      setStatus('error');
      setErrMsg(e.message);
    }
  }, [activePairId, quote, activeGroup, tradeSize, slippageBps, feeMode]);

  useEffect(() => {
    if (!isLive) return undefined;
    doScan();
    const iv = setInterval(doScan, 12000);
    return () => clearInterval(iv);
  }, [isLive, doScan]);

  const selectPair = (p) => {
    setActivePairId(p.id);
    if (p.defaultQuote) setQuote(p.defaultQuote);
    setOpps([]);
    oppsRef.current = [];
    setStatus('idle');
    setIsLive(false);
  };

  const filtered = opps
    .filter(o => !viableOnly || o.isViable)
    .filter(o => !bookOnly || !o.estimated)
    .filter(o => !search || o.symbol.includes(search.toUpperCase()))
    .sort((a, b) => (b[sortKey] ?? -Infinity) - (a[sortKey] ?? -Infinity));

  const viableCount = opps.filter(o => o.isViable).length;
  const bestNet = opps.length ? Math.max(...opps.map(o => o.netProfit)) : 0;
  const bestDollar = opps.length ? Math.max(...opps.map(o => o.netDollar)) : 0;
  const exErrors = meta && meta.errors ? Object.entries(meta.errors).filter(([, v]) => v) : [];

  return (
    <div>
      <AutoTradePanel hosts={hosts} />
      {verifyOpp && (
        <VerifyFillModal opp={verifyOpp} pair={activePair} quote={quote} feeMode={feeMode} onClose={() => setVerifyOpp(null)} />
      )}

      {/* Top Controls Card */}
      <div style={{ ...S.card, marginBottom: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginBottom: 12 }}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            {EXCHANGE_PAIRS.map(p => (
              <button key={p.id} className="tbtn" onClick={() => selectPair(p)}
                style={activePairId === p.id ? S.btn(C.blue, true) : S.btnMuted}>
                {p.priority ? '★ ' : ''}{p.label}
              </button>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button className="tbtn" onClick={() => setIsLive(v => !v)}
              style={S.btn(isLive ? C.yellow : C.green, true)}>
              {isLive ? '⏸ Pause Live' : '▶ Start Live Scan'}
            </button>
            <button className="tbtn" onClick={doScan} disabled={status === 'loading'} style={S.btn(C.blue)}>
              {status === 'loading' ? '⟳ Scanning...' : '↻ Scan Once'}
            </button>
            {lastUpdate && <span style={{ fontSize: 10, color: C.dim }}>#{fetchCount} · {lastUpdate.toLocaleTimeString()}</span>}
          </div>
        </div>

        {/* Row 2: Quote, Fee Mode, Trade Size, Slippage, Coin Group */}
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div>
            <span style={S.lbl}>Quote Currency</span>
            <div style={{ display: 'flex', gap: 4 }}>
              {QUOTES.map(q => (
                <button key={q} className="tbtn" onClick={() => setQuote(q)}
                  style={quote === q ? S.btn(C.cyan, true) : S.btnMuted}>{q}</button>
              ))}
            </div>
          </div>

          <div>
            <span style={S.lbl}>Fee Mode</span>
            <div style={{ display: 'flex', gap: 4 }}>
              <button className="tbtn" onClick={() => setFeeMode('taker_taker')}
                style={feeMode === 'taker_taker' ? S.btn(C.purple, true) : S.btnMuted}>Taker+Taker</button>
              <button className="tbtn" onClick={() => setFeeMode('maker_taker')}
                style={feeMode === 'maker_taker' ? S.btn(C.green, true) : S.btnMuted}>XEMM Maker+Taker</button>
            </div>
          </div>

          <div>
            <span style={S.lbl}>Trade Size</span>
            <div style={{ display: 'flex', gap: 4 }}>
              {TRADE_SIZES.map(sz => (
                <button key={sz} className="tbtn" onClick={() => setTradeSize(sz)}
                  style={tradeSize === sz ? S.btn(C.yellow, true) : S.btnMuted}>
                  ${sz >= 1000 ? `${sz / 1000}k` : sz}
                </button>
              ))}
            </div>
          </div>

          <div style={{ width: 95 }}>
            <span style={S.lbl}>Slippage (bps)</span>
            <input type="number" min="0" max="100" step="1" style={S.inp} value={slippageBps}
              onChange={e => setSlippageBps(Math.max(0, Number(e.target.value) || 0))} />
          </div>

          <div style={{ flex: 1, minWidth: 150 }}>
            <span style={S.lbl}>Search Coin</span>
            <input style={S.inp} placeholder="BTC, SOL, XRP..." value={search} onChange={e => setSearch(e.target.value)} />
          </div>
        </div>

        {/* Row 3: Coin groups + Filters */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginTop: 12, paddingTop: 10, borderTop: `1px solid ${C.border}` }}>
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
            {Object.keys(COIN_GROUPS).map(g => (
              <button key={g} className="tbtn" onClick={() => setActiveGroup(g)}
                style={activeGroup === g ? S.btn(C.cyan, true) : S.btnMuted}>{g}</button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <label style={{ fontSize: 11, color: C.muted, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5 }}>
              <input type="checkbox" checked={viableOnly} onChange={e => setViableOnly(e.target.checked)} /> Viable Only
            </label>
            <label style={{ fontSize: 11, color: C.muted, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5 }}>
              <input type="checkbox" checked={bookOnly} onChange={e => setBookOnly(e.target.checked)} /> Confirmed Book Only
            </label>
            <span style={{ fontSize: 10, color: C.dim }}>Sort:</span>
            {SORT_OPTS.map(o => (
              <button key={o.k} className="tbtn" onClick={() => setSortKey(o.k)}
                style={{ ...(sortKey === o.k ? S.btn(C.blue, true) : S.btnMuted), padding: '4px 8px', fontSize: 10 }}>{o.l}</button>
            ))}
          </div>
        </div>
      </div>

      {/* Warnings / Errors */}
      {errMsg && <Notice tone="error">⚠ Scanner error: {errMsg}</Notice>}
      {exErrors.length > 0 && (
        <Notice tone="warn">
          {exErrors.map(([ex, msg]) => `${EXCHANGES[ex]?.label || ex}: ${msg}`).join('\n')}
          {'\n'}Tip: US IPs cannot reach Binance.com / Bybit directly — use Kraken × Coinbase (USD) or Binance.US × Kraken, or deploy on an EU/AP VPS.
        </Notice>
      )}

      {/* Summary Metrics */}
      {meta && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
          <MetricCard label="Overlapping Pairs" value={meta.coinsMatched} sub={`${EXCHANGES[activePair.a]?.short}: ${meta.coinsAvailable?.[activePair.a] || 0} · ${EXCHANGES[activePair.b]?.short}: ${meta.coinsAvailable?.[activePair.b] || 0} (${quote})`} />
          <MetricCard label="Book Refined" value={`${meta.refined || 0} top`} sub="Live Ask/Bid verified" color={C.cyan} />
          {meta.excluded && meta.excluded.length > 0 && (
            <MetricCard label="Tickers Excluded" value={meta.excluded.length}
              sub={`${meta.excluded.slice(0, 4).map(x => x.symbol).join(', ')}${meta.excluded.length > 4 ? '…' : ''} — see 🔤 Ticker Audit`}
              color={C.yellow} />
          )}
          <MetricCard label="Viable Net > 0" value={viableCount} color={viableCount > 0 ? C.green : C.muted} />
          <MetricCard label="Best Net %" value={`${bestNet >= 0 ? '+' : ''}${bestNet.toFixed(3)}%`} sub={`Break-even ~${opps[0]?.breakevenPct.toFixed(2) || '—'}%`} color={bestNet > 0 ? C.green : C.yellow} />
          <MetricCard label={`Best Net (${fmtUsd(tradeSize, 0)})`} value={`${bestDollar >= 0 ? '+' : ''}${fmtUsd(bestDollar)}`} color={bestDollar > 0 ? C.green : C.red} />
          {meta.health && (
            <MetricCard
              label="API Latency"
              value={`${meta.health[activePair.a]?.latencyMs || '—'} / ${meta.health[activePair.b]?.latencyMs || '—'} ms`}
              sub={`${EXCHANGES[activePair.a]?.short} / ${EXCHANGES[activePair.b]?.short}`}
              color={C.blue}
            />
          )}
        </div>
      )}

      {/* Empty / Idle states */}
      {status === 'idle' && opps.length === 0 && (
        <div style={{ ...S.card, textAlign: 'center', padding: '44px 24px' }}>
          <div style={{ fontSize: 30, marginBottom: 10 }}>📡</div>
          <div style={{ fontFamily: "'Orbitron', sans-serif", fontSize: 14, color: C.blue, letterSpacing: 2, marginBottom: 8 }}>
            EXECUTABLE ASK / BID ARBITRAGE SCANNER
          </div>
          <div style={{ fontSize: 12, color: C.muted, maxWidth: 560, margin: '0 auto 18px', lineHeight: 1.7 }}>
            Computes true executable spreads (Buy at Ask, Sell at Bid) with live top-of-book refinement, 24h liquidity, real exchange fees, and 1-click L2 order-book verification.
            {activePairId === 'kraken_coinbase' && quote === 'USD' && ' Using USD quote gives 10× more liquid pairs across Kraken & Coinbase than USDT.'}
          </div>
          <button className="tbtn" onClick={() => setIsLive(true)} style={S.btn(C.green, true)}>
            ▶ Start Live Scanning ({activePair.label} · {quote})
          </button>
        </div>
      )}

      {status === 'loading' && opps.length === 0 && (
        <div style={{ ...S.card, textAlign: 'center', padding: '44px 24px', color: C.muted }}>
          <div style={{ fontSize: 26, animation: 'spin 1s linear infinite', display: 'inline-block', marginBottom: 10 }}>⟳</div>
          <div>Fetching bulk tickers & refining top-of-book quotes for {activePair.label} ({quote})...</div>
        </div>
      )}

      {status !== 'idle' && status !== 'loading' && filtered.length === 0 && (
        <div style={{ ...S.card, textAlign: 'center', padding: '36px 24px', color: C.muted }}>
          No pairs match the current filter ({opps.length} scanned). Try unchecking "Viable Only", switching Quote to USD, or adjusting Fee Mode / Fees in Servers & Settings.
        </div>
      )}

      {/* Table */}
      {filtered.length > 0 && (
        <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, overflowX: 'auto' }}>
          <div style={{ minWidth: 980 }}>
            <div style={{
              display: 'grid',
              gridTemplateColumns: '115px 108px 108px 82px 82px 92px 135px 82px 210px',
              padding: '10px 14px', background: '#04070e', borderBottom: `1px solid ${C.border}`,
              fontSize: 9, color: C.muted, letterSpacing: 1.5, textTransform: 'uppercase', gap: 6,
            }}>
              <span>Pair</span>
              <span>{EXCHANGES[activePair.a]?.short} Bid/Ask</span>
              <span>{EXCHANGES[activePair.b]?.short} Bid/Ask</span>
              <span>Exec Sprd</span>
              <span>Net %</span>
              <span>Net {fmtUsd(tradeSize, 0)}</span>
              <span>Route (Buy → Sell)</span>
              <span>Min 24h Vol</span>
              <span>Actions</span>
            </div>

            {filtered.slice(0, 120).map((o, idx) => {
              const pp = prevPrices[o.symbol] || {};
              const isSel = selected === o.symbol;
              return (
                <div key={o.symbol}>
                  <div className="trow" onClick={() => setSelected(isSel ? null : o.symbol)} style={{
                    display: 'grid',
                    gridTemplateColumns: '115px 108px 108px 82px 82px 92px 135px 82px 210px',
                    padding: '9px 14px', gap: 6, alignItems: 'center', fontSize: 11,
                    background: isSel ? C.panelAlt : idx % 2 === 0 ? C.panel : '#060b14',
                    borderBottom: `1px solid #0b1424`,
                    borderLeft: `3px solid ${o.isViable ? C.green : 'transparent'}`,
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                      <span style={{ fontFamily: "'Orbitron', sans-serif", fontWeight: 700, fontSize: 12, color: o.isViable ? '#e2f1ff' : C.text }}>{o.symbol}</span>
                      <Badge color={o.estimated ? C.dim : C.cyan} title={o.estimated ? 'Last-trade estimate (click Test Fill for live book)' : 'Confirmed Bid/Ask'}>
                        {o.estimated ? 'EST' : 'BOOK'}
                      </Badge>
                    </div>

                    <div style={{ fontSize: 10, lineHeight: 1.4 }}>
                      <div><PriceTick value={o.bidA} prev={pp.a} /></div>
                      <div style={{ color: C.dim }}>{fmtPrice(o.askA)}</div>
                    </div>

                    <div style={{ fontSize: 10, lineHeight: 1.4 }}>
                      <div><PriceTick value={o.bidB} prev={pp.b} /></div>
                      <div style={{ color: C.dim }}>{fmtPrice(o.askB)}</div>
                    </div>

                    <div style={{ color: o.spread > 0.3 ? C.yellow : o.spread > 0 ? C.blue : C.dim, fontWeight: 600 }}>
                      {o.spread >= 0 ? '+' : ''}{o.spread.toFixed(3)}%
                    </div>

                    <div style={{ color: o.netProfit > 0 ? C.green : C.red, fontWeight: 600 }}>
                      {o.netProfit >= 0 ? '+' : ''}{o.netProfit.toFixed(3)}%
                    </div>

                    <div style={{ color: o.netDollar > 0 ? C.green : C.red, fontWeight: 600 }}>
                      {o.netDollar >= 0 ? '+' : ''}{fmtUsd(o.netDollar)}
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                      <ExBadge name={o.buyOn} symbol={o.symbol} quote={quote} />
                      <span style={{ color: C.dim }}>→</span>
                      <ExBadge name={o.sellOn} symbol={o.symbol} quote={quote} />
                    </div>

                    <div style={{ fontSize: 10, color: o.minVol && o.minVol > 500000 ? C.cyan : C.muted }}>
                      {fmtVol(o.minVol)}
                    </div>

                    <div style={{ display: 'flex', gap: 4 }} onClick={e => e.stopPropagation()}>
                      <button className="tbtn" onClick={() => setVerifyOpp(o)} title="Walk real L2 order books + latency test"
                        style={{ ...S.btn(C.cyan), padding: '4px 7px', fontSize: 10 }}>🧪 Fill</button>
                      <button className="tbtn" onClick={() => onProject(o)} title="Open Profitability Projections"
                        style={{ ...S.btn(C.yellow), padding: '4px 7px', fontSize: 10 }}>📈</button>
                      <button className="tbtn" onClick={() => onDeploy(o)} title="Deploy Hummingbot Strategy"
                        style={{ ...S.btn(o.isViable ? C.green : C.blue, o.isViable), padding: '4px 8px', fontSize: 10 }}>🤖 Bot</button>
                    </div>
                  </div>

                  {isSel && (
                    <div style={{ padding: '12px 16px', background: '#050a14', borderBottom: `1px solid ${C.border}`, fontSize: 11 }}>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(145px, 1fr))', gap: 8, marginBottom: 10 }}>
                        {[
                          ['Buy @ Ask', `${fmtPrice(o.buyPrice)} (${EXCHANGES[o.buyOn]?.label})`],
                          ['Sell @ Bid', `${fmtPrice(o.sellPrice)} (${EXCHANGES[o.sellOn]?.label})`],
                          ['Mid Spread', `${o.midSpread.toFixed(3)}%`],
                          ['Exec Spread (Ask→Bid)', `${o.spread.toFixed(3)}%`],
                          ['Total Fees', `-${o.feePct.toFixed(3)}% (${fmtUsd(o.feeDollar)})`],
                          ['Slippage Buffer', `-${o.slippagePct.toFixed(3)}%`],
                          ['Break-Even Spread', `${o.breakevenPct.toFixed(3)}%`],
                          ['Base Order Amount', `${o.coinsTraded.toFixed(o.coinsTraded >= 10 ? 3 : 6)} ${o.symbol}`],
                        ].map(([k, v]) => (
                          <div key={k} style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 6, padding: '7px 10px' }}>
                            <div style={{ fontSize: 9, color: C.dim, textTransform: 'uppercase', letterSpacing: 1 }}>{k}</div>
                            <div style={{ marginTop: 3, color: C.text }}>{v}</div>
                          </div>
                        ))}
                      </div>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button className="tbtn" onClick={() => setVerifyOpp(o)} style={S.btn(C.cyan)}>🧪 Live L2 Order-Book Fill Test</button>
                        <button className="tbtn" onClick={() => onProject(o)} style={S.btn(C.yellow)}>📈 Cost & Profit Projections</button>
                        <button className="tbtn" onClick={() => onDeploy(o)} style={S.btn(C.green, true)}>🤖 Deploy Hummingbot ({o.symbol}-{quote})</button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
