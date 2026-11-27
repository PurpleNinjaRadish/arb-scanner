// ─── Arb Scanner v3 — Unified Arbitrage, Alerts, Holdings & Hummingbot Suite ─
import { useState, useEffect, useCallback, useRef } from 'react';
import { api, API_BASE, setApiToken } from './api';
import { EXCHANGE_PAIRS } from './constants';
import { C, S, Badge } from './ui';
import ScannerTab from './components/ScannerTab';
import HummingbotHub from './components/HummingbotHub';
import PaperLabTab from './components/PaperLabTab';
import ProjectionsTab from './components/ProjectionsTab';
import ServersAdvisorTab from './components/ServersAdvisorTab';
import AlertsTab from './components/AlertsTab';
import PortfolioTab from './components/PortfolioTab';
import DeployModal from './components/DeployModal';
import CrossCheckTab from './components/CrossCheckTab';
import TickerAuditTab from './components/TickerAuditTab';
import RpcTab from './components/RpcTab';
import RemoteAccessTab from './components/RemoteAccessTab';
import LoginScreen from './components/LoginScreen';

const NAV = [
  ['scanner',     '📡 Scanner'],
  ['alerts',      '🔔 Alerts & Mobile'],
  ['portfolio',   '💼 Holdings & Txns'],
  ['hummingbot',  '🐳 Hummingbot'],
  ['paper',       '🧪 Paper Lab'],
  ['crosscheck',  '🛡 Cross-Check'],
  ['tickers',     '🔤 Ticker Audit'],
  ['projections', '📈 Projections'],
  ['servers',     '☁ Servers'],
  ['rpc',         '⛓ RPC'],
  ['remote',      '🌐 Remote Access'],
];

function playAlertChime() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    [880, 1174.66].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.08, ctx.currentTime + i * 0.12);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.12 + 0.22);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(ctx.currentTime + i * 0.12);
      osc.stop(ctx.currentTime + i * 0.12 + 0.24);
    });
  } catch (_) { /* autoplay policy */ }
}

