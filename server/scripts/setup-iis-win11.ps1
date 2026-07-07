<#
.SYNOPSIS
    Deploy AD-Ops on Windows 11 with IIS reverse proxy and a Node scheduled task.

.PARAMETER IisPort
    Public HTTP port IIS listens on (default 80). Use a custom port only when
    port 80 is already taken. Browse http://<server-ip> or http://<server-ip>:<IisPort>.

.PARAMETER NodePort
    Internal port for the Node.js process (default 3000). IIS proxies to
    localhost:NodePort; clients never connect to this port directly.
#>
param(
    [string]$RepoUrl = "https://github.com/Richie086/AD-Ops.git",
    [string]$InstallPath = "C:\inetpub\AD-Ops",
    [string]$SiteName = "AD-Ops",
    [string]$AppPoolName = "AD-Ops-AppPool",
    [int]$IisPort = 80,
    [int]$NodePort = 3000,
    [string]$NodeTaskName = "AD-Ops-Node",
    [switch]$SkipRepoSync,
    [switch]$AllowDefaultWebSiteTakeover
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'ensure-windows-powershell.ps1')
Ensure-WindowsPowerShell -ScriptBoundParameters $PSBoundParameters

function Write-Step {
    param([string]$Message)
    Write-Host "[setup] $Message" -ForegroundColor Cyan
}

function Assert-Admin {
    $currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($currentIdentity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw "Run this script from an elevated PowerShell session (Run as Administrator)."
    }
}

function Require-Command {
    param([string]$Name)
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Required command '$Name' was not found in PATH. Install it and re-run."
    }
}

function Import-IisAdministration {
    if (-not (Get-Module WebAdministration)) {
        Import-Module WebAdministration -ErrorAction Stop
    }
}

function Test-IisSite {
    param([string]$Name)
    return $null -ne (Get-Website -Name $Name -ErrorAction SilentlyContinue)
}

function Test-IisAppPool {
    param([string]$Name)
    return $null -ne (Get-WebAppPool -Name $Name -ErrorAction SilentlyContinue)
}

function Ensure-IisAppPool {
    param([string]$Name)

    Import-IisAdministration

    if (-not (Test-IisAppPool -Name $Name)) {
        New-WebAppPool -Name $Name | Out-Null
    }

    if (Get-PSDrive -Name IIS -ErrorAction SilentlyContinue) {
        Set-ItemProperty "IIS:\AppPools\$Name" -Name managedRuntimeVersion -Value ''
        Set-ItemProperty "IIS:\AppPools\$Name" -Name managedPipelineMode -Value 'Integrated'
        return
    }

    $appcmd = Join-Path $env:windir 'system32\inetsrv\appcmd.exe'
    & $appcmd set apppool "$Name" /managedRuntimeVersion:"" | Out-Null
    & $appcmd set apppool "$Name" /managedPipelineMode:Integrated | Out-Null
}

function Set-IisSiteProperties {
    param(
        [string]$SiteName,
        [string]$PhysicalPath,
        [string]$ApplicationPool
    )

    Import-IisAdministration

    if (Test-IisSite -Name $SiteName) {
        Set-Website -Name $SiteName -PhysicalPath $PhysicalPath -ApplicationPool $ApplicationPool | Out-Null
    }
}

function Enable-Iis {
    Write-Step "Enabling IIS optional Windows features"

    $features = @(
        'IIS-WebServerRole',
        'IIS-WebServer',
        'IIS-CommonHttpFeatures',
        'IIS-DefaultDocument',
        'IIS-StaticContent',
        'IIS-HttpErrors',
        'IIS-ApplicationDevelopment',
        'IIS-ISAPIExtensions',
        'IIS-ISAPIFilter',
        'IIS-ManagementConsole',
        'IIS-ManagementScriptingTools'
    )

    foreach ($feature in $features) {
        Enable-WindowsOptionalFeature -Online -FeatureName $feature -All -NoRestart | Out-Null
    }
}

