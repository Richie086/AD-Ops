const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { db, logAudit, VALID_ROLES } = require('../db');

const router = express.Router();

router.get('/', (req, res) => {
  const users = db.prepare('SELECT id, username, role, must_change_password, created_at FROM users ORDER BY username').all();
  res.json(users);
});

router.post('/', (req, res) => {
  const { username, role } = req.body || {};
  const chosenRole = role || 'operator';
  if (!username) return res.status(400).json({ error: 'username is required' });
  if (!VALID_ROLES.includes(chosenRole)) return res.status(400).json({ error: 'role must be one of: ' + VALID_ROLES.join(', ') });

  const tempPassword = crypto.randomBytes(9).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 12);
  const hash = bcrypt.hashSync(tempPassword, 12);
  try {
    const result = db.prepare('INSERT INTO users (username, password_hash, role, must_change_password) VALUES (?, ?, ?, 1)')
      .run(username, hash, chosenRole);
    logAudit(req.session.username, null, 'user_created', `${username} (${chosenRole})`);
    res.json({ id: result.lastInsertRowid, username, role: chosenRole, tempPassword });
  } catch (e) {
    res.status(400).json({ error: 'Username already exists' });
  }
});

router.patch('/:id', (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });

  const { role, resetPassword } = req.body || {};
  let tempPassword = null;

  if (role) {
    if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: 'role must be one of: ' + VALID_ROLES.join(', ') });
    if (target.role === 'admin' && role !== 'admin') {
      const adminCount = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'").get().c;
      if (adminCount <= 1) return res.status(400).json({ error: 'Cannot demote the last remaining admin' });
    }
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, target.id);
    logAudit(req.session.username, null, 'user_role_changed', `${target.username} -> ${role}`);
  }

  if (resetPassword) {
    tempPassword = crypto.randomBytes(9).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 12);
    const hash = bcrypt.hashSync(tempPassword, 12);
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(hash, target.id);
    logAudit(req.session.username, null, 'user_password_reset', target.username);
  }

  res.json({ ok: true, tempPassword });
});

router.delete('/:id', (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.id === req.session.userId) return res.status(400).json({ error: 'You cannot delete your own account' });
  if (target.role === 'admin') {
    const adminCount = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'").get().c;
    if (adminCount <= 1) return res.status(400).json({ error: 'Cannot delete the last remaining admin' });
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(target.id);
  logAudit(req.session.username, null, 'user_deleted', target.username);
  res.json({ ok: true });
});

module.exports = router;
