(() => {
  const api = async (url, opts = {}) => {
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      ...opts,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(body.error || `Request failed (${res.status})`);
      err.raw = body.raw;
      err.command = body.command;
      throw err;
    }
    return body;
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const THEME_KEY = 'adops-theme';

  function getTheme() {
    return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  }

  function updateThemeButtons(theme) {
    const label = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
    const icon = theme === 'dark' ? '☀️' : '🌙';
    ['#themeToggleAuth', '#themeToggleApp'].forEach((sel) => {
      const btn = $(sel);
      if (!btn) return;
      btn.textContent = icon;
      btn.title = label;
      btn.setAttribute('aria-label', label);
    });
    const authToggle = $('#themeToggleAuth');
    const appView = $('#appView');
    if (authToggle && appView) {
      authToggle.classList.toggle('hidden', !appView.classList.contains('hidden'));
    }
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem(THEME_KEY, theme);
    updateThemeButtons(theme);
    state.mermaidReady = false;
    if (state.lastResult && state.resultView === 'diagram' && getDiagramContext()) {
      renderResults();
    }
  }

  function toggleTheme() {
    applyTheme(getTheme() === 'dark' ? 'light' : 'dark');
  }

  $('#themeToggleAuth')?.addEventListener('click', toggleTheme);
  $('#themeToggleApp')?.addEventListener('click', toggleTheme);
  updateThemeButtons(getTheme());

  let state = {
    selectedDomainId: null,
    connected: false,
    lastResult: null, // { data, raw, command, title, meta? }
    drillStack: [],
    resultView: 'table',
    mermaidReady: false,
    lastMermaidSource: '',
    role: null,
    username: null,
    appSettings: null,
    adminAuditOffset: 0,
  };

  const FEATURE_LABELS = {
    groupCompare: 'Group compare',
    diagrams: 'Mermaid diagrams',
    export: 'Result export',
    scriptDeploy: 'Script deployment',
    psRemoting: 'PS remoting configuration',
    ouTree: 'OU structure tree',
    savedPasswords: 'Saved domain passwords',
    gpoReports: 'GPO XML reports',
    drillDown: 'Object drill-down',
  };

  // ---------- Auth ----------
  const loginView = $('#loginView');
  const changePwView = $('#changePwView');
  const appView = $('#appView');

  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#loginError').textContent = '';
    try {
      const username = $('#loginUsername').value.trim();
      const password = $('#loginPassword').value;
      const result = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
      if (result.mustChangePassword) {
        loginView.classList.add('hidden');
        changePwView.classList.remove('hidden');
      } else {
        await enterApp(result);
      }
    } catch (err) {
      $('#loginError').textContent = err.message;
      loginView.classList.remove('hidden');
      changePwView.classList.add('hidden');
      appView.classList.add('hidden');
    }
  });

  $('#changePwForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#cpError').textContent = '';
    try {
      await api('/api/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword: $('#cpCurrent').value, newPassword: $('#cpNew').value }),
      });
      changePwView.classList.add('hidden');
      const me = await api('/api/auth/me');
      await enterApp(me);
    } catch (err) {
      $('#cpError').textContent = err.message;
    }
  });

  $('#logoutBtn').addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' });
    location.reload();
  });

  async function loadAppSettings() {
    try {
      state.appSettings = await api('/api/settings');
      applyBranding(state.appSettings.branding);
      applyFeatureVisibility();
      applyDomainDefaults();
    } catch {
      state.appSettings = null;
    }
  }

  function applyBranding(branding) {
    const title = branding?.appTitle || 'AD Ops';
    const tagline = branding?.tagline || 'Sign in to continue';
    document.title = title;
    const brand = $('#appBrand');
    if (brand) brand.textContent = title;
    const loginTitle = $('#loginAppTitle');
    if (loginTitle) loginTitle.textContent = title;
    const loginTagline = $('#loginTagline');
    if (loginTagline) loginTagline.textContent = tagline;
  }

  function isFeatureEnabled(name) {
    return state.appSettings?.features?.[name] !== false;
  }

  function applyFeatureVisibility() {
    $$('[data-feature]').forEach((el) => {
      const feature = el.dataset.feature;
      const enabled = isFeatureEnabled(feature);
      const roleHidden = el.classList.contains('role-gated') &&
        ROLE_RANK[state.role] < ROLE_RANK[el.dataset.minRole || 'viewer'];
      el.classList.toggle('hidden', !enabled || roleHidden);
    });
  }

  function applyDomainDefaults() {
    const sslDefault = !!state.appSettings?.defaults?.winRmSsl;
    const sslBox = $('#newDomainUseSsl');
    if (sslBox && !sslBox.dataset.userTouched) {
      sslBox.checked = sslDefault;
    }
  }

  async function enterApp(who) {
    state.username = who.username;
    state.role = who.role;
    loginView.classList.add('hidden');
    changePwView.classList.add('hidden');
    appView.classList.remove('hidden');
    $('#userBadge').textContent = `${who.username} (${who.role})`;
    updateThemeButtons(getTheme());
    try {
      await loadAppSettings();
      applyRoleVisibility(who.role);
      try {
        await loadDomains();
      } catch (err) {
        console.error('Failed to load domains after login:', err);
        showError(err);
      }
      if (state.selectedDomainId) {
        try {
          await refreshDomainSession(state.selectedDomainId);
        } catch {
          state.connected = false;
          updateConnStatus();
        }
      }
    } catch (err) {
      loginView.classList.remove('hidden');
      appView.classList.add('hidden');
      throw err;
    }
  }

  const ROLE_RANK = { viewer: 0, operator: 1, admin: 2 };
  function applyRoleVisibility(role) {
    $$('.role-gated').forEach((el) => {
      const minRole = el.dataset.minRole || 'viewer';
      const roleOk = ROLE_RANK[role] >= ROLE_RANK[minRole];
      const featureOk = !el.dataset.feature || isFeatureEnabled(el.dataset.feature);
      el.classList.toggle('hidden', !roleOk || !featureOk);
    });
    $$('[data-feature]:not(.role-gated)').forEach((el) => {
      el.classList.toggle('hidden', !isFeatureEnabled(el.dataset.feature));
    });
    $('#historyAllToggleWrap').classList.toggle('hidden', role !== 'admin');
  }

  // Check existing session on load.
  fetch('/api/settings/branding', { credentials: 'same-origin' })
    .then((r) => r.json())
    .then(applyBranding)
    .catch(() => {});
  api('/api/auth/me').then(enterApp).catch(() => {});

  // ---------- Nav ----------
  $$('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('.nav-item').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      $$('.view').forEach((v) => v.classList.add('hidden'));
      $('#view-' + btn.dataset.view).classList.remove('hidden');
      clearResults();
      if (btn.dataset.view === 'domains') loadDomains();
      if (btn.dataset.view === 'history') loadHistory();
      if (btn.dataset.view === 'localUsers') loadLocalUsers();
      if (btn.dataset.view === 'adminPanel') loadAdminPanel();
      $('#sideNav').classList.remove('open');
    });
  });

  $('#navToggle').addEventListener('click', () => $('#sideNav').classList.toggle('open'));

  // ---------- Domains ----------
  async function loadDomains() {
    const domains = await api('/api/domains');
    const select = $('#domainSelect');
    select.innerHTML = '<option value="">— Select saved domain —</option>' +
      domains.map((d) => `<option value="${d.id}">${escapeHtml(d.label)} (${escapeHtml(d.dc_host)})</option>`).join('');
    if (state.selectedDomainId) select.value = state.selectedDomainId;

    const list = $('#domainsList');
    if (list) {
      list.innerHTML = domains.length
        ? domains.map((d) => `
            <div class="domain-row">
              <span class="dlabel">${escapeHtml(d.label)}</span>
              <span class="dhost">${escapeHtml(d.dc_host)}${d.notes ? ' — ' + escapeHtml(d.notes) : ''}</span>
              <button data-del="${d.id}">Delete</button>
            </div>`).join('')
        : '<p style="color:var(--muted)">No saved domains yet.</p>';
      $$('button[data-del]', list).forEach((b) => {
        b.addEventListener('click', async () => {
          await api('/api/domains/' + b.dataset.del, { method: 'DELETE' });
          loadDomains();
        });
      });
    }
  }

  $('#newDomainUseSsl')?.addEventListener('change', (e) => {
    e.target.dataset.userTouched = '1';
  });

  $('#addDomainForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    await api('/api/domains', {
      method: 'POST',
      body: JSON.stringify({
        label: $('#newDomainLabel').value,
        dcHost: $('#newDomainHost').value,
        notes: $('#newDomainNotes').value,
        useSsl: $('#newDomainUseSsl').checked,
      }),
    });
    $('#addDomainForm').reset();
    loadDomains();
  });

  $('#domainSelect').addEventListener('change', async (e) => {
    state.selectedDomainId = e.target.value || null;
    state.connected = false;
    updateConnStatus();
    if (state.selectedDomainId) {
      await refreshDomainSession(state.selectedDomainId);
    }
  });

  const connectModal = $('#connectModal');
  const connectForm = $('#connectForm');

  function openConnectModal() {
    if (!state.selectedDomainId) {
      alert('Select a saved domain first.');
      return;
    }
    $('#connectModalError').textContent = '';
    connectModal.classList.remove('hidden');
    loadConnectPrefs(state.selectedDomainId);
  }

  function closeConnectModal() {
    connectModal.classList.add('hidden');
    connectForm.reset();
    $('#connectRememberUsername').checked = true;
    $('#connectSavedHint').classList.add('hidden');
  }

  async function loadConnectPrefs(domainId) {
    try {
      const prefs = await api(`/api/domains/${domainId}/prefs`);
      $('#connectUsername').value = prefs.savedUsername || '';
      $('#connectUseSsl').checked = !!prefs.useSsl;
      const allowSaved = prefs.savedPasswordsAllowed !== false;
      $$('[data-feature="savedPasswords"]', $('#connectModal')).forEach((el) => {
        el.classList.toggle('hidden', !allowSaved);
      });
      $('#connectRememberPassword').checked = allowSaved && !!prefs.hasSavedPassword;
      $('#connectSavedHint').classList.toggle('hidden', !allowSaved || !prefs.hasSavedPassword);
      $('#connectPassword').required = allowSaved ? !prefs.hasSavedPassword : true;
    } catch (err) {
      $('#connectModalError').textContent = err.message;
    }
  }

  async function refreshDomainSession(domainId) {
    try {
      const status = await api(`/api/domains/${domainId}/session`);
      state.connected = !!status.connected;
      updateConnStatus();
    } catch {
      state.connected = false;
      updateConnStatus();
    }
  }

  $('#connectBtn').addEventListener('click', openConnectModal);
  $$('[data-close-modal]').forEach((el) => {
    el.addEventListener('click', closeConnectModal);
  });

  $('#connectRememberPassword').addEventListener('change', (e) => {
    const hasSaved = !$('#connectSavedHint').classList.contains('hidden');
    $('#connectPassword').required = !e.target.checked && !hasSaved;
  });

  $('#clearSavedCredsBtn').addEventListener('click', async () => {
    if (!state.selectedDomainId) return;
    try {
      await api(`/api/domains/${state.selectedDomainId}/prefs`, { method: 'DELETE' });
      $('#connectPassword').value = '';
      $('#connectPassword').required = true;
      $('#connectRememberPassword').checked = false;
      $('#connectSavedHint').classList.add('hidden');
    } catch (err) {
      $('#connectModalError').textContent = err.message;
    }
  });

  connectForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#connectModalError').textContent = '';
    const username = $('#connectUsername').value.trim();
    const password = $('#connectPassword').value;
    const rememberUsername = $('#connectRememberUsername').checked;
    const rememberPassword = $('#connectRememberPassword').checked;
    const useSsl = $('#connectUseSsl').checked;
    const hasSaved = !$('#connectSavedHint').classList.contains('hidden');

    if (!username) {
      $('#connectModalError').textContent = 'Domain account is required.';
      return;
    }
    if (!password && !hasSaved) {
      $('#connectModalError').textContent = 'Password is required.';
      return;
    }

    try {
      $('#connStatus').textContent = 'Connecting…';
      await api(`/api/domains/${state.selectedDomainId}/connect`, {
        method: 'POST',
        body: JSON.stringify({
          username,
          password,
          rememberUsername,
          rememberPassword,
          useSsl,
        }),
      });
      state.connected = true;
      updateConnStatus();
      closeConnectModal();
    } catch (err) {
      state.connected = false;
      updateConnStatus();
      $('#connectModalError').textContent = err.message;
      if (err.raw || err.command) {
        state.lastResult = { data: null, raw: err.raw, command: err.command, title: 'Domain connect failed' };
        renderResults();
      }
      showError(err);
    }
  });

  // ---------- History ----------
  async function loadHistory() {
    const all = $('#historyAllToggle').checked ? '?all=1' : '';
    const rows = await api('/api/history' + all);
    const list = $('#historyList');
    list.innerHTML = rows.length
      ? rows.map((r) => `
          <div class="history-row" data-id="${r.id}">
            <span class="hbadge ${r.success ? 'ok' : 'fail'}">${r.success ? 'OK' : 'FAILED'}</span>
            <span class="htitle">${escapeHtml(r.title || r.endpoint)}</span>
            <span class="hmeta">${escapeHtml(r.domain_label || '—')}${r.username !== state.username ? ' · ' + escapeHtml(r.username) : ''}</span>
            <span class="hmeta">${escapeHtml(r.created_at)}</span>
          </div>`).join('')
      : '<p style="color:var(--muted)">No history yet.</p>';
    $$('.history-row', list).forEach((row) => {
      row.addEventListener('click', () => viewHistoryItem(row.dataset.id));
    });
  }

  $('#historyAllToggle').addEventListener('change', loadHistory);

  async function viewHistoryItem(id) {
    const record = await api('/api/history/' + id);
    state.drillStack = [];
    state.lastResult = { data: record.data, raw: record.raw, command: record.command, title: record.title };
    renderResults();
  }

  // ---------- Local Accounts (admin) ----------
  async function loadLocalUsers() {
    const users = await api('/api/users');
    const list = $('#localUsersList');
    list.innerHTML = users.map((u) => `
      <div class="domain-row" data-id="${u.id}">
        <span class="dlabel">${escapeHtml(u.username)}</span>
        <select class="role-select" data-id="${u.id}">
          ${['viewer', 'operator', 'admin'].map((r) => `<option value="${r}" ${r === u.role ? 'selected' : ''}>${r}</option>`).join('')}
        </select>
        <span class="dhost">${u.must_change_password ? 'temp password pending' : ''}</span>
        <button data-reset="${u.id}">Reset PW</button>
        <button data-del="${u.id}">Delete</button>
      </div>`).join('');

    $$('.role-select', list).forEach((sel) => {
      sel.addEventListener('change', async () => {
        try {
          await api('/api/users/' + sel.dataset.id, { method: 'PATCH', body: JSON.stringify({ role: sel.value }) });
          loadLocalUsers();
        } catch (err) { showError(err); loadLocalUsers(); }
      });
    });
    $$('button[data-reset]', list).forEach((b) => {
      b.addEventListener('click', async () => {
        try {
          const res = await api('/api/users/' + b.dataset.reset, { method: 'PATCH', body: JSON.stringify({ resetPassword: true }) });
          alert('New temporary password: ' + res.tempPassword);
        } catch (err) { showError(err); }
      });
    });
    $$('button[data-del]', list).forEach((b) => {
      b.addEventListener('click', async () => {
        if (!confirm('Delete this account?')) return;
        try {
          await api('/api/users/' + b.dataset.del, { method: 'DELETE' });
          loadLocalUsers();
        } catch (err) { showError(err); }
      });
    });
  }

  }

  // ---------- Admin panel ----------
  function populateAdminForm(settings) {
    $('#adminAppTitle').value = settings.branding?.appTitle || 'AD Ops';
    $('#adminTagline').value = settings.branding?.tagline || '';
    $('#adminCredCacheHours').value = settings.session?.credCacheHours ?? 8;
    $('#adminMinPasswordLength').value = settings.security?.minPasswordLength ?? 8;
    $('#adminAuditLogging').checked = settings.security?.auditLogging !== false;
    $('#adminHistoryMax').value = settings.history?.maxRecords ?? 200;
    $('#adminDefaultWinRmSsl').checked = !!settings.defaults?.winRmSsl;

    const grid = $('#adminFeatureToggles');
    grid.innerHTML = Object.keys(FEATURE_LABELS).map((key) => `
      <label class="checkbox-row">
        <input type="checkbox" data-feature-key="${key}" ${settings.features?.[key] !== false ? 'checked' : ''}>
        ${escapeHtml(FEATURE_LABELS[key])}
      </label>`).join('');
  }

  function collectAdminSettings() {
    const features = {};
    $$('#adminFeatureToggles [data-feature-key]').forEach((cb) => {
      features[cb.dataset.featureKey] = cb.checked;
    });
    return {
      branding: {
        appTitle: $('#adminAppTitle').value.trim(),
        tagline: $('#adminTagline').value.trim(),
      },
      features,
      session: { credCacheHours: Number($('#adminCredCacheHours').value) },
      history: { maxRecords: Number($('#adminHistoryMax').value) },
      defaults: { winRmSsl: $('#adminDefaultWinRmSsl').checked },
      security: {
        auditLogging: $('#adminAuditLogging').checked,
        minPasswordLength: Number($('#adminMinPasswordLength').value),
      },
    };
  }

  async function loadAdminAudit(reset = false) {
    if (reset) state.adminAuditOffset = 0;
    const limit = 50;
    const data = await api(`/api/admin/audit?limit=${limit}&offset=${state.adminAuditOffset}`);
    const list = $('#adminAuditList');
    const rowsHtml = data.rows.map((r) => `
      <div class="history-row">
        <span class="hbadge ok">${escapeHtml(r.action)}</span>
        <span class="htitle">${escapeHtml(r.username || '—')}</span>
        <span class="hmeta">${escapeHtml(r.domain_label || '')}${r.detail ? ' · ' + escapeHtml(r.detail) : ''}</span>
        <span class="hmeta">${escapeHtml(r.created_at)}</span>
      </div>`).join('');
    if (reset) {
      list.innerHTML = rowsHtml || '<p style="color:var(--muted)">No audit entries yet.</p>';
    } else {
      list.insertAdjacentHTML('beforeend', rowsHtml);
    }
    state.adminAuditOffset += data.rows.length;
    $('#adminAuditMoreBtn').classList.toggle('hidden', state.adminAuditOffset >= data.total);
  }

  async function loadAdminPanel() {
    $('#adminSettingsMsg').textContent = '';
    try {
      const [stats, settingsRes] = await Promise.all([
        api('/api/admin/stats'),
        api('/api/admin/settings'),
      ]);
      const settings = settingsRes.settings;
      populateAdminForm(settings);

      $('#adminStats').innerHTML = `
        <div class="admin-stat"><span class="label">Local users</span><span class="value">${stats.users}</span></div>
        <div class="admin-stat"><span class="label">Saved domains</span><span class="value">${stats.domains}</span></div>
        <div class="admin-stat"><span class="label">Queries (24h)</span><span class="value">${stats.queriesToday}</span></div>
        <div class="admin-stat"><span class="label">Audit entries</span><span class="value">${stats.auditEntries}</span></div>`;

      if (stats.settingsUpdatedAt) {
        $('#adminStats').insertAdjacentHTML('beforeend',
          `<div class="admin-stat"><span class="label">Settings updated</span><span class="value" style="font-size:.85rem">${escapeHtml(stats.settingsUpdatedAt)}${stats.settingsUpdatedBy ? ' by ' + escapeHtml(stats.settingsUpdatedBy) : ''}</span></div>`);
      }

      await loadAdminAudit(true);
    } catch (err) {
      showError(err);
    }
  }

  $('#adminSettingsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#adminSettingsMsg').textContent = '';
    try {
      const res = await api('/api/admin/settings', {
        method: 'PATCH',
        body: JSON.stringify({ settings: collectAdminSettings() }),
      });
      state.appSettings = {
        branding: res.settings.branding,
        features: res.settings.features,
        defaults: res.settings.defaults,
        security: { minPasswordLength: res.settings.security.minPasswordLength },
      };
      applyBranding(res.settings.branding);
      applyRoleVisibility(state.role);
      applyDomainDefaults();
      $('#adminSettingsMsg').textContent = 'Settings saved.';
      loadAdminPanel();
    } catch (err) {
      $('#adminSettingsMsg').textContent = err.message;
      showError(err);
    }
  });

  $('#adminResetBtn').addEventListener('click', async () => {
    if (!confirm('Reset all AD Ops settings to defaults?')) return;
    try {
      const res = await api('/api/admin/settings/reset', { method: 'POST' });
      state.appSettings = {
        branding: res.settings.branding,
        features: res.settings.features,
        defaults: res.settings.defaults,
        security: { minPasswordLength: res.settings.security.minPasswordLength },
      };
      applyBranding(res.settings.branding);
      applyRoleVisibility(state.role);
      applyDomainDefaults();
      populateAdminForm(res.settings);
      $('#adminSettingsMsg').textContent = 'Settings reset to defaults.';
    } catch (err) {
      showError(err);
    }
  });

  $('#adminAuditMoreBtn').addEventListener('click', () => loadAdminAudit(false));

  $('#addLocalUserForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const res = await api('/api/users', {
        method: 'POST',
        body: JSON.stringify({ username: $('#newLocalUsername').value, role: $('#newLocalRole').value }),
      });
      $('#addLocalUserForm').reset();
      loadLocalUsers();
      alert(`Account created. Temporary password: ${res.tempPassword}`);
    } catch (err) {
      showError(err);
    }
  });

  function updateConnStatus() {
    const el = $('#connStatus');
    el.textContent = state.connected ? 'Connected' : 'Not connected';
    el.classList.toggle('connected', state.connected);
  }

  // ---------- Generic query forms ----------
  $$('.query-form[data-endpoint]').forEach((form) => {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!requireConnection()) return;
      const endpoint = form.dataset.endpoint;
      const bodyField = form.dataset.body;
      const payload = { domainId: state.selectedDomainId };
      if (bodyField) {
        const input = form.querySelector(`[name="${bodyField}"]`);
        payload[bodyField] = input ? input.value : '';
      }
      await runQuery(endpoint, payload, form.querySelector('button').textContent.trim());
    });
  });

  $('#deployForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!requireConnection()) return;
    const targets = $('#deployTargets').value.split(',').map((s) => s.trim()).filter(Boolean);
    const scriptContent = $('#deployScript').value;
    await runQuery('/api/scripts/deploy', { domainId: state.selectedDomainId, targets, scriptContent }, 'Script Deployment');
  });

  $('#remotingForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!requireConnection()) return;
    const target = $('#remotingTarget').value;
    const action = $('#remotingAction').value;
    await runQuery('/api/remoting/configure', { domainId: state.selectedDomainId, target, action }, 'PS Remoting: ' + action);
  });

  $('#groupCompareForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!requireConnection()) return;
    const groupA = $('#compareGroupA').value.trim();
    const groupB = $('#compareGroupB').value.trim();
    const includeNested = $('#compareIncludeNested').checked;
    const label = `Compare: ${groupA} vs ${groupB}`;
    await runQuery('/api/ad/group-compare', {
      domainId: state.selectedDomainId,
      groupA,
      groupB,
      includeNested,
    }, label);
  });

  function requireConnection() {
    if (!state.selectedDomainId || !state.connected) {
      showError({ message: 'Connect to a saved domain first (top bar).' });
      return false;
    }
    return true;
  }

  function buildQueryMeta(endpoint, payload) {
    if (endpoint === '/api/ad/membership') {
      return { diagramType: 'membership', membershipType: 'direct', rootGroup: payload.groupName };
    }
    if (endpoint === '/api/ad/nested-membership') {
      return { diagramType: 'membership', membershipType: 'nested', rootGroup: payload.groupName };
    }
    if (endpoint === '/api/ad/ou-tree') {
      return { diagramType: 'ou', root: payload.root || '' };
    }
    return null;
  }

  async function runQuery(endpoint, payload, title) {
    hideError();
    state.drillStack = [];
    state.resultView = endpoint === '/api/ad/ou-tree' ? 'diagram' : 'table';
    try {
      const result = await api(endpoint, { method: 'POST', body: JSON.stringify(payload) });
      state.lastResult = {
        data: result.data,
        raw: result.raw,
        command: result.command,
        title,
        meta: buildQueryMeta(endpoint, payload),
      };
      renderResults();
    } catch (err) {
      state.lastResult = { data: null, raw: err.raw, command: err.command, title, meta: null };
      renderResults();
      showError(err);
    }
  }

  $$('#resultViewToggle button').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.resultView = btn.dataset.view;
      $$('#resultViewToggle button').forEach((b) => b.classList.toggle('active', b === btn));
      renderResults();
    });
  });

  $('#copyMermaidBtn').addEventListener('click', async () => {
    if (!state.lastMermaidSource) return;
    try {
      await navigator.clipboard.writeText(state.lastMermaidSource);
      $('#copyMermaidBtn').textContent = 'Copied!';
      setTimeout(() => { $('#copyMermaidBtn').textContent = 'Copy Mermaid'; }, 1500);
    } catch {
      alert(state.lastMermaidSource);
    }
  });

  $('#drillBackBtn').addEventListener('click', () => {
    if (!state.drillStack.length) return;
    state.lastResult = state.drillStack.pop();
    renderResults();
  });

  $('#resultsTableWrap').addEventListener('click', (e) => {
    const row = e.target.closest('tr[data-drill-dn]');
    if (!row) return;
    drillInto({
      distinguishedName: row.dataset.drillDn,
      objectClass: row.dataset.drillClass || null,
      identity: row.dataset.drillIdentity || null,
    });
  });

  async function drillInto(info) {
    if (!requireConnection()) return;
    hideError();
    try {
      $('#resultsTableWrap').innerHTML = '<p style="color:var(--muted)">Loading object details…</p>';
      const result = await api('/api/ad/object', {
        method: 'POST',
        body: JSON.stringify({
          domainId: state.selectedDomainId,
          distinguishedName: info.distinguishedName,
          objectClass: info.objectClass || null,
          identity: info.identity || null,
        }),
      });
      state.drillStack.push(state.lastResult);
      const label = info.distinguishedName || info.identity || 'Object';
      state.lastResult = {
        data: result.data,
        raw: result.raw,
        command: result.command,
        title: `Object: ${label}`,
        meta: result.data?.related?.members?.length
          ? {
              diagramType: 'membership',
              membershipType: 'direct',
              rootGroup: result.data.object?.SamAccountName || result.data.object?.Name || label,
            }
          : null,
      };
      renderResults();
    } catch (err) {
      renderResults();
      showError(err);
    }
  }

  // ---------- Results rendering ----------
  function prettyJson(value) {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  function formatCellValue(v) {
    if (v == null) return '';
    if (typeof v === 'object') return prettyJson(v);
    return String(v);
  }

  function normalizeResultData(data) {
    if (data && typeof data === 'object' && data.object) {
      return { mode: 'detail', object: data.object, related: data.related || {} };
    }
    if (data && typeof data === 'object' && data.groupA && data.groupB && Array.isArray(data.onlyInA)) {
      return { mode: 'groupCompare', compare: data, related: {} };
    }
    const rows = data == null ? [] : Array.isArray(data) ? data : [data];
    return { mode: 'list', rows, related: {} };
  }

  function getDrillInfo(row) {
    if (!row || typeof row !== 'object') return null;
    const dn = row.DistinguishedName || row.distinguishedName;
    if (!dn) return null;
    let objectClass = row.objectClass || row.ObjectClass || null;
    if (!objectClass && dn.includes(',CN=Policies,CN=System,')) objectClass = 'gpo';
    if (!objectClass && dn.startsWith('OU=')) objectClass = 'organizationalUnit';
    const identity = row.SamAccountName || row.Name || row.DisplayName || null;
    return { distinguishedName: dn, objectClass, identity };
  }

  function rowDrillAttrs(info) {
    if (!info || !isFeatureEnabled('drillDown')) return '';
    return ` class="drillable-row" data-drill-dn="${escapeAttr(info.distinguishedName)}"` +
      ` data-drill-class="${escapeAttr(info.objectClass || '')}"` +
      ` data-drill-identity="${escapeAttr(info.identity || '')}"` +
      ' title="Click to drill down into this object"';
  }

  function updateDrillNav() {
    const hasStack = state.drillStack.length > 0;
    $('#drillBackBtn').classList.toggle('hidden', !hasStack);
    const crumb = $('#drillBreadcrumb');
    if (hasStack) {
      crumb.classList.remove('hidden');
      const trail = state.drillStack.map((s) => s.title || 'Results').join(' › ');
      crumb.textContent = `${trail} › ${state.lastResult?.title || 'Detail'}`;
    } else {
      crumb.classList.add('hidden');
      crumb.textContent = '';
    }
    $('#resultsTitle').textContent = state.lastResult?.title || 'Results';
  }

  function getDiagramContext() {
    if (!state.lastResult) return null;

    if (window.OuDiagram) {
      const ouCtx = OuDiagram.extractContext(state.lastResult.data, state.lastResult.meta);
      if (ouCtx) {
        return {
          label: 'OU structure diagram',
          toMermaid: () => OuDiagram.toMermaid(ouCtx),
        };
      }
    }

    if (window.MembershipDiagram) {
      const membershipCtx = MembershipDiagram.extractContext(state.lastResult.data, state.lastResult.meta);
      if (membershipCtx) {
        return {
          label: 'Group membership diagram',
          toMermaid: () => MembershipDiagram.toMermaid(membershipCtx),
        };
      }
    }

    return null;
  }

  async function renderMermaidDiagram(diagramCtx) {
    const code = diagramCtx.toMermaid();
    state.lastMermaidSource = code;
    $('#mermaidSource').textContent = code;
    $('#mermaidToolbarLabel').textContent = diagramCtx.label;
    const host = $('#mermaidDiagram');
    host.innerHTML = '<p style="color:var(--muted)">Rendering diagram…</p>';

    if (!window.mermaid) {
      host.innerHTML = '<p class="mermaid-error">Mermaid failed to load. Check network access to the CDN.</p>';
      return;
    }

    try {
      if (!state.mermaidReady) {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'loose',
          theme: getTheme() === 'dark' ? 'dark' : 'default',
        });
        state.mermaidReady = true;
      }
      const id = `diagram-${Date.now()}`;
      const { svg } = await mermaid.render(id, code);
      host.innerHTML = svg;
    } catch (err) {
      host.innerHTML = `<pre class="mermaid-error">${escapeHtml(err.message || 'Could not render diagram.')}</pre>`;
    }
  }

  function renderResults() {
    const area = $('#resultsArea');
    area.classList.remove('hidden');
    const { data, raw, command } = state.lastResult;
    const normalized = normalizeResultData(data);
    const diagramCtx = getDiagramContext();
    const diagramsAllowed = isFeatureEnabled('diagrams');

    $('#resultViewToggle').classList.toggle('hidden', !diagramCtx || !diagramsAllowed);
    if ((!diagramCtx || !diagramsAllowed) && state.resultView === 'diagram') {
      state.resultView = 'table';
      $$('#resultViewToggle button').forEach((b) => {
        b.classList.toggle('active', b.dataset.view === 'table');
      });
    }

    const showDiagram = diagramCtx && diagramsAllowed && state.resultView === 'diagram';
    $('#resultsTableWrap').classList.toggle('hidden', showDiagram);
    $('#mermaidWrap').classList.toggle('hidden', !showDiagram);

    if (showDiagram) {
      renderMermaidDiagram(diagramCtx);
    } else {
      let html = '';
      if (normalized.mode === 'detail') {
        if (diagramCtx) {
          html += '<p class="drill-hint">Switch to <strong>Diagram</strong> to view this result as a Mermaid chart.</p>';
        }
        html += buildDetailView(normalized.object);
        html += buildRelatedSections(normalized.related);
      } else if (normalized.mode === 'groupCompare') {
        html += buildGroupCompareView(normalized.compare);
      } else if (normalized.rows.length) {
        const hasDrillable = isFeatureEnabled('drillDown') && normalized.rows.some((r) => getDrillInfo(r));
        if (hasDrillable) {
          html += '<p class="drill-hint">Click a row to drill down into this object.</p>';
        }
        if (diagramCtx) {
          html += '<p class="drill-hint">Switch to <strong>Diagram</strong> to view this result as a Mermaid chart.</p>';
        }
        html += buildTable(normalized.rows);
      } else {
        html = '<p style="color:var(--muted)">No rows returned.</p>';
      }
      $('#resultsTableWrap').innerHTML = html;
    }

    $('#formattedJson').textContent = data == null ? '(no data)' : prettyJson(data);
    $('#rawCommand').textContent = command ? 'Command: ' + command : '';
    $('#rawOutput').textContent = raw || '(no output)';
    updateDrillNav();
  }

  function buildDetailView(obj) {
    if (!obj || typeof obj !== 'object') {
      return '<p style="color:var(--muted)">No object data.</p>';
    }
    const keys = Object.keys(obj).sort((a, b) => {
      if (a === 'DistinguishedName') return -1;
      if (b === 'DistinguishedName') return 1;
      return a.localeCompare(b);
    });
    let html = '<table class="result-table detail-table"><thead><tr><th>Property</th><th>Value</th></tr></thead><tbody>';
    keys.forEach((k) => {
      const v = obj[k];
      let cell;
      if (v != null && typeof v === 'object') {
        cell = `<pre class="cell-json">${escapeHtml(formatCellValue(v))}</pre>`;
      } else {
        cell = escapeHtml(v == null ? '' : String(v));
      }
      html += `<tr><th>${escapeHtml(k)}</th><td>${cell}</td></tr>`;
    });
    html += '</tbody></table>';
    return html;
  }

  function buildRelatedSections(related) {
    if (!related || typeof related !== 'object') return '';
    let html = '';
    if (Array.isArray(related.members) && related.members.length) {
      html += `<div class="related-section"><h4>Direct Members (${related.members.length})</h4>`;
      html += buildTable(related.members);
      html += '</div>';
    }
    if (Array.isArray(related.groups) && related.groups.length) {
      html += `<div class="related-section"><h4>Group Membership (${related.groups.length})</h4>`;
      html += buildTable(related.groups);
      html += '</div>';
    }
    return html;
  }

  function buildGroupCompareView(compare) {
    if (!compare || typeof compare !== 'object') {
      return '<p style="color:var(--muted)">No comparison data.</p>';
    }
    const a = compare.groupA || {};
    const b = compare.groupB || {};
    const summary = compare.summary || {};
    const nestedLabel = compare.includeNested ? 'nested' : 'direct';
    let html = `<p class="drill-hint">Comparing <strong>${escapeHtml(a.SamAccountName || a.Name || 'Group A')}</strong> vs <strong>${escapeHtml(b.SamAccountName || b.Name || 'Group B')}</strong> (${nestedLabel} membership).</p>`;
    html += '<div class="compare-summary">';
    html += `<span class="compare-stat">Group A members: <strong>${summary.totalA ?? 0}</strong></span>`;
    html += `<span class="compare-stat">Group B members: <strong>${summary.totalB ?? 0}</strong></span>`;
    html += `<span class="compare-stat">Only in A: <strong>${summary.onlyInA ?? 0}</strong></span>`;
    html += `<span class="compare-stat">Only in B: <strong>${summary.onlyInB ?? 0}</strong></span>`;
    html += `<span class="compare-stat">In both: <strong>${summary.inBoth ?? 0}</strong></span>`;
    html += '</div>';

    const sections = [
      { key: 'onlyInA', title: `Only in ${a.SamAccountName || a.Name || 'Group A'}`, className: 'only-a' },
      { key: 'inBoth', title: 'In Both Groups', className: 'both' },
      { key: 'onlyInB', title: `Only in ${b.SamAccountName || b.Name || 'Group B'}`, className: 'only-b' },
    ];
    sections.forEach((section) => {
      const rows = Array.isArray(compare[section.key]) ? compare[section.key] : [];
      html += `<div class="related-section compare-section ${section.className}">`;
      html += `<h4>${escapeHtml(section.title)} (${rows.length})</h4>`;
      if (rows.length) {
        const hasDrillable = rows.some((r) => getDrillInfo(r));
        if (hasDrillable) {
          html += '<p class="drill-hint">Click a row to drill down into this object.</p>';
        }
        html += buildTable(rows);
      } else {
        html += '<p style="color:var(--muted)">No members in this category.</p>';
      }
      html += '</div>';
    });
    return html;
  }

  function buildTable(rows) {
    const cols = [];
    const seen = new Set();
    rows.forEach((r) => {
      if (r && typeof r === 'object') {
        Object.keys(r).forEach((k) => { if (!seen.has(k)) { seen.add(k); cols.push(k); } });
      }
    });
    if (!cols.length) cols.push('value');
    cols.sort((a, b) => {
      if (a === 'DistinguishedName') return -1;
      if (b === 'DistinguishedName') return 1;
      return 0;
    });
    let html = '<table class="result-table"><thead><tr>' + cols.map((c) => `<th>${escapeHtml(c)}</th>`).join('') + '</tr></thead><tbody>';
    rows.forEach((r) => {
      const drill = getDrillInfo(r);
      html += `<tr${rowDrillAttrs(drill)}>` + cols.map((c) => {
        const v = typeof r === 'object' && r ? r[c] : (c === 'value' ? r : '');
        if (c === 'Success' && typeof v === 'boolean') {
          return `<td class="status-${v}">${v ? '✅ Success' : '❌ Failed'}</td>`;
        }
        if (v != null && typeof v === 'object') {
          return `<td><pre class="cell-json">${escapeHtml(formatCellValue(v))}</pre></td>`;
        }
        return `<td>${escapeHtml(v == null ? '' : String(v))}</td>`;
      }).join('') + '</tr>';
    });
    html += '</tbody></table>';
    return html;
  }

  function clearResults() {
    $('#resultsArea').classList.add('hidden');
    state.drillStack = [];
    state.resultView = 'table';
    state.lastMermaidSource = '';
    hideError();
  }

  // ---------- Export ----------
  $$('.export-buttons button').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!state.lastResult || state.lastResult.data == null) {
        alert('Run a query first.');
        return;
      }
      const fmt = btn.dataset.fmt;
      const res = await fetch('/api/reports/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          format: fmt,
          title: state.lastResult.title || 'report',
          data: state.lastResult.data,
          command: state.lastResult.command,
        }),
      });
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${(state.lastResult.title || 'report').replace(/[^a-z0-9_-]/gi, '_')}.${fmt}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    });
  });

  // ---------- Error display ----------
  function showError(err) {
    const banner = $('#errorBanner');
    banner.textContent = err.message || 'An error occurred.';
    banner.classList.remove('hidden');
    if (err.raw && !state.lastResult?.raw) {
      state.lastResult = { data: null, raw: err.raw, command: err.command, title: 'Error details' };
      renderResults();
    }
  }
  function hideError() {
    $('#errorBanner').classList.add('hidden');
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function escapeAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }
})();
