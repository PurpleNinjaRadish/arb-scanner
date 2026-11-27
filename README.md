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

## AI Reviewer (🧠 — Cross-Check tab settings; "AI Check" on alerts, Cross-Check and Deploy)
For a target the safety checks blocked, the AI reviewer collects the evidence and asks Claude (Anthropic API) or an OpenAI / OpenAI-compatible model (LM Studio, Ollama) whether it's real and tradeable. The evidence is live prices on every exchange, both order books, each exchange's deposit/withdrawal status, status-page incidents, the ticker audit and scanner history.

What an approval can and can't do is decided in code, not by the model:
- **It can override the judgement checks:** a price far from the other exchanges, an implausibly wide gap, scanner/book drift, missing history, and the monthly projection (treated as a one-off).
- **It can never override:** a per-trade loss on live books, missing/crossed/thin order books, a known different coin sharing the ticker, or the live guard rails.
- **It's re-checked at launch** against fresh prices, expires after 10 minutes, and caps the order size ($250, or lower if the AI recommends it).
- **Paper-only by default.** Allowing live needs the typed phrase `AI CAN APPROVE LIVE`. Manual live launches still need the pair's `LIVE` phrase.
- **With Auto-Trade on**, a blocked target is sent to the AI automatically. An approval launches with the AI order cap and a 30-minute run time.

Set the provider, model (default `claude-sonnet-5-5`) and API key in Cross-Check → AI Reviewer, or use the `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` env var.

## Hummingbot Latency Test (☁ Servers → ⏱ Latency Test)
Measures exchange latency from each host where bots run (your PC and each remote server) and compares them. On each host it starts a temporary container from your Hummingbot image, so the numbers include Docker networking exactly as a bot sees it. If the image isn't on a host, it falls back to curl over SSH, or to the backend on a Windows PC. Per exchange it measures DNS, network round trip, TLS handshake, a cold request, and repeated requests on a kept-alive connection (median, p90, jitter). Per trading pair it shows the time for one arbitrage round (both orders go out together, so a round takes as long as the slower exchange), which host is fastest and by how many ms, and which exchanges are region-blocked from each host. Results are kept for comparison over time.

## Ticker Audit (🔤 Ticker Audit tab)
Exchanges don't always agree on tickers. The same coin can have different tickers (Kraken `XBT` = `BTC`; OKX/KuCoin `LIT` = Lighter = `LIGHTER` on Kraken/Coinbase), and different coins can share one (Kraken `ONE` is not Harmony `ONE`). The scanner maps every listing to one canonical ticker (`server/lib/tickers.js`), then audits all USD/USDC/USDT markets on every reachable exchange every 30 minutes. Any listing more than 20% off the other exchanges' median price is excluded from the scanner, alerts and bot launches. Hummingbot strategies get each exchange's own market name automatically. The tab lists every coin per exchange, shows what was flagged and why, and exports CSV.

## RPC Management (⛓ RPC tab)
Keeps blockchain RPC endpoints per network (Ethereum, Arbitrum, Base, Optimism, Polygon, BNB, Avalanche, Celo, Unichain, Sepolia, Solana, Solana devnet) and pushes them into **Hummingbot Gateway**, the part of Hummingbot that DEX connectors (Uniswap, Jupiter, Raydium…) use. CEX bots don't use RPC.
- **Test** checks each endpoint is the right chain (chain id / Solana genesis), times it, and flags any that are more than 5 blocks (50 slots) behind the best one. Your endpoints are compared with your provider key's URL and Gateway's public default. **Use fastest** makes the quickest healthy one active.
- **Providers**: Infura / Helius / Chainstack keys, and which one each chain uses (`rpcProvider`). A provider replaces the per-network URL for the whole chain.
- **Push to Gateway** finds the Gateway container on the chosen host, writes `nodeURL`, `rpcProvider` and `apiKeys` through Gateway's `/config/update` API (or edits `conf/*.yml` directly, comments kept, if the API isn't reachable), restarts the container, and reads `/chains/<chain>/status` to confirm each network answers through the new RPC. An endpoint that fails its test is never pushed unless you tick *Push even if a test fails*. **Import from Gateway** copies Gateway's current URLs into the list first.
- URLs with API keys are masked everywhere in the UI and push history.

## Remote Access (🌐 Remote Access tab)
Use the web app or Android app from anywhere, without opening router ports.
- A second listener (`127.0.0.1:3002`) handles remote traffic. **Every** API request on it needs a signed-in device token — being "from localhost" means nothing there, because the tunnel runs locally. The old static LAN API token is not accepted through it, and `/api/mobile/*` (pairing secrets) is never served remotely.
- Sign in with a **password** (scrypt-hashed, 10+ chars) plus an optional **authenticator code** (TOTP — Google/Microsoft Authenticator, 1Password), or with a **one-time link code** made on the PC (8 characters, 10 minutes, single use, *full control* or *view only*). The code's QR opens the Android app directly (`arbscanner://link`); a second QR opens the web sign-in with the code filled in.
- Device tokens are stored only as hashes, expire after 30 idle days (configurable), and can be signed out one by one or all at once. 5 wrong attempts lock an address for 15 min; 25 from anywhere pause all sign-ins for 15 min. Everything is in the security log.
- Tunnels: **Tailscale** (`tailscale serve`, private to your own devices — most like remote desktop), **Cloudflare quick tunnel** (instant random `https://….trycloudflare.com`, no account), or **Cloudflare named tunnel** (your own domain; token from Zero Trust → Tunnels, public hostname → `http://localhost:3002`). The app starts, watches and restarts the tunnel itself. Install once: `winget install --id Tailscale.Tailscale` or `winget install --id Cloudflare.cloudflared`.
- Docker: the compose file publishes 3002 on loopback, and `TUNNEL_TOKEN=… docker compose --profile tunnel up -d` runs cloudflared next to the app (point the hostname at `http://arb-scanner:3002`).

## Tests
```bash
npm run test:server
npm test -- --watchAll=false
npm run build
```
