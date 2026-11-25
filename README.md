# Arb Scanner v3 — Arbitrage Scanner & Hummingbot Control Suite

Unified real-time cross-exchange arbitrage scanner, complete Hummingbot Docker control plane (local & remote SSH servers), live L2 order-book paper trading & accuracy lab, profitability projections, and remote VPS sizing advisor.

## Quick Start

### Option 1 — One-Click Windows Launcher
```powershell
# Dev mode (API on :3001 + React dev server on :3000)
.\launch.ps1

# Fast single-process production mode (serves built UI + API on http://127.0.0.1:3001)
.\launch.ps1 -Prod

# Enable LAN / Android remote phone control (binds 0.0.0.0 — generate an API Token in Alerts & Mobile first!)
.\launch.ps1 -Prod -Lan
```

### Android Companion App (Remote Control, Push Notifications, Holdings & Transactions)
The native Kotlin / Jetpack Compose Android app lives in `android-app/`:
- **Instant option (Zero Build — PWA + ntfy Push)**:
  1. Launch with `.\launch.ps1 -Prod -Lan` and generate an API Token in **🔔 Alerts & Mobile**.
  2. Open `http://<your-PC-LAN-IP>:3001` in Chrome on Android → **Add to Home Screen**.
  3. Generate a secret `ntfy.sh` topic in **🔔 Alerts & Mobile** and subscribe in the free **ntfy** Android app for instant phone push notifications.
