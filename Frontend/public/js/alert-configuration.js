/**
 * Alert Configuration — Email (live), WhatsApp & Telegram (coming soon).
 */
(function () {
  if (document.body.dataset.page !== 'alert-configuration') return;

  const root = document.getElementById('alertConfigRoot');
  if (!root) return;

  let config = null;
  let saving = false;

  function sessionUrl(path) {
    const sid = sessionStorage.getItem('atomoSessionId');
    return sid ? `${path}?sessionId=${encodeURIComponent(sid)}` : path;
  }

  function esc(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function showToast(msg, isError) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle('ov-toast-error', Boolean(isError));
    el.classList.toggle('ov-toast-success', !isError);
    el.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => {
      el.classList.remove('show', 'ov-toast-error', 'ov-toast-success');
    }, 3200);
  }

  function channelIcon(id) {
    if (id === 'email') {
      return `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 7L2 7"/></svg>`;
    }
    if (id === 'whatsapp') {
      return `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16.5 13.5c-.3-.2-1.8-.9-2.1-1s-.5-.2-.7.1-.8 1-.9 1.1-.3.2-.6.1a7.4 7.4 0 0 1-2.2-1.4 8.2 8.2 0 0 1-1.5-1.9c-.2-.3 0-.5.1-.6l.4-.5c.1-.2.2-.3.3-.5s0-.4-.1-.5-.7-1.7-.9-2.3c-.3-.6-.5-.5-.7-.5h-.6c-.2 0-.5.1-.8.4s-1 1-1 2.4 1.1 2.8 1.2 3 .2.4 2.1 3.2a14 14 0 0 0 4 2.8c1.6.5 2 .4 2.7.3a3 3 0 0 0 1.8-1.3c.2-.4.2-.7.1-.8s-.2-.2-.5-.4Z"/><path d="M12 2a9.9 9.9 0 0 0-8.5 15L2 22l5.2-1.4A10 10 0 1 0 12 2Z"/></svg>`;
    }
    return `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m22 3-9 9"/><path d="M22 3 15 21l-4-9-9-4 20-5Z"/></svg>`;
  }

  function parseRecipients(text) {
    return String(text || '')
      .split(/[\n,;]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  function render() {
    if (!config) {
      root.innerHTML = `<p class="ov-det-empty">Loading alert settings…</p>`;
      return;
    }

    const email = config.channels.email;
    const smtp = config.smtp || {};
    const events = config.eventOptions || [];
    const emailReady = Boolean(smtp.configured && email.enabled);

    root.innerHTML = `
      <div class="ov-alert-cfg">
        <p class="ov-alert-cfg-lead">
          Set how users get notified when detection alerts fire — danger zone, unknown face, blacklist, and more.
        </p>

        <div class="ov-alert-cfg-layout">
          ${renderChannelCard({
            id: 'email',
            title: 'Email',
            subtitle: 'Sender Gmail + App password → receivers get the alert',
            status: emailReady ? 'Active' : (email.enabled ? 'Setup needed' : 'Off'),
            statusClass: emailReady ? 'is-active' : (email.enabled ? 'is-soon' : 'is-off'),
            available: true,
            wide: true,
            body: renderEmailBody(email, events, smtp),
          })}

          <div class="ov-alert-cfg-side">
            ${renderChannelCard({
              id: 'whatsapp',
              title: 'WhatsApp',
              subtitle: 'Instant alerts on WhatsApp',
              status: 'Coming soon',
              statusClass: 'is-soon',
              available: false,
              body: `<p class="ov-alert-cfg-disabled-copy">WhatsApp alerts are in progress. This channel stays disabled until messaging is ready.</p>`,
            })}
            ${renderChannelCard({
              id: 'telegram',
              title: 'Telegram',
              subtitle: 'Push alerts to a Telegram chat',
              status: 'Coming soon',
              statusClass: 'is-soon',
              available: false,
              body: `<p class="ov-alert-cfg-disabled-copy">Telegram alerts are in progress. This channel stays disabled until bot delivery is ready.</p>`,
            })}
          </div>
        </div>
      </div>
    `;

    wireEvents();
  }

  function renderChannelCard({ id, title, subtitle, status, statusClass, available, body, wide }) {
    return `
      <article class="ov-alert-cfg-card ${available ? '' : 'is-unavailable'} ${wide ? 'is-wide' : ''}" role="listitem" data-channel="${esc(id)}">
        <header class="ov-alert-cfg-card-head">
          <div class="ov-alert-cfg-card-icon" aria-hidden="true">${channelIcon(id)}</div>
          <div class="ov-alert-cfg-card-titles">
            <h2>${esc(title)}</h2>
            <p>${esc(subtitle)}</p>
          </div>
          <span class="ov-alert-cfg-status ${statusClass}">${esc(status)}</span>
        </header>
        <div class="ov-alert-cfg-card-body">
          ${body}
        </div>
      </article>
    `;
  }

  function renderEmailBody(email, events, smtp) {
    const hasPass = Boolean(email.hasAppPassword);
    return `
      <div class="ov-alert-cfg-row ov-alert-cfg-row--switch">
        <div>
          <strong>Enable email alerts</strong>
          <span>Send mail when selected detection events occur</span>
        </div>
        <label class="ov-alert-cfg-switch">
          <input type="checkbox" id="alertEmailEnabled" ${email.enabled ? 'checked' : ''} />
          <span class="ov-alert-cfg-switch-ui" aria-hidden="true"></span>
        </label>
      </div>

      <div class="ov-alert-cfg-howto">
        <h3>How to create a Gmail App Password</h3>
        <ol>
          <li>Open your Google Account → <strong>Security</strong>.</li>
          <li>Turn on <strong>2-Step Verification</strong> (required).</li>
          <li>Search for <strong>App passwords</strong> and open it.</li>
          <li>Select app <strong>Mail</strong>, device <strong>Other</strong> (name it “Atomo Forge”), then Create.</li>
          <li>Copy the <strong>16-character password</strong> and paste it in <em>App password</em> below.
            Do <strong>not</strong> use your normal Gmail login password.</li>
        </ol>
        <p class="ov-alert-cfg-howto-link">
          Direct link:
          <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noopener noreferrer">
            myaccount.google.com/apppasswords
          </a>
        </p>
      </div>

      <div class="ov-alert-cfg-creds">
        <div class="ov-alert-cfg-field">
          <label for="alertSenderEmail">Sender email (Gmail)</label>
          <input
            id="alertSenderEmail"
            class="ov-det-input"
            type="email"
            autocomplete="username"
            placeholder="yourname@gmail.com"
            value="${esc(email.senderEmail || '')}"
          />
          <p class="ov-alert-cfg-hint">This Gmail account sends the alert emails.</p>
        </div>

        <div class="ov-alert-cfg-field">
          <label for="alertAppPassword">App password</label>
          <input
            id="alertAppPassword"
            class="ov-det-input"
            type="password"
            autocomplete="new-password"
            placeholder="${hasPass ? '••••••••••••••••  (saved — leave blank to keep)' : 'xxxx xxxx xxxx xxxx'}"
          />
          <p class="ov-alert-cfg-hint">
            ${hasPass
              ? 'An app password is already saved. Enter a new one only if you want to replace it.'
              : 'Paste the 16-character Google App Password (spaces are OK).'}
          </p>
        </div>
      </div>

      <div class="ov-alert-cfg-field">
        <label for="alertEmailRecipients">Receiver emails</label>
        <textarea
          id="alertEmailRecipients"
          class="ov-det-input ov-alert-cfg-textarea"
          rows="3"
          placeholder="ops@company.com&#10;security@company.com"
        >${esc((email.recipients || []).join('\n'))}</textarea>
        <p class="ov-alert-cfg-hint">Who should receive alerts — one email per line.</p>
      </div>

      <fieldset class="ov-alert-cfg-events">
        <legend>Notify on</legend>
        <div class="ov-alert-cfg-event-grid ov-alert-cfg-event-grid--2">
          ${events.map((ev) => `
            <label class="ov-alert-cfg-event">
              <input type="checkbox" data-event-id="${esc(ev.id)}" ${email.events?.[ev.id] ? 'checked' : ''} />
              <span>
                <strong>${esc(ev.label)}</strong>
                <em>${esc(ev.description || '')}</em>
              </span>
            </label>
          `).join('')}
        </div>
      </fieldset>

      <div class="ov-alert-cfg-smtp">
        <span class="ov-alert-cfg-smtp-dot ${smtp.configured ? 'is-ok' : 'is-bad'}"></span>
        ${smtp.configured
          ? `Ready to send · from ${esc(smtp.from || email.senderEmail || 'sender')}`
          : 'Add Sender email + App password, then Save to enable sending'}
      </div>

      <div class="ov-alert-cfg-actions">
        <button type="button" class="ov-quick-btn" id="alertEmailSave" ${saving ? 'disabled' : ''}>
          ${saving ? 'Saving…' : 'Save email settings'}
        </button>
        <button type="button" class="ov-quick-btn ov-alert-cfg-secondary" id="alertEmailTest">
          Send test email
        </button>
      </div>
    `;
  }

  function collectEmailPatch() {
    const enabled = Boolean(document.getElementById('alertEmailEnabled')?.checked);
    const senderEmail = String(document.getElementById('alertSenderEmail')?.value || '').trim();
    const appPassword = String(document.getElementById('alertAppPassword')?.value || '');
    const recipients = parseRecipients(document.getElementById('alertEmailRecipients')?.value || '');
    const events = {};
    root.querySelectorAll('[data-event-id]').forEach((input) => {
      events[input.dataset.eventId] = Boolean(input.checked);
    });
    const patch = { enabled, senderEmail, recipients, events };
    if (appPassword.trim()) patch.appPassword = appPassword;
    return patch;
  }

  function wireEvents() {
    document.getElementById('alertEmailSave')?.addEventListener('click', async () => {
      if (saving) return;
      const emailPatch = collectEmailPatch();
      if (emailPatch.enabled && !emailPatch.senderEmail) {
        showToast('Enter the Sender email (Gmail)', true);
        return;
      }
      if (emailPatch.enabled && !config.channels.email.hasAppPassword && !emailPatch.appPassword) {
        showToast('Enter the Google App password', true);
        return;
      }
      saving = true;
      render();
      try {
        const res = await fetch(sessionUrl('/api/alert-configuration'), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ channels: { email: emailPatch } }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Save failed');
        config = data;
        showToast('Email alert settings saved');
      } catch (err) {
        showToast(err.message || 'Could not save', true);
      } finally {
        saving = false;
        render();
      }
    });

    document.getElementById('alertEmailTest')?.addEventListener('click', async () => {
      const recipients = parseRecipients(document.getElementById('alertEmailRecipients')?.value || '');
      const to = recipients[0];
      if (!to) {
        showToast('Add at least one receiver email first', true);
        return;
      }
      const btn = document.getElementById('alertEmailTest');
      if (btn) btn.disabled = true;
      try {
        // Save current form values first so test uses latest sender/app password.
        const emailPatch = collectEmailPatch();
        const saveRes = await fetch(sessionUrl('/api/alert-configuration'), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ channels: { email: emailPatch } }),
        });
        const saveData = await saveRes.json();
        if (!saveRes.ok) throw new Error(saveData.error || 'Save failed before test');
        config = saveData;

        const res = await fetch(sessionUrl('/api/alert-configuration/test-email'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: to }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || 'Test email failed');
        showToast(`Test email sent to ${to}`);
        render();
      } catch (err) {
        showToast(err.message || 'Test email failed', true);
        render();
      } finally {
        const again = document.getElementById('alertEmailTest');
        if (again) again.disabled = false;
      }
    });
  }

  async function load() {
    try {
      const res = await fetch(sessionUrl('/api/alert-configuration'));
      if (!res.ok) throw new Error('Failed to load settings');
      config = await res.json();
      render();
    } catch (err) {
      root.innerHTML = `<p class="ov-det-empty">${esc(err.message || 'Could not load alert configuration')}</p>`;
    }
  }

  load();
})();
