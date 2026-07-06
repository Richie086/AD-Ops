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

  let state = {
    selectedDomainId: null,
    connected: false,
    lastResult: null, // { data, raw, command, title }
    role: null,
    username: null,
  };

  // ---------- Auth ----------
  const loginView = $('#loginView');
  const changePwView = $('#changePwView');
  const appView = $('#appView');

  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#loginError').textContent = '';
    try {
      const username = $('#loginUsername').value;
      const password = $('#loginPassword').value;
      const result = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
      if (result.mustChangePassword) {
        loginView.classList.add('hidden');
        changePwView.classList.remove('hidden');
      } else {
        enterApp(result);
      }
    } catch (err) {
      $('#loginError').textContent = err.message;
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
      enterApp(me);
    } catch (err) {
      $('#cpError').textContent = err.message;
    }
  });

  $('#logoutBtn').addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' });
    location.reload();
  });

  async function enterApp(who) {
    state.username = who.username;
    state.role = who.role;
    loginView.classList.add('hidden');
    changePwView.classList.add('hidden');
    appView.classList.remove('hidden');
    $('#userBadge').textContent = `${who.username} (${who.role})`;
    applyRoleVisibility(who.role);
    await loadDomains();
  }

  const ROLE_RANK = { viewer: 0, operator: 1, admin: 2 };
  function applyRoleVisibility(role) {
    $$('.role-gated').forEach((el) => {
      const minRole = el.dataset.minRole || 'viewer';
      el.classList.toggle('hidden', ROLE_RANK[role] < ROLE_RANK[minRole]);
    });
    $('#historyAllToggleWrap').classList.toggle('hidden', role !== 'admin');
  }

  // Check existing session on load.
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

  $('#addDomainForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    await api('/api/domains', {
      method: 'POST',
      body: JSON.stringify({
        label: $('#newDomainLabel').value,
        dcHost: $('#newDomainHost').value,
        notes: $('#newDomainNotes').value,
      }),
    });
    $('#addDomainForm').reset();
    loadDomains();
  });

  $('#domainSelect').addEventListener('change', (e) => {
    state.selectedDomainId = e.target.value || null;
    state.connected = false;
    updateConnStatus();
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

  $('#connectBtn').addEventListener('click', async () => {
    if (!state.selectedDomainId) {
      alert('Select a saved domain first.');
      return;
    }
    const username = prompt('Domain admin username (e.g. CONTOSO\\admin):');
    if (!username) return;
    const password = prompt('Password:');
    if (!password) return;
    try {
      $('#connStatus').textContent = 'Connecting…';
      await api(`/api/domains/${state.selectedDomainId}/connect`, {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });
      state.connected = true;
      updateConnStatus();
    } catch (err) {
      state.connected = false;
      updateConnStatus();
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

  function requireConnection() {
    if (!state.selectedDomainId || !state.connected) {
      showError({ message: 'Connect to a saved domain first (top bar).' });
      return false;
    }
    return true;
  }

  async function runQuery(endpoint, payload, title) {
    hideError();
    try {
      const result = await api(endpoint, { method: 'POST', body: JSON.stringify(payload) });
      state.lastResult = { data: result.data, raw: result.raw, command: result.command, title };
      renderResults();
    } catch (err) {
      state.lastResult = { data: null, raw: err.raw, command: err.command, title };
      renderResults();
      showError(err);
    }
  }

  // ---------- Results rendering ----------
  function renderResults() {
    const area = $('#resultsArea');
    area.classList.remove('hidden');
    const { data, raw, command } = state.lastResult;

    const rows = data == null ? [] : Array.isArray(data) ? data : [data];
    $('#resultsTableWrap').innerHTML = rows.length ? buildTable(rows) : '<p style="color:var(--muted)">No rows returned.</p>';
    $('#rawCommand').textContent = command ? 'Command: ' + command : '';
    $('#rawOutput').textContent = raw || '(no output)';
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
    let html = '<table class="result-table"><thead><tr>' + cols.map((c) => `<th>${escapeHtml(c)}</th>`).join('') + '</tr></thead><tbody>';
    rows.forEach((r) => {
      html += '<tr>' + cols.map((c) => {
        let v = typeof r === 'object' && r ? r[c] : (c === 'value' ? r : '');
        if (v && typeof v === 'object') v = JSON.stringify(v);
        if (c === 'Success' && typeof v === 'boolean') {
          return `<td class="status-${v}">${v ? '✅ Success' : '❌ Failed'}</td>`;
        }
        return `<td>${escapeHtml(v == null ? '' : String(v))}</td>`;
      }).join('') + '</tr>';
    });
    html += '</tbody></table>';
    return html;
  }

  function clearResults() {
    $('#resultsArea').classList.add('hidden');
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
  }
  function hideError() {
    $('#errorBanner').classList.add('hidden');
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
})();