export default function App() {
  const [tab, setTab] = useState('scanner');
  // Remote session (null until known). Opened through the tunnel without a token → sign-in screen.
  const [session, setSession] = useState(null);
  const loadSession = useCallback(() => api('/api/remote/session').then(setSession).catch(() => setSession({ remote: false, authenticated: true })), []);
  useEffect(() => {
    loadSession();
    const onAuth = () => loadSession();
    window.addEventListener('arb-auth-required', onAuth);
    return () => window.removeEventListener('arb-auth-required', onAuth);
  }, [loadSession]);
  const needsSignIn = !!(session && session.remote && !session.authenticated);
  const [activePairId, setActivePairId] = useState(EXCHANGE_PAIRS[0].id);
  const [quote, setQuote] = useState(EXCHANGE_PAIRS[0].defaultQuote);
  const [tradeSize, setTradeSize] = useState(1000);

  const [config, setConfig] = useState(null);
  const [hosts, setHosts] = useState([{ id: 'local', name: 'Local', kind: 'native-win' }]);
  const [selectedHost, setSelectedHost] = useState('local');
  const [hostStatuses, setHostStatuses] = useState({});
  const [backendOk, setBackendOk] = useState(null);
  const [vpnStatus, setVpnStatus] = useState(null);

  const [deployTargetOpp, setDeployTargetOpp] = useState(null);
  const [projSeed, setProjSeed] = useState(null);
  const [advisorSeed, setAdvisorSeed] = useState(null);

  // Live Target Notification state
  const [unreadAlerts, setUnreadAlerts] = useState(0);
  const [toastAlert, setToastAlert] = useState(null);
  const [browserNotifEnabled, setBrowserNotifEnabled] = useState(
    () => typeof Notification !== 'undefined' && Notification.permission === 'granted'
  );
  const [soundEnabled, setSoundEnabled] = useState(true);
  const soundRef = useRef(soundEnabled);
  const browserNotifRef = useRef(browserNotifEnabled);
  soundRef.current = soundEnabled;
  browserNotifRef.current = browserNotifEnabled;

  const loadConfigAndHosts = useCallback(async () => {
    try {
      const [cfg, hRes, alSt] = await Promise.all([
        api('/api/config'),
        api('/api/hosts'),
        api('/api/alerts/status').catch(() => null),
      ]);
      setConfig(cfg);
      setHosts(hRes.hosts || [{ id: 'local', name: 'Local', kind: 'native' }]);
      if (alSt?.status) setUnreadAlerts(alSt.status.unreadCount || 0);
      setBackendOk(true);
    } catch (_) {
      setBackendOk(false);
    }
  }, []);

  const refreshSystemStatus = useCallback(async () => {
    try {
      const st = await api('/api/system/status');
      const map = {};
      (st.hosts || []).forEach(h => { map[h.target] = h; });
      setHostStatuses(map);
      setBackendOk(true);
    } catch (_) {
      setBackendOk(false);
    }
  }, []);

  useEffect(() => {
    loadConfigAndHosts();
    refreshSystemStatus();
    const iv = setInterval(refreshSystemStatus, 20000);
    return () => clearInterval(iv);
  }, [loadConfigAndHosts, refreshSystemStatus]);

  // Live SSE push stream for profitable target notifications
  useEffect(() => {
    if (typeof EventSource === 'undefined' || !session || needsSignIn) return undefined;
    let es;
    let cancelled = false;
    (async () => {
      let qs = '';
      if (session.remote) {
        // EventSource can't send headers: use a signed read-only ticket, not the token
        let ticket = '';
        try { ticket = sessionStorage.getItem('arb_stream_ticket') || ''; } catch (_) {}
        if (!ticket) { try { ticket = (await api('/api/remote/ticket', { method: 'POST' })).ticket || ''; } catch (_) {} }
        if (!ticket) return;
        try { sessionStorage.setItem('arb_stream_ticket', ticket); } catch (_) {}
        qs = `?ticket=${encodeURIComponent(ticket)}`;
      } else {
        let tok = '';
        try { tok = localStorage.getItem('arb_api_token') || ''; } catch (_) {}
        if (tok) qs = `?token=${encodeURIComponent(tok)}`;
      }
      if (cancelled) return;
      const url = `${API_BASE}/api/alerts/stream${qs}`;
      es = new EventSource(url);
      es.onerror = () => {
        // a ticket expires after 12 h — drop it so the next attempt fetches a fresh one
        if (session.remote && es.readyState === EventSource.CLOSED) { try { sessionStorage.removeItem('arb_stream_ticket'); } catch (_) {} }
      };
      es.addEventListener('alert', (ev) => {
        try {
          const alert = JSON.parse(ev.data);
          setUnreadAlerts(n => n + 1);
          setToastAlert(alert);
          if (soundRef.current) playAlertChime();
          if (browserNotifRef.current && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
            new Notification(alert.title || 'Profitable Arb Target', { body: alert.message || '' });
          }
        } catch (_) {}
      });
    })().catch(() => {});
    return () => { cancelled = true; if (es) es.close(); };
  }, [session, needsSignIn]);

  // Auto-dismiss floating toast after 12s
  useEffect(() => {
    if (!toastAlert) return undefined;
    const t = setTimeout(() => setToastAlert(null), 12000);
    return () => clearTimeout(t);
  }, [toastAlert]);

  useEffect(() => {
    if (!config?.vpnDedicatedIp || selectedHost === 'local') {
      setVpnStatus(null);
      return undefined;
    }
    const check = () => api('/api/vpn-status').then(setVpnStatus).catch(() => setVpnStatus(null));
    check();
    const iv = setInterval(check, 30000);
    return () => clearInterval(iv);
  }, [config?.vpnDedicatedIp, selectedHost]);

  const activePair = EXCHANGE_PAIRS.find(p => p.id === activePairId) || EXCHANGE_PAIRS[0];
  const totalRunningBots = Object.values(hostStatuses).reduce((s, h) => s + (h.runningCount || 0), 0);

  const deployFromAlert = (al) => {
    const pairMatch = EXCHANGE_PAIRS.find(p => p.id === al.pair) || activePair;
    setActivePairId(pairMatch.id);
    if (al.quote) setQuote(al.quote);
    setDeployTargetOpp({
      symbol: al.symbol,
      buyOn: al.buyOn,
      sellOn: al.sellOn,
      buyPrice: al.buyPrice,
      sellPrice: al.sellPrice,
      priceA: al.buyPrice,
      priceB: al.sellPrice,
      netProfit: al.netProfitPct,
      feePct: 0.85,
      tradeSize: al.tradeSize || tradeSize,
    });
  };

  const signOut = async () => {
    if (!window.confirm('Sign this device out?')) return;
    try { await api('/api/remote/logout', { method: 'POST' }); } catch (_) {}
    setApiToken('');
    try { sessionStorage.removeItem('arb_stream_ticket'); } catch (_) {}
    loadSession();
  };

  if (needsSignIn) {
    return (
      <LoginScreen session={session} onSignedIn={() => {
        loadSession();
        loadConfigAndHosts();
        refreshSystemStatus();
      }} />
    );
  }
  const isViewer = session?.remote && session.device?.role === 'viewer';
  const nav = NAV.filter(([k]) => !(isViewer && k === 'remote'));

  return (
    <div style={{ minHeight: '100vh', background: C.bg, color: C.text, fontFamily: "'IBM Plex Mono', monospace" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@300;400;500;600;700&family=Orbitron:wght@600;700;900&display=swap');
        * { box-sizing: border-box; }
        body { margin: 0; background: ${C.bg}; }
        ::-webkit-scrollbar { width: 6px; height: 6px; }
        ::-webkit-scrollbar-thumb { background: #1e3354; border-radius: 3px; }
        .trow:hover { background: #0d1628 !important; cursor: pointer; }
        .tbtn { transition: opacity 0.15s, transform 0.1s; cursor: pointer; }
        .tbtn:hover:not(:disabled) { opacity: 0.85; }
        .tbtn:disabled { opacity: 0.45; cursor: not-allowed; }
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>

      {/* Floating Profitable Target Push Toast */}
      {toastAlert && (
        <div style={{
          position: 'fixed', bottom: 18, right: 18, zIndex: 900, maxWidth: 400,
          background: '#041a10', border: `1px solid ${C.green}`, borderRadius: 10, padding: '12px 16px',
          boxShadow: '0 8px 36px rgba(0, 230, 138, 0.25)',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <span style={{ fontFamily: "'Orbitron', sans-serif", fontSize: 12, color: C.green, fontWeight: 700 }}>
              🔔 {toastAlert.title}
            </span>
            <button onClick={() => setToastAlert(null)} style={{ background: 'none', border: 'none', color: C.muted, cursor: 'pointer', fontSize: 16 }}>×</button>
          </div>
          <div style={{ fontSize: 11, color: '#c8f5e0', whiteSpace: 'pre-wrap', lineHeight: 1.5, marginBottom: 8 }}>
            {toastAlert.message}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="tbtn" onClick={() => { setTab('alerts'); setToastAlert(null); }} style={S.btn(C.cyan)}>View Alerts</button>
            {!toastAlert.isTest && !['guard', 'auto'].includes(toastAlert.kind) && (
              <button className="tbtn" onClick={() => { deployFromAlert(toastAlert); setToastAlert(null); }} style={S.btn(C.green, true)}>🤖 Deploy Bot</button>
            )}
          </div>
        </div>
      )}

      {/* Deploy Modal */}
      {deployTargetOpp && (
        <DeployModal
          target={deployTargetOpp}
          pair={activePair}
          quote={quote}
          hosts={hosts}
          defaultHost={selectedHost}
          vpnStatus={vpnStatus}
          onClose={() => setDeployTargetOpp(null)}
          onDeployed={() => refreshSystemStatus()}
        />
      )}

      {/* Top System Status Strip */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10,
        padding: '7px 18px', background: '#020409', borderBottom: `1px solid ${C.border}`, fontSize: 11,
      }}>
        <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ color: C.muted }}>API:</span>
            <Badge color={backendOk === true ? C.green : backendOk === false ? C.red : C.yellow}>
              {backendOk === true ? 'ONLINE' : backendOk === false ? 'OFFLINE (port 3001)' : 'CHECKING'}
            </Badge>
          </span>
          {hosts.map(h => {
            const st = hostStatuses[h.id];
            return (
              <span key={h.id} onClick={() => { setSelectedHost(h.id); setTab('hummingbot'); }}
                style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}
                title={st?.error || `${h.name} (${h.kind})`}>
                <span style={{ color: C.muted }}>{h.name}:</span>
                <span style={{ color: st?.online ? C.green : C.red, fontWeight: 600 }}>
                  {st ? (st.online ? `● ON (${st.runningCount} bots)` : '● OFF') : '...'}
                </span>
              </span>
            );
          })}
        </div>

        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {session?.remote && session.device && (
            <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <Badge color={isViewer ? C.muted : C.cyan} title="Signed in through Remote Access">🌐 {session.device.name}{isViewer ? ' · view only' : ''}</Badge>
              <button className="tbtn" onClick={signOut} style={{ ...S.btnMuted, padding: '2px 8px', fontSize: 9 }}>Sign out</button>
            </span>
          )}
          {vpnStatus && (
            <Badge color={vpnStatus.connected ? C.green : C.red} title={`Current IP: ${vpnStatus.currentIp}`}>
              {vpnStatus.connected ? 'VPN ✓' : 'VPN MISMATCH'}
            </Badge>
          )}
          <span style={{ fontSize: 10, color: C.muted }}>Host:</span>
          <select
            value={selectedHost}
            onChange={e => setSelectedHost(e.target.value)}
            style={{ ...S.inp, width: 'auto', padding: '3px 8px', fontSize: 11 }}
          >
            {hosts.map(h => <option key={h.id} value={h.id}>{h.name}</option>)}
          </select>
        </div>
      </div>

      {/* Main Header + Workspace Navigation */}
      <div style={{ maxWidth: 1480, margin: '0 auto', padding: '16px 16px 48px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12, marginBottom: 16 }}>
          <div>
            <h1 style={{
              fontFamily: "'Orbitron', sans-serif", fontSize: 22, fontWeight: 900, margin: 0, letterSpacing: 2,
              background: 'linear-gradient(110deg, #dbeafe, #3b8dff 45%, #00e68a)',
              WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
            }}>
              ARB SCANNER v3
            </h1>
            <div style={{ fontSize: 10, color: C.dim, letterSpacing: 1.5, marginTop: 3 }}>
              SCANNER · PUSH ALERTS · HOLDINGS & TXNS · HUMMINGBOT · PAPER LAB · ANDROID REMOTE
            </div>
          </div>

          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {nav.map(([k, label]) => (
              <button key={k} className="tbtn" onClick={() => setTab(k)}
                style={{
                  ...(tab === k ? S.btn(C.blue, true) : S.btnMuted),
                  padding: '8px 12px',
                  borderColor: tab === k ? C.blue : C.border,
                }}>
                {label}
                {k === 'alerts' && unreadAlerts > 0 && (
                  <span style={{ marginLeft: 6, padding: '1px 6px', borderRadius: 10, background: `${C.green}33`, color: C.green, fontSize: 10 }}>
                    {unreadAlerts}
                  </span>
                )}
                {k === 'hummingbot' && totalRunningBots > 0 && (
                  <span style={{ marginLeft: 6, padding: '1px 6px', borderRadius: 10, background: `${C.cyan}33`, color: C.cyan, fontSize: 10 }}>
                    {totalRunningBots}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>

        {/* Active Workspace */}
        {tab === 'scanner' && (
          <ScannerTab
            hosts={hosts}
            activePairId={activePairId}
            setActivePairId={setActivePairId}
            quote={quote}
            setQuote={setQuote}
            tradeSize={tradeSize}
            setTradeSize={setTradeSize}
            onDeploy={opp => setDeployTargetOpp(opp)}
            onProject={opp => {
              setProjSeed({
                tradeSize: opp.tradeSize,
                avgGrossSpreadPct: Math.max(0.2, opp.spread),
                feeBuyPct: (opp.feeBuy || 0.0025) * 100,
                feeSellPct: (opp.feeSell || 0.006) * 100,
              });
              setTab('projections');
            }}
          />
        )}

        {tab === 'alerts' && (
          <AlertsTab
            onDeployFromAlert={deployFromAlert}
            browserNotifEnabled={browserNotifEnabled}
            setBrowserNotifEnabled={setBrowserNotifEnabled}
            soundEnabled={soundEnabled}
            setSoundEnabled={setSoundEnabled}
            onUnreadChanged={setUnreadAlerts}
          />
        )}

        {tab === 'portfolio' && (
          <PortfolioTab
            selectedHost={selectedHost}
            watchAccounts={config?.watchAccounts || []}
            onAccountsChanged={loadConfigAndHosts}
          />
        )}

        {tab === 'hummingbot' && (
          <HummingbotHub
            hosts={hosts}
            selectedHost={selectedHost}
            setSelectedHost={setSelectedHost}
            hostStatuses={hostStatuses}
            onRefreshStatus={refreshSystemStatus}
          />
        )}

        {tab === 'paper' && (
          <PaperLabTab
            activePairId={activePairId}
            quote={quote}
            onSendToProjections={seed => { setProjSeed(seed); setTab('projections'); }}
            onOpenHummingbotPaper={() => setTab('hummingbot')}
          />
        )}

        {tab === 'crosscheck' && (
          <CrossCheckTab
            activePairId={activePairId}
            quote={quote}
            tradeSize={tradeSize}
            hosts={hosts}
            selectedHost={selectedHost}
          />
        )}

        {tab === 'tickers' && <TickerAuditTab />}
        {tab === 'rpc' && <RpcTab hosts={hosts} />}
        {tab === 'remote' && <RemoteAccessTab />}

        {tab === 'projections' && (
          <ProjectionsTab
            seed={projSeed}
            activePairId={activePairId}
            quote={quote}
            onOpenAdvisor={(bots, gross) => { setAdvisorSeed({ bots, gross, ts: Date.now() }); setTab('servers'); }}
          />
        )}

        {tab === 'servers' && (
          <ServersAdvisorTab
            hosts={hosts}
            hostStatuses={hostStatuses}
            config={config}
            onConfigChanged={() => { loadConfigAndHosts(); refreshSystemStatus(); }}
            advisorSeed={advisorSeed}
            activePairId={activePairId}
          />
        )}

        <div style={{ marginTop: 28, fontSize: 10, color: C.dim, textAlign: 'center', letterSpacing: 1 }}>
          ARB SCANNER v3 · ALWAYS VALIDATE IN PAPER MODE FIRST · USE READ-ONLY API KEYS FOR PORTFOLIO WATCHING
        </div>
      </div>
    </div>
  );
}
