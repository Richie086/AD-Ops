<#
.SYNOPSIS
    Move AD-Ops IIS site from port 3001 back to the default port 80.

.DESCRIPTION
    Removes the port 3001 firewall rule, rebinds the AD-Ops IIS site to port 80,
    refreshes web.config reverse proxy, and restarts the Node scheduled task.
    Use this if authentication or proxy behavior broke after switching to 3001.

.EXAMPLE
    .\rebind-iis-port80.ps1
#>
[CmdletBinding()]
param(
    [string]$InstallPath = "C:\inetpub\AD-Ops",
    [string]$SiteName = "AD-Ops",
    [int]$OldIisPort = 3001,
    [int]$NewIisPort = 80,
    [int]$NodePort = 3000,
    [string]$NodeTaskName = "AD-Ops-Node"
)

$ErrorActionPreference = 'Stop'

function Write-Step {
    param([string]$Message)
    Write-Host "[rebind] $Message" -ForegroundColor Cyan
}

function Remove-PortFirewallRule {
    param([int]$Port)
    $ruleName = "AD-Ops IIS HTTP (Port $Port)"
    $existing = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
    if ($existing) {
        Write-Step "Removing firewall rule '$ruleName'"
        Remove-NetFirewallRule -DisplayName $ruleName
    }
}

$currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($currentIdentity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run this script from an elevated PowerShell session (Run as Administrator)."
}

Write-Step "Rebinding AD-Ops IIS from port $OldIisPort to port $NewIisPort"
Remove-PortFirewallRule -Port $OldIisPort

$setupScript = Join-Path $PSScriptRoot 'setup-iis-win11.ps1'
if (-not (Test-Path $setupScript)) {
    throw "Setup script not found: $setupScript"
}

& $setupScript `
    -InstallPath $InstallPath `
    -SiteName $SiteName `
    -IisPort $NewIisPort `
    -NodePort $NodePort `
    -NodeTaskName $NodeTaskName

Write-Host ""
Write-Host "Rebind complete. Browse http://localhost or http://<server-ip> (port 80)." -ForegroundColor Green
Write-Host "Stop using http://<server-ip>:3001 — that binding has been removed." -ForegroundColor Yellow
