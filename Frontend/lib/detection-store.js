const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const detectionConfig = require('./detection-config');
const cameraStore = require('./camera-store');
const { repairFaceEvent } = require('./face-confidence');

const STORE_PATH = path.join(__dirname, '..', 'data', 'detection-models.json');
const SNAP_DIR = path.join(__dirname, '..', 'data', 'event-snaps');

/** In-memory JPEG snapshots keyed by event ID (base64, no data: prefix) */
const eventSnapshots = new Map();

/** Per-track last JPEG — memory only (never persist into detection-models.json). */
const trackLastJpegs = new Map();

/** In-memory models cache — avoid re-parsing a multi‑MB JSON on every tick. */
let modelsCache = null;
let flushTimer = null;
let snapMigrated = false;

function ensureStore() {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.mkdirSync(SNAP_DIR, { recursive: true });
  if (!fs.existsSync(STORE_PATH)) {
    const models = {};
    for (const slug of detectionConfig.listSlugs()) {
      models[slug] = defaultModelState(slug);
    }
    fs.writeFileSync(STORE_PATH, JSON.stringify({ models }, null, 2));
  }
}

function snapFilePath(eventId) {
  const safe = String(eventId || '').replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(SNAP_DIR, `${safe}.jpg`);
}

function normalizeJpegBase64(jpeg) {
  if (!jpeg || typeof jpeg !== 'string' || jpeg.length < 64) return null;
  return jpeg.replace(/^data:image\/\w+;base64,/, '');
}

function persistEventJpeg(eventId, jpegBase64) {
  const id = String(eventId || '');
  const b64 = normalizeJpegBase64(jpegBase64);
  if (!id || !b64) return false;
  try {
    fs.mkdirSync(SNAP_DIR, { recursive: true });
    const buf = Buffer.from(b64, 'base64');
    if (buf.length < 32) return false;
    fs.writeFileSync(snapFilePath(id), buf);
    eventSnapshots.set(id, { jpeg: b64, bbox: null });
    if (eventSnapshots.size > 300) {
      const first = eventSnapshots.keys().next().value;
      eventSnapshots.delete(first);
    }
    return true;
  } catch (err) {
    console.warn('[detection-store] persist snap failed:', err.message);
    return false;
  }
}

function readEventJpegFile(eventId) {
  try {
    const p = snapFilePath(eventId);
    if (!fs.existsSync(p)) return null;
    const buf = fs.readFileSync(p);
    if (!buf || buf.length < 32) return null;
    return buf.toString('base64');
  } catch {
    return null;
  }
}

function deleteEventJpeg(eventId) {
  const id = String(eventId || '');
  if (!id) return;
  eventSnapshots.delete(id);
  try {
    const p = snapFilePath(id);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch {
    /* ignore */
  }
}

function eventHasPhoto(event) {
  if (!event?.id) return false;
  const id = String(event.id);
  if (eventSnapshots.has(id)) return true;
  if (typeof event.snapshotJpeg === 'string' && event.snapshotJpeg.length >= 64) return true;
  try {
    return fs.existsSync(snapFilePath(id));
  } catch {
    return false;
  }
}

/** Move embedded base64 off the event object onto disk + memory. */
function stripEventsForDisk(events) {
  if (!Array.isArray(events)) return [];
  return events.map((e) => {
    if (!e || typeof e !== 'object') return e;
    const jpeg = e.snapshotJpeg;
    if (jpeg && e.id) persistEventJpeg(e.id, jpeg);
    const { snapshotJpeg, ...rest } = e;
    return {
      ...rest,
      hasSnapshot: Boolean(rest.hasSnapshot) || Boolean(jpeg) || eventHasPhoto(rest),
    };
  });
}

function migrateEmbeddedJpegs(models) {
  if (snapMigrated || !models || typeof models !== 'object') return false;
  snapMigrated = true;
  let moved = 0;
  let strippedTracks = 0;
  for (const state of Object.values(models)) {
    const events = state?.recentEvents;
    if (Array.isArray(events)) {
      for (const e of events) {
        if (e?.snapshotJpeg && e.id) {
          if (persistEventJpeg(e.id, e.snapshotJpeg)) moved += 1;
        }
      }
      state.recentEvents = stripEventsForDisk(events);
    }
    if (state?._trackPresence) {
      const before = JSON.stringify(state._trackPresence).length;
      state._trackPresence = sanitizeTrackPresence(state._trackPresence);
      const after = JSON.stringify(state._trackPresence).length;
      if (before > after + 1000) strippedTracks += 1;
    }
  }
  if (moved > 0) {
    console.log(`[detection-store] migrated ${moved} event photos to ${SNAP_DIR}`);
  }
  if (strippedTracks > 0) {
    console.log('[detection-store] stripped track JPEGs from persisted state');
  }
  return moved > 0 || strippedTracks > 0;
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    try {
      flushStoreToDisk();
    } catch (err) {
      console.warn('[detection-store] flush failed:', err.message);
    }
  }, 400);
}

function sanitizeTrackPresence(tp) {
  if (!tp || typeof tp !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(tp)) {
    if (!v || typeof v !== 'object') continue;
    const { lastJpeg, ...rest } = v;
    if (lastJpeg && typeof lastJpeg === 'string' && lastJpeg.length >= 64) {
      trackLastJpegs.set(String(k), normalizeJpegBase64(lastJpeg) || lastJpeg);
    }
    out[k] = rest;
  }
  return out;
}

function flushStoreToDisk() {
  if (!modelsCache) return;
  ensureStore();
  const toWrite = {};
  for (const [slug, state] of Object.entries(modelsCache)) {
    const cleaned = {
      ...state,
      recentEvents: stripEventsForDisk(state.recentEvents || []),
      _trackPresence: sanitizeTrackPresence(state._trackPresence),
    };
    toWrite[slug] = cleaned;
    modelsCache[slug] = cleaned;
  }
  fs.writeFileSync(STORE_PATH, JSON.stringify({ models: toWrite }));
}

function defaultModelState(slug) {
  const tab = detectionConfig.getTab(slug);
  const alerts = {};
  (tab?.alertOptions || []).forEach((a) => {
    alerts[a.id] = a.defaultEnabled ?? false;
  });
  const base = {
    inferenceRunning: false,
    // `activeCameraId` is only the camera selected in the UI.  Runtime
    // ownership is kept separately so selecting another camera never stops
    // an already-running worker.
    runningCameraIds: [],
    backendCameraIds: {},
    streamModes: {},
    confidence: 0.7,
    fpsRate: 15,
    resolution: '1920x1080',
    assignedCameraIds: [],
    zones: [],
    alerts,
  };

  if (slug === 'person') {
    return {
      ...base,
      confidence: 0.32,
      features: {
        detectPeople: true,
        countPeople: true,
        boundingBoxes: true,
        trackMovement: false,
        peopleCountLogs: true,
        personPresence: true,
        filterSmallObjects: false,
      },
      minObjectSizePx: 48,
      maxPeopleAlert: 10,
      activeCameraId: null,
      backendCameraId: null,
      streamMode: null,
      _peakToday: 0,
      _prevPeopleCountByCamera: {},
      _liveMetricsByCamera: {},
      recentEvents: [],
      _lastEventKey: null,
    };
  }

  if (slug === 'face') {
    return {
      ...base,
      confidence: 0.45,
      matchThreshold: 0.48,
      fpsRate: 10,
      features: {
        faceDetection: true,
        faceRecognition: true,
        genderClassification: false,
        boundingBoxes: true,
        showMatchLabels: true,
        unknownFaceAlerts: true,
      },
      activeCameraId: null,
      backendCameraId: null,
      streamMode: null,
      recentEvents: [],
      _lastEventKey: null,
      _liveMetrics: { facesNow: 0, knownNow: 0, unknownNow: 0 },
      _liveMetricsByCamera: {},
      _recognitionsToday: 0,
    };
  }

  return base;
}

function normalizeRuntimeState(state = {}) {
  const activeCameraId = state.activeCameraId || null;
  const hadExplicitRunningList = Array.isArray(state.runningCameraIds);
  const runningCameraIds = [...new Set(
    (hadExplicitRunningList
      ? state.runningCameraIds
      : (state.inferenceRunning && activeCameraId ? [activeCameraId] : []))
      .map((id) => String(id || '').trim())
      .filter(Boolean),
  )];

  const backendCameraIds = state.backendCameraIds
    && typeof state.backendCameraIds === 'object'
    && !Array.isArray(state.backendCameraIds)
    ? { ...state.backendCameraIds }
    : {};
  const streamModes = state.streamModes
    && typeof state.streamModes === 'object'
    && !Array.isArray(state.streamModes)
    ? { ...state.streamModes }
    : {};

  // One-time migration from the former single-camera fields.
  if (activeCameraId && state.backendCameraId && !backendCameraIds[activeCameraId]) {
    backendCameraIds[activeCameraId] = state.backendCameraId;
  }
  if (activeCameraId && state.streamMode && !streamModes[activeCameraId]) {
    streamModes[activeCameraId] = state.streamMode;
  }

  return {
    activeCameraId,
    runningCameraIds,
    backendCameraIds,
    streamModes,
    inferenceRunning: runningCameraIds.length > 0,
    // Keep these aliases for older frontend code. They now describe the
    // selected camera only, never the whole model runtime.
    backendCameraId: activeCameraId
      ? (backendCameraIds[activeCameraId] || state.backendCameraId || null)
      : (state.backendCameraId || null),
    streamMode: activeCameraId
      ? (streamModes[activeCameraId] || state.streamMode || null)
      : (state.streamMode || null),
  };
}

function normalizePersonState(state) {
  const defaults = defaultModelState('person');
  const tab = detectionConfig.getTab('person');
  const validAlertIds = new Set((tab?.alertOptions || []).map((a) => a.id));
  const mergedAlerts = { ...defaults.alerts, ...(state.alerts || {}) };
  const alerts = {};
  for (const id of validAlertIds) {
    alerts[id] = mergedAlerts[id] ?? defaults.alerts[id] ?? false;
  }
  return {
    ...defaults,
    ...state,
    ...normalizeRuntimeState(state),
    features: { ...defaults.features, ...(state.features || {}) },
    alerts,
    zones: Array.isArray(state.zones) ? sanitizeZones(state.zones) : defaults.zones,
  };
}

