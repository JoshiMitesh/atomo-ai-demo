require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const morgan  = require('morgan');
const http    = require('http');
const path    = require('path');
const fs      = require('fs');
const os      = require('os');
const { spawn, exec } = require('child_process');
const { WebSocketServer, WebSocket } = require('ws');
const log = require('./utils/logger').child('server');

const app    = express();
const server = http.createServer(app);

log.debug('initializing express server with middleware');

// Allow all origins (so the frontend on a different machine can talk to this backend)
app.use(cors({ origin: '*', methods: ['GET','POST','PUT','DELETE','OPTIONS'], allowedHeaders: '*' }));
log.debug('CORS enabled');

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(morgan('dev'));

// ── Static Assets ───────────────────────────────────────────────────────────
const PROJECT_ROOT       = path.join(__dirname, '..');
const CROPS_DIR_STATIC   = path.join(PROJECT_ROOT, 'data', 'crops');
const UPLOADS_DIR_STATIC = path.join(PROJECT_ROOT, 'uploads');

[CROPS_DIR_STATIC, UPLOADS_DIR_STATIC,
 path.join(UPLOADS_DIR_STATIC, 'faces'),
 path.join(UPLOADS_DIR_STATIC, 'enrollment')
].forEach(d => fs.mkdirSync(d, { recursive: true }));

app.use('/crops',   express.static(CROPS_DIR_STATIC));
app.use('/uploads', express.static(UPLOADS_DIR_STATIC));
app.use(express.static(path.join(PROJECT_ROOT, '../frontend')));
log.debug('static file serving configured', { crops: CROPS_DIR_STATIC, uploads: UPLOADS_DIR_STATIC });

// ── Routes ──────────────────────────────────────────────────────────────────
log.info('registering API routes');
app.use('/api/auth',     require('./routes/auth'));
app.use('/api/cameras',  require('./routes/cameras'));
app.use('/api/models',   require('./routes/models'));
app.use('/api/detect',   require('./routes/detect'));
app.use('/api/face',     require('./routes/face'));
app.use('/api/system',   require('./routes/system'));
app.use('/api/events',   require('./routes/events'));
app.use('/api/settings', require('./routes/settings'));

// Compatibility aliases so /api/persons, /api/clusters, /api/analyze work directly
app.use('/api', require('./routes/face'));

