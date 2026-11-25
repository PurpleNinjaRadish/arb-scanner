// ─── Auto-Trade panel (Scanner tab) ───────────────────────────────────────────
// Target Watcher hits become bots automatically when they pass every safety
// check. Paper by default; switching to live takes a typed confirmation.
import { useState, useEffect, useCallback } from 'react';
import { api } from '../api';
import { EXCHANGE_PAIRS } from '../constants';
import { C, S, Badge, Notice } from '../ui';

const LIMITS = [
  ['maxOrderUsd', 'Max order ($)', 50],
  ['minProfitabilityPct', 'Bot min profit (%)', 0.05],
  ['maxConcurrent', 'Max bots at once', 1],
  ['maxPerDay', 'Max launches / 24 h', 1],
  ['maxRuntimeMin', 'Stop each bot after (min)', 15],
  ['symbolCooldownMin', 'Same-coin cooldown (min)', 15],
];
const OUTCOME_COLOR = { launched: C.green, skipped: C.yellow, error: C.red, mode_change: C.cyan };

export default function AutoTradePanel({ hosts = [] }) {
  const [st, setSt] = useState(null);
  const [draft, setDraft] = useState(null);
  const [open, setOpen] = useState(false);
  const [livePrompt, setLivePrompt] = useState(false);
  const [phrase, setPhrase] = useState('');
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await api('/api/autotrade');
      setSt(d);
      setDraft(prev => prev || d.settings);
    } catch (_) {}
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]);

  const save = async (patch, okText) => {
    setBusy(true); setMsg(null);
    try {
      const d = await api('/api/autotrade/settings', { method: 'POST', body: patch });
      setSt(d); setDraft(d.settings);
      if (okText) setMsg({ tone: 'ok', text: okText });
      return true;
    } catch (e) { setMsg({ tone: 'error', text: e.message }); return false; }
    finally { setBusy(false); }
  };

  if (!st || !draft) return null;
  const s = st.settings;
  const live = s.mode === 'live';
  const color = !s.enabled ? C.muted : live ? C.red : C.green;
  const pairLabel = (EXCHANGE_PAIRS.find(p => p.id === st.watcher.pair) || {}).label || st.watcher.pair;

  return (
    <div style={{ ...S.card, marginBottom: 14, borderColor: s.enabled ? `${color}88` : C.border, background: s.enabled && live ? '#1a0509' : C.panel }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={S.sectionTitle}>🤖 Auto-Trade</span>
          <Badge color={color}>{!s.enabled ? 'OFF' : live ? 'ON · LIVE (REAL FUNDS)' : 'ON · PAPER'}</Badge>
          <span style={{ fontSize: 11, color: C.muted }}>
            {s.enabled
              ? `Watching ${pairLabel} ${st.watcher.quote} · ${st.activeBots.length} bot(s) running · ${st.launchesLast24h}/${s.maxPerDay} launches in 24 h`
              : 'Launches a bot when the Target Watcher finds a target that passes every safety check'}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="tbtn" onClick={() => setOpen(o => !o)} style={S.btnMuted}>{open ? 'Hide' : 'Settings'}</button>
          <button className="tbtn" disabled={busy} onClick={() => save({ enabled: !s.enabled }, s.enabled ? 'Auto-trade turned off.' : `Auto-trade on (${s.mode}). Target Watcher is on.`)}
            style={S.btn(s.enabled ? C.muted : live ? C.red : C.green, true)}>
            {s.enabled ? 'Turn off' : `Turn on (${live ? 'LIVE' : 'paper'})`}
          </button>
        </div>
      </div>

      {msg && <div style={{ marginTop: 10 }}><Notice tone={msg.tone}>{msg.text}</Notice></div>}

      {open && (
        <div style={{ marginTop: 14 }}>
          {/* Mode */}
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
            <span style={S.lbl}>Mode</span>
            <button className="tbtn" disabled={busy || !live} onClick={() => { setLivePrompt(false); save({ mode: 'paper' }, 'Switched to paper trading.'); }}
              style={!live ? S.btn(C.green, true) : S.btnMuted}>🟢 Paper (simulated)</button>
            <button className="tbtn" disabled={busy || live} onClick={() => setLivePrompt(true)}
              style={live ? S.btn(C.red, true) : S.btn(C.red)}>⚠ Live (real funds)</button>
          </div>

          {livePrompt && !live && (
            <div style={{ padding: '10px 14px', borderRadius: 8, marginBottom: 12, background: '#24060c', border: `1px solid ${C.red}66` }}>
              <div style={{ fontSize: 11, color: C.red, fontWeight: 700, marginBottom: 6 }}>SWITCH AUTO-TRADING TO REAL FUNDS</div>
              <div style={{ fontSize: 11, color: C.text, lineHeight: 1.6, marginBottom: 8 }}>
                Bots will place real orders on your exchange accounts with no one clicking Deploy. Each one still has to pass every
                safety check, and live guard rails apply: max order ${s.maxOrderUsd} (or the lower live limit),
                kill-switch stop-loss, max $ loss per bot, and the run-time limit above. Hummingbot must have API keys for both exchanges.
              </div>
              {st.liveBlockers.length > 0 && <Notice tone="error">{st.liveBlockers.join('\n')}</Notice>}
              <label style={S.lbl}>Type <b style={{ color: C.red }}>{st.livePhrase}</b> to confirm</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input style={S.inp} value={phrase} onChange={e => setPhrase(e.target.value)} placeholder={st.livePhrase} />
                <button className="tbtn" disabled={busy || phrase.trim().toUpperCase() !== st.livePhrase}
                  onClick={async () => { if (await save({ mode: 'live', confirmPhrase: phrase }, 'Auto-trading is now LIVE.')) { setLivePrompt(false); setPhrase(''); } }}
                  style={S.btn(C.red, true)}>Switch to LIVE</button>
                <button className="tbtn" onClick={() => { setLivePrompt(false); setPhrase(''); }} style={S.btnMuted}>Cancel</button>
              </div>
            </div>
          )}

          {/* Limits */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginBottom: 10 }}>
            <div>
              <label style={S.lbl}>Strategy</label>
              <select style={S.inp} value={draft.strategy} onChange={e => setDraft(d => ({ ...d, strategy: e.target.value }))}>
                <option value="amm_arb">amm_arb · taker + taker</option>
                <option value="cross_exchange_market_making">XEMM · maker + taker</option>
              </select>
            </div>
            <div>
              <label style={S.lbl}>Host</label>
              <select style={S.inp} value={draft.target} onChange={e => setDraft(d => ({ ...d, target: e.target.value }))}>
                {(hosts.length ? hosts : [{ id: 'local', name: 'Local' }]).map(h => <option key={h.id} value={h.id}>{h.name}</option>)}
              </select>
            </div>
            {LIMITS.map(([k, label, step]) => (
              <div key={k}>
                <label style={S.lbl}>{label}</label>
                <input type="number" step={step} style={S.inp} value={draft[k]} onChange={e => setDraft(d => ({ ...d, [k]: e.target.value }))} />
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
            <span style={{ fontSize: 10, color: C.muted, maxWidth: 760, lineHeight: 1.6 }}>
              Targets come from the Target Watcher ({pairLabel} {st.watcher.quote}, ≥ {st.watcher.minNetPct}% net, checked every {st.watcher.intervalSec}s; change these in 🔔 Alerts).
              Every launch must pass the ticker audit, price cross-check and both profitability calculations; failed targets are skipped, never overridden.
            </span>
            <button className="tbtn" disabled={busy} onClick={() => save(draft, 'Saved auto-trade settings.')} style={S.btn(C.green, true)}>Save settings</button>
          </div>

          {/* Running bots */}
          {st.activeBots.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div style={S.lbl}>Running auto bots</div>
              {st.activeBots.map(b => (
                <div key={b.key} style={{ fontSize: 11, padding: '4px 0', borderBottom: `1px dashed ${C.border}` }}>
                  <b>{b.containerName}</b> · {b.pair} · {b.live === false ? 'paper' : <span style={{ color: C.red }}>LIVE</span>} · {b.target}
                  {b.stopAt && <span style={{ color: C.muted }}> · stops {new Date(b.stopAt).toLocaleTimeString()}</span>}
                </div>
              ))}
            </div>
          )}

          {/* Decision log */}
          <div style={S.lbl}>Recent decisions</div>
          {st.log.length === 0 ? <div style={{ fontSize: 11, color: C.dim }}>No targets handled yet.</div> : (
            <div style={{ maxHeight: 240, overflowY: 'auto' }}>
              {st.log.slice(0, 30).map(e => (
                <div key={e.id} style={{ fontSize: 11, padding: '4px 0', borderBottom: `1px dashed ${C.border}` }}>
                  <span style={{ color: OUTCOME_COLOR[e.outcome] || C.muted, fontWeight: 700 }}>{e.outcome.replace('_', ' ').toUpperCase()}</span>
                  {' '}{new Date(e.ts).toLocaleString()}
                  {e.pair && <> · {e.pair} · {e.mode}</>}
                  {e.containerName && <> · {e.containerName}</>}
                  {e.verifiedNetPct != null && <> · {e.verifiedNetPct.toFixed(3)}%/trade</>}
                  {e.reason && <div style={{ color: C.muted, fontSize: 10 }}>{e.reason}</div>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
