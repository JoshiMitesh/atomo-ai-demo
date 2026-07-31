/**
 * Face tab — fetch-only bridge to vision board APIs.
 *
 * Live stream overlay  → GET /api/face/stream/boxes/:cameraId
 * Recognition events   → GET /api/face/stream/result/:cameraId
 */

const cameraStore = require('./camera-store');
const detectionStore = require('./detection-store');
const faceStore = require('./face-store');
const faceClusterStore = require('./face-cluster-store');
const { getLiveViewPayload, normalizeMediaUrl } = require('./camera-analytics');
const { createVisionClient } = require('./vision-api');
const { broadcastFaceUpdate } = require('./event-broadcast');
const { ensureBoardCamera, attachLocalPlayback } = require('./board-camera-sync');

const FACE_SLUG = 'face';
const faceClient = createVisionClient(
  process.env.VISION_FACE_API_URL || process.env.VISION_API_URL || process.env.BACKEND_API_URL,
  { label: 'face' },
);
const boardCropCache = new Map();
const boardCropPromises = new Map();
const streamClients = new Map();
const streamLoops = new Map();
const frameCounters = new Map();
const startPromises = new Map();
/** backend camera ID -> local MediaMTX RTSP URL already saved on face API */
const faceWorkerSources = new Map();
const faceWorkerSourcePromises = new Map();
const FACE_MIN_POLL_MS = Math.max(80, Number(process.env.FACE_POLL_MS) || 120);
const FACE_EVENT_POLL_MS = Math.max(250, Number(process.env.FACE_EVENT_POLL_MS) || 750);
let boardFaceProcessStartPromise = null;
let boardFaceProcessKnownRunning = false;
/** Throttle cluster ingest per track so one person doesn't spam new crops. */
const clusterIngestAt = new Map();
const CLUSTER_INGEST_MS = 2000;
/** backendId -> { enabled, at } — tripwire saved on board */
const tripwireCache = new Map();
/** backendId -> last segment the user saved (board may echo a legacy schema) */
const savedLineByBackend = new Map();
/** backendId -> Set of recently recorded cross keys (avoid double fire from poll+loop) */
const recordedCrossKeys = new Map();
/** backendId -> Map(crossKey -> lastSeenMs) — tracks whether a crossed track is still in frame */
const crossTrackLastSeenAt = new Map();
/** `${backendId}:${trackId}` -> last signed side of the tripwire (for local cross detection) */
const trackLineSide = new Map();
/** `${backendId}:${trackId}` -> ms until live overlay shows cross pulse (not for events) */
const crossOverlayUntil = new Map();
/** `${backendId}:${trackId}` -> previous board `crossed` flag (rising-edge only) */
const boardCrossedPrev = new Map();
/** `${backendId}:${trackId}` -> last box (stabilize anonymous tracks via IoU) */
const trackLastBoxByKey = new Map();
/** `${backendId}:${trackId}` -> already produced a line-cross for this in-frame visit */
const crossedThisVisit = new Map();
/** `${backendId}:${trackId}` -> last frame we saw this motion track */
const motionTrackLastSeenAt = new Map();
/** backendId -> Map(trackKey -> true) already emitted face-detect for this visit */
const recordedFaceDetectKeys = new Map();
/** backendId -> Map(visitKey -> face visit); survives short board track-id recycling. */
const stableFaceVisits = new Map();
let stableFaceVisitSequence = 0;
/** photoKey → track that used this crop for a face-detect event */
const usedFacePhotos = new Map();
/** photoKey → track that used this crop for a line-cross event */
const usedLinePhotos = new Map();

const CROSS_OVERLAY_PULSE_MS = 2500;
/** Only a short grace for tracker flicker — NOT an event cooldown. */
const TRACK_LOST_MS = 1500;
/** A continuously visible face remains the same visit across brief detector gaps. */
const FACE_VISIT_LOST_MS = 8000;
const FACE_VISIT_SPATIAL_GRACE_MS = 3000;

function clamp01(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  return Math.min(1, Math.max(0, v));
}

function isFaceCameraRunning(cameraId) {
  return detectionStore.isCameraRunning(FACE_SLUG, cameraId);
}

function facePollMs(state) {
  const fps = Math.max(1, Math.min(20, Number(state?.fpsRate) || 10));
  return Math.max(FACE_MIN_POLL_MS, Math.round(1000 / fps));
}

function scopeFaceTrackIds(cameraId, faces) {
  return (Array.isArray(faces) ? faces : []).map((face) => {
    const sourceId = face?.track_id ?? face?.trackId;
    if (sourceId == null || sourceId === '') return { ...face };
    return {
      ...face,
      source_track_id: face?.source_track_id ?? sourceId,
      track_id: `${cameraId}:${String(sourceId)}`,
    };
  });
}

/**
 * Normalize board line-config to the canonical 2-point segment used by the worker.
 * Supports:
 *   - { line_x1, line_y1, line_x2, line_y2 }
 *   - legacy { line_y, x_start, x_end, direction }
 */
function normalizeBoardLineConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return null;
  const enabled = cfg.enabled !== false && cfg.enabled !== 0;

  let x1 = clamp01(cfg.line_x1 ?? cfg.x1);
  let y1 = clamp01(cfg.line_y1 ?? cfg.y1);
  let x2 = clamp01(cfg.line_x2 ?? cfg.x2);
  let y2 = clamp01(cfg.line_y2 ?? cfg.y2);

  // Legacy horizontal tripwire used by some board builds
  if ((x1 == null || y1 == null || x2 == null || y2 == null)
    && (cfg.line_y != null || cfg.y != null)) {
    const y = clamp01(cfg.line_y ?? cfg.y);
    x1 = clamp01(cfg.x_start ?? cfg.xStart ?? 0) ?? 0;
    x2 = clamp01(cfg.x_end ?? cfg.xEnd ?? 1) ?? 1;
    y1 = y;
    y2 = y;
  }

  if (x1 == null || y1 == null || x2 == null || y2 == null) {
    return enabled ? { enabled: true, incomplete: true } : { enabled: false };
  }
  return {
    enabled,
    line_x1: x1,
    line_y1: y1,
    line_x2: x2,
    line_y2: y2,
    direction: cfg.direction || 'in',
  };
}

function toWorkerLineFields(norm) {
  if (!norm?.enabled || norm.incomplete) return {};
  if (norm.line_x1 == null) return {};
  const lineY = (Number(norm.line_y1) + Number(norm.line_y2)) / 2;
  const lineXStart = Math.min(Number(norm.line_x1), Number(norm.line_x2));
  const lineXEnd = Math.max(Number(norm.line_x1), Number(norm.line_x2));
  const lineDirection = norm.direction || 'in';
  return {
    // Canonical fields documented by POST /api/face/stream/start.
    line_crossing_enabled: true,
    line_y: lineY,
    line_direction: lineDirection,
    line_x_start: lineXStart,
    line_x_end: lineXEnd,
    // Segment/legacy aliases keep compatibility with older board builds.
    line_x1: norm.line_x1,
    line_y1: norm.line_y1,
    line_x2: norm.line_x2,
    line_y2: norm.line_y2,
    line_enabled: true,
    x_start: lineXStart,
    x_end: lineXEnd,
    direction: lineDirection,
  };
}

/** Body for PUT — send segment + legacy so either board build accepts it. */
function toBoardPutBody(body = {}) {
  const norm = normalizeBoardLineConfig({ ...body, enabled: body.enabled !== false });
  if (!norm || norm.incomplete || norm.line_x1 == null) {
    return body || {};
  }
  return {
    enabled: true,
    line_x1: norm.line_x1,
    line_y1: norm.line_y1,
    line_x2: norm.line_x2,
    line_y2: norm.line_y2,
    line_y: (norm.line_y1 + norm.line_y2) / 2,
    x_start: Math.min(norm.line_x1, norm.line_x2),
    x_end: Math.max(norm.line_x1, norm.line_x2),
    direction: body.direction || norm.direction || 'in',
  };
}

function rememberSavedLine(backendId, norm) {
  if (!backendId || !norm?.enabled || norm.line_x1 == null) return;
  savedLineByBackend.set(backendId, {
    enabled: true,
    line_x1: norm.line_x1,
    line_y1: norm.line_y1,
    line_x2: norm.line_x2,
    line_y2: norm.line_y2,
    direction: norm.direction || 'in',
  });
  tripwireCache.set(backendId, { enabled: true, at: Date.now() });
}

/** Persist tripwire on the dashboard camera so board camera-id changes don't lose it. */
function persistCameraTripwire(cameraId, norm) {
  if (!cameraId || !norm || norm.line_x1 == null) return;
  cameraStore.updateCamera(cameraId, {
    faceTripwire: {
      enabled: true,
      line_x1: norm.line_x1,
      line_y1: norm.line_y1,
      line_x2: norm.line_x2,
      line_y2: norm.line_y2,
      direction: norm.direction || 'in',
      savedAt: new Date().toISOString(),
    },
  });
}

function clearCameraTripwire(cameraId) {
  if (!cameraId) return;
  cameraStore.updateCamera(cameraId, { faceTripwire: null });
}

/** Hydrate in-memory line from dashboard camera record (survives board id / restart). */
function hydrateTripwireFromCamera(cameraId, backendId) {
  if (!cameraId || !backendId) return null;
  const cam = cameraStore.getCamera(cameraId);
  const tw = cam?.faceTripwire;
  if (!tw || tw.enabled === false || tw.line_x1 == null) return null;
  const norm = normalizeBoardLineConfig({ ...tw, enabled: true });
  if (!norm?.enabled || norm.line_x1 == null) return null;
  rememberSavedLine(backendId, norm);
  return savedLineByBackend.get(backendId) || norm;
}

function getRememberedLine(backendId) {
  return backendId ? (savedLineByBackend.get(backendId) || null) : null;
}

function hasLineSegment(backendId) {
  const line = getRememberedLine(backendId);
  return Boolean(line?.enabled && line.line_x1 != null);
}

