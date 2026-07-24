const router   = require('express').Router();
const path     = require('path');
const fs       = require('fs');
const multer   = require('multer');
const { requireAuth } = require('../middleware/auth');
const log = require('../utils/logger').child('face');
const bridge          = require('../services/faceWorkerBridge');
const personStore     = require('../services/personStore');
const clusterStore    = require('../services/clusterStore');
const lineConfigStore = require('../services/lineConfigStore');
const { cameras }     = require('../store');
const { readDB }      = require('../services/dbStore');

const PROJECT_ROOT = path.join(__dirname, '../..');
const UPLOAD_DIR   = path.join(PROJECT_ROOT, 'uploads');
const CROPS_DIR    = path.join(PROJECT_ROOT, 'data', 'crops');

[UPLOAD_DIR, CROPS_DIR,
 path.join(UPLOAD_DIR, 'faces'),
 path.join(UPLOAD_DIR, 'enrollment')
].forEach(d => fs.mkdirSync(d, { recursive: true }));

const imageUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(UPLOAD_DIR, 'faces')),
    filename:    (req, file, cb) => cb(null, `${Date.now()}_${file.originalname}`),
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => file.mimetype.startsWith('image/') ? cb(null, true) : cb(new Error('Images only')),
});

const videoUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(UPLOAD_DIR, 'enrollment')),
    filename:    (req, file, cb) => cb(null, `${Date.now()}_${file.originalname}`),
  }),
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (req, file, cb) => file.mimetype.startsWith('video/') ? cb(null, true) : cb(new Error('Videos only')),
});

const ALL_CAPS = ['face_detection', 'gender_classification', 'face_recognition'];

function parseCapabilities(body) {
  let raw = body.capabilities;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { raw = [raw]; }
  }
  if (!raw || !Array.isArray(raw) || raw.length === 0) return [...ALL_CAPS];
  const invalid = raw.filter(c => !ALL_CAPS.includes(c));
  if (invalid.length) throw new Error(`Unknown capabilities: ${invalid.join(', ')}. Valid: ${ALL_CAPS.join(', ')}`);
  return [...new Set(['face_detection', ...raw])];
}

function filterFace(face, caps) {
  const out = { box: face.box, detection_score: face.score ?? 0, crop_filename: face.crop_filename || null };
  if (caps.includes('gender_classification'))  out.gender     = face.gender || null;
  if (caps.includes('face_recognition'))       { out.is_known = face.is_known || false; out.match = face.match || null; out.match_score = face.score || 0; }
  return out;
}

async function ensureWorker(res) {
  try {
    if (!bridge.isReady()) await bridge.start();
    return true;
  } catch (err) {
    res.status(503).json({ error: `face_worker.py failed to start: ${err.message}` });
    return false;
  }
}

const eventStore = require('../services/eventStore');
const { broadcast } = require('../store/websocketBroadcast');

// Track active events - exactly like original backend
const activeEventUuids = new Map();
const recentFaceDetections = new Map();
const DUPLICATE_EVENT_WINDOW_MS = 5_000;

function boxesRepresentSameFace(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length < 4 || b.length < 4) return false;
  const [ax, ay, aw, ah] = a.map(Number);
  const [bx, by, bw, bh] = b.map(Number);
  const acx = ax + aw / 2;
  const acy = ay + ah / 2;
  const bcx = bx + bw / 2;
  const bcy = by + bh / 2;
  const interW = Math.max(0, Math.min(ax + aw, bx + bw) - Math.max(ax, bx));
  const interH = Math.max(0, Math.min(ay + ah, by + bh) - Math.max(ay, by));
  const intersection = interW * interH;
  const centerDistance = Math.hypot(acx - bcx, acy - bcy);
  return intersection > 0 && centerDistance <= 0.8 * Math.max(aw, ah, bw, bh);
}

