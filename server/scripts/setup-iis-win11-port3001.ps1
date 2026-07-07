<#
.SYNOPSIS
    DEPRECATED: Port 3001 has caused authentication issues for some deployments.
    Use setup-iis-win11.ps1 (default port 80) or rebind-iis-port80.ps1 to revert.

    Deploy AD-Ops with IIS on port 3001 (Node stays on internal port 3000).
#>

.DESCRIPTION
    Convenience wrapper around setup-iis-win11.ps1. IIS serves HTTP on port 3001
    and reverse-proxies to Node on localhost:3000. Browse http://<server-ip>:3001.

.EXAMPLE
    .\setup-iis-win11-port3001.ps1

.EXAMPLE
    .\setup-iis-win11-port3001.ps1 -InstallPath "D:\AD-Ops"
#>
[CmdletBinding()]
param(
    [string]$RepoUrl = "https://github.com/Richie086/AD-Ops.git",
    [string]$InstallPath = "C:\inetpub\AD-Ops",
    [string]$SiteName = "AD-Ops",
    [string]$AppPoolName = "AD-Ops-AppPool",
    [int]$NodePort = 3000,
    [string]$NodeTaskName = "AD-Ops-Node"
)

Write-Host "WARNING: Port 3001 is deprecated — use default port 80 if possible (see rebind-iis-port80.ps1)." -ForegroundColor Yellow
$setupScript = Join-Path $PSScriptRoot 'setup-iis-win11.ps1'
if (-not (Test-Path $setupScript)) {
    throw "Setup script not found: $setupScript"
}

& $setupScript `
    -RepoUrl $RepoUrl `
    -InstallPath $InstallPath `
    -SiteName $SiteName `
    -AppPoolName $AppPoolName `
    -IisPort 3001 `
    -NodePort $NodePort `
    -NodeTaskName $NodeTaskName
