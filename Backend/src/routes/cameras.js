/**
 * Camera routes — 10 endpoints
 *
 * POST   /api/cameras           Add camera → validate stream → register in MediaMTX
 * GET    /api/cameras           List all cameras
 * GET    /api/cameras/:id       Single camera detail
 * PUT    /api/cameras/:id       Update camera
 * DELETE /api/cameras/:id       Remove camera (admin+)
 * POST   /api/cameras/:id/validate   Test stream reachability
 * POST   /api/cameras/:id/restart    Restart MediaMTX stream path
 * GET    /api/cameras/:id/health     Live health metrics
 * GET    /api/cameras/:id/snapshot   Latest JPEG as base64
 * GET    /api/cameras/:id/logs       Stream + reconnect event log
 */

const router = require('express').Router();
const path = require('path');
const multer = require('multer');
const { cameras, uuidv4, pushLog, cameraLogs, saveCamerasToDB } = require('../store');
const { requireAuth, requireRole } = require('../middleware/auth');
const mtx = require('../services/mediamtx');
const { UPLOADS_DIR } = require('../services/dbStore');
const log = require('../utils/logger').child('cameras');

const uploadVideo = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname);
      cb(null, `upload_${Date.now()}_${Math.random().toString(36).substr(2, 5)}${ext}`);
    }
  }),
  limits: { fileSize: 100 * 1024 * 1024 }
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function notFound(res, id) {
  return res.status(404).json({ error: `Camera ${id} not found` });
}

function publicCamera(c) {
  // Don't leak raw credentials in list/get responses
  const { password, ...safe } = c;
  return safe;
}

// ── POST /api/cameras ─────────────────────────────────────────────────────────

router.post('/', requireAuth, async (req, res) => {
  const { name, type, url, username, password, location, zone, floor, department } = req.body || {};
  if (!name || !type || !url) {
    log.warn({ reqId: req.id, body: { name, type, url: !!url } }, 'create camera rejected — missing required fields');
    return res.status(400).json({ error: 'name, type, and url are required' });
  }

  log.info({ reqId: req.id, name, type, url }, 'creating camera — validating stream');

  // 1. Validate stream reachability
  let streamInfo;
  try {
    streamInfo = await mtx.validateStream(url, { username, password });
  } catch (err) {
    log.error({ reqId: req.id, err, url }, 'stream validation threw');
    return res.status(422).json({ error: `Stream validation failed: ${err.message}` });
  }

  if (!streamInfo.reachable) {
    log.warn({ reqId: req.id, url, streamInfo }, 'stream not reachable');
    return res.status(422).json({ error: 'Stream is not reachable', details: streamInfo });
  }

  // 2. Create camera record
  const id = 'cam_' + uuidv4().slice(0, 8);
  const camera = {
    id,
    name,
    type,
    url,
    username: username || null,
    password: password || null,   // store securely (vault) in production
    location: location || null,
    zone: zone || null,
    floor: floor || null,
    department: department || null,
    status: 'idle',
    codec: streamInfo.codec,
    resolution: streamInfo.resolution,
    fps: streamInfo.fps,
    assigned_models: [],
    created_at: new Date().toISOString(),
  };

  // 3. Register in MediaMTX
  try {
    const mtxResult = await mtx.addPath(id, url, { username, password });
    camera.whep_url = mtxResult.whepUrl;
    camera.local_rtsp = mtxResult.localRtsp;
    camera.status = 'online';
    log.info({ reqId: req.id, cameraId: id, whep_url: camera.whep_url }, 'camera registered in MediaMTX');
  } catch (err) {
    // Don't fail the whole request — camera saved but stream may not be live
    camera.whep_url = mtx.whepUrl(id);
    camera.local_rtsp = mtx.localRtsp(id);
    camera.status = 'error';
    camera.mtx_error = err.message;
    log.error({ reqId: req.id, cameraId: id, err }, 'MediaMTX registration failed — camera saved with status=error');
  }

  cameras.set(id, camera);
  saveCamerasToDB();
  pushLog(id, { event: 'camera_added', url });
  log.info({ reqId: req.id, cameraId: id, status: camera.status }, 'camera created');

  res.status(201).json({
    id,
    whep_url: camera.whep_url,
    status: camera.status,
    codec: camera.codec,
    resolution: camera.resolution,
    mtx_error: camera.mtx_error || null,
  });
});