function Sync-Repository {
    Write-Step "Cloning or updating repository at $InstallPath"

    if (Test-Path $InstallPath) {
        if (Test-Path (Join-Path $InstallPath '.git')) {
            git -C $InstallPath fetch --all --prune
            git -C $InstallPath pull --ff-only
        }
        else {
            $entries = Get-ChildItem -Path $InstallPath -Force -ErrorAction SilentlyContinue
            if ($entries.Count -gt 0) {
                throw "InstallPath '$InstallPath' exists and is not an empty folder or git repository."
            }
            git clone $RepoUrl $InstallPath
        }
    }
    else {
        $null = New-Item -ItemType Directory -Path $InstallPath -Force
        git clone $RepoUrl $InstallPath
    }
}

function Install-NodeDependencies {
    Write-Step "Installing Node dependencies"
    Push-Location $InstallPath
    try {
        npm install
    }
    finally {
        Pop-Location
    }
}

function Register-NodeStartupTask {
    Write-Step "Creating or updating startup scheduled task '$NodeTaskName'"

    $escapedPath = $InstallPath.Replace("'", "''")
    $command = "Set-Location '$escapedPath'; `$env:PORT='$NodePort'; npm start"

    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command $command"
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -RunLevel Highest -LogonType ServiceAccount
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable

    Register-ScheduledTask -TaskName $NodeTaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null

    try {
        Stop-ScheduledTask -TaskName $NodeTaskName -ErrorAction SilentlyContinue
    }
    catch {
        # ignore if it was not running
    }

    Start-ScheduledTask -TaskName $NodeTaskName
}

function Wait-NodePort {
    Write-Step "Waiting for Node app to listen on port $NodePort"

    for ($i = 0; $i -lt 30; $i++) {
        $isListening = Get-NetTCPConnection -State Listen -LocalPort $NodePort -ErrorAction SilentlyContinue
        if ($isListening) {
            Write-Step "Node process is listening on port $NodePort"
            return
        }
        Start-Sleep -Seconds 1
    }

    throw "Node app did not start on port $NodePort within timeout. Check scheduled task '$NodeTaskName'."
}

function Get-FirewallRuleName {
    param([int]$Port)
    return "AD-Ops IIS HTTP (Port $Port)"
}

