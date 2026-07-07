const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
require('./db'); // ensures DB + default admin bootstrap runs

const { requireLogin } = require('./middleware/auth');
const { requireRole } = require('./middleware/roles');

const authRoutes = require('./routes/auth');
const domainsRoutes = require('./routes/domains');
const adRoutes = require('./routes/ad');
const scriptsRoutes = require('./routes/scripts');
const remotingRoutes = require('./routes/remoting');
const reportsRoutes = require('./routes/reports');
const historyRoutes = require('./routes/history');
const usersRoutes = require('./routes/users');
const settingsRoutes = require('./routes/settings');
const adminRoutes = require('./routes/admin');
const { getSettings } = require('./settings');
const { db } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, '..', 'data');
const SESSION_SECRET_PATH = path.join(DATA_DIR, '.session_secret');

function getSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(SESSION_SECRET_PATH)) {
    return fs.readFileSync(SESSION_SECRET_PATH, 'utf8').trim();
  }
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(SESSION_SECRET_PATH, secret, { mode: 0o600 });
  return secret;
}

// Load persisted settings (cred cache TTL, etc.) at startup.
getSettings();

// IIS / ARR reverse proxy — required for correct client IP and session cookies.
app.set('trust proxy', 1);

app.use(express.json({ limit: '2mb' }));
app.use(
  session({
    name: 'adops.sid',
    secret: getSessionSecret(),
    resave: false,
    saveUninitialized: false,
    rolling: true,
    proxy: true,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      path: '/',
      maxAge: 8 * 60 * 60 * 1000, // 8 hours
    },
  })
);

app.use('/api/auth', authRoutes);
app.get('/api/health', (req, res) => {
  try {
    const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
    const adminExists = !!db.prepare("SELECT 1 AS ok FROM users WHERE lower(username) = 'admin'").get();
    res.json({
      ok: true,
      time: new Date().toISOString(),
      userCount,
      adminExists,
      dataDir: DATA_DIR,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
app.use('/api/settings', settingsRoutes);
app.use('/api/domains', requireLogin, domainsRoutes); // per-route role checks inside (viewer can GET/connect; operator+ can add/delete)
app.use('/api/ad', requireLogin, adRoutes); // read-only AD queries: all roles (viewer, operator, admin)
app.use('/api/scripts', requireLogin, requireRole(['operator', 'admin']), scriptsRoutes);
app.use('/api/remoting', requireLogin, requireRole(['operator', 'admin']), remotingRoutes);
app.use('/api/reports', requireLogin, reportsRoutes); // exporting a report you already viewed: all roles
app.use('/api/history', requireLogin, historyRoutes); // per-route: own history for all roles, ?all=1 admin-only
app.use('/api/users', requireLogin, requireRole(['admin']), usersRoutes);
app.use('/api/admin', requireLogin, requireRole(['admin']), adminRoutes);

app.use(express.static(path.join(__dirname, '..', 'public')));

app.listen(PORT, () => {
  console.log(`AD Ops listening on http://localhost:${PORT}`);
});
