/**
 * Overview dashboard — real cameras, detection events, alerts, and system stats.
 */

const os = require('os');
const cameraStore = require('./camera-store');
const detectionConfig = require('./detection-config');
const detectionStore = require('./detection-store');
const faceStore = require('./face-store');
const deviceProfile = require('./device-profile');
const { getMeshcentralUrl } = require('./device-config');
const {
  fetchSystemStats,
  getLocalSystemStats,
  getCachedBoardStats,
} = require('./local-system-stats');

/** Rolling metric history for charts (server-side, last N samples). */
const history = {
  cpu: [],
  ram: [],
  npu: [],
  download: [],
  upload: [],
  temp: [],
};
const HISTORY_LEN = 12;

function pushHistory(key, value) {
  if (value == null || !Number.isFinite(Number(value))) return;
  const arr = history[key];
  arr.push(Number(value));
  while (arr.length > HISTORY_LEN) arr.shift();
}

function padHistory(arr, fallback = 0) {
  const out = Array.isArray(arr) ? arr.slice() : [];
  while (out.length < 3) out.unshift(fallback);
  return out;
}

function isSameDay(iso, day = new Date()) {
  if (!iso) return false;
  const d = new Date(iso);
  return d.toDateString() === day.toDateString();
}

function startOfDay(d = new Date()) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function collectAllEvents() {
  const out = [];
  for (const slug of detectionConfig.listSlugs()) {
    const state = detectionStore.getModelState(slug);
    const events = Array.isArray(state.recentEvents) ? state.recentEvents : [];
    for (const e of events) {
      out.push({
        ...e,
        slug,
        time: e.time || e.createdAt || null,
        severity: e.severity || 'info',
        title: e.title || e.eventType || `${slug} event`,
      });
    }
  }
  return out;
}

