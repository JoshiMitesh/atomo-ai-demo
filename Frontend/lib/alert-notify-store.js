/**
 * Alert notification preferences — email / WhatsApp / Telegram channels.
 */

const fs = require('fs');
const path = require('path');

const STORE_PATH = path.join(__dirname, '..', 'data', 'alert-notify.json');

const ALERT_EVENT_OPTIONS = [
  {
    id: 'person-restricted-area',
    label: 'Danger zone (person)',
    description: 'Email when a person is detected inside a danger zone — includes photo and zone details',
    defaultEnabled: true,
  },
  {
    id: 'fire-smoke-alert',
    label: 'Fire / smoke detected',
    description: 'Email when fire or smoke is detected — red Atomic Vision alert with photo',
    defaultEnabled: true,
  },
  {
    id: 'unknown-face-detected',
    label: 'Unknown face detected',
    description: 'Notify when an unrecognized person appears on camera',
    defaultEnabled: true,
  },
  {
    id: 'blacklisted-person',
    label: 'Blacklisted person',
    description: 'Notify when a blacklisted person is recognized',
    defaultEnabled: true,
  },
  {
    id: 'unauthorized-person',
    label: 'Unauthorized person',
    description: 'Notify when an unauthorized enrolled person is seen',
    defaultEnabled: true,
  },
  {
    id: 'vip-person',
    label: 'VIP person',
    description: 'Notify when a VIP is recognized',
    defaultEnabled: false,
  },
  {
    id: 'known-face-recognized',
    label: 'Known face recognized',
    description: 'Notify on every known-face match (simple notice, not red alert)',
    defaultEnabled: false,
  },
];

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

function defaultConfig() {
  const events = {};
  for (const opt of ALERT_EVENT_OPTIONS) {
    events[opt.id] = Boolean(opt.defaultEnabled);
  }
  return {
    channels: {
      email: {
        enabled: true,
        available: true,
        senderEmail: '',
        appPassword: '',
        recipients: [],
        events,
      },
      whatsapp: {
        enabled: false,
        available: false,
        recipients: [],
        events: { ...events },
      },
      telegram: {
        enabled: false,
        available: false,
        recipients: [],
        events: { ...events },
      },
    },
    updatedAt: null,
  };
}

function ensureStore() {
  const dir = path.dirname(STORE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(STORE_PATH)) {
    fs.writeFileSync(STORE_PATH, JSON.stringify(defaultConfig(), null, 2));
  }
}

function readRaw() {
  ensureStore();
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch {
    return defaultConfig();
  }
}

function writeRaw(data) {
  ensureStore();
  fs.writeFileSync(STORE_PATH, JSON.stringify(data, null, 2));
}

function normalizeEvents(input) {
  const events = {};
  for (const opt of ALERT_EVENT_OPTIONS) {
    if (input && typeof input[opt.id] === 'boolean') {
      events[opt.id] = input[opt.id];
    } else {
      events[opt.id] = Boolean(opt.defaultEnabled);
    }
  }
  return events;
}

function normalizeRecipients(list) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const email = String(raw || '').trim().toLowerCase();
    if (!isValidEmail(email)) continue;
    if (seen.has(email)) continue;
    seen.add(email);
    out.push(email);
  }
  return out.slice(0, 20);
}

function normalizeSenderEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  return isValidEmail(email) ? email : '';
}

function normalizeAppPassword(value) {
  // Gmail app passwords are 16 chars; allow spaces and strip them.
  return String(value || '').replace(/\s+/g, '').trim();
}

/** Full config including secrets — for server-side sending only. */
function getInternalConfig() {
  const raw = readRaw();
  const defaults = defaultConfig();
  const emailSrc = raw.channels?.email || {};
  const events = normalizeEvents(emailSrc.events || defaults.channels.email.events);

  return {
    channels: {
      email: {
        enabled: Boolean(emailSrc.enabled ?? defaults.channels.email.enabled),
        available: true,
        senderEmail: normalizeSenderEmail(emailSrc.senderEmail),
        appPassword: normalizeAppPassword(emailSrc.appPassword),
        recipients: normalizeRecipients(emailSrc.recipients),
        events,
      },
      whatsapp: {
        enabled: false,
        available: false,
        recipients: [],
        events: { ...events },
      },
      telegram: {
        enabled: false,
        available: false,
        recipients: [],
        events: { ...events },
      },
    },
    eventOptions: ALERT_EVENT_OPTIONS,
    updatedAt: raw.updatedAt || null,
  };
}

/** Public config for UI — never expose app password plaintext. */
function getConfig() {
  const internal = getInternalConfig();
  const email = internal.channels.email;
  return {
    channels: {
      email: {
        enabled: email.enabled,
        available: true,
        senderEmail: email.senderEmail,
        hasAppPassword: Boolean(email.appPassword),
        recipients: email.recipients,
        events: email.events,
      },
      whatsapp: internal.channels.whatsapp,
      telegram: internal.channels.telegram,
    },
    eventOptions: ALERT_EVENT_OPTIONS,
    updatedAt: internal.updatedAt,
  };
}

function updateConfig(patch = {}) {
  const current = getInternalConfig();
  const nextEmail = { ...current.channels.email };

  const emailPatch = patch.channels?.email || patch.email || null;
  if (emailPatch && typeof emailPatch === 'object') {
    if (typeof emailPatch.enabled === 'boolean') {
      nextEmail.enabled = emailPatch.enabled;
    }
    if (emailPatch.senderEmail != null) {
      nextEmail.senderEmail = normalizeSenderEmail(emailPatch.senderEmail);
    }
    if (emailPatch.appPassword != null && String(emailPatch.appPassword).trim() !== '') {
      nextEmail.appPassword = normalizeAppPassword(emailPatch.appPassword);
    }
    if (emailPatch.clearAppPassword === true) {
      nextEmail.appPassword = '';
    }
    if (emailPatch.recipients != null) {
      nextEmail.recipients = normalizeRecipients(emailPatch.recipients);
    }
    if (emailPatch.events && typeof emailPatch.events === 'object') {
      nextEmail.events = normalizeEvents({
        ...nextEmail.events,
        ...emailPatch.events,
      });
    }
  }

  const updatedAt = new Date().toISOString();
  writeRaw({
    channels: {
      email: nextEmail,
      whatsapp: {
        enabled: false,
        available: false,
        recipients: [],
        events: nextEmail.events,
      },
      telegram: {
        enabled: false,
        available: false,
        recipients: [],
        events: nextEmail.events,
      },
    },
    updatedAt,
  });

  try {
    require('./alert-notify').resetTransporterCache();
  } catch {
    /* ignore */
  }

  return getConfig();
}

module.exports = {
  ALERT_EVENT_OPTIONS,
  getConfig,
  getInternalConfig,
  updateConfig,
};
