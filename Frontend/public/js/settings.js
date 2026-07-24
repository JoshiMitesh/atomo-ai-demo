(function () {
  const SECTIONS = [
    {
      id: 'device',
      label: 'Device settings',
      title: 'Device settings',
      summary: 'Name, timezone, and local device identity for this Atomo Forge node.',
      fields: [
        { id: 'deviceName', label: 'Device name', type: 'text', placeholder: 'Atomo Forge — Office' },
        { id: 'timezone', label: 'Timezone', type: 'text', placeholder: 'Asia/Kolkata' },
        { id: 'deviceId', label: 'Device ID', type: 'text', readonly: true, value: '—' },
      ],
    },
    {
      id: 'network',
      label: 'Network settings',
      title: 'Network settings',
      summary: 'IP configuration, DNS, and connectivity used by this device.',
      fields: [
        { id: 'hostname', label: 'Hostname', type: 'text', placeholder: 'atomo-forge' },
        { id: 'ipMode', label: 'IP mode', type: 'select', options: ['DHCP', 'Static'] },
        { id: 'dns', label: 'DNS servers', type: 'text', placeholder: '8.8.8.8, 1.1.1.1' },
      ],
    },
    {
      id: 'users',
      label: 'User management',
      title: 'User management',
      summary: 'Invite operators, manage accounts, and control who can sign in.',
      empty: 'User accounts are managed through Atomic Centre. Local operator invites will appear here.',
    },
    {
      id: 'roles',
      label: 'Role permissions',
      title: 'Role permissions',
      summary: 'Review Admin, Viewer, Operator, and other dashboard roles for this node.',
      link: { href: '/user-role', label: 'Open role selection' },
      empty: 'Role assignment for the current session can be changed from the role setup screen.',
    },
    {
      id: 'cameras',
      label: 'Camera settings',
      title: 'Camera settings',
      summary: 'Defaults for new cameras, stream quality, and reconnect behavior.',
      fields: [
        { id: 'defaultFps', label: 'Default FPS limit', type: 'number', placeholder: '25' },
        { id: 'defaultRes', label: 'Default resolution', type: 'text', placeholder: '1920x1080' },
        { id: 'reconnectSec', label: 'Reconnect interval (sec)', type: 'number', placeholder: '5' },
      ],
    },
    {
      id: 'ai-models',
      label: 'AI model settings',
      title: 'AI model settings',
      summary: 'Default confidence, inference rate, and model packaging preferences.',
      fields: [
        { id: 'confidence', label: 'Default confidence', type: 'number', placeholder: '0.70' },
        { id: 'inferFps', label: 'Inference FPS', type: 'number', placeholder: '15' },
      ],
      link: { href: '/dashboard#/ai-models', label: 'Open AI Models' },
    },
    {
      id: 'alerts',
      label: 'Alert settings',
      title: 'Alert settings',
      summary: 'Choose which detection events raise alerts and how severe they are treated.',
      fields: [
        { id: 'alertRetention', label: 'Alert retention (days)', type: 'number', placeholder: '30' },
        { id: 'soundEnabled', label: 'Play sound on critical alert', type: 'select', options: ['On', 'Off'] },
      ],
    },
    {
      id: 'notifications',
      label: 'Notification settings',
      title: 'Notification settings',
      summary: 'Email and other outbound channels for alert delivery.',
      link: { href: '/alert-configuration', label: 'Open Alert Configuration' },
      empty: 'Configure sender credentials and receivers in Alert Configuration.',
    },
    {
      id: 'atomic-centre',
      label: 'Atomic Centre account',
      title: 'Atomic Centre account',
      summary: 'Cloud account binding, organization, and sync status with Atomic Centre.',
      fields: [
        { id: 'orgName', label: 'Organization', type: 'text', readonly: true, value: '—' },
        { id: 'accountEmail', label: 'Account email', type: 'text', readonly: true, value: '—' },
        { id: 'syncStatus', label: 'Sync status', type: 'text', readonly: true, value: '—' },
      ],
    },
    {
      id: 'license',
      label: 'License settings',
      title: 'License settings',
      summary: 'Edition, seats, and renewal for this device license.',
      fields: [
        { id: 'edition', label: 'Edition', type: 'text', readonly: true, value: 'Enterprise' },
        { id: 'daysRemaining', label: 'Days remaining', type: 'text', readonly: true, value: '—' },
        { id: 'licenseKey', label: 'License key', type: 'text', placeholder: 'Enter license key' },
      ],
    },
    {
      id: 'cluster',
      label: 'Master/slave settings',
      title: 'Master/slave settings',
      summary: 'Cluster mode for this node — master, slave, or standalone.',
      link: { href: '/cluster-role', label: 'Change cluster mode' },
      fields: [
        { id: 'clusterMode', label: 'Current mode', type: 'text', readonly: true, value: '—' },
      ],
    },
    {
      id: 'storage',
      label: 'Storage settings',
      title: 'Storage settings',
      summary: 'Event retention, snapshot storage, and disk usage limits.',
      fields: [
        { id: 'eventDays', label: 'Event retention (days)', type: 'number', placeholder: '14' },
        { id: 'snapshotDays', label: 'Snapshot retention (days)', type: 'number', placeholder: '7' },
        { id: 'maxDiskPct', label: 'Max disk usage (%)', type: 'number', placeholder: '80' },
      ],
    },
    {
      id: 'backup',
      label: 'Backup and restore',
      title: 'Backup and restore',
      summary: 'Export configuration backups and restore a previous device state.',
      actions: [
        { id: 'backupNow', label: 'Create backup', primary: true },
        { id: 'restoreBackup', label: 'Restore from file' },
      ],
      empty: 'Backups include cameras, model settings, and alert configuration.',
    },
    {
      id: 'ota',
      label: 'OTA update',
      title: 'OTA update',
      summary: 'Check for firmware and software updates over the air.',
      fields: [
        { id: 'currentVersion', label: 'Current version', type: 'text', readonly: true, value: '—' },
        { id: 'channel', label: 'Update channel', type: 'select', options: ['Stable', 'Beta'] },
      ],
      actions: [{ id: 'checkUpdate', label: 'Check for updates', primary: true }],
    },
    {
      id: 'security',
      label: 'Security settings',
      title: 'Security settings',
      summary: 'Session timeout, password policy hints, and access hardening.',
      fields: [
        { id: 'sessionTimeout', label: 'Session timeout (minutes)', type: 'number', placeholder: '60' },
        { id: 'require2fa', label: 'Require 2FA via Atomic Centre', type: 'select', options: ['Recommended', 'Off'] },
      ],
    },
    {
      id: 'logs',
      label: 'Logs',
      title: 'Logs',
      summary: 'System, security, and application logs for diagnostics.',
      actions: [
        { id: 'refreshLogs', label: 'Refresh logs', primary: true },
        { id: 'downloadLogs', label: 'Download logs' },
      ],
      empty: 'Recent log lines will appear here when diagnostics are connected.',
    },
    {
      id: 'factory-reset',
      label: 'Factory reset',
      title: 'Factory reset',
      summary: 'Erase local configuration and return this device to factory defaults.',
      danger: true,
      actions: [{ id: 'factoryReset', label: 'Reset device', danger: true }],
      empty: 'This cannot be undone. Cameras, roles, and local model settings will be cleared.',
    },
  ];

  let activeId = 'device';
  let profile = null;

  function esc(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function sessionUrl(path) {
    const sid = sessionStorage.getItem('atomoSessionId');
    return sid ? `${path}?sessionId=${encodeURIComponent(sid)}` : path;
  }

  function showToast(msg) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 2600);
  }

  function sectionById(id) {
    return SECTIONS.find((s) => s.id === id) || SECTIONS[0];
  }

  function applyProfileToFields(section) {
    if (!profile || !section.fields) return section.fields;
    const mode = profile.clusterMode || '—';
    const map = {
      deviceId: profile.deviceId || profile.id || '—',
      deviceName: profile.deviceName || profile.organizationName || '',
      orgName: profile.organizationName || '—',
      accountEmail: profile.accountEmail || profile.email || '—',
      syncStatus: profile.syncStatus || (profile.registered === false ? 'Not registered' : 'Synced'),
      clusterMode: String(mode).toUpperCase(),
      edition: profile.license?.edition || 'Enterprise',
      daysRemaining:
        profile.license?.daysRemaining != null ? String(profile.license.daysRemaining) : '—',
      currentVersion: profile.softwareVersion || profile.version || '—',
    };
    return section.fields.map((f) => {
      if (map[f.id] != null && map[f.id] !== '') return { ...f, value: map[f.id] };
      return f;
    });
  }

  function renderField(field) {
    const value = field.value != null ? field.value : '';
    if (field.type === 'select') {
      const opts = (field.options || [])
        .map((o) => `<option value="${esc(o)}">${esc(o)}</option>`)
        .join('');
      return `
        <label class="ov-settings-field">
          <span>${esc(field.label)}</span>
          <select class="ov-det-select" data-field="${esc(field.id)}" ${field.readonly ? 'disabled' : ''}>${opts}</select>
        </label>`;
    }
    return `
      <label class="ov-settings-field">
        <span>${esc(field.label)}</span>
        <input
          class="ov-det-input"
          type="${esc(field.type || 'text')}"
          data-field="${esc(field.id)}"
          placeholder="${esc(field.placeholder || '')}"
          value="${esc(value)}"
          ${field.readonly ? 'readonly' : ''}
        />
      </label>`;
  }

  function renderPanel(section) {
    const fields = applyProfileToFields(section);
    const fieldsHtml = fields?.length
      ? `<div class="ov-settings-fields">${fields.map(renderField).join('')}</div>`
      : '';
    const emptyHtml = section.empty
      ? `<p class="ov-settings-empty">${esc(section.empty)}</p>`
      : '';
    const linkHtml = section.link
      ? `<a class="ov-quick-btn" href="${esc(section.link.href)}">${esc(section.link.label)}</a>`
      : '';
    const actionsHtml = (section.actions || [])
      .map((a) => {
        const cls = a.danger
          ? 'ov-cam-add-btn ov-settings-danger-btn'
          : a.primary
            ? 'ov-cam-add-btn'
            : 'ov-quick-btn';
        return `<button type="button" class="${cls}" data-action="${esc(a.id)}">${esc(a.label)}</button>`;
      })
      .join('');

    return `
      <article class="ov-settings-panel ${section.danger ? 'is-danger' : ''}" data-panel="${esc(section.id)}">
        <header class="ov-settings-panel-head">
          <h2>${esc(section.title)}</h2>
          <p>${esc(section.summary)}</p>
        </header>
        ${fieldsHtml}
        ${emptyHtml}
        <div class="ov-settings-panel-actions">
          ${actionsHtml}
          ${linkHtml}
          ${fields?.some((f) => !f.readonly) ? '<button type="button" class="ov-cam-add-btn" data-action="save-section">Save changes</button>' : ''}
        </div>
      </article>`;
  }

  function render() {
    const root = document.getElementById('settingsRoot');
    if (!root) return;
    const active = sectionById(activeId);

    root.innerHTML = `
      <div class="ov-settings-layout">
        <nav class="ov-settings-nav" aria-label="Settings sections">
          <p class="ov-settings-nav-label">Settings</p>
          <ul>
            ${SECTIONS.map(
              (s) => `
              <li>
                <button type="button" class="ov-settings-nav-item ${s.id === activeId ? 'is-active' : ''} ${s.danger ? 'is-danger' : ''}" data-section="${esc(s.id)}">
                  ${esc(s.label)}
                </button>
              </li>`
            ).join('')}
          </ul>
        </nav>
        <div class="ov-settings-content">
          ${renderPanel(active)}
        </div>
      </div>
    `;

    root.querySelectorAll('[data-section]').forEach((btn) => {
      btn.addEventListener('click', () => {
        activeId = btn.dataset.section;
        history.replaceState(null, '', `#${activeId}`);
        render();
      });
    });

    root.querySelectorAll('[data-action]').forEach((btn) => {
      btn.addEventListener('click', () => handleAction(btn.dataset.action));
    });
  }

  function handleAction(action) {
    if (action === 'save-section') {
      showToast('Settings saved locally for this section');
      return;
    }
    if (action === 'factoryReset') {
      if (!window.confirm('Factory reset this device? This cannot be undone.')) return;
      showToast('Factory reset requires admin confirmation from Atomic Centre');
      return;
    }
    if (action === 'backupNow') {
      showToast('Backup request queued');
      return;
    }
    if (action === 'restoreBackup') {
      showToast('Select a backup file from Atomic Centre to restore');
      return;
    }
    if (action === 'checkUpdate') {
      showToast('Checking for OTA updates…');
      return;
    }
    if (action === 'refreshLogs' || action === 'downloadLogs') {
      showToast('Logs will be available when diagnostics are connected');
    }
  }

  async function loadProfile() {
    try {
      const res = await fetch(sessionUrl('/api/session'));
      const data = await res.json();
      if (data?.profile) profile = data.profile;
      if (data?.deviceId && profile) profile.deviceId = data.deviceId;
    } catch {
      /* ignore */
    }
  }

  async function init() {
    const hash = (location.hash || '').replace(/^#/, '');
    if (hash && SECTIONS.some((s) => s.id === hash)) activeId = hash;
    await loadProfile();
    render();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
