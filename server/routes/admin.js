const express = require('express');
const { db, logAudit } = require('../db');
const { getSettings, updateSettings, resetSettings, DEFAULT_SETTINGS } = require('../settings');

const router = express.Router();

router.get('/stats', (req, res) => {
  const users = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  const domains = db.prepare('SELECT COUNT(*) AS c FROM domains').get().c;
  const queriesToday = db.prepare(
    "SELECT COUNT(*) AS c FROM query_history WHERE created_at >= datetime('now', '-1 day')"
  ).get().c;
  const auditEntries = db.prepare('SELECT COUNT(*) AS c FROM audit_log').get().c;
  const settingsRow = db.prepare('SELECT updated_at, updated_by FROM app_settings WHERE key = ?').get('main');

  res.json({
    users,
    domains,
    queriesToday,
    auditEntries,
    settingsUpdatedAt: settingsRow?.updated_at || null,
    settingsUpdatedBy: settingsRow?.updated_by || null,
  });
});

router.get('/settings', (req, res) => {
  res.json({ settings: getSettings(), defaults: DEFAULT_SETTINGS });
});

router.patch('/settings', (req, res) => {
  const partial = req.body?.settings ?? req.body;
  if (!partial || typeof partial !== 'object') {
    return res.status(400).json({ error: 'settings object is required' });
  }
  const next = updateSettings(partial, req.session.username);
  logAudit(req.session.username, null, 'settings_updated', JSON.stringify(Object.keys(partial)).slice(0, 500));
  res.json({ settings: next });
});

router.post('/settings/reset', (req, res) => {
  const next = resetSettings(req.session.username);
  logAudit(req.session.username, null, 'settings_reset', null);
  res.json({ settings: next });
});

router.get('/audit', (req, res) => {
  const limit = Math.min(500, Math.max(25, Number(req.query.limit) || 100));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const rows = db.prepare(
    'SELECT id, username, domain_label, action, detail, created_at FROM audit_log ORDER BY id DESC LIMIT ? OFFSET ?'
  ).all(limit, offset);
  const total = db.prepare('SELECT COUNT(*) AS c FROM audit_log').get().c;
  res.json({ rows, total, limit, offset });
});

module.exports = router;
