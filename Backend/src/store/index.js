const { readDB, writeDB } = require('../services/dbStore');

const cameras = new Map();
const models = new Map();
const workers = new Map();
const cameraLogs = new Map();

const uuidv4 = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
  const r = Math.random() * 16 | 0;
  const v = c === 'x' ? r : (r & 0x3 | 0x8);
  return v.toString(16);
});

function pushLog(cameraId, entry) {
  if (!cameraLogs.has(cameraId)) cameraLogs.set(cameraId, []);
  cameraLogs.get(cameraId).push({
    timestamp: new Date().toISOString(),
    ...entry
  });
}

const log = require('../utils/logger').child('store');

const builtinModels = [
  { id: 'mdl_person', name: 'Person Detection', type: 'builtin', capabilities: ['person_detection'], is_active: true },
  { id: 'mdl_face', name: 'Face Detection', type: 'builtin', capabilities: ['face_detection', 'gender_classification', 'face_recognition'], is_active: true },
  { id: 'mdl_fire', name: 'Fire/Smoke Detection', type: 'builtin', capabilities: ['fire_detection', 'smoke_detection'], is_active: true },
  { id: 'mdl_ppe', name: 'PPE Detection', type: 'builtin', capabilities: ['helmet_detection', 'vest_detection', 'gloves_detection'], is_active: true },
];

builtinModels.forEach(m => models.set(m.id, m));
log.info({ builtin_count: builtinModels.length }, 'initialized builtin models');

// Populate cameras from database.json if available
try {
  const db = readDB();
  if (Array.isArray(db.cameras)) {
    db.cameras.forEach(c => {
      cameras.set(c.id, {
        ...c,
        rtsp_url: c.rtsp_url || c.url || `rtsp://localhost:8554/${c.id}`,
        url: c.url || c.rtsp_url,
      });
    });
    log.info({ count: db.cameras.length }, 'loaded cameras from database file');
  }
} catch (err) {
  log.error({ err }, 'Failed to load cameras from database');
}

function saveCamerasToDB() {
  const db = readDB();
  db.cameras = Array.from(cameras.values());
  writeDB(db);
}

module.exports = { cameras, models, workers, cameraLogs, uuidv4, pushLog, saveCamerasToDB };
