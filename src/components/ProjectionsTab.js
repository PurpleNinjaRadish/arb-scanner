// ─── Cost-Effectiveness & Profitability Projections Tab ──────────────────────
import { useState, useEffect, useCallback } from 'react';
import { api } from '../api';
import { fmtUsd } from '../constants';
import { C, S, Badge, MetricCard, Notice } from '../ui';

const SERVER_PRESETS = [
  { label: 'Local PC ($0)', cost: 0 },
  { label: 'Hetzner CPX11 ($5.50)', cost: 5.5 },
  { label: 'Hetzner CPX21 ($10.50)', cost: 10.5 },
  { label: 'Hetzner CPX31 ($18.50)', cost: 18.5 },
  { label: 'AWS Lightsail 4G ($24)', cost: 24 },
  { label: 'AWS t3.medium ($33)', cost: 33 },
  { label: 'AWS c7i.large ($68)', cost: 68 },
];

export default function ProjectionsTab({ seed, activePairId, quote, onOpenAdvisor }) {
  const [inputs, setInputs] = useState({
    capital: 5000,
    tradeSize: 500,
    botsCount: 3,
    tradesPerDayPerBot: 8,
    avgGrossSpreadPct: 0.95,
    feeBuyPct: 0.25,
    feeSellPct: 0.60,
    slippageBps: 8,
    captureRatePct: 70,
    serverMonthlyUsd: 10.5,
    rebalanceMonthlyUsd: 5,
    strategyMode: 'xemm',
  });

  const [proj, setProj] = useState(null);
  const [obsStats, setObsStats] = useState(null);
  const [note, setNote] = useState('');

  // Accept prefill when user clicks "Project" on a scanner row or from Paper Lab
  useEffect(() => {
    if (!seed) return;
    setInputs(prev => ({
      ...prev,
      ...(seed.capital != null ? { capital: seed.capital } : {}),
      ...(seed.tradeSize != null ? { tradeSize: seed.tradeSize } : {}),
      ...(seed.avgGrossSpreadPct != null ? { avgGrossSpreadPct: Number(seed.avgGrossSpreadPct.toFixed(3)) } : {}),
      ...(seed.feeBuyPct != null ? { feeBuyPct: Number(seed.feeBuyPct.toFixed(3)) } : {}),
      ...(seed.feeSellPct != null ? { feeSellPct: Number(seed.feeSellPct.toFixed(3)) } : {}),
      ...(seed.slippageBps != null ? { slippageBps: seed.slippageBps } : {}),
      ...(seed.captureRatePct != null ? { captureRatePct: seed.captureRatePct } : {}),
      ...(seed.tradesPerDayPerBot != null ? { tradesPerDayPerBot: seed.tradesPerDayPerBot } : {}),
    }));
  }, [seed]);

  const recalc = useCallback(async (inp) => {
    try {
      const d = await api('/api/advisor/projections', { method: 'POST', body: inp });
      setProj(d);
    } catch (_) {}
  }, []);

  useEffect(() => {
    const t = setTimeout(() => recalc(inputs), 120);
    return () => clearTimeout(t);
  }, [inputs, recalc]);

  const loadObserved = useCallback(async () => {
    try {
      const key = `${activePairId}|${quote}`;
      const d = await api('/api/stats', { params: { key } });
      setObsStats(d);
    } catch (_) {}
  }, [activePairId, quote]);

  useEffect(() => { loadObserved(); }, [loadObserved]);

  const applyObserved = () => {
    if (!obsStats || !obsStats.totals || obsStats.totals.episodes === 0) {
      setNote('No viable observed episodes recorded yet — let the Live Scanner run for a few minutes first.');
      return;
    }
    const tpd = Math.max(1, Number((obsStats.totals.episodesPerHour * 24 / Math.max(1, inputs.botsCount)).toFixed(1)));
    const impliedGross = Number((obsStats.totals.avgNetViable + inputs.feeBuyPct + inputs.feeSellPct).toFixed(3));
    setInputs(p => ({ ...p, tradesPerDayPerBot: tpd, avgGrossSpreadPct: impliedGross }));
    setNote(`Loaded observed stats from ${obsStats.scans} scans (${obsStats.observedHours.toFixed(2)}h): ${tpd} trades/day/bot, ~${impliedGross}% gross spread.`);
  };

  const setNum = (k) => (e) => setInputs(p => ({ ...p, [k]: parseFloat(e.target.value) || 0 }));
  const base = proj?.scenarios?.base;

  return (
    <div>
      {/* Inputs */}
      <div style={{ ...S.card, marginBottom: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginBottom: 14 }}>
          <div>
            <div style={S.sectionTitle}>Profitability & Server Cost-Effectiveness Model</div>
            <div style={{ fontSize: 11, color: C.muted }}>
              Models net profit after exchange fees, order-book slippage, execution capture rate, rebalancing, and monthly VPS cost.
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button className="tbtn" onClick={applyObserved} style={S.btn(C.cyan)}>📊 Load Observed Scanner Rates</button>
            {onOpenAdvisor && (
              <button className="tbtn" onClick={() => onOpenAdvisor(inputs.botsCount, base?.monthlyBeforeServer || 150)} style={S.btn(C.blue, true)}>
                🖥 Match Optimal Server Specs →
              </button>
            )}
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginBottom: 12 }}>
          <div><label style={S.lbl}>Total Capital ($)</label><input type="number" step="500" style={S.inp} value={inputs.capital} onChange={setNum('capital')} /></div>
          <div><label style={S.lbl}>Order Size ($)</label><input type="number" step="100" style={S.inp} value={inputs.tradeSize} onChange={setNum('tradeSize')} /></div>
          <div><label style={S.lbl}>Active Bots</label><input type="number" min="1" max="50" style={S.inp} value={inputs.botsCount} onChange={setNum('botsCount')} /></div>
          <div><label style={S.lbl}>Signals / Day / Bot</label><input type="number" step="1" style={S.inp} value={inputs.tradesPerDayPerBot} onChange={setNum('tradesPerDayPerBot')} /></div>
          <div><label style={S.lbl}>Avg Gross Spread %</label><input type="number" step="0.05" style={S.inp} value={inputs.avgGrossSpreadPct} onChange={setNum('avgGrossSpreadPct')} /></div>
          <div><label style={S.lbl}>Buy Leg Fee %</label><input type="number" step="0.02" style={S.inp} value={inputs.feeBuyPct} onChange={setNum('feeBuyPct')} /></div>
          <div><label style={S.lbl}>Sell Leg Fee %</label><input type="number" step="0.02" style={S.inp} value={inputs.feeSellPct} onChange={setNum('feeSellPct')} /></div>
          <div><label style={S.lbl}>Round-Trip Slip (bps)</label><input type="number" step="1" style={S.inp} value={inputs.slippageBps} onChange={setNum('slippageBps')} /></div>
          <div><label style={S.lbl}>Capture Rate %</label><input type="number" min="5" max="100" step="5" style={S.inp} value={inputs.captureRatePct} onChange={setNum('captureRatePct')} /></div>
          <div><label style={S.lbl}>Server Cost ($/mo)</label><input type="number" step="1" style={S.inp} value={inputs.serverMonthlyUsd} onChange={setNum('serverMonthlyUsd')} /></div>
          <div><label style={S.lbl}>Rebalance ($/mo)</label><input type="number" step="1" style={S.inp} value={inputs.rebalanceMonthlyUsd} onChange={setNum('rebalanceMonthlyUsd')} /></div>
        </div>

        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', paddingTop: 10, borderTop: `1px solid ${C.border}` }}>
          <span style={{ fontSize: 10, color: C.muted, textTransform: 'uppercase', letterSpacing: 1 }}>Quick Server Cost:</span>
          {SERVER_PRESETS.map(p => (
            <button key={p.label} className="tbtn" onClick={() => setInputs(x => ({ ...x, serverMonthlyUsd: p.cost }))}
              style={{ ...(inputs.serverMonthlyUsd === p.cost ? S.btn(C.yellow, true) : S.btnMuted), fontSize: 10, padding: '4px 8px' }}>
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {note && <Notice tone="info">{note}</Notice>}

      {proj && (
        <div>
          {/* Cost-effectiveness verdict & warnings */}
          {proj.warnings.map((w, i) => <Notice key={i} tone="warn">⚠ {w}</Notice>)}

          {base && (
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
              <MetricCard
                label="Cost-Effectiveness"
                value={base.costEffective ? 'COST-EFFECTIVE' : base.monthlyNet > 0 ? 'MARGINAL' : 'UNPROFITABLE'}
                sub={base.serverCostPct != null ? `Server eats ${base.serverCostPct}% of profit` : 'Net ≤ 0 before server'}
                color={base.costEffective ? C.green : base.monthlyNet > 0 ? C.yellow : C.red}
              />
              <MetricCard label="Break-Even Spread" value={`${proj.breakevenSpreadPct.toFixed(3)}%`} sub="Fees + slippage floor" color={C.cyan} />
              <MetricCard label="Break-Even Trades/Day" value={base.breakevenTradesPerDay != null ? `${base.breakevenTradesPerDay}/day` : 'N/A'} sub="To pay server + rebalance" color={C.yellow} />
              <MetricCard label="Base Monthly Net" value={`${base.monthlyNet >= 0 ? '+' : ''}${fmtUsd(base.monthlyNet)}`} sub={`ROI ${base.monthlyRoiPct >= 0 ? '+' : ''}${base.monthlyRoiPct}% / mo (${base.annualRoiPct}%/yr)`} color={base.monthlyNet >= 0 ? C.green : C.red} />
              <MetricCard label="Est. Monthly Volume" value={fmtUsd(base.monthlyVolume, 0)} sub={`Monthly fees: ${fmtUsd(base.monthlyFees)}`} color={C.blue} />
              <MetricCard label="Suggested Capital" value={fmtUsd(proj.recommendedCapital, 0)} sub={`For ${inputs.botsCount} bots × ${fmtUsd(inputs.tradeSize, 0)}`} color={inputs.capital >= proj.recommendedCapital ? C.green : C.yellow} />
            </div>
          )}

          {/* 3-Scenario Comparison */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12, marginBottom: 14 }}>
            {['conservative', 'base', 'optimistic'].map(k => {
              const sc = proj.scenarios[k];
              const accent = k === 'base' ? C.blue : k === 'optimistic' ? C.green : C.yellow;
              return (
                <div key={k} style={{ ...S.card, borderColor: k === 'base' ? `${C.blue}88` : C.border }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                    <span style={{ fontFamily: "'Orbitron', sans-serif", fontSize: 12, color: accent, letterSpacing: 1.5 }}>{sc.label.toUpperCase()}</span>
                    <Badge color={sc.monthlyNet >= 0 ? C.green : C.red}>{sc.monthlyRoiPct >= 0 ? '+' : ''}{sc.monthlyRoiPct}% / mo</Badge>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 11 }}>
                    <div><span style={{ color: C.dim }}>Filled / Day:</span><br /><b>{sc.effTradesDay}</b></div>
                    <div><span style={{ color: C.dim }}>Net / Trade:</span><br /><b style={{ color: sc.netDollarTrade >= 0 ? C.green : C.red }}>{fmtUsd(sc.netDollarTrade)} ({sc.netPctPerTrade}%)</b></div>
                    <div><span style={{ color: C.dim }}>Daily Net:</span><br /><b style={{ color: sc.dailyNet >= 0 ? C.green : C.red }}>{fmtUsd(sc.dailyNet)}</b></div>
                    <div><span style={{ color: C.dim }}>Weekly Net:</span><br /><b style={{ color: sc.weeklyNet >= 0 ? C.green : C.red }}>{fmtUsd(sc.weeklyNet)}</b></div>
                    <div><span style={{ color: C.dim }}>Monthly (pre-VPS):</span><br /><b>{fmtUsd(sc.monthlyBeforeServer)}</b></div>
                    <div><span style={{ color: C.dim }}>Monthly Net:</span><br /><b style={{ fontSize: 14, color: sc.monthlyNet >= 0 ? C.green : C.red }}>{fmtUsd(sc.monthlyNet)}</b></div>
                    <div style={{ gridColumn: '1 / -1', borderTop: `1px solid ${C.border}`, paddingTop: 6, marginTop: 2 }}>
                      <span style={{ color: C.dim }}>Projected 12-Month Net: </span>
                      <b style={{ color: sc.annualNet >= 0 ? C.green : C.red }}>{fmtUsd(sc.annualNet)}</b>
                      <span style={{ color: C.muted }}> ({sc.annualRoiPct}% APR)</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Fee Tier Sensitivity Table */}
          <div style={{ ...S.card, marginBottom: 14 }}>
            <div style={S.sectionTitle}>Fee Tier Sensitivity Analysis (Why XEMM Maker Fees & Volume Tiers Matter)</div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                <thead>
                  <tr style={{ background: '#04070e', color: C.muted, textAlign: 'left' }}>
                    {['Fee Tier / Execution Style', 'Combined Fee', 'Break-Even Spread', 'Net % @ Current Spread', 'Est. Monthly Net', 'Status'].map(h => (
                      <th key={h} style={{ padding: '8px 10px', borderBottom: `1px solid ${C.border}` }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {proj.feeTierComparison.map(t => (
                    <tr key={t.name} style={{ borderBottom: `1px solid #0b1424` }}>
                      <td style={{ padding: '8px 10px', fontWeight: 600 }}>{t.name}</td>
                      <td style={{ padding: '8px 10px', color: C.yellow }}>{t.feePct.toFixed(2)}%</td>
                      <td style={{ padding: '8px 10px', color: C.cyan }}>{t.breakevenSpreadPct.toFixed(3)}%</td>
                      <td style={{ padding: '8px 10px', color: t.netPctPerTrade > 0 ? C.green : C.red }}>{t.netPctPerTrade >= 0 ? '+' : ''}{t.netPctPerTrade.toFixed(3)}%</td>
                      <td style={{ padding: '8px 10px', fontWeight: 700, color: t.monthlyNet > 0 ? C.green : C.red }}>{fmtUsd(t.monthlyNet)}</td>
                      <td style={{ padding: '8px 10px' }}><Badge color={t.profitable ? C.green : C.red}>{t.profitable ? 'PROFITABLE' : 'BELOW FEE FLOOR'}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Observed Opportunity Stats from Scanner */}
          {obsStats && obsStats.scans > 0 && (
            <div style={S.card}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <div style={S.sectionTitle}>Observed Live Scanner History ({obsStats.key} · {obsStats.scans} scans · {obsStats.observedHours.toFixed(2)}h)</div>
                <button className="tbtn" onClick={async () => { await api('/api/stats/reset', { method: 'POST', body: { key: obsStats.key } }); loadObserved(); }} style={S.btn(C.red)}>Reset History</button>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                  <thead>
                    <tr style={{ background: '#04070e', color: C.muted, textAlign: 'left' }}>
                      {['Coin', 'Samples', 'Viable %', 'Episodes', 'Episodes/hr', 'Avg Net (Viable)', 'Max Net', 'Avg Mid Spread'].map(h => (
                        <th key={h} style={{ padding: '7px 10px', borderBottom: `1px solid ${C.border}` }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {obsStats.coins.slice(0, 20).map(c => (
                      <tr key={c.coin} style={{ borderBottom: `1px solid #0b1424` }}>
                        <td style={{ padding: '6px 10px', fontWeight: 700 }}>{c.coin}</td>
                        <td style={{ padding: '6px 10px' }}>{c.samples}</td>
                        <td style={{ padding: '6px 10px', color: c.viablePct > 0 ? C.green : C.muted }}>{c.viablePct.toFixed(1)}%</td>
                        <td style={{ padding: '6px 10px' }}>{c.episodes}</td>
                        <td style={{ padding: '6px 10px', color: C.cyan }}>{c.episodesPerHour.toFixed(2)}</td>
                        <td style={{ padding: '6px 10px', color: c.avgNetViable > 0 ? C.green : C.muted }}>{c.avgNetViable.toFixed(3)}%</td>
                        <td style={{ padding: '6px 10px', color: (c.maxNet || 0) > 0 ? C.green : C.red }}>{c.maxNet != null ? `${c.maxNet.toFixed(3)}%` : '—'}</td>
                        <td style={{ padding: '6px 10px' }}>{c.avgMidSpread.toFixed(3)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