// ── POST /api/cameras/upload-video ───────────────────────────────────────────

// ── POST /api/cameras/upload-video  (also aliased as /upload-mock) ───────────
// Uploads a video file, loops it into MediaMTX as a fake RTSP camera via
// FFmpeg, then starts the Python face-recognition stream on it — mirrors
// small backend's /api/cameras/upload-mock exactly.

async function handleVideoUpload(req, res) {
  if (!req.file) return res.status(400).json({ error: 'No video file uploaded' });

  const id   = 'cam_' + uuidv4().slice(0, 8);
  const name = req.body.name || path.basename(req.file.originalname, path.extname(req.file.originalname));
  const rtspUrl = `rtsp://127.0.0.1:8554/${id}`;

  const camera = {
    id,
    name,
    type: 'video',
    url:     rtspUrl,
    rtsp_url: rtspUrl,
    local_rtsp: rtspUrl,
    is_active: false,
    line_crossing_enabled: false,
    line_y: 0.6,
    line_direction: 'in',
    line_x_start: 0.0,
    line_x_end: 1.0,
    video_path: req.file.path,
    status: 'idle',
    assigned_models: [],
    created_at: new Date().toISOString()
  };

  cameras.set(id, camera);
  saveCamerasToDB();
  pushLog(id, { event: 'video_camera_created', file: req.file.originalname });

  // 1. Start the FFmpeg loop stream into MediaMTX
  const startMock = req.app.locals.startMockFFmpegStream;
  if (startMock) {
    startMock(id, req.file.path);
    log.info({ cameraId: id }, 'FFmpeg loop stream started for uploaded video');
  }

  // 2. Start the Python face-recognition stream
  const startCam = req.app.locals.startCameraStream;
  if (startCam) {
    try {
      const bridge = require('../services/faceWorkerBridge');
      if (!bridge.isReady()) await bridge.start();

      await startCam(camera);
      camera.is_active = true;
      camera.status = 'online';
      saveCamerasToDB();
      log.info({ cameraId: id }, 'Python stream started for uploaded video camera');
    } catch (err) {
      log.error({ err: err.message, cameraId: id }, 'Failed to start Python stream for uploaded video');
      camera.status = 'error';
      camera.mtx_error = err.message;
      saveCamerasToDB();
    }
  }

  res.status(201).json(camera);
}

router.post('/upload-video', requireAuth, uploadVideo.single('video'), handleVideoUpload);
// Alias used by the small backend's frontend
router.post('/upload-mock',  requireAuth, uploadVideo.single('video'), handleVideoUpload);


// ── GET /api/cameras ──────────────────────────────────────────────────────────

router.get('/', requireAuth, (req, res) => {
  log.debug({ reqId: req.id, count: cameras.size }, 'listing all cameras');
  const list = Array.from(cameras.values()).map(c => ({
    id: c.id,
    name: c.name,
    type: c.type,
    status: c.status,
    fps: c.fps,
    rtsp_url: c.rtsp_url || c.url,
    is_active: !!c.is_active,
    line_crossing_enabled: !!c.line_crossing_enabled,
    line_y: c.line_y !== undefined ? c.line_y : 0.6,
    line_direction: c.line_direction || 'in',
    line_x_start: c.line_x_start !== undefined ? c.line_x_start : 0.0,
    line_x_end: c.line_x_end !== undefined ? c.line_x_end : 1.0,
    whep_url: c.whep_url,
    assigned_models: c.assigned_models || [],
  }));
  log.info({ reqId: req.id, count: list.length }, 'cameras list retrieved');
  res.json(list);
});

