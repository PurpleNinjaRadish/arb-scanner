# ─── Build & Optional USB Install Script for Arb Scanner v3 Android APK ──────
# Usage:
#   .\build-apk.ps1           -> Builds app-debug.apk
#   .\build-apk.ps1 -Install  -> Builds and installs to USB-connected Android phone / emulator
param(
    [switch]$Install
)

$ErrorActionPreference = "Stop"
$APP_DIR = $PSScriptRoot

Write-Host ""
Write-Host "  ARB SCANNER v3 — Android APK Builder" -ForegroundColor Cyan
Write-Host ""

# 1. Verify Android SDK
$sdk = $env:ANDROID_HOME
if (-not $sdk) { $sdk = $env:ANDROID_SDK_ROOT }
if (-not $sdk -and (Test-Path "$env:LOCALAPPDATA\Android\Sdk")) { $sdk = "$env:LOCALAPPDATA\Android\Sdk" }

if (-not $sdk -or -not (Test-Path $sdk)) {
    Write-Host "  [!!] Android SDK not found." -ForegroundColor Yellow
    Write-Host "  Option A (Fast CLI): Install Google's official android CLI & SDK:" -ForegroundColor White
    Write-Host '    curl -fsSL https://dl.google.com/android/cli/latest/windows_x86_64/install.cmd -o "%TEMP%\i.cmd" && "%TEMP%\i.cmd"' -ForegroundColor Gray
    Write-Host "    android sdk install platforms/android-35 build-tools/35.0.0 platform-tools" -ForegroundColor Gray
    Write-Host "  Option B: Open $APP_DIR in Android Studio and click Run." -ForegroundColor White
    exit 1
}

$sdkEscaped = $sdk.Replace("\", "\\").Replace(":", "\:")
Set-Content -Path (Join-Path $APP_DIR "local.properties") -Value "sdk.dir=$sdkEscaped"
Write-Host "  [OK] Android SDK: $sdk" -ForegroundColor Green

# 2. Check JDK 17+
$jbr = "C:\Program Files\Android\Android Studio\jbr"
if ((Test-Path $jbr) -and (-not $env:JAVA_HOME)) {
    $env:JAVA_HOME = $jbr
    $env:PATH = "$jbr\bin;$env:PATH"
}
$javaVer = (& java -version 2>&1 | Select-Object -First 1)
Write-Host "  [OK] Java: $javaVer" -ForegroundColor Green

# 3. Build APK using Gradle wrapper or system gradle
Push-Location $APP_DIR
try {
    if (Test-Path ".\gradlew.bat") {
        .\gradlew.bat assembleDebug
    } elseif (Get-Command gradle -ErrorAction SilentlyContinue) {
        gradle assembleDebug
    } else {
        Write-Host "  [!!] Gradle not found on PATH. Open $APP_DIR in Android Studio (it generates gradlew automatically) or run 'choco install gradle'." -ForegroundColor Yellow
        exit 1
    }
} finally {
    Pop-Location
}

$apk = Join-Path $APP_DIR "app\build\outputs\apk\debug\app-debug.apk"
if (Test-Path $apk) {
    Write-Host "  [OK] Built APK: $apk" -ForegroundColor Green
    if ($Install) {
        $adb = Join-Path $sdk "platform-tools\adb.exe"
        if (Test-Path $adb) {
            Write-Host "  [>>] Installing onto connected Android device..." -ForegroundColor Cyan
            & $adb install -r $apk
        } elseif (Get-Command android -ErrorAction SilentlyContinue) {
            android install --apks=$apk
        } else {
            Write-Host "  [!!] adb not found — copy $apk to your phone to install." -ForegroundColor Yellow
        }
    }
}
