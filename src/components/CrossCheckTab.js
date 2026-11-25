// ─── Price Cross-Check & Live Guard Rails Tab ─────────────────────────────────
import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../api';
import { EXCHANGE_PAIRS, QUOTES, fmtUsd } from '../constants';
import { C, S, Badge, Notice } from '../ui';
import CrossCheckReport from './CrossCheckReport';

const AUTO_INTERVALS = [15, 30, 60, 300];

const SETTING_FIELDS = [
  ['Pre-deploy check', [
    ['slippageBps', 'Slippage buffer (bps / leg)', 1],
    ['captureRatePct', 'Capture rate (%)', 5],
    ['fallbackTradesPerDay', 'Assumed signals / day', 1],
    ['rebalanceMonthlyUsd', 'Rebalancing ($ / month)', 1],
    ['maxRefDeviationPct', 'Max deviation vs reference (%)', 0.1],
    ['maxTickerDriftPct', 'Max scanner vs book drift (%)', 0.05],
    ['maxGrossSpreadPct', 'Max plausible venue gap (%)', 0.5],
  ]],
  ['Live trading guard rails', [
    ['liveStopLossPct', 'Stop-loss: kill switch (% return)', 0.5],
    ['liveMaxLossUsd', 'Stop-loss: max realized loss ($ / bot)', 5],
    ['liveMaxOrderUsd', 'Max live order size ($)', 50],
    ['liveMinProfitabilityPct', 'Min profitability floor (%)', 0.05],
    ['monitorIntervalSec', 'Monitor interval (s)', 15],
  ]],
];

