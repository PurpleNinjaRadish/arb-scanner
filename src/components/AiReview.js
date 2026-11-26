// ─── AI review: result card, "Ask AI" button and settings ─────────────────────
import { useState, useEffect } from 'react';
import { api } from '../api';
import { fmtUsd } from '../constants';
import { C, S, Badge, Notice } from '../ui';

const VERDICT = {
  tradeable: { color: C.green, label: 'TRADEABLE' },
  not_tradeable: { color: C.red, label: 'NOT TRADEABLE' },
  uncertain: { color: C.yellow, label: 'UNCERTAIN' },
};

export function AiReviewCard({ review }) {
  if (!review) return null;
  const v = review.verdict;
  const p = review.policy;
  const tone = p.approved ? C.green : v && v.verdict === 'tradeable' ? C.yellow : C.red;
  return (
    <div style={{ padding: '10px 14px', borderRadius: 8, marginTop: 10, background: `${tone}10`, border: `1px solid ${tone}66` }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
        <b style={{ fontSize: 12, color: tone }}>
          {p.approved ? `🧠 AI APPROVED — can override the block (max ${fmtUsd(p.maxOrderUsd, 0)} orders${review.live ? ', LIVE' : ', paper'})` : '🧠 AI REVIEW — block stays'}
        </b>
        {v && <Badge color={(VERDICT[v.verdict] || {}).color}>{(VERDICT[v.verdict] || {}).label}</Badge>}
        {v && <Badge color={C.cyan}>{Math.round(v.confidence * 100)}% CONFIDENT</Badge>}
        <span style={{ fontSize: 10, color: C.dim }}>{review.pair} · {review.provider}/{review.model} · {new Date(review.at).toLocaleTimeString()}</span>
      </div>
      {v && <div style={{ fontSize: 12, color: C.text, lineHeight: 1.6, marginBottom: 6 }}>{v.summary}</div>}
      {v && (
        <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.6 }}>
          <div><b>Cause of the gap:</b> {v.gapCause}</div>
          <div><b>Transfers:</b> {v.transferStatus}</div>
          <div><b>Same coin:</b> {v.sameAsset ? 'yes' : 'not confirmed'} · <b>Prices genuine:</b> {v.pricesGenuine ? 'yes' : 'not confirmed'} · <b>Executable with inventory:</b> {v.executableWithInventory ? 'yes' : 'no'}</div>
          {v.keyRisks.length > 0 && <div><b>Risks:</b> {v.keyRisks.join(' · ')}</div>}
        </div>
      )}
      <div style={{ fontSize: 11, marginTop: 6, color: p.approved ? C.green : C.red }}>
        {p.approved
          ? `Overrides: ${p.overrides.join('; ') || 'none needed'}. Live order books: ${review.check.netPct != null ? review.check.netPct.toFixed(3) + '% per trade' : '—'}. Approval valid for a few minutes.`
          : `Why the block stays: ${p.reasons.join('; ')}`}
      </div>
    </div>
  );
}