// ── GET /api/cameras/:id ──────────────────────────────────────────────────────

router.get('/:id', requireAuth, (req, res) => {
  log.debug({ reqId: req.id, cameraId: req.params.id }, 'fetching camera details');
  const cam = cameras.get(req.params.id);
  if (!cam) {
    log.warn({ reqId: req.id, cameraId: req.params.id }, 'camera not found');
    return notFound(res, req.params.id);
  }

  log.debug({ cameraId: cam.id, status: cam.status }, 'camera details retrieved');
  res.json({
    id: cam.id,
    name: cam.name,
    type: cam.type,
    url: cam.url,
    rtsp_url: cam.rtsp_url || cam.url,
    is_active: !!cam.is_active,
    line_crossing_enabled: !!cam.line_crossing_enabled,
    line_y: cam.line_y !== undefined ? cam.line_y : 0.6,
    line_direction: cam.line_direction || 'in',
    line_x_start: cam.line_x_start !== undefined ? cam.line_x_start : 0.0,
    line_x_end: cam.line_x_end !== undefined ? cam.line_x_end : 1.0,
    location: cam.location,
    zone: cam.zone,
    floor: cam.floor,
    department: cam.department,
    status: cam.status,
    codec: cam.codec,
    resolution: cam.resolution,
    models: cam.assigned_models || [],
    fps: cam.fps || 0,
    latency_ms: cam.latency_ms || 0,
    reconnect_count: cam.reconnect_count || 0,
    whep_url: cam.whep_url,
    local_rtsp: cam.local_rtsp,
    last_frame: cam.last_frame || null,
    created_at: cam.created_at,
  });
});

// ── PUT /api/cameras/:id ──────────────────────────────────────────────────────

router.put('/:id', requireAuth, async (req, res) => {
  log.debug({ reqId: req.id, cameraId: req.params.id, updates: Object.keys(req.body) }, 'updating camera');
  const cam = cameras.get(req.params.id);
  if (!cam) {
    log.warn({ reqId: req.id, cameraId: req.params.id }, 'camera not found for update');
    return notFound(res, req.params.id);
  }

  const updatable = ['name', 'url', 'rtsp_url', 'username', 'password', 'location', 'zone', 'floor', 'department', 'is_active', 'line_crossing_enabled', 'line_y', 'line_direction', 'line_x_start', 'line_x_end'];
  updatable.forEach(k => { if (req.body[k] !== undefined) cam[k] = req.body[k]; });
  saveCamerasToDB();

  // If URL / credentials changed — re-register in MediaMTX
  let mtxError = null;
  if (req.body.url || req.body.username || req.body.password) {
    log.debug({ cameraId: cam.id }, 'URL or credentials changed, re-registering with MediaMTX');
    try {
      await mtx.patchPath(cam.id, cam.url, { username: cam.username, password: cam.password });
      cam.status = 'online';
      delete cam.mtx_error;
      log.info({ reqId: req.id, cameraId: cam.id }, 'camera stream re-registered after update');
    } catch (err) {
      log.error({ reqId: req.id, cameraId: cam.id, err }, 'MediaMTX patchPath failed during camera update');
      cam.status = 'error';
      cam.mtx_error = err.message;
      mtxError = err.message;
    }
    pushLog(cam.id, { event: 'stream_updated', url: cam.url });
  }

  log.info({ reqId: req.id, cameraId: cam.id }, 'camera updated successfully');
  res.json({ id: cam.id, name: cam.name, updated: true, status: cam.status, mtx_error: mtxError });
});

// ── POST /api/cameras/:id/toggle ──────────────────────────────────────────────

