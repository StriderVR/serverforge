<#
.SYNOPSIS
    Registers standalone ServerForge.exe to auto-start when Windows 11 boots
    (no Remote Desktop login required) with Administrator privileges so
    managed daily PC reboots and task inspection work seamlessly.
.EXAMPLE
    # Run in PowerShell as Administrator from the folder containing ServerForge.exe:
    .\register-autostart-exe.ps1
#>
[CmdletBinding()]
param(
    [string]$ExePath = (Join-Path (Get-Location) "ServerForge.exe"),
    [switch]$OpenFirewallPort
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $ExePath)) {
    Write-Error "ServerForge.exe not found at '$ExePath'. Pass -ExePath 'C:\ServerForge\ServerForge.exe' or run from the folder containing ServerForge.exe."
}

$ResolvedExe = (Resolve-Path $ExePath).Path
$WorkDir = Split-Path -Parent $ResolvedExe

$Action = New-ScheduledTaskAction -Execute $ResolvedExe -WorkingDirectory $WorkDir
$Trigger = New-ScheduledTaskTrigger -AtStartup
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName "ServerForge" -Action $Action -Trigger $Trigger -Settings $Settings -RunLevel Highest -Force | Out-Null
Write-Host "[OK] Registered 'ServerForge' Windows Startup Task for $ResolvedExe" -ForegroundColor Green

if ($OpenFirewallPort) {
    New-NetFirewallRule -DisplayName "ServerForge Dashboard" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow -ErrorAction SilentlyContinue | Out-Null
    Write-Host "[OK] Opened Windows Firewall inbound TCP port 3000." -ForegroundColor Green
}

Write-Host ""
Write-Host "ServerForge will now automatically start every time your Windows 11 PC boots!" -ForegroundColor Cyan