function Ensure-FirewallRule {
    param([int]$Port)

    $ruleName = Get-FirewallRuleName -Port $Port
    Write-Step "Ensuring inbound firewall rule for TCP port $Port"

    $existing = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
    if ($existing) {
        Write-Step "Firewall rule '$ruleName' already exists"
        return
    }

    New-NetFirewallRule `
        -DisplayName $ruleName `
        -Description "Allow inbound HTTP to AD-Ops IIS site on port $Port" `
        -Direction Inbound `
        -Action Allow `
        -Protocol TCP `
        -LocalPort $Port `
        -Profile Any | Out-Null

    Write-Step "Created firewall rule '$ruleName'"
}

function Get-SiteBoundToHttpPort {
    param(
        [int]$Port,
        [string]$ExcludeSiteName
    )

    Import-IisAdministration

    foreach ($site in Get-Website) {
        if ($site.Name -eq $ExcludeSiteName) {
            continue
        }

        foreach ($binding in (Get-WebBinding -Name $site.Name)) {
            if ($binding.protocol -ne 'http') {
                continue
            }

            $parts = $binding.bindingInformation -split ':'
            if ($parts.Count -ge 2 -and [int]$parts[1] -eq $Port) {
                return $site.Name
            }
        }
    }

    return $null
}

function Resolve-HttpPortConflict {
    param(
        [int]$Port,
        [string]$TargetSiteName,
        [switch]$AllowDefaultWebSiteTakeover
    )

    Import-IisAdministration

    $conflictingSite = Get-SiteBoundToHttpPort -Port $Port -ExcludeSiteName $TargetSiteName
    if (-not $conflictingSite) {
        return
    }

    if ($AllowDefaultWebSiteTakeover -and $conflictingSite -eq 'Default Web Site') {
        Write-Step "Port $Port is bound by '$conflictingSite'; stopping site and removing its HTTP binding so AD-Ops can use port $Port"
        Stop-Website -Name $conflictingSite -ErrorAction SilentlyContinue
        $bindings = @(Get-WebBinding -Name $conflictingSite | Where-Object { $_.protocol -eq 'http' })
        foreach ($binding in $bindings) {
            $parts = $binding.bindingInformation -split ':'
            if ($parts.Count -ge 2 -and [int]$parts[1] -eq $Port) {
                Write-Step "Removing binding '$($binding.bindingInformation)' from '$conflictingSite'"
                Remove-WebBinding -Name $conflictingSite -BindingInformation $binding.bindingInformation -Protocol http
            }
        }
        return
    }

    throw @"
HTTP port $Port is already bound by IIS site '$conflictingSite'.
Stop that site and remove its port $Port binding, or pass -AllowDefaultWebSiteTakeover when rebinding from port 3001.
Example:
  Stop-Website -Name '$conflictingSite'
  Remove-WebBinding -Name '$conflictingSite' -BindingInformation '*:${Port}:' -Protocol http
"@
}

function Set-IisHttpBinding {
    param(
        [string]$SiteName,
        [int]$Port,
        [switch]$AllowDefaultWebSiteTakeover
    )

    Import-IisAdministration

    $bindingInfo = "*:${Port}:"
    Resolve-HttpPortConflict -Port $Port -TargetSiteName $SiteName -AllowDefaultWebSiteTakeover:$AllowDefaultWebSiteTakeover

    if (Test-IisSite -Name $SiteName) {
        $httpBindings = @(Get-WebBinding -Name $SiteName | Where-Object { $_.protocol -eq 'http' })
        foreach ($binding in $httpBindings) {
            if ($binding.bindingInformation -ne $bindingInfo) {
                Write-Step "Removing stale HTTP binding '$($binding.bindingInformation)' from site '$SiteName'"
                Remove-WebBinding -Name $SiteName -BindingInformation $binding.bindingInformation -Protocol http
            }
        }

        $hasTargetBinding = @(Get-WebBinding -Name $SiteName | Where-Object {
            $_.protocol -eq 'http' -and $_.bindingInformation -eq $bindingInfo
        }).Count -gt 0

        if (-not $hasTargetBinding) {
            Write-Step "Adding HTTP binding $bindingInfo to site '$SiteName'"
            New-WebBinding -Name $SiteName -Protocol http -Port $Port -IPAddress '*'
        }
    }
    else {
        New-Website -Name $SiteName -PhysicalPath $InstallPath -Port $Port -ApplicationPool $AppPoolName | Out-Null
    }
}

function Install-IisModules {
    Write-Step "Checking for required IIS modules (URL Rewrite and ARR)"
    
    Import-IisAdministration

    # Check for URL Rewrite
    $rewriteModule = Get-WebGlobalModule | Where-Object { $_.Name -eq 'RewriteModule' }
    if (-not $rewriteModule) {
        Write-Step "IIS URL Rewrite module not found. Attempting to install via winget..."
        winget install Microsoft.IIS.URLRewrite --silent --accept-package-agreements --accept-source-agreements
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to install IIS URL Rewrite module. Please install it manually from https://www.iis.net/downloads/microsoft/url-rewrite"
        }
        Write-Step "URL Rewrite installed successfully."
    }

    # Check if we can access the proxy configuration (indicates ARR is present)
    try {
        Get-WebConfigurationProperty -PSPath 'MACHINE/WEBROOT/APPHOST' -Filter 'system.webServer/proxy' -Name 'enabled' -ErrorAction Stop | Out-Null
    }
    catch {
        Write-Step "IIS Application Request Routing (ARR) not found. Attempting to install via winget..."
        winget install Microsoft.IIS.ApplicationRequestRouting --silent --accept-package-agreements --accept-source-agreements
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to install ARR. Please install it manually and re-run."
        }
        Write-Step "ARR installed successfully. Restarting IIS service to register module..."
        Restart-Service W3SVC -Force
    }
}

function Configure-IisSite {
    Write-Step "Configuring IIS site '$SiteName'"

    Install-IisModules

    Write-Step "Enabling IIS reverse proxy"
    try {
        Set-WebConfigurationProperty -PSPath 'MACHINE/WEBROOT/APPHOST' -Filter 'system.webServer/proxy' -Name 'enabled' -Value 'True' -ErrorAction Stop
    }
    catch {
        Write-Host "Warning: Could not enable proxy via Set-WebConfigurationProperty. Ensure ARR is fully installed." -ForegroundColor Yellow
        Write-Host $_.Exception.Message -ForegroundColor Gray
    }

    Ensure-IisAppPool -Name $AppPoolName
    Set-IisSiteProperties -SiteName $SiteName -PhysicalPath $InstallPath -ApplicationPool $AppPoolName

    Set-IisHttpBinding -SiteName $SiteName -Port $IisPort -AllowDefaultWebSiteTakeover:$AllowDefaultWebSiteTakeover

    $webConfigPath = Join-Path $InstallPath 'web.config'
    $webConfig = @"
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <system.webServer>
    <rewrite>
      <rules>
        <rule name="ADOpsReverseProxy" stopProcessing="true">
          <match url="(.*)" />
          <action type="Rewrite" url="http://localhost:$NodePort/{R:1}" />
        </rule>
      </rules>
    </rewrite>
  </system.webServer>
</configuration>
"@
    Set-Content -Path $webConfigPath -Value $webConfig -Encoding utf8

    $site = Get-Website -Name $SiteName
    if ($site.state -ne "Started") {
        try {
            Start-Website -Name $SiteName -ErrorAction Stop
            Write-Step "IIS site '$SiteName' started."
        }
        catch {
            Write-Host "Warning: Failed to start site '$SiteName'. Check if port $IisPort is in use by another site." -ForegroundColor Yellow
            Write-Host $_.Exception.Message -ForegroundColor Gray
        }
    } else {
        Write-Step "IIS site '$SiteName' is already running."
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

function Get-PrimaryIPv4Address {
    $address = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object {
            $_.IPAddress -notlike '127.*' -and
            $_.PrefixOrigin -ne 'WellKnown'
        } |
        Sort-Object -Property InterfaceMetric |
        Select-Object -First 1 -ExpandProperty IPAddress

    if ($address) {
        return $address
    }

    return '<server-ip>'
}

Assert-Admin
Require-Command -Name 'git'
Require-Command -Name 'node'
Require-Command -Name 'npm'

Enable-Iis

if ($SkipRepoSync) {
    if (-not (Test-Path $InstallPath)) {
        throw "InstallPath '$InstallPath' does not exist. Omit -SkipRepoSync for a fresh install."
    }
    Write-Step "Skipping repository sync and npm install (-SkipRepoSync)"
}
else {
    Sync-Repository
    Install-NodeDependencies
}

Register-NodeStartupTask
Wait-NodePort
Configure-IisSite
Ensure-FirewallRule -Port $IisPort

$serverIp = Get-PrimaryIPv4Address
$localUrl = Format-IisUrl -HostName 'localhost' -Port $IisPort
$remoteUrl = Format-IisUrl -HostName $serverIp -Port $IisPort

Write-Host ""
Write-Host "Deployment complete." -ForegroundColor Green
Write-Host "IIS site: $SiteName"
Write-Host "Path: $InstallPath"
Write-Host "IIS public port: $IisPort (Node internal port: $NodePort)"
Write-Host "Local URL:  $localUrl"
Write-Host "Remote URL: $remoteUrl"
Write-Host ""
Write-Host "Traffic is HTTP only unless you add TLS bindings separately." -ForegroundColor DarkGray