router.post('/:id/toggle', requireAuth, async (req, res) => {
  const cam = cameras.get(req.params.id);
  if (!cam) return notFound(res, req.params.id);

  cam.is_active = !cam.is_active;
  cam.status = cam.is_active ? 'online' : 'idle';
  saveCamerasToDB();

  if (cam.is_active) {
    // Use the centralized startCameraStream from index.js (handles FFmpeg + MediaMTX + Python)
    const startCam = req.app.locals.startCameraStream;
    if (startCam) {
      try {
        const bridge = require('../services/faceWorkerBridge');
        if (!bridge.isReady()) await bridge.start();
        await startCam(cam);
        log.info({ cameraId: cam.id }, 'Camera stream started via toggle');
      } catch (err) {
        log.error({ cameraId: cam.id, err }, 'Failed to start camera stream');
        cam.status = 'error';
        saveCamerasToDB();
      }
    } else {
      // Fallback: use bridge directly
      try {
        const bridge = require('../services/faceWorkerBridge');
        const personStore = require('../services/personStore');
        const lineConfigStore = require('../services/lineConfigStore');
        if (!bridge.isReady()) await bridge.start();
        const candidates = personStore.getCandidatesPayload();
        const lineConfig = lineConfigStore.getConfig(cam.id);
        await bridge.startStream(
          cam.id, cam.name,
          cam.local_rtsp || cam.url || `rtsp://localhost:8554/${cam.id}`,
          candidates, 0.60, 0, undefined, lineConfig
        );
      } catch (err) {
        log.error({ cameraId: cam.id, err }, 'Failed to start face stream thread');
      }
    }
  } else {
    // Use the centralized stopCameraStream from index.js
    const stopCam = req.app.locals.stopCameraStream;
    if (stopCam) {
      try {
        await stopCam(cam);
        log.info({ cameraId: cam.id }, 'Camera stream stopped via toggle');
      } catch (err) {
        log.error({ cameraId: cam.id, err }, 'Failed to stop camera stream');
      }
    } else {
      try {
        const bridge = require('../services/faceWorkerBridge');
        if (bridge.isReady()) await bridge.stopStream(cam.id);
      } catch (err) {
        log.error({ cameraId: cam.id, err }, 'Failed to stop face stream thread');
      }
    }
  }

  res.json({ success: true, camera: cam });
});

// ── POST /api/cameras/:id/line-settings ───────────────────────────────────────

router.post('/:id/line-settings', requireAuth, async (req, res) => {
  const cam = cameras.get(req.params.id);
  if (!cam) return notFound(res, req.params.id);

  const { line_crossing_enabled, line_y, line_direction, line_x_start, line_x_end } = req.body || {};
  cam.line_crossing_enabled = !!line_crossing_enabled;
  if (line_y !== undefined) cam.line_y = parseFloat(line_y);
  if (line_direction) cam.line_direction = line_direction;
  if (line_x_start !== undefined) cam.line_x_start = parseFloat(line_x_start);
  if (line_x_end !== undefined) cam.line_x_end = parseFloat(line_x_end);
  saveCamerasToDB();

  const lineConfigStore = require('../services/lineConfigStore');
  lineConfigStore.setConfig(cam.id, {
    enabled: cam.line_crossing_enabled,
    line_y: cam.line_y,
    direction: cam.line_direction,
    x_start: cam.line_x_start,
    x_end: cam.line_x_end,
  });

  // If the camera is active, restart the stream in Python with new line settings
  // — mirrors small backend's POST /api/cameras/:id/line-settings
  if (cam.is_active) {
    try {
      const bridge = require('../services/faceWorkerBridge');
      const personStore = require('../services/personStore');
      const { readDB } = require('../services/dbStore');
      const isLocal = (cam.url || cam.rtsp_url || '').startsWith('rtsp://localhost') ||
                      (cam.url || cam.rtsp_url || '').startsWith('rtsp://127.0.0.1');
      const targetRtsp = isLocal ? (cam.local_rtsp || cam.url || cam.rtsp_url) : `rtsp://127.0.0.1:8554/${cam.id}`;
      const db = readDB();
      const liveSettings = db.settings || { threshold: 0.60, dis_type: 0 };

      if (bridge.isReady()) {
        await bridge.startStream(
          cam.id, cam.name, targetRtsp,
          personStore.getCandidatesPayload(),
          liveSettings.threshold,
          liveSettings.dis_type,
          undefined,
          {
            enabled: cam.line_crossing_enabled,
            line_y: cam.line_y,
            direction: cam.line_direction,
            x_start: cam.line_x_start,
            x_end: cam.line_x_end,
          }
        );
        log.info({ cameraId: cam.id }, 'restarted stream with new line settings');
      }
    } catch (e) {
      log.error({ cameraId: cam.id, err: e.message }, 'Failed to apply line settings to active camera stream');
    }
  }

  const { broadcast } = require('../store/websocketBroadcast');
  if (broadcast) broadcast({ event: 'cameras_updated', data: Array.from(cameras.values()) });

  res.json({ success: true, camera: cam });
});

