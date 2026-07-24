require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const os = require('os');
const { WebSocketServer, WebSocket } = require('ws');

const { getMeshcentralUrl, offlineLoginEnabled, singleUserPerDevice } = require('./lib/device-config');
const { proxyJson, checkHealth, isNetworkError } = require('./lib/meshcentral-client');
const meshcentralStatus = require('./lib/meshcentral-status');
const { login: authLogin, completeSignupBind } = require('./lib/auth-service');
const { canAutoInstall } = require('./lib/mesh-agent-install');
const { runAtomicRegistration } = require('./lib/registration-pipeline');
const { saveDeviceProfileToCloud } = require('./lib/meshcentral-register');
const deviceBinding = require('./lib/device-binding');
const deviceProfile = require('./lib/device-profile');
const session = require('./lib/session');
const masterControl = require('./lib/master-control');
const dashboardRbac = require('./lib/dashboard-rbac');
const overviewData = require('./lib/overview-data');
const appLayout = require('./lib/app-layout');
const cameraStore = require('./lib/camera-store');
const detectionConfig = require('./lib/detection-config');
const detectionStore = require('./lib/detection-store');
const { buildSnapshotSvg } = require('./lib/detection-snapshot');
const { validateCameraConfig } = require('./lib/camera-validation');
const { getLiveViewPayload } = require('./lib/camera-analytics');
const rtspPreview = require('./lib/rtsp-preview');
const camLog = require('./lib/camera-stream-log');
const { fetchSystemStats, getLocalSystemStats, getCachedBoardStats } = require('./lib/local-system-stats');
const { ensureBoardCamera, syncAllCamerasToBoard } = require('./lib/board-camera-sync');
const personLive = require('./lib/person-live');
const faceLive = require('./lib/face-live');
const faceStore = require('./lib/face-store');
const faceBoardSync = require('./lib/face-board-sync');
const faceClusterStore = require('./lib/face-cluster-store');
const eventBroadcast = require('./lib/event-broadcast');

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';

const meshcentralUrl = getMeshcentralUrl();
if (!meshcentralUrl) {
  console.error('meshcentralUrl is required in app-config.json (or set MESHCENTRAL_URL).');
  console.error('Example: "meshcentralUrl": "https://3.108.40.151:4434"');
  process.exit(1);
}

function getLocalIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return 'localhost';
}

const pendingSignups = new Map();

function normalizeUsername(username) {
  return String(username || '').trim().toLowerCase();
}

function platformBlockReason(state, { kind }) {
  if (!state?.platformEnabled) return `${kind} is currently disabled because the platform is turned off.`;
  if (state?.emergencyLockdown) return `${kind} is blocked due to emergency lockdown mode.`;
  if (kind === 'Registration' && state?.registrationDisabled) return 'Registration is currently disabled by platform administrators.';
  if (kind === 'Login' && state?.loginDisabled) return 'Login is currently disabled by platform administrators.';
  if (state?.apiDisabled) return 'APIs are currently disabled by platform administrators.';
  return `${kind} is currently unavailable due to platform policy.`;
}

function postLoginRedirect(sessRecord) {
  if (!sessRecord) return '/login';
  if (!deviceProfile.isUserOnboarded(sessRecord.meshUserId)) return '/device-registration';
  if (!session.isClusterRoleConfirmed(sessRecord.sessionId)) return '/cluster-role';
  ensureStandaloneSessionRole(sessRecord);
  const clusterMode = deviceProfile.getClusterMode();
  if (clusterMode === 'standalone') return '/overview';
  if (!session.isUserRoleConfirmed(sessRecord.sessionId)) return '/user-role';
  return '/overview';
}

function ensureStandaloneSessionRole(sessRecord) {
  if (!sessRecord) return;
  if (deviceProfile.getClusterMode() !== 'standalone') return;
  if (session.isUserRoleConfirmed(sessRecord.sessionId)) return;
  const roleId = dashboardRbac.getDefaultRoleIdForClusterMode('standalone');
  const role = dashboardRbac.setUserRole(sessRecord.meshUserId, roleId);
  session.confirmUserRole(sessRecord.sessionId, role.id);
}

function sendProxy(res, { status, data }) {
  return res.status(status).json(data);
}

function validateOnboardingEmail(sessRecord, formEmail) {
  const accountEmail = sessRecord.email;
  const normalizedForm = formEmail ? String(formEmail).trim() : null;

  if (accountEmail && normalizedForm) {
    if (!deviceProfile.emailsMatch(accountEmail, normalizedForm)) {
      return {
        ok: false,
        error: `Registration email must match your account email (${accountEmail}).`,
      };
    }
  } else if (accountEmail && !normalizedForm) {
    return {
      ok: false,
      error: `Enter your account email (${accountEmail}) to complete one-time device registration.`,
    };
  }

  return {
    ok: true,
    email: normalizedForm || accountEmail || null,
  };
}

function markOnboardingComplete(sessRecord, formEmail) {
  const validated = validateOnboardingEmail(sessRecord, formEmail);
  if (!validated.ok) return validated;
  deviceProfile.markUserOnboarded({
    meshUserId: sessRecord.meshUserId,
    email: validated.email,
  });
  return { ok: true };
}

function deviceStatusPayload() {
  const binding = deviceBinding.getBinding();
  return {
    deviceId: deviceBinding.getDeviceId(),
    deviceSerial: deviceBinding.getDeviceSerial(),
    bound: deviceBinding.isBound(),
    boundUser: binding
      ? { username: binding.username, userId: binding.meshUserId, email: binding.email }
      : null,
    deviceRegistered: deviceProfile.isRegistered(),
    singleUserPerDevice: singleUserPerDevice(),
    offlineLoginEnabled: offlineLoginEnabled(),
    activeSession: session.getActiveSession()
      ? { username: session.getActiveSession().username }
      : null,
  };
}

const SIGNUP_OFFLINE_ERROR =
  'Account creation requires an internet connection to Atomic Center. Please connect and try again.';

async function isAtomicCenterOnline() {
  if (!meshcentralStatus.isStale()) {
    return meshcentralStatus.getReachable();
  }
  try {
    return await meshcentralStatus.refresh();
  } catch {
    return false;
  }
}

async function requireOnlineForSignup(res) {
  if (await isAtomicCenterOnline()) return true;
  res.status(503).json({ error: SIGNUP_OFFLINE_ERROR });
  return false;
}

async function verifyMeshCentralOnStartup() {
  try {
    const online = await meshcentralStatus.refresh();
    if (online) {
      console.log('MeshCentral reachable at', meshcentralUrl);
      return true;
    }
    console.warn('[Startup] MeshCentral health check failed.');
    return false;
  } catch (e) {
    const detail = e.cause?.message || e.message;
    meshcentralStatus.markUnreachable();
    console.warn('[Startup] Atomic Center not reachable — app runs locally (offline login if bound).');
    console.warn('[Startup]', detail);
    if (offlineLoginEnabled() && deviceBinding.isBound()) {
      const b = deviceBinding.getBinding();
      console.warn(`[Startup] Offline login ready for "${b.username}" (${b.meshUserId})`);
    }
    return false;
  }
}

const dashboardDist = path.join(__dirname, 'dashboard', 'dist');

app.use(express.json({ limit: '25mb' }));
app.use(masterControl.attachMasterContext);
app.use(express.static(path.join(__dirname, 'public')));
app.use('/assets', express.static(path.join(dashboardDist, 'assets')));
app.use('/api/master', masterControl.routes);

function resolveSession(req) {
  const sessionId =
    req.body?.sessionId ||
    req.query?.sessionId ||
    req.headers['x-session-id'];
  if (sessionId) {
    const sess = session.getSessionRecord(sessionId);
    if (sess) return sess;
  }
  return session.getSessionRecord(session.getActiveSession()?.sessionId);
}

const PUBLIC_API_PATHS = [
  /^\/api\/login/,
  /^\/api\/signup/,
  /^\/api\/logout/,
  /^\/api\/device\//,
  /^\/api\/auth\//,
  /^\/api\/master\/public-state/,
  /^\/api\/health/,
  /^\/api\/meshcentral/,
];

function isPublicApi(pathname) {
  return PUBLIC_API_PATHS.some((re) => re.test(pathname));
}

function getSessionRoleId(sess) {
  if (!sess) return null;
  ensureStandaloneSessionRole(sess);
  return dashboardRbac.resolveSessionRoleId(sess);
}

/** Page guard: session + role + path permission. */
function requirePageAccess(req, res) {
  const record = requireDashboardSession(req, res);
  if (!record) return null;
  const roleId = getSessionRoleId(record);
  if (!roleId) {
    res.redirect('/user-role');
    return null;
  }
  if (!dashboardRbac.canAccessPath(roleId, req.path)) {
    res.redirect(dashboardRbac.getDefaultLandingPath(roleId));
    return null;
  }
  req.dashboardRoleId = roleId;
  return record;
}

/** API RBAC — deny forbidden actions for the active role. */
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  if (isPublicApi(req.path)) return next();

  const sess = resolveSession(req);
  if (!sess) return next(); // route handlers return 401

  if (!deviceProfile.isRegistered()) return next();
  if (!session.isClusterRoleConfirmed(sess.sessionId)) {
    if (/^\/api\/(session|cluster-role)/.test(req.path)) return next();
    return res.status(403).json({ error: 'Confirm cluster role first.', redirectTo: '/cluster-role' });
  }

  ensureStandaloneSessionRole(sess);
  const clusterMode = deviceProfile.getClusterMode();
  if (clusterMode !== 'standalone' && !session.isUserRoleConfirmed(sess.sessionId)) {
    if (/^\/api\/(session|user-role|cluster-role)/.test(req.path)) return next();
    return res.status(403).json({ error: 'Select a user role to continue.', redirectTo: '/user-role' });
  }

  const roleId = getSessionRoleId(sess);
  if (!roleId) {
    return res.status(403).json({ error: 'No role assigned.', redirectTo: '/user-role' });
  }

  if (!dashboardRbac.canAccessApi(roleId, req.method, req.path)) {
    return res.status(403).json({
      error: 'Your role does not allow this action.',
      role: roleId,
      path: req.path,
    });
  }

  req.dashboardRoleId = roleId;
  return next();
});

