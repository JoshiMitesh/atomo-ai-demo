'use strict';

/**
 * Local browser-playback pipeline based on the original working server.js:
 *   camera RTSP -> local MediaMTX path -> WHEP/HLS in the browser
 *
 * H.265/HEVC cameras are transcoded to low-latency H.264 before publishing.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const API_BASE = String(
  process.env.LOCAL_MEDIAMTX_API || 'http://127.0.0.1:9997',
).replace(/\/+$/, '');
const RTSP_PORT = Number(process.env.LOCAL_MEDIAMTX_RTSP_PORT) || 8554;
const HLS_PORT = Number(process.env.LOCAL_MEDIAMTX_HLS_PORT) || 8888;
const WHEP_PORT = Number(process.env.LOCAL_MEDIAMTX_WEBRTC_PORT) || 8889;
const START_TIMEOUT_MS = Math.max(
  2000,
  Number(process.env.LOCAL_MEDIAMTX_START_TIMEOUT_MS) || 10000,
);

let mediamtxProcess = null;
let mediamtxStartPromise = null;
let shuttingDown = false;
let cleanupInstalled = false;
let respawnTimer = null;
const cameraSetupPromises = new Map();
const registeredSources = new Map();
const transcoderProcesses = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function localPlaybackEnabled() {
  return !['0', 'false', 'no', 'off'].includes(
    String(process.env.LOCAL_MEDIAMTX_ENABLED || 'true').toLowerCase(),
  );
}

function detectLanAddress() {
  try {
    const nets = os.networkInterfaces();
    for (const entries of Object.values(nets)) {
      for (const entry of entries || []) {
        if (entry && entry.family === 'IPv4' && !entry.internal) return entry.address;
      }
    }
  } catch (err) {
    console.warn('[local-mediamtx] LAN address detection failed:', err.message);
  }
  return '127.0.0.1';
}

function localMediaHost() {
  const configured = process.env.LOCAL_MEDIA_HOST
    || process.env.DASHBOARD_PUBLIC_HOST
    || process.env.APP_PUBLIC_HOST
    || '';
  if (!configured) return detectLanAddress();
  try {
    return new URL(configured.includes('://') ? configured : `http://${configured}`).hostname;
  } catch {
    return configured.replace(/^https?:\/\//i, '').split('/')[0].split(':')[0];
  }
}

function streamUrlOf(camera) {
  return String(camera?.rtspUrl || camera?.url || camera?.streamUrl || '').trim();
}

function playbackFields(cameraId) {
  const host = localMediaHost();
  const protocol = (process.env.LOCAL_MEDIA_PROTOCOL || 'http').replace(/:$/, '');
  return {
    localMediaPath: String(cameraId),
    localMediaHost: host,
    localProxyRtsp: `rtsp://127.0.0.1:${RTSP_PORT}/${cameraId}`,
    // Reachable from the remote vision board. Face/person workers should use
    // this H.264 MediaMTX output instead of decoding the original H.265 RTSP.
    workerRtspUrl: `rtsp://${host}:${RTSP_PORT}/${cameraId}`,
    whepUrl: `${protocol}://${host}:${WHEP_PORT}/${cameraId}/whep`,
    hlsUrl: `${protocol}://${host}:${HLS_PORT}/${cameraId}/index.m3u8`,
    mjpegUrl: `/api/cameras/${encodeURIComponent(cameraId)}/preview.mjpeg`,
  };
}

function projectRoot() {
  const candidates = [process.cwd(), path.resolve(__dirname, '..')];
  return candidates.find((candidate) => fs.existsSync(path.join(candidate, 'server.js')))
    || process.cwd();
}

function resolveBinary() {
  if (process.env.LOCAL_MEDIAMTX_BINARY) return process.env.LOCAL_MEDIAMTX_BINARY;
  const candidates = [
    path.join(process.cwd(), 'mediamtx'),
    path.resolve(__dirname, '..', 'mediamtx'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || 'mediamtx';
}

async function apiFetch(apiPath, options = {}) {
  const controller = new AbortController();
  const timeoutMs = Math.max(500, Number(options.timeoutMs) || 3000);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const init = { ...options, signal: controller.signal };
  delete init.timeoutMs;
  try {
    return await fetch(`${API_BASE}${apiPath}`, init);
  } finally {
    clearTimeout(timer);
  }
}

async function apiReady() {
  try {
    const response = await apiFetch('/v3/config/paths/list', { timeoutMs: 800 });
    // Any HTTP response proves that the local MediaMTX API socket is ready.
    return Boolean(response);
  } catch {
    return false;
  }
}

function installCleanup() {
  if (cleanupInstalled) return;
  cleanupInstalled = true;
  process.once('exit', () => {
    shuttingDown = true;
    if (respawnTimer) clearTimeout(respawnTimer);
    for (const proc of transcoderProcesses.values()) {
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
    }
    if (mediamtxProcess) {
      try { mediamtxProcess.kill('SIGKILL'); } catch { /* ignore */ }
    }
  });
}

