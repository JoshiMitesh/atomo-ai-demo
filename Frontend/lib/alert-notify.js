/**
 * Dispatch detection alerts to configured channels (email live; WhatsApp/Telegram later).
 * Critical alerts (unknown / danger zone / fire / blacklist) use Atomic Vision red template.
 * Known-face alerts use a simple neutral template (not red).
 */

const fs = require('fs');
const path = require('path');
const alertNotifyStore = require('./alert-notify-store');

let transporterPromise = null;
let transporterKey = null;
const recentSendAt = new Map();
const SEND_COOLDOWN_MS = 60_000;

const LOGO_PATH = path.join(__dirname, '..', 'dashboard', 'atomoheaderlogo.png');
const LOGO_CID = 'atomo-logo@atomo';
const SNAP_CID = 'face-snapshot@atomo';

function resetTransporterCache() {
  transporterPromise = null;
  transporterKey = null;
}

function loadSmtpConfig() {
  const email = alertNotifyStore.getInternalConfig().channels.email;
  if (email.senderEmail && email.appPassword) {
    const isGmail = /@(gmail|googlemail)\.com$/i.test(email.senderEmail);
    return {
      host: isGmail ? 'smtp.gmail.com' : (process.env.SMTP_HOST || 'smtp.gmail.com'),
      port: Number(process.env.SMTP_PORT || 587),
      user: email.senderEmail,
      pass: email.appPassword,
      from: email.senderEmail,
      name: 'Atomic Vision',
      tls: false,
      source: 'user',
    };
  }

  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    return {
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      name: process.env.SMTP_NAME || 'Atomic Vision',
      tls: process.env.SMTP_TLS === 'true',
      source: 'env',
    };
  }

  return null;
}

function getSmtpStatus() {
  const email = alertNotifyStore.getInternalConfig().channels.email;
  const smtp = loadSmtpConfig();
  const ready = Boolean(smtp?.host && smtp?.user && smtp?.pass);
  return {
    configured: ready,
    host: smtp?.host || (email.senderEmail ? 'smtp.gmail.com' : null),
    from: email.senderEmail || smtp?.from || null,
    hasSender: Boolean(email.senderEmail),
    hasAppPassword: Boolean(email.appPassword),
    hasRecipients: email.recipients.length > 0,
    source: smtp?.source || null,
  };
}

function resolveNodemailer() {
  try {
    return require('nodemailer');
  } catch {
    return require(path.join(
      __dirname,
      '..',
      'atomic',
      'MeshCentral-master',
      'node_modules',
      'nodemailer',
    ));
  }
}

async function getTransporter() {
  const smtp = loadSmtpConfig();
  if (!smtp?.host || !smtp?.user || !smtp?.pass) return null;

  const key = `${smtp.host}:${smtp.port}:${smtp.user}:${smtp.pass}`;
  if (transporterPromise && transporterKey === key) return transporterPromise;

  transporterKey = key;
  transporterPromise = (async () => {
    let nodemailer;
    try {
      nodemailer = resolveNodemailer();
    } catch (err) {
      console.warn('[alert-notify] nodemailer missing:', err.message);
      return null;
    }
    const secure = smtp.tls || Number(smtp.port) === 465;
    const options = smtp.user.toLowerCase().endsWith('@gmail.com')
      || smtp.user.toLowerCase().endsWith('@googlemail.com')
      ? { service: 'gmail', auth: { user: smtp.user, pass: smtp.pass } }
      : {
        host: smtp.host,
        port: Number(smtp.port) || 587,
        secure,
        auth: { user: smtp.user, pass: smtp.pass },
      };
    return nodemailer.createTransport(options);
  })();
  return transporterPromise;
}

function shouldNotifyEmail(alertType) {
  const cfg = alertNotifyStore.getInternalConfig();
  const email = cfg.channels.email;
  if (!email.enabled || !email.available) return false;
  if (!email.recipients.length) return false;
  if (!email.senderEmail || !email.appPassword) return false;
  if (!email.events?.[alertType]) return false;
  return true;
}

function cooldownKey(alert, channel) {
  return `${channel}:${alert.type || 'alert'}:${alert.cameraId || ''}:${alert.personId || alert.personName || alert.trackingId || alert.zoneName || 'any'}`;
}

