// ─── Easy Paper Mode & Processing Accuracy Lab ───────────────────────────────
// Tests real profitability AND scanner processing accuracy by re-checking every
// signal against LIVE L2 order books after a configurable execution latency delay.
import { useState, useEffect, useCallback } from 'react';
import { api } from '../api';
import { EXCHANGES, EXCHANGE_PAIRS, QUOTES, fmtUsd, fmtPrice } from '../constants';
import { C, S, Badge, MetricCard, Notice, Sparkline } from '../ui';

const LATENCY_PRESETS = [
  { ms: 50,   label: '50ms (AWS/Hetzner VPS)' },
  { ms: 250,  label: '250ms (Fast Home)' },
  { ms: 600,  label: '600ms (Typical Home/VPN)' },
  { ms: 1200, label: '1200ms (Slow / Congested)' },
];

export default function PaperLabTab({ activePairId, quote, onSendToProjections, onOpenHummingbotPaper }) {
  const pairObj = EXCHANGE_PAIRS.find(p => p.id === activePairId) || EXCHANGE_PAIRS[0];
  const [exPair, setExPair] = useState(pairObj.id);
  const [qCur, setQCur] = useState(quote || 'USD');
  const [tradeSize, setTradeSize] = useState(500);
  const [startBal, setStartBal] = useState(5000);
  const [minNetPct, setMinNetPct] = useState(0.05);
  const [latencyMs, setLatencyMs] = useState(250);
  const [pollSec, setPollSec] = useState(12);
  const [feeMode, setFeeMode] = useState('maker_taker'); // 'maker_taker' | 'taker_taker'
  const [abortOnDecay, setAbortOnDecay] = useState(true);
  const [autoRebalance, setAutoRebalance] = useState(true);

  const [state, setState] = useState({ active: false, session: null, derived: null });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const d = await api('/api/paper-sim/state');
      setState(d);
    } catch (_) {}
  }, []);

  useEffect(() => {
    refresh();
    const iv = setInterval(refresh, 4000);
    return () => clearInterval(iv);
  }, [refresh]);

  const startSession = async () => {
    setBusy(true); setMsg(null);
    const p = EXCHANGE_PAIRS.find(x => x.id === exPair) || EXCHANGE_PAIRS[0];
    try {
      const d = await api('/api/paper-sim/start', {
        method: 'POST',
        body: {
          exA: p.a, exB: p.b, quote: qCur,
          tradeSize, startingBalancePerEx: startBal,
          minNetProfitPct: minNetPct, simulatedLatencyMs: latencyMs,
          pollIntervalMs: pollSec * 1000, feeMode, abortOnDecay, autoRebalance,
        },
      });
      setState(d);
      setMsg({ tone: 'ok', text: `Paper trading session started (${p.label} · ${qCur}) with ${latencyMs}ms simulated execution latency.` });
    } catch (e) { setMsg({ tone: 'error', text: e.message }); }
    finally { setBusy(false); }
  };

  const control = async (endpoint, body) => {
    setBusy(true); setMsg(null);
    try {
      const d = await api(`/api/paper-sim/${endpoint}`, { method: 'POST', body });
      setState(d);
    } catch (e) { setMsg({ tone: 'error', text: e.message }); }
    finally { setBusy(false); }
  };

  const s = state.session;
  const der = state.derived;

  return (
    <div>
      {/* Header Explanation + Shortcuts */}
      <div style={{ ...S.card, marginBottom: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12, marginBottom: 14 }}>
          <div>
            <div style={S.sectionTitle}>Built-In Paper Mode & Processing Accuracy Lab</div>
            <div style={{ fontSize: 11, color: C.muted, maxWidth: 680, lineHeight: 1.65 }}>
              Runs zero-risk paper trades directly against <b>live exchange L2 order books</b>. For every detected arbitrage signal, the engine waits your configured execution latency, walks real book depth on both venues for your trade size, and reports <b>realized P&L</b>, <b>signal survival %</b>, <b>slippage drift (bps)</b>, and <b>profit capture accuracy</b>.
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {der && der.avgDriftBps != null && onSendToProjections && (
              <button className="tbtn" onClick={() => onSendToProjections({
                captureRatePct: Math.round(der.signalSurvivalPct ?? 70),
                slippageBps: Math.max(1, Math.round(Math.abs(der.avgDriftBps))),
                tradesPerDayPerBot: Math.max(1, Number((der.tradesPerDayRate || 5).toFixed(1))),
                tradeSize: s.config.tradeSize,
                capital: der.startingEquity,
              })} style={S.btn(C.yellow, true)}>
                📈 Use Measured Accuracy in Projections →
              </button>
            )}
            {onOpenHummingbotPaper && (
              <button className="tbtn" onClick={onOpenHummingbotPaper} style={S.btn(C.cyan)}>
                🐳 Hummingbot Docker Paper Config →
              </button>
            )}
          </div>
        </div>

        {/* Config Form */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginBottom: 12 }}>
          <div>
            <label style={S.lbl}>Exchange Pair</label>
            <select style={S.inp} value={exPair} onChange={e => setExPair(e.target.value)}>
              {EXCHANGE_PAIRS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </div>
          <div>
            <label style={S.lbl}>Quote</label>
            <select style={S.inp} value={qCur} onChange={e => setQCur(e.target.value)}>
              {QUOTES.map(q => <option key={q} value={q}>{q}</option>)}
            </select>
          </div>
          <div>
            <label style={S.lbl}>Order Size ({qCur})</label>
            <input type="number" style={S.inp} min="25" step="50" value={tradeSize} onChange={e => setTradeSize(Number(e.target.value) || 100)} />
          </div>
          <div>
            <label style={S.lbl}>Virtual Balance / Ex</label>
            <input type="number" style={S.inp} min="100" step="500" value={startBal} onChange={e => setStartBal(Number(e.target.value) || 1000)} />
          </div>
          <div>
            <label style={S.lbl}>Min Trigger Net %</label>
            <input type="number" style={S.inp} step="0.05" value={minNetPct} onChange={e => setMinNetPct(parseFloat(e.target.value) || 0)} />
          </div>
          <div>
            <label style={S.lbl}>Fee Mode</label>
            <select style={S.inp} value={feeMode} onChange={e => setFeeMode(e.target.value)}>
              <option value="maker_taker">XEMM Maker+Taker</option>
              <option value="taker_taker">Taker+Taker (amm_arb)</option>
            </select>
          </div>
          <div>
            <label style={S.lbl}>Poll Interval (sec)</label>
            <input type="number" style={S.inp} min="5" max="120" value={pollSec} onChange={e => setPollSec(Math.max(5, Number(e.target.value) || 12))} />
          </div>
        </div>

        {/* Latency & toggles */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12, paddingTop: 10, borderTop: `1px solid ${C.border}` }}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontSize: 10, color: C.muted, textTransform: 'uppercase', letterSpacing: 1 }}>Exec Latency:</span>
            {LATENCY_PRESETS.map(p => (
              <button key={p.ms} className="tbtn" onClick={() => setLatencyMs(p.ms)}
                style={{ ...(latencyMs === p.ms ? S.btn(C.cyan, true) : S.btnMuted), fontSize: 10, padding: '4px 8px' }}>
                {p.label}
              </button>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap', fontSize: 11, color: C.muted }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
              <input type="checkbox" checked={abortOnDecay} onChange={e => setAbortOnDecay(e.target.checked)} />
              Abort if spread decays during latency
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
              <input type="checkbox" checked={autoRebalance} onChange={e => setAutoRebalance(e.target.checked)} />
              Assume pre-positioned inventory
            </label>
          </div>
        </div>

        {/* Action buttons */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 14 }}>
          <button className="tbtn" disabled={busy} onClick={startSession} style={S.btn(C.green, true)}>
            ▶ {s ? 'Start Fresh Paper Session' : 'Start Paper Trading Session'}
          </button>
          {s && s.running && (
            <button className="tbtn" disabled={busy} onClick={() => control('stop')} style={S.btn(C.yellow, true)}>⏸ Pause Session</button>
          )}
          {s && !s.running && (
            <button className="tbtn" disabled={busy} onClick={() => control('resume')} style={S.btn(C.blue, true)}>▶ Resume Session</button>
          )}
          {s && (
            <>
              <button className="tbtn" disabled={busy} onClick={() => control('tick', { forceTestTop: true })} style={S.btn(C.cyan, true)}>
                ⚡ Force L2 Accuracy Check on Top Pair Now
              </button>
              <button className="tbtn" disabled={busy} onClick={() => control('reset')} style={S.btn(C.red)}>🗑 Reset</button>
            </>
          )}
        </div>
      </div>

      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      {s?.lastError && <Notice tone="warn">Last tick note: {s.lastError}</Notice>}

      {/* Active Session Scorecard */}
      {s && der && (
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginBottom: 14 }}>
            <MetricCard
              label="Session Status"
              value={s.running ? 'RUNNING' : 'PAUSED'}
              sub={`${s.tickCount} scans · ${s.config.exA.toUpperCase()}↔${s.config.exB.toUpperCase()}`}
              color={s.running ? C.green : C.yellow}
            />
            <MetricCard
              label="Simulated Net P&L"
              value={`${s.stats.actualProfitTotal >= 0 ? '+' : ''}${fmtUsd(s.stats.actualProfitTotal)}`}
              sub={`ROI ${der.roiPct >= 0 ? '+' : ''}${der.roiPct.toFixed(3)}% · Fees ${fmtUsd(s.stats.totalFees)}`}
              color={s.stats.actualProfitTotal >= 0 ? C.green : C.red}
            />
            <MetricCard
              label="Signal Survival Rate"
              value={der.signalSurvivalPct != null ? `${der.signalSurvivalPct.toFixed(1)}%` : '—'}
              sub={`${s.stats.filledTrades} filled · ${s.stats.decayedSignals} decayed`}
              color={der.signalSurvivalPct >= 60 ? C.green : der.signalSurvivalPct != null ? C.yellow : C.muted}
            />
            <MetricCard
              label="Avg Slippage Drift"
              value={der.avgDriftBps != null ? `${der.avgDriftBps.toFixed(1)} bps` : '—'}
              sub={der.avgBookImpactBps != null ? `L2 depth impact: ${der.avgBookImpactBps.toFixed(1)} bps` : 'Predicted vs L2 VWAP'}
              color={der.avgDriftBps != null && der.avgDriftBps > 15 ? C.red : C.cyan}
            />
            <MetricCard
              label="Avg Processing Time"
              value={der.avgProcessingMs != null ? `${der.avgProcessingMs} ms` : '—'}
              sub={`Incl. ${s.config.simulatedLatencyMs}ms sim delay`}
              color={C.blue}
            />
            <MetricCard
              label="Smart vs Blind P&L"
              value={fmtUsd(s.stats.blindExecutionProfitTotal)}
              sub={der.profitCapturePct != null ? `Capture ${der.profitCapturePct.toFixed(0)}% of T0` : 'If decayed trades ran blindly'}
              color={s.stats.blindExecutionProfitTotal >= 0 ? C.green : C.red}
            />
          </div>

          {/* Equity Curve & Virtual Wallets */}
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 14, marginBottom: 14 }}>
            <div style={S.card}>
              <div style={S.sectionTitle}>Simulated Equity Curve (Cumulative Net P&L)</div>
              <Sparkline points={s.equityCurve} />
            </div>
            <div style={S.card}>
              <div style={S.sectionTitle}>Virtual Wallets ({s.config.quote})</div>
              <div style={{ display: 'grid', gap: 8 }}>
                {Object.entries(s.balances).map(([ex, bal]) => (
                  <div key={ex} style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 12px', background: '#04070e', border: `1px solid ${C.border}`, borderRadius: 6 }}>
                    <span style={{ color: C.muted }}>{EXCHANGES[ex]?.label || ex}</span>
                    <span style={{ fontWeight: 700, color: C.text }}>{fmtUsd(bal)}</span>
                  </div>
                ))}
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 12px', background: '#0a1428', border: `1px solid ${C.blue}55`, borderRadius: 6 }}>
                  <span style={{ color: C.blue, fontWeight: 600 }}>Total Virtual Equity</span>
                  <span style={{ fontWeight: 700, color: der.currentEquity >= der.startingEquity ? C.green : C.red }}>{fmtUsd(der.currentEquity)}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Audit Log */}
          <div style={S.card}>
            <div style={S.sectionTitle}>Predicted (T0) vs Live L2 Order-Book Fill (T1) Audit Log ({s.trades.length})</div>
            {s.trades.length === 0 ? (
              <div style={{ padding: 24, textAlign: 'center', color: C.muted, border: `1px dashed ${C.border}`, borderRadius: 8 }}>
                Waiting for a spread ≥ {s.config.minNetProfitPct}% on {s.config.exA.toUpperCase()} ↔ {s.config.exB.toUpperCase()}...
                Click <b>"⚡ Force L2 Accuracy Check on Top Pair Now"</b> above to immediately benchmark processing accuracy & L2 slippage!
              </div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                  <thead>
                    <tr style={{ background: '#04070e', color: C.muted, textAlign: 'left' }}>
                      {['Time', 'Pair', 'Route', 'Outcome', 'Pred Buy / Actual VWAP', 'Pred Sell / Actual VWAP', 'Pred Net', 'Actual Net', 'Drift', 'Proc ms'].map(h => (
                        <th key={h} style={{ padding: '8px 10px', borderBottom: `1px solid ${C.border}` }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {s.trades.map(t => {
                      const outColor = t.outcome === 'FILLED' ? C.green : t.outcome === 'DECAYED' ? C.yellow : C.red;
                      return (
                        <tr key={t.id} style={{ borderBottom: `1px solid #0b1424` }}>
                          <td style={{ padding: '7px 10px', color: C.muted }}>{new Date(t.ts).toLocaleTimeString()}</td>
                          <td style={{ padding: '7px 10px', fontWeight: 700 }}>{t.symbol}-{t.quote}</td>
                          <td style={{ padding: '7px 10px' }}>{EXCHANGES[t.buyOn]?.short}→{EXCHANGES[t.sellOn]?.short}</td>
                          <td style={{ padding: '7px 10px' }}><Badge color={outColor}>{t.outcome}</Badge></td>
                          <td style={{ padding: '7px 10px' }}>{fmtPrice(t.predictedBuy)} / <span style={{ color: C.cyan }}>{fmtPrice(t.actualBuyVwap)}</span></td>
                          <td style={{ padding: '7px 10px' }}>{fmtPrice(t.predictedSell)} / <span style={{ color: C.cyan }}>{fmtPrice(t.actualSellVwap)}</span></td>
                          <td style={{ padding: '7px 10px', color: t.predictedNetDollar >= 0 ? C.green : C.red }}>{fmtUsd(t.predictedNetDollar)}</td>
                          <td style={{ padding: '7px 10px', fontWeight: 700, color: t.actualNetDollar >= 0 ? C.green : C.red }}>{fmtUsd(t.actualNetDollar)}</td>
                          <td style={{ padding: '7px 10px', color: Math.abs(t.driftBps) > 15 ? C.red : C.yellow }}>{t.driftBps.toFixed(1)} bps</td>
                          <td style={{ padding: '7px 10px', color: C.blue }}>{t.processingMs} ms</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
