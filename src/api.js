// ─── API Client ───────────────────────────────────────────────────────────────
// In CRA dev mode (port 3000), talk to local backend at http://localhost:3001.
// When served directly by Express (production/VPS single-port mode), use relative URLs.
const API_BASE =
  process.env.REACT_APP_API_URL ||
  (window.location.port === '3000' ? 'http://localhost:3001' : '');

function getToken() {
  try { return localStorage.getItem('arb_api_token') || ''; } catch (_) { return ''; }
}
export function setApiToken(tok) {
  try {
    if (tok) localStorage.setItem('arb_api_token', tok);
    else localStorage.removeItem('arb_api_token');
  } catch (_) {}
}

export async function api(path, { method = 'GET', body, params } = {}) {
  let url = `${API_BASE}${path}`;
  if (params) {
    const qs = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    });
    const s = qs.toString();
    if (s) url += (url.includes('?') ? '&' : '?') + s;
  }

  const headers = {};
  const tok = getToken();
  if (tok) headers['X-API-Token'] = tok;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { raw: text }; }
  if (!res.ok) {
    // Remote session missing or revoked: let the app show the sign-in screen
    if (res.status === 401 && data.auth) {
      try { window.dispatchEvent(new CustomEvent('arb-auth-required')); } catch (_) {}
    }
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export { API_BASE };
