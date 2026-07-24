/**
 * faceWorkerBridge.js
 * Manages one long-running face_worker.py process.
 * Commands sent via stdin JSON lines; responses read from stdout JSON lines.
 */
const { spawn }     = require('child_process');
const path          = require('path');
const EventEmitter  = require('events');
const log           = require('../utils/logger').child('faceWorker');

const PROJECT_ROOT  = path.join(__dirname, '../..');
const DETECTORS_DIR = path.join(PROJECT_ROOT, 'detectors');
const SCRIPT_PATH   = path.join(DETECTORS_DIR, 'face_worker.py');
const CROPS_DIR     = path.join(PROJECT_ROOT, 'data', 'crops');
const PYTHON_BIN    = process.env.PYTHON_BIN || process.env.PYTHON_EXECUTABLE || 'python3';

// The new worker reads RTSP over a raw FFmpeg pipe hardcoded to this
// resolution (see VideoGrabber.run(): width=640, height=360) — every box
// coordinate it emits is in this fixed space, and it no longer sends
// frame_width/frame_height per-event like the old worker did.
const STREAM_FRAME_WIDTH  = 640;
const STREAM_FRAME_HEIGHT = 360;

// How long a detected face is kept around waiting for its matching
// stream_recognize event (or just kept visible after being recognized)
// before being pruned from the "latest result" for a camera.
// The detector updates active tracks at ~2 FPS. Keeping disappeared tracks
// for 15 seconds caused old and replacement boxes to be shown together.
const FACE_TTL_MS   = 1_800;
const MAX_FACES_PER_CAMERA = 50;

class FaceWorkerBridge extends EventEmitter {
  constructor() {
    super();
    this.proc        = null;
    this.ready       = false;
    this.pendingCmds = new Map();
    this.stdoutBuf   = '';
    this.starting    = false;
    this.latestStreamResults = new Map(); // camera_id -> { camera_id, camera_name, facesMap: Map(event_uuid -> face), updated_at }
    this.activeStreams = new Set(); // camera_ids with a running stream thread
  }

