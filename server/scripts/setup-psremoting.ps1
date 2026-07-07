<#
.SYNOPSIS
    Configure PowerShell Remoting (WinRM) on a Windows 11 host so that
    AD-Ops can reach it via Invoke-Command / wrapper.ps1.

.DESCRIPTION
    Run this script *on the target host* (e.g. 192.168.0.21) from an
    elevated PowerShell session.

    What it does:
      1. Enables WinRM and the PSRemoting listener (HTTP :5985).
      2. Optionally creates a self-signed HTTPS listener (:5986) so that
         wrapper.ps1 can use -UseSSL without a CA cert.
      3. Opens the required Windows Firewall rules (HTTP and/or HTTPS).
      4. Raises WinRM memory and envelope limits so large AD payloads
         don't get truncated.
      5. Optionally adds trusted-host entries on *this* machine so it can
         also act as a remoting *client* back to other hosts.
      6. Prints a test command you can run from the AD-Ops server to verify.

.PARAMETER HttpsOnly
    Skip the HTTP listener and firewall rule; only configure HTTPS (:5986).
    Useful when the host is not domain-joined and you want encryption at rest.

.PARAMETER AddTrustedHosts
    Comma-separated list of hosts/IPs to add to WinRM TrustedHosts on *this*
    machine (needed when connecting *from* this host to non-domain targets).
    Example: -AddTrustedHosts "192.168.0.10,192.168.0.11"

.PARAMETER CertDnsName
    Subject/SAN for the self-signed certificate created for the HTTPS listener.
    Defaults to the machine's FQDN. Override when accessing by IP or alias.

.EXAMPLE
    # HTTP only (simplest, fine on a trusted LAN)
    .\setup-psremoting.ps1

.EXAMPLE
    # HTTPS only with a custom cert DNS name
    .\setup-psremoting.ps1 -HttpsOnly -CertDnsName "win11-lab.corp.local"

.EXAMPLE
    # HTTP + HTTPS, and also trust the AD-Ops server so this host can call back
    .\setup-psremoting.ps1 -AddTrustedHosts "192.168.0.10"
#>
param(
    [switch]$HttpsOnly,
    [string]$AddTrustedHosts = '',
    [string]$CertDnsName = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

function Write-Step {
    param([string]$Message)
    Write-Host "[psremoting] $Message" -ForegroundColor Cyan
}

function Write-Ok {
    param([string]$Message)
    Write-Host "  OK  $Message" -ForegroundColor Green
}

function Write-Warn {
    param([string]$Message)
    Write-Host "  WARN $Message" -ForegroundColor Yellow
}

function Assert-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $p  = New-Object Security.Principal.WindowsPrincipal($id)
    if (-not $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw "Run this script from an elevated PowerShell session (Run as Administrator)."
    }
}

# ---------------------------------------------------------------------------
# Step 1 – pre-flight
# ---------------------------------------------------------------------------

Assert-Admin

if (-not $CertDnsName) {
    $CertDnsName = [System.Net.Dns]::GetHostEntry('').HostName
    if (-not $CertDnsName) {
        $CertDnsName = $env:COMPUTERNAME
    }
}

Write-Step "Target FQDN / cert name: $CertDnsName"

# ---------------------------------------------------------------------------
# Step 2 – enable WinRM service
# ---------------------------------------------------------------------------

Write-Step "Enabling WinRM service"
Set-Service -Name WinRM -StartupType Automatic
Start-Service -Name WinRM -ErrorAction SilentlyContinue
Write-Ok "WinRM service is running"

# ---------------------------------------------------------------------------
# Step 3 – HTTP listener (:5985)
# ---------------------------------------------------------------------------

