// ─── Remote Access ────────────────────────────────────────────────────────────
// Sign in to the app from anywhere through an encrypted tunnel, with a password
// (+ optional authenticator code) or a one-time link code made here.
import { useState, useEffect, useCallback } from 'react';
import { api } from '../api';
import { C, S, Badge, Notice, CopyBtn } from '../ui';

const TUNNELS = [
  {
    id: 'tailscale', name: 'Tailscale (private)', badge: 'most private',
    text: 'Only devices signed in to your Tailscale account can reach the app — nothing is exposed to the public internet. Install Tailscale on this PC and on your phone, sign in to both with the same account. Works like your remote desktop.',
  },
  {
    id: 'cloudflare-quick', name: 'Cloudflare quick tunnel', badge: 'no account',
    text: 'One click gives a random https://….trycloudflare.com address. Anyone with the address sees the sign-in page, so a strong password (and authenticator code) protects it. The address changes every time the tunnel restarts — link codes include it.',
  },
  {
    id: 'cloudflare-named', name: 'Cloudflare tunnel (your domain)', badge: 'stable address',
    text: 'A fixed address on a domain you own in Cloudflare (e.g. arb.yourdomain.com). In the Cloudflare dashboard: Zero Trust → Networks → Tunnels → Create tunnel → copy the token, and add a public hostname pointing to http://localhost:3002. For extra protection add a Cloudflare Access policy (email code) in front of it.',
  },
];

const fmtAgo = ts => {
  if (!ts) return '—';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
};

function Step({ n, title, done, children }) {
  return (
    <div style={{ ...S.card, marginBottom: 12 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 10 }}>
        <span style={{ width: 22, height: 22, borderRadius: 11, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, background: done ? `${C.green}33` : `${C.blue}22`, color: done ? C.green : C.blue }}>{done ? '✓' : n}</span>
        <span style={{ ...S.sectionTitle, marginBottom: 0 }}>{title}</span>
      </div>
      {children}
    </div>
  );
}

function LinkCodeCard({ code, onDone }) {
  const [left, setLeft] = useState(Math.max(0, code.expiresAt - Date.now()));
  useEffect(() => {
    const iv = setInterval(() => setLeft(Math.max(0, code.expiresAt - Date.now())), 1000);
    return () => clearInterval(iv);
  }, [code.expiresAt]);
  const mm = Math.floor(left / 60000), ss = String(Math.floor((left % 60000) / 1000)).padStart(2, '0');
  return (
    <div style={{ border: `1px solid ${C.green}55`, borderRadius: 10, padding: 14, background: '#03140c', marginTop: 10 }}>
      <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'center' }}>
        <div>
          <div style={S.lbl}>Link code ({code.role}) · expires in {left ? `${mm}:${ss}` : 'expired'}</div>
          <div style={{ fontFamily: "'Orbitron', sans-serif", fontSize: 34, letterSpacing: 6, color: left ? C.green : C.dim }}>{code.code}</div>
          <div style={{ fontSize: 10, color: C.muted, marginTop: 6, maxWidth: 380, lineHeight: 1.6 }}>
            Enter it in the Android app (Settings → Link with code) or on the sign-in page of the remote address. Works once.
          </div>
          {code.urls.web && <div style={{ marginTop: 8, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 10, color: C.cyan, wordBreak: 'break-all' }}>{code.urls.web}</span>
            <CopyBtn text={code.urls.web} label="Copy link" />
          </div>}
        </div>
        {code.qrApp && (
          <div style={{ textAlign: 'center' }}>
            <img src={code.qrApp} alt="QR code for the Android app" width={150} height={150} style={{ borderRadius: 6, background: '#fff' }} />
            <div style={{ fontSize: 9, color: C.muted, marginTop: 4 }}>Scan with phone camera → opens the app</div>
          </div>
        )}
        {code.qrWeb && (
          <div style={{ textAlign: 'center' }}>
            <img src={code.qrWeb} alt="QR code for the web sign-in" width={150} height={150} style={{ borderRadius: 6, background: '#fff' }} />
            <div style={{ fontSize: 9, color: C.muted, marginTop: 4 }}>Opens the web app, code filled in</div>
          </div>
        )}
      </div>
      {!code.urls.web && <Notice tone="warn">The tunnel has no public address yet, so the QR only carries the code. In the app, also enter the address once the tunnel is up.</Notice>}
      <button className="tbtn" onClick={onDone} style={{ ...S.btnMuted, marginTop: 8 }}>Done</button>
    </div>
  );
}

