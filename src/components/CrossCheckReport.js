// ─── Price Cross-Check Report + Manual Override Confirmation ──────────────────
import { fmtUsd, fmtPrice } from '../constants';
import { C, S, Badge } from '../ui';

const STATUS_COLOR = { pass: C.green, warn: C.yellow, fail: C.red };
const STATUS_ICON = { pass: '✓', warn: '!', fail: '✗' };
const pct = (v, d = 3) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${Number(v).toFixed(d)}%`);

export function VerdictBanner({ check }) {
  if (!check) return null;
  const tone = check.allowed ? C.green : !check.dataOk ? C.red : C.yellow;
  const title = check.allowed
    ? 'VERIFIED — prices check out and profitable on both calculations'
    : !check.dataOk
      ? 'BLOCKED — price data failed cross-reference'
      : 'BLOCKED — not profitable on both calculations';
  return (
    <div style={{ padding: '10px 14px', borderRadius: 8, marginBottom: 12, background: `${tone}14`, border: `1px solid ${tone}66` }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ color: tone, fontWeight: 700, fontSize: 12 }}>{title}</span>
        <span style={{ display: 'flex', gap: 6 }}>
          <Badge color={check.dataOk ? C.green : C.red}>PRICES {check.dataOk ? 'OK' : 'FAIL'}</Badge>
          <Badge color={check.perTrade.pass ? C.green : C.red}>PER TRADE {check.perTrade.pass ? 'PASS' : 'FAIL'}</Badge>
          <Badge color={check.monthly.pass ? C.green : C.red}>MONTHLY {check.monthly.pass ? 'PASS' : 'FAIL'}</Badge>
        </span>
      </div>
      {!check.allowed && check.blockers.length > 0 && (
        <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 11, color: C.text, lineHeight: 1.6 }}>
          {check.blockers.slice(0, 5).map((b, i) => <li key={i}>{b}</li>)}
        </ul>
      )}
    </div>
  );
}

function Row({ label, value, color, strong }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: '3px 0', fontSize: 11, borderBottom: `1px dashed ${C.border}` }}>
      <span style={{ color: C.muted }}>{label}</span>
      <span style={{ color: color || C.text, fontWeight: strong ? 700 : 400 }}>{value}</span>
    </div>
  );
}

function CalcCard({ title, pass, children, footer }) {
  return (
    <div style={{ ...S.card, padding: 12, borderColor: `${pass ? C.green : C.red}66` }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: C.text, letterSpacing: 1, textTransform: 'uppercase' }}>{title}</span>
        <Badge color={pass ? C.green : C.red}>{pass ? 'PROFITABLE' : 'NOT PROFITABLE'}</Badge>
      </div>
      {children}
      {footer && <div style={{ fontSize: 10, color: C.muted, marginTop: 8, lineHeight: 1.5 }}>{footer}</div>}
    </div>
  );
}

export default function CrossCheckReport({ check, compact = false }) {
  if (!check) return null;
  const t = check.perTrade;
  const m = check.monthly;
  const lbl = (ex) => (check.prices.find(p => p.ex === ex) || {}).label || ex;

  return (
    <div>
      <VerdictBanner check={check} />

      {/* Price comparison */}
      <div style={{ overflowX: 'auto', marginBottom: 12 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
          <thead>
            <tr style={{ background: '#04070e', color: C.muted, textAlign: 'left' }}>
              {['Venue', 'Scanner bid / ask', 'Live book bid / ask', 'Book mid', 'Scanner drift', 'vs reference'].map(h => (
                <th key={h} style={{ padding: '6px 8px', borderBottom: `1px solid ${C.border}` }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {check.prices.map(p => (
              <tr key={p.ex} style={{ borderBottom: '1px solid #0b1424' }}>
                <td style={{ padding: '6px 8px', fontWeight: 700 }}>{p.label}</td>
                <td style={{ padding: '6px 8px' }}>{p.tickerMid ? `${fmtPrice(p.tickerBid)} / ${fmtPrice(p.tickerAsk)}` : <span style={{ color: C.yellow }}>{p.tickerError || '—'}</span>}</td>
                <td style={{ padding: '6px 8px' }}>{p.bookMid ? `${fmtPrice(p.bookBid)} / ${fmtPrice(p.bookAsk)}` : <span style={{ color: C.red }}>{p.bookError || '—'}</span>}</td>
                <td style={{ padding: '6px 8px', color: C.cyan }}>{fmtPrice(p.bookMid)}</td>
                <td style={{ padding: '6px 8px' }}>{p.driftPct != null ? `${p.driftPct.toFixed(3)}%` : '—'}</td>
                <td style={{ padding: '6px 8px' }}>{p.refDevPct != null ? `${p.refDevPct.toFixed(3)}%` : '—'}</td>
              </tr>
            ))}
            <tr>
              <td style={{ padding: '6px 8px', color: C.muted }}>Reference</td>
              <td colSpan={5} style={{ padding: '6px 8px', color: C.muted }}>
                {check.reference.median
                  ? `Median ${fmtPrice(check.reference.median)} from ${check.reference.sources.map(s => `${s.label}${s.quote !== check.quote ? ` (${s.quote})` : ''}`).join(', ')}`
                  : 'No other exchange lists this coin'}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Two profitability calculations */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12, marginBottom: 12 }}>
        <CalcCard title="1 · Per trade (live order books)" pass={t.pass}
          footer={t.buyOn ? `Buy ${lbl(t.buyOn)} → sell ${lbl(t.sellOn)}. Prices are volume-weighted fills for the full order, plus a ${t.slippageBps} bps/leg slippage buffer.` : t.reason}>
          {t.buyOn && (<>
            <Row label="Order" value={`${t.baseAmount} ${check.symbol} ≈ ${fmtUsd(t.tradeSize)}`} />
            <Row label="Buy VWAP / Sell VWAP" value={`${fmtPrice(t.buyVwap)} / ${fmtPrice(t.sellVwap)}`} />
            <Row label="Gross spread" value={`${fmtUsd(t.grossDollar, 4)} (${pct(t.grossPct)})`} />
            <Row label={`Trading fees (${t.feeBuyPct}% + ${t.feeSellPct}%)`} value={`−${fmtUsd(t.feeDollar, 4)}`} color={C.yellow} />
            <Row label="Slippage buffer" value={`−${fmtUsd(Math.max(0, t.slippageDollar), 4)}`} color={C.yellow} />
            <Row label="Net per trade" value={`${fmtUsd(t.netDollar, 4)} (${pct(t.netPct)})`} color={t.netDollar > 0 ? C.green : C.red} strong />
            <Row label="Break-even spread" value={`${t.breakevenPct}%`} />
            {t.minProfitabilityPct != null && (
              <Row label="Bot min_profitability" value={`${t.minProfitabilityPct}% ${t.meetsBotThreshold ? '(met now)' : '(not met now — bot will wait)'}`} color={t.meetsBotThreshold ? C.green : C.muted} />
            )}
          </>)}
        </CalcCard>

        <CalcCard title="2 · Monthly (server + transaction costs)" pass={m.pass}
          footer={m.source === 'observed'
            ? `Based on ${m.observedHours}h of scanner history: ${m.episodesPerHour} opportunities/hour × ${m.captureRatePct}% capture.`
            : `Assumed rate — not enough scanner history yet (${m.observedHours}h). Run the Live Scanner for at least 1 hour for real numbers.`}>
          <Row label="Trades / month" value={`${m.tradesPerMonth}${m.source === 'assumed' ? ' (assumed)' : ''}`} />
          <Row label="Net per trade" value={`${fmtUsd(m.netPerTrade, 4)} (${pct(m.netPctPerTrade)})`} />
          <Row label="Trading net (after fees + slippage)" value={fmtUsd(m.tradingNetMonthly)} color={m.tradingNetMonthly > 0 ? C.green : C.red} />
          <Row label="  incl. fees / slippage" value={`${fmtUsd(m.feesMonthly)} / ${fmtUsd(m.slippageMonthly)}`} color={C.muted} />
          <Row label="Rebalancing transfers" value={`−${fmtUsd(m.rebalanceMonthly)}`} color={C.yellow} />
          <Row label={`Server (${m.serverSource === 'host' ? 'your host cost' : 'est. avg'})`} value={`−${fmtUsd(m.serverMonthly)}`} color={C.yellow} />
          <Row label="Net per month" value={fmtUsd(m.monthlyNet)} color={m.monthlyNet > 0 ? C.green : C.red} strong />
          {!compact && m.serverDetail && <div style={{ fontSize: 10, color: C.dim, marginTop: 6 }}>{m.serverDetail}</div>}
        </CalcCard>
      </div>

      {/* Data integrity checks */}
      <div style={{ display: 'grid', gap: 4, marginBottom: 8 }}>
        {check.checks.map(c => (
          <div key={c.id} style={{ display: 'flex', gap: 8, fontSize: 11, alignItems: 'baseline' }}>
            <span style={{ color: STATUS_COLOR[c.status], fontWeight: 700, width: 14 }}>{STATUS_ICON[c.status]}</span>
            <span style={{ color: C.text, minWidth: compact ? 0 : 300 }}>{c.label}</span>
            {!compact && <span style={{ color: C.muted }}>{c.detail}</span>}
          </div>
        ))}
      </div>
      <div style={{ fontSize: 10, color: C.dim }}>Checked {new Date(check.checkedAt).toLocaleTimeString()}</div>
    </div>
  );
}

// Manual confirmation needed to launch a bot that did not pass the check
export function OverrideConfirm({ live, phrase, confirmed, setConfirmed, typed, setTyped }) {
  return (
    <div style={{ padding: '10px 14px', borderRadius: 8, marginBottom: 12, background: '#1f1400', border: `1px solid ${C.yellow}66` }}>
      <div style={{ fontSize: 11, color: C.yellow, fontWeight: 700, marginBottom: 6 }}>MANUAL CONFIRMATION REQUIRED</div>
      <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 11, color: C.text, cursor: 'pointer', lineHeight: 1.5 }}>
        <input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} style={{ marginTop: 2 }} />
        I reviewed the cross-check above and want to launch this bot anyway. This override is logged.
      </label>
      {live && (
        <div style={{ marginTop: 8 }}>
          <label style={S.lbl}>Type <b style={{ color: C.red }}>{phrase}</b> to launch with real funds</label>
          <input style={S.inp} value={typed} onChange={e => setTyped(e.target.value)} placeholder={phrase} />
        </div>
      )}
    </div>
  );
}

export function overrideReady({ live, phrase, confirmed, typed }) {
  return confirmed && (!live || String(typed || '').trim().toUpperCase() === String(phrase || '').toUpperCase());
}
