// ─── RPC Manager ──────────────────────────────────────────────────────────────
// Blockchain RPC endpoints per network, health checks, and push to Hummingbot
// Gateway (used by DEX connectors). CEX bots (Kraken/Coinbase) don't use RPC.
import { useState, useEffect, useCallback } from 'react';
import { api } from '../api';
import { C, S, Badge, Notice } from '../ui';

const fmtAgo = ts => {
  if (!ts) return '';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ts).toLocaleDateString();
};

function ResultCell({ r, unit }) {
  if (!r) return <span style={{ color: C.dim }}>not tested</span>;
  if (!r.ok) return <span style={{ color: C.red }} title={r.error}>✗ {String(r.error || 'failed').slice(0, 70)}</span>;
  return (
    <span>
      <span style={{ color: r.latencyMs < 150 ? C.green : r.latencyMs < 400 ? C.yellow : C.red }}>{r.latencyMs} ms</span>
      <span style={{ color: r.lagging ? C.red : C.muted }}> · {r.lag === 0 ? 'at tip' : `${r.lag} ${unit} behind`}</span>
    </span>
  );
}

function NetworkCard({ n, unit, onChanged, busyKey, setBusyKey, setError }) {
  const [url, setUrl] = useState('');
  const [label, setLabel] = useState('');
  const t = n.lastTest;
  const resultFor = id => (t ? t.results.find(x => x.id === id) : null);
  const extra = t ? t.results.filter(x => x.kind !== 'endpoint') : [];

  const act = async (key, fn) => {
    setBusyKey(key); setError('');
    try { await fn(); await onChanged(); } catch (e) { setError(`${n.label}: ${e.message}`); } finally { setBusyKey(''); }
  };
  const add = () => act(`add:${n.id}`, async () => {
    await api('/api/rpc/endpoints', { method: 'POST', body: { network: n.id, url, label } });
    setUrl(''); setLabel('');
  });

  const cell = { padding: '6px 8px', borderBottom: '1px solid #0b1424', fontSize: 11, verticalAlign: 'middle' };
  return (
    <div style={{ ...S.card, marginBottom: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontFamily: "'Orbitron', sans-serif", fontSize: 12, color: C.text }}>{n.label}</span>
          <Badge color={C.muted}>{n.id}</Badge>
          {n.chainId && <Badge color={C.dim}>chain {n.chainId}</Badge>}
          {n.testnet && <Badge color={C.yellow}>testnet</Badge>}
          {n.provider !== 'url' && <Badge color={C.purple} title="Gateway uses the provider for this chain, not the URL below">uses {n.provider}</Badge>}
          {t && <span style={{ fontSize: 10, color: C.dim }}>tested {fmtAgo(t.at)}</span>}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="tbtn" disabled={!!busyKey} onClick={() => act(`test:${n.id}`, () => api('/api/rpc/test', { method: 'POST', body: { network: n.id } }))} style={S.btn(C.cyan)}>
            {busyKey === `test:${n.id}` ? 'Testing…' : 'Test'}
          </button>
          <button className="tbtn" disabled={!!busyKey || !n.endpoints.length} onClick={() => act(`fast:${n.id}`, () => api('/api/rpc/fastest', { method: 'POST', body: { network: n.id } }))} style={S.btn(C.green)}>
            {busyKey === `fast:${n.id}` ? 'Testing…' : 'Use fastest'}
          </button>
        </div>
      </div>

      {n.provider !== 'url' && (
        <div style={{ fontSize: 10, color: C.purple, marginBottom: 8 }}>
          {n.chain} is set to the {n.provider} provider, so Gateway ignores nodeURL for this network. Switch the provider back to "Your URLs" above to use the list below.
        </div>
      )}

      {n.endpoints.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 8 }}>
          <thead>
            <tr style={{ fontSize: 9, color: C.muted, textAlign: 'left', letterSpacing: 1 }}>
              <th style={cell}>ACTIVE</th><th style={cell}>NAME</th><th style={cell}>URL</th><th style={cell}>LAST TEST</th><th style={cell} />
            </tr>
          </thead>
          <tbody>
            {n.endpoints.map(e => {
              const r = resultFor(e.id);
              return (
                <tr key={e.id}>
                  <td style={cell}>
                    <input type="radio" name={`active-${n.id}`} checked={n.active === e.id} disabled={!!busyKey}
                      onChange={() => act(`active:${n.id}`, () => api('/api/rpc/active', { method: 'POST', body: { network: n.id, id: e.id } }))} />
                  </td>
                  <td style={cell}>{e.label}</td>
                  <td style={{ ...cell, color: C.muted, wordBreak: 'break-all' }}>{e.url} {e.hasSecret && <span title="Contains an API key — hidden here">🔑</span>}</td>
                  <td style={cell}><ResultCell r={r} unit={unit} /></td>
                  <td style={{ ...cell, textAlign: 'right' }}>
                    <button className="tbtn" disabled={!!busyKey} onClick={() => {
                      if (window.confirm(`Remove ${e.label}?`)) act(`del:${e.id}`, () => api(`/api/rpc/endpoints/${n.id}/${e.id}`, { method: 'DELETE' }));
                    }} style={{ ...S.btnMuted, padding: '3px 8px', fontSize: 9 }}>Remove</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {extra.length > 0 && (
        <div style={{ fontSize: 10, color: C.muted, marginBottom: 8 }}>
          For comparison: {extra.map(x => (
            <span key={x.id} style={{ marginRight: 12 }}>{x.label}: <ResultCell r={x} unit={unit} /></span>
          ))}
        </div>
      )}
      {t && t.activeHealthy === false && <Notice tone="warn">The active endpoint failed its last test — pick another before pushing to Gateway.</Notice>}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 3fr) minmax(120px, 1fr) auto', gap: 8 }}>
        <input style={S.inp} value={url} onChange={e => setUrl(e.target.value)} placeholder={`https://… (${n.label} RPC URL, API key included)`} />
        <input style={S.inp} value={label} onChange={e => setLabel(e.target.value)} placeholder="Name (optional)" />
        <button className="tbtn" disabled={!url || !!busyKey} onClick={add} style={S.btn(C.blue, true)}>{busyKey === `add:${n.id}` ? 'Adding…' : '+ Add'}</button>
      </div>
    </div>
  );
}

export default function RpcTab({ hosts = [] }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busyKey, setBusyKey] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [opened, setOpened] = useState([]);
  const [target, setTarget] = useState('local');
  const [gw, setGw] = useState(null);
  const [gwError, setGwError] = useState('');
  const [keys, setKeys] = useState({ infura: '', helius: '', chainstack: '' });
  const [push, setPush] = useState(null);
  const [pushOpts, setPushOpts] = useState({ includeKeys: true, includeProviders: true, force: false });

  const load = useCallback(async () => {
    try { setData(await api('/api/rpc')); } catch (e) { setError(e.message); }
  }, []);
  const loadGateway = useCallback(async () => {
    setGwError(''); setGw(null);
    try { setGw(await api('/api/rpc/gateway', { params: { target } })); } catch (e) { setGwError(e.message); }
  }, [target]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadGateway(); }, [loadGateway]);

  if (!data) return <div style={S.card}>{error ? <Notice tone="error">{error}</Notice> : 'Loading RPC settings…'}</div>;

  const run = async (key, fn) => {
    setBusyKey(key); setError('');
    try { return await fn(); } catch (e) { setError(e.message); return null; } finally { setBusyKey(''); }
  };
  const saveKeys = () => run('keys', async () => {
    const body = { apiKeys: Object.fromEntries(Object.entries(keys).filter(([, v]) => v)) };
    await api('/api/rpc/settings', { method: 'POST', body });
    setKeys({ infura: '', helius: '', chainstack: '' });
    await load();
  });
  const clearKey = k => run('keys', async () => { await api('/api/rpc/settings', { method: 'POST', body: { apiKeys: { [k]: '' } } }); await load(); });
  const setProvider = (chain, p) => run('prov', async () => { await api('/api/rpc/settings', { method: 'POST', body: { chainProvider: { [chain]: p } } }); await load(); });
  const testAll = () => run('testall', async () => { await api('/api/rpc/test', { method: 'POST', body: {} }); await load(); });
  const doImport = () => run('import', async () => {
    const r = await api('/api/rpc/gateway/import', { method: 'POST', body: { target } });
    await load();
    setError(r.imported ? '' : 'Gateway only has the default public RPCs — nothing new to import.');
  });
  const doPush = () => run('push', async () => {
    const hostName = (hosts.find(h => h.id === target) || {}).name || target;
    if (!window.confirm(`Push the active RPCs${pushOpts.includeKeys ? ', provider API keys' : ''} to Gateway on ${hostName} and restart Gateway?\n\nRunning DEX bots lose their Gateway connection for a few seconds.`)) return;
    setPush(await api('/api/rpc/gateway/push', { method: 'POST', body: { target, ...pushOpts } }));
    await Promise.all([load(), loadGateway()]);
  });

  const used = data.networks.filter(n => n.endpoints.length || n.lastTest || opened.includes(n.id));
  const shown = showAll ? data.networks : used;
  const hidden = data.networks.filter(n => !shown.includes(n));
  const activeCount = data.networks.filter(n => n.active).length;

  return (
    <div>
      <div style={{ ...S.card, marginBottom: 14 }}>
        <div style={S.sectionTitle}>⛓ RPC Management</div>
        <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.65, maxWidth: 980 }}>
          RPC endpoints are how Hummingbot reads and sends blockchain transactions. They're used by <b style={{ color: C.text }}>Hummingbot Gateway</b> for
          DEX connectors (Uniswap, Jupiter, Raydium, PancakeSwap…). Your current CEX bots (Kraken ↔ Coinbase) don't use them. Add your own endpoints
          (Alchemy, QuickNode, Ankr, your own node…), test them against each other, then push the active one into Gateway. Pushing writes Gateway's config,
          restarts the Gateway container and checks that each network answers through the new RPC.
        </div>
      </div>

      {error && <Notice tone="error">{error}</Notice>}

      {/* Gateway connection */}
      <div style={{ ...S.card, marginBottom: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginBottom: 10 }}>
          <div style={S.sectionTitle}>Hummingbot Gateway</div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 10, color: C.muted }}>Host:</span>
            <select value={target} onChange={e => setTarget(e.target.value)} style={{ ...S.inp, width: 'auto', padding: '4px 8px' }}>
              {(hosts.length ? hosts : [{ id: 'local', name: 'Local' }]).map(h => <option key={h.id} value={h.id}>{h.name}</option>)}
            </select>
            <button className="tbtn" onClick={loadGateway} style={S.btnMuted}>Refresh</button>
            <button className="tbtn" disabled={!!busyKey || !gw?.running} onClick={doImport} style={S.btn(C.cyan)}>{busyKey === 'import' ? 'Importing…' : 'Import from Gateway'}</button>
          </div>
        </div>

        {gwError && <Notice tone="warn">{gwError}</Notice>}
        {!gw && !gwError && <div style={{ fontSize: 11, color: C.muted }}>Looking for the Gateway container…</div>}
        {gw && (
          <div style={{ fontSize: 11, lineHeight: 1.8 }}>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <Badge color={gw.running ? C.green : C.red}>{gw.running ? 'running' : 'stopped'}</Badge>
              <span>{gw.container} <span style={{ color: C.dim }}>({gw.image})</span> on {gw.host}</span>
              {gw.api && <Badge color={gw.api.reachable ? C.green : C.yellow} title={gw.api.error || ''}>{gw.api.reachable ? `API ${gw.api.scheme}` : 'API not reachable — file mode'}</Badge>}
              {gw.chains && Object.entries(gw.chains).filter(([, v]) => v).map(([ch, v]) => (
                <Badge key={ch} color={v.rpcProvider === 'url' ? C.muted : C.purple}>{ch}: {v.rpcProvider}</Badge>
              ))}
            </div>
            {gw.running && gw.networks && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                {data.networks.filter(n => gw.networks[n.id]?.present).map(n => {
                  const g = gw.networks[n.id];
                  const color = g.matchesActive === true ? C.green : g.matchesActive === false ? C.yellow : C.dim;
                  return (
                    <span key={n.id} title={g.nodeURL || ''} style={{ fontSize: 10, padding: '2px 8px', border: `1px solid ${color}55`, borderRadius: 4, color }}>
                      {n.label}: {g.matchesActive === true ? 'your active RPC' : g.isDefault ? 'public default' : g.matchesActive === false ? 'different RPC' : 'custom'}
                    </span>
                  );
                })}
              </div>
            )}
          </div>
        )}

        <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap', marginTop: 12, paddingTop: 12, borderTop: `1px solid ${C.border}` }}>
          {[
            ['includeKeys', 'Include provider API keys'],
            ['includeProviders', 'Set each chain\'s provider'],
            ['force', 'Push even if a test fails'],
          ].map(([k, l]) => (
            <label key={k} style={{ fontSize: 11, color: k === 'force' && pushOpts.force ? C.yellow : C.muted, display: 'flex', gap: 5, alignItems: 'center' }}>
              <input type="checkbox" checked={pushOpts[k]} onChange={e => setPushOpts(o => ({ ...o, [k]: e.target.checked }))} /> {l}
            </label>
          ))}
          <button className="tbtn" disabled={!!busyKey || !gw?.running || (!activeCount && !pushOpts.includeKeys && !pushOpts.includeProviders)} onClick={doPush} style={S.btn(C.green, true)}>
            {busyKey === 'push' ? 'Pushing & restarting…' : `⬆ Push to Gateway (${activeCount} network${activeCount === 1 ? '' : 's'})`}
          </button>
        </div>

        {push && (
          <div style={{ marginTop: 12 }}>
            <Notice tone={push.ok && (!push.verify || Object.values(push.verify).every(v => v.ok)) ? 'ok' : 'warn'}>
              {push.ok ? `Pushed to ${push.container} on ${push.host}` : 'Some settings could not be written'}
              {push.restarted ? ' · Gateway restarted' : push.restartError ? ` · restart failed: ${push.restartError}` : ''}
              {'\n'}{push.results.map(r => `${r.ok ? '✓' : '✗'} ${r.namespace}.${r.path} = ${r.value} (${r.via || r.error})`).join('\n')}
              {push.verify && `\n\nAfter restart:\n${Object.entries(push.verify).map(([id, v]) => `${v.ok ? '✓' : '✗'} ${id}: ${v.ok ? `block ${v.block} via ${v.rpcUrl}` : v.error}`).join('\n')}`}
              {push.restarted && !push.verify && '\n\nGateway did not answer within ~30 s of the restart — check its logs.'}
            </Notice>
          </div>
        )}
      </div>

      {/* Providers */}
      <div style={{ ...S.card, marginBottom: 14 }}>
        <div style={S.sectionTitle}>Providers (optional)</div>
        <div style={{ fontSize: 11, color: C.muted, marginBottom: 10, lineHeight: 1.6 }}>
          Instead of a URL per network, Gateway can build URLs from one provider key. A provider applies to the whole chain (every Ethereum network, or every Solana network).
          Chainstack finds your deployed nodes through its own API, so its URLs can't be tested here.
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12, marginBottom: 12 }}>
          {['infura', 'helius', 'chainstack'].map(k => (
            <div key={k}>
              <label style={S.lbl}>{data.providers[k].label} API key {data.apiKeys[k].set && <span style={{ color: C.green }}>· saved {data.apiKeys[k].preview}</span>}</label>
              <div style={{ display: 'flex', gap: 6 }}>
                <input type="password" autoComplete="off" style={S.inp} value={keys[k]} onChange={e => setKeys(s => ({ ...s, [k]: e.target.value }))} placeholder={data.apiKeys[k].set ? 'replace…' : 'paste key'} />
                {data.apiKeys[k].set && <button className="tbtn" disabled={!!busyKey} onClick={() => clearKey(k)} style={{ ...S.btnMuted, padding: '4px 8px' }}>Clear</button>}
              </div>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="tbtn" disabled={!!busyKey || !Object.values(keys).some(Boolean)} onClick={saveKeys} style={S.btn(C.blue, true)}>{busyKey === 'keys' ? 'Saving…' : 'Save keys'}</button>
          {['ethereum', 'solana'].map(ch => (
            <label key={ch} style={{ fontSize: 11, color: C.muted, display: 'flex', gap: 6, alignItems: 'center' }}>
              {ch} uses:
              <select value={data.chainProvider[ch]} disabled={!!busyKey} onChange={e => setProvider(ch, e.target.value)} style={{ ...S.inp, width: 'auto', padding: '4px 8px' }}>
                {Object.entries(data.providers).filter(([, p]) => p.chains.includes(ch)).map(([id, p]) => <option key={id} value={id}>{p.label}</option>)}
              </select>
            </label>
          ))}
        </div>
      </div>

      {/* Networks */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
        <div style={S.sectionTitle}>Networks</div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="tbtn" disabled={!!busyKey || !used.length} onClick={testAll} style={S.btn(C.cyan)}>{busyKey === 'testall' ? 'Testing every network…' : 'Test all'}</button>
          <button className="tbtn" onClick={() => setShowAll(v => !v)} style={S.btnMuted}>{showAll ? 'Hide unused' : `Show all ${data.networks.length}`}</button>
        </div>
      </div>

      {!shown.length && <Notice>No RPC endpoints yet. Use "Import from Gateway" to copy the ones Gateway already has, or add one below.</Notice>}
      {shown.map(n => (
        <NetworkCard key={n.id} n={n} unit={n.chain === 'ethereum' ? 'blocks' : 'slots'} onChanged={load} busyKey={busyKey} setBusyKey={setBusyKey} setError={setError} />
      ))}
      {!showAll && hidden.length > 0 && (
        <div style={{ ...S.card, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, color: C.muted }}>Add an RPC for:</span>
          {hidden.map(n => (
            <button key={n.id} className="tbtn" onClick={() => setOpened(o => [...o, n.id])} style={{ ...S.btnMuted, padding: '4px 9px', fontSize: 10 }}>{n.label}</button>
          ))}
        </div>
      )}

      {data.history && data.history.length > 0 && (
        <div style={{ ...S.card, marginTop: 14 }}>
          <div style={S.sectionTitle}>Recent pushes</div>
          {data.history.map(h => (
            <div key={h.id} style={{ fontSize: 11, padding: '5px 0', borderBottom: '1px solid #0b1424', display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ color: C.dim }}>{new Date(h.at).toLocaleString()}</span>
              <Badge color={h.ok ? C.green : C.red}>{h.ok ? 'ok' : 'partial'}</Badge>
              <span>{h.host} · {h.container}</span>
              <span style={{ color: C.muted }}>{h.results.filter(r => r.path === 'nodeURL').map(r => r.namespace).join(', ') || 'provider settings'}</span>
              {h.restarted && <span style={{ color: C.muted }}>restarted</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