function collectRecentAlerts(limit = 8) {
  const faceAlerts = faceStore.listAlerts({ status: 'active' }).map((a) => ({
    title: a.title || a.type || 'Face alert',
    time: a.createdAt
      ? new Date(a.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : '—',
    severity: a.severity || 'warning',
    createdAt: a.createdAt,
  }));

  const events = collectAllEvents()
    .filter((e) => e.severity === 'critical' || e.severity === 'warning' || e.eventType === 'person-restricted-area')
    .map((e) => ({
      title: `${e.title}${e.camera ? ` — ${e.camera}` : ''}`,
      time: e.time
        ? new Date(e.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : '—',
      severity: e.severity || 'warning',
      createdAt: e.time,
    }));

  return [...faceAlerts, ...events]
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
    .slice(0, limit);
}

function buildAlertStats(events, faceAlerts) {
  const todayEvents = events.filter((e) => isSameDay(e.time));
  const todayFace = faceAlerts.filter((a) => isSameDay(a.createdAt));
  const todayTotal = todayEvents.length + todayFace.length;

  const criticalOpen = [
    ...todayEvents.filter((e) => e.severity === 'critical'),
    ...faceAlerts.filter((a) => a.status === 'active' && a.severity === 'critical'),
  ].length;

  const breakdown = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const e of todayEvents) {
    const s = String(e.severity || 'info').toLowerCase();
    if (s === 'critical') breakdown.critical += 1;
    else if (s === 'warning' || s === 'high') breakdown.high += 1;
    else if (s === 'success' || s === 'medium') breakdown.medium += 1;
    else if (s === 'low') breakdown.low += 1;
    else breakdown.info += 1;
  }
  for (const a of todayFace) {
    const s = String(a.severity || 'warning').toLowerCase();
    if (s === 'critical') breakdown.critical += 1;
    else if (s === 'warning' || s === 'high') breakdown.high += 1;
    else breakdown.medium += 1;
  }

  const allTimes = [
    ...todayEvents.map((e) => e.time),
    ...todayFace.map((a) => a.createdAt),
  ]
    .filter(Boolean)
    .map((t) => new Date(t).getTime())
    .sort((a, b) => b - a);

  return {
    todayTotal,
    criticalOpen,
    breakdown,
    lastAlertAt: allTimes.length ? new Date(allTimes[0]).toISOString() : null,
  };
}

function buildHourlyTrend(events, faceAlerts) {
  const buckets = Array(24).fill(0);
  const today = startOfDay();
  const push = (iso) => {
    if (!iso) return;
    const d = new Date(iso);
    if (d < today) return;
    buckets[d.getHours()] += 1;
  };
  for (const e of events) push(e.time);
  for (const a of faceAlerts) push(a.createdAt);
  // Show last ~11 buckets from morning-ish to now for the sparkline UI
  const hour = new Date().getHours();
  const start = Math.max(0, hour - 10);
  return buckets.slice(start, hour + 1);
}

function buildWeekSeries(events, faceAlerts) {
  const labels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const cameraEvents = Array(7).fill(0);
  const alertEvents = Array(7).fill(0);
  const now = new Date();
  for (let i = 6; i >= 0; i -= 1) {
    const day = new Date(now);
    day.setDate(now.getDate() - (6 - i));
    const key = day.toDateString();
    cameraEvents[i] = events.filter((e) => e.time && new Date(e.time).toDateString() === key).length;
    alertEvents[i] = faceAlerts.filter((a) => a.createdAt && new Date(a.createdAt).toDateString() === key).length
      + events.filter((e) => e.time && new Date(e.time).toDateString() === key
        && (e.severity === 'critical' || e.severity === 'warning')).length;
  }
  // Reorder to Mon…Sun for display
  const order = [1, 2, 3, 4, 5, 6, 0];
  return {
    labels: order.map((i) => labels[i]),
    cameraEvents: order.map((i) => cameraEvents[i]),
    alertEvents: order.map((i) => alertEvents[i]),
    totalEvents: cameraEvents.reduce((s, n) => s + n, 0) + alertEvents.reduce((s, n) => s + n, 0),
  };
}

function buildAiModels() {
  return detectionConfig.listSlugs().map((slug) => {
    const tab = detectionConfig.getTab(slug);
    const state = detectionStore.getModelState(slug);
    const assigned = Array.isArray(state.assignedCameraIds) ? state.assignedCameraIds.length : 0;
    return {
      id: tab?.aiModelId || slug,
      name: tab?.modelName || tab?.title || slug,
      shortLabel: tab?.title || slug,
      running: Boolean(state.inferenceRunning),
      assignedCameras: assigned,
      slug,
    };
  });
}

function primaryLanIp() {
  const nets = os.networkInterfaces();
  for (const list of Object.values(nets || {})) {
    for (const n of list || []) {
      if (n.family === 'IPv4' && !n.internal) return n.address;
    }
  }
  return process.env.BOARD_IP || '127.0.0.1';
}

function bytesToGb(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round((n / (1024 ** 3)) * 10) / 10;
}

async function resolveSystemStats() {
  try {
    const board = await fetchSystemStats();
    if (board) return board;
  } catch {
    /* fall through */
  }
  return getCachedBoardStats() || getLocalSystemStats();
}

async function getOverviewPayload(sess) {
  const profile = deviceProfile.getProfile();
  const cameras = cameraStore.listCameras();
  const camStats = cameraStore.cameraStats();
  const online = cameras.filter((c) => c.status === 'online').length;
  const offline = Math.max(0, cameras.length - online);

  const events = collectAllEvents();
  const faceAlerts = faceStore.listAlerts();
  const alertStats = buildAlertStats(events, faceAlerts);
  const aiModels = buildAiModels();
  const runningModels = aiModels.filter((m) => m.running);
  const stats = await resolveSystemStats();
  const local = getLocalSystemStats();

  const cpu = stats?.cpu ?? local.cpu ?? 0;
  const ramPct = stats?.ram ?? local.ram ?? 0;
  const npu = stats?.npu != null ? stats.npu : 0;
  const npuAvailable = stats?.npu_detail?.available !== false && stats?.npu != null;
  const temp = stats?.temp ?? stats?.temp_detail?.temp_c ?? null;
  const download = stats?.net_detail?.download_mbps ?? stats?.net ?? 0;
  const upload = stats?.net_detail?.upload_mbps ?? 0;
  const ramTotalGb = bytesToGb(stats?.ram_detail?.total ?? local.ram_detail?.total)
    || bytesToGb(os.totalmem());
  const ramUsedGb = bytesToGb(stats?.ram_detail?.used)
    || Math.round((ramPct / 100) * ramTotalGb * 10) / 10;
  const storageUsedGb = bytesToGb(stats?.storage_detail?.used);
  const storageTotalGb = bytesToGb(stats?.storage_detail?.total);
  const storagePct = stats?.storage
    ?? (storageTotalGb > 0 ? Math.round((storageUsedGb / storageTotalGb) * 100) : 0);

  pushHistory('cpu', cpu);
  pushHistory('ram', ramPct);
  if (npuAvailable) pushHistory('npu', npu);
  pushHistory('download', download || 0);
  pushHistory('upload', upload || 0);
  if (temp != null) pushHistory('temp', temp);

  const meshUrl = getMeshcentralUrl() || '';
  const meshHost = String(meshUrl).replace(/^https?:\/\//, '') || '—';
  const clusterMode = deviceProfile.getClusterMode() || 'master';
  const uptimeSecs = Math.floor(stats?.uptime_s ?? local.uptime_s ?? os.uptime());

  const hourly = buildHourlyTrend(events, faceAlerts);
  const week = buildWeekSeries(events, faceAlerts);
  const recentAlerts = collectRecentAlerts(8);

  const lastHour = hourly.slice(-2).reduce((s, n) => s + n, 0);
  const avgPerHour = hourly.length
    ? Math.max(0, Math.round(hourly.reduce((s, n) => s + n, 0) / hourly.length))
    : 0;
  const peakVal = hourly.length ? Math.max(...hourly) : 0;
  const peakIdx = hourly.indexOf(peakVal);
  const peakHour = Math.max(0, new Date().getHours() - (hourly.length - 1 - peakIdx));

  return {
    username: sess?.username || 'operator',
    userRole: sess?.userRole || null,
    cameras: {
      total: cameras.length || camStats.total || 0,
      active: online || camStats.online || 0,
      offline,
      uptimePercent: cameras.length
        ? Math.round((online / cameras.length) * 1000) / 10
        : 0,
      offlineLastSeen: offline ? 'check cameras' : '—',
    },
    cameraFeeds: cameras.slice(0, 8).map((c) => ({
      id: c.id,
      name: c.name,
      status: c.status || 'offline',
    })),
    aiModels,
    aiModelsRunning: runningModels.length,
    aiModelsTotal: aiModels.length,
    alerts: {
      todayTotal: alertStats.todayTotal,
      criticalOpen: alertStats.criticalOpen,
      lastAlertAt: alertStats.lastAlertAt,
    },
    alertBreakdown: alertStats.breakdown,
    recentAlerts,
    alertsLastHour: lastHour,
    alertsAvgPerHour: avgPerHour,
    alertsPeakTime: `${String(peakHour).padStart(2, '0')}:00`,
    resources: {
      cpuPercent: cpu,
      npuPercent: npuAvailable ? npu : 0,
      npuAvailable,
      ramUsedGb,
      ramTotalGb,
      ramPercent: ramPct,
      storageUsedGb,
      storageTotalGb,
      storagePercent: storagePct,
      cpuHistory: padHistory(history.cpu, cpu),
      ramHistory: padHistory(history.ram, ramPct),
      npuHistory: padHistory(history.npu, npuAvailable ? npu : 0),
    },
    network: {
      interfaceName: stats?.net_detail?.iface || 'eth0',
      downloadMbps: Math.round((download || 0) * 100) / 100,
      uploadMbps: Math.round((upload || 0) * 100) / 100,
      deviceIp: primaryLanIp(),
      downloadHistory: padHistory(history.download, download || 0),
      uploadHistory: padHistory(history.upload, upload || 0),
    },
    health: {
      temperatureC: temp != null ? Math.round(temp) : null,
      uptimeBaseSecs: uptimeSecs,
      powerSource: 'ac',
      fanRpm: null,
      throttling: cpu > 85 ? 'Active' : 'None',
    },
    sync: {
      status: stats?._fromBoard || stats?.live ? 'connected' : (stats?._boardOffline ? 'local' : 'connected'),
      atomicCentreUrl: meshUrl || 'https://atomic-centre.atomo.io',
      atomicCentreHost: meshHost,
    },
    device: {
      hostname: stats?.board_hostname || local.board_hostname || profile?.deviceName || os.hostname(),
      deviceId: profile?.deviceSerial || '—',
      firmwareVersion: profile?.firmwareVersion || '—',
      osVersion: `${os.type()} ${os.release()}`,
      organizationName: profile?.organizationName || '—',
    },
    deviceRole: {
      role: 'Edge AI Gateway',
      clusterMode,
    },
    license: {
      edition: profile?.licenseEdition || 'Standard',
      daysRemaining: profile?.licenseDaysRemaining ?? null,
      status: profile?.licenseStatus || 'active',
    },
    statistic: week,
    alertTrend: {
      today: hourly.length ? hourly : [0],
      week: week.alertEvents,
      month: week.alertEvents,
    },
  };
}

module.exports = { getOverviewPayload };
