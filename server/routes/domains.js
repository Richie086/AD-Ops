const express = require('express');
const { db, logAudit } = require('../db');
const { setCreds, getCreds, clearCreds } = require('../credCache');
const { runRemote } = require('../psRunner');
const { requireRole } = require('../middleware/roles');

const router = express.Router();

router.get('/', (req, res) => {
  const domains = db.prepare('SELECT id, label, dc_host, use_ssl, notes, created_at, last_used FROM domains ORDER BY label').all();
  res.json(domains);
});

router.post('/', requireRole(['operator', 'admin']), (req, res) => {
  const { label, dcHost, notes } = req.body || {};
  if (!label || !dcHost) return res.status(400).json({ error: 'label and dcHost are required' });
  const result = db.prepare('INSERT INTO domains (label, dc_host, notes) VALUES (?, ?, ?)').run(label, dcHost, notes || null);
  logAudit(req.session.username, label, 'domain_saved', dcHost);
  res.json({ id: result.lastInsertRowid, label, dcHost, notes });
});

router.delete('/:id', requireRole(['operator', 'admin']), (req, res) => {
  const domain = db.prepare('SELECT * FROM domains WHERE id = ?').get(req.params.id);
  db.prepare('DELETE FROM domains WHERE id = ?').run(req.params.id);
  if (domain) logAudit(req.session.username, domain.label, 'domain_deleted', domain.dc_host);
  res.json({ ok: true });
});

// Validate domain admin credentials against the target and cache them
// in-memory for this browser session (never persisted to disk).
router.post('/:id/connect', async (req, res) => {
  const domain = db.prepare('SELECT * FROM domains WHERE id = ?').get(req.params.id);
  if (!domain) return res.status(404).json({ error: 'Domain not found' });

  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });

  const result = await runRemote(domain.dc_host, username, password, 'Get-ADDomain | Select-Object DNSRoot,NetBIOSName,DomainMode');

  if (!result.ok) {
    return res.status(401).json({ error: result.error || 'Could not authenticate to domain', raw: result.raw, command: result.command });
  }

  setCreds(req.sessionID, domain.id, username, password);
  db.prepare("UPDATE domains SET last_used = datetime('now') WHERE id = ?").run(domain.id);
  logAudit(req.session.username, domain.label, 'domain_connected', username);

  res.json({ ok: true, domainInfo: result.data, raw: result.raw, command: result.command });
});

router.post('/:id/disconnect', (req, res) => {
  clearCreds(req.sessionID);
  res.json({ ok: true });
});

// Helper used by other route modules to fetch the active credential for a domain.
function requireDomainSession(req, res, domainId) {
  const creds = getCreds(req.sessionID, Number(domainId));
  if (!creds) {
    res.status(440).json({ error: 'No active domain session. Connect with domain admin credentials first.' });
    return null;
  }
  return creds;
}

module.exports = router;
module.exports.requireDomainSession = requireDomainSession;