app.get('/', (_req, res) => {
  const sess = session.getActiveSession();
  if (!sess) return res.redirect('/login');
  const record = session.getSessionRecord(sess.sessionId);
  return res.redirect(postLoginRedirect(record));
});

app.get('/login', (_req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'login.html'));
});

app.get('/signup', (_req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'signup.html'));
});

app.get('/device-registration', (_req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'device-registration.html'));
});

app.get('/cluster-role', (_req, res) => {
  const sess = session.getActiveSession();
  if (!sess) return res.redirect('/login');
  if (!deviceProfile.isRegistered()) return res.redirect('/device-registration');
  res.sendFile(path.join(__dirname, 'views', 'cluster-role.html'));
});

app.get('/user-role', (_req, res) => {
  const sess = session.getActiveSession();
  if (!sess) return res.redirect('/login');
  if (!deviceProfile.isRegistered()) return res.redirect('/device-registration');
  const record = session.getSessionRecord(sess.sessionId);
  if (record && !session.isClusterRoleConfirmed(record.sessionId)) {
    return res.redirect('/cluster-role');
  }
  if (deviceProfile.getClusterMode() === 'standalone') {
    ensureStandaloneSessionRole(record);
    return res.redirect('/overview');
  }
  res.sendFile(path.join(__dirname, 'views', 'user-role.html'));
});

function requireDashboardSession(_req, res) {
  const sess = session.getActiveSession();
  if (!sess) {
    res.redirect('/login');
    return null;
  }
  const record = session.getSessionRecord(sess.sessionId);
  if (!deviceProfile.isRegistered()) {
    res.redirect('/device-registration');
    return null;
  }
  if (record && !session.isClusterRoleConfirmed(record.sessionId)) {
    res.redirect('/cluster-role');
    return null;
  }
  ensureStandaloneSessionRole(record);
  if (deviceProfile.getClusterMode() !== 'standalone' && record && !session.isUserRoleConfirmed(record.sessionId)) {
    res.redirect('/user-role');
    return null;
  }
  return record || sess;
}

app.get('/overview', (req, res) => {
  if (!requirePageAccess(req, res)) return;
  res.type('html').send(appLayout.renderPage('overview.html'));
});

app.get('/alert-configuration', (req, res) => {
  if (!requirePageAccess(req, res)) return;
  res.type('html').send(appLayout.renderPage('alert-configuration.html'));
});

app.get('/settings', (req, res) => {
  if (!requirePageAccess(req, res)) return;
  res.type('html').send(appLayout.renderPage('settings.html'));
});

app.get('/api/alert-configuration', (req, res) => {
  const sess = resolveSession(req);
  if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
  const alertNotifyStore = require('./lib/alert-notify-store');
  const alertNotify = require('./lib/alert-notify');
  return res.json({
    ...alertNotifyStore.getConfig(),
    smtp: alertNotify.getSmtpStatus(),
  });
});

app.put('/api/alert-configuration', (req, res) => {
  const sess = resolveSession(req);
  if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
  const alertNotifyStore = require('./lib/alert-notify-store');
  const alertNotify = require('./lib/alert-notify');
  const config = alertNotifyStore.updateConfig(req.body || {});
  return res.json({
    ...config,
    smtp: alertNotify.getSmtpStatus(),
  });
});

app.post('/api/alert-configuration/test-email', async (req, res) => {
  const sess = resolveSession(req);
  if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
  try {
    const alertNotify = require('./lib/alert-notify');
    const result = await alertNotify.sendTestEmail(req.body?.email || req.body?.to);
    if (!result.ok) return res.status(400).json(result);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || 'Failed to send test email' });
  }
});

app.get('/cameras/:id', (req, res) => {
  if (!requirePageAccess(req, res)) return;
  const camera = cameraStore.getCamera(req.params.id);
  if (!camera) {
    res.redirect('/overview');
    return;
  }
  res.type('html').send(appLayout.renderPage('camera-live.html'));
});

app.get('/detection/:slug', (req, res) => {
  if (!requirePageAccess(req, res)) return;
  const tab = detectionConfig.getTab(req.params.slug);
  if (!tab) {
    res.redirect('/overview');
    return;
  }
  const html = appLayout.renderDetectionPage(req.params.slug);
  if (!html) {
    res.redirect('/overview');
    return;
  }
  res.type('html').send(html);
});

app.get('/api/detection/events/:eventId/snapshot', (req, res) => {
  const sess = resolveSession(req);
  if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
  const snap = detectionStore.getEventSnapshot(req.params.eventId);
  if (snap?.jpeg) {
    const b64 = String(snap.jpeg).replace(/^data:image\/\w+;base64,/, '');
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.send(Buffer.from(b64, 'base64'));
  }
  const event = detectionStore.getSnapshotEvent(req.params.eventId);
  if (!event) return res.status(404).send('Not found');
  // Legacy embedded JPEG (should be rare after migration to data/event-snaps).
  if (event.snapshotJpeg && typeof event.snapshotJpeg === 'string' && event.snapshotJpeg.length > 64) {
    const b64 = String(event.snapshotJpeg).replace(/^data:image\/\w+;base64,/, '');
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.send(Buffer.from(b64, 'base64'));
  }
  // No photo → 404 (frontend shows fallback). Never return a black SVG as a "photo".
  return res.status(404).send('Not found');
});

app.get('/api/detection/:slug', (req, res) => {
  const sess = resolveSession(req);
  if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
  const payload = detectionStore.getPayload(req.params.slug);
  if (!payload) return res.status(404).json({ error: 'Detection model not found.' });
  return res.json(payload);
});

app.patch('/api/detection/:slug', (req, res) => {
  const sess = resolveSession(req);
  if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
  const payload = detectionStore.updateSettings(req.params.slug, req.body || {});
  if (!payload) return res.status(404).json({ error: 'Detection model not found.' });
  return res.json(payload);
});

app.post('/api/detection/:slug/inference', (req, res) => {
  const sess = resolveSession(req);
  if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
  const running = req.body?.action === 'start';
  const payload = detectionStore.setInference(req.params.slug, running);
  if (!payload) return res.status(404).json({ error: 'Detection model not found.' });
  return res.json(payload);
});

app.post('/api/detection/person/live/:cameraId/select', async (req, res) => {
  const sess = resolveSession(req);
  if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
  try {
    const result = await personLive.selectCamera(req.params.cameraId);
    if (!result.ok) return res.status(404).json({ error: result.error });
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Could not select camera' });
  }
});

app.post('/api/detection/person/live/:cameraId/prewarm', async (req, res) => {
  const sess = resolveSession(req);
  if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
  try {
    const result = await personLive.prewarmWorker(req.params.cameraId);
    if (!result.ok) return res.status(400).json({ error: result.error });
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Could not prewarm worker' });
  }
});

app.post('/api/detection/person/live/:cameraId/start', async (req, res) => {
  const sess = resolveSession(req);
  if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
  try {
    const camera = cameraStore.getCamera(req.params.cameraId);
    const result = await personLive.startLive(req.params.cameraId);
    camLog.logDetectionStart('person', req.params.cameraId, result, camera || {});
    if (!result.ok) return res.status(400).json({ error: result.error });
    return res.json(result);
  } catch (err) {
    camLog.logDetectionStart('person', req.params.cameraId, {
      ok: false,
      error: err.message || 'Could not start inference',
    }, cameraStore.getCamera(req.params.cameraId) || {});
    return res.status(500).json({ error: err.message || 'Could not start inference' });
  }
});

app.post('/api/detection/person/live/:cameraId/stop', async (req, res) => {
  const sess = resolveSession(req);
  if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
  try {
    const result = await personLive.stopLive(req.params.cameraId);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Could not stop inference' });
  }
});

app.post('/api/detection/person/start-all', async (req, res) => {
  const sess = resolveSession(req);
  if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
  try {
    const result = await personLive.startAllLive();
    if (!result.ok) return res.status(400).json({ error: result.error });
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Could not start all cameras' });
  }
});

app.get('/api/detection/person/live/:cameraId/frame', async (req, res) => {
  const sess = resolveSession(req);
  if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
  try {
    const result = await personLive.getLiveFrame(req.params.cameraId);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Could not load frame' });
  }
});

app.post('/api/detection/person/live/:cameraId/resync', async (req, res) => {
  const sess = resolveSession(req);
  if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
  try {
    const result = await personLive.resyncStream(req.params.cameraId);
    if (!result.ok) return res.status(400).json({ error: result.error });
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Could not resync stream' });
  }
});

app.patch('/api/detection/person/live/:cameraId/config', async (req, res) => {
  const sess = resolveSession(req);
  if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
  try {
    const result = await personLive.updateLiveConfig(req.params.cameraId, req.body || {});
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Could not update settings' });
  }
});

// ── Face Recognition live ─────────────────────────────────────
app.post('/api/detection/face/live/:cameraId/select', async (req, res) => {
  const sess = resolveSession(req);
  if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
  try {
    const result = await faceLive.selectCamera(req.params.cameraId);
    if (!result.ok) return res.status(404).json({ error: result.error });
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Could not select camera' });
  }
});