app.get('/health', (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

app.get('/api', (req, res) => {
  res.json({
    name: 'Vision Backend API',
    version: '1.0.0',
    endpoints: {
      auth:     '/api/auth',
      cameras:  '/api/cameras',
      models:   '/api/models',
      detect:   '/api/detect',
      face:     '/api/face',
      system:   '/api/system',
      events:   '/api/events',
      settings: '/api/settings',
      persons:  '/api/persons',
      clusters: '/api/clusters'
    }
  });
});

// ── MediaMTX subprocess ─────────────────────────────────────────────────────
// Mirrors small backend: auto-start the mediamtx binary on server boot,
// restart it automatically if it crashes.
let mediamtxProcess = null;

function startMediaMTX() {
  log.info('Starting MediaMTX RTSP server...');
  mediamtxProcess = spawn('./mediamtx', [], { cwd: PROJECT_ROOT });

  mediamtxProcess.stdout.on('data', (data) => {
    const s = data.toString().trim();
    if (s.includes('ERR') || s.includes('warn')) {
      log.warn('[MediaMTX] ' + s);
    }
  });

  mediamtxProcess.stderr.on('data', () => {
    // Suppress normal startup noise from mediamtx
  });

  mediamtxProcess.on('close', (code) => {
    if (code !== 0 && code !== null) {
      log.error({ code }, 'MediaMTX exited unexpectedly. Re-spawning in 5 s...');
      setTimeout(startMediaMTX, 5000);
    }
  });
}
startMediaMTX();

// ── FFmpeg Mock Loop-Stream Management ─────────────────────────────────────
// camera_id → childProcess  (for uploaded-video looping streams)
const ffmpegProcesses = new Map();

function startMockFFmpegStream(cameraId, videoPath) {
  stopMockFFmpegStream(cameraId);
  log.info({ cameraId, videoPath }, 'Starting FFmpeg loop stream');
  const rtspUrl = `rtsp://127.0.0.1:8554/${cameraId}`;

  const proc = spawn('ffmpeg', [
    '-re', '-stream_loop', '-1', '-i', videoPath,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
    '-an', '-f', 'rtsp', '-rtsp_transport', 'tcp', rtspUrl
  ]);

  proc.stderr.on('data', () => {}); // suppress ffmpeg noise

  proc.on('close', (code) => {
    log.info({ cameraId, code }, 'FFmpeg loop stream exited');
    ffmpegProcesses.delete(cameraId);
  });

  ffmpegProcesses.set(cameraId, proc);
  return rtspUrl;
}

function stopMockFFmpegStream(cameraId) {
  if (ffmpegProcesses.has(cameraId)) {
    log.info({ cameraId }, 'Stopping FFmpeg loop stream');
    try { ffmpegProcesses.get(cameraId).kill('SIGKILL'); } catch (e) {}
    ffmpegProcesses.delete(cameraId);
  }
}

// ── FFmpeg Transcoder (H.265 → H.264) ──────────────────────────────────────
// For cameras that emit HEVC streams, we transcode on-the-fly to H.264
// before pushing into MediaMTX so the Python worker (libx264) can read it.
const transcoderProcesses = new Map();

function getStreamCodec(rtspUrl) {
  return new Promise((resolve) => {
    const cmd = `ffprobe -v error -rtsp_transport tcp -select_streams v:0 -show_entries stream=codec_name -of default=noprint_wrappers=1:nokey=1 "${rtspUrl}"`;
    exec(cmd, { timeout: 5000 }, (err, stdout) => {
      if (err) { resolve('unknown'); } else { resolve(stdout.trim().toLowerCase()); }
    });
  });
}

function startTranscoder(cameraId, rtspUrl) {
  stopTranscoder(cameraId);
  log.info({ cameraId, rtspUrl }, 'Starting H.265→H.264 transcoder');
  const targetRtsp = `rtsp://127.0.0.1:8554/${cameraId}`;

  const proc = spawn('ffmpeg', [
    '-allowed_media_types', 'video',
    '-rtsp_transport', 'tcp',
    '-fflags', 'nobuffer',
    '-probesize', '100000',
    '-analyzeduration', '0',
    '-i', rtspUrl,
    '-vf', 'scale=960:-2,fps=8',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-bf', '0',
    '-g', '8',
    '-crf', '22',
    '-threads', '1',
    '-an',
    '-f', 'rtsp',
    '-rtsp_transport', 'tcp',
    targetRtsp
  ]);

  proc.stderr.on('data', () => {}); // suppress ffmpeg noise

  proc.on('close', (code) => {
    log.info({ cameraId, code }, 'Transcoder exited');
    transcoderProcesses.delete(cameraId);
  });

  transcoderProcesses.set(cameraId, proc);
}

function stopTranscoder(cameraId) {
  if (transcoderProcesses.has(cameraId)) {
    log.info({ cameraId }, 'Stopping transcoder');
    try { transcoderProcesses.get(cameraId).kill('SIGKILL'); } catch (e) {}
    transcoderProcesses.delete(cameraId);
  }
}

// ── MediaMTX path helpers (mirrors small backend) ──────────────────────────
async function registerMediaMtxPath(cameraId, rtspUrl) {
  if (rtspUrl.startsWith('rtsp://localhost') || rtspUrl.startsWith('rtsp://127.0.0.1')) return;
  log.info({ cameraId, rtspUrl }, '[MediaMTX] Registering remote RTSP path');
  try {
    const res = await fetch(`http://localhost:9997/v3/config/paths/add/${cameraId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: rtspUrl, sourceOnDemand: false, sourceProtocol: 'tcp' })
    });
    if (!res.ok) log.warn({ status: res.status }, '[MediaMTX] path add returned non-OK');
  } catch (err) {
    log.error({ err: err.message }, '[MediaMTX] path add failed');
  }
}

async function registerMediaMtxPublisherPath(cameraId) {
  try {
    await fetch(`http://localhost:9997/v3/config/paths/add/${cameraId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'publisher' })
    });
  } catch (err) {
    log.error({ err: err.message }, '[MediaMTX] publisher path add failed');
  }
}

async function unregisterMediaMtxPath(cameraId) {
  try {
    await fetch(`http://localhost:9997/v3/config/paths/delete/${cameraId}`, { method: 'POST' });
  } catch (err) {
    log.error({ err: err.message }, '[MediaMTX] path delete failed');
  }
}

// ── Full camera stream start/stop (mirrors small backend) ──────────────────
const faceBridge    = require('./services/faceWorkerBridge');
const personStore   = require('./services/personStore');
const lineConfStore = require('./services/lineConfigStore');
const { cameras, saveCamerasToDB } = require('./store');
const { readDB }    = require('./services/dbStore');

async function startCameraStream(camera) {
  const rtspUrl = camera.url || camera.rtsp_url || '';
  const isLocal = rtspUrl.startsWith('rtsp://localhost') || rtspUrl.startsWith('rtsp://127.0.0.1');

  if (!isLocal) {
    // Clean up any previous path config to avoid publish conflicts
    await unregisterMediaMtxPath(camera.id);
    const codec = await getStreamCodec(rtspUrl);
    log.info({ cameraId: camera.id, codec }, 'Detected stream codec');

    if (codec === 'hevc' || codec === 'h265') {
      log.info({ cameraId: camera.id }, 'H.265 stream — starting transcoder');
      await registerMediaMtxPublisherPath(camera.id);
      startTranscoder(camera.id, rtspUrl);
      // Brief wait for transcoder to start publishing before Python connects
      await new Promise(r => setTimeout(r, 1500));
    } else {
      log.info({ cameraId: camera.id, codec }, 'Proxying directly through MediaMTX');
      await registerMediaMtxPath(camera.id, rtspUrl);
    }
  }

  const targetRtsp = isLocal ? rtspUrl : `rtsp://127.0.0.1:8554/${camera.id}`;
  log.info({ cameraId: camera.id, targetRtsp }, 'Starting Python stream thread');

  const lineConfig = lineConfStore.getConfig(camera.id);
  const candidates = personStore.getCandidatesPayload();
  const db = readDB();
  const settings = db.settings || { threshold: 0.60, dis_type: 0 };

  return faceBridge.startStream(
    camera.id, camera.name, targetRtsp,
    candidates, settings.threshold, settings.dis_type,
    CROPS_DIR_STATIC, lineConfig
  );
}

async function stopCameraStream(camera) {
  try {
    await faceBridge.stopStream(camera.id);
  } catch (err) {
    log.warn({ err: err.message, cameraId: camera.id }, 'Python stop_stream error');
  }

  stopMockFFmpegStream(camera.id);
  stopTranscoder(camera.id);

  const rtspUrl = camera.url || camera.rtsp_url || '';
  const isLocal = rtspUrl.startsWith('rtsp://localhost') || rtspUrl.startsWith('rtsp://127.0.0.1');
  if (!isLocal) {
    await unregisterMediaMtxPath(camera.id);
  }
}

// ── Auto-resume active cameras when Python worker becomes ready ─────────────
// Mirrors small backend's resumeActiveStreams() — called on every worker restart
async function resumeActiveStreams() {
  const allCams = Array.from(cameras.values()).filter(c => c.is_active);
  if (allCams.length === 0) return;
  log.info({ count: allCams.length }, 'Auto-resuming active camera streams after worker ready');
  for (const cam of allCams) {
    try {
      await startCameraStream(cam);
    } catch (err) {
      log.error({ err: err.message, cameraId: cam.id }, 'Failed to auto-resume camera stream');
    }
  }
}

faceBridge.on('ready', () => {
  log.info('Face worker is ready — resuming active streams');
  resumeActiveStreams();
});

// Expose helpers to routes via app.locals so cameras.js can use them
app.locals.startCameraStream     = startCameraStream;
app.locals.stopCameraStream      = stopCameraStream;
app.locals.startMockFFmpegStream = startMockFFmpegStream;
app.locals.stopMockFFmpegStream  = stopMockFFmpegStream;

// ── WebSocket Server ────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });
log.info('WebSocket server initialized');

const { setBroadcast } = require('./store/websocketBroadcast');
const eventStore = require('./services/eventStore');

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}
setBroadcast(broadcast);

