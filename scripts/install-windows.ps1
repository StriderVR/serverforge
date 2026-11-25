<#
.SYNOPSIS
    ServerForge Windows 11 Installer & Setup Helper
.DESCRIPTION
    Checks prerequisites (Node.js 22+, pnpm, Docker Desktop, SteamCMD),
    installs dependencies, builds ServerForge, creates .env, and optionally
    registers a Windows startup task so ServerForge runs on boot without RDP.
#>
[CmdletBinding()]
param(
    [switch]$InstallSteamCmd,
    [switch]$RegisterStartupTask,
    [switch]$OpenFirewallPort
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $RepoRoot

Write-Host ""
Write-Host "======================================================" -ForegroundColor DarkYellow
Write-Host "  ServerForge — Windows 11 Setup" -ForegroundColor Yellow
Write-Host "======================================================" -ForegroundColor DarkYellow
Write-Host ""

# 1. Check Node.js 22+
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "Node.js 22+ is required. Install it from https://nodejs.org/ or run: winget install OpenJS.NodeJS.LTS"
}
$nodeVer = (node -v).TrimStart('v')
$nodeMajor = [int]($nodeVer.Split('.')[0])
if ($nodeMajor -lt 22) {
    Write-Error "Node.js v22.5+ is required (found v$nodeVer). Please upgrade Node.js."
}
Write-Host "[OK] Node.js v$nodeVer detected." -ForegroundColor Green

# 2. Ensure pnpm is available
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    Write-Host "[..] Enabling pnpm via corepack..." -ForegroundColor Cyan
    corepack enable
    corepack prepare pnpm@latest --activate
}
Write-Host "[OK] pnpm $(pnpm -v) detected." -ForegroundColor Green

# 3. Check optional runtimes (Docker Desktop & SteamCMD)
if (Get-Command docker -ErrorAction SilentlyContinue) {
    Write-Host "[OK] Docker CLI detected (Docker Desktop recommended for Minecraft, Factorio, Satisfactory, Palworld)." -ForegroundColor Green
} else {
    Write-Host "[INFO] Docker Desktop not found. You can still run SteamCMD/Java servers natively, or install Docker Desktop later." -ForegroundColor Yellow
}

$SteamCmdDir = Join-Path $RepoRoot "data\tools\steamcmd"
$SteamCmdExe = Join-Path $SteamCmdDir "steamcmd.exe"
if ($InstallSteamCmd -and -not (Test-Path $SteamCmdExe)) {
    Write-Host "[..] Downloading official Valve SteamCMD for Windows..." -ForegroundColor Cyan
    New-Item -ItemType Directory -Force -Path $SteamCmdDir | Out-Null
    $ZipPath = Join-Path $SteamCmdDir "steamcmd.zip"
    Invoke-WebRequest -Uri "https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip" -OutFile $ZipPath
    Expand-Archive -Path $ZipPath -DestinationPath $SteamCmdDir -Force
    Remove-Item $ZipPath -Force
    Write-Host "[OK] SteamCMD installed to $SteamCmdDir (ready for Native Ark: ASA, Palworld, Satisfactory)." -ForegroundColor Green
} elseif (Test-Path $SteamCmdExe) {
    Write-Host "[OK] Local SteamCMD found at $SteamCmdExe." -ForegroundColor Green
} else {
    Write-Host "[INFO] Tip: Re-run with -InstallSteamCmd to auto-install SteamCMD for Native Windows servers (like Ark: ASA)." -ForegroundColor Yellow
}

# 4. Initialize .env
$EnvFile = Join-Path $RepoRoot ".env"
if (-not (Test-Path $EnvFile)) {
    Copy-Item (Join-Path $RepoRoot ".env.example") $EnvFile
    Write-Host "[OK] Created .env from .env.example — edit it to add your DISCORD_TOKEN and PUBLIC_HOST." -ForegroundColor Green
}

# 5. Install dependencies & build
Write-Host "[..] Installing dependencies..." -ForegroundColor Cyan
pnpm install

Write-Host "[..] Building ServerForge (shared, server, web)..." -ForegroundColor Cyan
pnpm build

# 6. Optional Windows Firewall rule for Dashboard Port 3000
if ($OpenFirewallPort) {
    Write-Host "[..] Adding Windows Firewall inbound rule for TCP 3000 (requires Admin PowerShell)..." -ForegroundColor Cyan
    New-NetFirewallRule -DisplayName "ServerForge Dashboard" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow -ErrorAction SilentlyContinue | Out-Null
    Write-Host "[OK] Firewall rule created for TCP 3000." -ForegroundColor Green
}

# 7. Optional Startup Task (runs at boot without Remote Desktop login)
if ($RegisterStartupTask) {
    $NodeExe = (Get-Command node).Source
    $EntryPoint = Join-Path $RepoRoot "packages\server\dist\index.js"
    $Action = New-ScheduledTaskAction -Execute $NodeExe -Argument "`"$EntryPoint`"" -WorkingDirectory $RepoRoot
    $Trigger = New-ScheduledTaskTrigger -AtStartup
    $Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    Register-ScheduledTask -TaskName "ServerForge" -Action $Action -Trigger $Trigger -Settings $Settings -RunLevel Highest -Force | Out-Null
    Write-Host "[OK] Registered 'ServerForge' Windows Startup Scheduled Task." -ForegroundColor Green
}

Write-Host ""
Write-Host "Setup complete!" -ForegroundColor Green
Write-Host "  1. Edit .env to configure PUBLIC_HOST (e.g. your Tailscale IP) and DISCORD_TOKEN."
Write-Host "  2. Launch ServerForge with:  pnpm start"
Write-Host "  3. Open http://localhost:3000 in your browser to create your admin login."
Write-Host ""