// Button + card. `request` = body for /api/ai/review (alertId or symbol/quote/exA/exB/...)
export function AskAiButton({ request, onReview, label = '🧠 Ask AI', compact = false }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [review, setReview] = useState(null);
  const run = async () => {
    setBusy(true); setErr('');
    try {
      const r = await api('/api/ai/review', { method: 'POST', body: request });
      setReview(r);
      if (onReview) onReview(r);
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };
  return (
    <div style={{ width: compact ? 'auto' : '100%' }}>
      <button className="tbtn" disabled={busy} onClick={run} style={S.btn(C.purple || C.cyan)}>
        {busy ? '🧠 AI reviewing… (up to a minute)' : label}
      </button>
      {err && <div style={{ marginTop: 8 }}><Notice tone="error">{err}</Notice></div>}
      {!onReview && <AiReviewCard review={review} />}
    </div>
  );
}

export function AiSettingsCard() {
  const [s, setS] = useState(null);
  const [draft, setDraft] = useState({});
  const [key, setKey] = useState('');
  const [msg, setMsg] = useState(null);
  const [phrase, setPhrase] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { api('/api/ai/settings').then(d => { setS(d); setDraft(d); }).catch(() => {}); }, []);
  if (!s) return null;

  const save = async (patch, ok) => {
    setBusy(true); setMsg(null);
    try {
      const d = await api('/api/ai/settings', { method: 'POST', body: patch });
      setS(d); setDraft(d); setKey(''); setPhrase('');
      setMsg({ tone: 'ok', text: ok || 'Saved AI reviewer settings.' });
    } catch (e) { setMsg({ tone: 'error', text: e.message }); }
    finally { setBusy(false); }
  };
  const test = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await api('/api/ai/test', { method: 'POST' });
      setMsg({ tone: r.ok ? 'ok' : 'warn', text: r.ok ? `Connected to ${r.provider} / ${r.model}.` : 'The model answered but not in the expected format.' });
    } catch (e) { setMsg({ tone: 'error', text: `Test failed: ${e.message}` }); }
    finally { setBusy(false); }
  };
  const field = (k, label, step) => (
    <div key={k}>
      <label style={S.lbl}>{label}</label>
      <input type="number" step={step} style={S.inp} value={draft[k] ?? ''} onChange={e => setDraft(d => ({ ...d, [k]: e.target.value }))} />
    </div>
  );

  return (
    <div style={{ ...S.card, marginBottom: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginBottom: 8 }}>
        <div>
          <div style={S.sectionTitle}>🧠 AI Reviewer</div>
          <div style={{ fontSize: 11, color: C.muted, maxWidth: 820, lineHeight: 1.6 }}>
            Sends a blocked target's evidence (prices on every exchange, order books, deposit/withdrawal status, status-page incidents,
            ticker audit, scanner history) to an AI for a second opinion. An approval can override only the judgement checks (price far from
            other exchanges, implausible gap, monthly projection). It can never override a per-trade loss, thin books, a known different
            coin or the live guard rails.
          </div>
        </div>
        <Badge color={s.enabled ? C.green : C.muted}>{s.enabled ? 'ON' : 'OFF'}</Badge>
      </div>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10, marginBottom: 10 }}>
        <div>
          <label style={S.lbl}>Provider</label>
          <select style={S.inp} value={draft.provider} onChange={e => setDraft(d => ({ ...d, provider: e.target.value, model: e.target.value === 'anthropic' ? 'claude-sonnet-5-5' : d.model }))}>
            <option value="anthropic">Anthropic (Claude)</option>
            <option value="openai">OpenAI / compatible (LM Studio, Ollama)</option>
          </select>
        </div>
        <div>
          <label style={S.lbl}>Model</label>
          <input style={S.inp} value={draft.model || ''} onChange={e => setDraft(d => ({ ...d, model: e.target.value }))} />
        </div>
        <div>
          <label style={S.lbl}>API key {s.hasApiKey ? '(saved)' : ''}</label>
          <input type="password" style={S.inp} value={key} placeholder={s.hasApiKey ? '•••••••• (leave blank to keep)' : 'paste key'} onChange={e => setKey(e.target.value)} />
        </div>
        <div>
          <label style={S.lbl}>Base URL (optional)</label>
          <input style={S.inp} value={draft.baseUrl || ''} placeholder="http://localhost:1234/v1" onChange={e => setDraft(d => ({ ...d, baseUrl: e.target.value }))} />
        </div>
        {field('minConfidence', 'Min confidence (0.5–1)', 0.05)}
        {field('maxOrderUsd', 'Max order when AI-approved ($)', 25)}
        {field('maxRuntimeMin', 'Max run time when AI-approved (min)', 5)}
        {field('maxPerHour', 'Max AI calls / hour', 1)}
        {field('validMin', 'Approval valid for (min)', 1)}
      </div>

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
        {[['enabled', 'AI reviewer on'], ['autoOverride', 'Auto-Trade may launch AI-approved targets']].map(([k, label]) => (
          <label key={k} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 11, color: C.text, cursor: 'pointer' }}>
            <input type="checkbox" checked={!!draft[k]} onChange={e => setDraft(d => ({ ...d, [k]: e.target.checked }))} /> {label}
          </label>
        ))}
        <span style={{ fontSize: 11, color: s.allowLive ? C.red : C.muted }}>
          AI approvals: <b>{s.allowLive ? 'paper and LIVE' : 'paper only'}</b>
        </span>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <button className="tbtn" disabled={busy} onClick={() => save({ ...draft, apiKey: key || undefined })} style={S.btn(C.green, true)}>Save</button>
        <button className="tbtn" disabled={busy || (!s.hasApiKey && !draft.baseUrl)} onClick={test} style={S.btn(C.cyan)}>Test connection</button>
        {s.allowLive ? (
          <button className="tbtn" disabled={busy} onClick={() => save({ allowLive: false }, 'AI approvals are paper-only again.')} style={S.btnMuted}>Make AI approvals paper-only</button>
        ) : (
          <>
            <input style={{ ...S.inp, width: 230 }} value={phrase} onChange={e => setPhrase(e.target.value)} placeholder={`Type ${s.livePhrase} to allow live`} />
            <button className="tbtn" disabled={busy || phrase.trim().toUpperCase() !== s.livePhrase}
              onClick={() => save({ allowLive: true, confirmPhrase: phrase }, 'AI approvals can now launch LIVE bots.')} style={S.btn(C.red)}>Allow live</button>
          </>
        )}
      </div>
    </div>
  );
}
