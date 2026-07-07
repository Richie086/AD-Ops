const express = require('express');
const bcrypt = require('bcryptjs');
const { db, logAudit } = require('../db');
const { clearCreds } = require('../credCache');
const { getMinPasswordLength } = require('../settings');

const router = express.Router();

router.post('/login', (req, res) => {
  try {
    const { username, password } = req.body || {};
    const user = String(username || '').trim();
    const pass = String(password || '');
    if (!user || !pass) return res.status(400).json({ error: 'Username and password required' });

    const row = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(user);
    if (!row || !bcrypt.compareSync(pass, row.password_hash)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    req.session.userId = row.id;
    req.session.username = row.username;
    req.session.role = row.role;
    logAudit(row.username, null, 'login', null);

    res.json({
      username: row.username,
      role: row.role,
      mustChangePassword: !!row.must_change_password,
    });
  } catch (err) {
    console.error('Login failed:', err);
    res.status(500).json({ error: 'Login failed due to a server error. Check server logs.' });
  }
});

router.post('/logout', (req, res) => {
  const username = req.session.username;
  clearCreds(req.sessionID);
  logAudit(username, null, 'logout', null);
  req.session.destroy(() => res.json({ ok: true }));
});

router.get('/me', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ username: req.session.username, role: req.session.role });
});

router.post('/change-password', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const { currentPassword, newPassword } = req.body || {};
  const minLen = getMinPasswordLength();
  if (!newPassword || newPassword.length < minLen) {
    return res.status(400).json({ error: `New password must be at least ${minLen} characters` });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!bcrypt.compareSync(currentPassword || '', user.password_hash)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  const hash = bcrypt.hashSync(newPassword, 12);
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(hash, user.id);
  logAudit(user.username, null, 'change_password', null);
  res.json({ ok: true });
});

module.exports = router;