// ── DELETE /api/cameras/:id ───────────────────────────────────────────────────

router.delete('/:id', requireAuth, requireRole('admin'), async (req, res) => {
  log.debug({ reqId: req.id, cameraId: req.params.id }, 'deleting camera');
  const cam = cameras.get(req.params.id);
  if (!cam) {
    log.warn({ reqId: req.id, cameraId: req.params.id }, 'camera not found for deletion');
    return notFound(res, req.params.id);
  }

  // Stop all running workers for this camera
  const { workers } = require('../store');
  const { stopWorker } = require('../services/worker');
  for (const [key] of workers.entries()) {
    if (key.startsWith(req.params.id + '::')) {
      const modelId = key.split('::')[1];
      try {
        log.debug({ cameraId: req.params.id, modelId }, 'stopping worker during camera delete');
        stopWorker(req.params.id, modelId);
        log.debug({ cameraId: req.params.id, modelId }, 'worker stopped');
      } catch (err) {
        log.warn({ reqId: req.id, cameraId: req.params.id, modelId, err }, 'failed to stop worker during camera delete');
      }
    }
  }

  // Deregister from MediaMTX
  try {
    log.debug({ cameraId: req.params.id }, 'removing MediaMTX path');
    await mtx.removePath(req.params.id);
    log.debug({ cameraId: req.params.id }, 'MediaMTX path removed');
  } catch (err) {
    log.warn({ reqId: req.id, cameraId: req.params.id, err }, 'failed to remove MediaMTX path during camera delete');
  }

  cameras.delete(req.params.id);
  saveCamerasToDB();
  pushLog(req.params.id, { event: 'camera_deleted' });
  log.info({ reqId: req.id, cameraId: req.params.id }, 'camera deleted successfully');
  res.json({ ok: true });
});

// ── POST /api/cameras/:id/validate ───────────────────────────────────────────

router.post('/:id/validate', requireAuth, async (req, res) => {
  log.debug({ reqId: req.id, cameraId: req.params.id }, 'validating camera stream');
  const cam = cameras.get(req.params.id);
  if (!cam) {
    log.warn({ reqId: req.id, cameraId: req.params.id }, 'camera not found for validation');
    return notFound(res, req.params.id);
  }

  try {
    log.debug({ cameraId: cam.id, url: cam.url }, 'calling stream validation');
    const result = await mtx.validateStream(cam.url, { username: cam.username, password: cam.password });
    log.info({ reqId: req.id, cameraId: cam.id, reachable: result.reachable }, 'stream validation succeeded');
    res.json(result);
  } catch (err) {
    log.error({ reqId: req.id, cameraId: cam.id, err }, 'stream validation failed');
    res.status(422).json({ reachable: false, error: err.message });
  }
});

// ── POST /api/cameras/:id/restart ────────────────────────────────────────────

