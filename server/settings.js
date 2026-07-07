const { db } = require('./db');
const { setCredCacheTtlHours } = require('./credCache');

const DEFAULT_SETTINGS = {
  branding: {
    appTitle: 'AD Ops',
    tagline: 'Active Directory operations console',
  },
  features: {
    groupCompare: true,
    diagrams: true,
    export: true,
    scriptDeploy: true,
    psRemoting: true,
    ouTree: true,
    savedPasswords: true,
    gpoReports: true,
    drillDown: true,
  },
  session: {
    credCacheHours: 8,
  },
  history: {
    maxRecords: 200,
  },
  defaults: {
    winRmSsl: false,
  },
  security: {
    auditLogging: true,
    minPasswordLength: 8,
  },
};

let cached = null;

function deepMerge(base, patch) {
  const out = { ...base };
  for (const key of Object.keys(patch || {})) {
    const val = patch[key];
    if (val && typeof val === 'object' && !Array.isArray(val) && base[key] && typeof base[key] === 'object') {
      out[key] = deepMerge(base[key], val);
    } else if (val !== undefined) {
      out[key] = val;
    }
  }
  return out;
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function sanitizeSettings(input) {
  const merged = deepMerge(DEFAULT_SETTINGS, input || {});
  merged.session.credCacheHours = clampNumber(merged.session.credCacheHours, 1, 24, 8);
  merged.history.maxRecords = clampNumber(merged.history.maxRecords, 25, 1000, 200);
  merged.security.minPasswordLength = clampNumber(merged.security.minPasswordLength, 8, 128, 8);
  merged.branding.appTitle = String(merged.branding.appTitle || DEFAULT_SETTINGS.branding.appTitle).trim().slice(0, 80)
    || DEFAULT_SETTINGS.branding.appTitle;
  merged.branding.tagline = String(merged.branding.tagline || '').trim().slice(0, 200);
  for (const key of Object.keys(DEFAULT_SETTINGS.features)) {
    merged.features[key] = !!merged.features[key];
  }
  merged.security.auditLogging = !!merged.security.auditLogging;
  merged.defaults.winRmSsl = !!merged.defaults.winRmSsl;
  return merged;
}

function applyRuntimeSettings(settings) {
  setCredCacheTtlHours(settings.session.credCacheHours);
}

function getSettings() {
  if (cached) return cached;
  const row = db.prepare('SELECT value_json FROM app_settings WHERE key = ?').get('main');
  cached = sanitizeSettings(row ? JSON.parse(row.value_json) : null);
  applyRuntimeSettings(cached);
  return cached;
}

function updateSettings(partial, updatedBy) {
  const next = sanitizeSettings(deepMerge(getSettings(), partial || {}));
  db.prepare(`
    INSERT INTO app_settings (key, value_json, updated_at, updated_by)
    VALUES ('main', ?, datetime('now'), ?)
    ON CONFLICT(key) DO UPDATE SET
      value_json = excluded.value_json,
      updated_at = excluded.updated_at,
      updated_by = excluded.updated_by
  `).run(JSON.stringify(next), updatedBy || null);
  cached = next;
  applyRuntimeSettings(next);
  return next;
}

function resetSettings(updatedBy) {
  cached = null;
  db.prepare('DELETE FROM app_settings WHERE key = ?').run('main');
  return updateSettings({}, updatedBy);
}

function getPublicSettings() {
  const s = getSettings();
  return {
    branding: s.branding,
    features: s.features,
    defaults: s.defaults,
    security: { minPasswordLength: s.security.minPasswordLength },
  };
}

function isFeatureEnabled(name) {
  return !!getSettings().features[name];
}

function isAuditEnabled() {
  return !!getSettings().security.auditLogging;
}

function getMinPasswordLength() {
  return getSettings().security.minPasswordLength;
}

function getHistoryLimit() {
  return getSettings().history.maxRecords;
}

function requireFeature(featureName) {
  return (req, res, next) => {
    if (!isFeatureEnabled(featureName)) {
      return res.status(403).json({ error: `This feature is disabled by an administrator (${featureName}).` });
    }
    next();
  };
}

module.exports = {
  DEFAULT_SETTINGS,
  getSettings,
  updateSettings,
  resetSettings,
  getPublicSettings,
  isFeatureEnabled,
  isAuditEnabled,
  getMinPasswordLength,
  getHistoryLimit,
  requireFeature,
};