app.post('/api/detection/face/live/:cameraId/start', async (req, res) => {
  const sess = resolveSession(req);
  if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
  try {
    const camera = cameraStore.getCamera(req.params.cameraId);
    const result = await faceLive.startLive(req.params.cameraId);
    camLog.logDetectionStart('face', req.params.cameraId, result, camera || {});
    if (!result.ok) return res.status(400).json({ error: result.error });
    return res.json(result);
  } catch (err) {
    camLog.logDetectionStart('face', req.params.cameraId, {
      ok: false,
      error: err.message || 'Could not start face recognition',
    }, cameraStore.getCamera(req.params.cameraId) || {});
    return res.status(500).json({ error: err.message || 'Could not start face recognition' });
  }
});

app.post('/api/detection/face/live/:cameraId/stop', async (req, res) => {
  const sess = resolveSession(req);
  if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
  try {
    const result = await faceLive.stopLive(req.params.cameraId);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Could not stop face recognition' });
  }
});

app.post('/api/detection/face/start-all', async (req, res) => {
  const sess = resolveSession(req);
  if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
  try {
    const result = await faceLive.startAllLive();
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Could not start all cameras' });
  }
});

app.get('/api/detection/face/live/:cameraId/frame', async (req, res) => {
  const sess = resolveSession(req);
  if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
  try {
    const result = await faceLive.getLiveFrame(req.params.cameraId);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Could not load frame' });
  }
});

app.patch('/api/detection/face/live/:cameraId/config', async (req, res) => {
  const sess = resolveSession(req);
  if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
  try {
    const result = await faceLive.updateLiveConfig(req.params.cameraId, req.body || {});
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Could not update settings' });
  }
});

// Tripwire line — proxies to board /api/face/stream/line-config/:cameraId
app.get('/api/face/stream/line-config/:cameraId', async (req, res) => {
  const sess = resolveSession(req);
  if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
  try {
    const result = await faceLive.getLineConfig(req.params.cameraId);
    if (!result.ok) return res.status(result.error?.includes('offline') ? 503 : 400).json(result);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Could not load line config' });
  }
});

app.put('/api/face/stream/line-config/:cameraId', async (req, res) => {
  const sess = resolveSession(req);
  if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
  try {
    const result = await faceLive.setLineConfig(req.params.cameraId, req.body || {});
    if (!result.ok) return res.status(result.error?.includes('offline') ? 503 : 400).json(result);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Could not save line config' });
  }
});

app.delete('/api/face/stream/line-config/:cameraId', async (req, res) => {
  const sess = resolveSession(req);
  if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
  try {
    const result = await faceLive.clearLineConfig(req.params.cameraId);
    if (!result.ok) return res.status(result.error?.includes('offline') ? 503 : 400).json(result);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Could not clear line config' });
  }
});

// ── Face database & enrollment ──────────────────────────────────

async function refreshFaceLiveAfterEnroll() {
  const state = detectionStore.getModelState('face');
  if (state.inferenceRunning && state.activeCameraId) {
    await faceLive.updateLiveConfig(state.activeCameraId, {});
  }
}

app.get('/api/face/dashboard', (req, res) => {
  const sess = resolveSession(req);
  if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
  const payload = detectionStore.getPayload('face');
  return res.json({
    statistics: faceStore.getStatistics(),
    groups: faceStore.listGroups(),
    recentAlerts: faceStore.listAlerts().slice(0, 20),
    recentEvents: payload?.events?.slice(0, 20) || [],
    assignedCameras: payload?.assignedCameras || [],
    faceMetrics: payload?.faceMetrics || null,
    report: payload?.report || null,
  });
});

app.get('/api/face/board-status', async (req, res) => {
  const sess = resolveSession(req);
  if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
  const { isReachable, BASE } = require('./lib/vision-api');
  let boardReachable = false;
  let workerRunning = false;
  let enrolledOnBoard = 0;
  try {
    boardReachable = await isReachable();
    if (boardReachable) {
      const { apiJson } = require('./lib/vision-api');
      const status = await apiJson('/api/face/worker/status');
      workerRunning = Boolean(status?.running);
      const list = await apiJson('/api/face/persons');
      enrolledOnBoard = Array.isArray(list)
        ? list.filter((p) => (p.embedding_count || 0) > 0).length
        : 0;
    }
  } catch {
    /* offline */
  }
  return res.json({
    boardReachable,
    workerRunning,
    enrolledOnBoard,
    ready: boardReachable && workerRunning,
    boardUrl: BASE,
  });
});

/** Board enrolled persons — for cluster / unknown naming (fetch only). */
app.get('/api/face/board/persons', async (req, res) => {
  const sess = resolveSession(req);
  if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
  try {
    const { apiJson } = require('./lib/vision-api');
    const persons = await apiJson('/api/face/persons');
    return res.json({ persons: Array.isArray(persons) ? persons : [] });
  } catch (err) {
    return res.status(err.status === 401 ? 401 : 503).json({ error: err.message || 'Board offline' });
  }
});

app.put('/api/face/board/persons/:personId', async (req, res) => {
  const sess = resolveSession(req);
  if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
  try {
    const { apiJson } = require('./lib/vision-api');
    const data = await apiJson(`/api/face/persons/${encodeURIComponent(req.params.personId)}`, {
      method: 'PUT',
      body: { name: req.body?.name, note: req.body?.note },
    });
    return res.json(data);
  } catch (err) {
    return res.status(err.status || 503).json({ error: err.message || 'Update failed' });
  }
});

/** Local cluster crop JPEGs (and board fallback). */
app.get('/api/face/crops/:filename', async (req, res) => {
  const sess = resolveSession(req);
  if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
  const filename = String(req.params.filename || '').replace(/[^a-zA-Z0-9._-]/g, '');
  if (!filename) return res.status(400).json({ error: 'Invalid filename' });

  // Local cluster snap: /api/face/crops/:cropId?clusterId=clu_xxx
  const clusterId = String(req.query.clusterId || '').replace(/[^a-zA-Z0-9._-]/g, '');
  if (clusterId) {
    const buf = faceClusterStore.getCropBuffer(clusterId, filename);
    if (buf) {
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=600');
      return res.send(buf);
    }
  }

  // Scan local snaps by crop id suffix (UI often only has crop filename).
  try {
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(__dirname, 'data', 'face-cluster-snaps');
    if (fs.existsSync(dir)) {
      const hit = fs.readdirSync(dir).find((n) => n.endsWith(`__${filename}.jpg`) || n === `${filename}.jpg`);
      if (hit) {
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=600');
        return res.send(fs.readFileSync(path.join(dir, hit)));
      }
    }
  } catch {
    /* fall through to board */
  }

  try {
    const { apiFetch } = require('./lib/vision-api');
    const upstream = await apiFetch(`/crops/${encodeURIComponent(filename)}`);
    if (!upstream.ok) return res.status(upstream.status).send('Crop not found');
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=600');
    return res.send(buf);
  } catch (err) {
    return res.status(404).send('Crop not found');
  }
});

/** Dashboard-local unknown-face clusters (same person → one bunch). */
app.get('/api/face/clusters', (req, res) => {
  const sess = resolveSession(req);
  if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
  return res.json({
    clusters: faceClusterStore.listClusters(),
    threshold: faceClusterStore.getThreshold().threshold,
    source: 'dashboard',
  });
});

app.get('/api/face/clusters/config/threshold', (req, res) => {
  const sess = resolveSession(req);
  if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
  return res.json(faceClusterStore.getThreshold());
});

