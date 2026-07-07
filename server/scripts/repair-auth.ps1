<#
.SYNOPSIS
    One-shot repair for broken AD-Ops login behind IIS.

.DESCRIPTION
    Fixes the common causes of auth failure:
      - Default Web Site still bound to port 80 (IIS welcome page / 404.4 on /api/*)
      - Missing URL Rewrite or ARR reverse proxy
      - Stale web.config
      - Node scheduled task not running
      - Unknown local admin password

    Resets the local admin password, reconfigures IIS, restarts Node, and verifies
    login works both directly and through IIS.

.EXAMPLE
    .\repair-auth.ps1
    .\repair-auth.ps1 -AdminPassword 'MyNewPass123'
#>
[CmdletBinding()]
param(
    [string]$InstallPath = "C:\inetpub\AD-Ops",
    [string]$AdminPassword = "admin",
    [int]$IisPort = 80,
    [int]$NodePort = 3000,
    [string]$NodeTaskName = "AD-Ops-Node"
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'ensure-windows-powershell.ps1')
Ensure-WindowsPowerShell -ScriptBoundParameters $PSBoundParameters

function Write-Step {
    param([string]$Message)
    Write-Host "[repair-auth] $Message" -ForegroundColor Cyan
}

$currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($currentIdentity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run this script from an elevated PowerShell session (Run as Administrator)."
}

if (-not (Test-Path $InstallPath)) {
    throw "Install path not found: $InstallPath"
}

Write-Step "Reconfiguring IIS reverse proxy and Node (install path: $InstallPath)"

$setupScript = Join-Path $PSScriptRoot 'setup-iis-win11.ps1'
if (-not (Test-Path $setupScript)) {
    throw "Setup script not found: $setupScript"
}

& $setupScript `
    -InstallPath $InstallPath `
    -IisPort $IisPort `
    -NodePort $NodePort `
    -NodeTaskName $NodeTaskName `
    -SkipRepoSync `
    -AllowDefaultWebSiteTakeover

Write-Step "Resetting local admin password"
Set-Location $InstallPath
node server/scripts/reset-local-admin.js $AdminPassword
if ($LASTEXITCODE -ne 0) {
    throw "Failed to reset admin password (exit $LASTEXITCODE)"
}

Write-Step "Verifying login end-to-end"
$diagnoseScript = Join-Path $PSScriptRoot 'diagnose-login.ps1'
& $diagnoseScript -InstallPath $InstallPath -IisPort $IisPort -NodePort $NodePort -Username 'admin' -Password $AdminPassword

Write-Host ""
Write-Host "Repair complete." -ForegroundColor Green
Write-Host "Sign in at http://localhost with username 'admin' and the password you set (-AdminPassword)." -ForegroundColor Green