function resolveLineForWorker(backendId, boardCfg) {
  const remembered = savedLineByBackend.get(backendId);
  const fromBoard = normalizeBoardLineConfig(boardCfg);
  // Prefer the exact segment the user drew/saved on this dashboard.
  if (remembered?.enabled && remembered.line_x1 != null) {
    return remembered;
  }
  if (fromBoard?.enabled && fromBoard.line_x1 != null) {
    return fromBoard;
  }
  return null;
}

function invalidateTripwireCache(backendId) {
  if (backendId) {
    tripwireCache.delete(backendId);
  } else {
    tripwireCache.clear();
  }
}

async function isTripwireActive(backendId, hintEnabled = false, cameraId = null) {
  if (cameraId && backendId) hydrateTripwireFromCamera(cameraId, backendId);
  if (!backendId) return Boolean(hintEnabled);
  if (savedLineByBackend.get(backendId)?.enabled) {
    tripwireCache.set(backendId, { enabled: true, at: Date.now() });
    return true;
  }
  if (hintEnabled) {
    tripwireCache.set(backendId, { enabled: true, at: Date.now() });
    return true;
  }
  const cached = tripwireCache.get(backendId);
  if (cached && Date.now() - cached.at < 2500) return cached.enabled;
  try {
    const lineCfg = await faceClient.apiJson(
      `/api/face/stream/line-config/${encodeURIComponent(backendId)}`,
    );
    const norm = normalizeBoardLineConfig(lineCfg);
    const enabled = Boolean(norm?.enabled && (norm.line_x1 != null || savedLineByBackend.has(backendId)));
    if (enabled && norm?.line_x1 != null) rememberSavedLine(backendId, norm);
    // Board may say enabled:false even after we saved — dashboard memory still wins.
    if (!enabled && hasLineSegment(backendId)) {
      tripwireCache.set(backendId, { enabled: true, at: Date.now() });
      return true;
    }
    tripwireCache.set(backendId, { enabled, at: Date.now() });
    return enabled;
  } catch {
    if (hasLineSegment(backendId)) return true;
    return Boolean(hintEnabled);
  }
}

/** STRICT: when tripwire is on, only faces that actually crossed the line. */
function filterCrossedEventFaces(faces) {
  return (Array.isArray(faces) ? faces : []).filter((f) => f && f.crossed === true);
}

function sideOfSegment(px, py, x1, y1, x2, y2) {
  return (x2 - x1) * (py - y1) - (y2 - y1) * (px - x1);
}