router.post('/:id/restart', requireAuth, async (req, res) => {
  log.debug({ reqId: req.id, cameraId: req.params.id }, 'restarting camera stream');
  const cam = cameras.get(req.params.id);
  if (!cam) {
    log.warn({ reqId: req.id, cameraId: req.params.id }, 'camera not found for restart');
    return notFound(res, req.params.id);
  }

  try {
    // Remove and re-add the path to force MediaMTX to reconnect
    log.debug({ cameraId: cam.id }, 'removing existing MediaMTX path');
    await mtx.removePath(cam.id);
    await new Promise(r => setTimeout(r, 300));
    log.debug({ cameraId: cam.id }, 're-adding MediaMTX path');
    await mtx.addPath(cam.id, cam.url, { username: cam.username, password: cam.password });
    cam.status = 'online';
    delete cam.mtx_error;
    cam.reconnect_count = (cam.reconnect_count || 0) + 1;
    pushLog(cam.id, { event: 'stream_restarted' });
    log.info({ reqId: req.id, cameraId: cam.id, reconnect_count: cam.reconnect_count }, 'camera stream restarted successfully');
    res.json({ restarted: true });
  } catch (err) {
    log.error({ reqId: req.id, cameraId: cam.id, err }, 'camera stream restart failed');
    cam.status = 'error';
    cam.mtx_error = err.message;
    res.status(500).json({ restarted: false, error: err.message });
  }
});

// ── GET /api/cameras/:id/health ───────────────────────────────────────────────

router.get('/:id/health', requireAuth, (req, res) => {
  log.debug({ reqId: req.id, cameraId: req.params.id }, 'fetching camera health metrics');
  const cam = cameras.get(req.params.id);
  if (!cam) {
    log.warn({ reqId: req.id, cameraId: req.params.id }, 'camera not found for health check');
    return notFound(res, req.params.id);
  }

  // In production: read live metrics from MediaMTX path info
  const health = {
    fps: cam.fps || parseFloat((10 + Math.random() * 8).toFixed(1)),
    bandwidth_kbps: Math.floor(700 + Math.random() * 500),
    latency_ms: Math.floor(40 + Math.random() * 80),
    drop_rate: parseFloat((Math.random() * 0.03).toFixed(4)),
    last_frame: new Date().toISOString(),
  };
  log.trace({ cameraId: cam.id, health }, 'camera health metrics gathered');
  res.json(health);
});

// ── GET /api/cameras/:id/snapshot ────────────────────────────────────────────

router.get('/:id/snapshot', requireAuth, (req, res) => {
  log.debug({ reqId: req.id, cameraId: req.params.id }, 'fetching camera snapshot');
  const cam = cameras.get(req.params.id);
  if (!cam) {
    log.warn({ reqId: req.id, cameraId: req.params.id }, 'camera not found for snapshot');
    return notFound(res, req.params.id);
  }

  // In production: grab a frame via ffmpeg from cam.local_rtsp
  // ffmpeg -rtsp_transport tcp -i <url> -vframes 1 -f image2pipe -vcodec mjpeg pipe:1
  // Then base64-encode the output buffer.
  const placeholder =
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoH' +
    'BwYIDAoMCwsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/wAALCAAB' +
    'AAEBAREAAQAB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAA' +
    'AAD/2gAIAQEAAD8AVIP/2Q==';

  log.debug({ cameraId: cam.id }, 'snapshot (placeholder) generated');
  res.json({ jpeg_b64: placeholder, timestamp: new Date().toISOString() });
});

// ── GET /api/cameras/:id/logs ─────────────────────────────────────────────────

router.get('/:id/logs', requireAuth, (req, res) => {
  log.debug({ reqId: req.id, cameraId: req.params.id }, 'fetching camera event logs');
  const cam = cameras.get(req.params.id);
  if (!cam) {
    log.warn({ reqId: req.id, cameraId: req.params.id }, 'camera not found for logs');
    return notFound(res, req.params.id);
  }

  const logs = cameraLogs.get(req.params.id) || [];
  log.trace({ cameraId: req.params.id, logCount: logs.length }, 'camera logs retrieved');
  res.json(logs);
});

module.exports = router;