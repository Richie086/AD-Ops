const express = require('express');
const { db, logAudit, recordHistory } = require('../db');
const { runRemote, psEscapeLiteral } = require('../psRunner');
const { requireDomainSession } = require('./domains');

const router = express.Router();

function getDomain(id) {
  return db.prepare('SELECT * FROM domains WHERE id = ?').get(id);
}

function titleFromLabel(actionLabel) {
  return actionLabel.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

async function runQuery(req, res, scriptBody, args, actionLabel) {
  const { domainId } = req.body || {};
  const domain = getDomain(domainId);
  if (!domain) return res.status(404).json({ error: 'Domain not found' });

  const creds = requireDomainSession(req, res, domainId);
  if (!creds) return;

  const result = await runRemote(domain.dc_host, creds.username, creds.password, scriptBody, args);
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
    param($q)
    Import-Module ActiveDirectory
    Get-ADUser -Filter "Name -like '$q' -or SamAccountName -like '$q'" -Properties DisplayName,EmailAddress,Enabled,LastLogonDate,Title,Department,Description |
      Select-Object Name,SamAccountName,DisplayName,EmailAddress,Enabled,Title,Department,LastLogonDate,Description
  `;
  runQuery(req, res, script, [`*${filterVal.replace(/\*/g, '')}*`], 'query_users');
});

router.post('/groups', (req, res) => {
  const { query } = req.body || {};
  const filterVal = query && query.trim() ? query.trim() : '*';
  const script = `
    param($q)
    Import-Module ActiveDirectory
    Get-ADGroup -Filter "Name -like '$q'" -Properties Description,GroupCategory,GroupScope,Members |
      Select-Object Name,SamAccountName,GroupCategory,GroupScope,Description,@{N='MemberCount';E={($_.Members).Count}}
  `;
  runQuery(req, res, script, [`*${filterVal.replace(/\*/g, '')}*`], 'query_groups');
});

router.post('/computers', (req, res) => {
  const { query } = req.body || {};
  const filterVal = query && query.trim() ? query.trim() : '*';
  const script = `
    param($q)
    Import-Module ActiveDirectory
    Get-ADComputer -Filter "Name -like '$q'" -Properties OperatingSystem,OperatingSystemVersion,LastLogonDate,Enabled,IPv4Address |
      Select-Object Name,DNSHostName,OperatingSystem,OperatingSystemVersion,Enabled,IPv4Address,LastLogonDate
  `;
  runQuery(req, res, script, [`*${filterVal.replace(/\*/g, '')}*`], 'query_computers');
});

// Direct (non-recursive) group membership.
router.post('/membership', (req, res) => {
  const { groupName } = req.body || {};
  if (!groupName) return res.status(400).json({ error: 'groupName is required' });
  const script = `
    param($g)
    Import-Module ActiveDirectory
    Get-ADGroupMember -Identity $g |
      Select-Object Name,SamAccountName,objectClass,distinguishedName
  `;
  runQuery(req, res, script, [groupName], 'group_membership');
});

// Fully recursive/nested group membership, flattened with a Depth marker
// and de-duplicated so circular/nested groups don't loop.
router.post('/nested-membership', (req, res) => {
  const { groupName } = req.body || {};
  if (!groupName) return res.status(400).json({ error: 'groupName is required' });
  const script = `
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
                Name         = $m.Name
                SamAccountName = $m.SamAccountName
                objectClass  = $m.objectClass
                Depth        = $depth
                ViaGroup     = $path
            })
            if ($m.objectClass -eq 'group') {
                Resolve-Members $m.SamAccountName ($depth + 1) "$path > $($m.Name)"
            }
        }
    }

    Resolve-Members $g 1 $g
    $results
  `;
  runQuery(req, res, script, [groupName], 'nested_group_membership');
});

// Which groups a user or computer belongs to, including nested (indirect) membership.
router.post('/principal-groups', (req, res) => {
  const { principal } = req.body || {};
  if (!principal) return res.status(400).json({ error: 'principal is required' });
  const script = `
    param($p)
    Import-Module ActiveDirectory
    Get-ADPrincipalGroupMembership -Identity $p |
      Select-Object Name,SamAccountName,GroupCategory,GroupScope
  `;
  runQuery(req, res, script, [principal], 'principal_group_membership');
});

router.post('/gpo', (req, res) => {
  const script = `
    Import-Module GroupPolicy
    Get-GPO -All | Select-Object DisplayName,Id,GpoStatus,CreationTime,ModificationTime,Owner
  `;
  runQuery(req, res, script, [], 'query_gpo_list');
});

router.post('/gpo-report', (req, res) => {
  const { gpoName } = req.body || {};
  if (!gpoName) return res.status(400).json({ error: 'gpoName is required' });
  const script = `
    param($name)
    Import-Module GroupPolicy
    $xml = Get-GPOReport -Name $name -ReportType Xml
    [PSCustomObject]@{ Name = $name; ReportXml = $xml }
  `;
  runQuery(req, res, script, [gpoName], 'gpo_report');
});

module.exports = router;