export default function CrossCheckTab({ activePairId, quote: defaultQuote, tradeSize: defaultSize, hosts = [], selectedHost = 'local', seed }) {
  const [pairId, setPairId] = useState(activePairId || EXCHANGE_PAIRS[0].id);
  const [quote, setQuote] = useState(defaultQuote || 'USD');
  const [symbol, setSymbol] = useState('BTC');
  const [tradeSize, setTradeSize] = useState(defaultSize || 1000);
  const [strategy, setStrategy] = useState('amm_arb');
  const [target, setTarget] = useState(selectedHost || 'local');
  const [check, setCheck] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [auto, setAuto] = useState(false);
  const [autoSec, setAutoSec] = useState(30);

  const [guard, setGuard] = useState(null);
  const [draft, setDraft] = useState({});
  const [saveMsg, setSaveMsg] = useState('');
  const [history, setHistory] = useState([]);
  const busyRef = useRef(false);

  const pair = EXCHANGE_PAIRS.find(p => p.id === pairId) || EXCHANGE_PAIRS[0];

  useEffect(() => {
    if (!seed) return;
    if (seed.pairId) setPairId(seed.pairId);
    if (seed.quote) setQuote(seed.quote);
    if (seed.symbol) setSymbol(seed.symbol);
    if (seed.tradeSize) setTradeSize(seed.tradeSize);
  }, [seed]);

  const loadGuard = useCallback(async () => {
    try {
      const [g, h] = await Promise.all([api('/api/guard'), api('/api/crosscheck/history')]);
      setGuard(g);
      setDraft(d => (Object.keys(d).length ? d : g.settings));
      setHistory(h.history || []);
    } catch (_) {}
  }, []);

  useEffect(() => { loadGuard(); const t = setInterval(loadGuard, 20000); return () => clearInterval(t); }, [loadGuard]);

  const run = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError('');
    try {
      const d = await api('/api/crosscheck', {
        method: 'POST',
        body: { symbol, quote, exA: pair.a, exB: pair.b, strategy, tradeSize, target },
      });
      setCheck(d);
      loadGuard();
    } catch (e) {
      setError(e.message);
    } finally {
      busyRef.current = false; setBusy(false);
    }
  }, [symbol, quote, pair.a, pair.b, strategy, tradeSize, target, loadGuard]);

  // Automatic mode: re-run on an interval while enabled
  useEffect(() => {
    if (!auto) return undefined;
    run();
    const t = setInterval(run, autoSec * 1000);
    return () => clearInterval(t);
  }, [auto, autoSec, run]);

  const saveSettings = async () => {
    try {
      const d = await api('/api/guard/settings', { method: 'POST', body: draft });
      setDraft(d.settings);
      setSaveMsg('Saved guard-rail settings.');
      loadGuard();
    } catch (e) { setSaveMsg(`Error: ${e.message}`); }
  };

  const runMonitor = async () => {
    try { await api('/api/guard/monitor/run', { method: 'POST' }); loadGuard(); } catch (e) { setSaveMsg(`Monitor error: ${e.message}`); }
  };

  const removeBot = async (key) => {
    try { await api(`/api/guard/bots/${encodeURIComponent(key)}`, { method: 'DELETE' }); loadGuard(); } catch (_) {}
  };

  const monitorBots = guard?.monitor?.bots || [];

  return (
    <div>
      {/* Manual / automatic cross-check */}
      <div style={{ ...S.card, marginBottom: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginBottom: 12 }}>
          <div>
            <div style={S.sectionTitle}>Price Cross-Reference & Profitability Check</div>
            <div style={{ fontSize: 11, color: C.muted, maxWidth: 820, lineHeight: 1.6 }}>
              Compares the scanner's prices with fresh order books on both exchanges and the median of other exchanges, then
              checks profit per trade (after fees and slippage) and per month (after server and rebalancing costs).
              Every bot launch runs this check automatically; bots that fail need manual confirmation.
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 11, color: auto ? C.green : C.muted, cursor: 'pointer' }}>
              <input type="checkbox" checked={auto} onChange={e => setAuto(e.target.checked)} /> Auto re-check every
            </label>
            <select style={{ ...S.inp, width: 80 }} value={autoSec} onChange={e => setAutoSec(Number(e.target.value))}>
              {AUTO_INTERVALS.map(s => <option key={s} value={s}>{s}s</option>)}
            </select>
            <button className="tbtn" disabled={busy} onClick={run} style={S.btn(C.cyan, true)}>{busy ? 'Checking…' : '🔍 Run Check'}</button>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10 }}>
          <div>
            <label style={S.lbl}>Exchange pair</label>
            <select style={S.inp} value={pairId} onChange={e => setPairId(e.target.value)}>
              {EXCHANGE_PAIRS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </div>
          <div>
            <label style={S.lbl}>Coin</label>
            <input style={S.inp} value={symbol} onChange={e => setSymbol(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} />
          </div>
          <div>
            <label style={S.lbl}>Quote</label>
            <select style={S.inp} value={quote} onChange={e => setQuote(e.target.value)}>
              {QUOTES.map(q => <option key={q} value={q}>{q}</option>)}
            </select>
          </div>
          <div>
            <label style={S.lbl}>Order size ($)</label>
            <input type="number" min="10" step="100" style={S.inp} value={tradeSize} onChange={e => setTradeSize(Math.max(10, Number(e.target.value) || 10))} />
          </div>
          <div>
            <label style={S.lbl}>Strategy (fees)</label>
            <select style={S.inp} value={strategy} onChange={e => setStrategy(e.target.value)}>
              <option value="amm_arb">amm_arb · taker + taker</option>
              <option value="cross_exchange_market_making">XEMM · maker + taker</option>
            </select>
          </div>
          <div>
            <label style={S.lbl}>Host (server cost)</label>
            <select style={S.inp} value={target} onChange={e => setTarget(e.target.value)}>
              {(hosts.length ? hosts : [{ id: 'local', name: 'Local' }]).map(h => <option key={h.id} value={h.id}>{h.name}</option>)}
            </select>
          </div>
        </div>
      </div>

      {error && <Notice tone="error">✗ {error}</Notice>}
      {check && <div style={{ ...S.card, marginBottom: 14 }}><CrossCheckReport check={check} /></div>}

      {/* Monitored live bots */}
      <div style={{ ...S.card, marginBottom: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginBottom: 10 }}>
          <div>
            <div style={S.sectionTitle}>Live Bot Stop-Loss Monitor</div>
            <div style={{ fontSize: 11, color: C.muted }}>
              Every {guard?.monitor?.intervalSec || 60}s: stops a live bot when its realized loss reaches its limit, and re-checks its prices.
              {guard?.monitor?.lastRunAt ? ` Last run ${new Date(guard.monitor.lastRunAt).toLocaleTimeString()}.` : ''}
            </div>
          </div>
          <button className="tbtn" onClick={runMonitor} style={S.btn(C.blue)}>Run monitor now</button>
        </div>
        {guard?.monitor?.lastError && <Notice tone="warn">Monitor: {guard.monitor.lastError}</Notice>}
        {monitorBots.length === 0 ? (
          <div style={{ fontSize: 11, color: C.dim }}>No live bots launched through Arb Scanner yet. Paper bots are not monitored.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
              <thead>
                <tr style={{ background: '#04070e', color: C.muted, textAlign: 'left' }}>
                  {['Bot', 'Host', 'Pair', 'Status', 'Realized P&L', 'Loss limit', 'Last price check', ''].map(h => (
                    <th key={h} style={{ padding: '6px 8px', borderBottom: `1px solid ${C.border}` }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {monitorBots.map(b => (
                  <tr key={b.key} style={{ borderBottom: '1px solid #0b1424' }}>
                    <td style={{ padding: '6px 8px', fontWeight: 700 }}>{b.containerName}</td>
                    <td style={{ padding: '6px 8px' }}>{b.target}</td>
                    <td style={{ padding: '6px 8px' }}>{b.pair}</td>
                    <td style={{ padding: '6px 8px' }}>
                      <Badge color={b.status === 'active' ? C.green : b.status === 'tripped' ? C.red : C.muted}>{b.status.toUpperCase()}</Badge>
                      {b.lastNote && <div style={{ color: C.muted, fontSize: 10, marginTop: 2 }}>{b.lastNote}</div>}
                    </td>
                    <td style={{ padding: '6px 8px', color: b.sessionPnl >= 0 ? C.green : C.red }}>{fmtUsd(b.sessionPnl)}</td>
                    <td style={{ padding: '6px 8px' }}>−{fmtUsd(b.maxLossUsd, 0)} · kill switch −{b.stopLossPct}%</td>
                    <td style={{ padding: '6px 8px', color: b.lastDataOk === false ? C.red : C.muted }}>
                      {b.lastDataOk == null ? '—' : b.lastDataOk ? `OK (${b.lastNetPct != null ? b.lastNetPct.toFixed(3) + '%' : '—'})` : 'FAILED'}
                    </td>
                    <td style={{ padding: '6px 8px' }}>
                      {b.status !== 'active' && <button className="tbtn" onClick={() => removeBot(b.key)} style={{ ...S.btnMuted, padding: '3px 8px', fontSize: 10 }}>Remove</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Guard rail settings */}
      <div style={{ ...S.card, marginBottom: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <div style={S.sectionTitle}>Guard Rail Settings</div>
          <button className="tbtn" onClick={saveSettings} style={S.btn(C.green, true)}>Save settings</button>
        </div>
        {saveMsg && <Notice tone={saveMsg.startsWith('Error') ? 'error' : 'ok'}>{saveMsg}</Notice>}
        {SETTING_FIELDS.map(([group, fields]) => (
          <div key={group} style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 10, color: group.startsWith('Live') ? C.red : C.cyan, letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 6 }}>{group}</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 10 }}>
              {fields.map(([k, label, step]) => (
                <div key={k}>
                  <label style={S.lbl}>{label}</label>
                  <input type="number" step={step} style={S.inp} value={draft[k] ?? ''}
                    onChange={e => setDraft(d => ({ ...d, [k]: e.target.value }))} />
                </div>
              ))}
            </div>
          </div>
        ))}
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 11, color: C.text, cursor: 'pointer' }}>
          <input type="checkbox" checked={!!draft.autoRecheckEnabled} onChange={e => setDraft(d => ({ ...d, autoRecheckEnabled: e.target.checked }))} />
          Automatically re-check prices for running live bots and alert on failure
        </label>
        <div style={{ fontSize: 10, color: C.muted, marginTop: 8, lineHeight: 1.6 }}>
          Live guard rails can't be overridden when launching. The kill switch is written to the host's conf_client.yml
          (it applies to every bot on that host; a tighter existing setting is kept).
        </div>
      </div>

      {/* History + audit */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', gap: 14 }}>
        <div style={S.card}>
          <div style={S.sectionTitle}>Recent Checks</div>
          {history.length === 0 ? <div style={{ fontSize: 11, color: C.dim }}>None yet.</div> : history.slice(0, 12).map(h => (
            <div key={h.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 11, padding: '4px 0', borderBottom: `1px dashed ${C.border}` }}>
              <span>{new Date(h.checkedAt).toLocaleTimeString()} · {h.pair} · {h.exA}/{h.exB}</span>
              <span style={{ color: h.allowed ? C.green : C.red }}>
                {h.allowed ? 'PASS' : 'BLOCK'} · {h.netPct != null ? `${h.netPct.toFixed(3)}%` : '—'} · {fmtUsd(h.monthlyNet)}/mo
              </span>
            </div>
          ))}
        </div>
        <div style={S.card}>
          <div style={S.sectionTitle}>Launch Decisions & Overrides</div>
          {(guard?.audit || []).length === 0 ? <div style={{ fontSize: 11, color: C.dim }}>None yet.</div> : guard.audit.slice(0, 12).map((a, i) => (
            <div key={i} style={{ fontSize: 11, padding: '4px 0', borderBottom: `1px dashed ${C.border}` }}>
              <span style={{ color: { allowed: C.green, override: C.yellow, stop_loss: C.red }[a.action] || C.red, fontWeight: 700 }}>
                {a.action.replace(/_/g, ' ').toUpperCase()}
              </span>
              {' '}{new Date(a.ts).toLocaleString()} · {a.pair} · {a.live ? 'LIVE' : 'paper'} · {a.target}
              {a.reasons && a.reasons.length > 0 && <div style={{ color: C.muted, fontSize: 10 }}>{a.reasons[0]}</div>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
