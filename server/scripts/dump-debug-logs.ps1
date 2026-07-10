# Dump AD-Ops query debug logs to the console and a local file.
# Run on the AD-Ops Windows host after reproducing a failed query.
param(
    [string]$InstallPath = "C:\inetpub\AD-Ops",
    [string]$BaseUrl = "http://localhost"
)

$ErrorActionPreference = 'Continue'
Write-Host "Fetching $BaseUrl/api/debug-logs ..." -ForegroundColor Cyan
try {
    $resp = Invoke-RestMethod -Uri "$BaseUrl/api/debug-logs" -TimeoutSec 10
    $json = $resp | ConvertTo-Json -Depth 8
    Write-Host $json
    $out = Join-Path $InstallPath "data\debug-db110a-dump.json"
    New-Item -ItemType Directory -Force -Path (Split-Path $out) | Out-Null
    Set-Content -Path $out -Value $json -Encoding UTF8
    Write-Host ""
    Write-Host "Wrote $out" -ForegroundColor Green
    Write-Host "Paste that JSON into the Cursor chat." -ForegroundColor Yellow
} catch {
    Write-Host "FAILED: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "If this 404s, run: git pull; Restart-ScheduledTask -TaskName AD-Ops-Node" -ForegroundColor Yellow
    exit 1
}
