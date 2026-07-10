const express = require('express');
const { db, logAudit, recordHistory } = require('../db');
const { runRemote, psEscapeLiteral } = require('../psRunner');
const { requireDomainSession } = require('./domains');
const { requireFeature } = require('../settings');
const debugLog = require('../debugLog');

const router = express.Router();

// #region agent log
function agentLog(hypothesisId, location, message, data) {
  debugLog.append({ runId: 'query-pre', hypothesisId, location, message, data });
}
// #endregion

// Prepended to AD query scripts so every attribute serializes cleanly to JSON.
const AD_SERIALIZE_HELPER = `
function ConvertTo-ExportableObject {
    param([Parameter(ValueFromPipeline = $true)]$InputObject)
    begin {
        function Convert-PropertyValue($v) {
            if ($null -eq $v) { return $null }
            if ($v -is [byte[]]) { return [Convert]::ToBase64String($v) }
            if ($v -is [datetime]) { return $v.ToString('o') }
            if ($v -is [guid]) { return $v.ToString() }
            if ($v -is [System.Security.Principal.SecurityIdentifier]) { return $v.Value }
            if ($v -is [System.Collections.IEnumerable] -and -not ($v -is [string])) {
                return @($v | ForEach-Object { Convert-PropertyValue $_ })
            }
            return $v
        }
    }
    process {
        if ($null -eq $InputObject) { return $null }
        $props = @{}
        foreach ($prop in $InputObject.PSObject.Properties) {
            if ($prop.Name -match '^(?:PS|CLR|Runspace)') { continue }
            $props[$prop.Name] = Convert-PropertyValue $prop.Value
        }
        $dn = $null
        if ($props.ContainsKey('DistinguishedName')) {
            $dn = $props['DistinguishedName']
            $props.Remove('DistinguishedName')
        }
        elseif ($props.ContainsKey('distinguishedName')) {
            $dn = $props['distinguishedName']
            $props.Remove('distinguishedName')
        }
        elseif ($InputObject.DistinguishedName) {
            $dn = $InputObject.DistinguishedName
        }
        $out = [ordered]@{}
        if ($dn) { $out['DistinguishedName'] = $dn }
        foreach ($key in ($props.Keys | Sort-Object)) {
            $out[$key] = $props[$key]
        }
        [PSCustomObject]$out
    }
}

function Convert-GpoToExportableObject {
    param(
        [Parameter(ValueFromPipeline = $true)]$Gpo,
        [string]$DomainDn
    )
    process {
        $obj = $Gpo | ConvertTo-ExportableObject
        if (-not $DomainDn) { return $obj }
        $dn = "CN={$($Gpo.Id)},CN=Policies,CN=System,$DomainDn"
        $out = [ordered]@{ DistinguishedName = $dn }
        foreach ($prop in $obj.PSObject.Properties) {
            if ($prop.Name -ne 'DistinguishedName') { $out[$prop.Name] = $prop.Value }
        }
        [PSCustomObject]$out
    }
}
`.trim();

function getDomain(id) {
  return db.prepare('SELECT * FROM domains WHERE id = ?').get(id);
}

