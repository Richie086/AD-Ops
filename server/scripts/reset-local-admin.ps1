# Reset the local AD-Ops admin password (default: admin).
# Run as Administrator from the install directory.
param(
    [string]$InstallPath = "C:\inetpub\AD-Ops",
    [string]$Password = "admin"
)

$ErrorActionPreference = 'Stop'
Set-Location $InstallPath
Write-Host "Resetting local admin password in $InstallPath ..." -ForegroundColor Cyan
node server/scripts/reset-local-admin.js $Password
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "Restarting AD-Ops Node scheduled task ..." -ForegroundColor Cyan
Stop-ScheduledTask -TaskName 'AD-Ops-Node' -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
Start-ScheduledTask -TaskName 'AD-Ops-Node'
Write-Host "Done. Sign in with username 'admin' and the password you set." -ForegroundColor Green