function canSendNow(key) {
  const last = recentSendAt.get(key) || 0;
  if (Date.now() - last < SEND_COOLDOWN_MS) return false;
  recentSendAt.set(key, Date.now());
  if (recentSendAt.size > 400) {
    const first = recentSendAt.keys().next().value;
    recentSendAt.delete(first);
  }
  return true;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function normalizeAlertJpeg(jpeg) {
  if (!jpeg || typeof jpeg !== 'string' || jpeg.length < 64) return null;
  const raw = jpeg.replace(/^data:image\/\w+;base64,/, '');
  return raw.length >= 64 ? raw : null;
}

function safeAttachmentName(alert) {
  const base = String(alert.personName || alert.zoneName || alert.type || 'detection')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'detection';
  return `${base}-alert.jpg`;
}

function resolveAlertJpeg(alert) {
  const direct = normalizeAlertJpeg(alert?.snapshotJpeg);
  if (direct) return direct;
  const eventId = alert?.snapshotEventId;
  if (!eventId) return null;
  try {
    const detectionStore = require('./detection-store');
    const snap = detectionStore.getEventSnapshot(eventId);
    return normalizeAlertJpeg(snap?.jpeg) || null;
  } catch {
    return null;
  }
}

function loadLogoAttachment() {
  try {
    if (!fs.existsSync(LOGO_PATH)) return null;
    const content = fs.readFileSync(LOGO_PATH);
    if (!content?.length) return null;
    return {
      filename: 'atomo-logo.png',
      content,
      contentType: 'image/png',
      cid: LOGO_CID,
    };
  } catch (err) {
    console.warn('[alert-notify] logo load failed:', err.message);
    return null;
  }
}

function makeAlertId(when = new Date()) {
  const d = when instanceof Date ? when : new Date(when);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  return `ATV-${y}${m}${day}-${h}${mi}${s}`;
}

function confPercent(alert) {
  if (alert.confidence == null) return null;
  const n = Number(alert.confidence);
  if (!Number.isFinite(n)) return null;
  return `${Math.round(n * (n <= 1 ? 100 : 1))}%`;
}

function dashboardUrl() {
  const host = process.env.PUBLIC_DASHBOARD_URL
    || process.env.DASHBOARD_URL
    || `http://${process.env.HOST === '0.0.0.0' ? 'localhost' : (process.env.HOST || 'localhost')}:${process.env.PORT || 3000}`;
  return String(host).replace(/\/$/, '');
}

/**
 * Critical / security alerts get the red Atomic Vision template.
 * Known-face (and VIP) stay simple / non-red.
 */
function isCriticalAlertTheme(alertType) {
  const t = String(alertType || '');
  if (t === 'known-face-recognized' || t === 'vip-person') return false;
  return [
    'unknown-face-detected',
    'person-restricted-area',
    'fire-smoke-alert',
    'fire',
    'blacklisted-person',
    'unauthorized-person',
  ].includes(t) || t.includes('fire') || t.includes('danger') || t.includes('restricted');
}

function resolveAlertMeta(alert) {
  const type = alert?.type || 'alert';
  const person = alert?.personName || null;
  const zone = alert?.zoneName || alert?.zone || null;

  if (type === 'unknown-face-detected') {
    return {
      headline: 'UNKNOWN PERSON',
      introHighlight: 'unknown person',
      intro: 'This is an automated alert from your Atomic Vision System. An <strong style="color:#c62828">unknown person</strong> has been detected.',
      nameLabel: 'Unknown Person',
      typeLabel: 'Unknown',
      statusLabel: 'UNKNOWN',
      summaryType: 'Unknown Person Detected',
      alertTypeLine: 'Unknown Person Detected',
    };
  }
  if (type === 'person-restricted-area') {
    const z = zone || 'Danger zone';
    return {
      headline: 'DANGER ZONE',
      introHighlight: 'danger zone',
      intro: `This is an automated alert from your Atomic Vision System. A person was detected inside danger zone <strong style="color:#c62828">${escapeHtml(z)}</strong>.`,
      nameLabel: person || 'Person detected',
      typeLabel: 'Danger Zone',
      statusLabel: 'DANGER',
      summaryType: 'Danger Zone Intrusion',
      alertTypeLine: `Danger Zone — ${z}`,
    };
  }
  if (type === 'fire-smoke-alert' || type === 'fire' || String(type).includes('fire')) {
    return {
      headline: 'FIRE / SMOKE',
      introHighlight: 'fire or smoke',
      intro: 'This is an automated alert from your Atomic Vision System. <strong style="color:#c62828">Fire or smoke</strong> has been detected.',
      nameLabel: person || 'Fire / Smoke',
      typeLabel: 'Fire & Smoke',
      statusLabel: 'CRITICAL',
      summaryType: 'Fire / Smoke Detected',
      alertTypeLine: 'Fire / Smoke Detected',
    };
  }
  if (type === 'blacklisted-person') {
    return {
      headline: 'BLACKLISTED',
      introHighlight: 'blacklisted person',
      intro: `This is an automated alert from your Atomic Vision System. A <strong style="color:#c62828">blacklisted person</strong>${person ? ` (<strong>${escapeHtml(person)}</strong>)` : ''} has been detected.`,
      nameLabel: person || 'Blacklisted person',
      typeLabel: 'Blacklist',
      statusLabel: 'BLACKLIST',
      summaryType: 'Blacklisted Person Detected',
      alertTypeLine: 'Blacklisted Person Detected',
    };
  }
  if (type === 'unauthorized-person') {
    return {
      headline: 'UNAUTHORIZED',
      introHighlight: 'unauthorized person',
      intro: `This is an automated alert from your Atomic Vision System. An <strong style="color:#c62828">unauthorized person</strong>${person ? ` (<strong>${escapeHtml(person)}</strong>)` : ''} has been detected.`,
      nameLabel: person || 'Unauthorized person',
      typeLabel: 'Unauthorized',
      statusLabel: 'UNAUTHORIZED',
      summaryType: 'Unauthorized Person Detected',
      alertTypeLine: 'Unauthorized Person Detected',
    };
  }
  if (type === 'known-face-recognized') {
    return {
      headline: 'KNOWN PERSON',
      intro: `This is an automated notice from your Atomic Vision System. <strong>${escapeHtml(person || 'A known person')}</strong> was recognized.`,
      nameLabel: person || 'Known person',
      typeLabel: 'Known',
      statusLabel: 'KNOWN',
      summaryType: 'Known Face Recognized',
      alertTypeLine: 'Known Face Recognized',
    };
  }
  if (type === 'vip-person') {
    return {
      headline: 'VIP PERSON',
      intro: `This is an automated notice from your Atomic Vision System. VIP <strong>${escapeHtml(person || 'person')}</strong> was recognized.`,
      nameLabel: person || 'VIP',
      typeLabel: 'VIP',
      statusLabel: 'VIP',
      summaryType: 'VIP Detected',
      alertTypeLine: 'VIP Person Detected',
    };
  }
  return {
    headline: String(alert?.title || 'DETECTION ALERT').toUpperCase(),
    intro: escapeHtml(alert?.message || 'A detection alert was raised by Atomic Vision.'),
    nameLabel: person || zone || 'Detection',
    typeLabel: type,
    statusLabel: String(alert?.severity || 'ALERT').toUpperCase(),
    summaryType: alert?.title || 'Detection Alert',
    alertTypeLine: alert?.title || type,
  };
}

function formatDetectedAt(d) {
  try {
    return d.toLocaleString('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    }).replace(',', ' |');
  } catch {
    return d.toLocaleString();
  }
}

function detailRow(icon, label, valueHtml) {
  return `
    <tr>
      <td style="padding:8px 0;vertical-align:top;width:28px;color:#9aa0a6;font-size:14px">${icon}</td>
      <td style="padding:8px 0;vertical-align:top">
        <div style="font-size:11px;color:#8e8e8e;letter-spacing:0.04em;text-transform:uppercase">${label}</div>
        <div style="font-size:14px;color:#1a1a1a;font-weight:600;margin-top:2px">${valueHtml}</div>
      </td>
    </tr>`;
}

function buildCriticalHtml(alert, meta, opts) {
  const {
    alertId, when, dateLabel, timeLabel, confPct, hasPhoto, dashUrl,
  } = opts;
  const camera = escapeHtml(alert.cameraName || 'Unknown');
  const location = escapeHtml(alert.location || '—');
  const nameColor = '#c62828';

  const photoCell = hasPhoto
    ? `<td style="width:48%;vertical-align:top;padding-right:16px">
        <div style="position:relative;border:1px solid #f0c2c2;border-radius:8px;overflow:hidden;background:#111">
          <img src="cid:${SNAP_CID}" alt="Detection snapshot"
            style="display:block;width:100%;max-width:280px;height:auto" />
        </div>
      </td>`
    : `<td style="width:48%;vertical-align:top;padding-right:16px">
        <div style="border:1px dashed #f0c2c2;border-radius:8px;padding:40px 16px;text-align:center;color:#c62828;font-size:13px;background:#fff8f8">
          No snapshot available
        </div>
      </td>`;

  return `
<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:0;background:#f3f3f3;font-family:Segoe UI,Helvetica,Arial,sans-serif">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f3f3f3;padding:24px 12px">
    <tr><td align="center">
      <table role="presentation" width="640" cellspacing="0" cellpadding="0" style="max-width:640px;width:100%;background:#ffffff;border-radius:4px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08)">
        <!-- Header -->
        <tr>
          <td style="background:#0a0a0a;padding:14px 20px">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
              <tr>
                <td style="vertical-align:middle;white-space:nowrap">
                  <img src="cid:${LOGO_CID}" alt="Atomo" width="28" height="28"
                    style="display:inline-block;vertical-align:middle;margin-right:8px;border:0" />
                  <span style="display:inline-block;vertical-align:middle;color:#ffffff;font-weight:800;font-size:16px;letter-spacing:0.12em">ATOMO</span>
                </td>
                <td align="center" style="vertical-align:middle;padding:0 8px">
                  <span style="color:#c62828;font-size:11px">——</span>
                  <span style="color:#ffffff;font-weight:700;font-size:12px;letter-spacing:0.28em;padding:0 8px">ATOMIC VISION</span>
                  <span style="color:#c62828;font-size:11px">——</span>
                </td>
                <td align="right" style="vertical-align:middle;white-space:nowrap">
                  <span style="color:#c62828;font-size:16px;margin-right:6px">▲</span>
                  <span style="display:inline-block;text-align:left;vertical-align:middle">
                    <span style="display:block;color:#ffffff;font-size:10px;font-weight:700;letter-spacing:0.08em">DETECTION ALERT</span>
                    <span style="display:block;color:#c62828;font-size:11px;font-weight:800;letter-spacing:0.04em">${escapeHtml(meta.headline)}</span>
                  </span>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Greeting -->
        <tr>
          <td style="padding:28px 28px 8px">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
              <tr>
                <td style="vertical-align:top">
                  <div style="font-size:20px;font-weight:700;color:#111;margin-bottom:8px">Hello,</div>
                  <div style="font-size:14px;color:#444;line-height:1.55;max-width:380px">${meta.intro}</div>
                </td>
                <td align="right" style="vertical-align:top;padding-left:12px">
                  <span style="display:inline-block;background:#fde8e8;color:#c62828;font-size:11px;font-weight:700;padding:8px 12px;border-radius:999px;letter-spacing:0.02em">
                    ALERT ID: ${escapeHtml(alertId)}
                  </span>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Snapshot + details -->
        <tr>
          <td style="padding:20px 28px 8px">
            <div style="color:#c62828;font-size:13px;font-weight:800;letter-spacing:0.08em;margin-bottom:14px">
              ▣&nbsp; DETECTION SNAPSHOT
            </div>
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
              <tr>
                ${photoCell}
                <td style="width:52%;vertical-align:top">
                  <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                    ${detailRow('👤', 'Name', `<span style="color:${nameColor}">${escapeHtml(meta.nameLabel)}</span>`)}
                    ${detailRow('◈', 'Type', escapeHtml(meta.typeLabel))}
                    ${detailRow('◎', 'Security Status', `<span style="display:inline-block;background:#fde8e8;color:#c62828;font-size:11px;font-weight:800;padding:4px 10px;border-radius:999px">${escapeHtml(meta.statusLabel)}</span>`)}
                    ${detailRow('▣', 'Camera', camera)}
                    ${detailRow('⌖', 'Location', location)}
                    ${meta.zoneExtra || ''}
                    ${confPct ? detailRow('%', 'Confidence', escapeHtml(confPct)) : ''}
                    ${detailRow('◷', 'Detected At', escapeHtml(when))}
                  </table>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Alert summary -->
        <tr>
          <td style="padding:16px 28px">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#fff5f5;border:1px solid #f5d0d0;border-radius:10px">
              <tr>
                <td style="padding:16px 18px">
                  <div style="color:#c62828;font-size:12px;font-weight:800;letter-spacing:0.08em;margin-bottom:12px">
                    ▲&nbsp; ALERT SUMMARY
                  </div>
                  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="font-size:13px">
                    <tr>
                      <td style="padding:5px 0;color:#666">Alert Type</td>
                      <td align="right" style="padding:5px 0;color:#c62828;font-weight:700">${escapeHtml(meta.alertTypeLine)}</td>
                    </tr>
                    <tr>
                      <td style="padding:5px 0;color:#666">System Status</td>
                      <td align="right" style="padding:5px 0;color:#c62828;font-weight:700">Attention Required</td>
                    </tr>
                    <tr>
                      <td style="padding:5px 0;color:#666">Source</td>
                      <td align="right" style="padding:5px 0;color:#333;font-weight:600">Atomic Vision System</td>
                    </tr>
                    <tr>
                      <td style="padding:5px 0;color:#666">Date</td>
                      <td align="right" style="padding:5px 0;color:#333;font-weight:600">${escapeHtml(dateLabel)}</td>
                    </tr>
                    <tr>
                      <td style="padding:5px 0;color:#666">Time</td>
                      <td align="right" style="padding:5px 0;color:#333;font-weight:600">${escapeHtml(timeLabel)}</td>
                    </tr>
                  </table>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Security notice + CTA -->
        <tr>
          <td style="padding:8px 28px 24px">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#ffe8e8;border-radius:10px">
              <tr>
                <td style="padding:14px 16px;vertical-align:middle;width:36px;color:#c62828;font-size:20px">🛡</td>
                <td style="padding:14px 8px;vertical-align:middle">
                  <div style="color:#c62828;font-size:13px;font-weight:800">SECURITY NOTICE</div>
                  <div style="color:#444;font-size:12px;margin-top:2px;line-height:1.4">This is an automated alert for your awareness. Please review the system if any action is required.</div>
                </td>
                <td style="padding:14px 16px;vertical-align:middle;text-align:right;white-space:nowrap">
                  <a href="${escapeHtml(dashUrl)}" style="display:inline-block;background:#c62828;color:#ffffff;text-decoration:none;font-size:12px;font-weight:800;letter-spacing:0.04em;padding:12px 16px;border-radius:6px">
                    REVIEW IN DASHBOARD
                  </a>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background:#2b2b2b;padding:18px 24px">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
              <tr>
                <td style="vertical-align:middle">
                  <div style="color:#ffffff;font-size:13px;font-weight:700">Atomo Innovation Pvt. Ltd.</div>
                  <div style="color:#a0a0a0;font-size:11px;margin-top:4px">AI-Powered Vision Intelligence for a Safer Tomorrow</div>
                </td>
                <td align="right" style="vertical-align:middle">
                  <div style="color:#a0a0a0;font-size:11px">Need help? Contact your system administrator.</div>
                  <a href="https://www.atomo.in" style="color:#c62828;font-size:12px;font-weight:700;text-decoration:none">www.atomo.in</a>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

function buildSimpleKnownHtml(alert, meta, opts) {
  const {
    alertId, when, confPct, hasPhoto, dashUrl,
  } = opts;
  const camera = escapeHtml(alert.cameraName || 'Unknown');
  const location = escapeHtml(alert.location || '—');
  const person = escapeHtml(meta.nameLabel);

  const photoBlock = hasPhoto
    ? `<div style="margin:16px 0"><img src="cid:${SNAP_CID}" alt="${person}" style="display:block;max-width:280px;width:100%;border-radius:8px;border:1px solid #e5e5e5" /></div>`
    : '';

  return `
<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Segoe UI,Helvetica,Arial,sans-serif">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f5f5f5;padding:24px 12px">
    <tr><td align="center">
      <table role="presentation" width="560" cellspacing="0" cellpadding="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:6px;overflow:hidden;border:1px solid #e8e8e8">
        <tr>
          <td style="background:#111;padding:14px 20px">
            <img src="cid:${LOGO_CID}" alt="Atomo" width="26" height="26"
              style="display:inline-block;vertical-align:middle;margin-right:8px;border:0" />
            <span style="display:inline-block;vertical-align:middle;color:#fff;font-weight:800;font-size:15px;letter-spacing:0.1em">ATOMO</span>
            <span style="display:inline-block;vertical-align:middle;color:#aaa;font-size:11px;letter-spacing:0.2em;margin-left:14px">ATOMIC VISION</span>
          </td>
        </tr>
        <tr>
          <td style="padding:24px 28px">
            <div style="font-size:11px;color:#888;margin-bottom:6px">NOTICE ID: ${escapeHtml(alertId)}</div>
            <h2 style="margin:0 0 10px;font-size:18px;color:#111">${escapeHtml(meta.headline)}</h2>
            <p style="margin:0 0 16px;color:#555;font-size:14px;line-height:1.5">${meta.intro}</p>
            ${photoBlock}
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="font-size:14px;border-top:1px solid #eee;padding-top:8px">
              <tr><td style="padding:8px 0;color:#888">Name</td><td style="padding:8px 0;font-weight:600;color:#111">${person}</td></tr>
              <tr><td style="padding:8px 0;color:#888">Status</td><td style="padding:8px 0"><span style="background:#e8f5e9;color:#2e7d32;font-size:11px;font-weight:700;padding:3px 8px;border-radius:999px">${escapeHtml(meta.statusLabel)}</span></td></tr>
              <tr><td style="padding:8px 0;color:#888">Camera</td><td style="padding:8px 0;font-weight:600">${camera}</td></tr>
              <tr><td style="padding:8px 0;color:#888">Location</td><td style="padding:8px 0;font-weight:600">${location}</td></tr>
              ${confPct ? `<tr><td style="padding:8px 0;color:#888">Confidence</td><td style="padding:8px 0;font-weight:600">${escapeHtml(confPct)}</td></tr>` : ''}
              <tr><td style="padding:8px 0;color:#888">Detected At</td><td style="padding:8px 0;font-weight:600">${escapeHtml(when)}</td></tr>
            </table>
            <div style="margin-top:20px">
              <a href="${escapeHtml(dashUrl)}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;font-size:12px;font-weight:700;padding:10px 16px;border-radius:6px">OPEN DASHBOARD</a>
            </div>
          </td>
        </tr>
        <tr>
          <td style="background:#f0f0f0;padding:14px 24px;font-size:11px;color:#777">
            Atomo Innovation Pvt. Ltd. · <a href="https://www.atomo.in" style="color:#333">www.atomo.in</a>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

function buildEmailContent(alert, { hasPhoto = false } = {}) {
  const created = alert.createdAt ? new Date(alert.createdAt) : new Date();
  const alertId = alert.alertId || makeAlertId(created);
  const when = formatDetectedAt(created);
  const dateLabel = created.toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric',
  });
  const timeLabel = `${created.toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true,
  })} (IST)`;
  const confPct = confPercent(alert);
  const meta = resolveAlertMeta(alert);
  const zone = alert.zoneName || alert.zone || null;
  if (zone && alert.type === 'person-restricted-area') {
    meta.zoneExtra = detailRow('⚠', 'Danger zone', `<span style="color:#c62828">${escapeHtml(zone)}</span>`);
  }

  const opts = {
    alertId,
    when,
    dateLabel,
    timeLabel,
    confPct,
    hasPhoto,
    dashUrl: dashboardUrl(),
  };

  const critical = isCriticalAlertTheme(alert.type);
  const html = critical
    ? buildCriticalHtml(alert, meta, opts)
    : buildSimpleKnownHtml(alert, meta, opts);

  const person = alert.personName || null;
  const lines = [
    `Atomic Vision — ${meta.headline}`,
    '',
    alert.message || meta.summaryType,
    '',
    `Alert ID: ${alertId}`,
    person ? `Name: ${person}` : null,
    zone ? `Danger zone: ${zone}` : null,
    `Type: ${meta.typeLabel}`,
    `Camera: ${alert.cameraName || 'Unknown'}`,
    `Location: ${alert.location || '—'}`,
    confPct ? `Confidence: ${confPct}` : null,
    `Detected At: ${when}`,
    hasPhoto ? 'Photo: attached' : null,
    '',
    `Dashboard: ${opts.dashUrl}`,
    '',
    'Atomo Innovation Pvt. Ltd. · www.atomo.in',
  ].filter(Boolean);

  const subjectCore = person
    ? `${person} — ${meta.headline}`
    : (zone ? `${zone} — ${meta.headline}` : meta.headline);

  return {
    subject: `[Atomic Vision] ${subjectCore}`,
    text: lines.join('\n'),
    html,
    alertId,
    critical,
  };
}

async function sendEmailAlert(alert) {
  if (!shouldNotifyEmail(alert?.type)) {
    return { ok: false, skipped: true, reason: 'email_disabled_or_unconfigured' };
  }
  const key = cooldownKey(alert, 'email');
  if (!canSendNow(key)) {
    return { ok: false, skipped: true, reason: 'cooldown' };
  }

  const smtp = loadSmtpConfig();
  const transport = await getTransporter();
  if (!smtp || !transport) {
    return { ok: false, error: 'Add Sender email and App password in Alert Configuration' };
  }

  const cfg = alertNotifyStore.getInternalConfig();
  const jpeg = resolveAlertJpeg(alert);
  const { subject, text, html } = buildEmailContent(alert, { hasPhoto: Boolean(jpeg) });
  const fromAddr = smtp.from || smtp.user;
  const attachments = [];

  const logo = loadLogoAttachment();
  if (logo) attachments.push(logo);

  if (jpeg) {
    const filename = safeAttachmentName(alert);
    const buf = Buffer.from(jpeg, 'base64');
    attachments.push({
      filename,
      content: buf,
      contentType: 'image/jpeg',
      cid: SNAP_CID,
    });
    attachments.push({
      filename,
      content: buf,
      contentType: 'image/jpeg',
    });
  }

  const mail = {
    from: `"Atomic Vision" <${fromAddr}>`,
    to: cfg.channels.email.recipients.join(', '),
    subject,
    text,
    html,
    attachments: attachments.length ? attachments : undefined,
  };

  await transport.sendMail(mail);

  return {
    ok: true,
    channel: 'email',
    recipients: cfg.channels.email.recipients.length,
    hasPhoto: Boolean(jpeg),
  };
}

async function dispatchAlert(alert) {
  if (!alert) return { ok: false, error: 'No alert' };
  const results = { email: null, whatsapp: null, telegram: null };

  try {
    results.email = await sendEmailAlert(alert);
  } catch (err) {
    console.warn('[alert-notify] email failed:', err.message);
    results.email = { ok: false, error: err.message };
  }

  results.whatsapp = { ok: false, skipped: true, reason: 'unavailable' };
  results.telegram = { ok: false, skipped: true, reason: 'unavailable' };

  return { ok: Boolean(results.email?.ok), results };
}

async function sendTestEmail(toEmail) {
  const email = String(toEmail || '').trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, error: 'Enter a valid receiver email address' };
  }
  const smtp = loadSmtpConfig();
  const transport = await getTransporter();
  if (!smtp || !transport) {
    return { ok: false, error: 'Add Sender email and App password first, then Save' };
  }

  const sampleAlert = {
    type: 'unknown-face-detected',
    title: 'Unknown Face Detected',
    message: 'Test alert — Atomic Vision email template preview.',
    severity: 'warning',
    cameraName: 'Office',
    location: 'Work Station',
    confidence: 0.49,
    personName: null,
    createdAt: new Date().toISOString(),
  };
  const { subject, text, html } = buildEmailContent(sampleAlert, { hasPhoto: false });
  const attachments = [];
  const logo = loadLogoAttachment();
  if (logo) attachments.push(logo);

  const fromAddr = smtp.from || smtp.user;
  await transport.sendMail({
    from: `"Atomic Vision" <${fromAddr}>`,
    to: email,
    subject: subject.replace('[Atomic Vision]', '[Atomic Vision TEST]'),
    text,
    html,
    attachments: attachments.length ? attachments : undefined,
  });

  return { ok: true, to: email };
}

module.exports = {
  getSmtpStatus,
  dispatchAlert,
  sendTestEmail,
  sendEmailAlert,
  resetTransporterCache,
  buildEmailContent,
};
