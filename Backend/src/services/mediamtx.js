/**
 * mediamtx.js — MediaMTX v3 API wrapper
 *
 * Correct endpoint for adding a pull path:
 *   POST /v3/config/paths/add/{name}
 *   Body: { "source": "rtsp://...", "sourceOnDemand": false }
 *
 * NOT /v3/paths/{name}/source  ← that doesn't exist in v3
 */

const axios = require('axios');
const log = require('../utils/logger').child('mediamtx');

const MTX_API   = process.env.MEDIAMTX_API_URL  || 'http://127.0.0.1:9997';
const RTSP_PORT  = process.env.MEDIAMTX_RTSP_PORT || 8554;
const WHEP_PORT  = process.env.MEDIAMTX_WHEP_PORT || 8889;
// MEDIAMTX_WHEP_HOST: the IP/hostname browsers will use to reach MediaMTX WHEP.
// Defaults to the machine's outbound IP so remote browsers work out of the box.
const os = require('os');
function getHostIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}
const WHEP_HOST  = process.env.MEDIAMTX_WHEP_HOST || getHostIP();

function whepUrl(pathName) {
  return `http://${WHEP_HOST}:${WHEP_PORT}/${pathName}/whep`;
}

function localRtsp(pathName) {
  return `rtsp://localhost:${RTSP_PORT}/${pathName}`;
}

async function validateStream(url, credentials = {}) {
  log.debug({ url }, 'validating stream reachability');
  // In production: run ffprobe here
  // ffprobe -v error -rtsp_transport tcp -show_entries stream=codec_name,r_frame_rate,width,height "<url>"
  const result = { reachable: true, codec: 'H264', resolution: '1920x1080', fps: 25 };
  log.trace({ url, result }, 'stream validation result');
  return result;
}

/**
 * Register a new path in MediaMTX so it pulls from sourceUrl.
 *
 * MediaMTX v3 correct endpoint:
 *   POST /v3/config/paths/add/{name}
 */
async function addPath(pathName, sourceUrl, credentials = {}) {
  log.debug({ pathName, sourceUrl }, 'adding path to MediaMTX');
  // Embed credentials into the URL if provided
  let src = sourceUrl;
  if (credentials.username && credentials.password) {
    try {
      const u = new URL(sourceUrl);
      u.username = encodeURIComponent(credentials.username);
      u.password = encodeURIComponent(credentials.password);
      src = u.toString();
      log.debug({ pathName }, 'credentials embedded in source URL');
    } catch {
      // not a parseable URL — pass as-is, MediaMTX handles it
      log.trace({ pathName }, 'source URL not parseable, using as-is');
    }
  }

  const body = {
    source: src,
    sourceOnDemand: false,   // pull immediately, don't wait for a reader
    record: false,
  };

  try {
    log.debug({ pathName, endpoint: `${MTX_API}/v3/config/paths/add/${pathName}` }, 'posting to MediaMTX API');
    await axios.post(`${MTX_API}/v3/config/paths/add/${pathName}`, body, {
      timeout: 5000,
      headers: { 'Content-Type': 'application/json' },
    });
    log.info({ pathName, sourceUrl }, 'path registered in MediaMTX');
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data?.error || err.message;

    if (status === 400 && detail?.includes('already exists')) {
      // Path already registered — patch it instead. patchPath() now throws
      // on real failure, which propagates naturally out of this await.
      log.info({ pathName }, 'path already exists, patching instead');
      await patchPath(pathName, sourceUrl, credentials);
    } else {
      // Previously this only logged and let addPath() resolve as if
      // registration succeeded — callers (cameras.js) then marked the
      // camera "online" with a local_rtsp pointing at a path MediaMTX
      // never actually created, so every downstream RTSP client (the face
      // worker's ffmpeg) would connect-then-instant-EOF forever with no
      // indication why. Throw so the caller's try/catch does its job.
      log.error({ pathName, status, detail }, 'addPath failed');
      throw new Error(`MediaMTX addPath failed (${status || 'no response'}): ${detail}`);
    }
  }

  return {
    whepUrl: whepUrl(pathName),
    localRtsp: localRtsp(pathName),
  };
}

/**
 * Update an existing path (e.g. new source URL).
 *
 * MediaMTX v3: PATCH /v3/config/paths/patch/{name}
 */
async function patchPath(pathName, sourceUrl, credentials = {}) {
  log.debug({ pathName, sourceUrl }, 'patching MediaMTX path');
  let src = sourceUrl;
  if (credentials.username && credentials.password) {
    try {
      const u = new URL(sourceUrl);
      u.username = encodeURIComponent(credentials.username);
      u.password = encodeURIComponent(credentials.password);
      src = u.toString();
    } catch {}
  }

  try {
    log.debug({ pathName }, 'sending PATCH to MediaMTX');
    await axios.patch(`${MTX_API}/v3/config/paths/patch/${pathName}`,
      { source: src },
      { timeout: 5000, headers: { 'Content-Type': 'application/json' } }
    );
    log.info({ pathName }, 'path patched in MediaMTX');
  } catch (err) {
    const detail = err.response?.data?.error || err.message;
    log.error({ pathName, detail }, 'patchPath failed');
    // Previously this only logged and returned as if it succeeded, which let
    // callers (addPath's "already exists" branch, and cameras.js's PUT
    // route) believe registration worked when it hadn't. Surface it.
    throw new Error(`MediaMTX patchPath failed: ${detail}`);
  }

  return { whepUrl: whepUrl(pathName), localRtsp: localRtsp(pathName) };
}

/**
 * Remove a path.
 *
 * MediaMTX v3: DELETE /v3/config/paths/delete/{name}
 */
async function removePath(pathName) {
  log.debug({ pathName }, 'removing path from MediaMTX');
  try {
    log.debug({ pathName }, 'sending DELETE to MediaMTX');
    await axios.delete(`${MTX_API}/v3/config/paths/delete/${pathName}`, { timeout: 5000 });
    log.info({ pathName }, 'path removed from MediaMTX');
  } catch (err) {
    if (err.response?.status !== 404) {
      log.error({ pathName, err: err.message }, 'removePath failed');
    } else {
      log.debug({ pathName }, 'path not found in MediaMTX (already removed)');
    }
  }
}

/**
 * List all active paths (for health checks).
 */
async function listPaths() {
  log.debug('listing MediaMTX paths');
  try {
    const { data } = await axios.get(`${MTX_API}/v3/paths/list`, { timeout: 3000 });
    const items = data.items || [];
    log.trace({ pathCount: items.length }, 'paths listed');
    return items;
  } catch (err) {
    log.warn({ err: err.message }, 'failed to list MediaMTX paths');
    return [];
  }
}

module.exports = {
  validateStream,
  addPath,
  patchPath,
  removePath,
  listPaths,
  whepUrl,
  localRtsp,
};