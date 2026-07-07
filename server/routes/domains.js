const express = require('express');
const { db, logAudit } = require('../db');
const { setCreds, getCreds, clearCreds } = require('../credCache');
const { encryptSecret, decryptSecret } = require('../domainVault');
const { runRemote } = require('../psRunner');
const { requireRole } = require('../middleware/roles');
const { getSettings, isFeatureEnabled } = require('../settings');

const router = express.Router();

function getDomain(id) {
  return db.prepare('SELECT * FROM domains WHERE id = ?').get(id);
}

function getPrefs(localUsername, domainId) {
  return db.prepare('SELECT * FROM domain_user_prefs WHERE local_username = ? AND domain_id = ?')
    .get(localUsername, domainId);
}

function savePrefs(localUsername, domainId, { username, password, rememberUsername, rememberPassword }) {
  const existing = getPrefs(localUsername, domainId);
  let passwordEnc = existing?.password_enc || null;
  let passwordIv = existing?.password_iv || null;
  let passwordTag = existing?.password_tag || null;
  let rememberFlag = existing?.remember_password || 0;

  if (rememberPassword && password) {
    if (!isFeatureEnabled('savedPasswords')) {
      passwordEnc = null;
      passwordIv = null;
      passwordTag = null;
      rememberFlag = 0;
    } else {
      const enc = encryptSecret(password);
      passwordEnc = enc.data;
      passwordIv = enc.iv;
      passwordTag = enc.tag;
      rememberFlag = 1;
    }
  } else if (!rememberPassword) {
    passwordEnc = null;
    passwordIv = null;
    passwordTag = null;
    rememberFlag = 0;
  }

  const savedUsername = rememberUsername === false ? null : username;

  db.prepare(`
    INSERT INTO domain_user_prefs (local_username, domain_id, saved_username, password_enc, password_iv, password_tag, remember_password, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(local_username, domain_id) DO UPDATE SET
      saved_username = excluded.saved_username,
      password_enc = excluded.password_enc,
      password_iv = excluded.password_iv,
      password_tag = excluded.password_tag,
      remember_password = excluded.remember_password,
      updated_at = datetime('now')
  `).run(localUsername, domainId, savedUsername, passwordEnc, passwordIv, passwordTag, rememberFlag);
}

function resolvePassword(localUsername, domainId, username, password) {
  if (password) return password;
  if (!isFeatureEnabled('savedPasswords')) return null;
  const prefs = getPrefs(localUsername, domainId);
  if (!prefs?.remember_password || !prefs.password_enc) return null;
  if (prefs.saved_username && prefs.saved_username !== username) return null;
  try {
    return decryptSecret({ data: prefs.password_enc, iv: prefs.password_iv, tag: prefs.password_tag });
  } catch {
    return null;
  }
}

router.get('/', (req, res) => {
  const domains = db.prepare('SELECT id, label, dc_host, use_ssl, notes, created_at, last_used FROM domains ORDER BY label').all();
  res.json(domains);
});

router.post('/', requireRole(['operator', 'admin']), (req, res) => {
  const { label, dcHost, notes, useSsl } = req.body || {};
  if (!label || !dcHost) return res.status(400).json({ error: 'label and dcHost are required' });
  const result = db.prepare('INSERT INTO domains (label, dc_host, use_ssl, notes) VALUES (?, ?, ?, ?)')
    .run(label, dcHost, useSsl != null ? (useSsl ? 1 : 0) : (getSettings().defaults.winRmSsl ? 1 : 0), notes || null);
  logAudit(req.session.username, label, 'domain_saved', dcHost);
  res.json({ id: result.lastInsertRowid, label, dcHost, useSsl: !!useSsl, notes });
});

router.delete('/:id', requireRole(['operator', 'admin']), (req, res) => {
  const domain = getDomain(req.params.id);
  db.prepare('DELETE FROM domains WHERE id = ?').run(req.params.id);
  if (domain) logAudit(req.session.username, domain.label, 'domain_deleted', domain.dc_host);
  res.json({ ok: true });
});

router.get('/:id/prefs', (req, res) => {
  const domain = getDomain(req.params.id);
  if (!domain) return res.status(404).json({ error: 'Domain not found' });

  const prefs = getPrefs(req.session.username, domain.id);
  res.json({
    savedUsername: prefs?.saved_username || '',
    hasSavedPassword: isFeatureEnabled('savedPasswords') && !!(prefs?.remember_password && prefs?.password_enc),
    useSsl: !!domain.use_ssl,
    savedPasswordsAllowed: isFeatureEnabled('savedPasswords'),
  });
});

router.get('/:id/session', (req, res) => {
  const domain = getDomain(req.params.id);
  if (!domain) return res.status(404).json({ error: 'Domain not found' });
  const creds = getCreds(req.sessionID, Number(domain.id));
  res.json({ connected: !!creds });
});

// Validate domain admin credentials against the target and cache them
// in-memory for this browser session. Username/password may be remembered
// per local user in encrypted form when explicitly opted in.
router.post('/:id/connect', async (req, res) => {
  const domain = getDomain(req.params.id);
  if (!domain) return res.status(404).json({ error: 'Domain not found' });

  const {
    username,
    password,
    rememberUsername = true,
    rememberPassword = false,
    useSsl,
  } = req.body || {};

  if (!username) return res.status(400).json({ error: 'username is required' });
  if (rememberPassword && !isFeatureEnabled('savedPasswords')) {
    return res.status(403).json({ error: 'Saving domain passwords is disabled by an administrator.' });
  }

  const resolvedPassword = resolvePassword(req.session.username, domain.id, username, password);
  if (!resolvedPassword) {
    return res.status(400).json({ error: 'password is required' });
  }

  const useSslFlag = useSsl != null ? !!useSsl : !!domain.use_ssl;
  if (useSsl != null) {
    db.prepare('UPDATE domains SET use_ssl = ? WHERE id = ?').run(useSslFlag ? 1 : 0, domain.id);
  }

  const result = await runRemote(
    domain.dc_host,
    username,
    resolvedPassword,
    'Get-ADDomain | Select-Object DNSRoot,NetBIOSName,DomainMode',
    [],
    { useSsl: useSslFlag }
  );

  if (!result.ok) {
    return res.status(401).json({ error: result.error || 'Could not authenticate to domain', raw: result.raw, command: result.command });
  }

  setCreds(req.sessionID, domain.id, username, resolvedPassword);
  savePrefs(req.session.username, domain.id, {
    username,
    password: resolvedPassword,
    rememberUsername,
    rememberPassword,
  });
  db.prepare("UPDATE domains SET last_used = datetime('now') WHERE id = ?").run(domain.id);
  logAudit(req.session.username, domain.label, 'domain_connected', username);

  res.json({ ok: true, domainInfo: result.data, raw: result.raw, command: result.command, useSsl: useSslFlag });
});

router.post('/:id/disconnect', (req, res) => {
  clearCreds(req.sessionID);
  res.json({ ok: true });
});

router.delete('/:id/prefs', (req, res) => {
  const domain = getDomain(req.params.id);
  if (!domain) return res.status(404).json({ error: 'Domain not found' });
  db.prepare('DELETE FROM domain_user_prefs WHERE local_username = ? AND domain_id = ?')
    .run(req.session.username, domain.id);
  logAudit(req.session.username, domain.label, 'domain_prefs_cleared', null);
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
module.exports.getDomain = getDomain;