wss.on('connection', (ws, req) => {
  const urlObj   = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const cameraId = urlObj.searchParams.get('camera');
  const modelId  = urlObj.searchParams.get('model');

  // Send initial state to newly connected client
  try {
    const db = readDB();
    ws.send(JSON.stringify({
      event: 'connection_init',
      data: {
        status:  db.settings || { threshold: 0.60, dis_type: 0 },
        cameras: Array.from(cameras.values()),
        events:  eventStore.getEvents(30)
      }
    }));
  } catch (err) {
    log.error({ err }, 'Error sending connection_init payload');
  }

  // Stream polling for specific camera/model parameter connections
  if (cameraId && modelId) {
    log.info({ cameraId, modelId }, 'WebSocket streaming session opened');
    const { getWorkerResult } = require('./services/worker');

    const interval = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) { clearInterval(interval); return; }
      let result = null;
      if (modelId === 'mdl_face') {
        result = faceBridge.getLatestStreamResult(cameraId);
      } else {
        result = getWorkerResult(cameraId, modelId);
      }
      if (result) ws.send(JSON.stringify(result));
    }, 500);

    ws.on('close', () => clearInterval(interval));
    ws.on('error', () => clearInterval(interval));
  }
});

// ── Error handling ──────────────────────────────────────────────────────────
app.use((req, res) => {
  log.warn({ method: req.method, path: req.path }, 'route not found — 404');
  res.status(404).json({ error: 'Route not found' });
});