// When a face is detected, create an immediate UNKNOWN event
bridge.on('stream_detect', (msg) => {
  const now = Date.now();
  const recent = (recentFaceDetections.get(msg.camera_id) || [])
    .filter((item) => now - item.at < DUPLICATE_EVENT_WINDOW_MS);
  const duplicate = recent.find((item) => boxesRepresentSameFace(item.box, msg.box));
  if (duplicate) {
    // Link recognition for the replacement track to the existing event.
    activeEventUuids.set(msg.event_uuid, duplicate.eventId);
    recentFaceDetections.set(msg.camera_id, recent);
    return;
  }

  const savedEvent = eventStore.addEvent(
    'UNKNOWN',
    'UNKNOWN',
    0.0,
    msg.crop_filename,
    false,
    msg.camera_id,
    msg.camera_name || msg.camera_id
  );
  
  activeEventUuids.set(msg.event_uuid, savedEvent.id);
  recent.push({ box: msg.box, eventId: savedEvent.id, at: now });
  recentFaceDetections.set(msg.camera_id, recent);
  
  if (broadcast) {
    broadcast({
      event: 'recognition_event',
      data: savedEvent
    });
  }
});

// When recognition completes, update the event with identified person
bridge.on('stream_recognize', (face) => {
  const eventId = activeEventUuids.get(face.event_uuid);
  
  if (eventId) {
    activeEventUuids.delete(face.event_uuid);
    
    let personId = 'UNKNOWN';
    let personName = 'UNKNOWN';
    let isKnown = !!face.is_known;

    // If recognized as known person
    if (isKnown && face.match) {
      personId = face.match.person_id;
      personName = face.match.name;
    } 
    // If unknown, cluster and add to profile
    else if (face.embedding) {
      try {
        const cluster = clusterStore.ingestUnknownFace({
          embedding:     face.embedding,
          crop_filename: face.crop_filename,
          camera_id:     face.camera_id,
          gender:        face.gender,
        });
        if (cluster) {
          personId = cluster.cluster_id;
          personName = cluster.name || `Profile #${cluster.cluster_id}`;
          if (broadcast) broadcast({ event: 'clusters_updated' });
        }
      } catch (err) {
        log.error({ err }, 'Error clustering face');
      }
    }

    // Update event with recognition results
    const updatedEvent = eventStore.updateEvent(eventId, {
      person_id: personId,
      person_name: personName,
      score: face.score || 0,
      is_known: isKnown
    });

    if (updatedEvent && broadcast) {
      broadcast({
        event: 'recognition_update',
        data: updatedEvent
      });
    }

    // Auto-learning: if high-confidence known match, save new template — mirrors small backend
    if (isKnown && face.match) {
      const db = readDB();
      const liveThreshold = (db.settings && db.settings.threshold) ? db.settings.threshold : 0.60;
      const matchMargin = Number(face.match?.margin ?? 0);
      const learnThreshold = Math.max(0.55, Number(face.match?.effective_threshold ?? 0.45) + 0.08);
      if (face.score >= learnThreshold && matchMargin >= 0.04 && face.embedding) {
        const person = personStore.getPerson(face.match.person_id);
        if (person && face.crop_filename) {
          // Prune oldest auto-learned photo if limit reached (mirrors small backend cap logic)
          const allPhotos = person.photos || [];
          const autoPhotos = allPhotos.filter(p => (p.filename || '').startsWith('auto_'));
          if (allPhotos.length >= 1000) {
            if (autoPhotos.length > 0) {
              autoPhotos.sort((a, b) => (a.filename || '').localeCompare(b.filename || ''));
              personStore.deletePhoto(autoPhotos[0].id || autoPhotos[0].filename);
            } else {
              // No auto photos to prune — skip
              return;
            }
          }
          const cropPath = path.join(CROPS_DIR, face.crop_filename);
          const uploadFilename = `auto_${Date.now()}_${path.basename(face.crop_filename)}`;
          const uploadPath = path.join(UPLOAD_DIR, uploadFilename);
          try {
            if (fs.existsSync(cropPath)) {
              fs.copyFileSync(cropPath, uploadPath);
              personStore.addEmbeddings(person.person_id, [face.embedding], [uploadFilename]);
              if (bridge.isReady()) bridge.updateCandidates(personStore.getCandidatesPayload()).catch(() => {});
              if (broadcast) broadcast({ event: 'database_updated' });
              log.info({ person: face.match.name, score: face.score.toFixed(3) }, '[Auto-Learning] enrolled new template');
            }
          } catch (err) {
            log.error({ err }, 'Auto-learning failed');
          }
        }
      }
    }
  }
});

// ── Worker status ─────────────────────────────────────────────
router.get('/worker/status', requireAuth, (req, res) => {
  res.json({ running: bridge.isReady(), pid: bridge.proc?.pid || null });
});

