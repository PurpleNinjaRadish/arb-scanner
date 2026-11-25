// ─── Profitable Target Alerts, Push Notifications & Android Pairing Tab ──────
import { useState, useEffect, useCallback } from 'react';
import { api, setApiToken } from '../api';
import { EXCHANGE_PAIRS, QUOTES, EXCHANGES, fmtPrice, fmtUsd } from '../constants';
import { C, S, Badge, MetricCard, Notice, CopyBtn } from '../ui';

export default function AlertsTab({
  onDeployFromAlert,
  browserNotifEnabled, setBrowserNotifEnabled,
  soundEnabled, setSoundEnabled,
  onUnreadChanged,
}) {
  const [settings, setSettings] = useState(null);
  const [status, setStatus] = useState(null);
  const [alerts, setAlerts] = useState([]);
  const [pairing, setPairing] = useState(null);
  const [tgToken, setTgToken] = useState('');
  const [webhookInput, setWebhookInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const loadAll = useCallback(async () => {
    try {
      const [stRes, alRes, pairRes] = await Promise.all([
        api('/api/alerts/status'),
        api('/api/alerts', { params: { limit: 100 } }),
        api('/api/mobile/pairing').catch(() => null),
      ]);
      setSettings(stRes.settings);
      setStatus(stRes.status);
      setAlerts(alRes.alerts || []);
      if (pairRes) setPairing(pairRes);
      if (onUnreadChanged && stRes.status) onUnreadChanged(stRes.status.unreadCount || 0);
    } catch (e) {
      setMsg({ tone: 'error', text: e.message });
    }
  }, [onUnreadChanged]);

  useEffect(() => {
    loadAll();
    const iv = setInterval(loadAll, 8000);
    return () => clearInterval(iv);
  }, [loadAll]);

  const saveSettings = async (override = {}) => {
    if (!settings) return;
    setBusy(true); setMsg(null);
    try {
      const body = {
        ...settings,
        ...override,
        ...(tgToken ? { telegramBotToken: tgToken } : {}),
        ...(webhookInput ? { webhookUrl: webhookInput } : {}),
      };
      const res = await api('/api/alerts/settings', { method: 'POST', body });
      setSettings(res.settings);
      setStatus(res.status);
      setTgToken('');
      setWebhookInput('');
      setMsg({ tone: 'ok', text: `Alert watcher saved (${res.settings.enabled ? 'ACTIVE' : 'PAUSED'}).` });
      loadAll();
    } catch (e) { setMsg({ tone: 'error', text: e.message }); }
    finally { setBusy(false); }
  };

  const runCheckNow = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await api('/api/alerts/check', { method: 'POST' });
      setMsg({
        tone: r.triggeredCount > 0 ? 'ok' : 'info',
        text: r.error
          ? `Check error: ${r.error}`
          : `Scanned ${r.checked || 0} pairs — ${r.triggeredCount || 0} profitable target(s) matched criteria.`,
      });
      loadAll();
    } catch (e) { setMsg({ tone: 'error', text: e.message }); }
    finally { setBusy(false); }
  };

  const sendTest = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await api('/api/alerts/test', { method: 'POST' });
      const deliv = r.alert?.delivery || {};
      const chanSummary = Object.entries(deliv).map(([k, v]) => `${k}: ${v.ok ? 'SENT' : `FAILED (${v.error})`}`).join(' · ');
      setMsg({ tone: 'ok', text: `Test profitable-target notification fired! ${chanSummary || 'Delivered to web/Android feed (add an ntfy topic below for instant phone push).'}` });
      loadAll();
    } catch (e) { setMsg({ tone: 'error', text: e.message }); }
    finally { setBusy(false); }
  };

  const requestBrowserPermission = async () => {
    if (!('Notification' in window)) {
      return setMsg({ tone: 'warn', text: 'This browser does not support OS desktop notifications.' });
    }
    const perm = await Notification.requestPermission();
    if (perm === 'granted') {
      setBrowserNotifEnabled(true);
      setMsg({ tone: 'ok', text: 'Browser notifications enabled! You will receive OS popups whenever a profitable target triggers.' });
    } else {
      setBrowserNotifEnabled(false);
      setMsg({ tone: 'warn', text: `Notification permission: ${perm}` });
    }
  };

  const generateTopic = () => {
    const rand = Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
    setSettings(s => ({ ...s, ntfyTopic: `arb-scanner-${rand}` }));
  };

  const generateMobileToken = async () => {
    try {
      const r = await api('/api/mobile/token/generate', { method: 'POST' });
      setApiToken(r.token);
      setMsg({ tone: 'ok', text: `Generated new Mobile API Token: ${r.token}\nSaved to this browser automatically. Copy the Pairing JSON below into your Android app.` });
      loadAll();
    } catch (e) { setMsg({ tone: 'error', text: e.message }); }
  };

  const markAllRead = async () => {
    await api('/api/alerts/read', { method: 'POST', body: { id: 'all' } });
    loadAll();
  };

  const clearAlerts = async () => {
    if (!window.confirm('Clear all alert history?')) return;
    await api('/api/alerts', { method: 'DELETE' });
    loadAll();
  };

  return (
    <div>
      {/* Status Summary */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
        <MetricCard
          label="Target Watcher"
          value={status?.enabled ? 'ACTIVE' : 'PAUSED'}
          sub={status?.lastCheckAt ? `Last scan ${new Date(status.lastCheckAt).toLocaleTimeString()} (#${status.checksCount})` : 'Not scanned yet'}
          color={status?.enabled ? C.green : C.yellow}
        />
        <MetricCard label="Unread Alerts" value={status?.unreadCount ?? 0} sub={`${status?.totalAlerts ?? 0} total logged`} color={(status?.unreadCount || 0) > 0 ? C.green : C.muted} />
        <MetricCard label="Android Push (ntfy)" value={settings?.ntfyTopic ? 'CONFIGURED' : 'NOT SET'} sub={settings?.ntfyTopic || 'Generate topic below'} color={settings?.ntfyTopic ? C.cyan : C.dim} />
        <MetricCard label="Live Clients (SSE)" value={status?.subscribers ?? 0} sub="Connected browsers/phones" color={C.blue} />
        <MetricCard label="Mobile LAN Access" value={pairing?.lanAccessible ? 'READY' : 'LOCAL ONLY'} sub={pairing?.recommendedUrl || '—'} color={pairing?.lanAccessible ? C.green : C.yellow} />
      </div>

      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      {status?.lastError && <Notice tone="warn">Watcher last error: {status.lastError}</Notice>}

      {/* Two-column configuration: Target Watcher + Push & Android Pairing */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 14, marginBottom: 14 }}>
        {/* Target Watcher Rules */}
        {settings && (
          <div style={S.card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <div style={S.sectionTitle}>Profitable Target Watcher Rules</div>
              <button className="tbtn" disabled={busy}
                onClick={() => saveSettings({ enabled: !settings.enabled })}
                style={S.btn(settings.enabled ? C.yellow : C.green, true)}>
                {settings.enabled ? '⏸ Pause Watcher' : '▶ Enable 24/7 Watcher'}
              </button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
              <div>
                <label style={S.lbl}>Exchange Pair</label>
                <select style={S.inp} value={settings.pair} onChange={e => setSettings({ ...settings, pair: e.target.value })}>
                  {EXCHANGE_PAIRS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                </select>
              </div>
              <div>
                <label style={S.lbl}>Quote Currency</label>
                <select style={S.inp} value={settings.quote} onChange={e => setSettings({ ...settings, quote: e.target.value })}>
                  {QUOTES.map(q => <option key={q} value={q}>{q}</option>)}
                </select>
              </div>
              <div>
                <label style={S.lbl}>Min Net Profit %</label>
                <input type="number" step="0.05" style={S.inp} value={settings.minNetPct}
                  onChange={e => setSettings({ ...settings, minNetPct: parseFloat(e.target.value) || 0 })} />
              </div>
              <div>
                <label style={S.lbl}>Min Net Profit ($)</label>
                <input type="number" step="0.5" style={S.inp} value={settings.minNetDollar}
                  onChange={e => setSettings({ ...settings, minNetDollar: parseFloat(e.target.value) || 0 })} />
              </div>
              <div>
                <label style={S.lbl}>Trade Size ({settings.quote})</label>
                <input type="number" step="100" style={S.inp} value={settings.tradeSize}
                  onChange={e => setSettings({ ...settings, tradeSize: Number(e.target.value) || 500 })} />
              </div>
              <div>
                <label style={S.lbl}>Min 24h Volume ($)</label>
                <input type="number" step="50000" style={S.inp} value={settings.minVolUsd}
                  onChange={e => setSettings({ ...settings, minVolUsd: Number(e.target.value) || 0 })} />
              </div>
              <div>
                <label style={S.lbl}>Scan Interval (sec)</label>
                <input type="number" min="10" style={S.inp} value={settings.intervalSec}
                  onChange={e => setSettings({ ...settings, intervalSec: Number(e.target.value) || 20 })} />
              </div>
              <div>
                <label style={S.lbl}>Per-Coin Cooldown (sec)</label>
                <input type="number" min="15" style={S.inp} value={settings.cooldownSec}
                  onChange={e => setSettings({ ...settings, cooldownSec: Number(e.target.value) || 300 })} />
              </div>
            </div>

            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12, fontSize: 11, color: C.text }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                <input type="checkbox" checked={!!settings.verifyOrderBook}
                  onChange={e => setSettings({ ...settings, verifyOrderBook: e.target.checked })} />
                Verify live L2 Order Book before pushing (prevents false alarms)
              </label>
              <select style={{ ...S.inp, width: 'auto' }} value={settings.feeMode}
                onChange={e => setSettings({ ...settings, feeMode: e.target.value })}>
                <option value="maker_taker">XEMM Maker+Taker Fees</option>
                <option value="taker_taker">Taker+Taker Fees</option>
              </select>
            </div>

            {/* Browser Notifications & Audio */}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', padding: '10px 12px', background: '#04070e', border: `1px solid ${C.border}`, borderRadius: 8, marginBottom: 12 }}>
              <button className="tbtn" onClick={requestBrowserPermission} style={S.btn(browserNotifEnabled ? C.green : C.cyan)}>
                {browserNotifEnabled ? '🔔 Browser Alerts ON' : '🔔 Enable Browser Popups'}
              </button>
              <button className="tbtn" onClick={() => setSoundEnabled(!soundEnabled)} style={S.btn(soundEnabled ? C.green : C.muted)}>
                {soundEnabled ? '🔊 Alert Chime ON' : '🔇 Alert Chime OFF'}
              </button>
            </div>

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="tbtn" disabled={busy} onClick={() => saveSettings()} style={S.btn(C.green, true)}>💾 Save Rules</button>
              <button className="tbtn" disabled={busy} onClick={runCheckNow} style={S.btn(C.blue)}>🔍 Check Now</button>
              <button className="tbtn" disabled={busy} onClick={sendTest} style={S.btn(C.yellow)}>🧪 Send Test Alert</button>
            </div>
          </div>
        )}

        {/* Push Channels & Android Companion Pairing */}
        {settings && (
          <div style={S.card}>
            <div style={S.sectionTitle}>Android Push Channels & Phone Remote Control</div>

            <div style={{ background: '#040914', border: `1px solid ${C.cyan}44`, borderRadius: 8, padding: 12, marginBottom: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.cyan, marginBottom: 6 }}>1. Instant Android Push via ntfy.sh (Free · Zero Firebase Setup)</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                <div>
                  <label style={S.lbl}>ntfy Server</label>
                  <input style={S.inp} value={settings.ntfyUrl || 'https://ntfy.sh'} onChange={e => setSettings({ ...settings, ntfyUrl: e.target.value })} />
                </div>
                <div>
                  <label style={S.lbl}>Secret Topic Name</label>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <input style={S.inp} placeholder="arb-scanner-mysecret" value={settings.ntfyTopic || ''}
                      onChange={e => setSettings({ ...settings, ntfyTopic: e.target.value })} />
                    <button className="tbtn" onClick={generateTopic} style={S.btn(C.cyan)}>Gen</button>
                  </div>
                </div>
              </div>
              <div style={{ fontSize: 10, color: C.muted, lineHeight: 1.6 }}>
                Our native Android app polls automatically AND you can also subscribe to this topic in the free <b>ntfy</b> Android app for sub-second zero-battery push notifications.
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12 }}>
              <div>
                <label style={S.lbl}>Telegram Bot Token {settings.hasTelegramToken ? '(saved)' : '(optional)'}</label>
                <input type="password" style={S.inp} placeholder={settings.hasTelegramToken ? '••••••••' : '123456:ABC...'}
                  value={tgToken} onChange={e => setTgToken(e.target.value)} />
              </div>
              <div>
                <label style={S.lbl}>Telegram Chat ID</label>
                <input style={S.inp} placeholder="e.g. 987654321" value={settings.telegramChatId || ''}
                  onChange={e => setSettings({ ...settings, telegramChatId: e.target.value })} />
              </div>
              <div style={{ gridColumn: '1 / -1' }}>
                <label style={S.lbl}>Discord / Custom Webhook URL {settings.hasWebhookUrl ? '(saved)' : '(optional)'}</label>
                <input style={S.inp} placeholder={settings.hasWebhookUrl ? 'Configured — paste new URL to replace' : 'https://discord.com/api/webhooks/...'}
                  value={webhookInput} onChange={e => setWebhookInput(e.target.value)} />
              </div>
            </div>

            {/* Android Pairing Block */}
            {pairing && (
              <div style={{ background: '#04070e', border: `1px solid ${C.borderHi}`, borderRadius: 8, padding: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: C.green }}>📱 Android App Remote Control Pairing</span>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button className="tbtn" onClick={generateMobileToken} style={{ ...S.btn(C.yellow), fontSize: 10, padding: '4px 8px' }}>
                      🔑 {pairing.hasApiToken ? 'Rotate API Token' : 'Generate API Token'}
                    </button>
                    <CopyBtn text={pairing.pairingJson} label="Copy Pairing JSON" />
                  </div>
                </div>
                {!pairing.lanAccessible && (
                  <Notice tone="warn">
                    Backend is currently bound to 127.0.0.1 (local-only). To control from your Android phone over Wi-Fi/Tailscale, generate an API token above and start with:{'\n'}
                    .\launch.ps1 -Prod -Lan   (sets BIND_HOST=0.0.0.0)
                  </Notice>
                )}
                <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.7 }}>
                  Server URL: <b style={{ color: C.cyan }}>{pairing.recommendedUrl}</b><br />
                  Token Protection: <Badge color={pairing.hasApiToken ? C.green : C.yellow}>{pairing.hasApiToken ? 'PROTECTED' : 'OPEN (GENERATE TOKEN)'}</Badge><br />
                  Native Android Project: <code>android-app/</code> (build APK with <code>.\android-app\build-apk.ps1</code> or open <b>{pairing.recommendedUrl}</b> in Chrome Android → "Add to Home Screen").
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Live Profitable Targets Feed */}
      <div style={S.card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
          <div style={S.sectionTitle}>Profitable Target Notifications Feed ({alerts.length})</div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="tbtn" onClick={markAllRead} style={S.btn(C.cyan)}>✓ Mark All Read</button>
            <button className="tbtn" onClick={clearAlerts} style={S.btn(C.red)}>🗑 Clear History</button>
          </div>
        </div>

        {alerts.length === 0 ? (
          <div style={{ padding: 30, textAlign: 'center', color: C.muted, border: `1px dashed ${C.border}`, borderRadius: 8 }}>
            No target notifications yet. Enable the <b>24/7 Target Watcher</b> above or click <b>🧪 Send Test Alert</b> to test desktop & Android push delivery!
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 8 }}>
            {alerts.map(a => (
              <div key={a.id} style={{
                background: a.read ? '#050912' : '#061a12',
                border: `1px solid ${a.read ? C.border : `${C.green}66`}`,
                borderRadius: 8, padding: '10px 14px',
                display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10,
              }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 700, fontSize: 13, color: a.isTest ? C.yellow : C.green }}>{a.title}</span>
                    {a.verifiedL2 && <Badge color={C.cyan}>L2 VERIFIED</Badge>}
                    {a.isTest && <Badge color={C.yellow}>TEST</Badge>}
                    {!a.read && <Badge color={C.green}>NEW</Badge>}
                  </div>
                  <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>
                    {['guard', 'auto'].includes(a.kind)
                      ? `${new Date(a.ts).toLocaleString()} · ${a.message}`
                      : <>{new Date(a.ts).toLocaleString()} · Buy {EXCHANGES[a.buyOn]?.label || a.buyOn} @ {fmtPrice(a.buyPrice)} → Sell {EXCHANGES[a.sellOn]?.label || a.sellOn} @ {fmtPrice(a.sellPrice)} · Size {fmtUsd(a.tradeSize, 0)}</>}
                  </div>
                </div>
                {onDeployFromAlert && !a.isTest && !['guard', 'auto'].includes(a.kind) && (
                  <button className="tbtn" onClick={() => onDeployFromAlert(a)} style={S.btn(C.green, true)}>
                    🤖 Deploy Bot
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
