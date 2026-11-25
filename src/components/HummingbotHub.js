// ─── Complete Hummingbot Control Center ───────────────────────────────────────
// Manage every aspect of Hummingbot on Local (Docker Desktop / WSL) & Remote SSH hosts:
//   1. Containers (Start, Stop, Restart, Pause, Unpause, Remove, Live CPU/RAM, Logs, Edit, Attach)
//   2. Strategy Files (Browse, Edit, Validate, Create, Launch, Delete)
//   3. Paper Trade Config (conf/conf_client.yml — exchanges, balances, kill switch, 1-click seed)
//   4. Exchange Connectors / API Keys (List, Delete, Secure Connect Terminal, Web Inject + Coinbase JSON)
//   5. Realized Trades & P&L (Parsed CSV summary, per-pair matched P&L, executions, raw export)
//   6. Strategy Log Browser (tail any logs/*.log file cleanly)
import { useState, useEffect, useCallback } from 'react';
import { api } from '../api';
import { fmtUsd } from '../constants';
import { C, S, Badge, MetricCard, Notice, Modal, CopyBtn } from '../ui';

const SUBTABS = [
  ['containers', '🐳 Containers'],
  ['strategies', '📄 Strategies'],
  ['paper',      '🧪 Paper Config'],
  ['connectors', '🔑 Connectors'],
  ['trades',     '📊 Trades & P&L'],
  ['logs',       '📜 Logs'],
];

const PAPER_EXCHANGE_CHOICES = [
  ['kraken', 'Kraken'],
  ['coinbase_advanced_trade', 'Coinbase Advanced Trade'],
  ['binance', 'Binance'],
  ['binance_us', 'Binance.US'],
  ['kucoin', 'KuCoin'],
  ['bybit', 'Bybit'],
  ['okx', 'OKX'],
  ['gate_io', 'Gate.io'],
];