function titleFromLabel(actionLabel) {
  return actionLabel.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

async function runQuery(req, res, scriptBody, args, actionLabel) {
  const { domainId } = req.body || {};
  // #region agent log
  agentLog('H2', 'ad.js:runQuery:entry', 'AD query received', { actionLabel, domainId, path: req.path, hasSession: !!(req.session && req.session.userId), sessionIdLen: req.sessionID ? String(req.sessionID).length : 0 });
  // #endregion
  const domain = getDomain(domainId);
  if (!domain) return res.status(404).json({ error: 'Domain not found' });

  const creds = requireDomainSession(req, res, domainId);
  if (!creds) {
    // #region agent log
    agentLog('H3', 'ad.js:runQuery:noCreds', 'missing domain session creds', { actionLabel, domainId });
    // #endregion
    return;
  }

  const result = await runRemote(domain.dc_host, creds.username, creds.password, scriptBody, args, { useSsl: !!domain.use_ssl });
  // #region agent log
  agentLog(result.ok ? 'H5' : 'H4', 'ad.js:runQuery:result', 'runRemote finished', { actionLabel, ok: !!result.ok, error: result.error ? String(result.error).slice(0, 300) : null, dataIsArray: Array.isArray(result.data), dataLen: Array.isArray(result.data) ? result.data.length : null });
  // #endregion
  logAudit(req.session.username, domain.label, actionLabel, JSON.stringify(args).slice(0, 500));

  const title = titleFromLabel(actionLabel);
  const payloadSummary = JSON.stringify(args).slice(0, 300);

  if (!result.ok) {
    recordHistory({
      username: req.session.username, domainLabel: domain.label, endpoint: req.path, title,
      payloadSummary, success: false, raw: result.raw, command: result.command,
    });
    return res.status(502).json({ error: result.error, raw: result.raw, command: result.command });
  }
  recordHistory({
    username: req.session.username, domainLabel: domain.label, endpoint: req.path, title,
    payloadSummary, success: true, data: result.data, raw: result.raw, command: result.command,
  });
  res.json({ data: result.data, raw: result.raw, command: result.command });
}

router.post('/users', (req, res) => {
  const { query } = req.body || {};
  const filterVal = query && query.trim() ? query.trim() : '*';
  const script = `
    ${AD_SERIALIZE_HELPER}
    param($q)
    Import-Module ActiveDirectory
    Get-ADUser -Filter "Name -like '$q' -or SamAccountName -like '$q'" -Properties * |
      ConvertTo-ExportableObject
  `;
  runQuery(req, res, script, [`*${filterVal.replace(/\*/g, '')}*`], 'query_users');
});

router.post('/groups', (req, res) => {
  const { query } = req.body || {};
  const filterVal = query && query.trim() ? query.trim() : '*';
  const script = `
    ${AD_SERIALIZE_HELPER}
    param($q)
    Import-Module ActiveDirectory
    Get-ADGroup -Filter "Name -like '$q' -or SamAccountName -like '$q'" -Properties * |
      ConvertTo-ExportableObject
  `;
  runQuery(req, res, script, [`*${filterVal.replace(/\*/g, '')}*`], 'query_groups');
});

router.post('/computers', (req, res) => {
  const { query } = req.body || {};
  const filterVal = query && query.trim() ? query.trim() : '*';
  const script = `
    ${AD_SERIALIZE_HELPER}
    param($q)
    Import-Module ActiveDirectory
    Get-ADComputer -Filter "Name -like '$q' -or SamAccountName -like '$q'" -Properties * |
      ConvertTo-ExportableObject
  `;
  runQuery(req, res, script, [`*${filterVal.replace(/\*/g, '')}*`], 'query_computers');
});

// Direct (non-recursive) group membership.
router.post('/membership', (req, res) => {
  const { groupName } = req.body || {};
  if (!groupName) return res.status(400).json({ error: 'groupName is required' });
  const script = `
    ${AD_SERIALIZE_HELPER}
    param($g)
    Import-Module ActiveDirectory
    Get-ADGroupMember -Identity $g | ForEach-Object {
        switch ($_.objectClass) {
            'group' { Get-ADGroup -Identity $_.DistinguishedName -Properties * }
            'user' { Get-ADUser -Identity $_.DistinguishedName -Properties * }
            'computer' { Get-ADComputer -Identity $_.DistinguishedName -Properties * }
            default { $_ }
        }
    } | ConvertTo-ExportableObject
  `;
  runQuery(req, res, script, [groupName], 'group_membership');
});

// Compare direct or nested membership between two groups.
router.post('/group-compare', requireFeature('groupCompare'), (req, res) => {
  const { groupA, groupB, includeNested } = req.body || {};
  if (!groupA || !groupB) {
    return res.status(400).json({ error: 'groupA and groupB are required' });
  }
  const nested = !!includeNested;
  const script = `
    ${AD_SERIALIZE_HELPER}
    param($gA, $gB, [bool]$IncludeNested)

    Import-Module ActiveDirectory

    function Get-MemberKey($m) {
        if ($m.DistinguishedName) { return [string]$m.DistinguishedName }
        return "$($m.objectClass):$($m.SamAccountName)"
    }

    function Resolve-MemberObject($m) {
        switch ($m.objectClass) {
            'group' { Get-ADGroup -Identity $m.DistinguishedName -Properties DistinguishedName,Name,SamAccountName,objectClass }
            'user' { Get-ADUser -Identity $m.DistinguishedName -Properties DistinguishedName,Name,SamAccountName,objectClass }
            'computer' { Get-ADComputer -Identity $m.DistinguishedName -Properties DistinguishedName,Name,SamAccountName,objectClass }
            default { $m }
        }
    }

    function Get-DirectMemberMap($groupIdentity) {
        $map = @{}
        Get-ADGroupMember -Identity $groupIdentity -ErrorAction Stop | ForEach-Object {
            $obj = Resolve-MemberObject $_
            $map[(Get-MemberKey $obj)] = $obj
        }
        return $map
    }

    function Get-NestedMemberMap($groupIdentity) {
        $map = @{}
        $seen = New-Object System.Collections.Generic.HashSet[string]

        function Resolve-Members($gi, $depth, $path) {
            $members = Get-ADGroupMember -Identity $gi -ErrorAction SilentlyContinue
            foreach ($m in $members) {
                $key = Get-MemberKey $m
                if ($seen.Contains($key)) { continue }
                $seen.Add($key) | Out-Null
                $map[$key] = [PSCustomObject]@{
                    DistinguishedName = $m.DistinguishedName
                    Name              = $m.Name
                    SamAccountName    = $m.SamAccountName
                    objectClass       = $m.objectClass
                    Depth             = $depth
                    ViaGroup          = $path
                }
                if ($m.objectClass -eq 'group') {
                    Resolve-Members $m.SamAccountName ($depth + 1) "$path > $($m.Name)"
                }
            }
        }

        Resolve-Members $groupIdentity 1 $groupIdentity
        return $map
    }

    function Export-Member($m) {
        if ($IncludeNested) { return $m | ConvertTo-ExportableObject }
        return $m | ConvertTo-ExportableObject
    }

    $groupAInfo = Get-ADGroup -Identity $gA -Properties DistinguishedName,Name,SamAccountName
    $groupBInfo = Get-ADGroup -Identity $gB -Properties DistinguishedName,Name,SamAccountName

    if ($IncludeNested) {
        $membersA = Get-NestedMemberMap $gA
        $membersB = Get-NestedMemberMap $gB
    } else {
        $membersA = Get-DirectMemberMap $gA
        $membersB = Get-DirectMemberMap $gB
    }

    $keysA = @($membersA.Keys)
    $keysB = @($membersB.Keys)
    $setA = New-Object 'System.Collections.Generic.HashSet[string]' ([string[]]$keysA)
    $setB = New-Object 'System.Collections.Generic.HashSet[string]' ([string[]]$keysB)

    $onlyAKeys = @($keysA | Where-Object { -not $setB.Contains($_) })
    $onlyBKeys = @($keysB | Where-Object { -not $setA.Contains($_) })
    $bothKeys = @($keysA | Where-Object { $setB.Contains($_) })

  [PSCustomObject]@{
        groupA = [PSCustomObject]@{
            Name              = $groupAInfo.Name
            SamAccountName    = $groupAInfo.SamAccountName
            DistinguishedName = $groupAInfo.DistinguishedName
            MemberCount       = $keysA.Count
        }
        groupB = [PSCustomObject]@{
            Name              = $groupBInfo.Name
            SamAccountName    = $groupBInfo.SamAccountName
            DistinguishedName = $groupBInfo.DistinguishedName
            MemberCount       = $keysB.Count
        }
        includeNested = [bool]$IncludeNested
        summary = [PSCustomObject]@{
            onlyInA = $onlyAKeys.Count
            onlyInB = $onlyBKeys.Count
            inBoth  = $bothKeys.Count
            totalA  = $keysA.Count
            totalB  = $keysB.Count
        }
        onlyInA = @($onlyAKeys | ForEach-Object { Export-Member $membersA[$_] })
        onlyInB = @($onlyBKeys | ForEach-Object { Export-Member $membersB[$_] })
        inBoth  = @($bothKeys | Sort-Object | ForEach-Object {
            $fromA = Export-Member $membersA[$_]
            $fromB = Export-Member $membersB[$_]
            if ($IncludeNested) {
                [PSCustomObject]@{
                    DistinguishedName = $fromA.DistinguishedName
                    Name              = $fromA.Name
                    SamAccountName    = $fromA.SamAccountName
                    objectClass       = $fromA.objectClass
                    DepthInA          = $fromA.Depth
                    ViaGroupA         = $fromA.ViaGroup
                    DepthInB          = $fromB.Depth
                    ViaGroupB         = $fromB.ViaGroup
                }
            } else {
                $fromA
            }
        })
    }
  `;
  runQuery(req, res, script, [groupA, groupB, nested], 'group_compare');
});

// Fully recursive/nested group membership, flattened with a Depth marker
// and de-duplicated so circular/nested groups don't loop.
router.post('/nested-membership', (req, res) => {
  const { groupName } = req.body || {};
  if (!groupName) return res.status(400).json({ error: 'groupName is required' });
  const script = `
    ${AD_SERIALIZE_HELPER}
    param($g)
    Import-Module ActiveDirectory

    $seen = New-Object System.Collections.Generic.HashSet[string]
    $results = New-Object System.Collections.ArrayList

    function Resolve-Members($groupIdentity, $depth, $path) {
        $members = Get-ADGroupMember -Identity $groupIdentity -ErrorAction SilentlyContinue
        foreach ($m in $members) {
            $key = "$($m.objectClass):$($m.SamAccountName)"
            if ($seen.Contains($key)) { continue }
            $seen.Add($key) | Out-Null
            [void]$results.Add([PSCustomObject]@{
                DistinguishedName = $m.DistinguishedName
                Name              = $m.Name
                SamAccountName    = $m.SamAccountName
                objectClass       = $m.objectClass
                Depth             = $depth
                ViaGroup          = $path
            })
            if ($m.objectClass -eq 'group') {
                Resolve-Members $m.SamAccountName ($depth + 1) "$path > $($m.Name)"
            }
        }
    }

    Resolve-Members $g 1 $g
    $results | ConvertTo-ExportableObject
  `;
  runQuery(req, res, script, [groupName], 'nested_group_membership');
});

// Which groups a user or computer belongs to, including nested (indirect) membership.
router.post('/principal-groups', (req, res) => {
  const { principal } = req.body || {};
  if (!principal) return res.status(400).json({ error: 'principal is required' });
  const script = `
    ${AD_SERIALIZE_HELPER}
    param($p)
    Import-Module ActiveDirectory
    Get-ADPrincipalGroupMembership -Identity $p | ForEach-Object {
        Get-ADGroup -Identity $_ -Properties * | ConvertTo-ExportableObject
    }
  `;
  runQuery(req, res, script, [principal], 'principal_group_membership');
});

router.post('/gpo', (req, res) => {
  const script = `
    ${AD_SERIALIZE_HELPER}
    Import-Module ActiveDirectory, GroupPolicy
    $domainDn = (Get-ADDomain).DistinguishedName
    Get-GPO -All | Convert-GpoToExportableObject -DomainDn $domainDn
  `;
  runQuery(req, res, script, [], 'query_gpo_list');
});

router.post('/gpo-report', requireFeature('gpoReports'), (req, res) => {
  const { gpoName } = req.body || {};
  if (!gpoName) return res.status(400).json({ error: 'gpoName is required' });
  const script = `
    ${AD_SERIALIZE_HELPER}
    param($name)
    Import-Module ActiveDirectory, GroupPolicy
    $domainDn = (Get-ADDomain).DistinguishedName
    $gpo = Get-GPO -Name $name
    $xml = Get-GPOReport -Name $name -ReportType Xml
    [PSCustomObject]@{
        DistinguishedName = "CN={$($gpo.Id)},CN=Policies,CN=System,$domainDn"
        Gpo = ($gpo | Convert-GpoToExportableObject -DomainDn $domainDn)
        ReportXml = $xml
    }
  `;
  runQuery(req, res, script, [gpoName], 'gpo_report');
});

router.post('/ou-tree', requireFeature('ouTree'), (req, res) => {
  const { root } = req.body || {};
  const script = `
    param($root)
    Import-Module ActiveDirectory

    function Get-ParentDn([string]$dn) {
        $comma = $dn.IndexOf(',')
        if ($comma -lt 0) { return $null }
        return $dn.Substring($comma + 1)
    }

    $domain = Get-ADDomain
    $searchBase = $domain.DistinguishedName
    $rootName = $domain.DNSRoot
    $rootClass = 'domain'

    if ($root -and $root.Trim()) {
        $ou = Get-ADOrganizationalUnit -Identity $root.Trim()
        $searchBase = $ou.DistinguishedName
        $rootName = $ou.Name
        $rootClass = 'organizationalUnit'
    }

    $nodes = [System.Collections.ArrayList]@()
    [void]$nodes.Add([PSCustomObject]@{
        DistinguishedName = $searchBase
        Name = $rootName
        Description = $null
        ParentDistinguishedName = $null
        objectClass = $rootClass
    })

    Get-ADOrganizationalUnit -Filter * -SearchBase $searchBase -SearchScope Subtree -Properties DistinguishedName,Name,Description |
        ForEach-Object {
            if ($_.DistinguishedName -eq $searchBase) { return }
            [void]$nodes.Add([PSCustomObject]@{
                DistinguishedName = $_.DistinguishedName
                Name = $_.Name
                Description = $_.Description
                ParentDistinguishedName = (Get-ParentDn $_.DistinguishedName)
                objectClass = 'organizationalUnit'
            })
        }

    $nodes
  `;
  runQuery(req, res, script, [root || ''], 'query_ou_tree');
});

// Drill into a single AD/GPO object and return full properties plus related data.
router.post('/object', requireFeature('drillDown'), (req, res) => {
  const { domainId, distinguishedName, objectClass, identity } = req.body || {};
  if (!domainId) return res.status(400).json({ error: 'domainId is required' });
  if (!distinguishedName && !identity) {
    return res.status(400).json({ error: 'distinguishedName or identity is required' });
  }

  const script = `
    ${AD_SERIALIZE_HELPER}
    param($dn, $class, $identity)
    Import-Module ActiveDirectory, GroupPolicy

    function Get-FullDirectoryObject {
        param($dn, $class, $identity)
        if ($dn -and $dn -match ',CN=Policies,CN=System,') {
            $gpoId = ($dn -replace '^CN=\\{?([^,}]+)\\}?,CN=Policies,CN=System,.*$', '$1')
            $gpo = Get-GPO -Guid $gpoId
            $domainDn = (Get-ADDomain).DistinguishedName
            $xml = Get-GPOReport -Guid $gpoId -ReportType Xml
            return [PSCustomObject]@{
                DistinguishedName = "CN={$($gpo.Id)},CN=Policies,CN=System,$domainDn"
                ObjectClass = 'gpo'
                Gpo = ($gpo | Convert-GpoToExportableObject -DomainDn $domainDn)
                ReportXml = $xml
            }
        }
        $resolvedClass = $class
        if (-not $resolvedClass -and $dn) {
            $resolvedClass = (Get-ADObject -Identity $dn -Properties objectClass).objectClass
        }
        switch ($resolvedClass) {
            'user' {
                if ($dn) { return Get-ADUser -Identity $dn -Properties * }
                return Get-ADUser -Identity $identity -Properties *
            }
            'group' {
                if ($dn) { return Get-ADGroup -Identity $dn -Properties * }
                return Get-ADGroup -Identity $identity -Properties *
            }
            'computer' {
                if ($dn) { return Get-ADComputer -Identity $dn -Properties * }
                return Get-ADComputer -Identity $identity -Properties *
            }
            'organizationalUnit' {
                if ($dn) { return Get-ADOrganizationalUnit -Identity $dn -Properties * }
                return Get-ADOrganizationalUnit -Identity $identity -Properties *
            }
            default {
                if ($dn) { return Get-ADObject -Identity $dn -Properties * }
                return Get-ADObject -Identity $identity -Properties *
            }
        }
    }

    $obj = Get-FullDirectoryObject -dn $dn -class $class -identity $identity
    $exported = if ($obj.ObjectClass -eq 'gpo') { $obj } else { $obj | ConvertTo-ExportableObject }
    $className = if ($obj.ObjectClass) { $obj.ObjectClass } elseif ($obj.objectClass) { $obj.objectClass } else { $class }
    $lookup = if ($dn) { $dn } elseif ($exported.DistinguishedName) { $exported.DistinguishedName } else { $identity }

    $related = [ordered]@{}
    if ($className -eq 'group') {
        $related.members = @(Get-ADGroupMember -Identity $lookup -ErrorAction SilentlyContinue | ForEach-Object {
            [PSCustomObject]@{
                DistinguishedName = $_.DistinguishedName
                Name = $_.Name
                SamAccountName = $_.SamAccountName
                objectClass = $_.objectClass
            }
        })
    }
    elseif ($className -eq 'user' -or $className -eq 'computer') {
        $related.groups = @(Get-ADPrincipalGroupMembership -Identity $lookup -ErrorAction SilentlyContinue | ForEach-Object {
            Get-ADGroup -Identity $_ -Properties DistinguishedName,Name,SamAccountName,GroupCategory,GroupScope |
                ConvertTo-ExportableObject
        })
    }

    [PSCustomObject]@{
        object = $exported
        related = [PSCustomObject]$related
    }
  `;

  runQuery(req, res, script, [distinguishedName || '', objectClass || '', identity || ''], 'object_detail');
});

module.exports = router;