export default function RemoteAccessTab() {
  const [st, setSt] = useState(null);
  const [tools, setTools] = useState(null);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [busy, setBusy] = useState('');
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' });
  const [totp, setTotp] = useState(null);
  const [totpCode, setTotpCode] = useState('');
  const [tun, setTun] = useState({ token: '', hostname: '' });
  const [role, setRole] = useState('admin');
  const [code, setCode] = useState(null);
  const [showLog, setShowLog] = useState(false);
  const [showAudit, setShowAudit] = useState(false);

  const load = useCallback(async () => {
    try { const s = await api('/api/remote/status'); setSt(s); setTun(t => ({ ...t, hostname: t.hostname || s.tunnel.hostname || '' })); } catch (e) { setError(e.message); }
  }, []);
  useEffect(() => { load(); api('/api/remote/tools').then(setTools).catch(() => {}); }, [load]);
  // Poll while a tunnel is starting so the address appears on its own
  useEffect(() => {
    if (!st || !st.enabled) return undefined;
    const fast = st.tunnel.mode !== 'none' && st.tunnel.running && !st.tunnel.publicUrl;
    const iv = setInterval(load, fast ? 2000 : 15000);
    return () => clearInterval(iv);
  }, [st, load]);

  const run = async (key, fn, okMsg) => {
    setBusy(key); setError(''); setOk('');
    try { const r = await fn(); if (okMsg) setOk(okMsg); await load(); return r; } catch (e) { setError(e.message); return null; } finally { setBusy(''); }
  };
  const save = (body, msg) => run('settings', () => api('/api/remote/settings', { method: 'POST', body }), msg);

  if (!st) return <div style={S.card}>{error ? <Notice tone="error">{error}</Notice> : 'Loading…'}</div>;

  const t = st.tunnel;
  const tunnelDef = TUNNELS.find(x => x.id === t.mode);
  const needsCf = t.mode.startsWith('cloudflare');
  const toolOk = !tools ? null : t.mode === 'tailscale' ? tools.tailscale.installed : needsCf ? tools.cloudflared.installed : true;
  const cell = { padding: '6px 8px', borderBottom: '1px solid #0b1424', fontSize: 11 };

  return (
    <div>
      <div style={{ ...S.card, marginBottom: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ maxWidth: 820 }}>
            <div style={S.sectionTitle}>🌐 Remote Access</div>
            <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.65 }}>
              Use the app from anywhere — no router changes, no open ports. A tunnel on this PC carries encrypted traffic to a separate, locked-down
              listener ({st.bind}:{st.port}). Every request through it must come from a signed-in device. Sign in with your password (+ authenticator code)
              or link a phone with a one-time code from this page. Each device can be revoked here.
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <Badge color={st.enabled ? (t.publicUrl ? C.green : C.yellow) : C.muted}>
              {st.enabled ? (t.publicUrl ? 'reachable' : t.mode === 'none' ? 'on · no tunnel' : 'on · connecting') : 'off'}
            </Badge>
            {t.publicUrl && (
              <div style={{ marginTop: 8, display: 'flex', gap: 6, alignItems: 'center', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                <a href={t.publicUrl} target="_blank" rel="noreferrer" style={{ color: C.cyan, fontSize: 12 }}>{t.publicUrl}</a>
                <CopyBtn text={t.publicUrl} />
              </div>
            )}
          </div>
        </div>
      </div>

      {error && <Notice tone="error">{error}</Notice>}
      {ok && <Notice tone="ok">{ok}</Notice>}
      {st.listenError && <Notice tone="error">{st.listenError}</Notice>}
      {st.viaRemote && <Notice tone="warn">You're connected remotely. Changes here can cut off your own connection (turning remote access off, changing the port or tunnel).</Notice>}

      <Step n={1} title="Password" done={st.passwordSet}>
        <div style={{ fontSize: 11, color: C.muted, marginBottom: 10 }}>
          Used on the remote sign-in page. At least 10 characters — a short sentence works well. {st.passwordSet && !st.viaRemote && 'On this PC you can reset it without the old one.'}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8, maxWidth: 760 }}>
          {st.passwordSet && st.viaRemote && <input type="password" autoComplete="current-password" style={S.inp} placeholder="Current password" value={pw.current} onChange={e => setPw(p => ({ ...p, current: e.target.value }))} />}
          <input type="password" autoComplete="new-password" style={S.inp} placeholder={st.passwordSet ? 'New password' : 'Password'} value={pw.next} onChange={e => setPw(p => ({ ...p, next: e.target.value }))} />
          <input type="password" autoComplete="new-password" style={S.inp} placeholder="Repeat it" value={pw.confirm} onChange={e => setPw(p => ({ ...p, confirm: e.target.value }))} />
          <button className="tbtn" disabled={!!busy || pw.next.length < 10 || pw.next !== pw.confirm}
            onClick={() => run('pw', () => api('/api/remote/password', { method: 'POST', body: { current: pw.current, next: pw.next } }), 'Password saved').then(r => r && setPw({ current: '', next: '', confirm: '' }))}
            style={S.btn(C.blue, true)}>{st.passwordSet ? 'Change password' : 'Set password'}</button>
        </div>
        {pw.next && pw.confirm && pw.next !== pw.confirm && <div style={{ fontSize: 10, color: C.yellow, marginTop: 6 }}>The two passwords don't match.</div>}
      </Step>

      <Step n={2} title="Authenticator code (recommended)" done={st.totpEnabled}>
        {st.totpEnabled ? (
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <Badge color={C.green}>on</Badge>
            <span style={{ fontSize: 11, color: C.muted }}>Password sign-ins also need the 6-digit code from your authenticator app. Link codes don't (they're made here and work once).</span>
            {st.viaRemote && <input style={{ ...S.inp, width: 120 }} placeholder="current code" value={totpCode} onChange={e => setTotpCode(e.target.value)} />}
            <button className="tbtn" disabled={!!busy} onClick={() => { if (window.confirm('Turn off the authenticator code?')) run('totp', () => api('/api/remote/totp/disable', { method: 'POST', body: { code: totpCode } }), 'Authenticator code turned off'); }} style={S.btn(C.red)}>Turn off</button>
          </div>
        ) : !totp ? (
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, color: C.muted }}>Adds a 6-digit code from Google Authenticator, Microsoft Authenticator, 1Password, etc. to password sign-ins — a stolen password alone won't get in.</span>
            <button className="tbtn" disabled={!!busy} onClick={() => run('totp', async () => setTotp(await api('/api/remote/totp/setup', { method: 'POST' })))} style={S.btn(C.blue, true)}>Set up</button>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
            {totp.qr && <img src={totp.qr} alt="Authenticator QR code" width={170} height={170} style={{ background: '#fff', borderRadius: 6 }} />}
            <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.7, maxWidth: 420 }}>
              1. In your authenticator app, add an account and scan this code<br />
              (or type the key: <span style={{ color: C.text, wordBreak: 'break-all' }}>{totp.secret}</span>)<br />
              2. Enter the 6-digit code it shows:
              <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                <input style={{ ...S.inp, width: 130, fontSize: 16, letterSpacing: 3 }} inputMode="numeric" maxLength={6} value={totpCode} onChange={e => setTotpCode(e.target.value.replace(/\D/g, ''))} />
                <button className="tbtn" disabled={!!busy || totpCode.length !== 6} onClick={() => run('totp', () => api('/api/remote/totp/enable', { method: 'POST', body: { code: totpCode } }), 'Authenticator code is on').then(r => { if (r) { setTotp(null); setTotpCode(''); } })} style={S.btn(C.green, true)}>Confirm</button>
                <button className="tbtn" onClick={() => { setTotp(null); setTotpCode(''); }} style={S.btnMuted}>Cancel</button>
              </div>
            </div>
          </div>
        )}
      </Step>

      <Step n={3} title="Tunnel" done={!!t.publicUrl}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 10, marginBottom: 12 }}>
          {TUNNELS.map(x => (
            <div key={x.id} onClick={() => !busy && save({ tunnel: { mode: x.id } })}
              style={{ cursor: 'pointer', border: `1px solid ${t.mode === x.id ? C.blue : C.border}`, background: t.mode === x.id ? `${C.blue}12` : 'transparent', borderRadius: 8, padding: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6, marginBottom: 6 }}>
                <span style={{ fontSize: 12, color: t.mode === x.id ? C.blue : C.text }}>{t.mode === x.id ? '◉' : '○'} {x.name}</span>
                <Badge color={x.id === 'tailscale' ? C.green : C.cyan}>{x.badge}</Badge>
              </div>
              <div style={{ fontSize: 10, color: C.muted, lineHeight: 1.6 }}>{x.text}</div>
            </div>
          ))}
        </div>

        {tools && tunnelDef && toolOk === false && (
          <Notice tone="warn">
            {t.mode === 'tailscale' ? 'Tailscale' : 'cloudflared'} isn't installed on this PC. In PowerShell run:{'\n'}
            {t.mode === 'tailscale' ? tools.tailscale.install : tools.cloudflared.install}{'\n'}then press Start below.
            {t.mode === 'tailscale' && ' Sign in to Tailscale on the PC and phone, and turn on HTTPS certificates (admin console → DNS → HTTPS) once.'}
          </Notice>
        )}
        {tools && toolOk && <div style={{ fontSize: 10, color: C.dim, marginBottom: 8 }}>{t.mode === 'tailscale' ? tools.tailscale.version : needsCf ? tools.cloudflared.version : ''}</div>}

        {t.mode === 'cloudflare-named' && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 8, marginBottom: 10 }}>
            <div>
              <label style={S.lbl}>Tunnel token {t.hasToken && <span style={{ color: C.green }}>· saved</span>}</label>
              <input type="password" autoComplete="off" style={S.inp} placeholder={t.hasToken ? 'replace…' : 'eyJh… from the Cloudflare dashboard'} value={tun.token} onChange={e => setTun(s => ({ ...s, token: e.target.value }))} />
            </div>
            <div>
              <label style={S.lbl}>Public hostname</label>
              <input style={S.inp} placeholder="arb.yourdomain.com" value={tun.hostname} onChange={e => setTun(s => ({ ...s, hostname: e.target.value }))} />
            </div>
            <div style={{ display: 'flex', alignItems: 'flex-end' }}>
              <button className="tbtn" disabled={!!busy} onClick={() => save({ tunnel: { token: tun.token, hostname: tun.hostname } }, 'Tunnel settings saved').then(() => setTun(s => ({ ...s, token: '' })))} style={S.btn(C.blue, true)}>Save</button>
            </div>
          </div>
        )}

        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ fontSize: 11, color: C.muted, display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={t.autoStart} onChange={e => save({ tunnel: { autoStart: e.target.checked } })} /> Start the tunnel with the app
          </label>
          {t.running
            ? <button className="tbtn" disabled={!!busy} onClick={() => run('tunnel', () => api('/api/remote/tunnel/stop', { method: 'POST' }), 'Tunnel stopped')} style={S.btn(C.red)}>Stop tunnel</button>
            : <button className="tbtn" disabled={!!busy || !st.enabled || t.mode === 'none'} onClick={() => run('tunnel', () => api('/api/remote/tunnel/start', { method: 'POST' }))} style={S.btn(C.green, true)}>{busy === 'tunnel' ? 'Starting…' : 'Start tunnel'}</button>}
          {!st.enabled && <span style={{ fontSize: 10, color: C.dim }}>Turn remote access on (step 4) to start it.</span>}
          {t.running && !t.publicUrl && <span style={{ fontSize: 11, color: C.yellow }}>Connecting…</span>}
          {t.lastError && <span style={{ fontSize: 11, color: C.red }}>{t.lastError}</span>}
          {t.log && t.log.length > 0 && <button className="tbtn" onClick={() => setShowLog(v => !v)} style={{ ...S.btnMuted, padding: '4px 8px', fontSize: 9 }}>{showLog ? 'Hide log' : 'Show log'}</button>}
        </div>
        {showLog && <pre style={{ ...S.codeBox, marginTop: 8, maxHeight: 220, whiteSpace: 'pre-wrap' }}>{(t.log || []).join('\n')}</pre>}
      </Step>

      <Step n={4} title="Turn on" done={st.enabled && st.listening}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="tbtn" disabled={!!busy || (!st.enabled && !st.passwordSet)}
            onClick={() => {
              if (st.enabled && st.viaRemote && !window.confirm('This disconnects you. Turn remote access off?')) return;
              save({ enabled: !st.enabled }, st.enabled ? 'Remote access is off' : 'Remote access is on');
            }}
            style={S.btn(st.enabled ? C.red : C.green, true)}>{st.enabled ? 'Turn remote access off' : 'Turn remote access on'}</button>
          {!st.passwordSet && <span style={{ fontSize: 10, color: C.yellow }}>Set a password first.</span>}
          {st.enabled && <span style={{ fontSize: 11, color: st.listening ? C.green : C.red }}>{st.listening ? `Listening on ${st.bind}:${st.port}` : 'Not listening'}</span>}
          <label style={{ fontSize: 11, color: C.muted, display: 'flex', gap: 6, alignItems: 'center' }}>
            Sign devices out after
            <select value={st.deviceIdleDays} onChange={e => save({ deviceIdleDays: +e.target.value })} style={{ ...S.inp, width: 'auto', padding: '3px 6px' }}>
              {[7, 14, 30, 90].map(d => <option key={d} value={d}>{d} days</option>)}
            </select>
            unused
          </label>
        </div>
      </Step>

      <Step n={5} title="Link a phone or browser" done={st.devices.length > 0}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, color: C.muted }}>Make a one-time code (10 min) for</span>
          <select value={role} onChange={e => setRole(e.target.value)} style={{ ...S.inp, width: 'auto', padding: '4px 8px' }}>
            <option value="admin">full control</option>
            <option value="viewer">view only</option>
          </select>
          <button className="tbtn" disabled={!!busy || !st.enabled} onClick={() => run('code', async () => setCode(await api('/api/remote/link-code', { method: 'POST', body: { role } })))} style={S.btn(C.green, true)}>Make link code</button>
          {st.pendingCodes.length > 0 && <button className="tbtn" onClick={() => run('code', () => api('/api/remote/link-codes', { method: 'DELETE' }), 'Unused codes cancelled').then(() => setCode(null))} style={S.btnMuted}>Cancel {st.pendingCodes.length} unused</button>}
        </div>
        {code && <LinkCodeCard code={code} onDone={() => setCode(null)} />}

        <div style={{ marginTop: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <span style={S.lbl}>Signed-in devices ({st.devices.length})</span>
            {st.devices.length > 1 && <button className="tbtn" onClick={() => { if (window.confirm('Sign out every device?')) run('revoke', () => api('/api/remote/devices/revoke-all', { method: 'POST' }), 'All devices signed out'); }} style={{ ...S.btn(C.red), padding: '3px 8px', fontSize: 9 }}>Sign out all</button>}
          </div>
          {st.devices.length === 0 ? <div style={{ fontSize: 11, color: C.dim }}>No devices yet.</div> : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr style={{ fontSize: 9, color: C.muted, textAlign: 'left' }}>
                <th style={cell}>DEVICE</th><th style={cell}>ACCESS</th><th style={cell}>SIGNED IN WITH</th><th style={cell}>LAST USED</th><th style={cell}>FROM</th><th style={cell} />
              </tr></thead>
              <tbody>
                {st.devices.map(d => (
                  <tr key={d.id}>
                    <td style={cell}>{d.name} {d.id === st.thisDevice && <Badge color={C.cyan}>this device</Badge>}</td>
                    <td style={cell}><Badge color={d.role === 'admin' ? C.yellow : C.muted}>{d.role === 'admin' ? 'full' : 'view only'}</Badge></td>
                    <td style={{ ...cell, color: C.muted }}>{d.via === 'link-code' ? 'link code' : 'password'}</td>
                    <td style={cell}>{fmtAgo(d.lastSeenAt)}</td>
                    <td style={{ ...cell, color: C.muted }}>{d.lastIp}</td>
                    <td style={{ ...cell, textAlign: 'right' }}>
                      <button className="tbtn" disabled={!!busy} onClick={() => run('revoke', () => api(`/api/remote/devices/${d.id}`, { method: 'DELETE' }), `${d.name} signed out`)} style={{ ...S.btnMuted, padding: '3px 8px', fontSize: 9 }}>Sign out</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <button className="tbtn" onClick={() => setShowAudit(v => !v)} style={{ ...S.btnMuted, marginTop: 12, padding: '4px 8px', fontSize: 9 }}>{showAudit ? 'Hide' : 'Show'} security log</button>
        {showAudit && (
          <div style={{ marginTop: 8, maxHeight: 260, overflowY: 'auto' }}>
            {st.audit.map((a, i) => (
              <div key={i} style={{ fontSize: 10, padding: '3px 0', borderBottom: '1px solid #0b1424', color: /failed|lockout/.test(a.event) ? C.red : C.muted }}>
                {new Date(a.at).toLocaleString()} · {a.event}{a.device ? ` · ${a.device}` : ''}{a.ip ? ` · ${a.ip}` : ''}{a.reason ? ` · ${a.reason}` : ''}{a.scope ? ` · ${a.scope}` : ''}
              </div>
            ))}
          </div>
        )}
      </Step>
    </div>
  );
}
