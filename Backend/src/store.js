/**
 * In-memory store — replace with SQLite/PostgreSQL in production.
 * Persists nothing on restart; used here for testability without a DB.
 */

const { v4: uuidv4 } = require('uuid');
const log = require('./utils/logger').child('store');

log.debug('initializing in-memory store');

// ── Cameras ──────────────────────────────────────────────────────────────────
const cameras = new Map();
log.debug('cameras store initialized');

// ── Models ───────────────────────────────────────────────────────────────────
// Built-in models are pre-seeded on start
const models = new Map([
  ['mdl_person', {
    id: 'mdl_person',
    name: 'Person Detection',
    type: 'builtin',
    is_active: true,
    tab_created: true,
    version: '1.0.0',
    script_path: 'detectors/person.py',
    model_path: 'models/person/yolo26s.nb',
    library_path: 'lib/libnn_yolo26s.so',
    assigned_cameras: [],
    capabilities: ['person_detection'],        // sub-features
  }],
  ['mdl_face', {
    id: 'mdl_face',
    name: 'Face Analysis',
    type: 'builtin',
    is_active: true,
    tab_created: true,
    version: '1.0.0',
    script_path: 'detectors/face.py',
    model_path: 'models/face/face.nb',
    library_path: 'lib/libnn_face.so',
    assigned_cameras: [],
    /**
     * Sub-capabilities users can toggle independently:
     *  face_detection  — just detect & localise faces
     *  gender_classification — add M/F label on top of detection
     *  face_recognition — match against enrolled embeddings
     */
    capabilities: ['face_detection', 'gender_classification', 'face_recognition'],
  }],
  ['mdl_fire', {
    id: 'mdl_fire',
    name: 'Fire & Smoke Detection',
    type: 'builtin',
    is_active: true,
    tab_created: true,
    version: '1.0.0',
    script_path: 'detectors/fire_smoke.py',
    model_path: 'models/fire/fire.nb',
    library_path: 'lib/libnn_fire.so',
    assigned_cameras: [],
    capabilities: ['fire_detection', 'smoke_detection'],
  }],
  ['mdl_ppe', {
    id: 'mdl_ppe',
    name: 'Safety PPE Detection',
    type: 'builtin',
    is_active: true,
    tab_created: true,
    version: '1.0.0',
    script_path: 'detectors/ppe.py',
    model_path: 'models/ppe/ppe.nb',
    library_path: 'lib/libnn_ppe.so',
    assigned_cameras: [],
    capabilities: ['helmet_detection', 'vest_detection', 'gloves_detection', 'no_ppe_alert'],
  }],
]);
log.info({ builtinCount: models.size }, 'models store initialized with builtin models');

// ── Workers (inference processes) ────────────────────────────────────────────
// key: `${camera_id}::${model_id}` → worker descriptor
const workers = new Map();
log.debug('workers store initialized');

// ── Camera logs (ring buffer per camera) ─────────────────────────────────────
const cameraLogs = new Map();
const LOG_RING = 200;

function pushLog(cameraId, event) {
  if (!cameraLogs.has(cameraId)) {
    log.debug({ cameraId }, 'creating new camera log ring');
    cameraLogs.set(cameraId, []);
  }
  const ring = cameraLogs.get(cameraId);
  const entry = { ...event, timestamp: new Date().toISOString() };
  ring.push(entry);
  log.trace({ cameraId, event: entry.event }, 'camera log entry added');
  if (ring.length > LOG_RING) {
    ring.shift();
    log.trace({ cameraId }, `camera log ring rotated at ${LOG_RING}`);
  }
}

// ── Users (for JWT auth demo) ─────────────────────────────────────────────────
const users = new Map([
  ['admin', { id: 'usr_admin', username: 'admin', password: 'admin123', role: 'admin' }],
  ['viewer', { id: 'usr_viewer', username: 'viewer', password: 'viewer123', role: 'viewer' }],
]);
log.info({ userCount: users.size }, 'users store initialized');

// ── Database persistence (cameras survive restarts) ───────────────────────────
let readDB, writeDB;
try {
  const dbStore = require('./services/dbStore');
  readDB  = dbStore.readDB;
  writeDB = dbStore.writeDB;

  // Load cameras saved from previous sessions
  const db = readDB();
  if (Array.isArray(db.cameras)) {
    db.cameras.forEach(c => {
      cameras.set(c.id, {
        ...c,
        rtsp_url: c.rtsp_url || c.url || `rtsp://localhost:8554/${c.id}`,
        url:      c.url      || c.rtsp_url,
      });
    });
    log.info({ count: db.cameras.length }, 'loaded cameras from database file');
  }
} catch (err) {
  log.warn({ err: err.message }, 'dbStore not available — cameras will not persist across restarts');
  readDB  = () => ({});
  writeDB = () => {};
}

function saveCamerasToDB() {
  try {
    const db = readDB();
    db.cameras = Array.from(cameras.values());
    writeDB(db);
  } catch (err) {
    log.error({ err: err.message }, 'failed to save cameras to database');
  }
}

module.exports = { cameras, models, workers, cameraLogs, pushLog, users, uuidv4, saveCamerasToDB };
