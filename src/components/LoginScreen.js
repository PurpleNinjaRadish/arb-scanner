// ─── Remote sign-in ───────────────────────────────────────────────────────────
// Shown when the app is opened through the remote tunnel without a device token.
import { useState } from 'react';
import { api, setApiToken } from '../api';
import { C, S, Notice } from '../ui';

export function linkCodeFromHash() {
  const m = /[#&]link=([A-Za-z0-9-]+)/.exec(window.location.hash || '');
  return m ? decodeURIComponent(m[1]) : '';
}

function defaultDeviceName() {
  const ua = navigator.userAgent || '';
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iPhone' : /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'Browser';
  const br = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '';
  return `${br ? `${br} on ` : ''}${os}`;
}

export default function LoginScreen({ session, onSignedIn }) {
  const hashCode = linkCodeFromHash();
  const [mode, setMode] = useState(hashCode || !session?.passwordSet ? 'code' : 'password');
  const [code, setCode] = useState(hashCode);
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [needsTotp, setNeedsTotp] = useState(!!session?.totpEnabled);
  const [name, setName] = useState(defaultDeviceName());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const finish = (r) => {
    setApiToken(r.token);
    try { sessionStorage.setItem('arb_stream_ticket', r.ticket || ''); } catch (_) {}
    if (window.location.hash.includes('link=')) window.history.replaceState(null, '', window.location.pathname + window.location.search);
    onSignedIn(r);
  };

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const r = mode === 'code'
        ? await api('/api/remote/link', { method: 'POST', body: { code, deviceName: name } })
        : await api('/api/remote/login', { method: 'POST', body: { password, totp: needsTotp ? totp : undefined, deviceName: name } });
      finish(r);
    } catch (err) {
      if (err.data && err.data.needsTotp) setNeedsTotp(true);
      setError(err.message);
    } finally { setBusy(false); }
  };

  const tab = (id, label) => (
    <button type="button" className="tbtn" onClick={() => { setMode(id); setError(''); }}
      style={{ ...(mode === id ? S.btn(C.blue, true) : S.btnMuted), flex: 1 }}>{label}</button>
  );

  return (
    <div style={{ minHeight: '100vh', background: C.bg, color: C.text, fontFamily: "'IBM Plex Mono', monospace", display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 18 }}>
      <style>{'* { box-sizing: border-box; } body { margin: 0; }'}</style>
      <form onSubmit={submit} style={{ ...S.card, width: '100%', maxWidth: 400, padding: 24 }}>
        <div style={{
          fontFamily: "'Orbitron', sans-serif", fontSize: 20, fontWeight: 900, letterSpacing: 2, marginBottom: 4,
          background: 'linear-gradient(110deg, #dbeafe, #3b8dff 45%, #00e68a)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
        }}>ARB SCANNER v3</div>
        <div style={{ fontSize: 11, color: C.muted, marginBottom: 18 }}>Remote access · sign in to continue</div>

        <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
          {tab('code', 'Link code')}
          {session?.passwordSet && tab('password', 'Password')}
        </div>

        {mode === 'code' ? (
          <>
            <label style={S.lbl}>Code from the PC (Remote Access → Make link code)</label>
            <input autoFocus style={{ ...S.inp, fontSize: 22, letterSpacing: 4, textAlign: 'center', textTransform: 'uppercase', marginBottom: 12 }}
              value={code} onChange={e => setCode(e.target.value.toUpperCase())} placeholder="ABCD-2345" autoComplete="one-time-code" />
          </>
        ) : (
          <>
            <label style={S.lbl}>Password</label>
            <input autoFocus type="password" autoComplete="current-password" style={{ ...S.inp, marginBottom: 12 }} value={password} onChange={e => setPassword(e.target.value)} />
            {needsTotp && (
              <>
                <label style={S.lbl}>Authenticator code</label>
                <input inputMode="numeric" autoComplete="one-time-code" maxLength={6} style={{ ...S.inp, fontSize: 18, letterSpacing: 4, marginBottom: 12 }} value={totp} onChange={e => setTotp(e.target.value.replace(/\D/g, ''))} />
              </>
            )}
          </>
        )}

        <label style={S.lbl}>Name this device</label>
        <input style={{ ...S.inp, marginBottom: 16 }} value={name} onChange={e => setName(e.target.value)} maxLength={48} />

        {error && <Notice tone="error">{error}</Notice>}
        <button type="submit" className="tbtn" disabled={busy || (mode === 'code' ? code.replace(/[^A-Z0-9]/gi, '').length < 8 : !password)} style={{ ...S.btn(C.green, true), width: '100%', padding: '10px' }}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <div style={{ fontSize: 10, color: C.dim, marginTop: 14, lineHeight: 1.6 }}>
          This device stays signed in until it's unused for a while or signed out from the PC. Repeated wrong attempts lock sign-in for 15 minutes.
        </div>
      </form>
    </div>
  );
}