function segmentHitsBox(x1, y1, x2, y2, bx1, by1, bx2, by2) {
  const minX = Math.min(bx1, bx2);
  const maxX = Math.max(bx1, bx2);
  const minY = Math.min(by1, by2);
  const maxY = Math.max(by1, by2);
  const samples = [
    [x1, y1], [x2, y2],
    [(x1 + x2) / 2, (y1 + y2) / 2],
  ];
  for (const [px, py] of samples) {
    if (px >= minX && px <= maxX && py >= minY && py <= maxY) return true;
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const s1 = sideOfSegment(minX, minY, x1, y1, x2, y2);
  const s2 = sideOfSegment(maxX, maxY, x1, y1, x2, y2);
  const s3 = sideOfSegment(minX, maxY, x1, y1, x2, y2);
  const s4 = sideOfSegment(maxX, minY, x1, y1, x2, y2);
  const sides = [s1, s2, s3, s4];
  if (sides.some((s) => s > 0) && sides.some((s) => s < 0)) return true;
  return sideOfSegment(cx, cy, x1, y1, x2, y2) === 0;
}

/** Keep anonymous faces on a stable key across frames (board often omits track_id). */
function resolveMotionTrackKey(backendId, face, box, idx) {
  if (face?.track_id != null) return `${backendId}:${String(face.track_id)}`;
  if (face?.trackId != null) return `${backendId}:${String(face.trackId)}`;
  let bestKey = null;
  let bestIou = 0.22;
  for (const [key, prevBox] of trackLastBoxByKey) {
    if (!key.startsWith(`${backendId}:`)) continue;
    const iou = boxIou(box, prevBox);
    if (iou > bestIou) {
      bestIou = iou;
      bestKey = key;
    }
  }
  if (bestKey) return bestKey;
  return `${backendId}:anon-${Date.now().toString(36)}-${idx}`;
}

function forgetVisitStateForKey(key) {
  trackLineSide.delete(key);
  crossOverlayUntil.delete(key);
  boardCrossedPrev.delete(key);
  trackLastBoxByKey.delete(key);
  crossedThisVisit.delete(key);
  motionTrackLastSeenAt.delete(key);
  const tid = key.includes(':') ? key.slice(key.indexOf(':') + 1) : key;
  releasePhotosForTrack(`tid:${tid}`);
  releasePhotosForTrack(key);
}

function faceEventIdentityKey(face, idx = 0) {
  if (face?.track_id != null && String(face.track_id) !== '') {
    return `tid:${String(face.track_id)}`;
  }
  if (face?.trackId != null && String(face.trackId) !== '') {
    return `tid:${String(face.trackId)}`;
  }
  if (face?.crop_filename) return `crop:${face.crop_filename}`;
  const matchId = face?.match?.person_id || face?.match?.personId || face?.person_id;
  if (matchId) return `person:${matchId}`;
  if (Array.isArray(face?.box) && face.box.length >= 4) {
    const cx = ((Number(face.box[0]) + Number(face.box[2])) / 2).toFixed(1);
    const cy = ((Number(face.box[1]) + Number(face.box[3])) / 2).toFixed(1);
    return `box:${cx},${cy}`;
  }
  return `idx:${idx}`;
}

function knownFacePersonId(face) {
  if (face?.is_known !== true && face?.match?.is_known !== true) return null;
  return face?.match?.person_id
    || face?.match?.personId
    || face?.person_id
    || face?.personId
    || null;
}

/**
 * Keep one face-detection event per continuous visit even when the board tracker
 * replaces track_id. Known people match by identity; unknown people match by
 * recent box overlap. Separate simultaneous faces retain separate visit keys.
 */
function stableFaceVisitKey(backendId, face) {
  let visits = stableFaceVisits.get(backendId);
  if (!visits) {
    visits = new Map();
    stableFaceVisits.set(backendId, visits);
  }

  const now = Date.now();
  for (const [key, visit] of [...visits.entries()]) {
    if (now - visit.lastSeen > FACE_VISIT_LOST_MS) {
      visits.delete(key);
      recordedFaceDetectKeys.get(backendId)?.delete(key);
      releasePhotosForTrack(key);
    }
  }

  const box = Array.isArray(face?.box) ? face.box.slice(0, 4) : null;
  const personId = knownFacePersonId(face);
  const sourceTrackId = face?.track_id != null
    ? String(face.track_id)
    : (face?.trackId != null ? String(face.trackId) : null);
  let bestKey = null;
  let bestScore = 0.18;

  for (const [key, visit] of visits) {
    if (sourceTrackId && visit.sourceTrackId === sourceTrackId) {
      bestKey = key;
      break;
    }
    if (personId && visit.personId === personId) {
      bestKey = key;
      break;
    }
    // A visit commonly starts UNKNOWN and becomes known after a clearer frame.
    // Permit that one-way identity upgrade when the boxes still overlap.
    if (visit.personId && personId && visit.personId !== personId) continue;
    if (!box || !visit.box) continue;
    if (now - visit.lastSeen > FACE_VISIT_SPATIAL_GRACE_MS) continue;
    const overlap = boxIou(box, visit.box);
    if (overlap > bestScore) {
      bestScore = overlap;
      bestKey = key;
    }
  }

  if (!bestKey) {
    stableFaceVisitSequence += 1;
    bestKey = `visit:${backendId}:${stableFaceVisitSequence}`;
  }
  const previous = visits.get(bestKey);
  visits.set(bestKey, {
    box,
    personId: personId || previous?.personId || null,
    sourceTrackId: sourceTrackId || previous?.sourceTrackId || null,
    lastSeen: now,
  });
  return bestKey;
}

function facePhotoKey(face) {
  if (face?.crop_filename) return `file:${face.crop_filename}`;
  const jpeg = typeof face?.crop_jpeg === 'string' ? face.crop_jpeg : '';
  if (jpeg.length >= 64) {
    return `jpeg:${jpeg.length}:${jpeg.slice(32, 64)}:${jpeg.slice(-32)}`;
  }
  return null;
}

function faceHasUsablePhoto(face) {
  // Filename alone is not enough — store needs base64. Requiring jpeg prevents
  // "emitted" marks that never become UI events when crop fetch is late/fails.
  const jpeg = typeof face?.crop_jpeg === 'string'
    ? face.crop_jpeg.replace(/^data:image\/\w+;base64,/, '')
    : '';
  return Boolean(jpeg && jpeg.length >= 64);
}

/** One exact photo → one event per kind (face vs line). Cleared when that track leaves. */
function claimPhotoForTrack(face, trackKey, kind = 'face') {
  const photoKey = facePhotoKey(face);
  if (!photoKey) return true;
  const map = kind === 'line' ? usedLinePhotos : usedFacePhotos;
  const owner = map.get(photoKey);
  if (owner && owner !== trackKey) return false;
  if (owner === trackKey) return false;
  map.set(photoKey, trackKey);
  return true;
}

function releasePhotosForTrack(trackKey) {
  for (const map of [usedFacePhotos, usedLinePhotos]) {
    for (const [photoKey, owner] of [...map.entries()]) {
      if (owner === trackKey) map.delete(photoKey);
    }
  }
}

/**
 * Detect crosses from saved segment + face motion.
 * `justCrossed` fires once per in-frame visit (not every N seconds while standing).
 */
function annotateLocalCrossings(backendId, faces) {
  const list = Array.isArray(faces) ? faces : [];
  const line = savedLineByBackend.get(backendId);
  if (!backendId || !line?.enabled || line.line_x1 == null) {
    return list.map((f) => {
      const board = f?.crossed === true;
      return { ...f, crossed: board, justCrossed: board };
    });
  }
  const { line_x1: x1, line_y1: y1, line_x2: x2, line_y2: y2 } = line;
  const now = Date.now();
  return list.map((f, idx) => {
    let justCrossed = false;
    const box = f?.box;
    if (!Array.isArray(box) || box.length < 4) {
      const board = f?.crossed === true;
      return { ...f, crossed: board, justCrossed: board };
    }
    const cx = (Number(box[0]) + Number(box[2])) / 2;
    const cy = (Number(box[1]) + Number(box[3])) / 2;
    if (![cx, cy].every(Number.isFinite)) {
      const board = f?.crossed === true;
      return { ...f, crossed: board, justCrossed: board };
    }

    const key = resolveMotionTrackKey(backendId, f, box, idx);
    const tid = key.slice(backendId.length + 1);
    const side = sideOfSegment(cx, cy, x1, y1, x2, y2);
    const prev = trackLineSide.get(key);
    const boardSaysCrossed = f?.crossed === true;
    const prevBoard = boardCrossedPrev.get(key) === true;
    const alreadyVisited = crossedThisVisit.get(key) === true;
    const intersecting = segmentHitsBox(x1, y1, x2, y2, box[0], box[1], box[2], box[3]);

    if (boardSaysCrossed && !prevBoard) justCrossed = true;

    if (!justCrossed && prev != null && prev !== 0 && side !== 0 && (prev > 0) !== (side > 0)) {
      justCrossed = true;
    }

    // First line contact this visit (covers missing track_id / no clean side flip).
    if (!justCrossed && intersecting && !alreadyVisited) justCrossed = true;

    if (justCrossed) {
      crossedThisVisit.set(key, true);
      crossOverlayUntil.set(key, now + CROSS_OVERLAY_PULSE_MS);
    }

    boardCrossedPrev.set(key, boardSaysCrossed);
    trackLastBoxByKey.set(key, box.slice(0, 4));
    motionTrackLastSeenAt.set(key, now);
    if (side !== 0) trackLineSide.set(key, side);
    else if (prev == null) trackLineSide.set(key, 0);

    // Keep green overlay for the rest of this visit after a real cross.
    const showOverlay = justCrossed
      || crossedThisVisit.get(key) === true
      || (crossOverlayUntil.get(key) || 0) > now;

    return {
      ...f,
      track_id: f.track_id ?? tid,
      justCrossed,
      crossed: showOverlay,
      line_crossed: showOverlay,
      lineCrossed: showOverlay,
    };
  });
}

function clearLocalCrossingState(backendId) {
  if (!backendId) {
    trackLineSide.clear();
    crossOverlayUntil.clear();
    boardCrossedPrev.clear();
    trackLastBoxByKey.clear();
    crossedThisVisit.clear();
    motionTrackLastSeenAt.clear();
    recordedFaceDetectKeys.clear();
    stableFaceVisits.clear();
    recordedCrossKeys.clear();
    usedFacePhotos.clear();
    usedLinePhotos.clear();
    return;
  }
  const prefix = `${backendId}:`;
  for (const key of [
    ...trackLineSide.keys(),
    ...crossOverlayUntil.keys(),
    ...boardCrossedPrev.keys(),
    ...trackLastBoxByKey.keys(),
    ...crossedThisVisit.keys(),
    ...motionTrackLastSeenAt.keys(),
  ]) {
    if (key.startsWith(prefix)) forgetVisitStateForKey(key);
  }
  recordedFaceDetectKeys.delete(backendId);
  stableFaceVisits.delete(backendId);
  recordedCrossKeys.delete(backendId);
}

/** Only faces that crossed on this exact frame — one real event per crossing. */
function filterJustCrossedEventFaces(faces) {
  return (Array.isArray(faces) ? faces : []).filter((f) => f && f.justCrossed === true);
}

/** Forget visit state when a track truly leaves — enables a NEW event on a later return. */
function touchCrossTrackPresence(backendId, faces) {
  if (!backendId) return;
  let seenMap = crossTrackLastSeenAt.get(backendId);
  if (!seenMap) {
    seenMap = new Map();
    crossTrackLastSeenAt.set(backendId, seenMap);
  }
  const now = Date.now();
  const aliveMotion = new Set();
  const aliveIdentity = new Set();
  (Array.isArray(faces) ? faces : []).forEach((f, idx) => {
    const idKey = faceEventIdentityKey(f, idx);
    aliveIdentity.add(idKey);
    seenMap.set(idKey, now);
    if (f?.track_id != null) {
      const mk = `${backendId}:${String(f.track_id)}`;
      aliveMotion.add(mk);
      motionTrackLastSeenAt.set(mk, now);
    }
  });
  for (const key of [...motionTrackLastSeenAt.keys()]) {
    if (!key.startsWith(`${backendId}:`)) continue;
    const lastSeen = motionTrackLastSeenAt.get(key) || 0;
    if (!aliveMotion.has(key) && now - lastSeen > TRACK_LOST_MS) {
      forgetVisitStateForKey(key);
    }
  }
  const recorded = recordedCrossKeys.get(backendId);
  if (recorded) {
    for (const key of [...recorded.keys()]) {
      if (!aliveIdentity.has(key) && now - (seenMap.get(key) || 0) > TRACK_LOST_MS) {
        recorded.delete(key);
        seenMap.delete(key);
        releasePhotosForTrack(key);
      }
    }
  }
}

/**
 * Face-detect once per visit. Pending until a real JPEG arrives.
 * Same picture never creates another face event.
 */
function takeUnseenFaceDetectFaces(backendId, faces) {
  if (!backendId) return [];
  let map = recordedFaceDetectKeys.get(backendId);
  if (!map) {
    map = new Map();
    recordedFaceDetectKeys.set(backendId, map);
  }
  const out = [];
  (Array.isArray(faces) ? faces : []).forEach((f, idx) => {
    // Same tick as a brand-new line-cross edge → line tab owns that moment.
    if (f?.justCrossed === true) return;
    if (!Array.isArray(f?.box) || f.box.length < 4) return;
    const key = stableFaceVisitKey(backendId, f, idx);
    const prev = map.get(key);
    const isKnown = Boolean(f?.is_known && f?.match);
    // Let a recognized retry upgrade the already-emitted UNKNOWN event once.
    if (prev?.emitted && (prev.isKnown || !isKnown)) return;

    if (!faceHasUsablePhoto(f)) {
      if (!prev) map.set(key, { emitted: false, pending: true, at: Date.now() });
      return;
    }
    if (!claimPhotoForTrack(f, key, 'face')) return;
    map.set(key, {
      emitted: true,
      pending: false,
      at: Date.now(),
      photo: facePhotoKey(f),
      isKnown,
    });
    out.push({
      ...f,
      // Keep the local event identity stable even if the board tracker swaps IDs.
      track_id: key,
      crossed: false,
      line_crossed: false,
      lineCrossed: false,
      justCrossed: false,
    });
  });
  return out;
}

/**
 * Line-cross once per visit. Pending until photo exists.
 * Same picture never creates another line event.
 */
function takeUnseenCrossedFaces(backendId, faces) {
  if (!backendId) return [];
  let map = recordedCrossKeys.get(backendId);
  if (!map) {
    map = new Map();
    recordedCrossKeys.set(backendId, map);
  }
  const out = [];
  (Array.isArray(faces) ? faces : []).forEach((f, idx) => {
    if (!Array.isArray(f?.box) || f.box.length < 4) return;
    const key = faceEventIdentityKey(f, idx);
    const motionKey = f.track_id != null ? `${backendId}:${String(f.track_id)}` : null;
    const prev = map.get(key);
    if (prev?.emitted) return;

    const visited = f.justCrossed === true
      || f.lineCrossed === true
      || f.line_crossed === true
      || (motionKey && crossedThisVisit.get(motionKey) === true)
      || Boolean(prev?.pending);
    if (!visited) return;

    if (!faceHasUsablePhoto(f)) {
      map.set(key, { emitted: false, pending: true, at: Date.now() });
      return;
    }
    if (!claimPhotoForTrack(f, key, 'line')) return;
    map.set(key, {
      emitted: true,
      pending: false,
      at: Date.now(),
      photo: facePhotoKey(f),
    });
    out.push({
      ...f,
      crossed: true,
      line_crossed: true,
      lineCrossed: true,
      justCrossed: true,
    });
  });
  return out;
}

function addStreamClient(ws, cameraId) {
  if (!streamClients.has(cameraId)) streamClients.set(cameraId, new Set());
  streamClients.get(cameraId).add(ws);
  ws.on('close', () => streamClients.get(cameraId)?.delete(ws));
  ws.on('error', () => streamClients.get(cameraId)?.delete(ws));
}

function broadcastFrame(cameraId, data) {
  const set = streamClients.get(cameraId);
  if (!set || !set.size) return;
  const msg = JSON.stringify(data);
  for (const ws of set) {
    if (ws.readyState === 1) {
      try { ws.send(msg); } catch { set.delete(ws); }
    }
  }
}

function stopFaceStreamLoop(cameraId) {
  streamLoops.get(cameraId)?.stop();
  streamLoops.delete(cameraId);
  frameCounters.delete(cameraId);
}

function isWorkerWarmingUpError(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  return msg.includes('no result yet')
    || msg.includes('stream running')
    || msg.includes('stream is not running')
    || msg.includes('not ready')
    || msg.includes('warming');
}

function buildFaceStreamStartBody(backendId, state, lineFields = {}) {
  return {
    camera_id: backendId,
    threshold: state.matchThreshold ?? 0.48,
    dis_type: Number(state.disType ?? state.dis_type ?? 0) || 0,
    capabilities: buildCapabilities(state),
    ...lineFields,
  };
}

function faceWorkerSourceOf(camera) {
  const localMediaEnabled = /^(1|true|yes|on)$/i.test(
    String(process.env.FRONTEND_LOCAL_MEDIAMTX || ''),
  );
  if (!localMediaEnabled) return '';
  if (!camera || camera.localMediaReady === false) return '';
  return String(
    camera.workerRtspUrl
      || camera.faceWorkerRtspUrl
      || '',
  ).trim();
}

/**
 * Point the board camera record at the frontend MediaMTX H.264 output before
 * starting face_worker.py. The public API accepts camera_id only, so the
 * worker resolves its RTSP input from this camera record.
 */
async function ensureFaceWorkerMediaSource(camera, backendId, options = {}) {
  const id = String(backendId || '').trim();
  const source = faceWorkerSourceOf(camera);
  if (!id) return { ok: false, error: 'Missing backend camera ID' };
  if (!source) {
    // Normal production path: Backend owns MediaMTX and already has the
    // camera's original URL/local_rtsp. Do not rewrite it to a frontend-local
    // proxy that the board may not be able to reach.
    return {
      ok: true,
      source: camera?.localRtsp || camera?.rtspUrl || null,
      backendManaged: true,
    };
  }

  if (!options.force && faceWorkerSources.get(id) === source) {
    return { ok: true, source, alreadySynced: true };
  }
  if (faceWorkerSourcePromises.has(id)) return faceWorkerSourcePromises.get(id);

  const pending = (async () => {
    try {
      await faceClient.apiJson(`/api/cameras/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: {
          type: 'rtsp',
          url: source,
        },
      });
      faceWorkerSources.set(id, source);
      cameraStore.updateCamera(camera.id, {
        faceWorkerRtspUrl: source,
        faceWorkerSourceError: null,
        faceWorkerSourceSyncedAt: new Date().toISOString(),
      });
      console.log('[face-live] face worker input -> local MediaMTX', {
        dashboardCameraId: camera.id,
        backendCameraId: id,
        rtsp: source,
      });
      return { ok: true, source, updated: true };
    } catch (err) {
      cameraStore.updateCamera(camera.id, {
        faceWorkerSourceError: err.message,
        faceWorkerSourceSyncedAt: null,
      });
      console.warn('[face-live] could not set MediaMTX face-worker input:', err.message);
      return { ok: false, source, error: err.message };
    }
  })();

  faceWorkerSourcePromises.set(id, pending);
  try {
    return await pending;
  } finally {
    if (faceWorkerSourcePromises.get(id) === pending) {
      faceWorkerSourcePromises.delete(id);
    }
  }
}

/**
 * Board has two layers:
 * 1) face_worker.py process  → POST /api/face/worker/start
 * 2) per-camera stream thread → POST /api/face/stream/start
 * stream/start alone returns OK even when face_worker is dead → boxes stay "No result yet".
 */
async function ensureBoardFaceProcess({ forceRestart = false } = {}) {
  if (!forceRestart && boardFaceProcessKnownRunning) {
    return { ok: true, alreadyRunning: true };
  }
  if (!forceRestart && boardFaceProcessStartPromise) {
    return boardFaceProcessStartPromise;
  }

  const pending = (async () => {
    try {
      if (forceRestart) {
        try {
          await faceClient.apiJson('/api/face/worker/stop', { method: 'POST', body: {} });
        } catch {
          /* ignore explicit restart stop errors */
        }
        boardFaceProcessKnownRunning = false;
      } else {
        try {
          const status = await faceClient.apiJson('/api/face/worker/status');
          if (status?.running) {
            boardFaceProcessKnownRunning = true;
            return { ok: true, alreadyRunning: true, status };
          }
        } catch (statusErr) {
          if (statusErr.status === 401 || statusErr.status === 403) throw statusErr;
          // A missing/not-yet-created worker is a normal cold-start state.
        }
      }

      console.log('[face-live] starting board face_worker process…');
      const started = await faceClient.apiJson('/api/face/worker/start', {
        method: 'POST',
        body: {},
      });
      // Process/model warm-up continues in the background.  The stream loop
      // handles the temporary "No result yet" response without blocking UI.
      boardFaceProcessKnownRunning = true;
      return { ok: true, starting: true, status: started };
    } catch (err) {
      boardFaceProcessKnownRunning = false;
      console.warn('[face-live] board face_worker process start failed:', err.message);
      return { ok: false, error: err.message };
    }
  })();

  boardFaceProcessStartPromise = pending;
  try {
    return await pending;
  } finally {
    if (boardFaceProcessStartPromise === pending) boardFaceProcessStartPromise = null;
  }
}

/** Ensure face_worker process + camera stream thread. Avoid stream start-spam mid-boot. */
async function ensureFaceWorkerRunning(cameraId, backendId, { forceRestart = false } = {}) {
  const camera = cameraStore.getCamera(cameraId);
  const state = detectionStore.getModelState(FACE_SLUG);
  if (!backendId || !camera) return { ok: false, error: 'Missing camera/backendId' };
  hydrateTripwireFromCamera(cameraId, backendId);
  const lineFields = hasLineSegment(backendId)
    ? toWorkerLineFields(getRememberedLine(backendId))
    : {};
  const body = buildFaceStreamStartBody(backendId, state, lineFields);

  try {
    const source = await ensureFaceWorkerMediaSource(camera, backendId);
    if (!source.ok) {
      return {
        ok: false,
        error: `Face worker MediaMTX source failed: ${source.error}`,
      };
    }

    const proc = await ensureBoardFaceProcess({ forceRestart: false });
    if (!proc.ok) {
      return { ok: false, error: proc.error || 'Board face_worker offline' };
    }

    if (forceRestart) {
      try {
        await faceClient.apiJson('/api/face/stream/stop', {
          method: 'POST',
          body: { camera_id: backendId },
        });
      } catch {
        /* ignore stop errors */
      }
    }
    await faceClient.apiJson('/api/face/stream/start', { method: 'POST', body });
    console.log('[face-live] board face stream start OK', backendId, {
      forceRestart,
      processWasRunning: Boolean(proc.alreadyRunning),
      rtsp: source.source,
    });
    return { ok: true, lineFields, processStarting: Boolean(proc.starting) };
  } catch (err) {
    console.warn('[face-live] board face stream start failed:', err.message);
    return { ok: false, error: err.message };
  }
}

async function restartFaceStreamOnBoard(cameraId, backendId) {
  const res = await ensureFaceWorkerRunning(cameraId, backendId, { forceRestart: true });
  return Boolean(res.ok);
}

function startFaceStreamLoop(cameraId, backendId) {
  stopFaceStreamLoop(cameraId);
  const loop = {
    stopped: false,
    lastEventAt: 0,
    failStreak: 0,
    lastRestartAt: 0,
    lastProcessCheckAt: 0,
  };
  frameCounters.set(cameraId, 0);

  async function tick() {
    if (loop.stopped) return;
    const state = detectionStore.getModelState(FACE_SLUG);
    if (!isFaceCameraRunning(cameraId)) {
      loop.stopped = true;
      return;
    }

    let delayMs = facePollMs(state);
    try {
      hydrateTripwireFromCamera(cameraId, backendId);

      let mapped = {
        faces: [],
        frame_w: 1920,
        frame_h: 1080,
        capture_ts: Date.now(),
        line_enabled: false,
      };
      let boxesOk = false;
      try {
        const boxData = await faceClient.apiJson(
          `/api/face/stream/boxes/${encodeURIComponent(backendId)}`,
        );
        mapped = mapBoxesToFaces(boxData);
        boxesOk = true;
        loop.failStreak = 0;
      } catch (boxErr) {
        loop.failStreak += 1;
        const warming = isWorkerWarmingUpError(boxErr);
        // While warming up, wait patiently — do NOT spam start (that kills the worker).
        delayMs = warming
          ? Math.max(600, delayMs)
          : Math.min(3000, 250 * Math.max(1, loop.failStreak));
        if (loop.failStreak === 1 || loop.failStreak % 20 === 0) {
          console.warn(
            warming
              ? '[face-live] face worker still starting…'
              : '[face-live] boxes poll failed:',
            boxErr.message,
          );
        }
        const nowRs = Date.now();
        // An empty scene / model warm-up is valid and must never restart every
        // other camera. Only hard, repeated failures restart this stream.
        if (warming && loop.failStreak >= 20 && nowRs - loop.lastProcessCheckAt > 30000) {
          loop.lastProcessCheckAt = nowRs;
          try {
            const status = await faceClient.apiJson('/api/face/worker/status');
            if (!status?.running) {
              boardFaceProcessKnownRunning = false;
              await ensureFaceWorkerRunning(cameraId, backendId, { forceRestart: false });
            }
          } catch {
            boardFaceProcessKnownRunning = false;
            await ensureFaceWorkerRunning(cameraId, backendId, { forceRestart: false });
          }
        } else if (!warming && loop.failStreak >= 25 && nowRs - loop.lastRestartAt > 30000) {
          loop.lastRestartAt = nowRs;
          boardFaceProcessKnownRunning = false;
          console.warn('[face-live] restarting one face stream after prolonged failure');
          await restartFaceStreamOnBoard(cameraId, backendId);
          loop.failStreak = 0;
        }
      }

      const lineActive = await isTripwireActive(
        backendId,
        Boolean(mapped.line_enabled),
        cameraId,
      );
      const trackedFaces = hasLineSegment(backendId)
        ? annotateLocalCrossings(backendId, mapped.faces)
        : mapped.faces;

      const frameId = (frameCounters.get(cameraId) || 0) + 1;
      frameCounters.set(cameraId, frameId);
      if (boxesOk || trackedFaces.length) {
        broadcastFrame(cameraId, {
          frame_id: frameId,
          faces: trackedFaces,
          frame_w: mapped.frame_w,
          frame_h: mapped.frame_h,
          capture_ts: mapped.capture_ts,
          server_ts: Date.now(),
          line_enabled: lineActive || hasLineSegment(backendId),
        });
      }

      const now = Date.now();
      if (now - loop.lastEventAt >= FACE_EVENT_POLL_MS) {
        loop.lastEventAt = now;
        const camera = cameraStore.getCamera(cameraId);
        if (camera) {
          let recognitionFaces = [];
          try {
            const result = await faceClient.apiJson(
              `/api/face/stream/result/${encodeURIComponent(backendId)}`,
            );
            recognitionFaces = await enrichRecognitionFaces(
              mapResultFaces(result, mapped.frame_w, mapped.frame_h),
            );
            if (recognitionFaces.length) loop.failStreak = 0;
          } catch (err) {
            if (err.status !== 404 && (loop.failStreak <= 1 || loop.failStreak % 15 === 0)) {
              console.warn('[face-live] stream result:', err.message);
            }
          }

          const merged = await enrichEventFaces(
            mergeBoxesWithRecognition(trackedFaces, recognitionFaces),
          );
          touchCrossTrackPresence(
            backendId,
            trackedFaces.length ? trackedFaces : recognitionFaces,
          );

          // Face recognition: prefer boxes+crops; fall back to recognition-only if boxes are down.
          const candidates = merged.length ? merged : recognitionFaces;

          let eventFaces = [];
          if (hasLineSegment(backendId)) {
            const crossFaces = takeUnseenCrossedFaces(backendId, candidates);
            const faceDetectFaces = takeUnseenFaceDetectFaces(backendId, candidates);
            eventFaces = [...crossFaces, ...faceDetectFaces];
            if (crossFaces.length) {
              console.log('[FaceTripwire] recording CROSS event(s)', {
                count: crossFaces.length,
                backendId,
              });
            }
          } else {
            eventFaces = takeUnseenFaceDetectFaces(backendId, candidates);
          }

          ingestUnknownFacesIntoClusters(camera, recognitionFaces);

          if (!eventFaces.length && candidates.length && (loop.failStreak <= 1 || Date.now() % 40 === 0)) {
            const sample = candidates[0] || {};
            // Occasional breadcrumb while debugging empty Event feed.
            if (!faceHasUsablePhoto(sample)) {
              // keep quiet most frames — crop still downloading
            }
          }

          if (eventFaces.length) {
            const { newEvents: evts } = await detectionStore.recordFaceDetection(
              camera,
              scopeFaceTrackIds(cameraId, eventFaces),
              {},
            );
            if (evts?.length) {
              const lineN = evts.filter(
                (e) => e.lineCrossed || e.eventType === 'line-crossed',
              ).length;
              console.log('[face-live] events stored', {
                total: evts.length,
                face: evts.length - lineN,
                line: lineN,
              });
              broadcastFaceUpdate(detectionStore.getPayload(FACE_SLUG), evts, {
                faceDatabase: {
                  statistics: faceStore.getStatistics(),
                  recentAlerts: faceStore.listAlerts({ status: 'active' }).slice(0, 5),
                },
              });
            } else {
              console.warn('[face-live] recordFaceDetection returned 0 events', {
                candidates: eventFaces.length,
                hasJpeg: eventFaces.map((f) => Boolean(f.crop_jpeg)),
                scores: eventFaces.map((f) => f.detection_score ?? f.score),
              });
            }
          }
        }
      }
    } catch (err) {
      loop.failStreak += 1;
      delayMs = Math.min(2500, 200 * loop.failStreak);
      if (err.status !== 404 && (loop.failStreak === 1 || loop.failStreak % 15 === 0)) {
        console.warn('[face-live] stream loop:', err.message, err.cause?.message || '');
      }
    }

    if (!loop.stopped) setTimeout(tick, Math.max(FACE_MIN_POLL_MS, delayMs));
  }

  loop.stop = () => { loop.stopped = true; };
  streamLoops.set(cameraId, loop);
  tick();
}

function sanitizeCam(camera) {
  if (!camera) return null;
  const { validation, password, ...rest } = camera;
  return { ...rest, hasCredentials: Boolean(camera.username || password) };
}

function usingLocalFaceBackend() {
  return Boolean(process.env.VISION_FACE_API_URL);
}

function backendCameraId(camera, state, cameraId = camera?.id) {
  if (usingLocalFaceBackend()) {
    return camera?.faceBackendId
      || state?.backendCameraIds?.[cameraId]
      || (state?.activeCameraId === cameraId ? state?.backendCameraId : null)
      || null;
  }
  return camera?.backendId
    || state?.backendCameraIds?.[cameraId]
    || (state?.activeCameraId === cameraId ? state?.backendCameraId : null)
    || null;
}

function buildCapabilities(state) {
  const caps = ['face_detection'];
  if (state.features?.genderClassification) caps.push('gender_classification');
  if (state.features?.faceRecognition !== false) caps.push('face_recognition');
  return caps;
}

async function resolveBackendId(cameraId) {
  const camera = cameraStore.getCamera(cameraId);
  const state = detectionStore.getModelState(FACE_SLUG);
  if (!camera) return { camera: null, backendId: null };
  const ensured = await ensureFaceBackendCamera(camera);
  return {
    camera: ensured,
    backendId: backendCameraId(ensured, state, cameraId),
  };
}

async function getLineConfig(cameraId) {
  const { camera, backendId } = await resolveBackendId(cameraId);
  if (!backendId) return { ok: false, error: 'Camera has no board ID', enabled: false };
  hydrateTripwireFromCamera(cameraId, backendId);
  if (!(await faceClient.isReachable())) {
    const remembered = savedLineByBackend.get(backendId) || camera?.faceTripwire;
    if (remembered?.line_x1 != null) {
      return {
        ok: true,
        enabled: true,
        line_x1: remembered.line_x1,
        line_y1: remembered.line_y1,
        line_x2: remembered.line_x2,
        line_y2: remembered.line_y2,
        direction: remembered.direction || 'in',
        dashboardCameraId: cameraId,
        backendCameraId: backendId,
        offline: true,
      };
    }
    return { ok: false, error: 'Vision board offline', enabled: false, camera_id: backendId };
  }
  try {
    console.log('[FaceTripwire] dashboard GET line-config', { dashboardCameraId: cameraId, backendId });
    const data = await faceClient.apiJson(
      `/api/face/stream/line-config/${encodeURIComponent(backendId)}`,
    );
    console.log('[FaceTripwire] board GET line-config OK', data);
    const resolved = resolveLineForWorker(backendId, data);
    if (resolved?.enabled && resolved.line_x1 != null) {
      rememberSavedLine(backendId, resolved);
      persistCameraTripwire(cameraId, resolved);
      return {
        ok: true,
        camera_id: data.camera_id || backendId,
        enabled: true,
        line_x1: resolved.line_x1,
        line_y1: resolved.line_y1,
        line_x2: resolved.line_x2,
        line_y2: resolved.line_y2,
        direction: resolved.direction,
        dashboardCameraId: cameraId,
        backendCameraId: backendId,
        boardRaw: data,
      };
    }
    // Board disabled — still return dashboard-persisted tripwire if present.
    const local = hydrateTripwireFromCamera(cameraId, backendId);
    if (local?.line_x1 != null) {
      return {
        ok: true,
        camera_id: data.camera_id || backendId,
        enabled: true,
        line_x1: local.line_x1,
        line_y1: local.line_y1,
        line_x2: local.line_x2,
        line_y2: local.line_y2,
        direction: local.direction || 'in',
        dashboardCameraId: cameraId,
        backendCameraId: backendId,
        boardRaw: data,
        dashboardOnly: true,
      };
    }
    return {
      ok: true,
      camera_id: data.camera_id || backendId,
      enabled: false,
      line_x1: null,
      line_y1: null,
      line_x2: null,
      line_y2: null,
      dashboardCameraId: cameraId,
      backendCameraId: backendId,
      boardRaw: data,
    };
  } catch (err) {
    console.warn('[FaceTripwire] board GET line-config failed', err.message);
    const remembered = savedLineByBackend.get(backendId) || hydrateTripwireFromCamera(cameraId, backendId);
    if (remembered?.line_x1 != null) {
      return {
        ok: true,
        enabled: true,
        line_x1: remembered.line_x1,
        line_y1: remembered.line_y1,
        line_x2: remembered.line_x2,
        line_y2: remembered.line_y2,
        direction: remembered.direction || 'in',
        dashboardCameraId: cameraId,
        backendCameraId: backendId,
      };
    }
    return { ok: false, error: err.message, enabled: false, camera_id: backendId };
  }
}

async function setLineConfig(cameraId, body) {
  const { camera, backendId } = await resolveBackendId(cameraId);
  if (!backendId) return { ok: false, error: 'Camera has no board ID' };
  const putBody = toBoardPutBody(body || {});
  const localNorm = normalizeBoardLineConfig(putBody);
  // Always remember locally first — board may be flaky or ignore enabled.
  if (localNorm?.line_x1 != null) {
    rememberSavedLine(backendId, { ...localNorm, enabled: true });
    persistCameraTripwire(cameraId, { ...localNorm, enabled: true });
  }
  if (!(await faceClient.isReachable())) {
    if (localNorm?.line_x1 != null) {
      return {
        ok: true,
        camera_id: backendId,
        enabled: true,
        line_x1: localNorm.line_x1,
        line_y1: localNorm.line_y1,
        line_x2: localNorm.line_x2,
        line_y2: localNorm.line_y2,
        dashboardCameraId: cameraId,
        backendCameraId: backendId,
        offline: true,
      };
    }
    return { ok: false, error: 'Vision board offline' };
  }
  try {
    console.log('[FaceTripwire] dashboard PUT line-config', { dashboardCameraId: cameraId, backendId, putBody });
    const data = await faceClient.apiJson(
      `/api/face/stream/line-config/${encodeURIComponent(backendId)}`,
      { method: 'PUT', body: putBody },
    );
    console.log('[FaceTripwire] board PUT line-config OK', data);
    if (localNorm?.line_x1 != null) {
      rememberSavedLine(backendId, { ...localNorm, enabled: true });
      persistCameraTripwire(cameraId, { ...localNorm, enabled: true });
    } else {
      const fromBoard = normalizeBoardLineConfig(data);
      if (fromBoard?.line_x1 != null) {
        rememberSavedLine(backendId, { ...fromBoard, enabled: true });
        persistCameraTripwire(cameraId, { ...fromBoard, enabled: true });
      }
    }
    recordedCrossKeys.delete(backendId);
    crossTrackLastSeenAt.delete(backendId);
    clearLocalCrossingState(backendId);
    const saved = savedLineByBackend.get(backendId) || localNorm;
    return {
      ok: true,
      camera_id: backendId,
      enabled: true,
      line_x1: saved?.line_x1,
      line_y1: saved?.line_y1,
      line_x2: saved?.line_x2,
      line_y2: saved?.line_y2,
      hotUpdated: Boolean(data.hot_updated),
      restarted: false,
      restartError: null,
      dashboardCameraId: cameraId,
      backendCameraId: backendId,
      boardRaw: data,
    };
  } catch (err) {
    console.warn('[FaceTripwire] board PUT line-config failed', err.message);
    // Keep dashboard tripwire even if board PUT fails.
    if (localNorm?.line_x1 != null) {
      return {
        ok: true,
        camera_id: backendId,
        enabled: true,
        line_x1: localNorm.line_x1,
        line_y1: localNorm.line_y1,
        line_x2: localNorm.line_x2,
        line_y2: localNorm.line_y2,
        dashboardCameraId: cameraId,
        backendCameraId: backendId,
        boardError: err.message,
      };
    }
    return { ok: false, error: err.message };
  }
}

async function clearLineConfig(cameraId) {
  const { camera, backendId } = await resolveBackendId(cameraId);
  if (!backendId) return { ok: false, error: 'Camera has no board ID' };
  clearCameraTripwire(cameraId);
  savedLineByBackend.delete(backendId);
  invalidateTripwireCache(backendId);
  recordedCrossKeys.delete(backendId);
  crossTrackLastSeenAt.delete(backendId);
  clearLocalCrossingState(backendId);
  if (!(await faceClient.isReachable())) {
    return { ok: true, dashboardCameraId: cameraId, backendCameraId: backendId, offline: true };
  }
  try {
    console.log('[FaceTripwire] dashboard DELETE line-config', { dashboardCameraId: cameraId, backendId });
    const data = await faceClient.apiJson(
      `/api/face/stream/line-config/${encodeURIComponent(backendId)}`,
      { method: 'DELETE' },
    );
    console.log('[FaceTripwire] board DELETE line-config OK', data);
    return {
      ok: true,
      ...data,
      hotUpdated: Boolean(data.hot_updated),
      restarted: false,
      restartError: null,
      dashboardCameraId: cameraId,
      backendCameraId: backendId,
    };
  } catch (err) {
    console.warn('[FaceTripwire] board DELETE line-config failed', err.message);
    return { ok: true, dashboardCameraId: cameraId, backendCameraId: backendId, boardError: err.message };
  }
}

async function ensureFaceBackendCamera(camera) {
  if (!usingLocalFaceBackend()) return camera;

  const name = camera?.name || 'camera';
  const rtsp = camera?.rtspUrl || camera?.url || camera?.streamUrl || '';
  if (!rtsp) return camera;

  const configuredHost = process.env.VISION_PUBLIC_HOST
    || process.env.MEDIA_PUBLIC_HOST
    || process.env.BOARD_PUBLIC_HOST
    || process.env.BOARD_IP
    || '';
  let host = '';
  try {
    host = configuredHost
      ? new URL(configuredHost.includes('://') ? configuredHost : `http://${configuredHost}`).hostname
      : new URL(faceClient.BASE).hostname;
  } catch {
    host = configuredHost || 'localhost';
  }
  const mediaProtocol = (process.env.MEDIA_PUBLIC_PROTOCOL || 'http').replace(/:$/, '');

  const mediaPatch = (id, created = {}) => ({
    faceBackendId: id,
    faceWhepUrl: normalizeMediaUrl(
      created?.whep_url || created?.whepUrl || `${mediaProtocol}://${host}:8889/${id}/whep`,
    ),
    faceHlsUrl: normalizeMediaUrl(
      created?.hls_url || created?.hlsUrl || `${mediaProtocol}://${host}:8888/${id}/index.m3u8`,
    ),
    faceLocalRtsp: created?.local_rtsp
      || created?.localRtsp
      || `rtsp://${host}:${process.env.MEDIAMTX_RTSP_PORT || 8554}/${id}`,
  });

  // A registered camera must not be registered again just because an older
  // record did not contain browser playback URLs.
  if (camera?.faceBackendId) {
    if (camera.faceWhepUrl && camera.faceHlsUrl) return camera;
    return cameraStore.updateCamera(
      camera.id,
      mediaPatch(camera.faceBackendId),
    ) || camera;
  }

  try {
    const created = await faceClient.apiJson('/api/cameras', {
      method: 'POST',
      body: {
        name,
        type: 'rtsp',
        url: rtsp,
        username: camera?.username || undefined,
        password: camera?.password || undefined,
        location: camera?.location || undefined,
        zone: camera?.zone || undefined,
        floor: camera?.floor || camera?.zoneFloor || undefined,
        department: camera?.department || undefined,
      },
    });

    const id = created?.id || null;
    if (!id) return camera;

    const patch = mediaPatch(id, created);
    return cameraStore.updateCamera(camera.id, patch) || camera;
  } catch (err) {
    console.warn('[face-live] local camera register failed:', err.message);
    return camera;
  }
}

/** Convert board /stream/boxes payload → normalized xyxy boxes for overlay. */
function mapBoxesToFaces(data) {
  const fw = data.frame_width || 1920;
  const fh = data.frame_height || 1080;
  const lineOn = Boolean(data.line_enabled);
  // Keep every detection — tripwire gating happens after local cross annotate.
  const faces = (data.boxes || []).map((b, idx) => {
    const n = b.box_normalized;
    let box = null;
    if (n && Number.isFinite(n.x)) {
      box = [n.x, n.y, n.x + n.w, n.y + n.h];
    } else if (b.box) {
      const { x, y, w, h } = b.box;
      box = [x / fw, y / fh, (x + w) / fw, (y + h) / fh];
    }
    const isKnown = Boolean(b.is_known && (b.person_id || b.name));
    // NEVER fall back to array index as track_id — slot 0/1/2 gets reused by the next person
    // and falsely drops them as "already emitted".
    const trackId = b.track_id ?? b.trackId ?? null;
    return {
      box,
      // Board `score` on boxes is detection confidence for all_detections.
      detection_score: b.detection_score ?? b.score ?? 0.9,
      match_score: b.match_score ?? (isKnown ? b.score : null),
      gender: b.gender || null,
      track_id: trackId,
      is_known: isKnown,
      match: isKnown
        ? { person_id: b.person_id || null, name: b.name || null, score: b.match_score ?? null }
        : null,
      crop_filename: b.crop_filename || null,
      crop_jpeg: b.crop_jpeg || null,
      crossed: b.crossed === true,
      frame_w: fw,
      frame_h: fh,
    };
  }).filter((f) => Boolean(f.box));

  return {
    faces,
    frame_w: fw,
    frame_h: fh,
    line_enabled: lineOn,
    capture_ts: data.updated_at ? new Date(data.updated_at).getTime() : Date.now(),
  };
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

/** Attach recognition crops / identity onto every live overlay bbox. */
function mergeBoxesWithRecognition(boxFaces, recognitionFaces) {
  const recog = Array.isArray(recognitionFaces) ? recognitionFaces : [];
  const used = new Set();
  const merged = (Array.isArray(boxFaces) ? boxFaces : []).map((face) => {
    let best = null;
    let bestScore = 0;
    for (let i = 0; i < recog.length; i += 1) {
      if (used.has(i)) continue;
      const r = recog[i];
      const sameTrack = face.track_id != null && r.track_id != null
        && String(face.track_id) === String(r.track_id);
      const iou = boxIou(face.box, r.box);
      // Prefer track match; otherwise require a real spatial overlap.
      const score = sameTrack ? 1.5 : iou;
      if (score >= (sameTrack ? 1.5 : 0.05) && score >= bestScore) {
        bestScore = score;
        best = { face: r, idx: i };
        if (sameTrack) break;
      }
    }
    if (!best) return face;
    used.add(best.idx);
    const r = best.face;
    const isKnown = Boolean(r.is_known && r.match) || Boolean(face.is_known && face.match);
    return {
      ...face,
      ...r,
      box: face.box || r.box,
      track_id: face.track_id ?? r.track_id,
      // Crossing flags live on the tracked box — never let recognition overwrite them.
      justCrossed: face.justCrossed === true,
      crossed: face.crossed === true || face.justCrossed === true,
      line_crossed: face.line_crossed === true || face.justCrossed === true,
      lineCrossed: face.lineCrossed === true || face.justCrossed === true,
      detection_score: face.detection_score ?? r.detection_score ?? 0.9,
      crop_jpeg: r.crop_jpeg || face.crop_jpeg || null,
      crop_filename: r.crop_filename || face.crop_filename || null,
      is_known: isKnown,
      match: r.match || face.match || null,
      match_score: r.match_score ?? face.match_score ?? null,
      frame_w: face.frame_w || r.frame_w,
      frame_h: face.frame_h || r.frame_h,
    };
  });

  // Unmatched recognition crops only when tripwire is OFF (caller decides).
  // Adding orphans while tripwire is on duplicates the same photo as a 2nd event.
  for (let i = 0; i < recog.length; i += 1) {
    if (used.has(i)) continue;
    const r = recog[i];
    if (!r?.crop_jpeg && !r?.crop_filename) continue;
    // Skip orphans that already have a justCrossed match nearby — box merge missed IoU.
    if (r.justCrossed === true || r.crossed === true) continue;
    merged.push({
      ...r,
      detection_score: r.detection_score ?? 0.85,
      track_id: r.track_id ?? `recog-${i}`,
      justCrossed: false,
      crossed: false,
      line_crossed: false,
      lineCrossed: false,
    });
  }
  return merged;
}

/** Map /stream/result faces for event layer only (recognition). */
function mapResultFaces(result, frameW = 1920, frameH = 1080) {
  const fw = result.frame_width || result.frame_w || frameW || 1920;
  const fh = result.frame_height || result.frame_h || frameH || 1080;
  return (result.faces || []).map((f) => {
    // Board returns pixel xywh — normalize to xyxy 0–1 so IoU merge with overlay boxes works.
    let box = null;
    if (Array.isArray(f.box) && f.box.length >= 4) {
      const [a, b, c, d] = f.box.map(Number);
      if ([a, b, c, d].every((v) => Number.isFinite(v))) {
        const looksNorm = [a, b, c, d].every((v) => v >= 0 && v <= 1.05) && c > a && d > b;
        if (looksNorm) {
          box = [a, b, c, d];
        } else if (c > a && d > b && (c > fw * 0.5 || d > fh * 0.5) && c <= fw + 2 && d <= fh + 2) {
          // pixel xyxy
          box = [a / fw, b / fh, c / fw, d / fh];
        } else {
          // pixel xywh (face_worker default)
          box = [a / fw, b / fh, (a + c) / fw, (b + d) / fh];
        }
      }
    }
    const isKnown = Boolean(f.is_known && (f.match || f.person_id));
    const matchScore = isKnown ? (f.match_score ?? f.score ?? null) : null;
    const detectionScore = f.detection_score
      ?? (isKnown ? null : (f.score ?? 0.85));
    return {
      ...f,
      box,
      is_known: isKnown,
      match: f.match || (f.person_id ? { person_id: f.person_id, name: f.name } : null),
      match_score: matchScore,
      detection_score: detectionScore,
      // face_worker correlates detect/recognize with event_uuid. Preserve it
      // as the stable visit ID instead of guessing identity from screen position.
      track_id: f.track_id ?? f.trackId ?? f.event_uuid ?? null,
      crop_filename: f.crop_filename || null,
      crossed: f.crossed === true,
      frame_w: fw,
      frame_h: fh,
    };
  });
}

async function fetchBoardCropJpeg(cropFilename) {
  if (!cropFilename) return null;
  if (boardCropCache.has(cropFilename)) return boardCropCache.get(cropFilename);
  if (boardCropPromises.has(cropFilename)) return boardCropPromises.get(cropFilename);

  const pending = (async () => {
    try {
      // Board serves crops as static files at /crops/<filename>
      const res = await faceClient.apiFetch(`/crops/${encodeURIComponent(cropFilename)}`);
      if (!res.ok) {
        console.warn('[face-live] crop HTTP', res.status, cropFilename);
        return null;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length || buf.length < 64) return null;
      // Reject HTML/error pages accidentally returned as "image"
      const head = buf.slice(0, 3).toString('hex');
      if (head !== 'ffd8ff' && buf.slice(0, 8).toString() !== '\x89PNG\r\n\x1a\n') {
        console.warn('[face-live] crop not an image:', cropFilename);
        return null;
      }
      const jpeg = buf.toString('base64');
      boardCropCache.set(cropFilename, jpeg);
      if (boardCropCache.size > 120) {
        boardCropCache.delete(boardCropCache.keys().next().value);
      }
      return jpeg;
    } catch (err) {
      console.warn('[face-live] crop fetch failed:', err.message);
      return null;
    }
  })();
  boardCropPromises.set(cropFilename, pending);
  try {
    return await pending;
  } finally {
    if (boardCropPromises.get(cropFilename) === pending) {
      boardCropPromises.delete(cropFilename);
    }
  }
}

/**
 * Feed unknown faces into dashboard clusters (same person → one named bunch).
 */
function ingestUnknownFacesIntoClusters(camera, recognitionFaces) {
  if (!camera || !Array.isArray(recognitionFaces) || !recognitionFaces.length) return 0;
  const now = Date.now();
  let changed = 0;
  for (const face of recognitionFaces) {
    if (face?.is_known) continue;
    const emb = face.embedding;
    let jpeg = face.crop_jpeg;
    if (jpeg && typeof jpeg === 'string' && jpeg.startsWith('data:image')) {
      jpeg = jpeg.replace(/^data:image\/\w+;base64,/, '');
    }
    if (!Array.isArray(emb) || emb.length < 64) continue;

    const tid = face.track_id != null ? String(face.track_id) : `emb-${Math.round(emb[0] * 1000)}`;
    const key = `${camera.id}:${tid}`;
    const last = clusterIngestAt.get(key) || 0;
    if (now - last < CLUSTER_INGEST_MS) continue;
    clusterIngestAt.set(key, now);
    if (clusterIngestAt.size > 400) {
      const first = clusterIngestAt.keys().next().value;
      clusterIngestAt.delete(first);
    }

    try {
      const cluster = faceClusterStore.ingestUnknownFace({
        embedding: emb,
        cropJpeg: jpeg || null,
        cameraId: camera.id,
        cameraName: camera.name,
        score: face.detection_score ?? face.score ?? null,
        gender: face.gender || null,
        trackId: tid,
      });
      if (cluster) changed += 1;
    } catch (err) {
      console.warn('[face-live] cluster ingest:', err.message);
    }
  }
  if (changed) {
    // Cluster cards/photos are fetched separately by the browser. Notify it
    // immediately; otherwise they only appeared after another event/reload.
    broadcastFaceUpdate(detectionStore.getPayload(FACE_SLUG), [], {
      clustersUpdated: true,
    });
  }
  return changed;
}

async function enrichRecognitionFaces(faces) {
  return Promise.all((Array.isArray(faces) ? faces : []).map(async (face) => {
    let crop_jpeg = face.crop_jpeg || null;
    if ((!crop_jpeg || crop_jpeg.length < 64) && face.crop_filename) {
      crop_jpeg = await fetchBoardCropJpeg(face.crop_filename);
    }
    return { ...face, crop_jpeg: crop_jpeg || face.crop_jpeg || null };
  }));
}

/** Enrich every live face (boxes + recognition) so events always get a photo when board has one. */
async function enrichEventFaces(faces) {
  return enrichRecognitionFaces(faces);
}

async function selectCamera(cameraId) {
  let camera = cameraStore.getCamera(cameraId);
  if (!camera) return { ok: false, error: 'Camera not found' };

  const state = detectionStore.getModelState(FACE_SLUG);
  const keepRunning = isFaceCameraRunning(cameraId);

  camera = await ensureFaceBackendCamera(camera);
  if (!usingLocalFaceBackend()) {
    camera = await ensureBoardCamera(camera, { startStream: false }) || camera;
  } else {
    // Face inference may use a separate API, but browser playback must still
    // use the frontend machine's original MediaMTX pipeline.
    camera = await attachLocalPlayback(camera) || camera;
  }
  const backendId = backendCameraId(camera, state, cameraId);
  const reachable = await faceClient.isReachable();
  const live = getLiveViewPayload(camera);

  const backendCameraIds = { ...(state.backendCameraIds || {}) };
  const streamModes = { ...(state.streamModes || {}) };
  if (backendId) backendCameraIds[cameraId] = backendId;
  streamModes[cameraId] = backendId && reachable ? 'backend' : 'preview';
  detectionStore.saveModelState(FACE_SLUG, {
    activeCameraId: cameraId,
    runningCameraIds: state.runningCameraIds,
    inferenceRunning: state.runningCameraIds.length > 0,
    streamMode: backendId && reachable ? 'backend' : 'preview',
    backendCameraId: backendId,
    backendCameraIds,
    streamModes,
  });

  // If recognition was already running, ensure the stream loop is still attached.
  if (keepRunning && backendId) {
    const loop = streamLoops.get(cameraId);
    if (!loop || loop.stopped) {
      startFaceStreamLoop(cameraId, backendId);
    }
  }

  const hlsUrl = normalizeMediaUrl(camera.hlsUrl || camera.faceHlsUrl || null);
  const whepUrl = normalizeMediaUrl(camera.whepUrl || camera.faceWhepUrl || null);

  return {
    ok: true,
    camera: sanitizeCam(camera),
    preview: live.preview,
    backendReachable: reachable,
    hasStreamUrl: Boolean(live.preview?.whepUrl || live.preview?.hlsUrl || camera.rtspUrl),
    backendCameraId: backendId,
    inferenceRunning: keepRunning,
    hlsUrl: hlsUrl || live.preview?.hlsUrl || null,
    whepUrl: whepUrl || live.preview?.whepUrl || null,
    mjpegUrl: live.preview?.mjpegUrl || null,
    payload: detectionStore.getPayload(FACE_SLUG),
    streamSync: { synced: Boolean(backendId), backendId },
  };
}

async function startLive(cameraId) {
  if (startPromises.has(cameraId)) return startPromises.get(cameraId);
  const pending = startLiveInternal(cameraId).finally(() => startPromises.delete(cameraId));
  startPromises.set(cameraId, pending);
  return pending;
}

async function startLiveInternal(cameraId) {
  let camera = cameraStore.getCamera(cameraId);
  if (!camera) return { ok: false, error: 'Camera not found' };

  if (!(await faceClient.isReachable())) {
    return {
      ok: false,
      error: 'Vision board offline — start backend on the board',
      backendError: 'Vision board offline',
      backendConnected: false,
      payload: detectionStore.getPayload(FACE_SLUG),
    };
  }

  camera = await ensureFaceBackendCamera(camera);
  if (!usingLocalFaceBackend()) {
    // Starting recognition must not tear down the MediaMTX path currently
    // feeding the browser. The camera was already registered/synchronized;
    // only ensure its board mapping here.
    camera = await ensureBoardCamera(camera, { startStream: false }) || camera;
  } else {
    camera = await attachLocalPlayback(camera) || camera;
  }
  const backendId = backendCameraId(
    camera,
    detectionStore.getModelState(FACE_SLUG),
    cameraId,
  );
  if (!backendId) {
    return {
      ok: false,
      error: 'Camera has no board ID (backendId) — re-register camera on board',
      backendError: 'Missing backend camera ID',
      backendConnected: false,
      payload: detectionStore.getPayload(FACE_SLUG),
    };
  }

  const state = detectionStore.getModelState(FACE_SLUG);
  const caps = buildCapabilities(state);

  const existingLoop = streamLoops.get(cameraId);
  if (isFaceCameraRunning(cameraId) && existingLoop && !existingLoop.stopped) {
    const live = getLiveViewPayload(camera);
    return {
      ok: true,
      alreadyRunning: true,
      backendConnected: true,
      backendCameraId: backendId,
      inferenceRunning: true,
      preview: live.preview,
      hlsUrl: normalizeMediaUrl(camera.hlsUrl || camera.faceHlsUrl || null),
      whepUrl: normalizeMediaUrl(camera.whepUrl || camera.faceWhepUrl || null),
      mjpegUrl: live.preview?.mjpegUrl || null,
      wsUrl: `/ws/face-live?cameraId=${encodeURIComponent(cameraId)}`,
      payload: detectionStore.getPayload(FACE_SLUG),
    };
  }

  let lineFields = {};
  let resolved = hydrateTripwireFromCamera(cameraId, backendId);
  try {
    // Dashboard-persisted config is already authoritative. Fetch from the
    // board only when this camera has no local saved segment.
    if (!resolved) {
      const lineCfg = await faceClient.apiJson(
        `/api/face/stream/line-config/${encodeURIComponent(backendId)}`,
      );
      resolved = resolveLineForWorker(backendId, lineCfg);
    }
    if (resolved?.enabled && resolved.line_x1 != null) {
      rememberSavedLine(backendId, resolved);
      persistCameraTripwire(cameraId, resolved);
      lineFields = toWorkerLineFields(resolved);
    } else {
      tripwireCache.set(backendId, { enabled: false, at: Date.now() });
    }
  } catch (err) {
    const remembered = hydrateTripwireFromCamera(cameraId, backendId) || savedLineByBackend.get(backendId);
    if (remembered) {
      console.warn('[FaceTripwire] line-config fetch failed — using dashboard tripwire', err.message);
      rememberSavedLine(backendId, remembered);
      lineFields = toWorkerLineFields(remembered);
    } else if (err.status !== 404) {
      console.warn('[face-live] line-config fetch:', err.message);
    }
  }

  console.log('[FaceTripwire] startLive ensuring face worker', {
    camera_id: backendId,
    threshold: state.matchThreshold ?? 0.48,
    capabilities: caps,
    lineFields,
    rtsp: camera.rtspUrl || null,
  });

  // Start once and return immediately. Model/RTSP warm-up is handled by the
  // background loop; it is not a failed start and must not trigger a global
  // process restart.
  clearLocalCrossingState(backendId);
  const started = await ensureFaceWorkerRunning(cameraId, backendId, { forceRestart: false });
  if (!started.ok) {
    return {
      ok: false,
      error: started.error || 'Could not start face worker on board',
      backendError: started.error || 'Worker start failed',
      backendConnected: false,
      payload: detectionStore.getPayload(FACE_SLUG),
    };
  }

  detectionStore.setCameraRuntime(FACE_SLUG, cameraId, {
    running: true,
    backendCameraId: backendId,
    streamMode: 'backend',
  });

  startFaceStreamLoop(cameraId, backendId);
  const live = getLiveViewPayload(camera);

  return {
    ok: true,
    backendConnected: true,
    backendError: null,
    backendCameraId: backendId,
    inferenceRunning: true,
    faces: [],
    faceCount: 0,
    warmingUp: Boolean(started.processStarting),
    hlsUrl: normalizeMediaUrl(camera.hlsUrl || camera.faceHlsUrl || null),
    whepUrl: normalizeMediaUrl(camera.whepUrl || camera.faceWhepUrl || null),
    mjpegUrl: live.preview?.mjpegUrl || null,
    preview: live.preview,
    wsUrl: `/ws/face-live?cameraId=${encodeURIComponent(cameraId)}`,
    payload: detectionStore.getPayload(FACE_SLUG),
  };
}

async function stopLive(cameraId) {
  const camera = cameraStore.getCamera(cameraId);
  const state = detectionStore.getModelState(FACE_SLUG);
  const backendId = backendCameraId(camera, state, cameraId);

  if (backendId && (await faceClient.isReachable())) {
    try {
      await faceClient.apiJson('/api/face/stream/stop', {
        method: 'POST',
        body: { camera_id: backendId },
      });
    } catch (err) {
      console.warn('[face-live] stop stream:', err.message);
    }
  }

  stopFaceStreamLoop(cameraId);
  detectionStore.setCameraRuntime(FACE_SLUG, cameraId, { running: false });
  const payload = detectionStore.getPayload(FACE_SLUG);
  broadcastFaceUpdate(payload, []);
  return { ok: true, payload };
}

async function getLiveFrame(cameraId) {
  const camera = cameraStore.getCamera(cameraId);
  const state = detectionStore.getModelState(FACE_SLUG);
  const live = camera ? getLiveViewPayload(camera) : { preview: null };
  const backendId = backendCameraId(camera, state, cameraId);
  const cameraRunning = isFaceCameraRunning(cameraId);
  const fullPayload = detectionStore.getPayload(FACE_SLUG);

  let faces = [];
  let frameW = null;
  let frameH = null;
  let captureTs = null;
  let backendConnected = false;
  const newEvents = [];

  if (backendId && cameraRunning && (await faceClient.isReachable())) {
    try {
      hydrateTripwireFromCamera(cameraId, backendId);
      const boxData = await faceClient.apiJson(`/api/face/stream/boxes/${encodeURIComponent(backendId)}`);
      const mapped = mapBoxesToFaces(boxData);
      const hintLine = Boolean(boxData.line_enabled) || mapped.line_enabled;
      const lineActive = await isTripwireActive(backendId, hintLine, cameraId);
      const trackedFaces = hasLineSegment(backendId)
        ? annotateLocalCrossings(backendId, mapped.faces)
        : mapped.faces;
      faces = trackedFaces;
      frameW = mapped.frame_w;
      frameH = mapped.frame_h;
      captureTs = mapped.capture_ts;
      backendConnected = true;

      let recognitionFaces = [];
      try {
        const result = await faceClient.apiJson(`/api/face/stream/result/${encodeURIComponent(backendId)}`);
        recognitionFaces = await enrichRecognitionFaces(
          mapResultFaces(result, frameW, frameH),
        );
      } catch (err) {
        if (err.status !== 404) console.warn('[face-live] result poll:', err.message);
      }

      if (camera) {
        const loopRunning = streamLoops.has(cameraId)
          && streamLoops.get(cameraId)
          && !streamLoops.get(cameraId).stopped;
        if (!loopRunning) {
          const merged = await enrichEventFaces(
            mergeBoxesWithRecognition(trackedFaces, recognitionFaces),
          );
          touchCrossTrackPresence(backendId, trackedFaces);
          let eventFaces = [];
          if (hasLineSegment(backendId)) {
            const crossFaces = takeUnseenCrossedFaces(backendId, merged);
            const faceDetectFaces = takeUnseenFaceDetectFaces(backendId, merged);
            eventFaces = [...crossFaces, ...faceDetectFaces];
          } else {
            eventFaces = takeUnseenFaceDetectFaces(backendId, merged);
          }
          ingestUnknownFacesIntoClusters(camera, recognitionFaces);
          if (eventFaces.length) {
            const { newEvents: evts } = await detectionStore.recordFaceDetection(
              camera,
              scopeFaceTrackIds(cameraId, eventFaces),
              {},
            );
            newEvents.push(...(evts || []));
          }
        }
      }
    } catch (err) {
      // Stream thread can take several seconds after start — don't flash "Worker offline".
      if (isWorkerWarmingUpError(err)) {
        backendConnected = true;
      } else if (err.status !== 404) {
        console.warn('[face-live] boxes poll:', err.message);
      }
    }
  }

  if (newEvents.length) {
    broadcastFaceUpdate(detectionStore.getPayload(FACE_SLUG), newEvents, {
      faceDatabase: {
        statistics: faceStore.getStatistics(),
        recentAlerts: faceStore.listAlerts({ status: 'active' }).slice(0, 5),
      },
    });
  }

  return {
    ok: true,
    camera: sanitizeCam(camera),
    preview: live.preview,
    streamMode: state.streamModes?.[cameraId] || (cameraRunning ? 'backend' : 'preview'),
    backendConnected,
    inferenceRunning: cameraRunning,
    backendCameraId: backendId,
    hlsUrl: normalizeMediaUrl(camera?.hlsUrl || camera?.faceHlsUrl || live.preview?.hlsUrl || null),
    whepUrl: normalizeMediaUrl(camera?.whepUrl || camera?.faceWhepUrl || live.preview?.whepUrl || null),
    mjpegUrl: live.preview?.mjpegUrl || null,
    faces: state.features?.boundingBoxes !== false ? faces : [],
    faceCount: faces.length,
    capture_ts: captureTs,
    frame_w: frameW,
    frame_h: frameH,
    metrics: fullPayload.faceMetrics,
    features: state.features,
    alerts: state.alerts,
    confidence: state.confidence,
    updatedAt: new Date().toISOString(),
    payload: detectionStore.getPayload(FACE_SLUG),
    newEvents,
  };
}

async function updateLiveConfig(cameraId, patch) {
  detectionStore.updateSettings(FACE_SLUG, patch);
  const camera = cameraStore.getCamera(cameraId);
  const state = detectionStore.getModelState(FACE_SLUG);
  const backendId = backendCameraId(camera, state, cameraId);

  if (backendId && isFaceCameraRunning(cameraId) && (await faceClient.isReachable())) {
    try {
      let lineFields = {};
      try {
        const lineCfg = await faceClient.apiJson(
          `/api/face/stream/line-config/${encodeURIComponent(backendId)}`,
        );
        const resolved = resolveLineForWorker(backendId, lineCfg);
        if (resolved?.enabled && resolved.line_x1 != null) {
          lineFields = toWorkerLineFields(resolved);
        }
      } catch {
        const remembered = savedLineByBackend.get(backendId);
        if (remembered) lineFields = toWorkerLineFields(remembered);
      }
      await faceClient.apiJson('/api/face/stream/stop', { method: 'POST', body: { camera_id: backendId } });
      await faceClient.apiJson('/api/face/stream/start', {
        method: 'POST',
        body: buildFaceStreamStartBody(backendId, state, lineFields),
      });
    } catch (err) {
      console.warn('[face-live] config restart:', err.message);
    }
  }

  return { ok: true, payload: detectionStore.getPayload(FACE_SLUG) };
}

async function startAllLive() {
  const state = detectionStore.getModelState(FACE_SLUG);
  const results = [];
  for (const camId of state.assignedCameraIds || []) {
    try {
      const r = await startLive(camId);
      results.push({ cameraId: camId, ok: r.ok, error: r.error || null });
    } catch (err) {
      results.push({ cameraId: camId, ok: false, error: err.message });
    }
  }
  return { ok: true, results };
}

module.exports = {
  selectCamera,
  startLive,
  stopLive,
  getLiveFrame,
  updateLiveConfig,
  startAllLive,
  addStreamClient,
  getLineConfig,
  setLineConfig,
  clearLineConfig,
  ensureFaceWorkerMediaSource,
};
