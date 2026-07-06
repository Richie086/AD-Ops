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

function Install-IisModules {
    Write-Step "Checking for required IIS modules (URL Rewrite and ARR)"
    
    Import-Module WebAdministration

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

    if (-not (Test-Path IIS:\AppPools\$AppPoolName)) {
        New-WebAppPool -Name $AppPoolName | Out-Null
    }

    Set-ItemProperty IIS:\AppPools\$AppPoolName -Name managedRuntimeVersion -Value ''
    Set-ItemProperty IIS:\AppPools\$AppPoolName -Name managedPipelineMode -Value 'Integrated'

    if (Test-Path IIS:\Sites\$SiteName) {
        Set-ItemProperty IIS:\Sites\$SiteName -Name physicalPath -Value $InstallPath
        Set-ItemProperty IIS:\Sites\$SiteName -Name applicationPool -Value $AppPoolName

        $bindingInfo = "*:${IisPort}:"
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
Write-Host "URL: http://localhost:${IisPort}"