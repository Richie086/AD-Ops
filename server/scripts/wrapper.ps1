# wrapper.ps1
# Reads a JSON payload from stdin.
#
# Default mode: { DC, User, Pass, Script, Args }
#   Opens a remote session to DC (string or array) with the supplied
#   credential and runs Script there, passing Args as positional params.
#   NOTE: if DC is an array and ANY target errors, the whole call fails —
#   this mode is for single-target queries (e.g. against one DC).
#
# Per-target mode: { Mode: "perTarget", Targets, User, Pass, Script }
#   Runs Script against each target independently, in its own try/catch,
#   so one bad host doesn't abort the others. Result is always an array of
#   { Target, Success, Output, Error } — check Success per item.
#
# Both modes emit ONE line "===JSON===" followed by JSON output, so the
# caller can split structured data from any preceding warnings on stdout.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Write-JsonResult {
    param([object]$Payload)
    $json = if ($null -eq $Payload) { '[]' } else { $Payload | ConvertTo-Json -Depth 8 -Compress -EnumerateCollection }
    Write-Output ("===JSON===`n" + $json)
}

$raw = [Console]::In.ReadToEnd()
$data = $raw | ConvertFrom-Json

if ($data.Mode -eq 'perTarget') {
    $secpass = ConvertTo-SecureString $data.Pass -AsPlainText -Force
    $cred = New-Object System.Management.Automation.PSCredential($data.User, $secpass)
    $sb = [ScriptBlock]::Create($data.Script)
    $sessionOpt = New-PSSessionOption -OperationTimeout 60000 -OpenTimeout 30000

    $results = foreach ($t in $data.Targets) {
        try {
            $out = Invoke-Command -ComputerName $t -Credential $cred -ScriptBlock $sb -SessionOption $sessionOpt -ErrorAction Stop
            [PSCustomObject]@{
                Target  = $t
                Success = $true
                Output  = if ($null -eq $out) { '' } else { ($out | Out-String).Trim() }
                Error   = $null
            }
        } catch {
            [PSCustomObject]@{
                Target  = $t
                Success = $false
                Output  = $null
                Error   = $_.Exception.Message
            }
        }
    }

    Write-JsonResult $results
    exit 0
}

try {
    $secpass = ConvertTo-SecureString $data.Pass -AsPlainText -Force
    $cred = New-Object System.Management.Automation.PSCredential($data.User, $secpass)

    $sb = [ScriptBlock]::Create($data.Script)

    $sessionOpt = New-PSSessionOption -OperationTimeout 60000 -OpenTimeout 30000

    $params = @{
        ComputerName  = $data.DC
        Credential    = $cred
        ScriptBlock   = $sb
        SessionOption = $sessionOpt
        ErrorAction   = 'Stop'
    }
    if ($data.Args) {
        $params.ArgumentList = $data.Args
    }

    $result = Invoke-Command @params -WarningAction SilentlyContinue
    Write-JsonResult $result
}
catch {
    Write-JsonResult @{ error = $true; message = $_.Exception.Message }
    exit 1
}
