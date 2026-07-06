param(
    [string]$InstallPath = "C:\inetpub\AD-Ops",
    [string]$SiteName = "AD-Ops",
    [string]$AppPoolName = "AD-Ops-AppPool",
    [int]$NodePort = 3000,
    [string]$NodeTaskName = "AD-Ops-Node",
    [switch]$RemoveInstallPath
)

$ErrorActionPreference = 'Stop'

function Write-Step {
    param([string]$Message)
    Write-Host "[remove] $Message" -ForegroundColor Yellow
}

function Assert-Admin {
    $currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($currentIdentity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw "Run this script from an elevated PowerShell session (Run as Administrator)."
    }
}

function Remove-NodeTask {
    if (Get-ScheduledTask -TaskName $NodeTaskName -ErrorAction SilentlyContinue) {
        Write-Step "Stopping and removing scheduled task '$NodeTaskName'"

        try {
            Stop-ScheduledTask -TaskName $NodeTaskName -ErrorAction SilentlyContinue
        }
        catch {
            # ignore if task is not running
        }

        Unregister-ScheduledTask -TaskName $NodeTaskName -Confirm:$false
    }
    else {
        Write-Step "Scheduled task '$NodeTaskName' not found, skipping"
    }
}

function Stop-NodePortProcess {
    $connections = Get-NetTCPConnection -State Listen -LocalPort $NodePort -ErrorAction SilentlyContinue
    if (-not $connections) {
        Write-Step "No listening process on port $NodePort, skipping"
        return
    }

    $pids = $connections | Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($pid in $pids) {
        if ($pid -and $pid -gt 0) {
            try {
                Write-Step "Stopping process PID $pid listening on port $NodePort"
                Stop-Process -Id $pid -Force -ErrorAction Stop
            }
            catch {
                $err = $_.Exception.Message
                Write-Step "Could not stop PID $pid : $err"
            }
        }
    }
}

function Remove-IisObjects {
    Import-Module WebAdministration -ErrorAction SilentlyContinue
    if (-not (Get-Module WebAdministration)) {
        # Fallback for newer PowerShell editions if normal import fails
        Import-Module WebAdministration -SkipEditionCheck -ErrorAction SilentlyContinue
    }

    if (Test-Path "IIS:\Sites\$SiteName") {
        Write-Step "Stopping and removing IIS site '$SiteName'"
        try {
            # Check if site exists first to satisfy the provider
            $site = Get-Website -Name $SiteName -ErrorAction SilentlyContinue
            if ($site) {
                Stop-Website -Name $SiteName -ErrorAction SilentlyContinue
                Remove-Website -Name $SiteName
            }
        }
        catch {
            Write-Step "Error removing site: $($_.Exception.Message)"
        }
    }
    else {
        Write-Step "IIS site '$SiteName' not found, skipping"
    }

    if (Test-Path "IIS:\AppPools\$AppPoolName") {
        Write-Step "Removing IIS app pool '$AppPoolName'"
        try {
            Remove-WebAppPool -Name $AppPoolName -ErrorAction SilentlyContinue
        }
        catch {
             Write-Step "Error removing app pool: $($_.Exception.Message)"
        }
    }
    else {
        Write-Step "IIS app pool '$AppPoolName' not found, skipping"
    }
}

function Remove-InstallDirectory {
    if (-not $RemoveInstallPath.IsPresent) {
        Write-Step "Install directory preserved. Use -RemoveInstallPath to delete '$InstallPath'."
        return
    }

    if (Test-Path $InstallPath) {
        Write-Step "Removing install directory '$InstallPath'"
        Remove-Item -Path $InstallPath -Recurse -Force
    }
    else {
        Write-Step "Install directory '$InstallPath' not found, skipping"
    }
}

Assert-Admin
Remove-NodeTask
Stop-NodePortProcess
Remove-IisObjects
Remove-InstallDirectory

Write-Host ""
Write-Host "Removal complete." -ForegroundColor Green