const path = require('path');
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

const app = express();
const PORT = process.env.PORT || 3000;

// Load persisted settings (cred cache TTL, etc.) at startup.
getSettings();

app.use(express.json({ limit: '2mb' }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || require('crypto').randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 8 * 60 * 60 * 1000, // 8 hours
    },
  })
);

app.use('/api/auth', authRoutes);
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
