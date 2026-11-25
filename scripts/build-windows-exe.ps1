<#
.SYNOPSIS
    Builds a standalone, double-clickable ServerForge.exe for Windows 11 (x64)
    using Node.js 22 Single Executable Applications (SEA).
#>
$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $RepoRoot

Write-Host "[1/4] Building workspace packages..." -ForegroundColor Cyan
pnpm build

Write-Host "[2/4] Bundling single-file app + embedded React UI & game templates..." -ForegroundColor Cyan
node scripts/build-exe-bundle.mjs

Push-Location (Join-Path $RepoRoot "dist-exe")
try {
    Write-Host "[3/4] Generating Node 22 SEA blob..." -ForegroundColor Cyan
    node --experimental-sea-config sea-config.json

    $NodeExe = (Get-Command node).Source
    $OutExe = Join-Path (Get-Location) "ServerForge.exe"
    Copy-Item -Path $NodeExe -Destination $OutExe -Force

    # Remove existing Authenticode signature from copied node.exe before postject injection (optional if signtool exists)
    if (Get-Command signtool -ErrorAction SilentlyContinue) {
        try { signtool remove /s $OutExe | Out-Null } catch {}
    }

    Write-Host "[4/4] Injecting ServerForge bundle into ServerForge.exe..." -ForegroundColor Cyan
    npx --yes postject $OutExe NODE_SEA_BLOB sea-prep.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 --overwrite

    $SizeMb = [math]::Round((Get-Item $OutExe).Length / 1MB, 1)
    Write-Host ""
    Write-Host "[OK] Built standalone executable: $OutExe ($SizeMb MB)" -ForegroundColor Green
    Write-Host "     Just double-click ServerForge.exe on any Windows 11 PC — no Node.js install needed!" -ForegroundColor Green
} finally {
    Pop-Location
}