function ContainerInspectModal({ container, target, onClose, onRestarted }) {
  const [tab, setTab] = useState('logs');
  const [logSource, setLogSource] = useState('auto');
  const [logs, setLogs] = useState('Loading...');
  const [logFile, setLogFile] = useState(null);
  const [yaml, setYaml] = useState('');
  const [configName, setConfigName] = useState(container.configName || '');
  const [attachInfo, setAttachInfo] = useState(null);
  const [msg, setMsg] = useState('');
  const [saving, setSaving] = useState(false);

  const loadLogs = useCallback(async () => {
    try {
      const d = await api(`/api/instance/${encodeURIComponent(container.id)}/logs`, { params: { target, source: logSource, tail: 300 } });
      setLogs(d.logs || '');
      setLogFile(d.logFile || null);
    } catch (e) { setLogs(`Error: ${e.message}`); }
  }, [container.id, target, logSource]);

  const loadConfig = useCallback(async () => {
    try {
      const d = await api(`/api/instance/${encodeURIComponent(container.id)}/config`, { params: { target } });
      setYaml(d.yaml || '');
      setConfigName(d.configName || '');
    } catch (e) { setYaml(`# ${e.message}`); }
  }, [container.id, target]);

  useEffect(() => {
    loadLogs();
    loadConfig();
    const iv = setInterval(loadLogs, 4000);
    return () => clearInterval(iv);
  }, [loadLogs, loadConfig]);

  const saveAndRestart = async () => {
    if (!configName) return;
    setSaving(true); setMsg('');
    try {
      await api('/api/instance/edit', {
        method: 'POST',
        body: { target, containerId: container.id, configName, yaml },
      });
      setMsg('Saved & recreated container!');
      if (onRestarted) onRestarted();
    } catch (e) { setMsg(`Error: ${e.message}`); }
    finally { setSaving(false); }
  };

  const openAttach = async (openWin) => {
    try {
      const d = await api(`/api/instance/${encodeURIComponent(container.id)}/attach`, {
        method: 'POST',
        body: { target, open: openWin },
      });
      setAttachInfo(d);
    } catch (e) { setMsg(`Error: ${e.message}`); }
  };

  return (
    <Modal
      title={`BOT: ${container.name}`}
      subtitle={`${container.id.slice(0, 12)} · ${container.state.toUpperCase()} · ${container.status}${logFile ? ` · ${logFile}` : ''}`}
      onClose={onClose}
      maxWidth={880}
    >
      <div style={{ display: 'flex', gap: 6, marginBottom: 14, borderBottom: `1px solid ${C.border}`, paddingBottom: 10 }}>
        {[['logs', 'Live Logs'], ['config', 'Edit Strategy YAML'], ['attach', 'CLI Attach']].map(([k, l]) => (
          <button key={k} className="tbtn" onClick={() => setTab(k)} style={tab === k ? S.btn(C.blue, true) : S.btnMuted}>{l}</button>
        ))}
      </div>

      {msg && <Notice tone={msg.startsWith('Error') ? 'error' : 'ok'}>{msg}</Notice>}

      {tab === 'logs' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <div style={{ display: 'flex', gap: 6 }}>
              {[['auto', 'Auto (Clean File First)'], ['file', 'Strategy Log File'], ['docker', 'Docker Stdout']].map(([k, l]) => (
                <button key={k} className="tbtn" onClick={() => setLogSource(k)} style={{ ...(logSource === k ? S.btn(C.cyan, true) : S.btnMuted), fontSize: 10, padding: '4px 9px' }}>{l}</button>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <CopyBtn text={logs} label="Copy Logs" />
              <button className="tbtn" onClick={loadLogs} style={S.btn(C.blue)}>↻ Refresh</button>
            </div>
          </div>
          <pre style={{ ...S.codeBox, height: 420, color: '#a7f3d0', fontSize: 11 }}>{logs}</pre>
        </div>
      )}

      {tab === 'config' && (
        <div>
          <Notice tone="warn">Saving overwrites conf/strategies/{configName || '?'}.yml on {target} and recreates the container cleanly.</Notice>
          <textarea value={yaml} onChange={e => setYaml(e.target.value)}
            style={{ ...S.codeBox, width: '100%', height: 340, color: C.text, resize: 'vertical', marginBottom: 12 }} />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <CopyBtn text={yaml} label="Copy YAML" />
            <button className="tbtn" disabled={saving || !configName} onClick={saveAndRestart} style={S.btn(C.green, true)}>
              {saving ? 'Restarting...' : '💾 Save & Restart Container'}
            </button>
          </div>
        </div>
      )}

      {tab === 'attach' && (
        <div>
          <Notice tone="info">
            Attach directly to the live Hummingbot CLI (to run `status`, `history`, `balance`, `stop`, etc.).
            {'\n'}IMPORTANT: Always detach with <b>Ctrl+P then Ctrl+Q</b> so you don't kill the bot!
          </Notice>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <button className="tbtn" onClick={() => openAttach(true)} style={S.btn(C.green, true)}>💻 Open Attach Terminal</button>
            <button className="tbtn" onClick={() => openAttach(false)} style={S.btn(C.blue)}>📋 Show Command</button>
          </div>
          {attachInfo && (
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                <span style={S.lbl}>Command</span>
                <CopyBtn text={attachInfo.command} />
              </div>
              <pre style={S.codeBox}>{attachInfo.command}</pre>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

export default function HummingbotHub({ hosts = [], selectedHost, setSelectedHost, hostStatuses = {}, onRefreshStatus }) {
  const [sub, setSub] = useState('containers');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null); // { tone, text }

  // Containers
  const [containers, setContainers] = useState([]);
  const [inspecting, setInspecting] = useState(null);
  const [capacity, setCapacity] = useState(null);

  // Strategies
  const [strategies, setStrategies] = useState([]);
  const [editingStrat, setEditingStrat] = useState(null); // { name, yaml, isNew }

  // Paper config
  const [paperCfg, setPaperCfg] = useState(null);
  const [newAsset, setNewAsset] = useState('');
  const [newAmt, setNewAmt] = useState('');

  // Connectors
  const [connectors, setConnectors] = useState([]);
  const [connEx, setConnEx] = useState('kraken');
  const [connKey, setConnKey] = useState('');
  const [connSecret, setConnSecret] = useState('');
  const [connPass, setConnPass] = useState('');
  const [termCmd, setTermCmd] = useState('');

  // Trades & PnL
  const [pnl, setPnl] = useState(null);

  // Logs
  const [logFiles, setLogFiles] = useState([]);
  const [selectedLog, setSelectedLog] = useState('');
  const [logContent, setLogContent] = useState('');

  // Pull image job
  const [pullJob, setPullJob] = useState(null);

  const target = selectedHost || 'local';
  const curStatus = hostStatuses[target];

  const flash = (tone, text) => setNotice({ tone, text });

  const loadContainers = useCallback(async () => {
    setBusy(true);
    try {
      const [cRes, capRes] = await Promise.all([
        api('/api/instances', { params: { target } }),
        api('/api/advisor/capacity', { params: { target } }).catch(() => null),
      ]);
      setContainers(cRes.instances || []);
      setCapacity(capRes && capRes.available ? capRes : null);
    } catch (e) {
      setContainers([]);
      flash('error', `Cannot load containers on ${target}: ${e.message}`);
    } finally { setBusy(false); }
  }, [target]);

  const loadStrategies = useCallback(async () => {
    setBusy(true);
    try {
      const d = await api('/api/strategies', { params: { target } });
      setStrategies(d.strategies || []);
    } catch (e) { flash('error', e.message); }
    finally { setBusy(false); }
  }, [target]);

  const loadPaper = useCallback(async () => {
    setBusy(true);
    try {
      const d = await api('/api/paper-config', { params: { target } });
      setPaperCfg(d);
    } catch (e) { flash('error', e.message); }
    finally { setBusy(false); }
  }, [target]);

  const loadConnectors = useCallback(async () => {
    setBusy(true);
    try {
      const d = await api('/api/connectors', { params: { target } });
      setConnectors(d.connectors || []);
    } catch (e) { flash('error', e.message); }
    finally { setBusy(false); }
  }, [target]);

  const loadTrades = useCallback(async () => {
    setBusy(true);
    try { setPnl(await api('/api/pnl', { params: { target } })); }
    catch (e) { flash('error', e.message); }
    finally { setBusy(false); }
  }, [target]);

  const loadLogList = useCallback(async () => {
    setBusy(true);
    try {
      const d = await api('/api/logs', { params: { target } });
      setLogFiles(d.files || []);
    } catch (e) { flash('error', e.message); }
    finally { setBusy(false); }
  }, [target]);

  useEffect(() => {
    setNotice(null);
    if (sub === 'containers') loadContainers();
    else if (sub === 'strategies') loadStrategies();
    else if (sub === 'paper') loadPaper();
    else if (sub === 'connectors') loadConnectors();
    else if (sub === 'trades') loadTrades();
    else if (sub === 'logs') loadLogList();
  }, [sub, target, loadContainers, loadStrategies, loadPaper, loadConnectors, loadTrades, loadLogList]);

  // Poll image pull job if active
  useEffect(() => {
    if (!pullJob || pullJob.status !== 'running') return undefined;
    const iv = setInterval(async () => {
      try {
        const j = await api(`/api/jobs/${pullJob.id}`);
        setPullJob(j);
        if (j.status !== 'running' && onRefreshStatus) onRefreshStatus();
      } catch (_) {}
    }, 2000);
    return () => clearInterval(iv);
  }, [pullJob, onRefreshStatus]);

  const doContainerAction = async (id, action) => {
    try {
      await api(`/api/instance/${encodeURIComponent(id)}/action`, { method: 'POST', body: { target, action } });
      flash('ok', `Action "${action}" succeeded on ${id.slice(0, 12)}.`);
      loadContainers();
      if (onRefreshStatus) onRefreshStatus();
    } catch (e) { flash('error', e.message); }
  };

  const doStopAll = async (remove) => {
    if (!window.confirm(`${remove ? 'Stop AND remove' : 'Stop'} ALL Hummingbot containers on ${target}?`)) return;
    try {
      const r = await api('/api/stop-all', { method: 'POST', body: { target, remove } });
      flash('ok', `Stopped ${r.stopped} container(s)${remove ? `, removed ${r.removed}` : ''}.`);
      loadContainers();
      if (onRefreshStatus) onRefreshStatus();
    } catch (e) { flash('error', e.message); }
  };

  const doDeployBase = async (launchMode) => {
    try {
      const r = await api('/api/deploy-base', { method: 'POST', body: { target, launchMode } });
      flash('ok', r.message || 'Base Hummingbot started.');
      loadContainers();
    } catch (e) { flash('error', e.message); }
  };

  const doPullImage = async () => {
    try {
      const r = await api('/api/image/pull', { method: 'POST', body: { target } });
      setPullJob(r.job);
    } catch (e) { flash('error', e.message); }
  };

  const openStrategyEditor = async (name) => {
    try {
      const d = await api(`/api/strategies/${encodeURIComponent(name)}`, { params: { target } });
      setEditingStrat({ name: d.name, yaml: d.yaml, isNew: false });
    } catch (e) { flash('error', e.message); }
  };

  const saveStrategyFile = async (andLaunch = false) => {
    if (!editingStrat || !editingStrat.name) return;
    try {
      if (andLaunch) {
        const r = await api('/api/deploy', {
          method: 'POST',
          body: { target, configName: editingStrat.name, yaml: editingStrat.yaml, launchMode: 'detached', autoStart: true },
        });
        flash('ok', r.message);
      } else {
        await api('/api/strategies', { method: 'POST', body: { target, name: editingStrat.name, yaml: editingStrat.yaml } });
        flash('ok', `Saved conf/strategies/${editingStrat.name}.yml`);
      }
      setEditingStrat(null);
      loadStrategies();
    } catch (e) { flash('error', e.message); }
  };

  const launchSavedStrategy = async (s) => {
    try {
      const d = await api(`/api/strategies/${encodeURIComponent(s.name)}`, { params: { target } });
      const r = await api('/api/deploy', {
        method: 'POST',
        body: { target, configName: s.name, yaml: d.yaml, launchMode: 'detached', autoStart: true },
      });
      flash('ok', r.message);
      loadStrategies();
      if (onRefreshStatus) onRefreshStatus();
    } catch (e) { flash('error', e.message); }
  };

  const deleteSavedStrategy = async (name) => {
    if (!window.confirm(`Delete conf/strategies/${name}.yml on ${target}?`)) return;
    try {
      await api(`/api/strategies/${encodeURIComponent(name)}`, { method: 'DELETE', params: { target } });
      flash('ok', `Deleted ${name}.yml`);
      loadStrategies();
    } catch (e) { flash('error', e.message); }
  };

  const savePaper = async () => {
    if (!paperCfg) return;
    try {
      const d = await api('/api/paper-config', {
        method: 'POST',
        body: {
          target,
          exchanges: paperCfg.exchanges,
          balances: paperCfg.balances,
          killSwitchEnabled: paperCfg.killSwitchEnabled,
          killSwitchRate: paperCfg.killSwitchRate,
        },
      });
      setPaperCfg(d);
      flash('ok', `Saved conf/conf_client.yml on ${target}! Restart running paper bots to pick up new balances.`);
    } catch (e) { flash('error', e.message); }
  };

  const seedPaperDefaults = async () => {
    try {
      await api('/api/paper-config/seed', { method: 'POST', body: { target } });
      flash('ok', 'Seeded conf/conf_client.yml with Kraken, Coinbase Adv, Binance, KuCoin, Bybit, OKX paper exchanges & starter balances!');
      loadPaper();
    } catch (e) { flash('error', e.message); }
  };

  const saveConnectorKeys = async () => {
    try {
      const r = await api('/api/exchange/add', {
        method: 'POST',
        body: { target, exchange: connEx, apiKey: connKey, apiSecret: connSecret, passphrase: connPass },
      });
      flash('ok', `${r.exchange}: ${r.note}`);
      setConnKey(''); setConnSecret(''); setConnPass('');
      loadConnectors();
    } catch (e) { flash('error', e.message); }
  };

  const launchConnectTerm = async () => {
    try {
      const r = await api('/api/exchange/terminal', { method: 'POST', body: { target, open: true } });
      setTermCmd(r.command || '');
      flash('ok', r.opened ? 'Opened interactive Hummingbot terminal — type `connect kraken` or `connect coinbase_advanced_trade`.' : 'Copy and run the command below in a terminal.');
    } catch (e) { flash('error', e.message); }
  };

  const openLogFile = async (name) => {
    setSelectedLog(name);
    setLogContent('Loading...');
    try {
      const d = await api(`/api/logs/${encodeURIComponent(name)}`, { params: { target, lines: 350 } });
      setLogContent(d.logs || '(empty)');
    } catch (e) { setLogContent(`Error: ${e.message}`); }
  };

  const downloadCsv = () => {
    if (!pnl || !pnl.csvData) return;
    const blob = new Blob([pnl.csvData], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `hummingbot_trades_${target}_${Date.now()}.csv`;
    a.click();
  };

  return (
    <div>
      {inspecting && (
        <ContainerInspectModal
          container={inspecting}
          target={target}
          onClose={() => setInspecting(null)}
          onRestarted={loadContainers}
        />
      )}

      {editingStrat && (
        <Modal
          title={editingStrat.isNew ? 'NEW STRATEGY YAML' : `EDIT: ${editingStrat.name}.yml`}
          subtitle={`Host: ${target} · conf/strategies/`}
          onClose={() => setEditingStrat(null)}
          maxWidth={760}
        >
          <div style={{ marginBottom: 10 }}>
            <label style={S.lbl}>Strategy Name</label>
            <input style={S.inp} value={editingStrat.name} disabled={!editingStrat.isNew}
              onChange={e => setEditingStrat(s => ({ ...s, name: e.target.value.replace(/[^a-zA-Z0-9_.-]/g, '') }))} />
          </div>
          <label style={S.lbl}>YAML Content</label>
          <textarea value={editingStrat.yaml} onChange={e => setEditingStrat(s => ({ ...s, yaml: e.target.value }))}
            style={{ ...S.codeBox, width: '100%', height: 340, color: C.text, resize: 'vertical', marginBottom: 14 }} />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button className="tbtn" onClick={() => setEditingStrat(null)} style={S.btnMuted}>Cancel</button>
            <button className="tbtn" onClick={() => saveStrategyFile(false)} style={S.btn(C.yellow)}>💾 Save File</button>
            <button className="tbtn" onClick={() => saveStrategyFile(true)} style={S.btn(C.green, true)}>🚀 Save & Launch Bot</button>
          </div>
        </Modal>
      )}

      {/* Host switcher bar */}
      <div style={{ ...S.card, marginBottom: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontSize: 10, color: C.muted, letterSpacing: 1.5, textTransform: 'uppercase', marginRight: 4 }}>Manage Host:</span>
            {hosts.map(h => {
              const st = hostStatuses[h.id];
              const online = st && st.online;
              return (
                <button key={h.id} className="tbtn" onClick={() => setSelectedHost(h.id)}
                  style={target === h.id ? S.btn(online ? C.green : C.blue, true) : S.btnMuted}>
                  {online ? '🟢' : '🔴'} {h.name} {st ? `(${st.runningCount || 0} running)` : ''}
                </button>
              );
            })}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="tbtn" onClick={doPullImage} style={S.btn(C.purple)}>⬇ Pull Hummingbot Image</button>
            <button className="tbtn" onClick={() => { if (onRefreshStatus) onRefreshStatus(); loadContainers(); }} style={S.btn(C.blue)}>↻ Refresh Host</button>
          </div>
        </div>

        {/* Host summary metrics */}
        {curStatus && (
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 12, paddingTop: 12, borderTop: `1px solid ${C.border}` }}>
            <MetricCard label="Docker Engine" value={curStatus.online ? `v${curStatus.dockerVersion}` : 'OFFLINE'} sub={curStatus.kind} color={curStatus.online ? C.green : C.red} />
            <MetricCard label="Hummingbot Image" value={curStatus.imagePresent ? 'READY' : 'MISSING'} sub={curStatus.imageSizeMb ? `${curStatus.imageSizeMb} MB` : curStatus.hbImage} color={curStatus.imagePresent ? C.cyan : C.yellow} />
            <MetricCard label="Active Bots" value={`${curStatus.runningCount} / ${curStatus.totalCount}`} sub="Running / Total" color={C.blue} />
            {capacity && (
              <>
                <MetricCard label="Host Specs" value={`${capacity.specs.vcpu} vCPU · ${capacity.specs.ramGb} GB`} sub={capacity.specs.swapGb ? `+${capacity.specs.swapGb} GB swap` : 'No swap'} color={C.text} />
                <MetricCard label="Bot Capacity" value={`${capacity.capacity.remainingSafeSlots} free slots`} sub={`Safe max ${capacity.capacity.recommendedBots} (${capacity.capacity.botsRamMb} MB used)`} color={capacity.capacity.remainingSafeSlots > 0 ? C.green : C.yellow} />
              </>
            )}
          </div>
        )}

        {pullJob && (
          <div style={{ marginTop: 12 }}>
            <Notice tone={pullJob.status === 'error' ? 'error' : pullJob.status === 'done' ? 'ok' : 'info'}>
              Image Pull ({pullJob.status.toUpperCase()}):{'\n'}{pullJob.log}
            </Notice>
          </div>
        )}
      </div>

      {/* Sub-navigation */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
        {SUBTABS.map(([k, l]) => (
          <button key={k} className="tbtn" onClick={() => setSub(k)} style={sub === k ? S.btn(C.blue, true) : S.btnMuted}>{l}</button>
        ))}
      </div>

      {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}

      {/* 1. CONTAINERS */}
      {sub === 'containers' && (
        <div style={S.card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
            <div style={S.sectionTitle}>Hummingbot Docker Containers ({containers.length})</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button className="tbtn" onClick={() => doDeployBase('detached')} style={S.btn(C.blue)}>+ Base Bot (Detached)</button>
              <button className="tbtn" onClick={() => doDeployBase('interactive')} style={S.btn(C.cyan)}>💻 Base Bot (Terminal)</button>
              <button className="tbtn" onClick={() => doStopAll(false)} style={S.btn(C.yellow)}>■ Stop All</button>
              <button className="tbtn" onClick={() => doStopAll(true)} style={S.btn(C.red)}>🗑 Stop & Remove All</button>
            </div>
          </div>

          {busy && containers.length === 0 ? (
            <div style={{ padding: 28, textAlign: 'center', color: C.muted }}>Loading containers from {target}...</div>
          ) : containers.length === 0 ? (
            <div style={{ padding: 32, textAlign: 'center', color: C.muted, border: `1px dashed ${C.border}`, borderRadius: 8 }}>
              No Hummingbot containers found on <b>{target}</b>. Deploy one from the Live Scanner, Strategies tab, or launch a Base Bot above.
            </div>
          ) : (
            <div style={{ display: 'grid', gap: 10 }}>
              {containers.map(c => {
                const running = c.state === 'running';
                const paused = c.state === 'paused';
                return (
                  <div key={c.id} style={{
                    background: '#050912', border: `1px solid ${running ? `${C.green}44` : C.border}`,
                    borderRadius: 8, padding: '12px 14px',
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12,
                  }}>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <span style={{ fontWeight: 700, fontSize: 13, color: '#e2f1ff' }}>{c.name}</span>
                        <Badge color={running ? C.green : paused ? C.yellow : C.red}>{c.state}</Badge>
                        {c.paper === true && <Badge color={C.cyan}>PAPER</Badge>}
                        {c.paper === false && <Badge color={C.red}>LIVE</Badge>}
                        {c.configFile && <Badge color={C.purple}>{c.configFile}</Badge>}
                      </div>
                      <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>
                        ID: {c.id.slice(0, 12)} · {c.status}
                        {c.stats && (
                          <span style={{ color: C.cyan }}>
                            {' · '}CPU {c.stats.cpuPct.toFixed(1)}% · RAM {c.stats.memUsedMb} MB ({c.stats.memPct.toFixed(1)}%) · Net {c.stats.netIO}
                          </span>
                        )}
                      </div>
                    </div>

                    <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                      {!running && !paused && <button className="tbtn" onClick={() => doContainerAction(c.id, 'start')} style={S.btn(C.green)}>▶ Start</button>}
                      {running && <button className="tbtn" onClick={() => doContainerAction(c.id, 'pause')} style={S.btn(C.yellow)}>⏸ Pause</button>}
                      {paused && <button className="tbtn" onClick={() => doContainerAction(c.id, 'unpause')} style={S.btn(C.green)}>▶ Resume</button>}
                      {running && <button className="tbtn" onClick={() => doContainerAction(c.id, 'restart')} style={S.btn(C.cyan)}>↻ Restart</button>}
                      <button className="tbtn" onClick={() => setInspecting(c)} style={S.btn(C.blue, true)}>📋 Logs / Edit / Attach</button>
                      {running && <button className="tbtn" onClick={() => doContainerAction(c.id, 'stop')} style={S.btn(C.red)}>■ Stop</button>}
                      <button className="tbtn" onClick={() => doContainerAction(c.id, 'remove')} style={S.btn(C.red)}>✕ Rm</button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* 2. STRATEGIES */}
      {sub === 'strategies' && (
        <div style={S.card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
            <div style={S.sectionTitle}>Saved Strategy Files (conf/strategies/)</div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="tbtn" onClick={() => setEditingStrat({
                name: `custom_arb_${Date.now().toString().slice(-4)}`,
                isNew: true,
                yaml: `strategy: amm_arb\nconnector_1: kraken_paper_trade\nmarket_1: SOL-USD\nconnector_2: coinbase_advanced_trade_paper_trade\nmarket_2: SOL-USD\norder_amount: 5.0\nmin_profitability: 0.35\nmarket_1_slippage_buffer: 0.15\nmarket_2_slippage_buffer: 0.15\nconcurrent_orders_submission: true\n`,
              })} style={S.btn(C.green)}>+ New Strategy YAML</button>
              <button className="tbtn" onClick={loadStrategies} style={S.btn(C.blue)}>↻ Refresh</button>
            </div>
          </div>

          {strategies.length === 0 ? (
            <div style={{ padding: 28, textAlign: 'center', color: C.muted, border: `1px dashed ${C.border}`, borderRadius: 8 }}>
              No strategy YAML files in conf/strategies/ on {target}.
            </div>
          ) : (
            <div style={{ display: 'grid', gap: 8 }}>
              {strategies.map(s => (
                <div key={s.name} style={{
                  background: '#050912', border: `1px solid ${C.border}`, borderRadius: 8, padding: '10px 14px',
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10,
                }}>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 700, color: C.text }}>{s.name}.yml</span>
                      <Badge color={C.blue}>{s.strategy}</Badge>
                      {s.pair && <Badge color={C.cyan}>{s.pair}</Badge>}
                      <Badge color={s.paper ? C.green : C.red}>{s.paper ? 'PAPER' : 'LIVE'}</Badge>
                      {s.container && <Badge color={s.container.state === 'running' ? C.green : C.yellow}>CONTAINER: {s.container.state}</Badge>}
                    </div>
                    <div style={{ fontSize: 10, color: C.muted, marginTop: 4 }}>
                      {s.connectors.join(' ↔ ')} · Size: {s.orderAmount ?? '—'} · Min Profit: {s.minProfitability ?? '—'}%
                      {s.warnings?.length > 0 && <span style={{ color: C.yellow }}> · ⚠ {s.warnings[0]}</span>}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button className="tbtn" onClick={() => launchSavedStrategy(s)} style={S.btn(C.green, true)}>▶ Launch</button>
                    <button className="tbtn" onClick={() => openStrategyEditor(s.name)} style={S.btn(C.blue)}>✏ Edit</button>
                    <button className="tbtn" onClick={() => deleteSavedStrategy(s.name)} style={S.btn(C.red)}>🗑</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 3. PAPER CONFIG (conf/conf_client.yml) */}
      {sub === 'paper' && (
        <div style={S.card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
            <div>
              <div style={S.sectionTitle}>Hummingbot Paper Trade Config (conf/conf_client.yml)</div>
              <div style={{ fontSize: 11, color: C.muted }}>
                Fixes Hummingbot's default exclusion of Coinbase Advanced Trade from paper trading and manages simulated starting balances & kill-switch.
              </div>
            </div>
            <button className="tbtn" onClick={seedPaperDefaults} style={S.btn(C.cyan, true)}>⚡ Auto-Seed Kraken & Coinbase Defaults</button>
          </div>

          {paperCfg && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <div>
                <div style={S.lbl}>Enabled Paper Trade Exchanges (`paper_trade_exchanges`)</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 16 }}>
                  {PAPER_EXCHANGE_CHOICES.map(([key, label]) => {
                    const checked = (paperCfg.exchanges || []).includes(key);
                    return (
                      <label key={key} style={{
                        display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: 6, cursor: 'pointer',
                        background: checked ? '#001a10' : '#04070e',
                        border: `1px solid ${checked ? C.green : C.border}`, fontSize: 11, color: checked ? C.green : C.muted,
                      }}>
                        <input type="checkbox" checked={checked} onChange={e => {
                          const set = new Set(paperCfg.exchanges || []);
                          if (e.target.checked) set.add(key); else set.delete(key);
                          setPaperCfg({ ...paperCfg, exchanges: [...set] });
                        }} />
                        {label}
                      </label>
                    );
                  })}
                </div>

                <div style={S.lbl}>Global Safety Kill Switch</div>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', background: '#04070e', border: `1px solid ${C.border}`, borderRadius: 8, padding: 10 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: C.text, cursor: 'pointer' }}>
                    <input type="checkbox" checked={!!paperCfg.killSwitchEnabled}
                      onChange={e => setPaperCfg({ ...paperCfg, killSwitchEnabled: e.target.checked })} />
                    Enable Kill Switch
                  </label>
                  <div style={{ flex: 1 }}>
                    <input type="number" step="0.5" max="0" style={S.inp} value={paperCfg.killSwitchRate ?? -100}
                      onChange={e => setPaperCfg({ ...paperCfg, killSwitchRate: parseFloat(e.target.value) || -100 })} />
                  </div>
                  <span style={{ fontSize: 10, color: C.muted }}>% drawdown</span>
                </div>
              </div>

              <div>
                <div style={S.lbl}>Paper Account Balances (`paper_trade_account_balance`)</div>
                <div style={{ display: 'grid', gap: 6, maxHeight: 260, overflowY: 'auto', marginBottom: 10 }}>
                  {Object.entries(paperCfg.balances || {}).map(([asset, amt]) => (
                    <div key={asset} style={{ display: 'flex', gap: 8, alignItems: 'center', background: '#04070e', padding: '6px 10px', borderRadius: 6, border: `1px solid ${C.border}` }}>
                      <span style={{ width: 65, fontWeight: 700, color: C.green }}>{asset}</span>
                      <input type="number" style={S.inp} value={amt} onChange={e => setPaperCfg({
                        ...paperCfg, balances: { ...paperCfg.balances, [asset]: parseFloat(e.target.value) || 0 },
                      })} />
                      <button onClick={() => {
                        const copy = { ...paperCfg.balances }; delete copy[asset];
                        setPaperCfg({ ...paperCfg, balances: copy });
                      }} style={{ background: 'none', border: 'none', color: C.red, fontSize: 16, cursor: 'pointer' }}>×</button>
                    </div>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
                  <input style={S.inp} placeholder="Asset (e.g. SOL)" value={newAsset} onChange={e => setNewAsset(e.target.value.toUpperCase())} />
                  <input style={S.inp} type="number" placeholder="Amount" value={newAmt} onChange={e => setNewAmt(e.target.value)} />
                  <button className="tbtn" onClick={() => {
                    if (!newAsset || !newAmt) return;
                    setPaperCfg({ ...paperCfg, balances: { ...paperCfg.balances, [newAsset]: parseFloat(newAmt) || 0 } });
                    setNewAsset(''); setNewAmt('');
                  }} style={S.btn(C.blue)}>+ Add</button>
                </div>
                <button className="tbtn" onClick={savePaper} style={{ ...S.btn(C.green, true), width: '100%', padding: 10 }}>
                  💾 Save conf_client.yml to {target}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* 4. CONNECTORS / API KEYS */}
      {sub === 'connectors' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <div style={S.card}>
            <div style={S.sectionTitle}>Configured Exchange Connectors ({connectors.length})</div>
            <Notice tone="info">
              For live trading, Hummingbot's interactive `connect` command encrypts keys with your CONFIG_PASSWORD.
              Always disable withdrawals on exchange API keys and whitelist your server's static IP.
            </Notice>
            <button className="tbtn" onClick={launchConnectTerm} style={{ ...S.btn(C.green, true), width: '100%', marginBottom: 12, padding: 10 }}>
              💻 Launch Interactive `connect` Terminal
            </button>
            {termCmd && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                  <span style={S.lbl}>Terminal Command</span>
                  <CopyBtn text={termCmd} />
                </div>
                <pre style={{ ...S.codeBox, fontSize: 10 }}>{termCmd}</pre>
              </div>
            )}
            <div style={{ display: 'grid', gap: 6 }}>
              {connectors.length === 0 ? (
                <div style={{ color: C.dim, fontSize: 11, padding: 16, textAlign: 'center', border: `1px dashed ${C.border}`, borderRadius: 6 }}>
                  No connectors found in conf/connectors/ on {target}
                </div>
              ) : connectors.map(c => (
                <div key={c.exchange} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#04070e', border: `1px solid ${C.border}`, borderRadius: 6, padding: '8px 12px' }}>
                  <div>
                    <span style={{ fontWeight: 600 }}>{c.exchange}</span>{' '}
                    <Badge color={c.encrypted ? C.green : C.yellow}>{c.encrypted ? 'ENCRYPTED' : 'PLAIN YAML'}</Badge>
                  </div>
                  <button className="tbtn" onClick={async () => {
                    if (!window.confirm(`Remove connector ${c.exchange}?`)) return;
                    await api(`/api/connectors/${encodeURIComponent(c.exchange)}`, { method: 'DELETE', params: { target } });
                    loadConnectors();
                  }} style={S.btn(C.red)}>Delete</button>
                </div>
              ))}
            </div>
          </div>

          <div style={S.card}>
            <div style={S.sectionTitle}>Direct Connector YAML Setup</div>
            <div style={{ display: 'grid', gap: 10 }}>
              <div>
                <label style={S.lbl}>Exchange</label>
                <select style={S.inp} value={connEx} onChange={e => { setConnEx(e.target.value); setConnKey(''); setConnSecret(''); setConnPass(''); }}>
                  <option value="kraken">Kraken</option>
                  <option value="coinbase">Coinbase Advanced Trade</option>
                  <option value="binance">Binance</option>
                  <option value="binanceus">Binance.US</option>
                  <option value="kucoin">KuCoin</option>
                  <option value="bybit">Bybit</option>
                  <option value="okx">OKX</option>
                </select>
              </div>
              {connEx === 'coinbase' && (
                <div style={{ background: '#0a1226', padding: 10, borderRadius: 6, border: `1px dashed ${C.blue}` }}>
                  <label style={{ ...S.lbl, color: C.blue }}>Paste Coinbase CDP API JSON (auto-fills Name & EC Private Key)</label>
                  <textarea style={{ ...S.inp, height: 60 }} placeholder='{"name": "organizations/.../apiKeys/...", "privateKey": "-----BEGIN EC PRIVATE KEY-----..."}'
                    onChange={e => {
                      try {
                        const j = JSON.parse(e.target.value);
                        if (j.name && j.privateKey) { setConnKey(j.name); setConnSecret(j.privateKey); flash('ok', 'Parsed Coinbase CDP JSON!'); }
                      } catch (_) {}
                    }} />
                </div>
              )}
              <div>
                <label style={S.lbl}>API Key</label>
                <input style={S.inp} type={connEx === 'coinbase' ? 'text' : 'password'} value={connKey} onChange={e => setConnKey(e.target.value)} />
              </div>
              <div>
                <label style={S.lbl}>API Secret</label>
                <textarea style={{ ...S.inp, height: connEx === 'coinbase' ? 80 : 38 }} value={connSecret} onChange={e => setConnSecret(e.target.value)} />
              </div>
              {['kucoin', 'okx'].includes(connEx) && (
                <div>
                  <label style={S.lbl}>Passphrase</label>
                  <input style={S.inp} type="password" value={connPass} onChange={e => setConnPass(e.target.value)} />
                </div>
              )}
              <button className="tbtn" onClick={saveConnectorKeys} style={S.btn(C.blue, true)}>💾 Save Connector to {target}</button>
            </div>
          </div>
        </div>
      )}

      {/* 5. TRADES & REALIZED P&L */}
      {sub === 'trades' && (
        <div style={S.card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
            <div style={S.sectionTitle}>Hummingbot Realized Trades & P&L ({target})</div>
            <div style={{ display: 'flex', gap: 6 }}>
              {pnl?.csvData && <button className="tbtn" onClick={downloadCsv} style={S.btn(C.cyan)}>⬇ Export CSV</button>}
              <button className="tbtn" onClick={loadTrades} style={S.btn(C.blue)}>↻ Refresh</button>
            </div>
          </div>

          {!pnl || pnl.summary.totalTrades === 0 ? (
            <div style={{ padding: 30, textAlign: 'center', color: C.muted, border: `1px dashed ${C.border}`, borderRadius: 8 }}>
              No `*_trades.csv` executions recorded in `{target}` data/ directory yet. Start a Hummingbot paper bot or test instantly in the Paper Lab tab!
            </div>
          ) : (
            <div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
                <MetricCard label="Total Trades" value={pnl.summary.totalTrades} sub={`${pnl.summary.buyCount} buys · ${pnl.summary.sellCount} sells`} />
                <MetricCard label="Total Volume" value={fmtUsd(pnl.summary.totalVolume, 0)} color={C.cyan} />
                <MetricCard label="Total Fees" value={fmtUsd(pnl.summary.totalFees)} color={C.yellow} />
                <MetricCard label="Matched Realized P&L" value={`${pnl.summary.realizedPnl >= 0 ? '+' : ''}${fmtUsd(pnl.summary.realizedPnl)}`} sub={`${pnl.summary.netBps.toFixed(1)} bps`} color={pnl.summary.realizedPnl >= 0 ? C.green : C.red} />
              </div>

              {pnl.byPair.length > 0 && (
                <div style={{ marginBottom: 16 }}>
                  <div style={S.lbl}>Per-Pair Matched Arbitrage P&L</div>
                  <div style={{ overflowX: 'auto', border: `1px solid ${C.border}`, borderRadius: 8 }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                      <thead>
                        <tr style={{ background: '#04070e', color: C.muted, textAlign: 'left' }}>
                          {['Pair', 'Buys / Sells', 'Avg Buy', 'Avg Sell', 'Matched Qty', 'Fees', 'Net P&L', 'Inv Δ'].map(h => (
                            <th key={h} style={{ padding: '8px 10px', borderBottom: `1px solid ${C.border}` }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {pnl.byPair.map(p => (
                          <tr key={p.pair} style={{ borderBottom: `1px solid #0b1424` }}>
                            <td style={{ padding: '7px 10px', fontWeight: 700 }}>{p.pair}</td>
                            <td style={{ padding: '7px 10px' }}>{p.buys} / {p.sells}</td>
                            <td style={{ padding: '7px 10px' }}>${p.avgBuy.toFixed(4)}</td>
                            <td style={{ padding: '7px 10px' }}>${p.avgSell.toFixed(4)}</td>
                            <td style={{ padding: '7px 10px' }}>{p.matchedQty.toFixed(4)}</td>
                            <td style={{ padding: '7px 10px', color: C.yellow }}>{fmtUsd(p.fees)}</td>
                            <td style={{ padding: '7px 10px', fontWeight: 700, color: p.netMatchedPnl >= 0 ? C.green : C.red }}>{fmtUsd(p.netMatchedPnl)}</td>
                            <td style={{ padding: '7px 10px', color: C.muted }}>{p.inventoryDelta.toFixed(4)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              <div style={S.lbl}>Recent Executions (latest {pnl.trades.length})</div>
              <div style={{ maxHeight: 300, overflow: 'auto', border: `1px solid ${C.border}`, borderRadius: 8 }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                  <thead>
                    <tr style={{ background: '#04070e', color: C.muted, textAlign: 'left' }}>
                      {['Time', 'Market', 'Pair', 'Side', 'Price', 'Amount', 'Notional', 'Fee'].map(h => (
                        <th key={h} style={{ padding: '7px 10px', borderBottom: `1px solid ${C.border}` }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {pnl.trades.map((t, i) => (
                      <tr key={i} style={{ borderBottom: `1px solid #0b1424` }}>
                        <td style={{ padding: '6px 10px', color: C.muted }}>{t.timestamp}</td>
                        <td style={{ padding: '6px 10px' }}>{t.market}</td>
                        <td style={{ padding: '6px 10px', fontWeight: 600 }}>{t.pair}</td>
                        <td style={{ padding: '6px 10px', color: t.side === 'BUY' ? C.green : C.red }}>{t.side}</td>
                        <td style={{ padding: '6px 10px' }}>${t.price.toFixed(4)}</td>
                        <td style={{ padding: '6px 10px' }}>{t.amount.toFixed(5)}</td>
                        <td style={{ padding: '6px 10px' }}>{fmtUsd(t.notional)}</td>
                        <td style={{ padding: '6px 10px', color: C.yellow }}>{fmtUsd(t.feeQuote, 3)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* 6. LOGS BROWSER */}
      {sub === 'logs' && (
        <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: 14 }}>
          <div style={S.card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <div style={S.sectionTitle}>Log Files</div>
              <button className="tbtn" onClick={loadLogList} style={{ ...S.btn(C.blue), padding: '3px 7px', fontSize: 10 }}>↻</button>
            </div>
            <div style={{ display: 'grid', gap: 5, maxHeight: 440, overflowY: 'auto' }}>
              {logFiles.length === 0 ? (
                <div style={{ color: C.dim, fontSize: 11 }}>No *.log files found in logs/</div>
              ) : logFiles.map(f => (
                <button key={f.name} className="tbtn" onClick={() => openLogFile(f.name)} style={{
                  textAlign: 'left', padding: '7px 9px', borderRadius: 6, fontSize: 10,
                  background: selectedLog === f.name ? C.panelAlt : '#04070e',
                  border: `1px solid ${selectedLog === f.name ? C.blue : C.border}`,
                  color: selectedLog === f.name ? C.blue : C.text, cursor: 'pointer',
                }}>
                  <div style={{ fontWeight: 600, wordBreak: 'break-all' }}>{f.name}</div>
                  <div style={{ color: C.dim, marginTop: 2 }}>{(f.size / 1024).toFixed(1)} KB</div>
                </button>
              ))}
            </div>
          </div>

          <div style={S.card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <div style={S.sectionTitle}>{selectedLog || 'Select a log file'}</div>
              {selectedLog && (
                <div style={{ display: 'flex', gap: 6 }}>
                  <CopyBtn text={logContent} />
                  <button className="tbtn" onClick={() => openLogFile(selectedLog)} style={S.btn(C.blue)}>↻ Refresh</button>
                </div>
              )}
            </div>
            <pre style={{ ...S.codeBox, height: 430, color: '#a7f3d0', fontSize: 11 }}>
              {logContent || 'Pick a log file on the left to tail Hummingbot strategy logs without TUI noise.'}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