router.post('/worker/start', requireAuth, async (req, res) => {
  try {
    await bridge.start();
    res.json({ started: true, pid: bridge.proc?.pid });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/worker/stop', requireAuth, (req, res) => {
  bridge.stop();
  res.json({ stopped: true });
});

// ── Live stream ───────────────────────────────────────────────
router.post('/stream/start', requireAuth, async (req, res) => {
  const {
    camera_id, threshold = 0.60, dis_type = 0,
    // Optional inline line-crossing override. If provided, this also
    // becomes the new saved config for the camera (same as calling
    // PUT /stream/line-config/:camera_id first). If omitted, whatever
    // was last saved for this camera (or the disabled default) is used.
    line_crossing_enabled, line_y, line_direction, line_x_start, line_x_end,
    line_x1, line_y1, line_x2, line_y2,
  } = req.body || {};
  if (!camera_id) return res.status(400).json({ error: 'camera_id required' });

  const cam = cameras.get(camera_id);
  if (!cam) return res.status(404).json({ error: `Camera ${camera_id} not found` });

  let caps;
  try { caps = parseCapabilities(req.body); }
  catch (e) { return res.status(400).json({ error: e.message }); }

  const hasInlineLineConfig = [
    line_crossing_enabled, line_y, line_direction, line_x_start, line_x_end,
    line_x1, line_y1, line_x2, line_y2,
  ]
    .some(v => v !== undefined);

  let lineConfig;
  try {
    lineConfig = hasInlineLineConfig
      ? lineConfigStore.setConfig(camera_id, {
          enabled: line_crossing_enabled, line_y, direction: line_direction,
          x_start: line_x_start, x_end: line_x_end,
          line_x1, line_y1, line_x2, line_y2,
        })
      : lineConfigStore.getConfig(camera_id);
  } catch (e) { return res.status(400).json({ error: e.message }); }

  if (!(await ensureWorker(res))) return;

  const candidates = caps.includes('face_recognition') ? personStore.getCandidatesPayload() : [];

  try {
    if (bridge.isStreamActive(camera_id)) {
      await bridge.updateCandidates(candidates);
      await bridge.updateLineConfig(camera_id, lineConfig);
      return res.json({
        started: true,
        already_running: true,
        hot_updated: true,
        camera_id,
        capabilities: caps,
        threshold,
        line_config: lineConfig,
        message: 'Recognition was already running; configuration updated without restart.',
      });
    }
    const result = await bridge.startStream(
      camera_id, cam.name,
      cam.local_rtsp || `rtsp://localhost:8554/${camera_id}`,
      candidates, threshold, dis_type, CROPS_DIR, lineConfig
    );
    res.json({ started: true, camera_id, capabilities: caps, threshold, line_config: lineConfig, message: result.message });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Line-crossing config (the "dynamically drawn line") ─────────
// A frontend lets an operator draw a line over the camera preview (as
// normalized 0–1 fractions of frame width/height) and saves it here. It's
// picked up automatically the next time that camera's face stream starts
// (see /stream/start above), or you can pass line_* fields inline on that
// call instead — both paths write to the same store.
router.get('/stream/line-config/:cameraId', requireAuth, (req, res) => {
  res.json({ camera_id: req.params.cameraId, ...lineConfigStore.getConfig(req.params.cameraId) });
});

router.put('/stream/line-config/:cameraId', requireAuth, async (req, res) => {
  const { cameraId } = req.params;
  if (!cameras.get(cameraId)) return res.status(404).json({ error: `Camera ${cameraId} not found` });

  let cfg;
  try { cfg = lineConfigStore.setConfig(cameraId, req.body || {}); }
  catch (e) { return res.status(400).json({ error: e.message }); }

  // Apply to the active Python thread without restarting FFmpeg/recognition.
  let hotUpdated = false;
  if (bridge.isReady() && bridge.isStreamActive(cameraId)) {
    try {
      await bridge.updateLineConfig(cameraId, cfg);
      hotUpdated = true;
    } catch (e) { /* best-effort — config is saved either way */ }
  }

  res.json({ camera_id: cameraId, ...cfg, hot_updated: hotUpdated, restarted: false });
});

router.delete('/stream/line-config/:cameraId', requireAuth, async (req, res) => {
  const { cameraId } = req.params;
  lineConfigStore.deleteConfig(cameraId);
  let hotUpdated = false;
  if (bridge.isReady() && bridge.isStreamActive(cameraId)) {
    try {
      await bridge.updateLineConfig(cameraId, lineConfigStore.DEFAULTS);
      hotUpdated = true;
    } catch (e) { /* config remains cleared even if worker update fails */ }
  }
  res.json({
    camera_id: cameraId,
    ...lineConfigStore.DEFAULTS,
    hot_updated: hotUpdated,
    restarted: false,
  });
});

router.post('/stream/stop', requireAuth, async (req, res) => {
  const { camera_id } = req.body || {};
  if (!camera_id) return res.status(400).json({ error: 'camera_id required' });
  if (!(await ensureWorker(res))) return;
  try {
    const r = await bridge.stopStream(camera_id);
    res.json({ stopped: true, camera_id, message: r.message });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/stream/result/:cameraId', requireAuth, (req, res) => {
  const result = bridge.getLatestStreamResult(req.params.cameraId);
  if (!result) {
    if (bridge.isStreamActive(req.params.cameraId)) {
      return res.json({
        camera_id: req.params.cameraId,
        faces: [],
        updated_at: new Date().toISOString(),
      });
    }
    return res.status(404).json({ error: 'Stream is not running' });
  }
  res.json({ camera_id: result.camera_id, camera_name: result.camera_name, faces: result.faces || [], updated_at: new Date().toISOString() });
});

// ── Live bounding boxes for frontend overlay rendering ──────────
// Returns both raw pixel boxes (native frame resolution) AND normalized
// (0–1) boxes, so the frontend can draw a canvas overlay on top of the
// <video> element regardless of its rendered/display size — just multiply
// box_normalized.x/y/w/h by the video element's current width/height.
router.get('/stream/boxes/:cameraId', requireAuth, (req, res) => {
  const result = bridge.getLatestStreamResult(req.params.cameraId);
  if (!result) {
    if (bridge.isStreamActive(req.params.cameraId)) {
      return res.json({
        camera_id: req.params.cameraId,
        frame_width: 640,
        frame_height: 360,
        boxes: [],
        updated_at: new Date().toISOString(),
      });
    }
    return res.status(404).json({ error: 'Stream is not running' });
  }

  const fw = result.frame_width  || null;
  const fh = result.frame_height || null;

  const boxes = (result.faces || []).map(f => {
    const [x, y, w, h] = f.box || [0, 0, 0, 0];
    return {
      track_id: f.event_uuid || null,
      box: { x, y, w, h }, // raw pixel box (native camera frame resolution)
      box_normalized: (fw && fh) ? {
        x: x / fw,
        y: y / fh,
        w: w / fw,
        h: h / fh,
      } : null,
      is_known:  f.is_known || false,
      person_id: f.match?.person_id || null,
      name:      f.match?.name || null,
      score:     f.score || 0,
      gender:    f.gender || null,
      crop_filename: f.crop_filename || null,
    };
  });

  res.json({
    camera_id:    result.camera_id,
    camera_name:  result.camera_name,
    frame_width:  fw,
    frame_height: fh,
    boxes,
    updated_at:   new Date().toISOString(),
  });
});

// ── One-shot image analysis ───────────────────────────────────
router.post('/analyze', requireAuth, imageUpload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'image file required (field: "image")' });
  let caps;
  try { caps = parseCapabilities(req.body); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  if (!(await ensureWorker(res))) return;

  const candidates = caps.includes('face_recognition') ? personStore.getCandidatesPayload() : [];
  const threshold  = parseFloat(req.body.threshold) || 0.60;
  const disType    = parseInt(req.body.dis_type)    || 0;

  try {
    const response = await bridge.recognizeImage(req.file.path, candidates, threshold, disType, CROPS_DIR);
    const faces    = (response.faces || []).map(f => filterFace(f, caps));
    res.json({ faces, face_count: faces.length, capabilities_used: caps, image_file: req.file.filename });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Face clusters (recurring, not-yet-labeled strangers) ───────
// Populated automatically from live streams (see the stream_match
// listener above). Label a cluster to turn it into a recognizable Person.
router.get('/clusters', requireAuth, (req, res) => {
  const clusters = clusterStore.listClusters();
  
  // Filter out crop files that don't exist on disk
  const validatedClusters = clusters.map(c => {
    if (!c.photos || !Array.isArray(c.photos)) return c;
    
    // Only keep photos whose crop files actually exist
    const validPhotos = c.photos.filter(p => {
      const cropPath = path.join(CROPS_DIR, p.filename);
      return fs.existsSync(cropPath);
    });
    
    return {
      ...c,
      photos: validPhotos,
      crop_filenames: validPhotos.map(p => p.filename)
    };
  });
  
  res.json(validatedClusters);
});

router.delete('/clusters', requireAuth, (req, res) => {
  try {
    const deleted = clusterStore.deleteAllClusters();
    if (broadcast) broadcast({ event: 'clusters_updated' });
    res.json({ ok: true, deleted, message: 'All unknown-face clusters deleted' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/clusters/:id', requireAuth, (req, res) => {
  const c = clusterStore.getCluster(req.params.id);
  if (!c) return res.status(404).json({ error: 'Cluster not found' });
  
  // Filter out crop files that don't exist on disk
  const validCropFilenames = (c.crop_filenames || []).filter(fn => {
    const cropPath = path.join(CROPS_DIR, fn);
    return fs.existsSync(cropPath);
  });
  
  res.json({
    cluster_id:      c.cluster_id,
    seen_count:      c.seen_count,
    embedding_count: c.embeddings.length,
    camera_ids:      Array.from(c.camera_ids),
    crop_filenames:  validCropFilenames,
    last_gender:     c.last_gender,
    first_seen:      c.first_seen,
    last_seen:       c.last_seen,
  });
});

// Read/update the cosine similarity threshold used to decide whether a new
// unknown face joins an existing cluster. Defaults to env var
// CLUSTER_MATCH_THRESHOLD (or 0.60); changes here apply immediately and take
// effect for the next ingested face, no restart required.
router.get('/clusters/config/threshold', requireAuth, (req, res) => {
  res.json({ threshold: clusterStore.getThreshold() });
});

router.put('/clusters/config/threshold', requireAuth, (req, res) => {
  try {
    const threshold = clusterStore.setThreshold(req.body?.threshold);
    res.json({ threshold, message: 'Cluster match threshold updated.' });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Discard a cluster (e.g. it's noise, or crops of unrelated people that got
// merged) without creating/updating any person.
router.delete('/clusters/:id', requireAuth, (req, res) => {
  try { clusterStore.deleteCluster(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(404).json({ error: e.message }); }
});

// Label a cluster: creates a new Person from its embeddings (or, if
// person_id is supplied, merges its embeddings into an existing Person),
// pushes the updated candidate list to the running worker, and removes the
// cluster. From this point on the labeled face is recognized (is_known:
// true) on future stream/analyze detections.
router.post('/clusters/:id/label', requireAuth, async (req, res) => {
  const cluster = clusterStore.getCluster(req.params.id);
  if (!cluster) return res.status(404).json({ error: 'Cluster not found' });

  const { name, note, person_id } = req.body || {};
  if (!person_id && !name)
    return res.status(400).json({ error: 'name is required (or pass person_id to merge into an existing person)' });

  try {
    let person;
    if (person_id) {
      person = personStore.getPerson(person_id);
      if (!person) return res.status(404).json({ error: `Person ${person_id} not found` });
    } else {
      person = personStore.createPerson({ name, note });
    }

    personStore.addEmbeddings(person.person_id, cluster.embeddings, cluster.crop_filenames);
    if (bridge.isReady()) await bridge.updateCandidates(personStore.getCandidatesPayload());

    clusterStore.deleteCluster(cluster.cluster_id);

    res.json({
      person_id:       person.person_id,
      name:            person.name,
      embedding_count: personStore.getPerson(person.person_id).embeddings.length,
      cluster_id:      cluster.cluster_id,
      message:         'Cluster labeled — this face will now be recognized on future detections.',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Person management ─────────────────────────────────────────
router.post('/persons', requireAuth, (req, res) => {
  try { res.status(201).json(personStore.createPerson(req.body)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/persons', requireAuth, (req, res) => res.json(personStore.listPersons()));

router.delete('/persons', requireAuth, async (req, res) => {
  try {
    const deleted = personStore.deleteAllPersons();
    if (bridge.isReady()) await bridge.updateCandidates([]);
    if (broadcast) broadcast({ event: 'database_updated' });
    res.json({ ok: true, deleted, message: 'All enrolled identities deleted' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/persons/:id', requireAuth, (req, res) => {
  const p = personStore.getPerson(req.params.id);
  if (!p) return res.status(404).json({ error: 'Person not found' });
  res.json({ ...p, embeddings: undefined, embedding_count: p.embeddings.length });
});

router.put('/persons/:id', requireAuth, async (req, res) => {
  try {
    const p = personStore.updatePerson(req.params.id, req.body);
    if (bridge.isReady()) await bridge.updateCandidates(personStore.getCandidatesPayload());
    res.json({
      person_id: p.person_id,
      name: p.name,
      note: p.note,
      updated: true,
      merged: Boolean(p.merged_from),
      merged_from: p.merged_from || null,
    });
  }
  catch (e) { res.status(404).json({ error: e.message }); }
});

router.delete('/persons/:id', requireAuth, async (req, res) => {
  try {
    personStore.deletePerson(req.params.id);
    if (bridge.isReady()) bridge.updateCandidates(personStore.getCandidatesPayload()).catch(() => {});
    res.json({ ok: true });
  } catch (e) { res.status(404).json({ error: e.message }); }
});

// ── Enroll from image ─────────────────────────────────────────
router.post('/persons/:id/enroll/image', requireAuth, imageUpload.single('image'), async (req, res) => {
  const person = personStore.getPerson(req.params.id);
  if (!person) return res.status(404).json({ error: 'Person not found' });
  if (!req.file) return res.status(400).json({ error: 'image file required (field: "image")' });
  if (!(await ensureWorker(res))) return;

  try {
    const response = await bridge.extractEmbedding(req.file.path);
    if (!response.embedding)
      return res.status(422).json({ error: 'No face detected. Use a clear frontal photo (conf>=0.75, size>=80px).' });

    personStore.addEmbeddings(person.person_id, [response.embedding], [req.file.filename]);
    if (bridge.isReady()) await bridge.updateCandidates(personStore.getCandidatesPayload());

    res.json({
      person_id:       person.person_id,
      name:            person.name,
      embedding_count: personStore.getPerson(person.person_id).embeddings.length,
      message:         'Embedding added successfully',
    });
  } catch (err) { res.status(422).json({ error: err.message }); }
});

// ── Enroll from video ─────────────────────────────────────────
router.post('/persons/:id/enroll/video', requireAuth, videoUpload.single('video'), async (req, res) => {
  const person = personStore.getPerson(req.params.id);
  if (!person) return res.status(404).json({ error: 'Person not found' });
  if (!req.file) return res.status(400).json({ error: 'video file required (field: "video")' });
  if (!(await ensureWorker(res))) return;

  try {
    const response = await bridge.processVideoEnrollment(req.file.path, CROPS_DIR);
    if (!response.faces?.length)
      return res.status(422).json({ error: 'No usable faces found in video.' });

    personStore.addEmbeddings(person.person_id, response.faces.map(f => f.embedding), response.faces.map(f => f.filename).filter(Boolean));
    if (bridge.isReady()) await bridge.updateCandidates(personStore.getCandidatesPayload());

    res.json({
      person_id:       person.person_id,
      name:            person.name,
      frames_accepted: response.faces.length,
      embedding_count: personStore.getPerson(person.person_id).embeddings.length,
      message:         `${response.faces.length} embeddings added from video`,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Clear embeddings ──────────────────────────────────────────
router.delete('/persons/:id/embeddings', requireAuth, async (req, res) => {
  const p = personStore.getPerson(req.params.id);
  if (!p) return res.status(404).json({ error: 'Person not found' });
  p.embeddings = []; p.crop_filenames = []; p.updated_at = new Date().toISOString();
  if (bridge.isReady()) await bridge.updateCandidates(personStore.getCandidatesPayload());
  res.json({ ok: true, person_id: req.params.id, message: 'All embeddings cleared' });
});

// ── Additional cluster & photo routes ─────────────────────────
router.post('/clusters/:id/enroll', requireAuth, async (req, res) => {
  const clusterId = req.params.id;
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Person name is required.' });

  const cluster = clusterStore.getCluster(clusterId);
  if (!cluster) return res.status(404).json({ error: 'Cluster not found' });

  try {
    const person = personStore.createPerson({ name: name.trim(), gender: cluster.last_gender || 'Unknown' });
    if (cluster.embeddings && cluster.embeddings.length) {
      personStore.addEmbeddings(person.person_id, cluster.embeddings, cluster.crop_filenames);
    }
    if (bridge.isReady()) await bridge.updateCandidates(personStore.getCandidatesPayload());
    clusterStore.deleteCluster(clusterId);

    if (broadcast) {
      broadcast({ event: 'database_updated' });
      broadcast({ event: 'clusters_updated' });
    }

    res.json({ success: true, person });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/clusters/:clusterId/photos/:photoId/move', requireAuth, async (req, res) => {
  const { clusterId, photoId } = req.params;
  const { personId, name } = req.body || {};

  try {
    const result = clusterStore.movePhotoFromClusterToPerson(clusterId, photoId, personId, name);
    if (bridge.isReady()) await bridge.updateCandidates(personStore.getCandidatesPayload());

    if (broadcast) {
      broadcast({ event: 'database_updated' });
      broadcast({ event: 'clusters_updated' });
    }

    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/photos/:id', requireAuth, async (req, res) => {
  const success = personStore.deletePhoto(req.params.id);
  if (success) {
    if (bridge.isReady()) await bridge.updateCandidates(personStore.getCandidatesPayload());
    if (broadcast) broadcast({ event: 'database_updated' });
    res.json({ success: true, message: 'Photo deleted.' });
  } else {
    res.status(404).json({ error: 'Photo not found.' });
  }
});

router.get('/persons/:id/photos', requireAuth, (req, res) => {
  const p = personStore.getPerson(req.params.id);
  if (!p) return res.status(404).json({ error: 'Person not found' });
  res.json(p.photos || []);
});

// ── Frontend compatibility aliases ────────────────────────────
// The web UI uses shorter endpoint paths; these aliases map them to the
// canonical handlers above without breaking existing API consumers.

// POST /persons/:id/photos  →  same as POST /persons/:id/enroll/image but multi-upload
router.post('/persons/:id/photos', requireAuth, imageUpload.array('photos'), async (req, res) => {
  const person = personStore.getPerson(req.params.id);
  if (!person) return res.status(404).json({ error: 'Person not found' });
  if (!req.files || req.files.length === 0) {
    // Fallback: check single 'photo' field for backwards compat
    const singleFile = req.file;
    if (!singleFile) return res.status(400).json({ error: 'No photos uploaded (use field name "photos")' });
    req.files = [singleFile];
  }
  if (!(await ensureWorker(res))) return;

  const addedPhotos = [];
  const errors = [];

  for (const file of req.files) {
    try {
      const response = await bridge.extractEmbedding(file.path);
      if (response && response.embedding) {
        personStore.addEmbeddings(person.person_id, [response.embedding], [file.filename]);
        addedPhotos.push({ id: file.filename, filename: file.filename });
      } else {
        errors.push(`File ${file.originalname}: no face detected — use a clear frontal photo`);
        try { fs.unlinkSync(file.path); } catch (e) {}
      }
    } catch (err) {
      errors.push(`File ${file.originalname}: ${err.message}`);
      try { fs.unlinkSync(file.path); } catch (e) {}
    }
  }

  if (bridge.isReady()) await bridge.updateCandidates(personStore.getCandidatesPayload());
  if (broadcast) broadcast({ event: 'database_updated' });

  res.json({
    success: addedPhotos.length > 0,
    person_id: person.person_id,
    name: person.name,
    embedding_count: personStore.getPerson(person.person_id).embeddings.length,
    added: addedPhotos,
    errors
  });
});

// POST /persons/:id/video  →  same as POST /persons/:id/enroll/video
router.post('/persons/:id/video', requireAuth, videoUpload.single('video'), async (req, res) => {
  const person = personStore.getPerson(req.params.id);
  if (!person) return res.status(404).json({ error: 'Person not found' });
  if (!req.file) return res.status(400).json({ error: 'video file required (field: "video")' });
  if (!(await ensureWorker(res))) return;

  try {
    const response = await bridge.processVideoEnrollment(req.file.path, CROPS_DIR);
    if (!response.faces?.length)
      return res.status(422).json({ error: 'No usable faces found in video.' });

    personStore.addEmbeddings(person.person_id, response.faces.map(f => f.embedding), response.faces.map(f => f.filename).filter(Boolean));
    if (bridge.isReady()) await bridge.updateCandidates(personStore.getCandidatesPayload());
    if (broadcast) broadcast({ event: 'database_updated' });

    res.json({
      person_id:       person.person_id,
      name:            person.name,
      frames_accepted: response.faces.length,
      embedding_count: personStore.getPerson(person.person_id).embeddings.length,
      message:         `${response.faces.length} face frames enrolled from video`,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /recognize  — matches small backend exactly:
// saves an event for each face, clusters unknowns, auto-learns known faces
router.post('/recognize', requireAuth, imageUpload.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No photo uploaded.' });
  if (!(await ensureWorker(res))) return;

  const db = readDB();
  const liveSettings = db.settings || { threshold: 0.60, dis_type: 0 };
  const candidates = personStore.getCandidatesPayload();
  const threshold  = parseFloat(req.body.threshold) || liveSettings.threshold;
  const disType    = parseInt(req.body.dis_type ?? liveSettings.dis_type) || 0;

  try {
    const response = await bridge.recognizeImage(req.file.path, candidates, threshold, disType, CROPS_DIR);

    if (response.status === 'success' || Array.isArray(response.faces)) {
      const eventStore = require('../services/eventStore');

      for (const face of (response.faces || [])) {
        let personId = 'UNKNOWN';
        let personName = 'UNKNOWN';
        let isKnownEvent = face.is_known || false;

        if (face.is_known && face.match) {
          personId   = face.match.person_id;
          personName = face.match.name;
        } else if (face.embedding) {
          // Cluster the unknown face — mirrors small backend behaviour
          try {
            const cluster = clusterStore.ingestUnknownFace({
              embedding:     face.embedding,
              crop_filename: face.crop_filename,
              gender:        face.gender,
            });
            if (cluster) {
              personId   = cluster.cluster_id;
              personName = cluster.name || `Profile #${cluster.cluster_id}`;
              if (broadcast) broadcast({ event: 'clusters_updated' });
              face.cluster_id   = cluster.cluster_id;
              face.cluster_name = cluster.name;
            }
          } catch (err) {
            log.error({ err }, '[Clustering] error clustering face from /recognize');
          }
        }

        // Save an event — mirrors small backend addEvent()
        const savedEvent = eventStore.addEvent(
          personId, personName, face.score || 0,
          face.crop_filename, isKnownEvent, null, 'Manual Upload'
        );
        if (broadcast) broadcast({ event: 'recognition_event', data: savedEvent });

        // Auto-learning — mirrors small backend POST /recognize auto-learn logic
        const matchMargin = Number(face.match?.margin ?? 0);
        const learnThreshold = Math.max(0.55, Number(face.match?.effective_threshold ?? 0.45) + 0.08);
        if (face.is_known && face.match && face.score >= learnThreshold && matchMargin >= 0.04 && face.embedding) {
          const person = personStore.getPerson(face.match.person_id);
          if (person) {
            const allPhotos = person.photos || [];
            const autoPhotos = allPhotos.filter(p => (p.filename || '').startsWith('auto_'));
            if (allPhotos.length >= 1000) {
              if (autoPhotos.length > 0) {
                autoPhotos.sort((a, b) => (a.filename || '').localeCompare(b.filename || ''));
                personStore.deletePhoto(autoPhotos[0].id || autoPhotos[0].filename);
              }
            }
            const cropPath = path.join(CROPS_DIR, face.crop_filename || '');
            const uploadFilename = `auto_${Date.now()}_${path.basename(face.crop_filename || 'unknown.jpg')}`;
            const uploadPath = path.join(UPLOAD_DIR, uploadFilename);
            try {
              if (face.crop_filename && fs.existsSync(cropPath)) {
                fs.copyFileSync(cropPath, uploadPath);
                personStore.addEmbeddings(person.person_id, [face.embedding], [uploadFilename]);
                if (bridge.isReady()) bridge.updateCandidates(personStore.getCandidatesPayload()).catch(() => {});
                if (broadcast) broadcast({ event: 'database_updated' });
                log.info({ person: face.match.name, score: face.score.toFixed(3) }, '[Auto-Learning] enrolled new template from /recognize');
              }
            } catch (err) {
              log.error({ err }, '[Auto-Learning] error saving template from /recognize');
            }
          }
        }
      }

      try { fs.unlinkSync(req.file.path); } catch (e) {}
      res.json({ success: true, faces: response.faces || [] });
    } else {
      try { fs.unlinkSync(req.file.path); } catch (e) {}
      res.status(500).json({ error: response.message || 'Recognition failed' });
    }
  } catch (err) {
    try { fs.unlinkSync(req.file.path); } catch (e) {}
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