if (-not $HttpsOnly) {
    Write-Step "Configuring HTTP listener on port 5985"

    $httpListener = Get-WSManInstance -ResourceURI winrm/config/Listener `
        -SelectorSet @{ Address = '*'; Transport = 'HTTP' } -ErrorAction SilentlyContinue

    if (-not $httpListener) {
        New-WSManInstance -ResourceURI winrm/config/Listener `
            -SelectorSet @{ Address = '*'; Transport = 'HTTP' } `
            -ValueSet    @{ Enabled = 'true' } | Out-Null
        Write-Ok "HTTP listener created"
    } else {
        Set-WSManInstance -ResourceURI winrm/config/Listener `
            -SelectorSet @{ Address = '*'; Transport = 'HTTP' } `
            -ValueSet    @{ Enabled = 'true' } | Out-Null
        Write-Ok "HTTP listener already exists (ensured enabled)"
    }

    # Firewall rule
    $ruleName = 'AD-Ops WinRM HTTP (5985)'
    if (-not (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue)) {
        New-NetFirewallRule `
            -DisplayName $ruleName `
            -Description 'Allow inbound WinRM HTTP for AD-Ops remoting' `
            -Direction Inbound -Action Allow -Protocol TCP `
            -LocalPort 5985 -Profile Any | Out-Null
        Write-Ok "Firewall rule '$ruleName' created"
    } else {
        Write-Ok "Firewall rule '$ruleName' already exists"
    }
}

# ---------------------------------------------------------------------------
# Step 4 – HTTPS listener (:5986) with self-signed cert
# ---------------------------------------------------------------------------

Write-Step "Configuring HTTPS listener on port 5986"

# Find or create a self-signed cert valid for 5 years.
$existingCert = Get-ChildItem Cert:\LocalMachine\My |
    Where-Object { $_.Subject -like "*CN=$CertDnsName*" } |
    Sort-Object NotAfter -Descending |
    Select-Object -First 1

if ($existingCert -and $existingCert.NotAfter -gt (Get-Date).AddDays(30)) {
    Write-Ok "Reusing existing certificate (thumbprint $($existingCert.Thumbprint), expires $($existingCert.NotAfter.ToString('yyyy-MM-dd')))"
    $cert = $existingCert
} else {
    Write-Step "Creating self-signed certificate for '$CertDnsName'"
    $cert = New-SelfSignedCertificate `
        -DnsName         $CertDnsName `
        -CertStoreLocation Cert:\LocalMachine\My `
        -NotAfter        (Get-Date).AddYears(5) `
        -KeyUsage        KeyEncipherment, DigitalSignature `
        -FriendlyName    "AD-Ops WinRM HTTPS"
    Write-Ok "Certificate created (thumbprint $($cert.Thumbprint))"
}