async function ensureLocalMediaMtx() {
  if (!localPlaybackEnabled()) {
    return { ok: false, disabled: true, error: 'Local MediaMTX is disabled' };
  }
  if (await apiReady()) return { ok: true, alreadyRunning: true };
  if (mediamtxStartPromise) return mediamtxStartPromise;

  const pending = (async () => {
    installCleanup();
    const binary = resolveBinary();
    const cwd = projectRoot();
    let spawnError = null;

    console.log(`[local-mediamtx] starting ${binary} in ${cwd}`);
    const child = spawn(binary, [], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    mediamtxProcess = child;

    const logChunk = (kind, chunk) => {
      const message = String(chunk || '').trim();
      if (!message) return;
      if (/err|warn|failed/i.test(message)) {
        console.warn(`[local-mediamtx] ${kind}:`, message.slice(0, 600));
      }
    };
    child.stdout?.on('data', (chunk) => logChunk('output', chunk));
    child.stderr?.on('data', (chunk) => logChunk('error', chunk));
    child.once('error', (err) => {
      spawnError = err;
      console.warn('[local-mediamtx] process error:', err.message);
    });
    child.once('close', (code, signal) => {
      if (mediamtxProcess === child) mediamtxProcess = null;
      // Dynamic path configuration lives inside the MediaMTX process.  Never
      // trust the in-memory cache after that process has exited.
      registeredSources.clear();
      if (!shuttingDown && code !== 0 && code !== null) {
        console.warn(`[local-mediamtx] exited code=${code} signal=${signal}; retrying in 5s`);
        respawnTimer = setTimeout(() => {
          mediamtxStartPromise = null;
          ensureLocalMediaMtx().catch(() => {});
        }, 5000);
      }
    });

    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (spawnError) break;
      if (await apiReady()) {
        console.log('[local-mediamtx] ready');
        return { ok: true, started: true, binary, cwd };
      }
      await sleep(150);
    }

    return {
      ok: false,
      error: spawnError?.message
        || `Local MediaMTX API did not become ready at ${API_BASE}`,
      binary,
      cwd,
    };
  })();

  mediamtxStartPromise = pending;
  try {
    return await pending;
  } finally {
    if (mediamtxStartPromise === pending) mediamtxStartPromise = null;
  }
}

async function pathRequest(action, cameraId, body = null) {
  const response = await apiFetch(
    `/v3/config/paths/${action}/${encodeURIComponent(cameraId)}`,
    {
      method: 'POST',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      timeoutMs: 4000,
    },
  );
  const text = await response.text();
  if (!response.ok) {
    const err = new Error(
      `MediaMTX path ${action} failed (${response.status})${text ? `: ${text.slice(0, 300)}` : ''}`,
    );
    err.status = response.status;
    throw err;
  }
  return text;
}

async function deletePath(cameraId) {
  try {
    await pathRequest('delete', cameraId);
  } catch (err) {
    if (err.status !== 404) throw err;
  }
}

async function addSourcePath(cameraId, rtspUrl) {
  await deletePath(cameraId);
  await pathRequest('add', cameraId, {
    source: rtspUrl,
    sourceOnDemand: false,
    sourceProtocol: 'tcp',
  });
}

async function addPublisherPath(cameraId) {
  await deletePath(cameraId);
  await pathRequest('add', cameraId, { source: 'publisher' });
}

function probeCodec(rtspUrl, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const proc = spawn('ffprobe', [
      '-v', 'error',
      '-rtsp_transport', 'tcp',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      rtspUrl,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let output = '';
    let done = false;
    const finish = (codec) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(String(codec || 'unknown').trim().toLowerCase() || 'unknown');
    };
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      finish('unknown');
    }, timeoutMs);
    proc.stdout.on('data', (chunk) => { output += String(chunk); });
    proc.once('error', () => finish('unknown'));
    proc.once('close', (code) => finish(code === 0 ? output : 'unknown'));
  });
}

function stopTranscoder(cameraId) {
  const proc = transcoderProcesses.get(cameraId);
  if (!proc) return;
  transcoderProcesses.delete(cameraId);
  try { proc.kill('SIGTERM'); } catch { /* ignore */ }
  setTimeout(() => {
    try { if (!proc.killed) proc.kill('SIGKILL'); } catch { /* ignore */ }
  }, 1500);
}

