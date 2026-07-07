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
    updateThemeButtons(getTheme());
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
      if (err.raw || err.command) {
        state.lastResult = { data: null, raw: err.raw, command: err.command, title: 'Domain connect failed' };
        renderResults();
      }
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
    if (!info) return '';
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
          flowchart: { htmlLabels: true, curve: 'basis' },
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

    $('#resultViewToggle').classList.toggle('hidden', !diagramCtx);
    if (!diagramCtx && state.resultView === 'diagram') {
      state.resultView = 'table';
      $$('#resultViewToggle button').forEach((b) => {
        b.classList.toggle('active', b.dataset.view === 'table');
      });
    }

    const showDiagram = diagramCtx && state.resultView === 'diagram';
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
      } else if (normalized.rows.length) {
        const hasDrillable = normalized.rows.some((r) => getDrillInfo(r));
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
