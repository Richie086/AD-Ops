const express = require('express');
const { db, logAudit, recordHistory } = require('../db');
const { runRemote } = require('../psRunner');
const { requireDomainSession } = require('./domains');

const router = express.Router();

function getDomain(id) {
  return db.prepare('SELECT * FROM domains WHERE id = ?').get(id);
}

// Uses WMI/DCOM (port 135 + dynamic RPC), not WinRM, to reach the target —
// so this works even on machines where PS remoting isn't enabled yet.
// The call is relayed via the domain controller we're already connected to.
router.post('/configure', async (req, res) => {
  const { domainId, target, action } = req.body || {};
  if (!domainId || !target || !['enable', 'disable', 'status'].includes(action)) {
    return res.status(400).json({ error: 'domainId, target, and action (enable|disable|status) are required' });
  }

  const domain = getDomain(domainId);
  if (!domain) return res.status(404).json({ error: 'Domain not found' });

  const creds = requireDomainSession(req, res, domainId);
  if (!creds) return;

  let script;
  if (action === 'status') {
    script = `
      param($target, $user, $pass)
      $sec = ConvertTo-SecureString $pass -AsPlainText -Force
      $cred = New-Object System.Management.Automation.PSCredential($user, $sec)
      Get-WmiObject Win32_Service -ComputerName $target -Credential $cred -Filter "Name='WinRM'" |
        Select-Object Name,DisplayName,State,StartMode
    `;
  } else {
    script = `
      param($target, $user, $pass, $cmd)
      $sec = ConvertTo-SecureString $pass -AsPlainText -Force
      $cred = New-Object System.Management.Automation.PSCredential($user, $sec)
      $r = Invoke-WmiMethod -Class Win32_Process -Name Create -ComputerName $target -Credential $cred -ArgumentList $cmd
      [PSCustomObject]@{ Target = $target; ProcessId = $r.ProcessId; ReturnValue = $r.ReturnValue }
    `;
  }

  const remoteCmd = action === 'enable'
    ? 'powershell -NoProfile -Command "Enable-PSRemoting -Force -SkipNetworkProfileCheck"'
    : action === 'disable'
      ? 'powershell -NoProfile -Command "Disable-PSRemoting -Force"'
      : null;

  const args = action === 'status'
    ? [target, creds.username, creds.password]
    : [target, creds.username, creds.password, remoteCmd];

  const result = await runRemote(domain.dc_host, creds.username, creds.password, script, args);
  logAudit(req.session.username, domain.label, 'ps_remoting_' + action, target);

  const title = `PS Remoting: ${action} (${target})`;
  if (!result.ok) {
    recordHistory({
      username: req.session.username, domainLabel: domain.label, endpoint: '/api/remoting/configure', title,
      payloadSummary: `target=${target} action=${action}`, success: false, raw: result.raw, command: result.command,
    });
    return res.status(502).json({ error: result.error, raw: result.raw, command: result.command });
  }
  recordHistory({
    username: req.session.username, domainLabel: domain.label, endpoint: '/api/remoting/configure', title,
    payloadSummary: `target=${target} action=${action}`, success: true, data: result.data, raw: result.raw, command: result.command,
  });
  res.json({ data: result.data, raw: result.raw, command: result.command });
});

module.exports = router;
