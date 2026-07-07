# Diagnose AD-Ops login and backend connectivity on the Windows host.
param(
    [string]$InstallPath = "C:\inetpub\AD-Ops",
    [int]$IisPort = 80,
    [int]$NodePort = 3000,
    [string]$Username = "admin",
    [string]$Password = "admin"
)

$ErrorActionPreference = 'Continue'

. (Join-Path $PSScriptRoot 'ensure-windows-powershell.ps1')
Ensure-WindowsPowerShell -ScriptBoundParameters $PSBoundParameters

Set-Location $InstallPath

Write-Host "=== AD-Ops login diagnostics ===" -ForegroundColor Cyan
Write-Host "Install path: $InstallPath"
Write-Host ""

function Test-Endpoint {
    param([string]$Label, [string]$Url, [hashtable]$Extra = @{})
    Write-Host "[$Label] $Url" -ForegroundColor Yellow
    try {
        $params = @{
            Uri = $Url
            UseBasicParsing = $true
            TimeoutSec = 10
        }
        if ($Extra.Method) { $params.Method = $Extra.Method }
        if ($Extra.Body) {
            $params.Body = $Extra.Body
            $params.ContentType = 'application/json'
        }
        if ($Extra.Session) { $params.WebSession = $Extra.Session }
        $resp = Invoke-WebRequest @params
        Write-Host "  Status: $($resp.StatusCode)" -ForegroundColor Green
        if ($resp.Content) {
            $preview = $resp.Content
            if ($preview.Length -gt 300) { $preview = $preview.Substring(0, 300) + '...' }
            Write-Host "  Body: $preview"
        }
        return $resp
    } catch {
        $status = $_.Exception.Response.StatusCode.value__
        Write-Host "  FAILED: status=$status $($_.Exception.Message)" -ForegroundColor Red
        if ($_.ErrorDetails.Message) { Write-Host "  Details: $($_.ErrorDetails.Message)" }
        return $null
    }
}

function Format-IisUrl {
    param(
        [string]$HostName,
        [int]$Port
    )

    if ($Port -eq 80) {
        return "http://${HostName}"
    }

    return "http://${HostName}:${Port}"
}

Write-Host "--- Node process ---" -ForegroundColor Cyan
$nodeListen = Get-NetTCPConnection -State Listen -LocalPort $NodePort -ErrorAction SilentlyContinue
if ($nodeListen) {
    Write-Host "Node is listening on port $NodePort (PID $($nodeListen.OwningProcess))" -ForegroundColor Green
} else {
    Write-Host "Node is NOT listening on port $NodePort" -ForegroundColor Red
    Write-Host "Try: Start-ScheduledTask -TaskName 'AD-Ops-Node'" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "--- IIS bindings ---" -ForegroundColor Cyan
Import-Module WebAdministration -ErrorAction SilentlyContinue
if (Get-Module WebAdministration) {
    $site = Get-Website -Name 'AD-Ops' -ErrorAction SilentlyContinue
    if ($site) {
        Write-Host "AD-Ops site state: $($site.state)" -ForegroundColor $(if ($site.state -eq 'Started') { 'Green' } else { 'Red' })
        Get-WebBinding -Name 'AD-Ops' | ForEach-Object {
            Write-Host "  AD-Ops binding: $($_.protocol) $($_.bindingInformation)"
        }
    } else {
        Write-Host "IIS site 'AD-Ops' not found" -ForegroundColor Red
    }

    $port80Site = $null
    foreach ($otherSite in Get-Website) {
        if ($otherSite.Name -eq 'AD-Ops') { continue }
        foreach ($binding in (Get-WebBinding -Name $otherSite.Name)) {
            if ($binding.protocol -ne 'http') { continue }
            $parts = $binding.bindingInformation -split ':'
            if ($parts.Count -ge 2 -and [int]$parts[1] -eq $IisPort) {
                $port80Site = $otherSite.Name
                Write-Host "Port $IisPort conflict: site '$port80Site' binding $($binding.bindingInformation)" -ForegroundColor Red
            }
        }
    }
    if (-not $port80Site -and $IisPort -eq 80) {
        Write-Host "No other IIS site is bound to port 80" -ForegroundColor Green
    }
} else {
    Write-Host "WebAdministration module unavailable; skipping IIS binding checks" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "--- HTTP checks ---" -ForegroundColor Cyan
Test-Endpoint -Label 'node-health' -Url "http://localhost:$NodePort/api/health"
Test-Endpoint -Label 'iis-health' -Url "$(Format-IisUrl -HostName 'localhost' -Port $IisPort)/api/health"

Write-Host ""
Write-Host "--- Login API (direct to Node) ---" -ForegroundColor Cyan
$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$loginBody = @{ username = $Username; password = $Password } | ConvertTo-Json
$login = Test-Endpoint -Label 'node-login' -Url "http://localhost:$NodePort/api/auth/login" -Extra @{
    Method = 'POST'
    Body = $loginBody
    Session = $session
}
if ($login) {
    Test-Endpoint -Label 'node-me' -Url "http://localhost:$NodePort/api/auth/me" -Extra @{ Session = $session }
}

Write-Host ""
Write-Host "--- Login API (via IIS) ---" -ForegroundColor Cyan
$iisSession = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$iisLogin = Test-Endpoint -Label 'iis-login' -Url "$(Format-IisUrl -HostName 'localhost' -Port $IisPort)/api/auth/login" -Extra @{
    Method = 'POST'
    Body = $loginBody
    Session = $iisSession
}
if ($iisLogin) {
    Test-Endpoint -Label 'iis-me' -Url "$(Format-IisUrl -HostName 'localhost' -Port $IisPort)/api/auth/me" -Extra @{ Session = $iisSession }
}

Write-Host ""
Write-Host "--- Local admin account ---" -ForegroundColor Cyan
if (Test-Path (Join-Path $InstallPath 'data\adops.db')) {
    node server/scripts/reset-local-admin.js $Password 2>&1 | ForEach-Object { Write-Host $_ }
} else {
    Write-Host "Database not found at data\adops.db" -ForegroundColor Red
}

Write-Host ""
Write-Host "If node-login works but iis-login fails, re-run setup-iis-win11.ps1 or rebind-iis-port80.ps1 to refresh web.config." -ForegroundColor Yellow
Write-Host "If port 80 shows the IIS welcome page, Default Web Site still owns port 80 — run rebind-iis-port80.ps1 again." -ForegroundColor Yellow
Write-Host "If login returns 401, credentials are wrong — reset script above sets admin password." -ForegroundColor Yellow