app.put('/api/face/clusters/config/threshold', (req, res) => {
  const sess = resolveSession(req);
  if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
  try {
    return res.json(faceClusterStore.setThreshold(req.body?.threshold));
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

app.get('/api/face/clusters/:id', (req, res) => {
  const sess = resolveSession(req);
  if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
  const c = faceClusterStore.getCluster(req.params.id);
  if (!c) return res.status(404).json({ error: 'Cluster not found' });
  return res.json(c);
});

app.delete('/api/face/clusters/:id', (req, res) => {
  const sess = resolveSession(req);
  if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
  try {
    return res.json(faceClusterStore.deleteCluster(req.params.id));
  } catch (err) {
    return res.status(404).json({ error: err.message });
  }
});

app.post('/api/face/clusters/:id/label', async (req, res) => {
  const sess = resolveSession(req);
  if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name is required' });

  let taken;
  try {
    taken = faceClusterStore.takeClusterForLabel(req.params.id);
  } catch (err) {
    return res.status(404).json({ error: err.message });
  }

  const created = faceStore.createPerson({
    fullName: name,
    groupId: req.body?.groupId || 'visitors',
    notes: req.body?.note || 'Named from unknown-face cluster',
    authorizationStatus: 'authorized',
  });
  if (!created.ok) return res.status(400).json({ error: created.error });

  let localPerson = created.person;
  const bestCrop = taken.crops[0]?.jpegBase64 || null;
  if (bestCrop) {
    faceStore.updatePerson(localPerson.id, {
      profileImage: `data:image/jpeg;base64,${bestCrop}`,
    });
    localPerson = faceStore.getPerson(localPerson.id);
  }

  // Enroll up to 3 crops on the board so recognition is robust.
  let boardPersonId = null;
  let embeddingCount = 0;
  let boardError = null;
  for (const crop of taken.crops.slice(0, 3)) {
    const board = await faceBoardSync.syncPersonEnrollToBoard(
      { ...localPerson, backendPersonId: boardPersonId },
      `data:image/jpeg;base64,${crop.jpegBase64}`,
    );
    if (board.ok) {
      boardPersonId = board.backendPersonId || boardPersonId;
      embeddingCount = Math.max(embeddingCount, board.embeddingCount || 1);
    } else {
      boardError = board.error || boardError;
    }
  }

  if (boardPersonId || embeddingCount) {
    faceStore.updatePerson(localPerson.id, {
      backendPersonId: boardPersonId,
      embeddingCount: embeddingCount || 1,
      enrolledAt: new Date().toISOString(),
    });
    localPerson = faceStore.getPerson(localPerson.id);
  }

  faceClusterStore.finalizeLabeled(req.params.id);
  await refreshFaceLiveAfterEnroll();

  return res.json({
    ok: true,
    cluster_id: req.params.id,
    person: {
      person_id: boardPersonId,
      name,
      embedding_count: embeddingCount || localPerson.embeddingCount || 1,
    },
    localPerson,
    message: boardPersonId
      ? `"${name}" enrolled — live recognition will identify this face`
      : `"${name}" saved locally${boardError ? ` (board: ${boardError})` : ''}`,
    boardError,
  });
});

app.get('/api/face/groups', (req, res) => {
  const sess = resolveSession(req);
  if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
  return res.json({ groups: faceStore.listGroups() });
});

app.post('/api/face/groups', (req, res) => {
  const sess = resolveSession(req);
  if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
  const result = faceStore.createGroup(req.body || {});
  if (!result.ok) return res.status(400).json({ error: result.error });
  return res.status(201).json(result);
});

app.patch('/api/face/groups/:groupId', (req, res) => {
  const sess = resolveSession(req);
  if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
  const result = faceStore.updateGroup(req.params.groupId, req.body || {});
  if (!result.ok) return res.status(400).json({ error: result.error });
  return res.json(result);
});

app.delete('/api/face/groups/:groupId', (req, res) => {
  const sess = resolveSession(req);
  if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
  const result = faceStore.deleteGroup(req.params.groupId);
  if (!result.ok) return res.status(400).json({ error: result.error });
  return res.json(result);
});

app.get('/api/face/persons', (req, res) => {
  const sess = resolveSession(req);
  if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
  const persons = faceStore.listPersons({
    q: req.query.q,
    groupId: req.query.groupId,
    authorizationStatus: req.query.authorizationStatus,
    sortBy: req.query.sortBy,
    sortDir: req.query.sortDir,
  });
  return res.json({ persons, statistics: faceStore.getStatistics() });
});

app.get('/api/face/persons/:personId', (req, res) => {
  const sess = resolveSession(req);
  if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
  const person = faceStore.getPerson(req.params.personId);
  if (!person) return res.status(404).json({ error: 'Person not found' });
  return res.json({ person });
});

app.get('/api/face/persons/:personId/image', (req, res) => {
  const sess = resolveSession(req);
  if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
  const filePath = faceStore.getProfileImagePath(req.params.personId);
  if (!filePath) return res.status(404).send('Not found');
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  return res.sendFile(filePath);
});

app.post('/api/face/persons', async (req, res) => {
  const sess = resolveSession(req);
  if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
  const result = faceStore.createPerson(req.body || {});
  if (!result.ok) return res.status(400).json({ error: result.error });

  if (req.body?.enrollImage) {
    faceStore.updatePerson(result.person.id, {
      profileImage: req.body.enrollImage,
    });
    result.person = faceStore.getPerson(result.person.id);

    const board = await faceBoardSync.syncPersonEnrollToBoard(result.person, req.body.enrollImage);
    if (board.ok) {
      faceStore.updatePerson(result.person.id, {
        backendPersonId: board.backendPersonId,
        embeddingCount: board.embeddingCount || 1,
        enrolledAt: new Date().toISOString(),
      });
      result.person = faceStore.getPerson(result.person.id);
      await refreshFaceLiveAfterEnroll();
      return res.status(201).json({
        ok: true,
        enrolled: true,
        person: result.person,
        embeddingCount: board.embeddingCount || 1,
        backendPersonId: board.backendPersonId,
        message: `${result.person.fullName} enrolled on board — ready for live recognition`,
      });
    }

    faceStore.updatePerson(result.person.id, { embeddingCount: 1 });
    result.person = faceStore.getPerson(result.person.id);
    return res.status(201).json({
      ok: true,
      enrolled: false,
      person: result.person,
      embeddingCount: 1,
      error: board.error,
      message: board.error || 'Saved locally — board sync failed, use Re-sync when board is online',
    });
  }

  return res.status(201).json({ ok: true, enrolled: false, person: result.person, message: 'Person created (no photo)' });
});

app.patch('/api/face/persons/:personId', (req, res) => {
  const sess = resolveSession(req);
  if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
  const result = faceStore.updatePerson(req.params.personId, req.body || {});
  if (!result.ok) return res.status(400).json({ error: result.error });
  return res.json(result);
});

app.delete('/api/face/persons/:personId', (req, res) => {
  const sess = resolveSession(req);
  if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
  const person = faceStore.getPerson(req.params.personId);
  if (!person) return res.status(404).json({ error: 'Person not found' });
  const result = faceStore.deletePerson(req.params.personId);
  return res.json(result);
});

app.post('/api/face/persons/bulk-delete', (req, res) => {
  const sess = resolveSession(req);
  if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  return res.json(faceStore.bulkDeletePersons(ids));
});

app.get('/api/face/persons/:personId/verify', async (req, res) => {
  const sess = resolveSession(req);
  if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
  const person = faceStore.getPerson(req.params.personId);
  if (!person) return res.status(404).json({ error: 'Person not found' });
  return res.json(await faceBoardSync.verifyPersonOnBoard(person));
});

app.post('/api/face/persons/:personId/resync', async (req, res) => {
  const sess = resolveSession(req);
  if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
  const person = faceStore.getPerson(req.params.personId);
  if (!person) return res.status(404).json({ error: 'Person not found' });

  const result = await faceBoardSync.resyncPersonToBoard(person, faceStore);
  if (!result.ok) return res.status(result.boardReachable === false ? 503 : 400).json({ error: result.error });

  await refreshFaceLiveAfterEnroll();
  return res.json(result);
});

app.post('/api/face/persons/:personId/enroll', async (req, res) => {
  const sess = resolveSession(req);
  if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
  const person = faceStore.getPerson(req.params.personId);
  if (!person) return res.status(404).json({ error: 'Person not found' });
  if (!req.body?.image) return res.status(400).json({ error: 'image (base64) is required' });

  faceStore.updatePerson(person.id, { profileImage: req.body.image });
  const refreshed = faceStore.getPerson(person.id);

  const board = await faceBoardSync.syncPersonEnrollToBoard(refreshed, req.body.image);
  if (board.ok) {
    faceStore.updatePerson(person.id, {
      backendPersonId: board.backendPersonId,
      embeddingCount: board.embeddingCount || (person.embeddingCount || 0) + 1,
      enrolledAt: person.enrolledAt || new Date().toISOString(),
    });
    await refreshFaceLiveAfterEnroll();
    return res.json({
      ok: true,
      enrolled: true,
      person: faceStore.getPerson(person.id),
      embeddingCount: board.embeddingCount,
      message: board.message,
    });
  }

  const count = (person.embeddingCount || 0) + 1;
  faceStore.updatePerson(person.id, { embeddingCount: count });
  return res.status(board.boardReachable === false ? 503 : 422).json({
    ok: false,
    error: board.error || 'Could not enroll on board',
    person: faceStore.getPerson(person.id),
    embeddingCount: count,
  });
});

app.post('/api/face/persons/bulk-enroll', async (req, res) => {
  const sess = resolveSession(req);
  if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  const results = [];
  for (const item of items) {
    if (!item.fullName || !item.image) {
      results.push({ fullName: item.fullName, ok: false, error: 'fullName and image required' });
      continue;
    }
    const created = faceStore.createPerson({
      fullName: item.fullName,
      personId: item.personId,
      groupId: item.groupId,
      role: item.role,
      department: item.department,
      authorizationStatus: item.authorizationStatus || 'pending',
      profileImage: item.image,
    });
    if (!created.ok) {
      results.push({ fullName: item.fullName, ok: false, error: created.error });
      continue;
    }
    const board = await faceBoardSync.syncPersonEnrollToBoard(created.person, item.image);
    if (board.ok) {
      faceStore.updatePerson(created.person.id, {
        backendPersonId: board.backendPersonId,
        embeddingCount: board.embeddingCount || 1,
      });
      results.push({ fullName: item.fullName, ok: true, personId: created.person.id, backendPersonId: board.backendPersonId });
    } else {
      faceStore.updatePerson(created.person.id, { embeddingCount: 1 });
      results.push({ fullName: item.fullName, ok: false, personId: created.person.id, error: board.error });
    }
  }
  if (results.some((r) => r.ok)) await refreshFaceLiveAfterEnroll();
  return res.json({ results, imported: results.filter((r) => r.ok).length });
});

app.post('/api/face/import', (req, res) => {
  const sess = resolveSession(req);
  if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
  return res.json(faceStore.importDatabase(req.body || {}));
});

app.post('/api/face/analyze', (req, res) => {
  const sess = resolveSession(req);
  if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
  if (!req.body?.image) return res.status(400).json({ error: 'image (base64) is required' });
  return res.status(503).json({ error: 'Vision API not connected' });
});

// ── Face alerts ─────────────────────────────────────────────────
app.get('/api/face/alerts', (req, res) => {
  const sess = resolveSession(req);
  if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
  return res.json({
    alerts: faceStore.listAlerts({
      status: req.query.status,
      type: req.query.type,
      q: req.query.q,
    }),
  });
});

app.get('/api/face/alerts/:alertId', (req, res) => {
  const sess = resolveSession(req);
  if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
  const alert = faceStore.getAlert(req.params.alertId);
  if (!alert) return res.status(404).json({ error: 'Alert not found' });
  return res.json({ alert });
});

app.post('/api/face/alerts/:alertId/acknowledge', (req, res) => {
  const sess = resolveSession(req);
  if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
  const user = sess.username || sess.userId || 'operator';
  const result = faceStore.acknowledgeAlert(req.params.alertId, user);
  if (!result.ok) return res.status(404).json({ error: result.error });
  eventBroadcast.broadcastFaceUpdate(detectionStore.getPayload('face'), [], {
    alertAcknowledged: result.alert,
  });
  return res.json(result);
});

app.post('/api/face/alerts/bulk-acknowledge', (req, res) => {
  const sess = resolveSession(req);
  if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
  const user = sess.username || sess.userId || 'operator';
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  return res.json(faceStore.bulkAcknowledgeAlerts(ids, user));
});

app.post('/api/detection/:slug/cameras', (req, res) => {
  const sess = resolveSession(req);
  if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
  const result = detectionStore.assignCamera(req.params.slug, req.body?.cameraId);
  if (!result.ok) return res.status(400).json({ error: result.error });
  return res.json(result.payload);
});

app.delete('/api/detection/:slug/cameras/:cameraId', (req, res) => {
  const sess = resolveSession(req);
  if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
  const result = detectionStore.unassignCamera(req.params.slug, req.params.cameraId);
  if (!result.ok) return res.status(400).json({ error: result.error });
  return res.json(result.payload);
});

app.get('/api/detection/:slug/export', (req, res) => {
  const sess = resolveSession(req);
  if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
  const format = req.query.format === 'csv' ? 'csv' : 'json';
  const exported = detectionStore.exportData(req.params.slug, format);
  if (!exported) return res.status(404).json({ error: 'Detection model not found.' });
  res.setHeader('Content-Type', exported.contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${exported.filename}"`);
  return res.send(exported.body);
});

app.get('/api/overview', async (req, res) => {
  const sess = resolveSession(req);
  if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
  try {
    const payload = await overviewData.getOverviewPayload(sess);
    return res.json(payload);
  } catch (err) {
    console.warn('[overview]', err.message);
    return res.status(500).json({ error: err.message || 'Overview failed' });
  }
});

app.get('/api/system/stats', async (req, res) => {
  const sess = resolveSession(req);
  if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
  try {
    const stats = await fetchSystemStats();
    if (stats) return res.json({ ...stats, _fromBoard: true });
    return res.json(getLocalSystemStats());
  } catch (err) {
    console.warn('[system/stats]', err.message);
    return res.json(getCachedBoardStats() || getLocalSystemStats());
  }
});

app.get('/api/cameras', (req, res) => {
  const sess = resolveSession(req);
  if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
  const cameras = cameraStore.listCameras();
  return res.json({ cameras, stats: cameraStore.cameraStats() });
});

/**
 * Local MJPEG preview — ffmpeg pulls RTSP with TCP transport
 * (same as: ffplay -rtsp_transport tcp "<url>").
 */
app.get('/api/cameras/:id/preview.mjpeg', (req, res) => {
  const sess = resolveSession(req);
  if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
  const camera = cameraStore.getCamera(req.params.id);
  if (!camera) return res.status(404).json({ error: 'Camera not found.' });
  const rtspUrl = String(camera.rtspUrl || '').trim();
  if (!/^rtsp:\/\//i.test(rtspUrl)) {
    return res.status(400).json({ error: 'Camera has no RTSP URL.' });
  }
  try {
    rtspPreview.attachClient(camera.id, rtspUrl, res);
  } catch (err) {
    console.warn('[rtsp-preview] attach failed:', err.message || err);
    if (!res.headersSent) res.status(502).json({ error: 'Could not start RTSP preview.' });
  }
});

app.get('/api/cameras/:id/live', async (req, res) => {
  const sess = resolveSession(req);
  if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
  let camera = cameraStore.getCamera(req.params.id);
  if (!camera) {
    camLog.logClientEvent({
      source: 'server',
      step: 'live',
      level: 'error',
      cameraId: req.params.id,
      message: 'Start stream requested but camera was not found',
      why: `No camera with id ${req.params.id} in cameras.json`,
    });
    return res.status(404).json({ error: 'Camera not found.' });
  }

  let syncError = null;
  // After dashboard/board restart: re-register this camera on the board so WHEP/HLS works.
  if (req.query.sync === '1' && camera.rtspUrl) {
    try {
      camera = await ensureBoardCamera(camera) || camera;
    } catch (err) {
      syncError = err.message || String(err);
      console.warn('[cameras] live sync failed:', syncError);
    }
  }

  const payload = getLiveViewPayload(camera);
  camLog.logLiveSync(payload.camera || camera, payload.preview || {}, {
    sync: req.query.sync === '1',
    syncError,
  });

  // For face-local debugging, allow returning the local Face backend stream URLs.
  if (req.query.slug === 'face' && process.env.VISION_FACE_API_URL) {
    // Ensure this camera is registered on the local face backend so MediaMTX
    // creates a WHEP/HLS path.
    if ((!camera.faceWhepUrl && !camera.faceHlsUrl) && camera.rtspUrl) {
      try {
        const { createVisionClient } = require('./lib/vision-api');
        const faceClient = createVisionClient(process.env.VISION_FACE_API_URL, { label: 'face' });
        const created = await faceClient.apiJson('/api/cameras', {
          method: 'POST',
          body: { name: camera.name || 'camera', type: 'rtsp', url: camera.rtspUrl },
        });
        const id = created?.id || null;
        if (id) {
          const host = new URL(faceClient.BASE).hostname || 'localhost';
          camera = cameraStore.updateCamera(camera.id, {
            faceBackendId: id,
            faceWhepUrl: created?.whep_url || `http://${host}:8889/${id}/whep`,
            faceHlsUrl: `http://${host}:8888/${id}/index.m3u8`,
            faceLocalRtsp: created?.local_rtsp || `rtsp://${host}:${process.env.MEDIAMTX_RTSP_PORT || 8554}/${id}`,
          }) || camera;
        }
      } catch (err) {
        console.warn('[cameras] local face register failed:', err.message || err);
      }
    }

    // IMPORTANT: the browser may be on another device (phone/tablet). In that
    // case `localhost` would point to the viewer device, not this PC.
    // Rewrite local MediaMTX URLs to the dashboard host so WHEP/HLS resolves.
    const requestHost = String(req.headers.host || '').split(':')[0] || req.hostname || 'localhost';
    const rewriteHost = (url) => {
      if (!url) return null;
      return String(url)
        .replace(/localhost/gi, requestHost)
        .replace(/127\.0\.0\.1/g, requestHost);
    };

    const faceWhep = rewriteHost(camera.faceWhepUrl) || null;
    const faceHls = rewriteHost(camera.faceHlsUrl) || null;
    if (faceWhep || faceHls) {
      // Use SAME-ORIGIN proxy URLs (and include sessionId) to avoid
      // CORS/mixed-origin issues + pass auth for raw SDP/HLS requests.
      const sid = sess?.sessionId ? `?sessionId=${encodeURIComponent(sess.sessionId)}` : '';
      const proxyWhep = `/api/face/local/whep/${encodeURIComponent(camera.id)}${sid}`;
      const proxyHls = `/api/face/local/hls/${encodeURIComponent(camera.id)}/index.m3u8${sid}`;
      payload.camera.whepUrl = proxyWhep;
      payload.camera.hlsUrl = proxyHls;
      payload.preview = {
        mode: 'whep',
        url: proxyWhep,
        hlsUrl: proxyHls,
        whepUrl: proxyWhep,
        simulated: false,
        label: 'Live WebRTC stream',
      };
    }
  }

  return res.json(payload);
});

/**
 * Local Face streaming proxies (SAME ORIGIN)
 * - WHEP: POST SDP to local MediaMTX and relay answer
 * - HLS: proxy m3u8 and segments from local MediaMTX
 */
app.post(
  '/api/face/local/whep/:cameraId',
  express.text({ type: ['application/sdp', 'text/plain', '*/*'], limit: '256kb' }),
  async (req, res) => {
    const sess = resolveSession(req);
    if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
    const cam = cameraStore.getCamera(req.params.cameraId);
    if (!cam?.faceBackendId) return res.status(404).json({ error: 'Face camera not registered' });

    const whepBase = 'http://127.0.0.1:8889';
    const target = `${whepBase}/${encodeURIComponent(cam.faceBackendId)}/whep`;
    try {
      const upstream = await fetch(target, {
        method: 'POST',
        headers: { 'Content-Type': 'application/sdp' },
        body: req.body || '',
      });
      const body = await upstream.text();
      res.status(upstream.status);
      res.set('Content-Type', upstream.headers.get('content-type') || 'application/sdp');
      return res.send(body);
    } catch (err) {
      console.warn('[face-local-whep] failed:', err.message);
      return res.status(502).json({ error: 'WHEP proxy failed' });
    }
  },
);

app.use('/api/face/local/hls/:cameraId', async (req, res) => {
  if (req.method !== 'GET') return res.status(405).end();
  const sess = resolveSession(req);
  if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
  const cam = cameraStore.getCamera(req.params.cameraId);
  if (!cam?.faceBackendId) return res.status(404).end();

  const segment = String(req.url || '/index.m3u8').replace(/^\//, '') || 'index.m3u8';
  const hlsBase = 'http://127.0.0.1:8888';
  const target = `${hlsBase}/${encodeURIComponent(cam.faceBackendId)}/${segment}`;

  try {
    const upstream = await fetch(target, {
      headers: req.headers.range ? { Range: String(req.headers.range) } : {},
    });
    if (!upstream.ok) return res.status(upstream.status).end();

    const ct = upstream.headers.get('content-type') || 'application/octet-stream';
    res.set('Content-Type', ct);
    res.set('Cache-Control', 'no-cache');

    // Rewrite playlist segment URLs to our proxy.
    if (segment.endsWith('.m3u8')) {
      const proxyBase = `/api/face/local/hls/${encodeURIComponent(cam.id)}/`;
      const sid = req.query.sessionId;
      const q = sid ? `?sessionId=${encodeURIComponent(sid)}` : '';
      let text = await upstream.text();
      text = text
        .split('\n')
        .map((line) => {
          const t = line.trim();
          if (!t || t.startsWith('#')) return line;
          if (/^https?:\/\//i.test(t)) return t;
          const seg = t.startsWith('/') ? t.slice(1) : t;
          return `${proxyBase}${seg}${q}`;
        })
        .join('\n');
      return res.send(text);
    }

    const buf = Buffer.from(await upstream.arrayBuffer());
    return res.send(buf);
  } catch (err) {
    console.warn('[face-local-hls] failed:', err.message);
    return res.status(502).end();
  }
});

app.post('/api/cameras/stream-log', (req, res) => {
  const sess = resolveSession(req);
  if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
  camLog.logClientEvent(req.body || {});
  return res.status(204).end();
});

app.post('/api/cameras/validate', async (req, res) => {
  const sess = resolveSession(req);
  if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
  const body = req.body || {};
  camLog.logValidateStart(body);
  const result = validateCameraConfig(body);

  const url = String(body.rtspUrl || body.streamUrl || '').trim();
  let probe = null;
  if (result.success && /^rtsp:\/\//i.test(url)) {
    probe = await rtspPreview.probeRtspTcp(url);
    if (!probe.ok) {
      result.success = false;
      result.error = 'RTSP unreachable over TCP';
      result.checks = result.checks || {};
      result.checks.streamReachable = {
        ok: false,
        message: probe.error || 'ffprobe failed with -rtsp_transport tcp',
      };
      result.checks.frameReceived = {
        ok: false,
        message: 'No frame received — try the same URL with: ffplay -rtsp_transport tcp "<url>"',
      };
      result.detected = null;
      camLog.logValidateResult(body, result, { probe });
      return res.json(result);
    }

    const width = probe.width || null;
    const height = probe.height || null;
    if (width && height) {
      result.detected.resolution = `${width}x${height}`;
      result.checks.resolutionDetected = { ok: true, message: `${width}x${height}` };
    }
    if (probe.codec) {
      result.detected.codec = String(probe.codec).toUpperCase();
      result.checks.codecDetected = { ok: true, message: result.detected.codec };
    }
    result.checks.streamReachable = {
      ok: true,
      message: 'RTSP reachable over TCP (ffprobe -rtsp_transport tcp)',
    };
    result.checks.frameReceived = { ok: true, message: 'Video stream probed successfully' };
  }

  camLog.logValidateResult(body, result, { probe });
  return res.json(result);
});

app.post('/api/cameras', async (req, res) => {
  const sess = resolveSession(req);
  if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
  const body = req.body || {};
  const validation = validateCameraConfig(body);
  if (!validation.success) {
    camLog.logValidateResult(body, validation);
    return res.status(400).json({
      error: validation.error,
      checks: validation.checks,
    });
  }

  let camera = cameraStore.addCamera({
    name: String(body.name || '').trim(),
    type: body.type || 'rtsp',
    rtspUrl: body.rtspUrl || body.url || '',
    username: body.username || '',
    ipAddress: body.ipAddress || '',
    port: body.port || '',
    location: body.location || '',
    zoneFloor: body.zoneFloor || '',
    department: body.department || '',
    group: body.group || '',
    resolution: body.resolution || validation.detected?.resolution || '1920x1080',
    fpsLimit: Number(body.fpsLimit) || validation.detected?.fps || 25,
    aiModels: Array.isArray(body.aiModels) ? body.aiModels : [],
    modelConfidence: {},
    recording: Boolean(body.recording),
    alertRules: Array.isArray(body.alertRules) ? body.alertRules : [],
    validation: validation.detected,
  });

  let boardError = null;
  // Await board register so cameras.json already has backendId before UI starts stream.
  try {
    camera = await ensureBoardCamera(camera, {
      username: body.username || null,
      password: body.password || null,
    }) || camera;
  } catch (err) {
    boardError = err.message || String(err);
    console.warn('[cameras] board sync failed:', boardError);
  }

  const aiModels = Array.isArray(camera.aiModels) ? camera.aiModels : [];
  const detectionConfig = require('./lib/detection-config');
  const assigned = [];
  for (const slug of detectionConfig.listSlugs()) {
    const tab = detectionConfig.getTab(slug);
    if (tab && aiModels.includes(tab.aiModelId)) {
      try {
        detectionStore.assignCamera(slug, camera.id);
        assigned.push(slug);
      } catch {
        /* ignore */
      }
    }
  }

  camLog.logCameraSaved(camera, {
    boardError,
    assignedSlug: assigned.length ? assigned.join(', ') : null,
  });

  return res.status(201).json({ camera, stats: cameraStore.cameraStats() });
});

app.patch('/api/cameras/:id', (req, res) => {
  const sess = resolveSession(req);
  if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
  const existing = cameraStore.getCamera(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Camera not found.' });

  const patch = {};
  if (req.body?.modelConfidence && typeof req.body.modelConfidence === 'object') {
    const merged = { ...(existing.modelConfidence || {}) };
    for (const [modelId, value] of Object.entries(req.body.modelConfidence)) {
      const n = Number(value);
      if (!Number.isFinite(n)) continue;
      merged[modelId] = Math.round(Math.max(0.25, Math.min(0.95, n)) * 100) / 100;
    }
    patch.modelConfidence = merged;
  }

  if (!Object.keys(patch).length) {
    return res.status(400).json({ error: 'No valid fields to update.' });
  }

  const camera = cameraStore.updateCamera(req.params.id, patch);
  return res.json({ camera });
});

app.delete('/api/cameras/:id', async (req, res) => {
  const sess = resolveSession(req);
  if (!sess) return res.status(401).json({ error: 'You must be signed in.' });

  const camera = cameraStore.getCamera(req.params.id);
  if (!camera) return res.status(404).json({ error: 'Camera not found.' });

  const meta = { name: camera.name || null, rtspUrl: camera.rtspUrl || null };
  let purgeStats = { events: 0, clusters: 0, alerts: 0 };

  // Stop any live person/face loops for this camera first.
  try { await personLive.stopLive?.(req.params.id); } catch { /* ignore */ }
  try { await faceLive.stopLive?.(req.params.id); } catch { /* ignore */ }

  // Purge events (person/face/…) + danger zones + track state for this camera.
  // Re-adding the same RTSP later must not revive old history.
  try {
    const ev = detectionStore.purgeCameraData(req.params.id, meta);
    purgeStats.events = ev?.removedEvents || 0;
  } catch (err) {
    console.warn('[cameras] purge events failed:', err.message);
  }

  try {
    const cl = faceClusterStore.purgeCameraData(req.params.id, meta);
    purgeStats.clusters = (cl?.removedClusters || 0) + (cl?.trimmedClusters || 0);
  } catch (err) {
    console.warn('[cameras] purge clusters failed:', err.message);
  }

  try {
    const al = faceStore.purgeCameraAlerts(req.params.id, meta);
    purgeStats.alerts = al?.removed || 0;
  } catch (err) {
    console.warn('[cameras] purge alerts failed:', err.message);
  }

  const removed = cameraStore.removeCamera(req.params.id);
  if (!removed) return res.status(404).json({ error: 'Camera not found.' });
  return res.json({
    ok: true,
    purged: purgeStats,
    stats: cameraStore.cameraStats(),
    message: 'Camera deleted — old events and clusters for this camera were cleared',
  });
});

app.get('/dashboard', (req, res) => {
  if (!requirePageAccess(req, res)) return;
  res.type('html').send(appLayout.renderPage('dashboard-shell.html'));
});

app.get('/api/session', (req, res) => {
  const sess = resolveSession(req);
  if (!sess) {
    return res.status(401).json({ authenticated: false });
  }
  const profile = deviceProfile.getProfile();
  const onboardingComplete = deviceProfile.isUserOnboarded(sess.meshUserId);
  ensureStandaloneSessionRole(sess);
  const clusterRoleConfirmed = session.isClusterRoleConfirmed(sess.sessionId);
  const userRoleConfirmed = session.isUserRoleConfirmed(sess.sessionId);
  const sessionRoleId = session.getSessionUserRole(sess.sessionId);
  const savedRole = dashboardRbac.getUserRole(sess.meshUserId);
  const activeRoleId = sessionRoleId || savedRole?.id || null;
  masterControl.bootstrapMasterControl({
    meshUserId: sess.meshUserId,
    username: sess.username,
    organizationName: profile?.organizationName,
  });
  res.json({
    authenticated: true,
    username: sess.username,
    userId: sess.meshUserId,
    email: sess.email || null,
    sessionId: sess.sessionId,
    deviceRegistered: deviceProfile.isRegistered(),
    onboardingComplete,
    clusterRoleConfirmed,
    clusterMode: profile?.clusterMode || null,
    userRoleConfirmed,
    userRole: activeRoleId ? dashboardRbac.getRolePayload(activeRoleId) : null,
    redirectTo: postLoginRedirect(sess),
    profile,
    masterControl: {
      enabled: masterControl.isFlagEnabled('master_control', { userId: sess.meshUserId }),
      platform: masterControl.getPlatformState(),
      role: req.masterRole || null,
    },
  });
});

app.get('/api/cluster-role', (req, res) => {
  const sess = resolveSession(req);
  if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
  return res.json({
    clusterMode: deviceProfile.getClusterMode(),
    clusterRoleConfirmed: session.isClusterRoleConfirmed(sess.sessionId),
  });
});

app.post('/api/cluster-role', (req, res) => {
  const sess = resolveSession(req);
  if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
  if (!deviceProfile.isRegistered()) return res.status(400).json({ error: 'Device must be registered first.' });
  try {
    const mode = deviceProfile.setClusterMode(req.body?.clusterMode);
    session.confirmClusterRole(sess.sessionId);

    if (mode === 'standalone') {
      ensureStandaloneSessionRole(sess);
      return res.json({
        success: true,
        clusterMode: mode,
        redirectTo: '/overview',
        skipUserRole: true,
      });
    }

    return res.json({ success: true, clusterMode: mode, redirectTo: '/user-role' });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message || 'Failed to save cluster mode.' });
  }
});

app.get('/api/user-role', (req, res) => {
  const sess = resolveSession(req);
  if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
  const clusterMode = deviceProfile.getClusterMode();
  if (clusterMode === 'standalone') {
    ensureStandaloneSessionRole(sess);
    return res.json({
      clusterMode,
      skipUserRole: true,
      redirectTo: '/overview',
      roles: [],
      userRole: dashboardRbac.getRolePayload(dashboardRbac.getDefaultRoleIdForClusterMode('standalone')),
      userRoleConfirmed: true,
    });
  }
  const saved = dashboardRbac.getUserRole(sess.meshUserId);
  const roles = dashboardRbac.listRolesForClusterMode(clusterMode);
  const defaultRoleId = dashboardRbac.getDefaultRoleIdForClusterMode(clusterMode);
  const savedRoleId = saved?.id;
  const activeRoleId =
    savedRoleId && roles.some((role) => role.id === savedRoleId) ? savedRoleId : defaultRoleId;
  return res.json({
    clusterMode,
    roles: roles.map((role) => dashboardRbac.getRolePayload(role.id)),
    userRole: dashboardRbac.getRolePayload(activeRoleId),
    userRoleConfirmed: session.isUserRoleConfirmed(sess.sessionId),
  });
});

app.post('/api/user-role', (req, res) => {
  const sess = resolveSession(req);
  if (!sess) return res.status(401).json({ error: 'You must be signed in.' });
  if (!session.isClusterRoleConfirmed(sess.sessionId)) {
    return res.status(400).json({ error: 'Complete master/slave setup first.' });
  }
  const clusterMode = deviceProfile.getClusterMode();
  if (clusterMode === 'standalone') {
    ensureStandaloneSessionRole(sess);
    return res.json({
      success: true,
      userRole: dashboardRbac.getRolePayload(dashboardRbac.getDefaultRoleIdForClusterMode('standalone')),
      redirectTo: '/overview',
    });
  }
  try {
    const roleId = req.body?.roleId;
    if (!dashboardRbac.isRoleAllowedForClusterMode(clusterMode, roleId)) {
      return res.status(400).json({
        error:
          clusterMode === 'master'
            ? 'Master nodes only support Admin and Viewer roles.'
            : 'Invalid role for the current cluster mode.',
      });
    }
    const role = dashboardRbac.setUserRole(sess.meshUserId, roleId);
    session.confirmUserRole(sess.sessionId, role.id);
    const payload = dashboardRbac.getRolePayload(role.id);
    return res.json({
      success: true,
      userRole: payload,
      redirectTo: payload?.landingPath || '/overview',
    });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message || 'Failed to save user role.' });
  }
});

app.get('/api/master/public-state', (_req, res) => {
  res.json({
    platform: masterControl.getPlatformState(),
    masterControlEnabled: masterControl.isFlagEnabled('master_control'),
  });
});

app.get('/api/device/profile', (_req, res) => {
  const profile = deviceProfile.getProfile();
  res.json({
    registered: deviceProfile.isRegistered(),
    profile,
    deviceId: deviceBinding.getDeviceId(),
    deviceSerial: deviceBinding.getDeviceSerial(),
    meshcentralUrl,
  });
});

app.post('/api/device/register', async (req, res) => {
  const sessRecord = resolveSession(req);
  if (!sessRecord) {
    return res.status(401).json({ error: 'You must be signed in to register this device.' });
  }

  const {
    deviceSerial,
    deviceName,
    deviceType,
    operatingSystem,
    organizationName,
    adminName,
    adminRole,
    email,
    phone,
    country,
    city,
    registerMeshCentral,
    meshGroupName,
    sudoPassword,
  } = req.body;

  const missing = [];
  if (!deviceName) missing.push('Device Name');
  if (!deviceType) missing.push('Device Type');
  if (!operatingSystem) missing.push('Operating System');
  if (!organizationName) missing.push('Organization Name');
  if (!adminName) missing.push('Administrator Name');
  if (!adminRole) missing.push('Role / Designation');
  if (!country) missing.push('Country');
  if (!city) missing.push('City');
  if (registerMeshCentral && !meshGroupName) missing.push('MeshCentral Device Group Name');
  if (registerMeshCentral && canAutoInstall(operatingSystem) && !sudoPassword) {
    missing.push('Device password (sudo)');
  }

  if (missing.length) {
    return res.status(400).json({ error: `Required fields missing: ${missing.join(', ')}.` });
  }

  if (deviceProfile.isUserOnboarded(sessRecord.meshUserId)) {
    return res.json({
      success: true,
      alreadyRegistered: true,
      message: 'You have already completed device registration.',
      profile: deviceProfile.getProfile(),
      redirectTo: '/overview',
    });
  }

  const onboardingCheck = validateOnboardingEmail(sessRecord, email);
  if (!onboardingCheck.ok) {
    return res.status(400).json({ error: onboardingCheck.error });
  }

  const serial = deviceSerial || deviceBinding.getDeviceSerial();
  const profilePayload = {
    deviceId: deviceBinding.getDeviceId(),
    deviceSerial: serial,
    deviceName: String(deviceName).trim(),
    deviceType: String(deviceType).trim(),
    operatingSystem: String(operatingSystem).trim(),
    organizationName: String(organizationName).trim(),
    adminName: String(adminName).trim(),
    adminRole: String(adminRole).trim(),
    email: email ? String(email).trim() : null,
    phone: phone ? String(phone).trim() : null,
    country: String(country).trim(),
    city: String(city).trim(),
    registerMeshCentral: !!registerMeshCentral,
    meshGroupName: meshGroupName ? String(meshGroupName).trim() : null,
    registeredBy: sessRecord.username,
  };

  try {
    const profile = deviceProfile.saveProfile(profilePayload);

    let cloudSave = { ok: false };
    if (await isAtomicCenterOnline()) {
      cloudSave = await saveDeviceProfileToCloud({
        userId: sessRecord.meshUserId,
        username: sessRecord.username,
        profilePayload,
      });
      if (cloudSave.ok) {
        console.log('[API] Device profile saved to AWS database:', cloudSave.deviceRecordId);
      } else {
        console.warn('[API] AWS profile save failed:', cloudSave.error);
      }
    } else {
      cloudSave = { ok: false, error: 'Atomic Center is offline. Profile saved locally only.' };
    }

    const cloudFields = {
      profileStoredOnCloud: cloudSave.ok,
      deviceRecordId: cloudSave.deviceRecordId || null,
      cloudSaveError: cloudSave.ok ? null : cloudSave.error,
    };

    if (!registerMeshCentral) {
      markOnboardingComplete(sessRecord, profilePayload.email);
      return res.json({
        success: true,
        message: cloudSave.ok
          ? 'Device registered and saved to Atomic Center database.'
          : 'Device registered locally. Cloud save failed — see cloudSaveError.',
        profile,
        onboardingComplete: true,
        redirectTo: '/cluster-role',
        ...cloudFields,
      });
    }

    if (!sessRecord.password) {
      return res.status(401).json({
        error:
          'Your details were saved, but the session expired. Sign in again to install the MeshCentral agent.',
        profile,
        ...cloudFields,
      });
    }

    try {
      const result = await runAtomicRegistration({
        username: sessRecord.username,
        atomicPassword: sessRecord.password,
        userId: sessRecord.meshUserId,
        profilePayload,
        operatingSystem,
        sudoPassword,
      });

      session.clearSessionPassword(sessRecord.sessionId);

      markOnboardingComplete(sessRecord, profilePayload.email);

      return res.json({
        success: true,
        partial: result.partial,
        message: result.message,
        profile,
        phases: result.phases,
        meshCentral: {
          ...result.meshCentral,
          profileStoredOnCloud: result.meshCentral?.profileStoredOnCloud || cloudSave.ok,
          deviceRecordId: result.meshCentral?.deviceRecordId || cloudSave.deviceRecordId || null,
          cloudSaveError: result.meshCentral?.cloudSaveError || cloudSave.error || null,
        },
        agentInstall: result.agentInstall,
        onboardingComplete: true,
        redirectTo: '/cluster-role',
        ...cloudFields,
      });
    } catch (e) {
      console.error('[API] Atomic Center registration failed:', e.message);
      if (cloudSave.ok) {
        markOnboardingComplete(sessRecord, profilePayload.email);
      }
      return res.status(cloudSave.ok ? 200 : 503).json({
        success: cloudSave.ok,
        partial: true,
        error: e.message,
        message: cloudSave.ok
          ? 'Profile saved to AWS. MeshCentral agent setup failed — you can retry after signing in again.'
          : e.message,
        profile,
        phases: e.phases || [],
        onboardingComplete: cloudSave.ok,
        redirectTo: cloudSave.ok ? '/cluster-role' : undefined,
        ...cloudFields,
      });
    }
  } catch (e) {
    console.error('[API] POST /api/device/register failed:', e.message);
    return res.status(500).json({ error: 'Failed to save device registration.' });
  }
});

app.get('/api/device/status', (_req, res) => {
  if (meshcentralStatus.isStale()) {
    meshcentralStatus.refresh().catch(() => {});
  }
  res.json({
    ...deviceStatusPayload(),
    meshcentralReachable: meshcentralStatus.getReachable(),
    online: meshcentralStatus.getReachable(),
  });
});

app.post('/api/logout', (req, res) => {
  const sessionId = req.body?.sessionId;
  session.destroySession(sessionId);
  res.json({ success: true });
});

app.get('/api/health', async (_req, res) => {
  const device = deviceStatusPayload();
  try {
    const remote = await checkHealth();
    res.json({
      ok: remote.ok,
      meshcentralUrl,
      meshcentralReachable: true,
      ...device,
      remote: remote.data,
      deviceIp: getLocalIp(),
    });
  } catch (e) {
    console.error('[API] GET /api/health failed:', e.message, e.cause?.message || '');
    const canWorkOffline = offlineLoginEnabled() && deviceBinding.isBound();
    res.status(canWorkOffline ? 200 : 503).json({
      ok: canWorkOffline,
      meshcentralUrl,
      meshcentralReachable: false,
      ...device,
      error: e.message,
      deviceIp: getLocalIp(),
    });
  }
});

app.get('/api/config', async (_req, res) => {
  try {
    const { status, data } = await proxyJson('/api/atomoforge/health', 'GET');
    const online = status === 200 && data.ok === true;
    res.status(status).json({
      emailVerificationEnabled: !!data.emailVerificationEnabled,
      online,
      meshcentralReachable: online,
      meshcentralUrl,
      ...deviceStatusPayload(),
    });
  } catch (e) {
    console.error('[API] GET /api/config failed:', e.message, e.cause?.message || '');
    res.status(503).json({
      emailVerificationEnabled: false,
      online: false,
      meshcentralReachable: false,
      error: e.message,
      ...deviceStatusPayload(),
    });
  }
});

app.post('/api/signup/init', async (req, res) => {
  if (!masterControl.isRegistrationAllowed()) {
    const state = masterControl.getPlatformState();
    return res.status(503).json({
      error: platformBlockReason(state, { kind: 'Registration' }),
      platform: state,
    });
  }
  if (!(await requireOnlineForSignup(res))) return;

  const username = String(req.body.username || '').trim();
  const email = String(req.body.email || '').trim();
  const { password, confirmPassword } = req.body;

  if (!username || !email || !password || !confirmPassword) {
    return res.status(400).json({ error: 'All fields are required.' });
  }

  try {
    const result = await proxyJson('/api/atomoforge/signup/init', 'POST', {
      username,
      email,
      password,
      confirmPassword,
    });

    if (result.status >= 200 && result.status < 300 && result.data.otpId) {
      pendingSignups.set(normalizeUsername(username), {
        username,
        email,
        password,
        otpId: result.data.otpId,
        createdAt: Date.now(),
      });
    }

    return sendProxy(res, result);
  } catch (e) {
    console.error('[API] POST /api/signup/init failed:', e.message, e.cause?.message || '');
    const msg = isNetworkError(e)
      ? 'Signup requires internet to reach Atomic Center and send the verification email.'
      : e.message;
    return res.status(503).json({ error: msg });
  }
});

app.post('/api/signup/resend', async (req, res) => {
  if (!(await requireOnlineForSignup(res))) return;

  const username = String(req.body.username || '').trim();
  const pending = pendingSignups.get(normalizeUsername(username));

  if (!pending || !pending.otpId) {
    return res.status(404).json({ error: 'Signup session expired. Please start again.' });
  }

  try {
    const result = await proxyJson('/api/atomoforge/signup/resend', 'POST', {
      otpId: pending.otpId,
    });
    return sendProxy(res, result);
  } catch (e) {
    console.error('[API] POST /api/signup/resend failed:', e.message, e.cause?.message || '');
    return res.status(503).json({ error: e.message });
  }
});

app.post('/api/signup/verify-2fa', async (req, res) => {
  if (!(await requireOnlineForSignup(res))) return;

  const username = String(req.body.username || '').trim();
  const { token } = req.body;

  if (!username || !token) {
    return res.status(400).json({ error: 'Username and verification code are required.' });
  }

  const pending = pendingSignups.get(normalizeUsername(username));
  if (!pending) {
    return res.status(404).json({ error: 'Signup session expired. Please start again.' });
  }

  try {
    const result = await proxyJson('/api/atomoforge/signup/verify', 'POST', {
      otpId: pending.otpId,
      token,
      username: pending.username,
    });

    if (result.status >= 200 && result.status < 300 && result.data.success) {
      try {
        const bindResult = await completeSignupBind({
          username: pending.username,
          email: pending.email,
          password: pending.password,
          userId: result.data.userId,
        });
        pendingSignups.delete(normalizeUsername(username));
        return sendProxy(res, bindResult);
      } catch (bindErr) {
        console.error('[Auth] Signup bind failed:', bindErr.message);
        return res.status(500).json({ error: 'Account created on server but device binding failed.' });
      }
    }

    return sendProxy(res, result);
  } catch (e) {
    console.error('[API] POST /api/signup/verify-2fa failed:', e.message, e.cause?.message || '');
    return res.status(503).json({ error: e.message });
  }
});

app.post('/api/login', async (req, res) => {
  const username = String(req.body.username || '').trim();
  const { password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  if (!masterControl.isLoginAllowed()) {
    const state = masterControl.getPlatformState();
    return res.status(503).json({
      error: platformBlockReason(state, { kind: 'Login' }),
      platform: state,
    });
  }

  try {
    const result = await authLogin(username, password);
    if (result.status >= 200 && result.status < 300 && result.data?.userId) {
      masterControl.bootstrapMasterControl({
        meshUserId: result.data.userId,
        username: result.data.username || username,
        organizationName: deviceProfile.getProfile()?.organizationName,
      });
    }
    return sendProxy(res, result);
  } catch (e) {
    console.error('[API] POST /api/login failed:', e.message, e.cause?.message || '');
    return res.status(503).json({ error: e.message });
  }
});

setInterval(() => {
  const cutoff = Date.now() - 15 * 60 * 1000;
  for (const [key, value] of pendingSignups.entries()) {
    if (value.createdAt < cutoff) {
      pendingSignups.delete(key);
    }
  }
}, 60 * 1000);

async function startServer() {
  const device = deviceStatusPayload();
  console.log('Device ID:', device.deviceId);
  if (device.bound) {
    console.log(`Device bound to: ${device.boundUser.username} (${device.boundUser.userId})`);
  } else {
    console.log('Device not bound yet — first signup/login will bind this device.');
  }

  meshcentralStatus.markUnreachable();

  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname === '/ws/detection') {
        wss.handleUpgrade(req, socket, head, (ws) => {
          const slug = url.searchParams.get('slug') || 'person';
          eventBroadcast.addClient(ws, slug);
        });
        return;
      }
      if (url.pathname === '/ws/face-live') {
        wss.handleUpgrade(req, socket, head, (ws) => {
          const cameraId = url.searchParams.get('cameraId');
          faceLive.addStreamClient(ws, cameraId);
        });
        return;
      }
      if (url.pathname === '/ws/person-live') {
        wss.handleUpgrade(req, socket, head, (ws) => {
          const cameraId = url.searchParams.get('cameraId');
          personLive.addStreamClient(ws, cameraId);
        });
        return;
      }
      if (url.pathname === '/ws/face-live') {
        wss.handleUpgrade(req, socket, head, (ws) => {
          const cameraId = url.searchParams.get('cameraId');
          faceLive.addStreamClient(ws, cameraId);
        });
        return;
      }
      if (url.pathname === '/ws/person-live') {
        wss.handleUpgrade(req, socket, head, (ws) => {
          const cameraId = url.searchParams.get('cameraId');
          personLive.addStreamClient(ws, cameraId);
        });
        return;
      }
    } catch {
      /* fall through */
    }
    socket.destroy();
  });

  server.listen(PORT, HOST, () => {
    const ip = getLocalIp();
    console.log(`Atomo Forge listening on ${HOST}:${PORT}`);
    console.log(`  On this device:  http://localhost:${PORT}`);
    console.log(`  On your network: http://${ip}:${PORT}`);
    console.log(`  MeshCentral:     ${meshcentralUrl}`);
    if (offlineLoginEnabled()) {
      console.log(`  Offline login:   ${device.bound ? 'ready' : 'needs one online bind first'}`);
    }
  });

  meshcentralStatus.startBackgroundRefresh();
  verifyMeshCentralOnStartup().catch(() => {});
  // Re-push every saved camera to the board so Start stream works after restart.
  syncAllCamerasToBoard().catch((err) => {
    console.warn('[cameras] startup board sync:', err.message || err);
  });
  // Keep Face/Person tab lists in sync with camera.aiModels after restart.
  try {
    for (const cam of cameraStore.listCameras()) {
      const models = Array.isArray(cam.aiModels) ? cam.aiModels : [];
      for (const slug of detectionConfig.listSlugs()) {
        const tab = detectionConfig.getTab(slug);
        if (tab && models.includes(tab.aiModelId)) {
          try { detectionStore.assignCamera(slug, cam.id); } catch { /* ignore */ }
        }
      }
    }
  } catch (err) {
    console.warn('[cameras] tab assign hydrate:', err.message || err);
  }
}

startServer();