function sanitizeZones(zones) {
  if (!Array.isArray(zones)) return [];
  return zones
    .map((z) => {
      if (!z || typeof z !== 'object') return null;
      const points = Array.isArray(z.points)
        ? z.points
            .filter((p) => Array.isArray(p) && p.length >= 2)
            .map((p) => [
              Math.max(0, Math.min(1, Number(p[0]))),
              Math.max(0, Math.min(1, Number(p[1]))),
            ])
            .filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))
        : [];
      return {
        id: z.id || randomUUID(),
        name: String(z.name || 'Danger zone').slice(0, 80),
        enabled: z.enabled !== false,
        cameraId: z.cameraId || null,
        points,
      };
    })
    .filter(Boolean);
}

function pointInPolygon(x, y, points) {
  if (!Array.isArray(points) || points.length < 3) return false;
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = points[i][0];
    const yi = points[i][1];
    const xj = points[j][0];
    const yj = points[j][1];
    const denom = (yj - yi) || 1e-12;
    const intersect = ((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / denom + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function detectionCenter(det) {
  const box = det?.box;
  if (!Array.isArray(box) || box.length < 4) return null;
  return [(Number(box[0]) + Number(box[2])) / 2, (Number(box[1]) + Number(box[3])) / 2];
}

function getActiveDangerZones(state, cameraId) {
  return (state.zones || []).filter(
    (z) =>
      z.enabled !== false
      && Array.isArray(z.points)
      && z.points.length >= 3
      && (!z.cameraId || !cameraId || z.cameraId === cameraId),
  );
}

function findZoneContaining(center, zones) {
  if (!center) return null;
  return zones.find((z) => pointInPolygon(center[0], center[1], z.points)) || null;
}

function readStore() {
  if (modelsCache) return modelsCache;
  ensureStore();
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    modelsCache = raw.models && typeof raw.models === 'object' ? raw.models : {};
    if (migrateEmbeddedJpegs(modelsCache)) {
      // Shrink the 30MB+ JSON immediately after migrating photos out.
      flushStoreToDisk();
    }
    return modelsCache;
  } catch {
    modelsCache = {};
    return modelsCache;
  }
}

function writeStore(models) {
  modelsCache = models && typeof models === 'object' ? models : {};
  scheduleFlush();
}

function normalizeFaceState(state) {
  const defaults = defaultModelState('face');
  const tab = detectionConfig.getTab('face');
  const validAlertIds = new Set((tab?.alertOptions || []).map((a) => a.id));
  const mergedAlerts = { ...defaults.alerts, ...(state.alerts || {}) };
  const alerts = {};
  for (const id of validAlertIds) {
    alerts[id] = mergedAlerts[id] ?? defaults.alerts[id] ?? false;
  }
  return {
    ...defaults,
    ...state,
    ...normalizeRuntimeState(state),
    matchThreshold: state.matchThreshold ?? defaults.matchThreshold ?? 0.48,
    features: { ...defaults.features, ...(state.features || {}) },
    alerts,
    zones: Array.isArray(state.zones) ? sanitizeZones(state.zones) : defaults.zones,
    recentEvents: Array.isArray(state.recentEvents)
      ? state.recentEvents.map(repairFaceEvent)
      : [],
  };
}

function getModelState(slug) {
  const models = readStore();
  if (!models[slug]) {
    models[slug] = defaultModelState(slug);
    writeStore(models);
  }
  const state = { ...models[slug] };
  if (slug === 'person') return normalizePersonState(state);
  if (slug === 'face') return normalizeFaceState(state);
  return state;
}

function saveModelState(slug, patch) {
  const models = readStore();
  const current = models[slug] || defaultModelState(slug);
  let next = { ...current, ...patch };
  if (Array.isArray(next.recentEvents)) {
    next = { ...next, recentEvents: stripEventsForDisk(next.recentEvents) };
  }
  if (next._trackPresence) {
    next = { ...next, _trackPresence: sanitizeTrackPresence(next._trackPresence) };
  }
  models[slug] = next;
  writeStore(models);
  return models[slug];
}

function generateEvents() {
  return [];
}

function generateLogs(slug, running, state = {}) {
  const tab = detectionConfig.getTab(slug);
  const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
  const lines = [
    `[${stamp()}] Model ${tab.modelName} ${running ? 'inference active' : 'inference stopped'}`,
    `[${stamp()}] Pipeline loaded — ${tab.modelVersion}`,
    `[${stamp()}] Assigned cameras synced`,
    `[${stamp()}] Zone configuration validated`,
    `[${stamp()}] Alert rules applied`,
  ];
  if (running) {
    lines.unshift(`[${stamp()}] Frame batch processed — ${12 + Math.floor(Math.random() * 8)} detections`);
  }
  if (slug === 'person' && state.features?.peopleCountLogs && running) {
    const count = 1 + Math.floor(Math.random() * 6);
    lines.unshift(`[${stamp()}] People count log — ${count} person${count === 1 ? '' : 's'} (aggregate)`);
    lines.splice(1, 0, `[${stamp()}] Count exported to activity log buffer`);
  }
  return lines;
}

function buildPersonMetrics(state) {
  const running = state.activeCameraId
    ? state.runningCameraIds.includes(state.activeCameraId)
    : state.inferenceRunning;
  const fromLive = state._liveMetricsByCamera?.[state.activeCameraId] || state._liveMetrics;
  if (fromLive) {
    return {
      current: fromLive.current ?? 0,
      peakToday: Math.max(fromLive.current ?? 0, state._peakToday ?? 0),
      presenceActive: Boolean(running && state.features?.personPresence && (fromLive.current ?? 0) > 0),
      logsEnabled: Boolean(state.features?.peopleCountLogs),
      fps: fromLive.fps ?? null,
      inferenceMs: fromLive.inferenceMs ?? null,
    };
  }
  const base = running ? 0 : 0;
  return {
    current: base,
    peakToday: state._peakToday || 0,
    presenceActive: false,
    logsEnabled: Boolean(state.features?.peopleCountLogs),
    fps: null,
    inferenceMs: null,
  };
}

const EVENT_COOLDOWN_MS = 2500;
const PRESENCE_COOLDOWN_MS = 8000;
/** Every visible bbox emits a Person Detected event about once per second. */
const PERSON_BBOX_EVENT_MS = 1000;
/** While a person stays inside a danger zone, emit about once per second. */
const DANGER_ZONE_EVENT_MS = 1000;
const TRACK_IOU_MATCH = 0.45;
const TRACK_STALE_MS = 2500;
const PERSON_EVENT_HISTORY = 200;

/** Serialize person event writes so poll + stream loop never race and drop bboxes. */
let personRecordQueue = Promise.resolve();

function enqueuePersonRecord(fn) {
  const run = personRecordQueue.then(fn, fn);
  personRecordQueue = run.catch((err) => {
    console.warn('[detection-store] person record:', err?.message || err);
  });
  return run;
}

function getCooldowns(state) {
  return state._eventCooldowns || {};
}

function markCooldown(state, key) {
  const cooldowns = { ...getCooldowns(state), [key]: Date.now() };
  saveModelState('person', { _eventCooldowns: cooldowns });
  return cooldowns;
}

function canEmit(state, key, ms = EVENT_COOLDOWN_MS, cooldownMap = null) {
  const map = cooldownMap || (getModelState('person')._eventCooldowns || {});
  const last = map[key] || 0;
  return Date.now() - last >= ms;
}

function touchCooldown(cooldownMap, key) {
  cooldownMap[key] = Date.now();
}

function isValidBBox(box) {
  if (!Array.isArray(box) || box.length < 4) return false;
  const [x1, y1, x2, y2] = box.map(Number);
  if (![x1, y1, x2, y2].every((v) => Number.isFinite(v))) return false;
  const w = x2 - x1;
  const h = y2 - y1;
  if (w <= 0.002 || h <= 0.002) return false;
  if (x1 < -0.05 || y1 < -0.05 || x2 > 1.05 || y2 > 1.05) return false;
  return true;
}

function boxIou(a, b) {
  if (!a || !b || a.length < 4 || b.length < 4) return 0;
  const ax1 = Math.min(a[0], a[2]);
  const ay1 = Math.min(a[1], a[3]);
  const ax2 = Math.max(a[0], a[2]);
  const ay2 = Math.max(a[1], a[3]);
  const bx1 = Math.min(b[0], b[2]);
  const by1 = Math.min(b[1], b[3]);
  const bx2 = Math.max(b[0], b[2]);
  const by2 = Math.max(b[1], b[3]);
  const ix1 = Math.max(ax1, bx1);
  const iy1 = Math.max(ay1, by1);
  const ix2 = Math.min(ax2, bx2);
  const iy2 = Math.min(ay2, by2);
  const iw = Math.max(0, ix2 - ix1);
  const ih = Math.max(0, iy2 - iy1);
  const inter = iw * ih;
  if (inter <= 0) return 0;
  const areaA = Math.max(0, ax2 - ax1) * Math.max(0, ay2 - ay1);
  const areaB = Math.max(0, bx2 - bx1) * Math.max(0, by2 - by1);
  const union = areaA + areaB - inter;
  return union > 0 ? inter / union : 0;
}

function spatialTrackKey(box, prefix = 't') {
  if (!box || box.length < 4) return null;
  const cx = (Number(box[0]) + Number(box[2])) / 2;
  const cy = (Number(box[1]) + Number(box[3])) / 2;
  if (![cx, cy].every((v) => Number.isFinite(v))) return null;
  return `${prefix}-${Math.floor(cx / 0.08)}-${Math.floor(cy / 0.08)}`;
}

/**
 * Assign stable track IDs across frames via IoU.
 * STRICT: every detection in the same frame gets a unique track_id — never merge
 * two live bboxes into one ID (that was dropping Person Detected events).
 */
function ensurePersonTrackIds(detections, trackPresence = {}) {
  const now = Date.now();
  const livePrev = Object.entries(trackPresence)
    .filter(([, info]) => info?.present && info?.box && (now - (info.lastSeen || 0)) < TRACK_STALE_MS)
    .map(([tid, info]) => ({ tid, box: info.box, score: info.score || 0 }));

  const list = (Array.isArray(detections) ? detections : [])
    .map((d, index) => ({ d, index, box: d?.box, score: d?.score ?? 0 }))
    .filter((item) => Array.isArray(item.box) && item.box.length >= 4);

  const usedPrev = new Set();
  const assigned = new Map(); // index -> tid

  // Greedy best-IoU matching so nearby people don't steal each other's tracks.
  const pairs = [];
  for (const item of list) {
    for (const prev of livePrev) {
      const iou = boxIou(item.box, prev.box);
      if (iou >= TRACK_IOU_MATCH) pairs.push({ index: item.index, tid: prev.tid, iou });
    }
  }
  pairs.sort((a, b) => b.iou - a.iou);
  for (const pair of pairs) {
    if (assigned.has(pair.index) || usedPrev.has(pair.tid)) continue;
    assigned.set(pair.index, pair.tid);
    usedPrev.add(pair.tid);
  }

  let autoSeq = 0;
  const usedTids = new Set([...assigned.values()]);

  return (Array.isArray(detections) ? detections : []).map((d, index) => {
    if (assigned.has(index)) {
      return { ...d, track_id: assigned.get(index) };
    }

    const existing = d.track_id ?? d.trackId ?? d.id;
    let tid = existing != null && existing !== '' ? String(existing) : null;
    if (tid && usedTids.has(tid)) tid = null;
    if (!tid) {
      tid = `p-${Date.now().toString(36)}-${autoSeq++}-${index}`;
    }
    // Final uniqueness guard within this frame.
    while (usedTids.has(tid)) {
      tid = `p-${Date.now().toString(36)}-${autoSeq++}-${index}`;
    }
    usedTids.add(tid);
    return { ...d, track_id: tid };
  });
}

function passesMinSize(box, state) {
  if (!isValidBBox(box)) return false;
  const minPx = state.minObjectSizePx ?? 48;
  const frameW = 640;
  const frameH = 360;
  const bw = (box[2] - box[0]) * frameW;
  const bh = (box[3] - box[1]) * frameH;
  return bw >= minPx && bh >= minPx;
}

function resolvePersonEventJpeg(detection, snapshotJpeg) {
  // Prefer full-frame snapshot so each person event can be cropped to its own bbox.
  if (snapshotJpeg && typeof snapshotJpeg === 'string' && snapshotJpeg.length >= 64) {
    return snapshotJpeg;
  }
  if (detection?.event_jpeg && typeof detection.event_jpeg === 'string' && detection.event_jpeg.length >= 64) {
    return detection.event_jpeg;
  }
  // Last resort: per-detection crop from board (already tight).
  if (detection?.crop_jpeg && typeof detection.crop_jpeg === 'string' && detection.crop_jpeg.length >= 64) {
    return detection.crop_jpeg;
  }
  return null;
}

function boxIntersectsZone(box, points) {
  if (!Array.isArray(box) || box.length < 4 || !Array.isArray(points) || points.length < 3) return false;
  const x1 = Math.min(Number(box[0]), Number(box[2]));
  const y1 = Math.min(Number(box[1]), Number(box[3]));
  const x2 = Math.max(Number(box[0]), Number(box[2]));
  const y2 = Math.max(Number(box[1]), Number(box[3]));
  if (![x1, y1, x2, y2].every((v) => Number.isFinite(v))) return false;
  // Body center inside zone = danger. Also accept upper-torso (35%) so seated
  // people still count when the zone covers the desk / upper body only.
  // Edge-only corner clips do not count.
  const cx = (x1 + x2) / 2;
  const cy = (y1 + y2) / 2;
  if (pointInPolygon(cx, cy, points)) return true;
  const torsoY = y1 + (y2 - y1) * 0.35;
  return pointInPolygon(cx, torsoY, points);
}

function findZoneHittingBox(box, zones) {
  if (!box) return null;
  return zones.find((z) => boxIntersectsZone(box, z.points)) || null;
}

function slimEventForClient(event) {
  if (!event || typeof event !== 'object') return event;
  // Keep gallery payloads light — photos load via /snapshot (fast + cached).
  const { snapshotJpeg, ...rest } = event;
  return rest;
}

function validateEventDetection(detection, state, snapshotJpeg) {
  const confThreshold = state.confidence ?? 0.32;
  const score = detection?.score ?? 0;
  if (score < confThreshold) return false;
  if (!isValidBBox(detection?.box)) return false;
  if (state.features?.filterSmallObjects && !passesMinSize(detection.box, state)) return false;
  // Prefer a snapshot, but never drop a valid on-screen bbox solely for missing JPEG.
  const jpeg = resolvePersonEventJpeg(detection, snapshotJpeg);
  if (jpeg && typeof jpeg === 'string' && jpeg.length >= 64) return true;
  return true;
}

function eventQualityScore(detection) {
  const score = detection?.score ?? 0;
  const box = detection?.box || [];
  const area = Math.max(0, (box[2] - box[0]) * (box[3] - box[1]));
  return score * 0.75 + Math.min(area * 4, 0.25);
}

function getTrackState(state) {
  return state._trackPresence || {};
}

function saveTrackState(state, trackPresence, prevCount) {
  saveModelState('person', {
    _trackPresence: trackPresence,
    _prevPeopleCount: prevCount,
  });
}

async function makePersonEvent({ title, eventType, camera, severity, confidence, jpeg, detections, trackingId, detection, box, zoneName }) {
  const at = new Date();
  const id = `evt-person-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const resolvedType = eventType || title;
  let outJpeg = jpeg || null;
  const sourceBox = (detection?.box && detection.box.length >= 4)
    ? detection.box
    : (Array.isArray(box) && box.length >= 4 ? box : null);

  // Already a board-side person crop — keep as cropped photo.
  let snapshotCropped = Boolean(
    detection?.crop_jpeg
    && outJpeg
    && outJpeg === detection.crop_jpeg,
  );
  let bbox = !snapshotCropped && sourceBox ? sourceBox : null;

  // Tight crop to THIS person's bbox only (+ small pad). One bbox → one clear HD event photo.
  if (outJpeg && sourceBox && !snapshotCropped) {
    try {
      const { cropJpegToBbox } = require('./jpeg-crop');
      const cropped = await cropJpegToBbox(outJpeg, sourceBox, {
        pad: 0.08,
        drawBox: false,
        quality: 95,
        minLongSide: 960,
      });
      if (cropped && cropped.length >= 64) {
        outJpeg = cropped;
        snapshotCropped = true;
        bbox = null;
      }
    } catch (err) {
      console.warn('[detection-store] person crop failed:', err.message);
    }
  }

  if (outJpeg) {
    persistEventJpeg(id, outJpeg);
  }

  const evt = {
    id,
    eventType: resolvedType,
    title,
    label: 'person',
    camera: camera?.name || 'Unknown camera',
    cameraId: camera?.id || null,
    location: camera?.location || 'Unknown location',
    zone: zoneName || camera?.group || camera?.zoneFloor || '—',
    department: camera?.department || null,
    severity: severity || 'info',
    confidence: confidence ?? 0.8,
    peopleCount: Array.isArray(detections) ? detections.length : null,
    trackingId: trackingId || null,
    bbox,
    box: bbox,
    sourceBbox: sourceBox || null,
    snapshotAnnotated: false,
    snapshotCropped,
    snapshotFullFrame: !snapshotCropped,
    // Photos live in memory + data/event-snaps — never bloat JSON / API payloads.
    snapshotJpeg: null,
    time: at.toISOString(),
    timeLabel: at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    dateLabel: at.toLocaleDateString([], { month: 'short', day: 'numeric' }),
    imageUrl: `/api/detection/events/${encodeURIComponent(id)}/snapshot`,
    hasSnapshot: Boolean(outJpeg),
  };

  return evt;
}

async function recordPersonDetection(camera, detections, statePatch = {}, snapshotJpeg = null) {
  return enqueuePersonRecord(() => recordPersonDetectionUnlocked(camera, detections, statePatch, snapshotJpeg));
}

async function recordPersonDetectionUnlocked(camera, detections, statePatch = {}, snapshotJpeg = null) {
  // Always read fresh track/event state — never trust a stale statePatch snapshot
  // from a concurrent poll/stream tick (that was dropping bbox events).
  const fresh = getModelState('person');
  const safePatch = { ...(statePatch || {}) };
  delete safePatch._trackPresence;
  delete safePatch._prevPeopleCount;
  delete safePatch._eventCooldowns;
  delete safePatch.recentEvents;
  const state = { ...fresh, ...safePatch, alerts: { ...fresh.alerts, ...(safePatch.alerts || {}) } };
  const alerts = state.alerts || {};
  const trackPresence = { ...getTrackState(fresh) };
  const cooldownMap = { ...(fresh._eventCooldowns || {}) };
  const cameraKey = String(camera?.id || camera?.name || 'camera');
  const cameraTrackPrefix = `${cameraKey}:`;
  const ownTrackPresence = Object.fromEntries(
    Object.entries(trackPresence).filter(([trackId]) => trackId.startsWith(cameraTrackPrefix)),
  );
  const tracked = ensurePersonTrackIds(detections, ownTrackPresence).map((detection, index) => {
    const rawId = String(detection?.track_id ?? detection?.trackId ?? `person-${index}`);
    return {
      ...detection,
      track_id: rawId.startsWith(cameraTrackPrefix) ? rawId : `${cameraTrackPrefix}${rawId}`,
    };
  });
  const count = tracked.length;
  const topScore = count > 0 ? Math.max(...tracked.map((d) => d.score ?? 0)) : 0;
  const events = Array.isArray(fresh.recentEvents) ? [...fresh.recentEvents] : [];
  const toAdd = [];
  const activeTracks = new Set();

  // STRICT: every on-screen bbox → its own Person Detected event, about once per second.
  const wantDetected = alerts['person-detected'] !== false;

  for (const d of tracked) {
    const tid = d.track_id ?? d.id;
    if (tid == null) continue;
    const tidKey = String(tid);
    activeTracks.add(tidKey);
    const prev = trackPresence[tidKey] || {};
    const wasPresent = Boolean(prev.present);
    const personJpeg = resolvePersonEventJpeg(d, snapshotJpeg);
    const valid = validateEventDetection(d, state, snapshotJpeg);
    if (personJpeg) trackLastJpegs.set(tidKey, normalizeJpegBase64(personJpeg) || personJpeg);

    trackPresence[tidKey] = {
      present: true,
      lastSeen: Date.now(),
      score: d.score,
      box: Array.isArray(d.box) ? d.box.slice(0, 4) : null,
      inZone: Boolean(prev.inZone),
    };

    if (wantDetected && valid && personJpeg
        && canEmit(state, `person-detected:${tidKey}`, PERSON_BBOX_EVENT_MS, cooldownMap)) {
      toAdd.push(await makePersonEvent({
        title: 'Person Detected',
        camera,
        severity: 'warning',
        confidence: d.score ?? topScore,
        jpeg: personJpeg,
        detections: [d],
        trackingId: tidKey,
        detection: d,
      }));
      touchCooldown(cooldownMap, `person-detected:${tidKey}`);
    }

    if (!wasPresent && state.features?.personPresence && valid && personJpeg
        && canEmit(state, `presence:${tidKey}`, PRESENCE_COOLDOWN_MS, cooldownMap)) {
      toAdd.push(await makePersonEvent({
        title: 'Presence Detected',
        camera,
        severity: 'success',
        confidence: d.score ?? topScore,
        jpeg: personJpeg,
        detections: [d],
        trackingId: tidKey,
        detection: d,
      }));
      touchCooldown(cooldownMap, `presence:${tidKey}`);
    }
  }

  for (const [tid, info] of Object.entries(trackPresence)) {
    if (!tid.startsWith(cameraTrackPrefix)) continue;
    if (activeTracks.has(tid)) continue;
    if (!info.present) continue;
    // Require a short absence before "left" so brief frame drops don't drop tracks.
    const absentFor = Date.now() - (info.lastSeen || 0);
    if (absentFor < TRACK_STALE_MS) continue;
    trackPresence[tid] = {
      ...info,
      present: false,
      inZone: false,
    };
    const leftDetection = info.box ? { box: info.box, score: info.score } : null;
    const leftJpeg = trackLastJpegs.get(tid) || info.lastJpeg || snapshotJpeg;
    trackLastJpegs.delete(tid);
    if (leftJpeg && canEmit(state, `person-left:${tid}`, EVENT_COOLDOWN_MS, cooldownMap)) {
      toAdd.push(await makePersonEvent({
        title: 'Person Left',
        camera,
        severity: 'info',
        confidence: info.score ?? 0,
        jpeg: leftJpeg,
        detections: [],
        trackingId: tid,
        detection: leftDetection,
        box: info.box || null,
      }));
      touchCooldown(cooldownMap, `person-left:${tid}`);
    }
    if (leftJpeg && state.features?.personPresence && canEmit(state, `presence-lost:${tid}`, PRESENCE_COOLDOWN_MS, cooldownMap)) {
      toAdd.push(await makePersonEvent({
        title: 'Presence Lost',
        camera,
        severity: 'info',
        confidence: info.score ?? 0,
        jpeg: leftJpeg,
        detections: [],
        trackingId: tid,
        detection: leftDetection,
        box: info.box || null,
      }));
      touchCooldown(cooldownMap, `presence-lost:${tid}`);
    }
  }

  const prevPeopleCountByCamera = { ...(fresh._prevPeopleCountByCamera || {}) };
  const prevCount = prevPeopleCountByCamera[cameraKey] ?? 0;
  if (alerts['person-not-detected'] && count === 0 && prevCount > 0 && state.inferenceRunning
      && canEmit(state, `person-not-detected:${cameraKey}`, PRESENCE_COOLDOWN_MS, cooldownMap)) {
    toAdd.push(await makePersonEvent({
      title: 'Person Not Detected',
      camera,
      severity: 'info',
      confidence: 0,
      jpeg: snapshotJpeg,
      detections: [],
    }));
    touchCooldown(cooldownMap, `person-not-detected:${cameraKey}`);
  }

  if (alerts['too-many-people'] && count > (state.maxPeopleAlert ?? 10)
      && canEmit(state, `too-many-people:${cameraKey}`, PRESENCE_COOLDOWN_MS, cooldownMap)) {
    const topDet = tracked.reduce((a, b) => ((b.score ?? 0) > (a.score ?? 0) ? b : a), tracked[0]);
    if (validateEventDetection(topDet, state, snapshotJpeg)) {
      toAdd.push(await makePersonEvent({
        title: 'Too Many People',
        camera,
        severity: 'critical',
        confidence: topScore,
        jpeg: snapshotJpeg,
        detections: tracked,
        trackingId: topDet?.track_id ?? null,
        detection: topDet || null,
      }));
      touchCooldown(cooldownMap, `too-many-people:${cameraKey}`);
    }
  }

  // Danger zone: person body center + lower body must be inside polygon (strict).
  if (alerts['person-restricted-area']) {
    const dangerZones = getActiveDangerZones(state, camera?.id);
    if (dangerZones.length) {
      const dangerMinScore = Number(state.confidence) || 0.32;
      for (const d of tracked) {
        const tid = d.track_id ?? d.id;
        if (tid == null) continue;
        const tidKey = String(tid);
        const box = Array.isArray(d.box) ? d.box : null;
        const hitZone = findZoneHittingBox(box, dangerZones);
        const inZone = Boolean(hitZone);
        if (trackPresence[tidKey]) trackPresence[tidKey].inZone = inZone;
        if (!inZone) continue;
        if ((d.score ?? 0) < dangerMinScore) continue;
        if (!validateEventDetection(d, state, snapshotJpeg)) continue;
        const personJpeg = resolvePersonEventJpeg(d, snapshotJpeg);
        // No photo → skip (never create black Danger Zone cards).
        if (!personJpeg) continue;
        if (!canEmit(state, `danger-zone:${tidKey}`, DANGER_ZONE_EVENT_MS, cooldownMap)) continue;
        const zoneName = hitZone?.name || 'Danger zone';
        const evt = await makePersonEvent({
          title: 'Danger Zone',
          eventType: 'person-restricted-area',
          camera,
          severity: 'critical',
          confidence: d.score ?? topScore,
          jpeg: personJpeg,
          detections: [d],
          trackingId: tidKey,
          detection: d,
          zoneName,
        });
        toAdd.push(evt);
        touchCooldown(cooldownMap, `danger-zone:${tidKey}`);

        // Email when Alert Configuration has "Danger zone (person)" enabled.
        try {
          const alertNotify = require('./alert-notify');
          Promise.resolve(alertNotify.dispatchAlert({
            type: 'person-restricted-area',
            title: 'Danger Zone Alert',
            message: `A person was detected inside danger zone "${zoneName}" on camera ${camera?.name || 'Unknown'}.`,
            severity: 'critical',
            cameraId: camera?.id || null,
            cameraName: camera?.name || 'Unknown camera',
            location: camera?.location || '—',
            zoneName,
            zone: zoneName,
            confidence: d.score ?? topScore,
            trackingId: tidKey,
            snapshotJpeg: personJpeg,
            snapshotEventId: evt.id,
            createdAt: evt.time || new Date().toISOString(),
          })).catch((err) => {
            console.warn('[detection-store] danger-zone email:', err.message);
          });
        } catch (err) {
          console.warn('[detection-store] danger-zone notify:', err.message);
        }
      }
    }
  }

  prevPeopleCountByCamera[cameraKey] = count;
  const liveMetric = {
    current: count,
    fps: statePatch?.fps ?? fresh._liveMetricsByCamera?.[cameraKey]?.fps ?? null,
    inferenceMs: statePatch?.inferenceMs ?? fresh._liveMetricsByCamera?.[cameraKey]?.inferenceMs ?? null,
  };
  const liveMetricsByCamera = {
    ...(fresh._liveMetricsByCamera || {}),
    [cameraKey]: liveMetric,
  };
  saveModelState('person', {
    _trackPresence: trackPresence,
    _prevPeopleCount: count,
    _prevPeopleCountByCamera: prevPeopleCountByCamera,
    _liveMetricsByCamera: liveMetricsByCamera,
    _liveMetrics: state.activeCameraId === cameraKey ? liveMetric : fresh._liveMetrics,
    _peakToday: Math.max(fresh._peakToday || 0, count),
    _eventCooldowns: cooldownMap,
  });

  if (!toAdd.length) return { events: events.slice(0, PERSON_EVENT_HISTORY), newEvents: [] };

  const merged = [...toAdd, ...events]
    .sort((a, b) => new Date(b.time || 0).getTime() - new Date(a.time || 0).getTime())
    .slice(0, PERSON_EVENT_HISTORY);
  // Drop orphaned snap files for events that fell out of history.
  const keepIds = new Set(merged.map((e) => String(e.id)));
  for (const old of events) {
    const oid = String(old?.id || '');
    if (oid && !keepIds.has(oid)) deleteEventJpeg(oid);
  }
  saveModelState('person', { recentEvents: merged });
  return { events: merged, newEvents: toAdd };
}

function getEventsForSlug(slug, state) {
  if (Array.isArray(state.recentEvents) && state.recentEvents.length) {
    // Face events persist until camera delete; person keeps its history cap.
    const limit = slug === 'person'
      ? PERSON_EVENT_HISTORY
      : slug === 'face'
        ? Number.MAX_SAFE_INTEGER
        : 50;
    const list = state.recentEvents
      // Only show events that actually have a photo (no black placeholders).
      .filter((e) => eventHasPhoto(e))
      .slice(0, limit)
      .sort((a, b) => new Date(b.time || 0).getTime() - new Date(a.time || 0).getTime())
      .map(slimEventForClient);
    if (slug === 'face') {
      return list.map(repairFaceEvent);
    }
    return list;
  }
  return [];
}

function buildReport(slug, state) {
  const events = getEventsForSlug(slug, state);
  const today = events.filter((e) => {
    const d = new Date(e.time);
    const n = new Date();
    return d.toDateString() === n.toDateString();
  });
  const report = {
    eventsToday: today.length,
    avgConfidence:
      events.length > 0
        ? Math.round((events.reduce((s, e) => s + e.confidence, 0) / events.length) * 100)
        : 0,
    activeCameras: state.assignedCameraIds.length,
    inferenceUptime: state.inferenceRunning ? '2h 14m' : '—',
  };
  if (slug === 'person') {
    const metrics = buildPersonMetrics(state);
    report.peopleNow = metrics.current;
    report.peakPeopleToday = metrics.peakToday;
  }
  if (slug === 'face') {
    const metrics = buildFaceMetrics(state);
    report.facesNow = metrics.facesNow;
    report.recognitionsToday = metrics.recognitionsToday;
  }
  return report;
}

function buildFaceMetrics(state) {
  const live = state._liveMetricsByCamera?.[state.activeCameraId] || state._liveMetrics || {};
  const selectedRunning = state.activeCameraId
    ? state.runningCameraIds.includes(state.activeCameraId)
    : state.inferenceRunning;
  return {
    facesNow: live.facesNow ?? 0,
    knownNow: live.knownNow ?? 0,
    unknownNow: live.unknownNow ?? 0,
    recognitionsToday: state._recognitionsToday ?? 0,
    inferenceRunning: Boolean(selectedRunning),
    fps: live.fps ?? null,
  };
}

const FACE_EVENT_COOLDOWN_MS = 3000;
const FACE_TRACK_STALE_MS = 2500;

/** Serialize face event writes so stream loop + poll never race and drop faces. */
let faceRecordQueue = Promise.resolve();
const faceTrackLastJpegs = new Map();

function enqueueFaceRecord(fn) {
  const run = faceRecordQueue.then(fn, fn);
  faceRecordQueue = run.catch((err) => {
    console.warn('[detection-store] face record:', err?.message || err);
  });
  return run;
}

const {
  resolveFaceMatchScore,
  resolveFaceDetectionScore,
  resolveFaceEventConfidence,
} = require('./face-confidence');

function normalizeFaceBox(box, frameW = 1920, frameH = 1080) {
  if (!Array.isArray(box) || box.length < 4) return null;
  const nums = box.map(Number);
  if (!nums.every((v) => Number.isFinite(v))) return null;

  const fw = Math.max(1, Number(frameW) || 1920);
  const fh = Math.max(1, Number(frameH) || 1080);

  // Already normalized xyxy
  if (nums.every((v) => v >= 0 && v <= 1.05) && nums[2] > nums[0] && nums[3] > nums[1]) {
    return nums.map((v) => Math.max(0, Math.min(1, v)));
  }

  const [a, b, c, d] = nums;
  // Pixel xyxy
  if (c > a && d > b && (c > 1 || d > 1)) {
    return [a / fw, b / fh, c / fw, d / fh];
  }
  // Pixel xywh
  return [a / fw, b / fh, (a + c) / fw, (b + d) / fh];
}

function faceHasLiveCrop(face) {
  const jpeg = face?.crop_jpeg;
  if (jpeg && typeof jpeg === 'string' && jpeg.replace(/^data:image\/\w+;base64,/, '').length >= 64) {
    return true;
  }
  return Boolean(face?.crop_filename);
}

function validateFaceEvent(face, state) {
  // Board face_worker already decided this is a face. Its raw `score` is often low
  // (~0.2) and must NOT reject events — previously Math.max(0.22) blocked crop/box fallbacks
  // and permanently marked the track "seen", so Face recognition events never appeared.
  const box = normalizeFaceBox(face?.box, face?.frame_w, face?.frame_h);
  const hasBox = Boolean(box && isValidBBox(box));
  const hasCrop = faceHasLiveCrop(face);
  if (hasBox || hasCrop) return true;

  const confThreshold = Math.min(0.35, Number(state.confidence) || 0.3);
  const isKnown = Boolean(face?.is_known && face?.match);
  const detection = resolveFaceDetectionScore(face);
  const match = resolveFaceMatchScore(face);
  const score = Math.max(detection || 0, match || 0) || (isKnown ? 0.72 : 0);
  return score >= confThreshold;
}

function canEmitFace(state, key, ms = FACE_EVENT_COOLDOWN_MS, cooldownMap = null) {
  const map = cooldownMap || (getModelState('face')._eventCooldowns || {});
  const last = map[key] || 0;
  return Date.now() - last >= ms;
}

function markFaceCooldown(state, key, cooldownMap = null) {
  if (cooldownMap) {
    cooldownMap[key] = Date.now();
    return cooldownMap;
  }
  const cooldowns = { ...(state._eventCooldowns || {}), [key]: Date.now() };
  saveModelState('face', { _eventCooldowns: cooldowns });
  return cooldowns;
}

function getFaceTrackState(state) {
  return state._faceTrackPresence || {};
}

function ensureFaceTrackIds(faces, trackPresence = {}) {
  const now = Date.now();
  const livePrev = Object.entries(trackPresence)
    .filter(([, info]) => info?.present && info?.box && (now - (info.lastSeen || 0)) < FACE_TRACK_STALE_MS)
    .map(([tid, info]) => ({ tid, box: info.box }));

  const used = new Set();
  let autoSeq = 0;

  return (Array.isArray(faces) ? faces : []).map((face, idx) => {
    const existing = face.track_id ?? face.trackId;
    if (existing != null && existing !== '') {
      return { ...face, track_id: String(existing) };
    }
    const box = normalizeFaceBox(face.box, face.frame_w, face.frame_h) || face.box;
    let bestTid = null;
    let bestIou = TRACK_IOU_MATCH;
    for (const prev of livePrev) {
      if (used.has(prev.tid)) continue;
      const iou = boxIou(box, prev.box);
      if (iou >= bestIou) {
        bestIou = iou;
        bestTid = prev.tid;
      }
    }
    if (bestTid) {
      used.add(bestTid);
      return { ...face, track_id: bestTid, box };
    }
    const spatial = spatialTrackKey(box, 'f');
    const tid = spatial || `f-auto-${Date.now()}-${autoSeq++}-${idx}`;
    used.add(tid);
    return { ...face, track_id: tid, box };
  });
}

function resolveFaceEventJpeg(face, snapshotJpeg = null) {
  const crop = face?.crop_jpeg;
  if (crop && typeof crop === 'string' && crop.replace(/^data:image\/\w+;base64,/, '').length >= 64) {
    return crop;
  }
  if (snapshotJpeg && typeof snapshotJpeg === 'string' && snapshotJpeg.length >= 64) {
    return snapshotJpeg;
  }
  return null;
}

function faceEventTitle(isKnown, matchedPerson, face) {
  if (isKnown) {
    const name = matchedPerson?.fullName || face?.match?.name || 'Known';
    return `Recognized: ${name}`;
  }
  return 'Face Detected';
}

function faceEventType(isKnown) {
  return isKnown ? 'known-face-recognized' : 'face-detected';
}

async function makeFaceEvent({ title, eventType, camera, severity, confidence, face, matchedPerson, snapshotJpeg, frameW, frameH }) {
  const at = new Date();
  const id = `evt-face-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  let jpeg = face?.crop_jpeg || snapshotJpeg || null;
  if (jpeg && typeof jpeg === 'string' && jpeg.startsWith('data:image')) {
    jpeg = jpeg.replace(/^data:image\/\w+;base64,/, '');
  }

  // Known face without live crop → use enrolled profile photo so the card isn't empty.
  if ((!jpeg || jpeg.length < 64) && matchedPerson?.id) {
    try {
      const faceStore = require('./face-store');
      const profile = faceStore.getProfileImageBase64?.(matchedPerson.id)
        || (typeof faceStore.getProfileImagePath === 'function' && faceStore.getProfileImagePath(matchedPerson.id)
          ? require('fs').readFileSync(faceStore.getProfileImagePath(matchedPerson.id)).toString('base64')
          : null);
      if (profile) {
        jpeg = String(profile).replace(/^data:image\/\w+;base64,/, '');
      }
    } catch {
      /* ignore */
    }
  }

  let isCropSnapshot = Boolean(face?.crop_jpeg || face?.crop_filename || (jpeg && matchedPerson));
  let bbox = (face?.crop_jpeg || face?.crop_filename)
    ? null
    : normalizeFaceBox(face?.box, frameW || face?.frame_w, frameH || face?.frame_h);
  const sourceBox = normalizeFaceBox(face?.box, frameW || face?.frame_w, frameH || face?.frame_h);

  // If we only have a full-frame snapshot, crop tightly to the face bbox.
  if (jpeg && sourceBox && !face?.crop_jpeg && !face?.crop_filename && !matchedPerson) {
    try {
      const { cropJpegToBbox } = require('./jpeg-crop');
      const cropped = await cropJpegToBbox(jpeg, sourceBox, { pad: 0.12, drawBox: false, quality: 95, minLongSide: 720 });
      if (cropped && cropped.length >= 64) {
        jpeg = cropped;
        isCropSnapshot = true;
        bbox = null;
      }
    } catch (err) {
      console.warn('[detection-store] face crop failed:', err.message);
    }
  }

  if (face?.crop_jpeg || face?.crop_filename) {
    isCropSnapshot = true;
    bbox = null;
  }

  const snapshotFullFrame = !isCropSnapshot && Boolean(jpeg);
  const isKnownFace = Boolean(face?.is_known || matchedPerson);
  const matchConfidence = resolveFaceMatchScore(face);
  const detectionConfidence = resolveFaceDetectionScore(face);
  const resolvedConfidence = (typeof confidence === 'number' && confidence > 0.01)
    ? confidence
    : resolveFaceEventConfidence(face, isKnownFace);
  const trackId = face?.track_id ?? face?.trackId ?? null;
  const hasJpeg = Boolean(jpeg && typeof jpeg === 'string' && jpeg.length >= 64);
  const lineCrossed = face?.crossed === true || face?.line_crossed === true || face?.lineCrossed === true;

  const evt = {
    id,
    eventType: eventType || title,
    title,
    label: 'face',
    camera: camera?.name || 'Unknown camera',
    cameraId: camera?.id || null,
    location: camera?.location || 'Unknown location',
    zone: camera?.group || camera?.zoneFloor || '—',
    department: camera?.department || null,
    severity: severity || 'info',
    confidence: resolvedConfidence,
    matchConfidence,
    detectionConfidence,
    personName: matchedPerson?.fullName || face?.match?.name || null,
    personId: matchedPerson?.id || face?.match?.person_id || null,
    groupId: matchedPerson?.groupId || null,
    isKnown: isKnownFace,
    gender: face?.gender || null,
    trackingId: trackId != null ? String(trackId) : null,
    lineCrossed,
    bbox: hasJpeg && isCropSnapshot ? null : bbox,
    box: hasJpeg && isCropSnapshot ? null : bbox,
    sourceBbox: sourceBox || null,
    snapshotFullFrame,
    snapshotCropped: isCropSnapshot && hasJpeg,
    snapshotJpeg: null,
    time: at.toISOString(),
    timeLabel: at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    dateLabel: at.toLocaleDateString([], { month: 'short', day: 'numeric' }),
    imageUrl: `/api/detection/events/${encodeURIComponent(id)}/snapshot`,
    hasSnapshot: hasJpeg,
  };

  if (hasJpeg) {
    persistEventJpeg(id, jpeg);
    if (eventSnapshots.size > 300) {
      const first = eventSnapshots.keys().next().value;
      eventSnapshots.delete(first);
    }
  }

  return evt;
}

/**
 * A Line crossed event must come from an actual worker/local crossing edge.
 * Older code mirrored every face event whenever a tripwire existed, which
 * produced false crossings and doubled the event volume.
 */
function appendLineCrossMirrors(events) {
  return Array.isArray(events) ? events : [];
}

async function recordFaceDetection(camera, faces, statePatch = {}, _snapshotJpeg = null) {
  return enqueueFaceRecord(() => recordFaceDetectionUnlocked(camera, faces, statePatch, _snapshotJpeg));
}

async function recordFaceDetectionUnlocked(camera, faces, statePatch = {}, _snapshotJpeg = null) {
  const faceStore = require('./face-store');
  // Always read fresh track/event state — never trust a stale statePatch from a concurrent tick.
  const fresh = getModelState('face');
  const safePatch = { ...(statePatch || {}) };
  delete safePatch._faceTrackPresence;
  delete safePatch._eventCooldowns;
  delete safePatch.recentEvents;
  delete safePatch._liveMetrics;
  delete safePatch._recognitionsToday;
  const state = {
    ...fresh,
    ...safePatch,
    alerts: { ...fresh.alerts, ...(safePatch.alerts || {}) },
    features: { ...fresh.features, ...(safePatch.features || {}) },
  };
  const alerts = state.alerts || {};
  const trackPresence = { ...getFaceTrackState(fresh) };
  const cooldownMap = { ...(fresh._eventCooldowns || {}) };
  const cameraKey = String(camera?.id || camera?.name || 'camera');
  const cameraTrackPrefix = `${cameraKey}:`;
  const ownTrackPresence = Object.fromEntries(
    Object.entries(trackPresence).filter(([trackId]) => trackId.startsWith(cameraTrackPrefix)),
  );
  const list = ensureFaceTrackIds(faces, ownTrackPresence).map((face, index) => {
    const rawId = String(face?.track_id ?? face?.trackId ?? `face-${index}`);
    return {
      ...face,
      track_id: rawId.startsWith(cameraTrackPrefix) ? rawId : `${cameraTrackPrefix}${rawId}`,
    };
  });
  const events = Array.isArray(fresh.recentEvents) ? [...fresh.recentEvents] : [];
  const toAdd = [];
  const frameW = list[0]?.frame_w || _snapshotJpeg?.frame_w || 1920;
  const frameH = list[0]?.frame_h || _snapshotJpeg?.frame_h || 1080;
  const activeTracks = new Set();

  const wantDetected = alerts['face-detected'] !== false;
  const wantKnown = alerts['known-face-recognized'] !== false;
  const wantUnknown = alerts['unknown-face-detected'] !== false;

  let knownNow = 0;
  let unknownNow = 0;

  for (const face of list) {
    const isKnown = Boolean(face.is_known && face.match);
    if (isKnown) knownNow += 1;
    else unknownNow += 1;

    const tidKey = String(
      face.track_id ?? face.trackId ?? spatialTrackKey(face.box, 'f') ?? `face-${knownNow + unknownNow}`,
    );
    activeTracks.add(tidKey);
    const prev = trackPresence[tidKey] || {};
    const wasPresent = Boolean(prev.present);
    const prevKnown = Boolean(prev.isKnown);
    const normBox = normalizeFaceBox(face.box, frameW, frameH) || face.box;

    const liveJpeg = resolveFaceEventJpeg(face, _snapshotJpeg);
    if (liveJpeg) {
      faceTrackLastJpegs.set(tidKey, normalizeJpegBase64(liveJpeg) || liveJpeg);
    }
    const faceSnapshot = liveJpeg || faceTrackLastJpegs.get(tidKey) || null;
    const hasPhoto = Boolean(
      faceSnapshot && String(faceSnapshot).replace(/^data:image\/\w+;base64,/, '').length >= 64,
    );

    const lineCrossedHint = face?.crossed === true
      || face?.line_crossed === true
      || face?.lineCrossed === true
      || face?.justCrossed === true;
    const valid = validateFaceEvent(face, state) || (lineCrossedHint && hasPhoto);

    // Only mark "present" once the face is valid for events. Invalid frames were
    // previously marking present=true → firstSight forever false → zero events.
    if (!valid) {
      if (hasPhoto || faceHasLiveCrop(face) || (Array.isArray(normBox) && normBox.length >= 4)) {
        trackPresence[tidKey] = {
          ...prev,
          present: Boolean(prev.present),
          lastSeen: Date.now(),
          score: resolveFaceDetectionScore(face) ?? face.detection_score ?? prev.score ?? 0,
          box: Array.isArray(normBox) ? normBox.slice(0, 4) : (prev.box || null),
          isKnown,
          needsPhoto: true,
          alertedUnknown: Boolean(prev.alertedUnknown),
          emittedFaceEvent: Boolean(prev.emittedFaceEvent),
          emittedLineCross: Boolean(prev.emittedLineCross),
        };
      }
      continue;
    }

    trackPresence[tidKey] = {
      present: true,
      lastSeen: Date.now(),
      score: resolveFaceDetectionScore(face) ?? face.detection_score ?? prev.score ?? 0,
      box: Array.isArray(normBox) ? normBox.slice(0, 4) : null,
      isKnown,
      needsPhoto: Boolean(prev.needsPhoto) && !hasPhoto,
      alertedUnknown: Boolean(prev.alertedUnknown),
      emittedFaceEvent: Boolean(prev.emittedFaceEvent),
      emittedLineCross: Boolean(prev.emittedLineCross),
      lastPhotoKey: prev.lastPhotoKey || null,
    };

    const matchId = face.match?.person_id || face.match?.personId;
    const matchedPerson = matchId || face.match?.name
      ? faceStore.listPersons().find((p) =>
        p.backendPersonId === matchId
        || p.id === matchId
        || (face.match?.name && p.fullName && p.fullName.toLowerCase() === String(face.match.name).toLowerCase()))
      : null;

    if (matchedPerson) {
      faceStore.recordLastSeen(matchedPerson.id, {
        cameraId: camera?.id,
        cameraName: camera?.name,
        location: camera?.location,
      });
    }

    const groupId = matchedPerson?.groupId;
    const auth = matchedPerson?.authorizationStatus;
    const eventConfidence = resolveFaceEventConfidence(face, isKnown);
    const allowed = isKnown
      ? (wantDetected || wantKnown)
      : (wantDetected || wantUnknown);

    // True events only:
    // - one face-detect per track visit (new person enter → one card + that photo)
    // - one line-cross per track visit
    // - never re-fire every second with the same picture
    if (allowed) {
      if (!hasPhoto) {
        trackPresence[tidKey].needsPhoto = true;
      } else {
        const awaitingPhoto = Boolean(prev.needsPhoto);
        const upgraded = wasPresent && !prevKnown && isKnown;
        const firstSight = !wasPresent || awaitingPhoto;
        const lineCrossed = face?.crossed === true
          || face?.line_crossed === true
          || face?.lineCrossed === true
          || face?.justCrossed === true;
        const alreadyFace = Boolean(prev.emittedFaceEvent);
        const alreadyLine = Boolean(prev.emittedLineCross);
        const photoKey = face?.crop_filename
          ? `file:${face.crop_filename}`
          : (faceSnapshot ? `jpeg:${String(faceSnapshot).length}:${String(faceSnapshot).slice(40, 72)}` : null);
        const samePhoto = photoKey && photoKey === prev.lastPhotoKey;

        const shouldEmit = lineCrossed
          ? (!alreadyLine && !samePhoto)
          : (((!alreadyFace && (firstSight || awaitingPhoto)) || upgraded) && !samePhoto);

        if (shouldEmit) {
          const evt = await makeFaceEvent({
            title: lineCrossed
              ? (isKnown
                ? `Line Crossed — ${matchedPerson?.fullName || face?.match?.name || 'Known face'}`
                : 'Line Crossed')
              : faceEventTitle(isKnown, matchedPerson, face),
            eventType: lineCrossed ? 'line-crossed' : faceEventType(isKnown),
            camera,
            severity: lineCrossed ? 'warning' : (isKnown ? 'success' : 'warning'),
            confidence: eventConfidence,
            face: { ...face, track_id: tidKey, crossed: lineCrossed, line_crossed: lineCrossed, lineCrossed },
            matchedPerson,
            snapshotJpeg: faceSnapshot,
            frameW,
            frameH,
          });
          if (evt.hasSnapshot) {
            toAdd.push(evt);
            if (lineCrossed) trackPresence[tidKey].emittedLineCross = true;
            else trackPresence[tidKey].emittedFaceEvent = true;
            trackPresence[tidKey].needsPhoto = false;
            trackPresence[tidKey].lastPhotoKey = photoKey;

            if (
              !isKnown
              && !lineCrossed
              && state.features?.unknownFaceAlerts !== false
              && !trackPresence[tidKey].alertedUnknown
              && (firstSight || awaitingPhoto)
            ) {
              faceStore.createAlert({
                type: 'unknown-face-detected',
                severity: 'warning',
                title: 'Face Detected',
                message: `Unrecognized face at ${camera?.name || 'camera'}`,
                cameraId: camera?.id,
                cameraName: camera?.name,
                location: camera?.location,
                confidence: eventConfidence,
                snapshotEventId: evt.id,
                snapshotJpeg: faceSnapshot,
              });
              trackPresence[tidKey].alertedUnknown = true;
            }
          } else {
            trackPresence[tidKey].needsPhoto = true;
          }
        }
      }
    }

    trackPresence[tidKey].isKnown = isKnown;

    // Known-face alert → email/Telegram pipeline (notify flags checked in dispatchAlert).
    // Without this, Face UI shows "Known Face Recognized" but no mail is ever sent.
    if (
      isKnown
      && (matchedPerson || face.match)
      && canEmitFace(state, `known-alert:${matchId || tidKey}`, FACE_EVENT_COOLDOWN_MS, cooldownMap)
    ) {
      const personName = matchedPerson?.fullName || face?.match?.name || 'Known person';
      const place = camera?.location || camera?.name || 'camera';
      const relatedEventId = toAdd.find((e) =>
        e.isKnown && String(e.trackingId || '') === tidKey
      )?.id || null;
      faceStore.createAlert({
        type: 'known-face-recognized',
        severity: 'success',
        title: 'Known Face Recognized',
        message: `${personName} was detected at ${place}`,
        personId: matchedPerson?.id || null,
        personName,
        groupId: matchedPerson?.groupId || groupId || null,
        cameraId: camera?.id,
        cameraName: camera?.name,
        location: camera?.location,
        confidence: eventConfidence,
        snapshotEventId: relatedEventId,
        snapshotJpeg: faceSnapshot,
      });
      markFaceCooldown(state, `known-alert:${matchId || tidKey}`, cooldownMap);
    }

    if (groupId === 'vip' && alerts['vip-person'] && canEmitFace(state, `vip:${matchId || tidKey}`, FACE_EVENT_COOLDOWN_MS, cooldownMap)) {
      toAdd.push(await makeFaceEvent({
        title: 'VIP Person Detected',
        eventType: 'vip-person',
        camera,
        severity: 'info',
        confidence: eventConfidence,
        face: { ...face, track_id: tidKey },
        matchedPerson,
        snapshotJpeg: faceSnapshot,
        frameW,
        frameH,
      }));
      markFaceCooldown(state, `vip:${matchId || tidKey}`, cooldownMap);
      faceStore.createAlert({
        type: 'vip-person',
        severity: 'info',
        title: 'VIP Person Detected',
        message: `${matchedPerson.fullName} was detected at ${camera?.location || camera?.name || 'camera'}`,
        personId: matchedPerson.id,
        personName: matchedPerson.fullName,
        groupId,
        cameraId: camera?.id,
        cameraName: camera?.name,
        location: camera?.location,
        confidence: eventConfidence,
        snapshotEventId: toAdd[toAdd.length - 1]?.id || null,
        snapshotJpeg: faceSnapshot,
      });
    }

    if (groupId === 'blacklist' && alerts['blacklisted-person'] && canEmitFace(state, `blacklist:${matchId || tidKey}`, FACE_EVENT_COOLDOWN_MS, cooldownMap)) {
      toAdd.push(await makeFaceEvent({
        title: 'Blacklisted Person Detected',
        eventType: 'blacklisted-person',
        camera,
        severity: 'critical',
        confidence: eventConfidence,
        face: { ...face, track_id: tidKey },
        matchedPerson,
        snapshotJpeg: faceSnapshot,
        frameW,
        frameH,
      }));
      markFaceCooldown(state, `blacklist:${matchId || tidKey}`, cooldownMap);
      const alert = faceStore.createAlert({
        type: 'blacklisted-person',
        severity: 'critical',
        title: 'Blacklisted Person Detected',
        message: `${matchedPerson.fullName} was detected at ${camera?.location || camera?.name || 'camera'}`,
        personId: matchedPerson.id,
        personName: matchedPerson.fullName,
        groupId,
        cameraId: camera?.id,
        cameraName: camera?.name,
        location: camera?.location,
        confidence: eventConfidence,
        snapshotEventId: toAdd[toAdd.length - 1]?.id || null,
        snapshotJpeg: faceSnapshot,
      });
      if (toAdd.length) toAdd[toAdd.length - 1].alertId = alert.id;
    }

    if (isKnown && auth === 'unauthorized' && alerts['unauthorized-person'] && canEmitFace(state, `unauth:${matchId || tidKey}`, FACE_EVENT_COOLDOWN_MS, cooldownMap)) {
      toAdd.push(await makeFaceEvent({
        title: 'Unauthorized Person Detected',
        eventType: 'unauthorized-person',
        camera,
        severity: 'critical',
        confidence: eventConfidence,
        face: { ...face, track_id: tidKey },
        matchedPerson,
        snapshotJpeg: faceSnapshot,
        frameW,
        frameH,
      }));
      markFaceCooldown(state, `unauth:${matchId || tidKey}`, cooldownMap);
      faceStore.createAlert({
        type: 'unauthorized-person',
        severity: 'critical',
        title: 'Unauthorized Person Detected',
        message: `${matchedPerson.fullName} is not authorized for this area`,
        personId: matchedPerson.id,
        personName: matchedPerson.fullName,
        groupId,
        cameraId: camera?.id,
        cameraName: camera?.name,
        location: camera?.location,
        confidence: eventConfidence,
        snapshotEventId: toAdd[toAdd.length - 1]?.id || null,
        snapshotJpeg: faceSnapshot,
      });
    }
  }

  for (const [tid, info] of Object.entries(trackPresence)) {
    if (!tid.startsWith(cameraTrackPrefix)) continue;
    if (activeTracks.has(tid)) continue;
    if (!info.present) continue;
    if (Date.now() - (info.lastSeen || 0) < FACE_TRACK_STALE_MS) continue;
    trackPresence[tid] = { ...info, present: false };
    faceTrackLastJpegs.delete(tid);
  }

  const eventsToStore = appendLineCrossMirrors(toAdd, camera);

  const recognitionsToday = (fresh._recognitionsToday || 0) + toAdd.filter((e) =>
    e.eventType === 'known-face-recognized' || (e.eventType === 'face-detected' && e.isKnown)
  ).length;

  const liveMetric = {
    facesNow: list.length,
    knownNow,
    unknownNow,
    fps: fresh._liveMetricsByCamera?.[cameraKey]?.fps ?? null,
  };
  const patch = {
    _liveMetrics: state.activeCameraId === cameraKey ? liveMetric : fresh._liveMetrics,
    _liveMetricsByCamera: {
      ...(fresh._liveMetricsByCamera || {}),
      [cameraKey]: liveMetric,
    },
    _recognitionsToday: recognitionsToday,
    _faceTrackPresence: trackPresence,
    _eventCooldowns: cooldownMap,
  };
  if (eventsToStore.length) {
    // Persist every face event — only purged when the camera is deleted.
    patch.recentEvents = [...eventsToStore.map(repairFaceEvent), ...events.map(repairFaceEvent)];
  }
  saveModelState('face', patch);

  return {
    newEvents: eventsToStore,
    metrics: { facesNow: list.length, knownNow, unknownNow, recognitionsToday },
  };
}

function getPayload(slug) {
  const tab = detectionConfig.getTab(slug);
  if (!tab) return null;

  const state = getModelState(slug);
  const allCameras = cameraStore.listCameras();
  const assigned = state.assignedCameraIds
    .map((id) => allCameras.find((c) => c.id === id))
    .filter(Boolean);
  const unassigned = allCameras.filter((c) => !state.assignedCameraIds.includes(c.id));

  let faceDatabase = null;
  if (slug === 'face') {
    try {
      const faceStore = require('./face-store');
      faceDatabase = {
        statistics: faceStore.getStatistics(),
        groups: faceStore.listGroups(),
        recentAlerts: faceStore.listAlerts({ status: 'active' }).slice(0, 10),
      };
    } catch {
      faceDatabase = null;
    }
  }

  // Never ship recentEvents / track maps to the browser (photos + internals).
  const {
    recentEvents: _recentEvents,
    _trackPresence,
    _eventCooldowns,
    _liveMetrics,
    _liveMetricsByCamera,
    _prevPeopleCount,
    _prevPeopleCountByCamera,
    ...publicState
  } = state;

  return {
    tab,
    state: {
      ...publicState,
      anyInferenceRunning: Boolean(state.inferenceRunning),
      inferenceRunning: state.activeCameraId
        ? state.runningCameraIds.includes(state.activeCameraId)
        : Boolean(state.inferenceRunning),
    },
    assignedCameras: assigned,
    availableCameras: unassigned,
    events: getEventsForSlug(slug, state),
    logs: generateLogs(slug, state.inferenceRunning, state),
    report: buildReport(slug, state),
    peopleMetrics: slug === 'person' ? buildPersonMetrics(state) : null,
    faceMetrics: slug === 'face' ? buildFaceMetrics(state) : null,
    faceDatabase,
  };
}

function assignCamera(slug, cameraId) {
  const tab = detectionConfig.getTab(slug);
  if (!tab) return { ok: false, error: 'Unknown detection model' };

  const camera = cameraStore.getCamera(cameraId);
  if (!camera) return { ok: false, error: 'Camera not found' };

  const state = getModelState(slug);
  if (!state.assignedCameraIds.includes(cameraId)) {
    state.assignedCameraIds.push(cameraId);
    saveModelState(slug, { assignedCameraIds: state.assignedCameraIds });
  }

  const aiModels = Array.isArray(camera.aiModels) ? [...camera.aiModels] : [];
  if (!aiModels.includes(tab.aiModelId)) {
    aiModels.push(tab.aiModelId);
    cameraStore.updateCamera(cameraId, { aiModels });
  }

  return { ok: true, payload: getPayload(slug) };
}

function unassignCamera(slug, cameraId) {
  const tab = detectionConfig.getTab(slug);
  if (!tab) return { ok: false, error: 'Unknown detection model' };

  const state = getModelState(slug);
  state.assignedCameraIds = state.assignedCameraIds.filter((id) => id !== cameraId);
  saveModelState(slug, { assignedCameraIds: state.assignedCameraIds });

  const camera = cameraStore.getCamera(cameraId);
  if (camera && Array.isArray(camera.aiModels)) {
    const aiModels = camera.aiModels.filter((id) => id !== tab.aiModelId);
    cameraStore.updateCamera(cameraId, { aiModels });
  }

  return { ok: true, payload: getPayload(slug) };
}

function setInference(slug, running) {
  const state = getModelState(slug);
  if (!running) {
    saveModelState(slug, {
      inferenceRunning: false,
      runningCameraIds: [],
      backendCameraIds: {},
      streamModes: {},
    });
  } else if (state.activeCameraId) {
    setCameraRuntime(slug, state.activeCameraId, { running: true });
  } else {
    saveModelState(slug, { inferenceRunning: true });
  }
  return getPayload(slug);
}

function isCameraRunning(slug, cameraId) {
  const id = String(cameraId || '').trim();
  if (!id) return false;
  return getModelState(slug).runningCameraIds.includes(id);
}

function getBackendCameraId(slug, cameraId) {
  const id = String(cameraId || '').trim();
  if (!id) return null;
  const state = getModelState(slug);
  return state.backendCameraIds[id]
    || (state.activeCameraId === id ? state.backendCameraId : null)
    || null;
}

/**
 * Atomically update one camera's runtime without disturbing other cameras.
 * Returns the normalized model state so callers can use the remaining count.
 */
function setCameraRuntime(slug, cameraId, options = {}) {
  const id = String(cameraId || '').trim();
  if (!id) return getModelState(slug);

  const state = getModelState(slug);
  const ids = new Set(state.runningCameraIds || []);
  const backendCameraIds = { ...(state.backendCameraIds || {}) };
  const streamModes = { ...(state.streamModes || {}) };
  const running = options.running !== false;

  if (running) ids.add(id);
  else ids.delete(id);

  if (options.backendCameraId) backendCameraIds[id] = options.backendCameraId;
  if (options.streamMode) streamModes[id] = options.streamMode;
  if (!running) {
    delete backendCameraIds[id];
    delete streamModes[id];
  }

  const runningCameraIds = [...ids];
  const activeCameraId = options.select === true
    ? id
    : (state.activeCameraId || (running ? id : null));
  const selectedBackendId = activeCameraId
    ? (backendCameraIds[activeCameraId] || null)
    : null;
  const selectedStreamMode = activeCameraId
    ? (streamModes[activeCameraId] || (runningCameraIds.length ? 'backend' : 'preview'))
    : (runningCameraIds.length ? 'backend' : 'preview');

  saveModelState(slug, {
    activeCameraId,
    runningCameraIds,
    backendCameraIds,
    streamModes,
    inferenceRunning: runningCameraIds.length > 0,
    backendCameraId: selectedBackendId,
    streamMode: selectedStreamMode,
  });
  return getModelState(slug);
}

function updateSettings(slug, body) {
  const current = getModelState(slug);
  const allowed = ['confidence', 'matchThreshold', 'fpsRate', 'resolution', 'zones', 'alerts', 'features', 'minObjectSizePx', 'maxPeopleAlert', 'activeCameraId'];
  const patch = {};
  for (const key of allowed) {
    if (body[key] !== undefined) patch[key] = body[key];
  }
  if (patch.confidence !== undefined) {
    patch.confidence = Math.max(0.25, Math.min(0.95, Number(patch.confidence)));
  }
  if (patch.matchThreshold !== undefined) {
    patch.matchThreshold = Math.max(0.35, Math.min(0.85, Number(patch.matchThreshold)));
  }
  if (patch.fpsRate !== undefined) {
    patch.fpsRate = Math.max(1, Math.min(60, Math.round(Number(patch.fpsRate))));
  }
  if (patch.features && typeof patch.features === 'object') {
    patch.features = { ...(current.features || {}), ...patch.features };
  }
  if (patch.alerts && typeof patch.alerts === 'object') {
    patch.alerts = { ...(current.alerts || {}), ...patch.alerts };
  }
  if (patch.minObjectSizePx !== undefined) {
    patch.minObjectSizePx = Math.max(16, Math.min(256, Math.round(Number(patch.minObjectSizePx))));
  }
  if (patch.maxPeopleAlert !== undefined) {
    patch.maxPeopleAlert = Math.max(1, Math.min(99, Math.round(Number(patch.maxPeopleAlert))));
  }
  if (patch.zones !== undefined) {
    patch.zones = sanitizeZones(patch.zones);
  }
  saveModelState(slug, patch);
  return getPayload(slug);
}

function exportData(slug, format) {
  const payload = getPayload(slug);
  if (!payload) return null;

  if (format === 'json') {
    return {
      contentType: 'application/json',
      filename: `${slug}-detection-export.json`,
      body: JSON.stringify(
        {
          model: payload.tab,
          settings: payload.state,
          assignedCameras: payload.assignedCameras,
          events: payload.events,
          report: payload.report,
          exportedAt: new Date().toISOString(),
        },
        null,
        2
      ),
    };
  }

  const rows = [
    ['Time', 'Event', 'Camera', 'Severity', 'Confidence'],
    ...payload.events.map((e) => [e.timeLabel, e.title, e.camera, e.severity, String(e.confidence)]),
  ];
  const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  return {
    contentType: 'text/csv',
    filename: `${slug}-events-export.csv`,
    body: csv,
  };
}

function getEventSnapshot(eventId) {
  const id = String(eventId);
  const hit = eventSnapshots.get(id);
  if (hit) {
    if (typeof hit === 'string') return { jpeg: hit, bbox: null };
    return hit;
  }
  const fromFile = readEventJpegFile(id);
  if (fromFile) {
    const entry = { jpeg: fromFile, bbox: null };
    eventSnapshots.set(id, entry);
    return entry;
  }
  // Legacy: JPEG still embedded on the event (pre-migration).
  const event = getSnapshotEvent(id);
  if (event?.snapshotJpeg && typeof event.snapshotJpeg === 'string' && event.snapshotJpeg.length >= 64) {
    persistEventJpeg(id, event.snapshotJpeg);
    return { jpeg: normalizeJpegBase64(event.snapshotJpeg), bbox: event.bbox || null };
  }
  return null;
}

function purgeCameraData(cameraId) {
  const id = String(cameraId || '').trim();
  if (!id) return { ok: false, removedEvents: 0, unassignedFrom: [] };

  // Optional extras: also match by camera display name (older events / re-add same RTSP).
  const extra = arguments[1] && typeof arguments[1] === 'object' ? arguments[1] : {};
  const name = String(extra.name || '').trim();
  const nameLower = name.toLowerCase();

  const slugs = detectionConfig.listSlugs();
  let removedEvents = 0;
  const unassignedFrom = [];
  const removedIds = [];

  function eventBelongsToCamera(e) {
    if (!e) return false;
    if (e.cameraId && String(e.cameraId) === id) return true;
    if (name && String(e.camera || '').trim() === name) return true;
    if (nameLower && String(e.camera || '').trim().toLowerCase() === nameLower) return true;
    return false;
  }

  for (const slug of slugs) {
    const state = getModelState(slug);
    const nextAssigned = Array.isArray(state.assignedCameraIds)
      ? state.assignedCameraIds.filter((cid) => cid !== id)
      : [];
    const wasAssigned = Array.isArray(state.assignedCameraIds) && nextAssigned.length !== state.assignedCameraIds.length;

    const prevEvents = Array.isArray(state.recentEvents) ? state.recentEvents : [];
    const nextEvents = prevEvents.filter((e) => !eventBelongsToCamera(e));
    const dropped = prevEvents.filter((e) => eventBelongsToCamera(e));
    dropped.forEach((e) => { if (e?.id) removedIds.push(String(e.id)); });
    const removedHere = prevEvents.length - nextEvents.length;
    removedEvents += Math.max(0, removedHere);

    const patch = {};
    if (wasAssigned) patch.assignedCameraIds = nextAssigned;
    if (removedHere) patch.recentEvents = nextEvents;

    if (slug === 'person' && state.activeCameraId === id) patch.activeCameraId = null;
    if (slug === 'face' && state.activeCameraId === id) patch.activeCameraId = null;

    const nextRunning = (state.runningCameraIds || []).filter((cid) => cid !== id);
    if (nextRunning.length !== (state.runningCameraIds || []).length) {
      const backendCameraIds = { ...(state.backendCameraIds || {}) };
      const streamModes = { ...(state.streamModes || {}) };
      delete backendCameraIds[id];
      delete streamModes[id];
      patch.runningCameraIds = nextRunning;
      patch.backendCameraIds = backendCameraIds;
      patch.streamModes = streamModes;
      patch.inferenceRunning = nextRunning.length > 0;
    }

    // Drop danger zones drawn for this camera.
    if (Array.isArray(state.zones) && state.zones.length) {
      const nextZones = state.zones.filter((z) => !z?.cameraId || z.cameraId !== id);
      if (nextZones.length !== state.zones.length) patch.zones = nextZones;
    }

    // Remove only this camera's tracking/metrics; other streams stay intact.
    const trackPrefix = `${id}:`;
    if (slug === 'person') {
      patch._trackPresence = Object.fromEntries(
        Object.entries(state._trackPresence || {}).filter(([key]) => !key.startsWith(trackPrefix)),
      );
      const counts = { ...(state._prevPeopleCountByCamera || {}) };
      const metrics = { ...(state._liveMetricsByCamera || {}) };
      delete counts[id];
      delete metrics[id];
      patch._prevPeopleCountByCamera = counts;
      patch._liveMetricsByCamera = metrics;
      if (state.activeCameraId === id) patch._prevPeopleCount = 0;
    }
    if (slug === 'face') {
      patch._faceTrackPresence = Object.fromEntries(
        Object.entries(state._faceTrackPresence || {}).filter(([key]) => !key.startsWith(trackPrefix)),
      );
      const metrics = { ...(state._liveMetricsByCamera || {}) };
      delete metrics[id];
      patch._liveMetricsByCamera = metrics;
    }

    if (Object.keys(patch).length) {
      saveModelState(slug, patch);
      if (wasAssigned) unassignedFrom.push(slug);
    }
  }

  for (const evtId of removedIds) {
    deleteEventJpeg(evtId);
    eventSnapshots.delete(evtId);
  }

  return { ok: true, removedEvents, unassignedFrom, removedIds };
}

module.exports = {
  getPayload,
  getModelState,
  saveModelState,
  assignCamera,
  unassignCamera,
  setInference,
  updateSettings,
  exportData,
  getSnapshotEvent,
  getEventSnapshot,
  recordPersonDetection,
  recordFaceDetection,
  isCameraRunning,
  getBackendCameraId,
  setCameraRuntime,
  purgeCameraData,
};

function getSnapshotEvent(eventId) {
  const id = String(eventId);
  for (const slug of detectionConfig.listSlugs()) {
    const state = getModelState(slug);
    const hit = (state.recentEvents || []).find((e) => e.id === id);
    if (hit) return hit;
  }
  return null;
}
