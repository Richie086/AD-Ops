const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'data', 'adops.db');
require('fs').mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'operator',
  must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS domains (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  dc_host TEXT NOT NULL,
  use_ssl INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT,
  domain_label TEXT,
  action TEXT,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS query_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  domain_label TEXT,
  endpoint TEXT NOT NULL,
  title TEXT,
  payload_summary TEXT,
  success INTEGER NOT NULL DEFAULT 1,
  data_json TEXT,
  raw TEXT,
  command TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_history_username ON query_history(username);

CREATE TABLE IF NOT EXISTS domain_user_prefs (
  local_username TEXT NOT NULL,
  domain_id INTEGER NOT NULL,
  saved_username TEXT,
  password_enc TEXT,
  password_iv TEXT,
  password_tag TEXT,
  remember_password INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (local_username, domain_id),
  FOREIGN KEY (domain_id) REFERENCES domains(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by TEXT
);
`);

// --- Lightweight migrations for databases created before newer columns/tables. ---
const userCols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
if (!userCols.includes('role')) {
  db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'operator'");
}

const domainCols = db.prepare('PRAGMA table_info(domains)').all().map((c) => c.name);
if (!domainCols.includes('use_ssl')) {
  db.exec('ALTER TABLE domains ADD COLUMN use_ssl INTEGER NOT NULL DEFAULT 0');
}

// Ensure newer tables exist even when domains/users were created on an older build.
db.exec(`
CREATE TABLE IF NOT EXISTS domain_user_prefs (
  local_username TEXT NOT NULL,
  domain_id INTEGER NOT NULL,
  saved_username TEXT,
  password_enc TEXT,
  password_iv TEXT,
  password_tag TEXT,
  remember_password INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (local_username, domain_id),
  FOREIGN KEY (domain_id) REFERENCES domains(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by TEXT
);
`);

const VALID_ROLES = ['viewer', 'operator', 'admin'];

// Bootstrap a default local admin account on first run only.
const adminUser = db.prepare("SELECT * FROM users WHERE username = 'admin'").get();
if (!adminUser) {
  const defaultPassword = 'admin';
  const hash = bcrypt.hashSync(defaultPassword, 12);
  db.prepare('INSERT INTO users (username, password_hash, role, must_change_password) VALUES (?, ?, ?, 0)')
    .run('admin', hash, 'admin');
  console.log('============================================================');
  console.log(' Bootstrap: created local login "admin" (role: admin)');
  console.log(' Default password: ' + defaultPassword);
  console.log('============================================================');
}

function logAudit(username, domainLabel, action, detail) {
  try {
    const { isAuditEnabled } = require('./settings');
    if (!isAuditEnabled()) return;
  } catch {
    // settings not ready during bootstrap — skip audit rather than break requests
    return;
  }
  db.prepare('INSERT INTO audit_log (username, domain_label, action, detail) VALUES (?, ?, ?, ?)')
    .run(username || null, domainLabel || null, action, detail || null);
}

// --- Query / job history -------------------------------------------------

function recordHistory({ username, domainLabel, endpoint, title, payloadSummary, success, data, raw, command }) {
  db.prepare(`
    INSERT INTO query_history (username, domain_label, endpoint, title, payload_summary, success, data_json, raw, command)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    username || null,
    domainLabel || null,
    endpoint,
    title || null,
    payloadSummary || null,
    success ? 1 : 0,
    data === undefined ? null : JSON.stringify(data),
    raw || null,
    command || null
  );
}

function listHistory(username, { all = false, limit = 100 } = {}) {
  if (all) {
    return db.prepare('SELECT id, username, domain_label, endpoint, title, success, created_at FROM query_history ORDER BY id DESC LIMIT ?').all(limit);
  }
  return db.prepare('SELECT id, username, domain_label, endpoint, title, success, created_at FROM query_history WHERE username = ? ORDER BY id DESC LIMIT ?').all(username, limit);
}

function getHistoryRecord(id, username, isAdmin) {
  const row = db.prepare('SELECT * FROM query_history WHERE id = ?').get(id);
  if (!row) return null;
  if (!isAdmin && row.username !== username) return null; // non-admins may only view their own
  return {
    ...row,
    data: row.data_json ? JSON.parse(row.data_json) : null,
  };
}

module.exports = { db, logAudit, recordHistory, listHistory, getHistoryRecord, VALID_ROLES };
