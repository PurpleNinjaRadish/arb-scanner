# ─── ARB SCANNER v3 LAUNCHER ──────────────────────────────────────────────────
# Usage:
#   .\launch.ps1             -> Dev mode (API on :3001 + React hot-reload on :3000)
#   .\launch.ps1 -Prod       -> Fast single-process mode (serves built UI + API on :3001)
#   .\launch.ps1 -Prod -Lan  -> Also bind 0.0.0.0 so your Android phone on Wi-Fi/Tailscale can connect!
param(
    [switch]$Prod,
    [switch]$Lan
)

$ROOT = $PSScriptRoot
$SERVER = Join-Path $ROOT "server"

Write-Host ""
Write-Host "  ARB SCANNER v3 — Hummingbot Control Suite" -ForegroundColor Cyan
Write-Host "  Root: $ROOT" -ForegroundColor DarkGray
Write-Host ""

function Stop-ProcessTree([int]$ParentPid) {
    if (-not $ParentPid) { return }
    try {
        Get-CimInstance Win32_Process -Filter "ParentProcessId=$ParentPid" -ErrorAction SilentlyContinue |
            ForEach-Object { Stop-ProcessTree $_.ProcessId }
        Stop-Process -Id $ParentPid -Force -ErrorAction SilentlyContinue
    } catch { }
}

# Only clear ports owned by previous Arb Scanner runs
$portsToClear = if ($Prod) { @(3001) } else { @(3000, 3001) }
foreach ($port in $portsToClear) {
    $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    foreach ($c in $conns) {
        if ($c.OwningProcess -gt 4) {
            Stop-ProcessTree $c.OwningProcess
            Write-Host "  [OK] Cleared listener on port $port (PID $($c.OwningProcess))" -ForegroundColor Yellow
        }
    }
}

Start-Sleep -Milliseconds 500

if ($Prod -and -not (Test-Path (Join-Path $ROOT "build\index.html"))) {
    Write-Host "  [>>] Building production UI bundle..." -ForegroundColor Cyan
    Push-Location $ROOT
    npm run build
    Pop-Location
}

if ($Lan) {
    $env:BIND_HOST = "0.0.0.0"
    Write-Host "  [>>] Starting backend API (LAN/Android enabled on http://0.0.0.0:3001)..." -ForegroundColor Green
} else {
    $env:BIND_HOST = "127.0.0.1"
    Write-Host "  [>>] Starting backend API (http://127.0.0.1:3001)..." -ForegroundColor Green
}
$backend = Start-Process -FilePath "node" -ArgumentList "index.js" `
    -WorkingDirectory $SERVER -PassThru -WindowStyle Hidden

$ready = $false
for ($i = 0; $i -lt 15; $i++) {
    Start-Sleep -Milliseconds 700
    try {
        $null = Invoke-WebRequest -Uri "http://127.0.0.1:3001/api/health" -TimeoutSec 2 -ErrorAction Stop
        $ready = $true
        break
    } catch { }
}
if ($ready) {
    Write-Host "  [OK] Backend healthy at http://127.0.0.1:3001" -ForegroundColor Green
} else {
    Write-Host "  [!!] Backend did not respond within timeout. Check server logs." -ForegroundColor Red
}

$frontend = $null
$url = "http://127.0.0.1:3001"

if (-not $Prod) {
    Write-Host "  [>>] Starting React dev server (http://localhost:3000)..." -ForegroundColor Green
    $env:BROWSER = "none"
    $frontend = Start-Process -FilePath "cmd.exe" -ArgumentList "/c npm start" `
        -WorkingDirectory $ROOT -PassThru -WindowStyle Hidden
    $url = "http://localhost:3000"

    for ($i = 0; $i -lt 45; $i++) {
        Start-Sleep -Seconds 1
        try {
            $null = Invoke-WebRequest -Uri $url -TimeoutSec 2 -ErrorAction Stop
            Write-Host "  [OK] Frontend ready at $url" -ForegroundColor Green
            break
        } catch { }
    }
}

Write-Host "  [>>] Opening $url ..." -ForegroundColor Cyan
Start-Process $url

Write-Host ""
Write-Host "  ARB SCANNER v3 running! Press ENTER to stop cleanly." -ForegroundColor Yellow
$null = Read-Host

Write-Host "  [>>] Stopping Arb Scanner processes only..." -ForegroundColor Red
if ($frontend) { Stop-ProcessTree $frontend.Id }
if ($backend)  { Stop-ProcessTree $backend.Id }
Write-Host "  [OK] Stopped cleanly." -ForegroundColor Green
