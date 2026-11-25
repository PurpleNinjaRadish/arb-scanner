// ─── Shared UI Styles & Reusable Components ───────────────────────────────────
import { useState } from 'react';
import { EXCHANGES, getTradeUrl, fmtPrice } from './constants';

export const C = {
  bg: '#050810',
  panel: '#080d18',
  panelAlt: '#0b1222',
  input: '#04070e',
  border: '#132138',
  borderHi: '#223a60',
  text: '#c8d6e8',
  muted: '#6c82a0',
  dim: '#3b4f6b',
  blue: '#3b8dff',
  green: '#00e68a',
  yellow: '#ffcc33',
  red: '#ff4d64',
  cyan: '#22d3ee',
  purple: '#a78bfa',
};

export const S = {
  card: {
    background: C.panel,
    border: `1px solid ${C.border}`,
    borderRadius: 10,
    padding: 16,
  },
  inp: {
    background: C.input,
    border: `1px solid ${C.borderHi}`,
    color: C.text,
    borderRadius: 6,
    padding: '7px 10px',
    fontSize: 12,
    fontFamily: "'IBM Plex Mono', monospace",
    width: '100%',
    outline: 'none',
  },
  lbl: {
    fontSize: 10,
    color: C.muted,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    display: 'block',
    marginBottom: 5,
  },
  btn: (color = C.blue, solid = false) => ({
    padding: '7px 13px',
    fontSize: 11,
    letterSpacing: 1,
    textTransform: 'uppercase',
    fontFamily: "'IBM Plex Mono', monospace",
    border: `1px solid ${color}${solid ? '' : '66'}`,
    background: solid ? `${color}28` : `${color}12`,
    color,
    borderRadius: 6,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  }),
  btnMuted: {
    padding: '7px 13px',
    fontSize: 11,
    letterSpacing: 1,
    textTransform: 'uppercase',
    fontFamily: "'IBM Plex Mono', monospace",
    border: `1px solid ${C.borderHi}`,
    background: 'transparent',
    color: C.muted,
    borderRadius: 6,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  sectionTitle: {
    fontFamily: "'Orbitron', sans-serif",
    fontSize: 12,
    color: C.blue,
    letterSpacing: 1.8,
    textTransform: 'uppercase',
    marginBottom: 10,
  },
  codeBox: {
    background: '#03060c',
    border: `1px solid ${C.border}`,
    borderRadius: 8,
    padding: 12,
    fontSize: 11,
    color: '#93c5fd',
    fontFamily: "'IBM Plex Mono', monospace",
    overflow: 'auto',
    whiteSpace: 'pre',
    lineHeight: 1.6,
  },
};

export function Badge({ children, color = C.blue, title }) {
  return (
    <span title={title} style={{
      display: 'inline-block',
      fontSize: 9,
      padding: '2px 7px',
      borderRadius: 4,
      letterSpacing: 0.8,
      textTransform: 'uppercase',
      fontWeight: 600,
      background: `${color}1f`,
      color,
      border: `1px solid ${color}4d`,
      whiteSpace: 'nowrap',
    }}>{children}</span>
  );
}

export function MetricCard({ label, value, sub, color = C.text }) {
  return (
    <div style={{
      background: C.panel,
      border: `1px solid ${C.border}`,
      borderRadius: 8,
      padding: '10px 14px',
      minWidth: 120,
    }}>
      <div style={{ fontSize: 9, color: C.muted, letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 17, color, fontFamily: "'Orbitron', sans-serif", fontWeight: 700 }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: C.dim, marginTop: 3 }}>{sub}</div>}
    </div>
  );
}

export function ExBadge({ name, symbol, quote = 'USD' }) {
  const ex = EXCHANGES[name] || { label: name, color: C.muted };
  const el = <Badge color={ex.color}>{ex.label}</Badge>;
  if (!symbol) return el;
  return (
    <a href={getTradeUrl(name, symbol, quote)} target="_blank" rel="noreferrer"
       style={{ textDecoration: 'none' }} onClick={e => e.stopPropagation()}>
      {el}
    </a>
  );
}

export function PriceTick({ value, prev }) {
  const c = prev != null && value > prev ? C.green : prev != null && value < prev ? C.red : C.text;
  return <span style={{ color: c, transition: 'color 0.4s' }}>{fmtPrice(value)}</span>;
}

export function CopyBtn({ text, label = 'Copy' }) {
  const [copied, setCopied] = useState(false);
  return (
    <button className="tbtn" onClick={() => {
      navigator.clipboard.writeText(text || '');
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    }} style={S.btn(copied ? C.green : C.muted)}>
      {copied ? '✓ Copied' : label}
    </button>
  );
}

export function Notice({ tone = 'info', children }) {
  const color = tone === 'error' ? C.red : tone === 'warn' ? C.yellow : tone === 'ok' ? C.green : C.blue;
  return (
    <div style={{
      background: `${color}14`,
      border: `1px solid ${color}44`,
      color,
      borderRadius: 8,
      padding: '10px 14px',
      fontSize: 11,
      lineHeight: 1.65,
      marginBottom: 12,
      whiteSpace: 'pre-wrap',
    }}>{children}</div>
  );
}

export function Modal({ title, subtitle, onClose, maxWidth = 760, children }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.82)', zIndex: 500,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 18,
    }} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{
        background: C.bg, border: `1px solid ${C.borderHi}`, borderRadius: 12,
        width: '100%', maxWidth, maxHeight: '92vh', display: 'flex', flexDirection: 'column',
        boxShadow: '0 14px 60px rgba(0,0,0,0.85)', overflow: 'hidden',
      }}>
        <div style={{
          padding: '14px 20px', background: C.panelAlt, borderBottom: `1px solid ${C.border}`,
          display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
        }}>
          <div>
            <div style={{ fontFamily: "'Orbitron', sans-serif", fontSize: 13, color: C.blue, letterSpacing: 1.8 }}>{title}</div>
            {subtitle && <div style={{ fontSize: 11, color: C.muted, marginTop: 3 }}>{subtitle}</div>}
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: C.muted, fontSize: 22, cursor: 'pointer', lineHeight: 1 }}>×</button>
        </div>
        <div style={{ padding: 20, overflowY: 'auto', flex: 1 }}>{children}</div>
      </div>
    </div>
  );
}

export function Sparkline({ points = [], width = 520, height = 110 }) {
  if (!points || points.length < 2) {
    return (
      <div style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.dim, fontSize: 11, border: `1px dashed ${C.border}`, borderRadius: 8 }}>
        Run a few paper ticks to plot equity curve
      </div>
    );
  }
  const vals = points.map(p => p.pnl);
  const min = Math.min(0, ...vals), max = Math.max(0.01, ...vals);
  const span = Math.max(max - min, 0.01);
  const pad = 12;
  const x = i => pad + (i / (points.length - 1)) * (width - pad * 2);
  const y = v => height - pad - ((v - min) / span) * (height - pad * 2);
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.pnl).toFixed(1)}`).join(' ');
  const last = vals[vals.length - 1];
  const color = last >= 0 ? C.green : C.red;
  const zeroY = y(0);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', height, background: '#04070e', borderRadius: 8, border: `1px solid ${C.border}` }}>
      <line x1={pad} y1={zeroY} x2={width - pad} y2={zeroY} stroke="#1f324d" strokeDasharray="4 4" />
      <path d={path} fill="none" stroke={color} strokeWidth="2" />
      <circle cx={x(points.length - 1)} cy={y(last)} r="3.5" fill={color} />
    </svg>
  );
}