  async start() {
    if (this.proc && !this.proc.killed) return;
    if (this.starting) {
      await new Promise(r => this.once('ready', r));
      return;
    }
    this.starting = true;

    return new Promise((resolve, reject) => {
      let settled = false;
      let startupTimer;
      const finishStartup = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(startupTimer);
        this.starting = false;
        if (error) reject(error);
        else resolve();
      };

      log.info({ python: PYTHON_BIN }, 'Spawning face_worker.py...');

      this.proc = spawn(PYTHON_BIN, [SCRIPT_PATH], {
        cwd: DETECTORS_DIR,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
      });

      if (!this.proc.pid) {
        return finishStartup(new Error(`Failed to spawn face_worker.py with "${PYTHON_BIN}"`));
      }

      this.proc.stdout.on('data', (chunk) => {
        this.stdoutBuf += chunk.toString();
        const lines = this.stdoutBuf.split('\n');
        this.stdoutBuf = lines.pop();
        for (const line of lines) {
          const t = line.trim();
          if (!t || !t.startsWith('{')) continue;
          try { this._handleMessage(JSON.parse(t)); }
          catch { log.warn({ snippet: t.slice(0, 100) }, 'bad JSON'); }
        }
      });

      this.proc.stderr.on('data', d => {
        const m = d.toString().trim();
        if (m) log.warn(m);
      });

      this.proc.on('close', (code) => {
        log.info({ code }, 'face_worker exited');
        if (!this.ready) {
          finishStartup(new Error(
            `face_worker.py exited before becoming ready (code ${code}). ` +
            `Check that "${PYTHON_BIN}" has the packages from detectors/requirements-face.txt.`
          ));
        }
        this.ready = false; this.starting = false; this.proc = null;
        this.activeStreams.clear();
        this.latestStreamResults.clear();
        for (const [, p] of this.pendingCmds) { clearTimeout(p.timer); p.reject(new Error('face_worker.py died')); }
        this.pendingCmds.clear();
        this.emit('exit', code);
      });

      this.proc.on('error', err => finishStartup(err));

      this.once('ready', () => finishStartup());
      startupTimer = setTimeout(() => {
        if (!this.ready) finishStartup(new Error('face_worker.py did not become ready in 120s'));
      }, 120_000);
    });
  }

  _getCameraEntry(cameraId, cameraName) {
    let entry = this.latestStreamResults.get(cameraId);
    if (!entry) {
      entry = { camera_id: cameraId, camera_name: cameraName || cameraId, facesMap: new Map(), updated_at: Date.now() };
      this.latestStreamResults.set(cameraId, entry);
    } else if (cameraName) {
      entry.camera_name = cameraName;
    }
    return entry;
  }

  _pruneFaces(entry) {
    const now = Date.now();
    for (const [uuid, f] of entry.facesMap) {
      if (now - f._ts > FACE_TTL_MS) entry.facesMap.delete(uuid);
    }
    if (entry.facesMap.size > MAX_FACES_PER_CAMERA) {
      const oldestFirst = [...entry.facesMap.entries()].sort((a, b) => a[1]._ts - b[1]._ts);
      for (let i = 0; i < oldestFirst.length - MAX_FACES_PER_CAMERA; i++) entry.facesMap.delete(oldestFirst[i][0]);
    }
  }

  _handleMessage(msg) {
    if (msg.event === 'ready') {
      this.ready = true;
      console.log('[FaceWorker] Ready ✓');
      this.emit('ready');
      return;
    }

    // Detection and recognition now arrive as two separate events
    // correlated by event_uuid — 'stream_detect' fires the instant a face
    // (or line crossing) is found, 'stream_recognize' fires once SFace
    // matching finishes, which can be moments later on a background thread
    // for line-crossing mode. We merge them into one "face" record per
    // camera so /stream/result and /stream/boxes keep the same shape.
    if (msg.event === 'stream_detect') {
      const entry = this._getCameraEntry(msg.camera_id, msg.camera_name);
      entry.facesMap.set(msg.event_uuid, {
        event_uuid:    msg.event_uuid,
        box:           msg.box || null,
        crop_filename: msg.crop_filename || null,
        is_known:      false,
        match:         null,
        score:         0,
        embedding:     null,
        gender:        null, // no longer produced by this worker build
        status:        'pending',
        _ts:           Date.now(),
      });
      entry.updated_at = Date.now();
      this._pruneFaces(entry);
      this.emit('stream_detect', msg);
      return;
    }

    // Box-only position update — no new event, just keep the face box fresh on the UI overlay
    if (msg.event === 'stream_box_update') {
      const entry = this.latestStreamResults.get(msg.camera_id);
      if (entry) {
        const existing = entry.facesMap.get(msg.event_uuid);
        if (existing && msg.box) {
          existing.box = msg.box;
          existing._ts = Date.now();   // refresh TTL so the face stays visible
          entry.updated_at = Date.now();
        }
      }
      return;
    }

    if (msg.event === 'stream_recognize') {
      const entry = this._getCameraEntry(msg.camera_id);
      const existing = entry.facesMap.get(msg.event_uuid) || {
        event_uuid: msg.event_uuid, box: null, _ts: Date.now(),
      };
      const merged = {
        ...existing,
        crop_filename: msg.crop_filename || existing.crop_filename || null,
        is_known:      !!msg.is_known,
        match:         msg.match || null,
        score:         msg.score || 0,
        embedding:     msg.embedding || null,
        gender:        null,
        status:        'recognized',
      };
      entry.facesMap.set(msg.event_uuid, merged);
      entry.updated_at = Date.now();
      this._pruneFaces(entry);
      const { _ts, ...publicFace } = merged;
      this.emit('stream_recognize', { camera_id: msg.camera_id, camera_name: entry.camera_name, ...publicFace });
      return;
    }

    if (msg.cmd) {
      const key = msg.camera_id ? `${msg.cmd}::${msg.camera_id}` : msg.cmd;
      const pending = this.pendingCmds.get(key);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingCmds.delete(key);
        if (msg.response?.status === 'error') pending.reject(new Error(msg.response.message));
        else pending.resolve(msg.response);
      }
    }
  }

  _send(cmd, payload, timeoutMs = 30_000) {
    if (!this.proc || this.proc.killed)
      return Promise.reject(new Error('face_worker.py is not running'));
    const key = payload.camera_id ? `${cmd}::${payload.camera_id}` : cmd;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCmds.delete(key);
        reject(new Error(`face_worker command "${cmd}" timed out`));
      }, timeoutMs);
      this.pendingCmds.set(key, { resolve, reject, timer });
      this.proc.stdin.write(JSON.stringify({ cmd, ...payload }) + '\n');
    });
  }

  extractEmbedding(imgPath) {
    return this._send('extract_embedding', { img_path: imgPath }, 20_000);
  }
  processVideoEnrollment(videoPath, cropsDir = CROPS_DIR) {
    return this._send('process_video_enrollment', { video_path: videoPath, crops_dir: cropsDir }, 120_000);
  }
  recognizeImage(imgPath, candidates = [], threshold = 0.60, disType = 0, cropsDir = CROPS_DIR) {
    return this._send('recognize_image', { img_path: imgPath, candidates, threshold, dis_type: disType, crops_dir: cropsDir }, 20_000);
  }
  startStream(cameraId, cameraName, rtspUrl, candidates = [], threshold = 0.60, disType = 0, cropsDir = CROPS_DIR, lineConfig = {}) {
    const {
      enabled:  line_crossing_enabled = false,
      line_y:      line_y             = 0.6,
      direction:   line_direction     = 'in',
      x_start:     line_x_start       = 0.0,
      x_end:       line_x_end         = 1.0,
    } = lineConfig;
    this.latestStreamResults.delete(cameraId); // drop stale faces from any previous run
    return this._send('start_stream', {
      camera_id: cameraId, camera_name: cameraName, rtsp_url: rtspUrl,
      candidates, threshold, dis_type: disType, crops_dir: cropsDir,
      line_crossing_enabled, line_y, line_direction, line_x_start, line_x_end,
    }).then(result => { this.activeStreams.add(cameraId); return result; });
  }
  stopStream(cameraId) {
    return this._send('stop_stream', { camera_id: cameraId })
      .then(result => {
        this.activeStreams.delete(cameraId);
        this.latestStreamResults.delete(cameraId);
        return result;
      });
  }
  isStreamActive(cameraId) { return this.activeStreams.has(cameraId); }
  updateCandidates(candidates = []) {
    return this._send('update_candidates', { candidates });
  }
  getLatestStreamResult(cameraId) {
    const entry = this.latestStreamResults.get(cameraId);
    if (!entry) return null;
    this._pruneFaces(entry);
    const faces = [...entry.facesMap.values()]
      .sort((a, b) => b._ts - a._ts)
      .map(({ _ts, ...f }) => f); // strip the internal timestamp before handing out
    return {
      camera_id:    entry.camera_id,
      camera_name:  entry.camera_name,
      faces,
      frame_width:  STREAM_FRAME_WIDTH,
      frame_height: STREAM_FRAME_HEIGHT,
      updated_at:   new Date(entry.updated_at).toISOString(),
    };
  }
  isReady() { return this.ready && !!this.proc && !this.proc.killed; }
  stop()    { if (this.proc && !this.proc.killed) this.proc.kill('SIGTERM'); }
}

module.exports = new FaceWorkerBridge();
