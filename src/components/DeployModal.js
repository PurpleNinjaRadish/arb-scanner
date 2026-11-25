// ─── Streamlined Hummingbot Strategy Deploy Modal ─────────────────────────────
import { useState, useEffect, useCallback } from 'react';
import { api } from '../api';
import { EXCHANGES, fmtUsd, fmtPrice } from '../constants';
import { C, S, Modal, Badge, Notice, CopyBtn } from '../ui';
import CrossCheckReport, { OverrideConfirm, overrideReady } from './CrossCheckReport';

export default function DeployModal({ target, pair, quote = 'USD', hosts = [], defaultHost = 'local', vpnStatus, onClose, onDeployed }) {
  const [strategy, setStrategy] = useState('amm_arb'); // 'amm_arb' | 'cross_exchange_market_making'
  const [hostId, setHostId] = useState(defaultHost || 'local');
  const [paperTrade, setPaperTrade] = useState(true);
  const [launchMode, setLaunchMode] = useState('detached'); // 'detached' | 'interactive'
  const [tradeSizeUsd, setTradeSizeUsd] = useState(target.tradeSize || 500);
  const [minProfitPct, setMinProfitPct] = useState(() =>
    Number(Math.max(target.netProfit > 0 ? target.netProfit * 0.75 : 0.35, 0.1).toFixed(3))
  );
  const [slippageBufferPct, setSlippageBufferPct] = useState(0.15);
  const [memLimit, setMemLimit] = useState('768m');
  const [cpuLimit, setCpuLimit] = useState('1.0');
  const [configName, setConfigName] = useState(
    `arb_${target.symbol.toLowerCase()}_${quote.toLowerCase()}_${Date.now().toString().slice(-5)}`
  );
  const [yamlText, setYamlText] = useState('');
  const [yamlEdited, setYamlEdited] = useState(false);
  const [warnings, setWarnings] = useState([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [check, setCheck] = useState(null);
  const [checking, setChecking] = useState(false);
  const [checkErr, setCheckErr] = useState('');
  const [guardCfg, setGuardCfg] = useState(null);
  const [confirmed, setConfirmed] = useState(false);
  const [typed, setTyped] = useState('');
  const [violations, setViolations] = useState([]);

  const refPrice = target.buyPrice || target.priceA || 1;
  const baseAmt = refPrice > 0 ? (tradeSizeUsd / refPrice) : 0;

  const isRemote = hostId !== 'local';
  const vpnBlocked = isRemote && vpnStatus && vpnStatus.connected === false;

  const refreshYaml = useCallback(async () => {
    try {
      const res = await api('/api/strategy/preview', {
        method: 'POST',
        body: {
          strategy,
          symbol: target.symbol,
          quote,
          exA: pair.a,
          exB: pair.b,
          makerEx: target.buyOn,
          takerEx: target.sellOn,
          tradeSizeUsd,
          refPrice,
          minProfitabilityPct: minProfitPct,
          slippageBufferPct,
          paperTrade,
          netProfitPreview: target.netProfit,
        },
      });
      setYamlText(res.yaml || '');
      setWarnings((res.parsed && res.parsed.warnings) || []);
      setYamlEdited(false);
    } catch (e) {
      setError(e.message);
    }
  }, [strategy, target.symbol, target.buyOn, target.sellOn, target.netProfit, quote, pair.a, pair.b, tradeSizeUsd, refPrice, minProfitPct, slippageBufferPct, paperTrade]);

  useEffect(() => { refreshYaml(); }, [refreshYaml]);

  // Guard-rail settings (live limits)
  useEffect(() => {
    api('/api/guard').then(d => setGuardCfg(d.settings)).catch(() => {});
  }, []);

  // Automatic price cross-check whenever the launch parameters change
  const runCheck = useCallback(async () => {
    setChecking(true); setCheckErr('');
    try {
      const d = await api('/api/crosscheck', {
        method: 'POST',
        body: {
          symbol: target.symbol, quote, exA: pair.a, exB: pair.b, strategy,
          tradeSize: tradeSizeUsd, target: hostId,
          minProfitabilityPct: minProfitPct, scannerNetPct: target.netProfit,
        },
      });
      setCheck(d);
    } catch (e) {
      setCheckErr(e.message);
      setCheck(null);
    } finally {
      setChecking(false);
    }
  }, [target.symbol, target.netProfit, quote, pair.a, pair.b, strategy, tradeSizeUsd, hostId, minProfitPct]);

  useEffect(() => {
    const t = setTimeout(runCheck, 700);
    return () => clearTimeout(t);
  }, [runCheck]);

  useEffect(() => { setConfirmed(false); setTyped(''); }, [paperTrade, target.symbol, hostId]);

  const phrase = `${target.symbol}-${quote} LIVE`;
  const needsOverride = !(check && check.allowed);
  const overrideOk = overrideReady({ live: !paperTrade, phrase, confirmed, typed });
  const liveRailIssues = (!paperTrade && guardCfg) ? [
    tradeSizeUsd > guardCfg.liveMaxOrderUsd ? `Order size ${fmtUsd(tradeSizeUsd, 0)} is above the live max of ${fmtUsd(guardCfg.liveMaxOrderUsd, 0)}` : null,
    minProfitPct < guardCfg.liveMinProfitabilityPct ? `Min profitability ${minProfitPct}% is below the live floor of ${guardCfg.liveMinProfitabilityPct}%` : null,
  ].filter(Boolean) : [];
  const launchBlocked = liveRailIssues.length > 0 || checking || (needsOverride && !overrideOk);

  const submit = async (autoStart) => {
    setBusy(true); setError(''); setResult(null); setViolations([]);
    try {
      const res = await api('/api/deploy', {
        method: 'POST',
        body: {
          target: hostId,
          configName,
          yaml: yamlText,
          launchMode,
          autoStart,
          memLimit,
          cpuLimit,
          override: autoStart && needsOverride ? { confirmed, phrase: typed } : undefined,
        },
      });
      setResult(res);
      if (res.guard && res.guard.check) setCheck(res.guard.check);
      if (onDeployed) onDeployed(res);
    } catch (e) {
      setError(e.message);
      if (e.data && e.data.check) setCheck(e.data.check);
      if (e.data && e.data.guardViolations && e.data.guardViolations.length) setViolations(e.data.guardViolations);
      if (e.status === 409) { setConfirmed(false); }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="DEPLOY HUMMINGBOT STRATEGY"
      subtitle={`${target.symbol}-${quote} · ${EXCHANGES[pair.a]?.label} ↔ ${EXCHANGES[pair.b]?.label} · Snapshot Net ${target.netProfit >= 0 ? '+' : ''}${target.netProfit.toFixed(3)}%`}
      onClose={onClose}
      maxWidth={780}
    >
      {/* Strategy & Host row */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
        <div>
          <label style={S.lbl}>Strategy Type</label>
          <select style={S.inp} value={strategy} onChange={e => setStrategy(e.target.value)}>
            <option value="amm_arb">Cross-Exchange Arbitrage (amm_arb · Taker+Taker)</option>
            <option value="cross_exchange_market_making">Cross-Exchange Market Making (XEMM · Maker+Taker)</option>
          </select>
        </div>
        <div>
          <label style={S.lbl}>Target Host</label>
          <select style={S.inp} value={hostId} onChange={e => setHostId(e.target.value)}>
            {(hosts.length ? hosts : [{ id: 'local', name: 'Local' }]).map(h => (
              <option key={h.id} value={h.id}>{h.name} ({h.kind}){h.monthlyCost ? ` — $${h.monthlyCost}/mo` : ''}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Paper vs Live banner */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12,
        padding: '10px 14px', borderRadius: 8, marginBottom: 14,
        background: paperTrade ? '#001c10' : '#24060c',
        border: `1px solid ${paperTrade ? C.green : C.red}66`,
      }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontSize: 12, color: paperTrade ? C.green : C.red, fontWeight: 600 }}>
          <input type="checkbox" checked={paperTrade} onChange={e => setPaperTrade(e.target.checked)} style={{ width: 16, height: 16 }} />
          {paperTrade
            ? '🟢 PAPER TRADE MODE (Safe — auto-enables paper connectors in conf_client.yml)'
            : '⚠ LIVE TRADING MODE (Real exchange funds & API keys required)'}
        </label>
        <Badge color={paperTrade ? C.green : C.red}>{paperTrade ? 'SIMULATED' : 'REAL FUNDS'}</Badge>
      </div>

      {/* Numeric params */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 14 }}>
        <div>
          <label style={S.lbl}>Order Size ({quote})</label>
          <input type="number" style={S.inp} min="10" step="50" value={tradeSizeUsd}
            onChange={e => setTradeSizeUsd(Math.max(10, parseFloat(e.target.value) || 10))} />
          <div style={{ fontSize: 10, color: C.cyan, marginTop: 4 }}>
            ≈ {baseAmt.toFixed(baseAmt >= 10 ? 3 : 5)} {target.symbol} @ {fmtPrice(refPrice)}
          </div>
        </div>
        <div>
          <label style={S.lbl}>Min Profitability (%)</label>
          <input type="number" style={S.inp} step="0.05" value={minProfitPct}
            onChange={e => setMinProfitPct(parseFloat(e.target.value) || 0)} />
          <div style={{ fontSize: 10, color: C.dim, marginTop: 4 }}>
            Fees: {target.feePct.toFixed(2)}% (Hummingbot % pts)
          </div>
        </div>
        <div>
          <label style={S.lbl}>Slippage Buffer (%)</label>
          <input type="number" style={S.inp} step="0.05" min="0" value={slippageBufferPct}
            onChange={e => setSlippageBufferPct(Math.max(0, parseFloat(e.target.value) || 0))} />
        </div>
        <div>
          <label style={S.lbl}>Launch Mode</label>
          <select style={S.inp} value={launchMode} onChange={e => setLaunchMode(e.target.value)}>
            <option value="detached">Detached (24/7 Headless)</option>
            <option value="interactive">Interactive Terminal</option>
          </select>
        </div>
      </div>

      {/* Container naming & resource caps */}
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 10, marginBottom: 14 }}>
        <div>
          <label style={S.lbl}>Strategy / Container Name</label>
          <input style={S.inp} value={configName} onChange={e => setConfigName(e.target.value.replace(/[^a-zA-Z0-9_.-]/g, ''))} />
        </div>
        <div>
          <label style={S.lbl}>RAM Limit</label>
          <select style={S.inp} value={memLimit} onChange={e => setMemLimit(e.target.value)}>
            <option value="512m">512 MB (Tight)</option>
            <option value="768m">768 MB (Recommended)</option>
            <option value="1024m">1024 MB (Generous)</option>
            <option value="">Unlimited</option>
          </select>
        </div>
        <div>
          <label style={S.lbl}>CPU Limit</label>
          <select style={S.inp} value={cpuLimit} onChange={e => setCpuLimit(e.target.value)}>
            <option value="0.5">0.5 vCPU</option>
            <option value="1.0">1.0 vCPU (Recommended)</option>
            <option value="2.0">2.0 vCPU</option>
            <option value="">Unlimited</option>
          </select>
        </div>
      </div>

      {/* Strategy explanation */}
      <div style={{ fontSize: 11, color: C.muted, background: C.panel, border: `1px solid ${C.border}`, borderRadius: 6, padding: '8px 12px', marginBottom: 12 }}>
        {strategy === 'amm_arb'
          ? `amm_arb monitors both ${EXCHANGES[pair.a]?.label} & ${EXCHANGES[pair.b]?.label} and fires simultaneous taker/limit legs whenever net spread ≥ ${minProfitPct}%. Order size is converted to base units (${baseAmt.toFixed(4)} ${target.symbol}) automatically.`
          : `XEMM posts a maker limit order on ${EXCHANGES[target.buyOn]?.label} (lower maker fee!) and immediately hedges fills on ${EXCHANGES[target.sellOn]?.label}. Ideal for Kraken × Coinbase because maker fees cut break-even spread in half.`}
      </div>

      {/* Pre-launch price cross-check */}
      <div style={{ ...S.card, padding: 12, marginBottom: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <span style={S.lbl}>Pre-launch price cross-check {checking ? '(checking…)' : ''}</span>
          <button className="tbtn" disabled={checking} onClick={runCheck} style={{ ...S.btnMuted, padding: '4px 10px', fontSize: 10 }}>Re-check</button>
        </div>
        {checkErr && <Notice tone="error">Cross-check failed: {checkErr}</Notice>}
        {check ? <CrossCheckReport check={check} compact /> : !checkErr && <div style={{ fontSize: 11, color: C.muted }}>Fetching live order books…</div>}
      </div>

      {!paperTrade && guardCfg && (
        <Notice tone={liveRailIssues.length ? 'error' : 'info'}>
          {`Live guard rails: kill-switch stop-loss at −${guardCfg.liveStopLossPct}% return · bot stopped at −${fmtUsd(guardCfg.liveMaxLossUsd, 0)} realized loss · max order ${fmtUsd(guardCfg.liveMaxOrderUsd, 0)} · min profitability ${guardCfg.liveMinProfitabilityPct}%`}
          {liveRailIssues.length ? `\n✗ ${liveRailIssues.join('\n✗ ')}` : ''}
        </Notice>
      )}
      {violations.length > 0 && <Notice tone="error">{`Blocked by live guard rails:\n✗ ${violations.join('\n✗ ')}`}</Notice>}

      {needsOverride && check && !checking && (
        <OverrideConfirm live={!paperTrade} phrase={phrase} confirmed={confirmed} setConfirmed={setConfirmed} typed={typed} setTyped={setTyped} />
      )}

      {warnings.length > 0 && <Notice tone="warn">{warnings.join('\n')}</Notice>}
      {vpnBlocked && (
        <Notice tone="error">
          Dedicated VPN IP mismatch: current IP {vpnStatus.currentIp} ≠ saved IP {vpnStatus.expectedIp}. Connect VPN or update VPN IP in Servers & Settings.
        </Notice>
      )}

      {/* Editable YAML preview */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <span style={S.lbl}>Generated Hummingbot YAML {yamlEdited ? '(Custom Edited)' : ''}</span>
        <div style={{ display: 'flex', gap: 6 }}>
          {yamlEdited && <button className="tbtn" onClick={refreshYaml} style={S.btnMuted}>Reset YAML</button>}
          <CopyBtn text={yamlText} label="Copy YAML" />
        </div>
      </div>
      <textarea
        value={yamlText}
        onChange={e => { setYamlText(e.target.value); setYamlEdited(true); }}
        style={{ ...S.codeBox, width: '100%', height: 200, resize: 'vertical', marginBottom: 14, color: '#c8e0ff' }}
      />

      {error && <Notice tone="error">✗ {error}</Notice>}
      {result && (
        <Notice tone="ok">
          ✓ {result.message || `Saved ${result.configName}.yml`}
          {result.containerId && result.containerId !== 'interactive' ? `\nContainer ID: ${result.containerId.slice(0, 12)} (${result.containerName})` : ''}
          {result.paperSetup?.changed ? '\nAuto-configured conf/conf_client.yml with paper exchanges & starter balances.' : ''}
          {result.guard?.overridden ? '\nLaunched with manual override (logged).' : ''}
          {result.guard?.killSwitch ? `\nStop-loss: kill switch at ${result.guard.killSwitch.killSwitchRate}% return${result.guard.killSwitch.keptExisting ? ' (kept your tighter setting)' : ''}.` : ''}
          {result.guard?.monitored ? '\nLive stop-loss monitor is watching this bot.' : ''}
          {result.command && !result.opened ? `\nRun in terminal:\n${result.command}` : ''}
        </Notice>
      )}

      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
        <button className="tbtn" onClick={onClose} style={S.btnMuted}>Close</button>
        <button className="tbtn" disabled={busy || vpnBlocked} onClick={() => submit(false)} style={S.btn(C.yellow)}>
          💾 Save YAML Only
        </button>
        <button className="tbtn" disabled={busy || vpnBlocked || launchBlocked} onClick={() => submit(true)} style={S.btn(paperTrade ? C.green : C.red, true)}
          title={launchBlocked ? 'Needs a passing cross-check or manual confirmation' : ''}>
          {busy ? 'Deploying...' : `🚀 ${needsOverride ? 'Override & ' : ''}Deploy ${paperTrade ? 'Paper' : 'LIVE'} Bot (${fmtUsd(tradeSizeUsd, 0)})`}
        </button>
      </div>
    </Modal>
  );
}
