<#
.SYNOPSIS
    Move AD-Ops IIS site from port 3001 back to the default port 80.

.DESCRIPTION
    Rebinds the AD-Ops IIS site to port 80, resolves the common Default Web Site
    port conflict, refreshes web.config reverse proxy, ensures the port 80 firewall
    rule exists, removes the old port 3001 firewall rule, and restarts the Node
    scheduled task.

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

function Test-IisHealth {
    param([int]$Port)

    $uri = if ($Port -eq 80) { 'http://localhost/api/health' } else { "http://localhost:${Port}/api/health" }
    try {
        $resp = Invoke-WebRequest -Uri $uri -UseBasicParsing -TimeoutSec 10
        return $resp.StatusCode -eq 200
    }
    catch {
        return $false
    }
}

function Show-RebindDiagnostics {
    param(
        [string]$SiteName,
        [int]$IisPort,
        [int]$NodePort
    )

    Import-Module WebAdministration -ErrorAction SilentlyContinue

    Write-Host ""
    Write-Host "Diagnostics:" -ForegroundColor Yellow

    $nodeListen = Get-NetTCPConnection -State Listen -LocalPort $NodePort -ErrorAction SilentlyContinue
    if ($nodeListen) {
        Write-Host "  Node listening on port $NodePort (PID $($nodeListen.OwningProcess))" -ForegroundColor Green
    }
    else {
        Write-Host "  Node is NOT listening on port $NodePort" -ForegroundColor Red
        Write-Host "  Try: Start-ScheduledTask -TaskName '$NodeTaskName'" -ForegroundColor Yellow
    }

    if (Get-Module WebAdministration) {
        $site = Get-Website -Name $SiteName -ErrorAction SilentlyContinue
        if ($site) {
            Write-Host "  IIS site '$SiteName' state: $($site.state)" -ForegroundColor $(if ($site.state -eq 'Started') { 'Green' } else { 'Red' })
            Get-WebBinding -Name $SiteName | ForEach-Object {
                Write-Host "  Binding: $($_.protocol) $($_.bindingInformation)"
            }
        }
        else {
            Write-Host "  IIS site '$SiteName' not found" -ForegroundColor Red
        }

        $conflict = Get-Website | ForEach-Object {
            $name = $_.Name
            if ($name -eq $SiteName) { return }
            Get-WebBinding -Name $name | Where-Object {
                $_.protocol -eq 'http' -and ($_.bindingInformation -split ':')[1] -eq "$IisPort"
            } | ForEach-Object { $name }
        } | Select-Object -First 1

        if ($conflict) {
            Write-Host "  Port $IisPort is still bound by IIS site '$conflict'" -ForegroundColor Red
        }
    }

    if (Test-IisHealth -Port $IisPort) {
        Write-Host "  IIS health check on port $IisPort: OK" -ForegroundColor Green
    }
    else {
        Write-Host "  IIS health check on port $IisPort: FAILED" -ForegroundColor Red
        Write-Host "  Run: .\diagnose-login.ps1 -IisPort $IisPort" -ForegroundColor Yellow
    }
}

$currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($currentIdentity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run this script from an elevated PowerShell session (Run as Administrator)."
}

Write-Step "Rebinding AD-Ops IIS from port $OldIisPort to port $NewIisPort"

$setupScript = Join-Path $PSScriptRoot 'setup-iis-win11.ps1'
if (-not (Test-Path $setupScript)) {
    throw "Setup script not found: $setupScript"
}

try {
    & $setupScript `
        -InstallPath $InstallPath `
        -SiteName $SiteName `
        -IisPort $NewIisPort `
        -NodePort $NodePort `
        -NodeTaskName $NodeTaskName `
        -SkipRepoSync `
        -AllowDefaultWebSiteTakeover
}
catch {
    Write-Host ""
    Write-Host "Rebind failed: $($_.Exception.Message)" -ForegroundColor Red
    Show-RebindDiagnostics -SiteName $SiteName -IisPort $NewIisPort -NodePort $NodePort
    Write-Host ""
    Write-Host "If AD-Ops is still on port $OldIisPort, browse http://<server-ip>:$OldIisPort until rebind succeeds." -ForegroundColor Yellow
    throw
}

Remove-PortFirewallRule -Port $OldIisPort

Write-Host ""
if (Test-IisHealth -Port $NewIisPort) {
    Write-Host "Rebind complete. Browse http://localhost or http://<server-ip> (port 80)." -ForegroundColor Green
}
else {
    Write-Host "Rebind finished but IIS health check failed." -ForegroundColor Yellow
    Show-RebindDiagnostics -SiteName $SiteName -IisPort $NewIisPort -NodePort $NodePort
}

Write-Host "Stop using http://<server-ip>:$OldIisPort — that binding has been removed." -ForegroundColor Yellow