$httpsListener = Get-WSManInstance -ResourceURI winrm/config/Listener `
    -SelectorSet @{ Address = '*'; Transport = 'HTTPS' } -ErrorAction SilentlyContinue

if (-not $httpsListener) {
    New-WSManInstance -ResourceURI winrm/config/Listener `
        -SelectorSet @{ Address = '*'; Transport = 'HTTPS' } `
        -ValueSet    @{ Enabled = 'true'; CertificateThumbprint = $cert.Thumbprint } | Out-Null
    Write-Ok "HTTPS listener created"
} else {
    Set-WSManInstance -ResourceURI winrm/config/Listener `
        -SelectorSet @{ Address = '*'; Transport = 'HTTPS' } `
        -ValueSet    @{ Enabled = 'true'; CertificateThumbprint = $cert.Thumbprint } | Out-Null
    Write-Ok "HTTPS listener updated (thumbprint refreshed)"
}

# Firewall rule
$httpsRuleName = 'AD-Ops WinRM HTTPS (5986)'
if (-not (Get-NetFirewallRule -DisplayName $httpsRuleName -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule `
        -DisplayName $httpsRuleName `
        -Description 'Allow inbound WinRM HTTPS for AD-Ops remoting' `
        -Direction Inbound -Action Allow -Protocol TCP `
        -LocalPort 5986 -Profile Any | Out-Null
    Write-Ok "Firewall rule '$httpsRuleName' created"
} else {
    Write-Ok "Firewall rule '$httpsRuleName' already exists"
}

# ---------------------------------------------------------------------------
# Step 5 – raise WinRM resource limits for large AD payloads
# ---------------------------------------------------------------------------

Write-Step "Tuning WinRM resource limits for large AD payloads"

# MaxEnvelopeSizekb: default 500 kB → 4 MB
Set-Item WSMan:\localhost\MaxEnvelopeSizekb 4096 -Force
# MaxMemoryPerShellMB: default 150 MB → 512 MB
Set-Item WSMan:\localhost\Shell\MaxMemoryPerShellMB 512 -Force
# Idle timeout: 4 hours (enough for long-running queries)
Set-Item WSMan:\localhost\Shell\IdleTimeoutms 14400000 -Force

Write-Ok "WinRM limits raised (envelope 4 MB, shell memory 512 MB, idle timeout 4 h)"

# ---------------------------------------------------------------------------
# Step 6 – authentication (ensure Negotiate/Kerberos; add Basic if needed)
# ---------------------------------------------------------------------------

Write-Step "Configuring WinRM authentication"

Set-Item WSMan:\localhost\Service\Auth\Negotiate $true -Force
Set-Item WSMan:\localhost\Service\Auth\Kerberos  $true -Force

# Basic auth is disabled by default on domain machines; enable only if
# the host is workgroup/not domain-joined so local accounts can connect.
$domainJoined = (Get-WmiObject Win32_ComputerSystem).PartOfDomain
if (-not $domainJoined) {
    Write-Warn "Host is not domain-joined — enabling Basic auth for local account access"
    Set-Item WSMan:\localhost\Service\Auth\Basic $true -Force
    Set-Item WSMan:\localhost\Service\AllowUnencrypted $false -Force  # HTTPS already handles encryption
}

Write-Ok "Authentication configured"

# ---------------------------------------------------------------------------
# Step 7 – add TrustedHosts on this machine (client-side, optional)
# ---------------------------------------------------------------------------

if ($AddTrustedHosts) {
    Write-Step "Adding TrustedHosts: $AddTrustedHosts"
    $current = (Get-Item WSMan:\localhost\Client\TrustedHosts).Value
    $toAdd   = $AddTrustedHosts -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' }

    foreach ($h in $toAdd) {
        if ($current -notmatch [regex]::Escape($h)) {
            $current = if ($current) { "$current,$h" } else { $h }
        }
    }

    Set-Item WSMan:\localhost\Client\TrustedHosts -Value $current -Force
    Write-Ok "TrustedHosts: $((Get-Item WSMan:\localhost\Client\TrustedHosts).Value)"
}

# ---------------------------------------------------------------------------
# Step 8 – restart WinRM to apply all changes
# ---------------------------------------------------------------------------

Write-Step "Restarting WinRM service to apply changes"
Restart-Service WinRM -Force
Write-Ok "WinRM restarted"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

$ip = (Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.PrefixOrigin -ne 'WellKnown' } |
    Sort-Object InterfaceMetric |
    Select-Object -First 1 -ExpandProperty IPAddress)

Write-Host ""
Write-Host "PowerShell Remoting is ready." -ForegroundColor Green
Write-Host ""
Write-Host "Host IP  : $ip"
Write-Host "DNS name : $CertDnsName"
Write-Host ""

if (-not $HttpsOnly) {
    Write-Host "Test from the AD-Ops server (HTTP, plain LAN):" -ForegroundColor Yellow
    Write-Host "  `$c = Get-Credential"
    Write-Host "  Invoke-Command -ComputerName $ip -Credential `$c -ScriptBlock { hostname }"
    Write-Host ""
}

Write-Host "Test from the AD-Ops server (HTTPS, self-signed cert):" -ForegroundColor Yellow
Write-Host "  `$c   = Get-Credential"
Write-Host "  `$opt = New-PSSessionOption -SkipCACheck -SkipCNCheck -SkipRevocationCheck"
Write-Host "  Invoke-Command -ComputerName $ip -Credential `$c -UseSSL -Port 5986 -SessionOption `$opt -ScriptBlock { hostname }"
Write-Host ""
Write-Host "In AD-Ops, add this host as a domain with:" -ForegroundColor Yellow
Write-Host "  DC = $ip   (or the FQDN: $CertDnsName)"
Write-Host "  Use SSL = true   Port = 5986  (or HTTP port = 5985)"
