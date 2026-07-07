function Ensure-WindowsPowerShell {
    param([hashtable]$ScriptBoundParameters = @{})

    if ($env:ADOPS_USE_WINPS -eq '1') {
        Remove-Item Env:ADOPS_USE_WINPS -ErrorAction SilentlyContinue
        return
    }

    if ($PSVersionTable.PSVersion.Major -lt 6) {
        return
    }

    $winPs = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
    if (-not (Test-Path -LiteralPath $winPs)) {
        throw "Windows PowerShell 5.1 is required for IIS management but was not found at $winPs."
    }

    Write-Host "Re-launching under Windows PowerShell 5.1 (WebAdministration requires Windows PowerShell)." -ForegroundColor Yellow

    $argList = New-Object System.Collections.Generic.List[string]
    $argList.Add('-NoProfile')
    $argList.Add('-ExecutionPolicy')
    $argList.Add('Bypass')
    $argList.Add('-File')
    $argList.Add($PSCommandPath)

    foreach ($key in $ScriptBoundParameters.Keys) {
        $val = $ScriptBoundParameters[$key]
        if ($val -is [switch] -and $val) {
            $argList.Add("-$key")
        }
        elseif ($val -is [bool]) {
            $argList.Add("-$key")
            $argList.Add("$val")
        }
        elseif ($null -ne $val) {
            $argList.Add("-$key")
            $argList.Add("$val")
        }
    }

    $env:ADOPS_USE_WINPS = '1'
    & $winPs $argList.ToArray()
    exit $LASTEXITCODE
}
