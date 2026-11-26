// ─── Hummingbot Latency Test (Servers tab) ────────────────────────────────────
// Runs a short probe on each host (inside a temporary Hummingbot container when
// the image is there) and compares exchange latency between hosts.
import { useState, useEffect, useMemo } from 'react';
import { api } from '../api';
import { EXCHANGES } from '../constants';
import { C, S, Badge, Notice } from '../ui';

const METHOD_LABEL = {
  'hummingbot-container': 'Hummingbot container',
  'host-curl': 'host shell (curl)',
  'backend-node': 'backend on this PC',
};
const SAMPLE_OPTIONS = [5, 10, 20];

function Bar({ value, max, color }) {
  const w = max > 0 && value != null ? Math.max(3, Math.round((value / max) * 100)) : 0;
  return (
    <div style={{ height: 4, background: '#0b1424', borderRadius: 2, marginTop: 3 }}>
      <div style={{ width: `${w}%`, height: 4, borderRadius: 2, background: color }} />
    </div>
  );
}

export default function LatencyTestPanel({ hosts = [] }) {
  const allHosts = hosts.length ? hosts : [{ id: 'local', name: 'Local' }];
  const [targets, setTargets] = useState(allHosts.map(h => h.id));
  const [exchanges, setExchanges] = useState(Object.keys(EXCHANGES));
  const [samples, setSamples] = useState(10);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [test, setTest] = useState(null);
  const [history, setHistory] = useState([]);

  useEffect(() => { setTargets(t => (t.length ? t : allHosts.map(h => h.id))); }, [hosts]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { api('/api/latency/history').then(d => setHistory(d.history || [])).catch(() => {}); }, [test]);

  const toggle = (list, setList, id) => setList(list.includes(id) ? list.filter(x => x !== id) : [...list, id]);

  const run = async () => {
    setBusy(true); setError('');
    try {
      setTest(await api('/api/latency/test', { method: 'POST', body: { targets, exchanges, samples } }));
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const runs = useMemo(() => (test ? test.runs : []), [test]);
  const okRuns = runs.filter(r => r.ok);
  const cmp = test ? test.comparison : null;
  const maxEx = cmp ? Math.max(1, ...cmp.perExchange.flatMap(e => e.hosts.map(h => h.medianMs || 0))) : 1;
  const maxPair = cmp ? Math.max(1, ...cmp.perPair.flatMap(p => p.hosts.map(h => h.roundMs || 0))) : 1;

  const cell = { padding: '7px 8px', borderBottom: '1px solid #0b1424', verticalAlign: 'top' };
  const head = { padding: '6px 8px', borderBottom: `1px solid ${C.border}`, color: C.muted, textAlign: 'left' };

  return (
    <div>
      <div style={{ ...S.card, marginBottom: 14 }}>
        <div style={S.sectionTitle}>⏱ Hummingbot Latency Test</div>
        <div style={{ fontSize: 11, color: C.muted, maxWidth: 900, lineHeight: 1.6, marginBottom: 12 }}>
          Measures how fast each host reaches each exchange, from where the bots actually run. On each host it starts a temporary
          container from your Hummingbot image (curl or the backend if the image isn't there) and times DNS, the network round trip,
          the TLS handshake and repeated requests on a kept-alive connection, which is what a running bot sees. For a trading pair both
          orders go out at once, so a round takes as long as the slower exchange.
        </div>

        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginBottom: 12 }}>
          <div>
            <div style={S.lbl}>Hosts to compare</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {allHosts.map(h => (
                <button key={h.id} className="tbtn" onClick={() => toggle(targets, setTargets, h.id)}
                  style={{ ...(targets.includes(h.id) ? S.btn(C.cyan, true) : S.btnMuted), padding: '5px 10px', fontSize: 10 }}>
                  {h.name}{h.provider ? ` · ${h.provider}` : ''}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div style={S.lbl}>Exchanges</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {Object.entries(EXCHANGES).map(([k, e]) => (
                <button key={k} className="tbtn" onClick={() => toggle(exchanges, setExchanges, k)}
                  style={{ ...(exchanges.includes(k) ? S.btn(C.blue, true) : S.btnMuted), padding: '5px 9px', fontSize: 10 }}>{e.label}</button>
              ))}
            </div>
          </div>
          <div>
            <div style={S.lbl}>Samples per exchange</div>
            <div style={{ display: 'flex', gap: 6 }}>
              {SAMPLE_OPTIONS.map(n => (
                <button key={n} className="tbtn" onClick={() => setSamples(n)}
                  style={{ ...(samples === n ? S.btn(C.yellow, true) : S.btnMuted), padding: '5px 10px', fontSize: 10 }}>{n}</button>
              ))}
            </div>
          </div>
        </div>

        <button className="tbtn" disabled={busy || !targets.length || !exchanges.length} onClick={run} style={S.btn(C.cyan, true)}>
          {busy ? `Testing ${targets.length} host(s)… (20–60 s)` : `⚡ Run latency test on ${targets.length} host(s)`}
        </button>
      </div>

      {error && <Notice tone="error">✗ {error}</Notice>}

      {test && (
        <>
          {cmp.headlines.length > 0 && <Notice tone="ok">{cmp.headlines.join('\n')}</Notice>}
          {okRuns.length === 1 && <Notice tone="info">Only one host answered, so there's nothing to compare yet. Add a remote server in ☁ Local & Remote Hosts.</Notice>}
          {cmp.blockedNotes.length > 0 && <Notice tone="warn">{cmp.blockedNotes.join('\n')}</Notice>}
          {runs.filter(r => !r.ok).map(r => <Notice key={r.target} tone="error">{`${r.hostName || r.target}: ${r.error}`}</Notice>)}

          {/* Pairs */}
          {cmp.perPair.length > 0 && (
            <div style={{ ...S.card, marginBottom: 14 }}>
              <div style={S.sectionTitle}>Per trading pair: time for one arbitrage round</div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                  <thead><tr style={{ background: '#04070e' }}>
                    <th style={head}>Pair</th>
                    {okRuns.map(r => <th key={r.target} style={head}>{r.hostName}</th>)}
                    <th style={head}>Advantage</th>
                  </tr></thead>
                  <tbody>
                    {cmp.perPair.map(p => (
                      <tr key={p.pair}>
                        <td style={{ ...cell, fontWeight: 700 }}>{p.label}</td>
                        {okRuns.map(r => {
                          const h = p.hosts.find(x => x.target === r.target);
                          if (!h || !h.ok) return <td key={r.target} style={{ ...cell, color: C.red }}>{h && h.blocked.length ? `blocked (${h.blocked.join(', ')})` : 'unreachable'}</td>;
                          const best = p.bestTarget === r.target;
                          return (
                            <td key={r.target} style={cell}>
                              <span style={{ color: best ? C.green : C.text, fontWeight: best ? 700 : 400 }}>{h.roundMs} ms</span>
                              <span style={{ color: C.dim }}> · p90 {h.p90Ms}</span>
                              {best ? <Badge color={C.green}>FASTEST</Badge> : <span style={{ color: C.yellow }}> +{h.slowerByMs} ms ({h.slowerByPct}%)</span>}
                              <Bar value={h.roundMs} max={maxPair} color={best ? C.green : C.yellow} />
                            </td>
                          );
                        })}
                        <td style={{ ...cell, color: C.cyan }}>
                          {p.advantageMs != null
                            ? `${okRuns.find(r => r.target === p.bestTarget)?.hostName} by ${p.advantageMs} ms`
                            : p.bestTarget ? 'only one host can trade it' : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Exchanges */}
          <div style={{ ...S.card, marginBottom: 14 }}>
            <div style={S.sectionTitle}>Per exchange: request latency on a live connection</div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                <thead><tr style={{ background: '#04070e' }}>
                  <th style={head}>Exchange</th>
                  {okRuns.map(r => <th key={r.target} style={head}>{r.hostName}</th>)}
                </tr></thead>
                <tbody>
                  {cmp.perExchange.map(e => (
                    <tr key={e.exchange}>
                      <td style={{ ...cell, fontWeight: 700 }}>{e.label}</td>
                      {okRuns.map(r => {
                        const h = e.hosts.find(x => x.target === r.target);
                        if (!h) return <td key={r.target} style={cell}>—</td>;
                        if (h.blocked) return <td key={r.target} style={{ ...cell, color: C.red }}>blocked here (HTTP {h.status})</td>;
                        if (!h.ok) return <td key={r.target} style={{ ...cell, color: C.red }} title={h.error || ''}>unreachable</td>;
                        const best = e.bestTarget === r.target;
                        return (
                          <td key={r.target} style={cell} title={`network round trip ${h.tcpMs} ms · jitter ${h.jitterMs} ms`}>
                            <span style={{ color: best ? C.green : C.text, fontWeight: best ? 700 : 400 }}>{h.medianMs} ms</span>
                            <span style={{ color: C.dim }}> · p90 {h.p90Ms} · ±{h.jitterMs}</span>
                            {!best && h.slowerByMs != null && okRuns.length > 1 && <span style={{ color: C.yellow }}> +{h.slowerByMs}</span>}
                            <div style={{ color: C.dim, fontSize: 10 }}>network RTT {h.tcpMs ?? '—'} ms</div>
                            <Bar value={h.medianMs} max={maxEx} color={best ? C.green : C.cyan} />
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ fontSize: 10, color: C.muted, marginTop: 8, lineHeight: 1.6 }}>
              {runs.filter(r => r.ok).map(r => `${r.hostName}: measured in ${METHOD_LABEL[r.method] || r.method}, ${r.samples} samples, ${(r.durationMs / 1000).toFixed(1)} s${r.notes.length ? ` (${r.notes.join('; ')})` : ''}`).join(' · ')}
            </div>
          </div>
        </>
      )}

      {history.length > 1 && (
        <div style={S.card}>
          <div style={S.sectionTitle}>Previous tests (round time per pair)</div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
              <thead><tr style={{ background: '#04070e' }}><th style={head}>When</th><th style={head}>Results</th></tr></thead>
              <tbody>
                {history.slice(0, 10).map(h => (
                  <tr key={h.id}>
                    <td style={{ ...cell, whiteSpace: 'nowrap' }}>{new Date(h.at).toLocaleString()}</td>
                    <td style={cell}>
                      {h.pairs.filter(p => p.hosts.some(x => x.roundMs != null)).map(p => (
                        <span key={p.pair} style={{ marginRight: 14 }}>
                          <b>{p.label}</b>: {p.hosts.map(x => `${x.hostName} ${x.roundMs != null ? x.roundMs + ' ms' : '—'}`).join(' / ')}
                        </span>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
