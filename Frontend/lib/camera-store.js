const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const STORE_PATH = path.join(__dirname, '..', 'data', 'cameras.json');

const DEFAULT_CAMERAS = [
  {
    id: 'cam-1',
    name: 'North Gate',
    type: 'rtsp',
    status: 'online',
    location: 'Building A',
    zoneFloor: 'Ground',
    department: 'Security',
    group: 'Perimeter',
    resolution: '1920x1080',
    fpsLimit: 25,
    aiModels: ['yolov8-perimeter'],
    recording: true,
    alertRules: ['intrusion-perimeter'],
    createdAt: '2026-06-10T08:00:00.000Z',
  },
  {
    id: 'cam-2',
    name: 'Loading Dock',
    type: 'onvif',
    status: 'online',
    location: 'Warehouse',
    zoneFloor: 'Bay 3',
    department: 'Logistics',
    group: 'Operations',
    resolution: '1280x720',
    fpsLimit: 20,
    aiModels: ['reid-tracking'],
    recording: true,
    alertRules: ['motion-dock'],
    createdAt: '2026-06-11T10:30:00.000Z',
  },
];

function ensureStore() {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  if (!fs.existsSync(STORE_PATH)) {
    fs.writeFileSync(STORE_PATH, JSON.stringify({ cameras: DEFAULT_CAMERAS }, null, 2));
  }
}

function readStore() {
  ensureStore();
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    return Array.isArray(raw.cameras) ? raw.cameras : [];
  } catch {
    return DEFAULT_CAMERAS.slice();
  }
}

function writeStore(cameras) {
  ensureStore();
  fs.writeFileSync(STORE_PATH, JSON.stringify({ cameras }, null, 2));
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj || {}, key);
}

/**
 * Keep the dashboard schema and the public Camera API schema interchangeable.
 * The public API calls the RTSP field `url`; older dashboard code used
 * `rtspUrl`.  Persisting both prevents a camera from looking configured in one
 * screen and URL-less in another.
 */
function normalizeCamera(camera = {}, { partial = false } = {}) {
  const normalized = { ...camera };
  const hasStreamField = ['rtspUrl', 'url', 'streamUrl'].some((key) => hasOwn(camera, key));
  if (!partial || hasStreamField) {
    const streamUrl = camera.rtspUrl ?? camera.url ?? camera.streamUrl ?? '';
    normalized.rtspUrl = String(streamUrl || '').trim();
    normalized.url = normalized.rtspUrl;
  }

  const hasFloorField = ['zoneFloor', 'floor'].some((key) => hasOwn(camera, key));
  if (!partial || hasFloorField) {
    const floor = camera.zoneFloor ?? camera.floor ?? '';
    normalized.zoneFloor = floor;
    normalized.floor = floor;
  }

  const hasWhepField = ['whepUrl', 'whep_url'].some((key) => hasOwn(camera, key));
  if (!partial || hasWhepField) {
    normalized.whepUrl = camera.whepUrl ?? camera.whep_url ?? null;
  }
  const hasHlsField = ['hlsUrl', 'hls_url'].some((key) => hasOwn(camera, key));
  if (!partial || hasHlsField) {
    normalized.hlsUrl = camera.hlsUrl ?? camera.hls_url ?? null;
  }

  if (!partial) {
    normalized.type = normalized.type || 'rtsp';
    normalized.status = normalized.status || 'online';
    normalized.aiModels = Array.isArray(normalized.aiModels) ? normalized.aiModels : [];
  }
  return normalized;
}

function listCameras() {
  return readStore().map((camera) => normalizeCamera(camera));
}

function getCamera(id) {
  return listCameras().find((c) => c.id === id) || null;
}

function addCamera(payload) {
  const cameras = readStore();
  const camera = normalizeCamera({
    status: 'online',
    createdAt: new Date().toISOString(),
    ...payload,
    // Never accept a caller-supplied ID for the dashboard record.
    id: randomUUID(),
  });
  cameras.unshift(camera);
  writeStore(cameras);
  return camera;
}

function removeCamera(id) {
  const cameras = readStore();
  const next = cameras.filter((c) => c.id !== id);
  if (next.length === cameras.length) return false;
  writeStore(next);
  return true;
}

function updateCamera(id, patch) {
  const cameras = readStore();
  const idx = cameras.findIndex((c) => c.id === id);
  if (idx === -1) return null;
  const safePatch = normalizeCamera(patch, { partial: true });
  cameras[idx] = normalizeCamera({ ...cameras[idx], ...safePatch, id });
  writeStore(cameras);
  return cameras[idx];
}

function cameraStats() {
  const cameras = readStore();
  const online = cameras.filter((c) => c.status === 'online').length;
  return {
    total: cameras.length,
    online,
    offline: cameras.length - online,
  };
}

module.exports = {
  listCameras,
  getCamera,
  addCamera,
  removeCamera,
  updateCamera,
  cameraStats,
  normalizeCamera,
};
