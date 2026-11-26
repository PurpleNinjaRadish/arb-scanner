// ─── Remote Server Recommendations, Multi-Host Manager & 1-Click Provisioning ─
import { useState, useEffect, useCallback } from 'react';
import { api } from '../api';
import { EXCHANGE_PAIRS, EXCHANGES, fmtUsd } from '../constants';
import { C, S, Badge, MetricCard, Notice, CopyBtn } from '../ui';
import LatencyTestPanel from './LatencyTestPanel';

const EMPTY_SERVER = {
  id: '', name: '', provider: 'hetzner', host: '', port: 22,
  username: 'ubuntu', pemPath: '', hbDir: '~/hummingbot', region: 'us-east', monthlyCost: 10.5,
};

export default function ServersAdvisorTab({
  hosts = [], hostStatuses = {}, config, onConfigChanged,
  advisorSeed, activePairId,
}) {
  const [sub, setSub] = useState('advisor'); // 'advisor' | 'hosts' | 'provision' | 'fees'

  // Advisor state
  const [targetBots, setTargetBots] = useState(advisorSeed?.bots || 4);
  const [pairId, setPairId] = useState(activePairId || 'kraken_coinbase');
  const [expectedGross, setExpectedGross] = useState(advisorSeed?.gross || 180);
  const [prioritizeLatency, setPrioritizeLatency] = useState(false);
  const [rec, setRec] = useState(null);

  // Live latency & capacity benchmark
  const [benchHost, setBenchHost] = useState('local');
  const [latencyRes, setLatencyRes] = useState(null);
  const [capRes, setCapRes] = useState(null);
  const [benchBusy, setBenchBusy] = useState(false);

  // Local & global config editor
  const [localMode, setLocalMode] = useState(config?.local?.mode || 'native');
  const [localDir, setLocalDir] = useState(config?.local?.hbDir || '~/hummingbot');
  const [wslDistro, setWslDistro] = useState(config?.local?.wslDistro || '');
  const [hbImage, setHbImage] = useState(config?.hbImage || 'hummingbot/hummingbot:version-2.14.0');
  const [hbPassword, setHbPassword] = useState('');
  const [vpnIp, setVpnIp] = useState(config?.vpnDedicatedIp || '');
  const [fees, setFees] = useState(config?.fees || {});

  // Remote server form
  const [srvForm, setSrvForm] = useState(EMPTY_SERVER);
  const [msg, setMsg] = useState(null);

  // Provisioning scripts & jobs
  const [provTarget, setProvTarget] = useState('');
  const [bootScript, setBootScript] = useState('');
  const [composeYaml, setComposeYaml] = useState('');
  const [jobs, setJobs] = useState([]);

  useEffect(() => {
    if (!config) return;
    setLocalMode(config.local?.mode || 'native');
    setLocalDir(config.local?.hbDir || '~/hummingbot');
    setWslDistro(config.local?.wslDistro || '');
    setHbImage(config.hbImage || 'hummingbot/hummingbot:version-2.14.0');
    setVpnIp(config.vpnDedicatedIp || '');
    setFees(config.fees || {});
  }, [config]);

  useEffect(() => {
    if (advisorSeed) {
      if (advisorSeed.bots) setTargetBots(advisorSeed.bots);
      if (advisorSeed.gross) setExpectedGross(Math.round(advisorSeed.gross));
      setSub('advisor');
    }
  }, [advisorSeed]);

  const loadRecommendations = useCallback(async () => {
    try {
      const d = await api('/api/advisor/servers', {
        params: { bots: targetBots, pair: pairId, gross: expectedGross, latency: prioritizeLatency ? '1' : '0' },
      });
      setRec(d);
    } catch (_) {}
  }, [targetBots, pairId, expectedGross, prioritizeLatency]);

  useEffect(() => { loadRecommendations(); }, [loadRecommendations]);

  const loadProvisionTemplates = useCallback(async () => {
    try {
      const [sRes, cRes, jRes] = await Promise.all([
        api('/api/provision/script'),
        api('/api/provision/compose'),
        api('/api/jobs'),
      ]);
      setBootScript(sRes.script || '');
      setComposeYaml(cRes.compose || '');
      setJobs(jRes.jobs || []);
    } catch (_) {}
  }, []);

  useEffect(() => {
    if (sub === 'provision') {
      loadProvisionTemplates();
      const firstRemote = hosts.find(h => h.id !== 'local');
      if (!provTarget && firstRemote) setProvTarget(firstRemote.id);
    }
  }, [sub, hosts, provTarget, loadProvisionTemplates]);

  // Poll running jobs
  useEffect(() => {
    const running = jobs.some(j => j.status === 'running');
    if (!running) return undefined;
    const iv = setInterval(async () => {
      try { const d = await api('/api/jobs'); setJobs(d.jobs || []); } catch (_) {}
    }, 2000);
    return () => clearInterval(iv);
  }, [jobs]);

  const runBenchmarks = async () => {
    setBenchBusy(true); setMsg(null);
    try {
      const [lat, cap] = await Promise.all([
        api('/api/advisor/latency', { method: 'POST', body: { target: benchHost } }),
        api('/api/advisor/capacity', { params: { target: benchHost } }).catch(() => null),
      ]);
      setLatencyRes(lat);
      setCapRes(cap);
    } catch (e) { setMsg({ tone: 'error', text: e.message }); }
    finally { setBenchBusy(false); }
  };

  const saveGlobalConfig = async () => {
    setMsg(null);
    try {
      await api('/api/config', {
        method: 'POST',
        body: {
          hbImage,
          ...(hbPassword ? { hbPassword } : {}),
          local: { mode: localMode, hbDir: localDir, wslDistro },
          vpnDedicatedIp: vpnIp,
        },
      });
      setHbPassword('');
      setMsg({ tone: 'ok', text: 'Saved local & Hummingbot settings!' });
      if (onConfigChanged) onConfigChanged();
    } catch (e) { setMsg({ tone: 'error', text: e.message }); }
  };

  const saveFeeSchedule = async () => {
    setMsg(null);
    try {
      await api('/api/config', { method: 'POST', body: { fees } });
      setMsg({ tone: 'ok', text: 'Exchange fee schedule saved! All scans & paper simulations now use these rates.' });
      if (onConfigChanged) onConfigChanged();
    } catch (e) { setMsg({ tone: 'error', text: e.message }); }
  };

  const saveServer = async () => {
    setMsg(null);
    try {
      await api('/api/servers', { method: 'POST', body: srvForm });
      setMsg({ tone: 'ok', text: `Saved remote server "${srvForm.name || srvForm.id}".` });
      setSrvForm(EMPTY_SERVER);
      if (onConfigChanged) onConfigChanged();
    } catch (e) { setMsg({ tone: 'error', text: e.message }); }
  };

  const deleteServer = async (id) => {
    if (!window.confirm(`Remove server "${id}" from config?`)) return;
    await api(`/api/servers/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (onConfigChanged) onConfigChanged();
  };

  const testServer = async (id) => {
    setMsg({ tone: 'info', text: `Testing connection to ${id}...` });
    try {
      const r = await api(`/api/host/${encodeURIComponent(id)}/test`, { method: 'POST' });
      setMsg({ tone: 'ok', text: `${id}: ${r.message}` });
      if (onConfigChanged) onConfigChanged();
    } catch (e) { setMsg({ tone: 'error', text: `${id}: ${e.message}` }); }
  };

  const startBootstrap = async () => {
    if (!provTarget) return setMsg({ tone: 'error', text: 'Pick a target server first.' });
    setMsg(null);
    try {
      const r = await api('/api/provision/run', { method: 'POST', body: { target: provTarget } });
      setJobs(prev => [r.job, ...prev]);
      setMsg({ tone: 'ok', text: `Started 1-click bootstrap job ${r.job.id} on ${provTarget}. Watch live output below.` });
    } catch (e) { setMsg({ tone: 'error', text: e.message }); }
  };

  const saveCurrentVpnIp = async () => {
    try {
      const r = await api('/api/vpn-status/save', { method: 'POST' });
      setVpnIp(r.savedIp);
      setMsg({ tone: 'ok', text: `Saved current IP (${r.savedIp}) as trusted VPN IP.` });
      if (onConfigChanged) onConfigChanged();
    } catch (e) { setMsg({ tone: 'error', text: e.message }); }
  };

  return (
    <div>
      {/* Sub-tabs */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
        {[
          ['advisor',   '🖥 Server Recommendations & Sizer'],
          ['hosts',     '☁ Local & Remote Hosts'],
          ['latency',   '⏱ Latency Test'],
          ['provision', '⚡ 1-Click Remote Bootstrap'],
          ['fees',      '💸 Exchange Fee Schedule'],
        ].map(([k, l]) => (
          <button key={k} className="tbtn" onClick={() => setSub(k)} style={sub === k ? S.btn(C.blue, true) : S.btnMuted}>{l}</button>
        ))}
      </div>

      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}

      {/* 1. SERVER RECOMMENDATIONS & CAPACITY SIZER */}
      {sub === 'advisor' && (
        <div>
          <div style={{ ...S.card, marginBottom: 14 }}>
            <div style={S.sectionTitle}>Remote Server Sizer & Exchange Proximity Advisor</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 14 }}>
              <div>
                <label style={S.lbl}>Target Concurrent Bots ({targetBots})</label>
                <input type="range" min="1" max="16" value={targetBots} onChange={e => setTargetBots(Number(e.target.value))} style={{ width: '100%' }} />
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: C.dim }}><span>1 bot</span><span>6 bots</span><span>16 bots</span></div>
              </div>
              <div>
                <label style={S.lbl}>Primary Exchange Pair</label>
                <select style={S.inp} value={pairId} onChange={e => setPairId(e.target.value)}>
                  {EXCHANGE_PAIRS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                </select>
              </div>
              <div>
                <label style={S.lbl}>Expected Monthly Gross ($)</label>
                <input type="number" step="25" style={S.inp} value={expectedGross} onChange={e => setExpectedGross(Number(e.target.value) || 0)} />
              </div>
              <div style={{ display: 'flex', alignItems: 'center' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: C.text, cursor: 'pointer' }}>
                  <input type="checkbox" checked={prioritizeLatency} onChange={e => setPrioritizeLatency(e.target.checked)} />
                  Prioritize Dedicated CPU / Lowest Latency
                </label>
              </div>
            </div>

            {rec && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div style={{ background: '#040914', border: `1px solid ${C.cyan}55`, borderRadius: 8, padding: 14 }}>
                  <div style={{ fontSize: 10, color: C.cyan, letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 4 }}>Optimal Server Region</div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: '#e2f1ff', marginBottom: 6 }}>{rec.regionGuidance.primaryRegion}</div>
                  <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.65 }}>
                    {rec.regionGuidance.why}
                    <div style={{ marginTop: 6, color: C.green }}>Expected RTT: <b>{rec.regionGuidance.expectedRttMs}</b> · Backup: {rec.regionGuidance.backupRegion}</div>
                  </div>
                </div>

                {rec.recommended && (
                  <div style={{ background: '#001a10', border: `1px solid ${C.green}66`, borderRadius: 8, padding: 14 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                      <span style={{ fontSize: 10, color: C.green, letterSpacing: 1.5, textTransform: 'uppercase' }}>Top Recommended Pick for {targetBots} Bot(s)</span>
                      <Badge color={C.green}>{fmtUsd(rec.recommended.monthlyUsd)}/mo</Badge>
                    </div>
                    <div style={{ fontSize: 15, fontWeight: 700, color: '#e2f1ff', marginBottom: 6 }}>
                      {rec.recommended.provider} — {rec.recommended.tier}
                    </div>
                    <div style={{ fontSize: 11, color: '#a7f3d0', lineHeight: 1.65 }}>
                      <b>{rec.recommended.vcpu} vCPU · {rec.recommended.ramGb} GB RAM · {rec.recommended.diskGb} GB NVMe</b><br />
                      Safe Capacity: <b>{rec.recommended.recommendedBots} bots</b> (Max {rec.recommended.maxBots}, bottleneck: {rec.recommended.bottleneck}) · ~{fmtUsd(rec.recommended.costPerBot)}/bot/mo<br />
                      {rec.recommended.bestFor}
                    </div>
                  </div>
                )}
              </div>
            )}

            {rec && rec.estimatedCost && (
              <div style={{ marginTop: 12, background: '#04101a', border: `1px solid ${C.cyan}55`, borderRadius: 8, padding: 14, display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'center' }}>
                <div>
                  <div style={{ fontSize: 10, color: C.cyan, letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 4 }}>Estimated Avg Server Cost · {targetBots} Bot(s)</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: '#e2f1ff' }}>
                    {fmtUsd(rec.estimatedCost.avgMonthlyUsd)}<span style={{ fontSize: 12, color: C.muted }}>/mo</span>
                    <span style={{ fontSize: 12, color: C.cyan, marginLeft: 10 }}>{fmtUsd(rec.estimatedCost.perBotMonthlyUsd)}/bot</span>
                  </div>
                </div>
                <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.6, flex: 1, minWidth: 260 }}>
                  {rec.estimatedCost.method}: {rec.estimatedCost.basis.map(b => `${b.name} (${fmtUsd(b.monthlyUsd)})`).join(', ')}.
                  {' '}Range {fmtUsd(rec.estimatedCost.minMonthlyUsd)}–{fmtUsd(rec.estimatedCost.maxMonthlyUsd)}.
                  {' '}Used as the server cost in Projections and in the pre-launch check for hosts with no monthly cost entered.
                </div>
              </div>
            )}
          </div>

          {/* Live Host Latency & Capacity Benchmark */}
          <div style={{ ...S.card, marginBottom: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginBottom: 12 }}>
              <div>
                <div style={S.sectionTitle}>Live Exchange Latency & Host Capacity Benchmark</div>
                <div style={{ fontSize: 11, color: C.muted }}>Measures real HTTP round-trip latency directly FROM your local PC or remote SSH server to each exchange.</div>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <select style={{ ...S.inp, width: 210 }} value={benchHost} onChange={e => setBenchHost(e.target.value)}>
                  {hosts.map(h => <option key={h.id} value={h.id}>{h.name}</option>)}
                </select>
                <button className="tbtn" disabled={benchBusy} onClick={runBenchmarks} style={S.btn(C.cyan, true)}>
                  {benchBusy ? 'Measuring...' : '⚡ Measure Latency & Specs'}
                </button>
              </div>
            </div>

            {capRes && capRes.available && (
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
                <MetricCard label="Measured Specs" value={`${capRes.specs.vcpu} vCPU / ${capRes.specs.ramGb} GB`} sub={capRes.specs.os} />
                <MetricCard label="Safe Bot Capacity" value={`${capRes.capacity.recommendedBots} bots`} sub={`Hard max ${capRes.capacity.maxBots} (${capRes.capacity.bottleneck})`} color={C.green} />
                <MetricCard label="Currently Running" value={`${capRes.capacity.runningBots} bots`} sub={`${capRes.capacity.botsRamMb} MB RAM · ${capRes.capacity.botsCpuPct}% CPU`} color={C.blue} />
                <MetricCard label="Remaining Slots" value={capRes.capacity.remainingSafeSlots} sub={`~${capRes.capacity.avgRamPerBotMb} MB/bot`} color={capRes.capacity.remainingSafeSlots > 0 ? C.cyan : C.red} />
                {capRes.specs.ntpSynced !== null && (
                  <MetricCard label="NTP Clock Sync" value={capRes.specs.ntpSynced ? 'SYNCED' : 'UNSYNCED'} color={capRes.specs.ntpSynced ? C.green : C.red} />
                )}
              </div>
            )}

            {latencyRes && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(145px, 1fr))', gap: 8 }}>
                {Object.entries(latencyRes.results).map(([ex, r]) => (
                  <div key={ex} style={{ background: '#04070e', border: `1px solid ${C.border}`, borderRadius: 6, padding: '8px 10px' }}>
                    <div style={{ fontSize: 10, color: C.muted }}>{EXCHANGES[ex]?.label || ex}</div>
                    {r.ok ? (
                      <div style={{ fontSize: 16, fontWeight: 700, fontFamily: "'Orbitron', sans-serif", marginTop: 3, color: r.avgMs < 40 ? C.green : r.avgMs < 120 ? C.yellow : C.red }}>
                        {r.avgMs} ms <span style={{ fontSize: 10, color: C.dim }}>(min {r.minMs})</span>
                      </div>
                    ) : (
                      <div style={{ fontSize: 11, color: C.red, marginTop: 4 }}>{r.error}</div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Full Server Comparison Matrix */}
          {rec && (
            <div style={{ ...S.card, marginBottom: 14 }}>
              <div style={S.sectionTitle}>Server Specification & Bot Capacity Comparison Matrix</div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                  <thead>
                    <tr style={{ background: '#04070e', color: C.muted, textAlign: 'left' }}>
                      {['Provider / Tier', 'Specs', 'Safe / Max Bots', 'Bottleneck', '$/Month', '$/Bot', '% of Gross', 'Best For'].map(h => (
                        <th key={h} style={{ padding: '8px 10px', borderBottom: `1px solid ${C.border}` }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rec.catalog.map(s => (
                      <tr key={s.id} style={{ borderBottom: `1px solid #0b1424`, background: rec.recommended?.id === s.id ? '#001a1044' : 'transparent' }}>
                        <td style={{ padding: '8px 10px', fontWeight: 700 }}>
                          {s.provider} <span style={{ color: C.cyan }}>{s.tier}</span>{' '}
                          {s.fits && <Badge color={C.green}>FITS</Badge>}
                          {!s.fits && s.fitsMax && <Badge color={C.yellow}>TIGHT</Badge>}
                        </td>
                        <td style={{ padding: '8px 10px' }}>{s.vcpu} vCPU · {s.ramGb} GB · {s.diskGb} GB</td>
                        <td style={{ padding: '8px 10px', fontWeight: 700, color: s.fits ? C.green : C.muted }}>{s.recommendedBots} / {s.maxBots} bots</td>
                        <td style={{ padding: '8px 10px', color: C.muted }}>{s.bottleneck}</td>
                        <td style={{ padding: '8px 10px', fontWeight: 700, color: C.yellow }}>{s.monthlyUsd === 0 ? 'Free' : fmtUsd(s.monthlyUsd)}</td>
                        <td style={{ padding: '8px 10px' }}>{s.costPerBot ? fmtUsd(s.costPerBot) : '—'}</td>
                        <td style={{ padding: '8px 10px', color: (s.costPctOfGross || 0) > 25 ? C.red : C.green }}>
                          {s.costPctOfGross != null ? `${s.costPctOfGross}%` : '—'}
                        </td>
                        <td style={{ padding: '8px 10px', color: C.muted }}>{s.bestFor}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Hardening Checklist */}
          {rec && (
            <div style={S.card}>
              <div style={S.sectionTitle}>Production Server Configuration & Hardening Checklist</div>
              <div style={{ display: 'grid', gap: 8 }}>
                {rec.checklist.map(c => (
                  <div key={c.item} style={{ display: 'grid', gridTemplateColumns: '210px 1fr', gap: 12, padding: '8px 12px', background: '#04070e', border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 11 }}>
                    <div style={{ color: C.cyan, fontWeight: 700 }}>{c.item}</div>
                    <div style={{ color: C.text, lineHeight: 1.6 }}>{c.value}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* 2. LOCAL & REMOTE HOSTS */}
      {sub === 'hosts' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <div style={S.card}>
            <div style={S.sectionTitle}>Local Host & Global Hummingbot Settings</div>
            <div style={{ display: 'grid', gap: 10 }}>
              <div>
                <label style={S.lbl}>Local Execution Mode</label>
                <select style={S.inp} value={localMode} onChange={e => setLocalMode(e.target.value)}>
                  <option value="native">Native Docker Desktop (Windows / Linux)</option>
                  <option value="wsl">Windows Subsystem for Linux (WSL2)</option>
                </select>
              </div>
              {localMode === 'wsl' && (
                <div>
                  <label style={S.lbl}>WSL Distro (optional, e.g. Ubuntu)</label>
                  <input style={S.inp} value={wslDistro} onChange={e => setWslDistro(e.target.value)} placeholder="default distro" />
                </div>
              )}
              <div>
                <label style={S.lbl}>Local Hummingbot Directory</label>
                <input style={S.inp} value={localDir} onChange={e => setLocalDir(e.target.value)} placeholder="~/hummingbot" />
              </div>
              <div>
                <label style={S.lbl}>Hummingbot Docker Image</label>
                <input style={S.inp} value={hbImage} onChange={e => setHbImage(e.target.value)} />
              </div>
              <div>
                <label style={S.lbl}>Hummingbot CONFIG_PASSWORD {config?.hasHbPassword ? '(set — leave blank to keep)' : '(not set)'}</label>
                <input type="password" style={S.inp} value={hbPassword} onChange={e => setHbPassword(e.target.value)} placeholder="••••••••" />
              </div>
              <div>
                <label style={S.lbl}>Optional Dedicated VPN IP Guard (for AWS Security Group)</label>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input style={S.inp} value={vpnIp} onChange={e => setVpnIp(e.target.value)} placeholder="Leave empty to disable" />
                  <button className="tbtn" onClick={saveCurrentVpnIp} style={S.btn(C.cyan)}>Use Current IP</button>
                </div>
              </div>
              <button className="tbtn" onClick={saveGlobalConfig} style={S.btn(C.green, true)}>💾 Save Local & Hummingbot Settings</button>
            </div>
          </div>

          <div style={S.card}>
            <div style={S.sectionTitle}>Remote SSH Servers ({hosts.filter(h => h.id !== 'local').length})</div>
            <div style={{ display: 'grid', gap: 8, marginBottom: 14 }}>
              {(config?.servers || []).map(s => {
                const st = hostStatuses[s.id];
                return (
                  <div key={s.id} style={{ background: '#04070e', border: `1px solid ${C.border}`, borderRadius: 8, padding: 10 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
                      <div>
                        <span style={{ fontWeight: 700 }}>{s.name}</span> <Badge color={st?.online ? C.green : C.red}>{st?.online ? 'ONLINE' : 'OFFLINE'}</Badge>{' '}
                        {s.monthlyCost > 0 && <Badge color={C.yellow}>${s.monthlyCost}/mo</Badge>}
                        <div style={{ fontSize: 10, color: C.muted, marginTop: 3 }}>{s.username}@{s.host}:{s.port || 22} · {s.hbDir}</div>
                      </div>
                      <div style={{ display: 'flex', gap: 5 }}>
                        <button className="tbtn" onClick={() => testServer(s.id)} style={S.btn(C.cyan)}>Test</button>
                        <button className="tbtn" onClick={() => setSrvForm(s)} style={S.btn(C.blue)}>Edit</button>
                        <button className="tbtn" onClick={() => deleteServer(s.id)} style={S.btn(C.red)}>Del</button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            <div style={{ ...S.lbl, color: C.blue, marginBottom: 8 }}>Add / Edit Remote Server</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <div><label style={S.lbl}>Short ID</label><input style={S.inp} placeholder="hetzner-va" value={srvForm.id} onChange={e => setSrvForm({ ...srvForm, id: e.target.value })} /></div>
              <div><label style={S.lbl}>Display Name</label><input style={S.inp} placeholder="Hetzner Ashburn" value={srvForm.name} onChange={e => setSrvForm({ ...srvForm, name: e.target.value })} /></div>
              <div style={{ gridColumn: '1 / -1' }}><label style={S.lbl}>Host / IP / DNS</label><input style={S.inp} placeholder="1.2.3.4 or ec2-....amazonaws.com" value={srvForm.host} onChange={e => setSrvForm({ ...srvForm, host: e.target.value })} /></div>
              <div><label style={S.lbl}>SSH User</label><input style={S.inp} value={srvForm.username} onChange={e => setSrvForm({ ...srvForm, username: e.target.value })} /></div>
              <div><label style={S.lbl}>SSH Port</label><input type="number" style={S.inp} value={srvForm.port} onChange={e => setSrvForm({ ...srvForm, port: Number(e.target.value) || 22 })} /></div>
              <div style={{ gridColumn: '1 / -1' }}><label style={S.lbl}>Local SSH Private Key / PEM Path</label><input style={S.inp} placeholder="C:\Users\you\.ssh\id_ed25519 or E:\Downloads\key.pem" value={srvForm.pemPath} onChange={e => setSrvForm({ ...srvForm, pemPath: e.target.value })} /></div>
              <div><label style={S.lbl}>Remote Hummingbot Dir</label><input style={S.inp} value={srvForm.hbDir} onChange={e => setSrvForm({ ...srvForm, hbDir: e.target.value })} /></div>
              <div><label style={S.lbl}>Monthly Cost ($)</label><input type="number" step="0.5" style={S.inp} value={srvForm.monthlyCost} onChange={e => setSrvForm({ ...srvForm, monthlyCost: parseFloat(e.target.value) || 0 })} /></div>
            </div>
            <button className="tbtn" onClick={saveServer} style={{ ...S.btn(C.green, true), width: '100%', marginTop: 12 }}>+ Save Remote Server</button>
          </div>
        </div>
      )}

      {/* 3. 1-CLICK REMOTE PROVISIONING */}
      {sub === 'provision' && (
        <div style={{ display: 'grid', gap: 14 }}>
          <div style={S.card}>
            <div style={S.sectionTitle}>1-Click Remote Server Bootstrap (Docker + Swap + Log Rotation + NTP + Hummingbot)</div>
            <div style={{ fontSize: 11, color: C.muted, marginBottom: 12, lineHeight: 1.65 }}>
              Turns a brand-new Ubuntu / Debian / Amazon Linux VPS (or WSL2 distro) into a production-ready Hummingbot host in one click: installs Docker, enables 10m×3 log rotation, creates a 2 GB swap safety net on ≤4 GB servers, verifies NTP clock sync, creates Hummingbot folders, seeds Kraken + Coinbase paper config, and pulls the Hummingbot image.
            </div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <select style={{ ...S.inp, width: 280 }} value={provTarget} onChange={e => setProvTarget(e.target.value)}>
                <option value="">-- Select Target Host --</option>
                {hosts.map(h => <option key={h.id} value={h.id}>{h.name} ({h.kind})</option>)}
              </select>
              <button className="tbtn" onClick={startBootstrap} style={S.btn(C.green, true)}>⚡ Bootstrap Host via SSH / WSL</button>
            </div>

            {jobs.length > 0 && (
              <div style={{ marginTop: 14, display: 'grid', gap: 10 }}>
                {jobs.slice(0, 4).map(j => (
                  <div key={j.id} style={{ background: '#04070e', border: `1px solid ${j.status === 'error' ? C.red : j.status === 'done' ? C.green : C.blue}55`, borderRadius: 8, padding: 10 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                      <span style={{ fontWeight: 700, fontSize: 11 }}>{j.type.toUpperCase()} · {j.target} ({j.id})</span>
                      <Badge color={j.status === 'done' ? C.green : j.status === 'error' ? C.red : C.yellow}>{j.status}</Badge>
                    </div>
                    <pre style={{ ...S.codeBox, maxHeight: 200, fontSize: 10, color: '#a7f3d0' }}>{j.log}</pre>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <div style={S.card}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <div style={S.sectionTitle}>Manual / Cloud-Init Bootstrap Script</div>
                <CopyBtn text={bootScript} label="Copy Script" />
              </div>
              <pre style={{ ...S.codeBox, maxHeight: 340, fontSize: 10 }}>{bootScript}</pre>
            </div>
            <div style={S.card}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <div style={S.sectionTitle}>Self-Hosted docker-compose.yml</div>
                <CopyBtn text={composeYaml} label="Copy Compose" />
              </div>
              <pre style={{ ...S.codeBox, maxHeight: 340, fontSize: 10 }}>{composeYaml}</pre>
            </div>
          </div>
        </div>
      )}

      {/* 4. EXCHANGE FEE SCHEDULE */}
      {sub === 'latency' && <LatencyTestPanel hosts={hosts} />}

      {sub === 'fees' && (
        <div style={S.card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginBottom: 14 }}>
            <div>
              <div style={S.sectionTitle}>Exchange Maker / Taker Fee Schedule (%)</div>
              <div style={{ fontSize: 11, color: C.muted }}>
                Enter your actual account fee tier percentages (e.g., 0.25 for 0.25%). Kraken & Coinbase start high at base tier and drop rapidly with 30-day volume.
              </div>
            </div>
            <button className="tbtn" onClick={saveFeeSchedule} style={S.btn(C.green, true)}>💾 Save Fee Schedule</button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 10 }}>
            {Object.keys(EXCHANGES).map(ex => {
              const f = fees[ex] || { maker: 0.001, taker: 0.001 };
              return (
                <div key={ex} style={{ background: '#04070e', border: `1px solid ${C.border}`, borderRadius: 8, padding: 12 }}>
                  <div style={{ fontWeight: 700, color: EXCHANGES[ex].color, marginBottom: 8 }}>{EXCHANGES[ex].label}</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    <div>
                      <label style={S.lbl}>Maker %</label>
                      <input type="number" step="0.01" style={S.inp}
                        value={Number((f.maker * 100).toFixed(4))}
                        onChange={e => setFees(p => ({ ...p, [ex]: { ...f, maker: (parseFloat(e.target.value) || 0) / 100 } }))} />
                    </div>
                    <div>
                      <label style={S.lbl}>Taker %</label>
                      <input type="number" step="0.01" style={S.inp}
                        value={Number((f.taker * 100).toFixed(4))}
                        onChange={e => setFees(p => ({ ...p, [ex]: { ...f, taker: (parseFloat(e.target.value) || 0) / 100 } }))} />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
