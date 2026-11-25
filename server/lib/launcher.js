// ─── Gated bot launch (shared by Deploy, Save & Restart and the auto-trader) ──
// Every bot start goes through the price cross-check + profitability gate.
// Live bots also get the kill-switch stop-loss before the container starts and
// are registered with the stop-loss monitor; auto-launched bots are registered
// too, so they can be stopped at their max runtime.
const hb = require('./hummingbot');
const guard = require('./guard');

async function guardedLaunch(target, { configName, yaml, override, auto = null }, launch) {
  const gate = await guard.gateDeploy(target, { configName, yaml, override, auto: !!auto });
  let killSwitch = null;
  if (gate.info.live) {
    // Stop-loss must be in conf_client.yml before the container reads it at startup
    killSwitch = await hb.ensureKillSwitch(target, guard.guardSettings().liveStopLossPct);
  }
  const result = await launch();
  let monitored = null;
  if ((gate.info.live || auto) && result && result.containerName && result.containerId !== 'interactive') {
    monitored = await guard.monitor.register({
      target, containerName: result.containerName, configName, info: gate.info,
      auto: !!auto, maxRuntimeMin: auto ? auto.maxRuntimeMin : null,
    }).catch(() => null);
  }
  return {
    ...result,
    guard: {
      allowed: gate.check ? gate.check.allowed : false,
      overridden: gate.overridden,
      live: gate.info.live,
      killSwitch,
      monitored: !!monitored,
      check: gate.check,
    },
  };
}

module.exports = { guardedLaunch };
