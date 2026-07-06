const express = require('express');
const crypto = require('crypto');
const { db, logAudit, recordHistory } = require('../db');
const { runPerTarget } = require('../psRunner');
const { requireDomainSession } = require('./domains');

const router = express.Router();

function getDomain(id) {
  return db.prepare('SELECT * FROM domains WHERE id = ?').get(id);
}

// Deploy/execute an arbitrary script body on one or more target computers,
// each isolated so one unreachable/erroring host doesn't sink the batch.
// Returns a per-target pass/fail summary: [{Target, Success, Output, Error}].
router.post('/deploy', async (req, res) => {
  const { domainId, targets, scriptContent } = req.body || {};
  if (!domainId || !Array.isArray(targets) || targets.length === 0 || !scriptContent) {
    return res.status(400).json({ error: 'domainId, targets (non-empty array), and scriptContent are required' });
  }

  const domain = getDomain(domainId);
  if (!domain) return res.status(404).json({ error: 'Domain not found' });

  const creds = requireDomainSession(req, res, domainId);
  if (!creds) return;

  const result = await runPerTarget(targets, creds.username, creds.password, scriptContent);

  const scriptHash = crypto.createHash('sha256').update(scriptContent).digest('hex').slice(0, 16);
  logAudit(req.session.username, domain.label, 'script_deploy', `targets=${targets.join(',')} sha256=${scriptHash}`);

  const title = `Script Deploy (${targets.length} target${targets.length > 1 ? 's' : ''})`;

  if (!result.ok) {
    recordHistory({
      username: req.session.username, domainLabel: domain.label, endpoint: '/api/scripts/deploy',
      title, payloadSummary: `targets=${targets.join(',')}`, success: false, raw: result.raw, command: result.command,
    });
    return res.status(502).json({ error: result.error, raw: result.raw, command: result.command });
  }

  const perTargetSuccessCount = Array.isArray(result.data) ? result.data.filter((r) => r.Success).length : 0;
  const overallSuccess = Array.isArray(result.data) && perTargetSuccessCount === result.data.length;

  recordHistory({
    username: req.session.username, domainLabel: domain.label, endpoint: '/api/scripts/deploy',
    title, payloadSummary: `targets=${targets.join(',')} (${perTargetSuccessCount}/${targets.length} succeeded)`,
    success: overallSuccess, data: result.data, raw: result.raw, command: result.command,
  });

  res.json({ data: result.data, raw: result.raw, command: result.command });
});

module.exports = router;