function startTranscoder(cameraId, rtspUrl) {
  stopTranscoder(cameraId);
  const target = `rtsp://127.0.0.1:${RTSP_PORT}/${cameraId}`;
  const proc = spawn('ffmpeg', [
    '-hide_banner',
    '-loglevel', 'warning',
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
    target,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  let lastLogAt = 0;
  proc.stderr.on('data', (chunk) => {
    const now = Date.now();
    if (now - lastLogAt < 5000) return;
    lastLogAt = now;
    const message = String(chunk || '').trim();
    if (message) console.warn(`[local-mediamtx] ffmpeg ${cameraId}:`, message.slice(0, 500));
  });
  proc.once('error', (err) => {
    console.warn(`[local-mediamtx] ffmpeg ${cameraId} failed:`, err.message);
  });
  proc.once('close', (code, signal) => {
    if (transcoderProcesses.get(cameraId) === proc) transcoderProcesses.delete(cameraId);
    if (!shuttingDown) {
      console.warn(`[local-mediamtx] ffmpeg ${cameraId} exited code=${code} signal=${signal}`);
    }
  });
  transcoderProcesses.set(cameraId, proc);
  return proc;
}

async function ensureLocalCameraPath(camera, options = {}) {
  const cameraId = String(camera?.id || '').trim();
  const rtspUrl = streamUrlOf(camera);
  if (!cameraId || !rtspUrl) {
    return { ok: false, error: 'Camera ID or RTSP URL is missing' };
  }

  if (
    !options.force
    && registeredSources.get(cameraId) === rtspUrl
  ) {
    if (await apiReady()) {
      return { ok: true, alreadyRegistered: true, ...playbackFields(cameraId) };
    }
    registeredSources.delete(cameraId);
  }
  if (cameraSetupPromises.has(cameraId)) return cameraSetupPromises.get(cameraId);

  const pending = (async () => {
    const media = await ensureLocalMediaMtx();
    if (!media.ok) return { ...media, cameraId };

    try {
      const localInput = /^rtsp:\/\/(localhost|127\.0\.0\.1)(:|\/)/i.test(rtspUrl);
      const codec = localInput ? 'publisher' : await probeCodec(rtspUrl);
      if (codec === 'hevc' || codec === 'h265') {
        console.log(`[local-mediamtx] ${cameraId}: H.265 -> local H.264 transcoder`);
        await addPublisherPath(cameraId);
        startTranscoder(cameraId, rtspUrl);
        await sleep(1200);
      } else if (localInput) {
        // A local/mock publisher already owns this path.
        console.log(`[local-mediamtx] ${cameraId}: using existing local publisher`);
      } else {
        stopTranscoder(cameraId);
        console.log(`[local-mediamtx] ${cameraId}: RTSP proxy (${codec || 'unknown'})`);
        await addSourcePath(cameraId, rtspUrl);
      }

      registeredSources.set(cameraId, rtspUrl);
      return {
        ok: true,
        cameraId,
        codec,
        registered: true,
        ...playbackFields(cameraId),
      };
    } catch (err) {
      return { ok: false, cameraId, error: err.message, ...playbackFields(cameraId) };
    }
  })();

  cameraSetupPromises.set(cameraId, pending);
  try {
    return await pending;
  } finally {
    if (cameraSetupPromises.get(cameraId) === pending) cameraSetupPromises.delete(cameraId);
  }
}

async function unregisterLocalCameraPath(cameraId) {
  const id = String(cameraId || '').trim();
  if (!id) return { ok: false, error: 'Camera ID is required' };
  stopTranscoder(id);
  registeredSources.delete(id);
  if (!(await apiReady())) return { ok: true, alreadyStopped: true };
  try {
    await deletePath(id);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function getLocalMediaStatus() {
  return {
    enabled: localPlaybackEnabled(),
    processRunning: Boolean(mediamtxProcess && !mediamtxProcess.killed),
    apiBase: API_BASE,
    host: localMediaHost(),
    ports: { rtsp: RTSP_PORT, hls: HLS_PORT, whep: WHEP_PORT },
    registeredCameraIds: [...registeredSources.keys()],
    transcodingCameraIds: [...transcoderProcesses.keys()],
  };
}

module.exports = {
  ensureLocalMediaMtx,
  ensureLocalCameraPath,
  unregisterLocalCameraPath,
  getLocalMediaStatus,
  playbackFields,
};
