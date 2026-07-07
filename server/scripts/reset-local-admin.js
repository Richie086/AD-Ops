#!/usr/bin/env node
/**
 * Reset (or create) the local "admin" account password.
 * Usage: node server/scripts/reset-local-admin.js [newPassword]
 * Default password: admin
 */
const bcrypt = require('bcryptjs');
const { db } = require('../db');

const password = process.argv[2] || 'admin';
if (password.length < 4) {
  console.error('Password must be at least 4 characters.');
  process.exit(1);
}

const hash = bcrypt.hashSync(password, 12);
const existing = db.prepare("SELECT id FROM users WHERE username = 'admin'").get();

if (existing) {
  db.prepare("UPDATE users SET password_hash = ?, must_change_password = 0, role = 'admin' WHERE username = 'admin'")
    .run(hash);
  console.log('Reset password for existing admin account.');
} else {
  db.prepare('INSERT INTO users (username, password_hash, role, must_change_password) VALUES (?, ?, ?, 0)')
    .run('admin', hash, 'admin');
  console.log('Created admin account.');
}

console.log('');
console.log('Local login credentials:');
console.log('  Username: admin');
console.log('  Password:', password);
console.log('');
console.log('Restart the AD-Ops Node process after running this script.');
