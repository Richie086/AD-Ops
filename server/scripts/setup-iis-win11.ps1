param(
    [string]$RepoUrl = "https://github.com/Richie086/AD-Ops.git",
    [string]$InstallPath = "C:\inetpub\AD-Ops",
    [string]$SiteName = "AD-Ops",
    [string]$AppPoolName = "AD-Ops-AppPool",
    [int]$IisPort = 80,
    [int]$NodePort = 3000,
    [string]$NodeTaskName = "AD-Ops-Node"
)

$ErrorActionPreference = 'Stop'

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

function Ensure-RewriteModule {
    $rewriteModule = Get-WebGlobalModule | Where-Object { $_.Name -eq 'RewriteModule' }
    if (-not $rewriteModule) {
        throw "IIS URL Rewrite module is required for reverse proxy. Install it from https://www.iis.net/downloads/microsoft/url-rewrite and re-run."
    }
}

function Configure-IisSite {
    Write-Step "Configuring IIS site '$SiteName'"

    Import-Module WebAdministration
    Ensure-RewriteModule

    try {
        Set-WebConfigurationProperty -PSPath 'MACHINE/WEBROOT/APPHOST' -Filter 'system.webServer/proxy' -Name 'enabled' -Value 'True'
    }
    catch {
        throw "Failed to enable IIS reverse proxy. Install ARR (Application Request Routing) and re-run."
    }

    if (-not (Test-Path IIS:\AppPools\$AppPoolName)) {
        New-WebAppPool -Name $AppPoolName | Out-Null
    }

    Set-ItemProperty IIS:\AppPools\$AppPoolName -Name managedRuntimeVersion -Value ''
    Set-ItemProperty IIS:\AppPools\$AppPoolName -Name managedPipelineMode -Value 'Integrated'

    if (Test-Path IIS:\Sites\$SiteName) {
        Set-ItemProperty IIS:\Sites\$SiteName -Name physicalPath -Value $InstallPath
        Set-ItemProperty IIS:\Sites\$SiteName -Name applicationPool -Value $AppPoolName

        $bindingInfo = "*:$IisPort:"
        $existingBindings = Get-WebBinding -Name $SiteName
        $hasPort = $false
        foreach ($binding in $existingBindings) {
            if ($binding.bindingInformation -eq $bindingInfo) {
                $hasPort = $true
            }
        }
        if (-not $hasPort) {
            New-WebBinding -Name $SiteName -Protocol http -Port $IisPort -IPAddress '*'
        }
    }
    else {
        New-Website -Name $SiteName -PhysicalPath $InstallPath -Port $IisPort -ApplicationPool $AppPoolName | Out-Null
    }

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

    Start-Website -Name $SiteName
}

Assert-Admin
Require-Command -Name 'git'
Require-Command -Name 'node'
Require-Command -Name 'npm'

Enable-Iis
Sync-Repository
Install-NodeDependencies
Register-NodeStartupTask
Wait-NodePort
Configure-IisSite

Write-Host ""
Write-Host "Deployment complete." -ForegroundColor Green
Write-Host "IIS site: $SiteName"
Write-Host "Path: $InstallPath"
Write-Host "URL: http://localhost:$IisPort"