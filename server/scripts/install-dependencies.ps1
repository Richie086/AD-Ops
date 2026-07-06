# Check for Node.js
Write-Host "Checking for Node.js..." -ForegroundColor Cyan
try {
    $nodeCheck = Get-Command node -ErrorAction SilentlyContinue
    if (!$nodeCheck) {
        Write-Host "Node.js not found. Attempting to install via winget..." -ForegroundColor Yellow
        winget install OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
        if ($LASTEXITCODE -ne 0) {
            Write-Error "Failed to install Node.js via winget. Please install it manually from https://nodejs.org/"
            exit 1
        }
        # Refresh path environment for the current session if possible, though winget usually requires a new shell
        Write-Host "Node.js installed. You may need to restart your terminal for the 'node' command to be available." -ForegroundColor Yellow
    } else {
        $nodeVersion = node -v
        Write-Host "Node.js is already installed ($nodeVersion)" -ForegroundColor Green
    }
} catch {
    Write-Error "An error occurred while checking for Node.js: $_"
}

# Verify npm
Write-Host "Checking for npm..." -ForegroundColor Cyan
if (!(Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Error "npm is not available in the path. If you just installed Node.js, please restart your terminal."
    exit 1
}

# Navigate to project root (2 levels up from server/scripts)
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$rootDir = Resolve-Path (Join-Path $scriptDir "..\..")
Set-Location $rootDir
Write-Host "Working directory set to: $rootDir" -ForegroundColor Gray

# Install dependencies
Write-Host "Installing npm packages from package.json..." -ForegroundColor Cyan
npm install

if ($LASTEXITCODE -eq 0) {
    Write-Host "SUCCESS: node_modules have been installed/updated." -ForegroundColor Green
} else {
    Write-Host "ERROR: npm install failed. Check errors above." -ForegroundColor Red
    Write-Host "Note: 'better-sqlite3' may require C++ Build Tools. If build fails, install them via:" -ForegroundColor Yellow
    Write-Host "npm install --global --production windows-build-tools" -ForegroundColor Yellow
    exit 1
}
