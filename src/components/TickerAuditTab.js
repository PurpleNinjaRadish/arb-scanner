// ─── Ticker Audit: every coin on every exchange, matched to one ticker ────────
import { useState, useEffect, useCallback, useMemo } from 'react';
import { api } from '../api';
import { EXCHANGES, fmtPrice } from '../constants';
import { C, S, Badge, Notice, MetricCard } from '../ui';

const STATUS = {
  ok: { color: C.green, label: 'OK' },
  single: { color: C.muted, label: 'ONLY HERE' },
  suspect: { color: C.yellow, label: 'SUSPECT' },
  bad_quote: { color: C.yellow, label: 'STALE QUOTE' },
  mismatch: { color: C.red, label: 'MISMATCH' },
  conflict: { color: C.red, label: 'CONFLICT' },
  collision: { color: C.red, label: 'DIFFERENT COIN' },
  no_price: { color: C.dim, label: 'NO PRICE' },
  fiat: { color: C.dim, label: 'FIAT' },
};
const FILTERS = [
  ['multi', 'On 2+ exchanges'],
  ['flagged', 'Flagged'],
  ['warn', 'Warnings'],
  ['all', 'All coins'],
];
const PAGE = 200;

function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export default function TickerAuditTab() {
  const [audit, setAudit] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('multi');
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(PAGE);

  const load = useCallback(async (refresh) => {
    setBusy(true); setError('');
    try {
      setAudit(await api('/api/tickers/audit', { params: { full: 1, refresh: refresh ? 1 : undefined } }));
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { load(false); }, [load]);

  const exList = useMemo(() => (audit ? Object.keys(audit.exchanges) : Object.keys(EXCHANGES)), [audit]);

  const rows = useMemo(() => {
    if (!audit) return [];
    const needle = q.trim().toUpperCase();
    return audit.symbols.filter(s => {
      if (needle && !s.symbol.includes(needle) && !Object.values(s.listings).some(l => l.native.includes(needle))) return false;
      if (filter === 'multi') return s.exchanges > 1;
      if (filter === 'flagged') return s.status === 'flagged';
      if (filter === 'warn') return s.status === 'warn' || s.status === 'flagged';
      return true;
    });
  }, [audit, filter, q]);

  useEffect(() => { setLimit(PAGE); }, [filter, q]);

  const exportCsv = () => {
    if (!audit) return;
    const head = ['symbol', 'kind', 'status', 'median_usd', 'exchanges', ...exList.flatMap(e => [`${e}_ticker`, `${e}_usd`, `${e}_status`])];
    const lines = [head.join(',')];
    for (const s of audit.symbols) {
      lines.push([s.symbol, s.kind, s.status, s.medianUsd, s.exchanges, ...exList.flatMap(e => {
        const l = s.listings[e];
        return l ? [l.native, l.usd, l.status] : ['', '', ''];
      })].map(csvEscape).join(','));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `ticker-audit-${new Date(audit.at).toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div>
      <div style={{ ...S.card, marginBottom: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
          <div>
            <div style={S.sectionTitle}>Ticker Audit — Every Coin on Every Exchange</div>
            <div style={{ fontSize: 11, color: C.muted, maxWidth: 860, lineHeight: 1.6 }}>
              Pulls every USD / USDC / USDT spot market from each exchange, maps renamed coins to one ticker, and checks each
              listing's price against the other exchanges. Flagged listings are different coins sharing a ticker, or dead
              markets, and are automatically left out of the scanner, alerts and bot launches. Refreshes every 30 minutes.
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="tbtn" disabled={!audit} onClick={exportCsv} style={S.btn(C.cyan)}>⬇ Export CSV</button>
            <button className="tbtn" disabled={busy} onClick={() => load(true)} style={S.btn(C.blue, true)}>{busy ? 'Auditing…' : '↻ Re-run audit'}</button>
          </div>
        </div>
        {audit && <div style={{ fontSize: 10, color: C.dim, marginTop: 8 }}>Last run {new Date(audit.at).toLocaleString()}</div>}
      </div>

      {error && <Notice tone="error">✗ {error}</Notice>}
      {!audit && !error && <Notice tone="info">Fetching every listing from every exchange… this takes 10–20 seconds.</Notice>}

      {audit && (
        <>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
            <MetricCard label="Coins found" value={audit.totals.symbols.toLocaleString()} sub={`${audit.totals.multiListed} on 2+ exchanges`} color={C.cyan} />
            <MetricCard label="Flagged" value={`${audit.totals.flaggedSymbols} coins`} sub={`${audit.totals.flaggedListings} listings excluded`} color={audit.totals.flaggedListings ? C.red : C.green} />
            {exList.map(e => {
              const x = audit.exchanges[e];
              return (
                <MetricCard key={e} label={x.label}
                  value={x.ok ? `${x.coins} coins` : 'UNREACHABLE'}
                  sub={x.ok ? `${x.markets} markets · ${x.flagged} flagged${x.source && x.source !== 'live' ? ` · ${x.source}` : ''}` : (x.error || 'no data')}
                  color={!x.ok ? C.red : x.source !== 'live' ? C.yellow : C.green} />
              );
            })}
          </div>

          {Object.values(audit.exchanges).some(x => !x.ok || x.source !== 'live') && (
            <Notice tone="warn">
              {Object.values(audit.exchanges).filter(x => !x.ok || x.source !== 'live')
                .map(x => (x.ok ? `${x.label}: ${x.source} — the scanner can't trade it from this server` : `${x.error} — skipped by the scanner`)).join('\n')}
            </Notice>
          )}

          {/* Flagged listings */}
          <div style={{ ...S.card, marginBottom: 14 }}>
            <div style={S.sectionTitle}>Flagged Listings ({audit.flagged.length})</div>
            {audit.flagged.length === 0 ? <div style={{ fontSize: 11, color: C.green }}>No mismatched tickers.</div> : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                  <thead>
                    <tr style={{ background: '#04070e', color: C.muted, textAlign: 'left' }}>
                      {['Coin', 'Exchange', 'Exchange ticker', 'Status', 'Price', 'Other exchanges', 'Why'].map(h => (
                        <th key={h} style={{ padding: '6px 8px', borderBottom: `1px solid ${C.border}` }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {audit.flagged.map(f => (
                      <tr key={`${f.symbol}-${f.exchange}`} style={{ borderBottom: '1px solid #0b1424' }}>
                        <td style={{ padding: '6px 8px', fontWeight: 700 }}>{f.symbol}</td>
                        <td style={{ padding: '6px 8px' }}>{audit.exchanges[f.exchange]?.label || f.exchange}</td>
                        <td style={{ padding: '6px 8px' }}>{f.native}</td>
                        <td style={{ padding: '6px 8px' }}><Badge color={STATUS[f.status]?.color}>{STATUS[f.status]?.label || f.status}</Badge></td>
                        <td style={{ padding: '6px 8px' }}>{fmtPrice(f.usd)}</td>
                        <td style={{ padding: '6px 8px', color: C.muted }}>{fmtPrice(f.medianUsd)}</td>
                        <td style={{ padding: '6px 8px', color: C.muted }}>{f.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Renamed tickers */}
          <div style={{ ...S.card, marginBottom: 14 }}>
            <div style={S.sectionTitle}>Renamed Tickers (matched to one coin)</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {Object.entries(audit.aliases).flatMap(([ex, map]) => Object.entries(map).map(([nat, can]) => (
                <span key={`${ex}-${nat}`} style={{ fontSize: 11, padding: '4px 8px', border: `1px solid ${C.border}`, borderRadius: 6 }}>
                  {audit.exchanges[ex]?.label || ex}: <b>{nat}</b> → <b style={{ color: C.cyan }}>{can}</b>
                </span>
              )))}
            </div>
          </div>

          {/* All coins */}
          <div style={S.card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginBottom: 10 }}>
              <div style={S.sectionTitle}>All Coins ({rows.length.toLocaleString()})</div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                <input style={{ ...S.inp, width: 160 }} placeholder="Search ticker…" value={q} onChange={e => setQ(e.target.value)} />
                {FILTERS.map(([k, label]) => (
                  <button key={k} className="tbtn" onClick={() => setFilter(k)}
                    style={{ ...(filter === k ? S.btn(C.blue, true) : S.btnMuted), padding: '5px 9px', fontSize: 10 }}>{label}</button>
                ))}
              </div>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                <thead>
                  <tr style={{ background: '#04070e', color: C.muted, textAlign: 'left' }}>
                    <th style={{ padding: '6px 8px', borderBottom: `1px solid ${C.border}` }}>Coin</th>
                    <th style={{ padding: '6px 8px', borderBottom: `1px solid ${C.border}` }}>Median</th>
                    {exList.map(e => <th key={e} style={{ padding: '6px 8px', borderBottom: `1px solid ${C.border}` }}>{audit.exchanges[e]?.label || e}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, limit).map(s => (
                    <tr key={s.symbol} style={{ borderBottom: '1px solid #0b1424' }}>
                      <td style={{ padding: '5px 8px', fontWeight: 700 }}>
                        {s.symbol}
                        {s.kind !== 'crypto' && <span style={{ color: C.dim, fontWeight: 400, fontSize: 10 }}> {s.kind}</span>}
                      </td>
                      <td style={{ padding: '5px 8px', color: C.muted }}>{fmtPrice(s.medianUsd)}</td>
                      {exList.map(e => {
                        const l = s.listings[e];
                        if (!l) return <td key={e} style={{ padding: '5px 8px', color: C.dim }}>—</td>;
                        const st = STATUS[l.status] || { color: C.muted };
                        return (
                          <td key={e} title={l.reason || ''} style={{ padding: '5px 8px', color: st.color }}>
                            {fmtPrice(l.usd)}
                            {l.native !== s.symbol && <span style={{ color: C.cyan }}> ({l.native})</span>}
                            {!['ok', 'single'].includes(l.status) && <span style={{ fontSize: 9 }}> {st.label}</span>}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {rows.length > limit && (
              <div style={{ textAlign: 'center', marginTop: 10 }}>
                <button className="tbtn" onClick={() => setLimit(l => l + PAGE)} style={S.btnMuted}>Show {Math.min(PAGE, rows.length - limit)} more</button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