- **Option 1 — Build APK in the Cloud with GitHub Actions (Zero Local SDK Setup)**:
  1. Push this repo to GitHub (make sure it's a **private** repo if you customize anything; `server/config.json` and `*.pem` are already gitignored).
  2. GitHub Actions automatically runs `.github/workflows/build-android-apk.yml` (or click **Actions → Build Android APK → Run workflow**).
  3. Open **Releases → android-latest** on your Android phone browser and tap **`arb-scanner-v3-debug.apk`** to download & install directly!
- **Option 2 — Local Android Studio / CLI Build (`android-app/`)**:
  1. Open `android-app/` in Android Studio (or run `.\android-app\build-apk.ps1 -Install` with Android SDK + JDK 17).
  2. In the app's **⚙ Connect** tab, paste the 1-tap **Pairing JSON** from desktop **🔔 Alerts & Mobile**.
  3. Enable **Real-Time Live SSE Listener** (sub-second heads-up Android push notifications with zero Firebase setup) and **Background Periodic Check**.

### Option 2 — Manual Local Run
```bash
npm run build
npm run server
# Open http://127.0.0.1:3001
```

### Option 3 — Docker Compose (Local or Remote Linux VPS)
```bash
docker compose up -d --build
# Access securely from your laptop via SSH tunnel:
ssh -L 3001:127.0.0.1:3001 user@your-vps-ip
# Then open http://127.0.0.1:3001
```

## Five Workspaces
1. **Live Scanner**: Executable Ask/Bid scanning (`USD` / `USDT` / `USDC`), Kraken × Coinbase priority, bulk fetching with top-of-book refinement, 24h liquidity, Taker+Taker vs XEMM Maker+Taker fees, and instant L2 order-book fill tests (`🧪 Fill`).
2. **Hummingbot Hub**: Full management across Local (Docker Desktop or WSL2) and any number of Remote SSH servers:
   - Container lifecycle (`Start / Stop / Restart / Pause / Resume / Remove / Stop All`) + live CPU/RAM stats + clean strategy log files + CLI `attach`.
   - Strategy YAML library (`conf/strategies/*.yml`) with validation, base-asset unit conversion, and 1-click launch.
   - Paper Trade Config (`conf/conf_client.yml`) — auto-enables `coinbase_advanced_trade` + `kraken` paper connectors, starting balances, and kill-switch.
   - Exchange connectors (interactive `connect` terminal or Coinbase CDP JSON paste) and parsed `data/*_trades.csv` realized P&L dashboard.
3. **Paper & Accuracy Lab**: Zero-setup paper trading simulator that waits your configured execution latency, walks live L2 order books on both exchanges, and measures Signal Survival %, Slippage Drift (bps), Processing Time (ms), Profit Capture %, and Equity Curve.
4. **Profit Projections**: 3-scenario (Conservative / Base / Optimistic) daily/monthly/annual projections after fees, slippage, rebalancing, and VPS cost, plus a Fee Tier Sensitivity Matrix and auto-fill from observed scanner/paper results.
5. **Servers & Sizing**: Interactive VPS capacity sizer (`~450 MB RAM + 0.25 vCPU` per bot + `750 MB` base), region recommendations (`us-east-1` / Ashburn VA for Kraken × Coinbase), live exchange RTT latency benchmarks from local or remote hosts, and 1-click SSH server bootstrapping (Docker, log rotation, swap, NTP, Hummingbot image).

## Pre-Launch Price Cross-Check & Live Guard Rails (🛡 Cross-Check tab)
Every bot launch (web Deploy dialog, Hummingbot "Save & Restart", Android quick deploy) runs a price cross-check first. Run it manually from the 🛡 Cross-Check tab, or turn on auto re-check.

- **Price cross-reference**: the scanner's prices are checked against fresh order books on both exchanges and against the median price on the other supported exchanges. Stale feeds, crossed or thin books, and two different tokens sharing a ticker fail the check.
- **Two profitability calculations; both must pass**:
  1. *Per trade*: order-book fill prices for the full order size, minus both legs' trading fees and a slippage buffer.
  2. *Monthly*: trades per month (from scanner history, or an assumption until there is 1h of history) × net per trade, minus rebalancing transfers and server cost. Server cost is the host's monthly cost if you entered one; otherwise it's the **estimated average server cost** from Server Suggestions (average of the top 3 suggested servers that fit your bot count).
- **Blocked bots need manual confirmation**: tick the confirmation box; live bots also require typing `COIN-QUOTE LIVE`. Every decision and override is logged. Phone deploys can't override; confirm on the desktop.
- **Live guard rails** (can't be overridden; change them in settings): max order size, minimum profitability floor, Hummingbot kill-switch stop-loss written to `conf_client.yml` (2.x `kill_switch_mode` format), and a backend monitor that stops a live bot and pushes an alert when its realized loss reaches the $ limit. The monitor uses realized (matched buy/sell) P&L; the kill switch covers overall return, including inventory.

## Auto-Trade (🤖 panel at the top of the Scanner tab)
When the Target Watcher finds a target, the auto-trader launches a bot for it, but only if it passes **every** check with no manual override: ticker audit, price cross-check, per-trade and monthly profitability, and the live guard rails in live mode. Failed targets are skipped and logged with the reason.

- **Paper by default.** Switching to live (real funds) means typing `LIVE AUTO-TRADE`. It's refused while the API is open to your network without an API token, and a live launch is skipped if Hummingbot has no API keys for either exchange.
- **Its own limits:** max order size, bot min profitability, max bots at once, max launches per 24 h, same-coin cooldown, and a max run time after which each auto bot is stopped.
- Turning auto-trade on also turns on the Target Watcher (pair, quote and thresholds are set in 🔔 Alerts). Each launch sends a push notification.

## Ticker Audit (🔤 Ticker Audit tab)
Exchanges don't always agree on tickers. The same coin can have different tickers (Kraken `XBT` = `BTC`; OKX/KuCoin `LIT` = Lighter = `LIGHTER` on Kraken/Coinbase), and different coins can share one (Kraken `ONE` is not Harmony `ONE`). The scanner maps every listing to one canonical ticker (`server/lib/tickers.js`), then audits all USD/USDC/USDT markets on every reachable exchange every 30 minutes. Any listing more than 20% off the other exchanges' median price is excluded from the scanner, alerts and bot launches. Hummingbot strategies get each exchange's own market name automatically. The tab lists every coin per exchange, shows what was flagged and why, and exports CSV.

## Tests
```bash
npm run test:server
npm test -- --watchAll=false
npm run build
```
