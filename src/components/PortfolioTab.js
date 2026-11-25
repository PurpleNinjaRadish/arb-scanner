// ─── Unified Account Holdings & Transactions Watcher Tab ─────────────────────
// Watches LIVE exchange accounts (via CCXT read-only keys) + Hummingbot Paper
// balances/trades + Paper Lab virtual holdings/fills in one dashboard.
import { useState, useEffect, useCallback } from 'react';
import { api } from '../api';
import { EXCHANGES, fmtUsd, fmtPrice } from '../constants';
import { C, S, Badge, MetricCard, Notice, Modal } from '../ui';

export default function PortfolioTab({ selectedHost = 'local', watchAccounts = [], onAccountsChanged }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [txFilter, setTxFilter] = useState('ALL'); // ALL | TRADE | PAPER_TRADE | DEPOSIT | WITHDRAWAL
  const [search, setSearch] = useState('');
  const [showAddModal, setShowAddModal] = useState(false);

  // Add watch account form
  const [ex, setEx] = useState('kraken');
  const [label, setLabel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [sandbox, setSandbox] = useState(false);
  const [modalMsg, setModalMsg] = useState(null);

  const loadPortfolio = useCallback(async () => {
    setLoading(true); setErr('');
    try {
      const res = await api('/api/portfolio', { params: { target: selectedHost } });
      setData(res);
    } catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  }, [selectedHost]);

  useEffect(() => {
    loadPortfolio();
    const iv = setInterval(loadPortfolio, 30000);
    return () => clearInterval(iv);
  }, [loadPortfolio]);

  const saveAccount = async () => {
    setModalMsg(null);
    try {
      await api('/api/portfolio/accounts', {
        method: 'POST',
        body: { exchange: ex, label: label || EXCHANGES[ex]?.label, apiKey, apiSecret, passphrase, sandbox },
      });
      setApiKey(''); setApiSecret(''); setPassphrase(''); setLabel('');
      setModalMsg({ tone: 'ok', text: `Saved ${EXCHANGES[ex]?.label} watch account! Refreshing balances...` });
      if (onAccountsChanged) onAccountsChanged();
      loadPortfolio();
    } catch (e) { setModalMsg({ tone: 'error', text: e.message }); }
  };

  const testAccount = async (id) => {
    setModalMsg({ tone: 'info', text: `Testing ${id}...` });
    try {
      const r = await api(`/api/portfolio/accounts/${encodeURIComponent(id)}/test`, { method: 'POST' });
      setModalMsg({ tone: 'ok', text: `${r.label}: Connected! ${r.assetCount} asset(s), Total ${fmtUsd(r.totalUsd)}` });
    } catch (e) { setModalMsg({ tone: 'error', text: e.message }); }
  };

  const removeAccount = async (id) => {
    if (!window.confirm(`Remove watch account "${id}"?`)) return;
    await api(`/api/portfolio/accounts/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (onAccountsChanged) onAccountsChanged();
    loadPortfolio();
  };

  const filteredTx = (data?.transactions || [])
    .filter(t => txFilter === 'ALL' || t.type === txFilter)
    .filter(t => !search || `${t.symbol} ${t.account} ${t.exchange} ${t.side}`.toUpperCase().includes(search.toUpperCase()));

  return (
    <div>
      {/* Manage Watch-Only Exchange Accounts Modal */}
      {showAddModal && (
        <Modal
          title="EXCHANGE WATCH ACCOUNTS (HOLDINGS & TXNS)"
          subtitle="Use READ-ONLY exchange API keys (no trade/withdrawal permissions needed to watch balances & transactions)."
          onClose={() => setShowAddModal(false)}
          maxWidth={680}
        >
          {modalMsg && <Notice tone={modalMsg.tone}>{modalMsg.text}</Notice>}

          {watchAccounts.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div style={S.lbl}>Connected Live Accounts ({watchAccounts.length})</div>
              <div style={{ display: 'grid', gap: 6 }}>
                {watchAccounts.map(a => (
                  <div key={a.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#04070e', border: `1px solid ${C.border}`, borderRadius: 6, padding: '8px 12px', fontSize: 11 }}>
                    <div>
                      <b>{a.label}</b> <Badge color={EXCHANGES[a.exchange]?.color || C.blue}>{a.exchange}</Badge>{' '}
                      <span style={{ color: C.dim }}>{a.keyPreview}</span>
                    </div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button className="tbtn" onClick={() => testAccount(a.id)} style={S.btn(C.cyan)}>Test</button>
                      <button className="tbtn" onClick={() => removeAccount(a.id)} style={S.btn(C.red)}>Del</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div style={{ display: 'grid', gap: 10 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div>
                <label style={S.lbl}>Exchange</label>
                <select style={S.inp} value={ex} onChange={e => { setEx(e.target.value); setApiKey(''); setApiSecret(''); setPassphrase(''); }}>
                  {Object.entries(EXCHANGES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                </select>
              </div>
              <div>
                <label style={S.lbl}>Account Label</label>
                <input style={S.inp} placeholder={`My ${EXCHANGES[ex]?.label}`} value={label} onChange={e => setLabel(e.target.value)} />
              </div>
            </div>

            {ex === 'coinbase' && (
              <div style={{ background: '#0a1226', padding: 10, borderRadius: 6, border: `1px dashed ${C.blue}` }}>
                <label style={{ ...S.lbl, color: C.blue }}>Paste Coinbase CDP API JSON (auto-fills Key + EC Private Key)</label>
                <textarea style={{ ...S.inp, height: 60 }} placeholder='{"name": "organizations/.../apiKeys/...", "privateKey": "-----BEGIN EC PRIVATE KEY-----..."}'
                  onChange={e => {
                    try {
                      const j = JSON.parse(e.target.value);
                      if (j.name && j.privateKey) { setApiKey(j.name); setApiSecret(j.privateKey); setModalMsg({ tone: 'ok', text: 'Coinbase CDP JSON parsed!' }); }
                    } catch (_) {}
                  }} />
              </div>
            )}

            <div>
              <label style={S.lbl}>API Key (Read-Only Recommended)</label>
              <input style={S.inp} value={apiKey} onChange={e => setApiKey(e.target.value)} />
            </div>
            <div>
              <label style={S.lbl}>API Secret</label>
              <textarea style={{ ...S.inp, height: ex === 'coinbase' ? 80 : 38 }} value={apiSecret} onChange={e => setApiSecret(e.target.value)} />
            </div>
            {['kucoin', 'okx'].includes(ex) && (
              <div>
                <label style={S.lbl}>Passphrase</label>
                <input type="password" style={S.inp} value={passphrase} onChange={e => setPassphrase(e.target.value)} />
              </div>
            )}
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: C.muted }}>
              <input type="checkbox" checked={sandbox} onChange={e => setSandbox(e.target.checked)} /> Sandbox / Testnet Mode
            </label>
            <button className="tbtn" onClick={saveAccount} style={S.btn(C.green, true)}>💾 Add Watch Account</button>
          </div>
        </Modal>
      )}

      {/* Top Controls & Summary */}
      <div style={{ ...S.card, marginBottom: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginBottom: 14 }}>
          <div>
            <div style={S.sectionTitle}>Unified Account Holdings & Transactions</div>
            <div style={{ fontSize: 11, color: C.muted }}>
              Tracks live exchange balances, open orders, fills, deposits/withdrawals, plus Hummingbot & Paper Lab accounts — synced to your Android app.
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="tbtn" onClick={() => setShowAddModal(true)} style={S.btn(C.green, true)}>🔑 Manage Live Watch Accounts ({watchAccounts.length})</button>
            <button className="tbtn" disabled={loading} onClick={loadPortfolio} style={S.btn(C.blue)}>{loading ? '⟳ Syncing...' : '↻ Refresh'}</button>
          </div>
        </div>

        {data && (
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <MetricCard
              label={data.summary.liveUsd > 0 ? 'Live Portfolio Equity' : 'Paper Portfolio Equity'}
              value={fmtUsd(data.summary.totalUsd)}
              sub={`${data.summary.assetCount} asset(s) valued in live USD`}
              color={C.green}
            />
            <MetricCard label="Live Exchanges" value={fmtUsd(data.summary.liveUsd)} sub={`${data.summary.liveAccountCount} connected`} color={C.cyan} />
            <MetricCard label="Hummingbot Paper" value={fmtUsd(data.summary.paperHummingbotUsd)} sub={`Host: ${selectedHost}`} color={C.blue} />
            <MetricCard label="Paper Lab Equity" value={fmtUsd(data.summary.paperLabUsd)} sub="L2 Simulator" color={C.purple} />
            <MetricCard label="Open Orders" value={data.summary.openOrderCount} sub="Active on exchanges" color={C.yellow} />
            <MetricCard label="Recorded Txns" value={data.summary.txCount} sub="Fills, deposits & paper" color={C.text} />
          </div>
        )}
      </div>

      {err && <Notice tone="error">⚠ {err}</Notice>}

      {data && (
        <div style={{ display: 'grid', gap: 14 }}>
          {/* Per-Account Holdings Cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(330px, 1fr))', gap: 14 }}>
            {data.accounts.length === 0 ? (
              <div style={{ ...S.card, textAlign: 'center', color: C.muted, padding: 30 }}>
                No live or paper balances found yet. Click <b>🔑 Manage Live Watch Accounts</b> to connect Kraken/Coinbase (read-only), or start a Paper Lab / Hummingbot Paper session!
              </div>
            ) : data.accounts.map(acct => (
              <div key={acct.id} style={S.card}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontWeight: 700, fontSize: 13 }}>{acct.label}</span>
                    <Badge color={acct.source === 'live' ? C.green : acct.source === 'hb_paper' ? C.blue : C.purple}>
                      {acct.source === 'live' ? 'LIVE' : acct.source === 'hb_paper' ? 'HB PAPER' : 'PAPER LAB'}
                    </Badge>
                  </div>
                  <span style={{ fontFamily: "'Orbitron', sans-serif", fontWeight: 700, color: C.green }}>{fmtUsd(acct.totalUsd)}</span>
                </div>

                {acct.error ? (
                  <Notice tone="error">{acct.error}</Notice>
                ) : acct.holdings.length === 0 ? (
                  <div style={{ color: C.dim, fontSize: 11 }}>Zero non-dust balances</div>
                ) : (
                  <div style={{ display: 'grid', gap: 6, maxHeight: 240, overflowY: 'auto' }}>
                    {acct.holdings.map(h => (
                      <div key={h.asset} style={{ background: '#04070e', border: `1px solid ${C.border}`, borderRadius: 6, padding: '7px 10px', fontSize: 11 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                          <span style={{ fontWeight: 700 }}>{h.asset} <span style={{ color: C.dim, fontWeight: 400 }}>{h.total.toLocaleString(undefined, { maximumFractionDigits: 6 })}</span></span>
                          <span style={{ color: C.cyan, fontWeight: 600 }}>{fmtUsd(h.valueUsd)} <span style={{ color: C.dim }}>({h.pct.toFixed(1)}%)</span></span>
                        </div>
                        <div style={{ height: 4, background: '#111d30', borderRadius: 2, overflow: 'hidden' }}>
                          <div style={{ width: `${Math.min(100, h.pct)}%`, height: '100%', background: acct.source === 'live' ? C.green : C.blue }} />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Open Orders */}
          {data.openOrders.length > 0 && (
            <div style={S.card}>
              <div style={S.sectionTitle}>Live Open Orders ({data.openOrders.length})</div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                  <thead>
                    <tr style={{ background: '#04070e', color: C.muted, textAlign: 'left' }}>
                      {['Account', 'Pair', 'Side', 'Type', 'Price', 'Amount', 'Filled', 'Status'].map(h => (
                        <th key={h} style={{ padding: '7px 10px', borderBottom: `1px solid ${C.border}` }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.openOrders.map(o => (
                      <tr key={o.id} style={{ borderBottom: `1px solid #0b1424` }}>
                        <td style={{ padding: '6px 10px' }}>{o.account}</td>
                        <td style={{ padding: '6px 10px', fontWeight: 700 }}>{o.symbol}</td>
                        <td style={{ padding: '6px 10px', color: o.side === 'BUY' ? C.green : C.red }}>{o.side}</td>
                        <td style={{ padding: '6px 10px' }}>{o.type}</td>
                        <td style={{ padding: '6px 10px' }}>{fmtPrice(o.price)}</td>
                        <td style={{ padding: '6px 10px' }}>{o.amount}</td>
                        <td style={{ padding: '6px 10px' }}>{o.filled}</td>
                        <td style={{ padding: '6px 10px' }}><Badge color={C.yellow}>{o.status}</Badge></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Unified Transactions Feed */}
          <div style={S.card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginBottom: 12 }}>
              <div style={S.sectionTitle}>Transactions & Execution History ({filteredTx.length})</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                {['ALL', 'TRADE', 'PAPER_TRADE', 'DEPOSIT', 'WITHDRAWAL'].map(f => (
                  <button key={f} className="tbtn" onClick={() => setTxFilter(f)}
                    style={{ ...(txFilter === f ? S.btn(C.blue, true) : S.btnMuted), fontSize: 10, padding: '4px 8px' }}>{f}</button>
                ))}
                <input style={{ ...S.inp, width: 150 }} placeholder="Filter pair/acct..." value={search} onChange={e => setSearch(e.target.value)} />
              </div>
            </div>

            {filteredTx.length === 0 ? (
              <div style={{ padding: 26, textAlign: 'center', color: C.muted, border: `1px dashed ${C.border}`, borderRadius: 8 }}>
                No transactions match the current filter.
              </div>
            ) : (
              <div style={{ overflowX: 'auto', maxHeight: 380 }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                  <thead>
                    <tr style={{ background: '#04070e', color: C.muted, textAlign: 'left' }}>
                      {['Time', 'Account', 'Type', 'Pair / Asset', 'Side / Outcome', 'Price', 'Amount', 'Value', 'Fee / P&L'].map(h => (
                        <th key={h} style={{ padding: '7px 10px', borderBottom: `1px solid ${C.border}` }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredTx.map(t => (
                      <tr key={t.id} style={{ borderBottom: `1px solid #0b1424` }}>
                        <td style={{ padding: '6px 10px', color: C.muted }}>{new Date(t.ts).toLocaleString()}</td>
                        <td style={{ padding: '6px 10px' }}>{t.account}</td>
                        <td style={{ padding: '6px 10px' }}><Badge color={t.source === 'live' ? C.green : C.purple}>{t.type}</Badge></td>
                        <td style={{ padding: '6px 10px', fontWeight: 700 }}>{t.symbol}</td>
                        <td style={{ padding: '6px 10px', color: ['BUY', 'IN', 'FILLED'].includes(t.side) ? C.green : t.side === 'DECAYED' ? C.yellow : C.red }}>{t.side}</td>
                        <td style={{ padding: '6px 10px' }}>{t.price ? fmtPrice(t.price) : '—'}</td>
                        <td style={{ padding: '6px 10px' }}>{Number(t.amount || 0).toFixed(5)}</td>
                        <td style={{ padding: '6px 10px' }}>{fmtUsd(t.valueUsd)}</td>
                        <td style={{ padding: '6px 10px', color: t.pnlUsd != null ? (t.pnlUsd >= 0 ? C.green : C.red) : C.yellow }}>
                          {t.pnlUsd != null ? `${t.pnlUsd >= 0 ? '+' : ''}${fmtUsd(t.pnlUsd)}` : fmtUsd(t.feeUsd, 3)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