app.use((err, req, res, _next) => {
  log.error({ method: req.method, path: req.path, err }, 'unhandled error');
  res.status(500).json({ error: err.message || 'Internal server error' });
});

const { startPoller } = require('./services/systemStore');
startPoller();

// ── Cleanup on exit ─────────────────────────────────────────────────────────
function cleanup() {
  log.info('Cleaning up sub-processes...');
  if (mediamtxProcess) { try { mediamtxProcess.kill('SIGKILL'); } catch (e) {} }
  ffmpegProcesses.forEach(proc  => { try { proc.kill('SIGKILL'); } catch (e) {} });
  transcoderProcesses.forEach(proc => { try { proc.kill('SIGKILL'); } catch (e) {} });
}
process.on('exit', cleanup);
process.on('SIGINT',  () => { cleanup(); process.exit(); });
process.on('SIGTERM', () => { cleanup(); process.exit(); });

// ── Start server ────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || '0.0.0.0';

function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

server.listen(PORT, HOST, () => {
  const ip = getLocalIP();
  log.info({ port: PORT, host: HOST, env: process.env.NODE_ENV || 'development' }, 'server started successfully');
  console.log(`\n  Vision Backend running on http://${ip}:${PORT}  (or http://localhost:${PORT})`);
  console.log(` API overview:  http://${ip}:${PORT}/api`);
  console.log(` Health check:  http://${ip}:${PORT}/health`);
  console.log(` WebSocket:     ws://${ip}:${PORT}/ws`);
});

module.exports = { app, server };
