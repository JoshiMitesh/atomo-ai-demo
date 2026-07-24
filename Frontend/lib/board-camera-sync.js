'use strict';

const cameraStore = require('./camera-store');
const { normalizeMediaUrl } = require('./camera-analytics');
const { createVisionClient } = require('./vision-api');
const {
  ensureLocalCameraPath,
  unregisterLocalCameraPath,
  getLocalMediaStatus,
} = require('./local-mediamtx');

const visionClient = createVisionClient(
  process.env.VISION_API_URL || process.env.BACKEND_API_URL,
  { label: 'camera-sync' },
);
const syncPromises = new Map();
const streamRestartPromises = new Map();
const streamStartedAt = new Map();
const STREAM_RESTART_TTL_MS = Math.max(
  5000,
  Number(process.env.BOARD_STREAM_RESTART_TTL_MS) || 30000,
);

function streamUrlOf(camera) {
  return String(camera?.rtspUrl || camera?.url || camera?.streamUrl || '').trim();
}

function normalizeForCompare(url) {
  return String(url || '').trim().replace(/\/+$/, '').toLowerCase();
}

function listFromResponse(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.cameras)) return payload.cameras;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.items)) return payload.items;
  return [];
}

function publicMediaHost() {
  const configured = process.env.VISION_PUBLIC_HOST
    || process.env.MEDIA_PUBLIC_HOST
    || process.env.BOARD_PUBLIC_HOST
    || process.env.BOARD_IP
    || '';
  try {
    if (configured) {
      return new URL(configured.includes('://') ? configured : `http://${configured}`).hostname;
    }
    return new URL(visionClient.BASE).hostname;
  } catch {
    return configured || 'localhost';
  }
}

function mediaFields(backendId, source = {}) {
  const host = publicMediaHost();
  const protocol = (process.env.MEDIA_PUBLIC_PROTOCOL || 'http').replace(/:$/, '');
  const rtspPort = Number(process.env.MEDIAMTX_RTSP_PORT) || 8554;
  const hlsPort = Number(process.env.MEDIAMTX_HLS_PORT) || 8888;
  const whepPort = Number(process.env.MEDIAMTX_WEBRTC_PORT) || 8889;

  return {
    backendId,
    whepUrl: normalizeMediaUrl(
      source.whepUrl
        || source.whep_url
        || source.webrtc_url
        || `${protocol}://${host}:${whepPort}/${backendId}/whep`,
    ),
    hlsUrl: normalizeMediaUrl(
      source.hlsUrl
        || source.hls_url
        || `${protocol}://${host}:${hlsPort}/${backendId}/index.m3u8`,
    ),
    localRtsp: source.localRtsp
      || source.local_rtsp
      || `rtsp://${host}:${rtspPort}/${backendId}`,
    backendSyncedAt: new Date().toISOString(),
  };
}

function findExistingCamera(cameras, camera) {
  const backendId = String(camera?.backendId || '').trim();
  if (backendId) {
    const byId = cameras.find((entry) => String(entry?.id || entry?.camera_id || '') === backendId);
    if (byId) return byId;
  }

  const wantedUrl = normalizeForCompare(streamUrlOf(camera));
  if (wantedUrl) {
    const byUrl = cameras.find((entry) => normalizeForCompare(
      entry?.url || entry?.rtspUrl || entry?.rtsp_url || entry?.streamUrl,
    ) === wantedUrl);
    if (byUrl) return byUrl;
  }

  const wantedName = String(camera?.name || '').trim().toLowerCase();
  if (wantedName) {
    return cameras.find((entry) => String(entry?.name || '').trim().toLowerCase() === wantedName) || null;
  }
  return null;
}

function saveBoardMapping(camera, backendCamera) {
  const backendId = String(
    backendCamera?.id || backendCamera?.camera_id || camera?.backendId || '',
  ).trim();
  if (!backendId) return camera;
  const patch = mediaFields(backendId, backendCamera);
  return cameraStore.updateCamera(camera.id, patch) || { ...camera, ...patch };
}

/**
 * Browser playback deliberately stays local, matching the original working
 * server.js/app.js pipeline:
 *
 *   camera RTSP -> frontend MediaMTX -> /<dashboard-camera-id>/whep|index.m3u8
 *
 * The vision backend ID remains attached to the record and is used only for
 * detection/face API calls.  Mixing these two IDs was the reason MediaMTX
 * returned 404 even though ports 8888 and 8889 were reachable.
 */
async function attachLocalPlayback(camera, options = {}) {
  if (!camera?.id || !streamUrlOf(camera)) return camera;

  const local = await ensureLocalCameraPath(camera, {
    force: options.force === true,
  });
  if (!local.ok) {
    const patch = {
      localMediaReady: false,
      localMediaError: local.error || 'Local MediaMTX path could not be created',
      localMediaSyncedAt: new Date().toISOString(),
    };
    const updated = cameraStore.updateCamera(camera.id, patch) || { ...camera, ...patch };
    console.warn('[board-camera-sync] local playback failed:', camera.id, patch.localMediaError);
    return updated;
  }

  const patch = {
    // These local URLs must win over URLs generated from the remote backend ID.
    whepUrl: local.whepUrl,
    hlsUrl: local.hlsUrl,
    localRtsp: local.localProxyRtsp,
    workerRtspUrl: local.workerRtspUrl,
    localMediaPath: local.localMediaPath,
    localMediaHost: local.localMediaHost,
    localMediaCodec: local.codec || camera.localMediaCodec || null,
    localMediaReady: true,
    localMediaError: null,
    localMediaSyncedAt: new Date().toISOString(),
  };
  return cameraStore.updateCamera(camera.id, patch) || { ...camera, ...patch };
}

function unwrapCameraPayload(payload) {
  if (!payload || typeof payload !== 'object') return {};
  if (payload.camera && typeof payload.camera === 'object') return payload.camera;
  if (payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)) {
    return payload.data;
  }
  return payload;
}

/** Activate the MediaMTX path behind a registered backend camera. */
async function restartBoardCameraStream(camera, options = {}) {
  const backendId = String(camera?.backendId || '').trim();
  if (!camera?.id || !backendId) {
    return { ok: false, camera, error: 'Camera has no backend ID' };
  }

  const lastStarted = streamStartedAt.get(backendId) || 0;
  if (!options.force && Date.now() - lastStarted < STREAM_RESTART_TTL_MS) {
    return { ok: true, camera, backendId, alreadyStarted: true };
  }
  if (streamRestartPromises.has(backendId)) return streamRestartPromises.get(backendId);

  const pending = (async () => {
    try {
      const restarted = await visionClient.apiJson(
        `/api/cameras/${encodeURIComponent(backendId)}/restart`,
        { method: 'POST' },
      );

      // Some backend builds return playback URLs only from camera detail.
      let detail = {};
      try {
        detail = unwrapCameraPayload(await visionClient.apiJson(
          `/api/cameras/${encodeURIComponent(backendId)}`,
        ));
      } catch {
        /* restart response + generated MediaMTX URLs remain usable */
      }

      const source = {
        ...camera,
        ...detail,
        ...unwrapCameraPayload(restarted),
      };
      const patch = {
        ...mediaFields(backendId, source),
        backendStreamStartedAt: new Date().toISOString(),
        backendStreamError: null,
      };
      const updated = cameraStore.updateCamera(camera.id, patch) || { ...camera, ...patch };
      streamStartedAt.set(backendId, Date.now());
      return {
        ok: true,
        camera: updated,
        backendId,
        restarted: true,
        response: restarted,
      };
    } catch (err) {
      // A few builds report conflict when the stream is already active.
      if (err.status === 409) {
        streamStartedAt.set(backendId, Date.now());
        return { ok: true, camera, backendId, alreadyStarted: true };
      }
      const patch = {
        backendStreamError: err.message,
        backendStreamStartedAt: null,
        // Do not keep advertising synthetic MediaMTX URLs when activation
        // failed; camera-analytics can then choose the local MJPEG bridge.
        whepUrl: null,
        hlsUrl: null,
      };
      const updated = cameraStore.updateCamera(camera.id, patch) || { ...camera, ...patch };
      console.warn('[board-camera-sync] stream restart failed:', backendId, err.message);
      return { ok: false, camera: updated, backendId, error: err.message };
    }
  })();

  streamRestartPromises.set(backendId, pending);
  try {
    return await pending;
  } finally {
    if (streamRestartPromises.get(backendId) === pending) {
      streamRestartPromises.delete(backendId);
    }
  }
}

async function ensureBoardCamera(camera, options = {}) {
  if (!camera?.id) return camera || null;
  const streamUrl = streamUrlOf(camera);
  if (!streamUrl) return camera;

  // A stored mapping still needs its MediaMTX path activated after each Node
  // or vision-backend restart.
  if (camera.backendId && !options.force) {
    const mapped = camera.whepUrl && camera.hlsUrl
      ? camera
      : saveBoardMapping(camera, { id: camera.backendId });
    let result = mapped;
    if (options.startStream !== false) {
      const started = await restartBoardCameraStream(mapped, {
        force: options.forceStreamRestart === true,
      });
      result = started.camera || mapped;
    }
    if (options.localPlayback === false) return result;
    return attachLocalPlayback(result, {
      force: options.forceLocalPlayback === true,
    });
  }

  if (syncPromises.has(camera.id)) return syncPromises.get(camera.id);
  const pending = (async () => {
    try {
      let backendCamera = null;
      try {
        const listed = await visionClient.apiJson('/api/cameras');
        backendCamera = findExistingCamera(listFromResponse(listed), camera);
      } catch (listErr) {
        if (listErr.status === 401 || listErr.status === 403) throw listErr;
        console.warn('[board-camera-sync] camera list:', listErr.message);
      }

      if (!backendCamera) {
        backendCamera = await visionClient.apiJson('/api/cameras', {
          method: 'POST',
          body: {
            name: camera.name || `Camera ${camera.id}`,
            type: camera.type || 'rtsp',
            url: streamUrl,
            username: camera.username || undefined,
            password: camera.password || undefined,
            location: camera.location || undefined,
            zone: camera.zone || camera.group || undefined,
            floor: camera.floor || camera.zoneFloor || undefined,
            department: camera.department || undefined,
          },
        });
      }

      const synced = saveBoardMapping(camera, backendCamera);
      if (!synced?.backendId) {
        console.warn('[board-camera-sync] board returned no camera id for', camera.name || camera.id);
        return camera;
      }
      let result = synced;
      if (options.startStream !== false) {
        const started = await restartBoardCameraStream(synced, {
          force: options.forceStreamRestart === true,
        });
        result = started.camera || synced;
      }
      if (options.localPlayback === false) return result;
      return attachLocalPlayback(result, {
        force: options.forceLocalPlayback === true,
      });
    } catch (err) {
      console.warn('[board-camera-sync] sync failed:', err.message);
      // Camera viewing is independent from inference.  Preserve the original
      // frontend behaviour even while the remote vision API is unavailable.
      if (options.localPlayback === false) return camera;
      return attachLocalPlayback(camera, {
        force: options.forceLocalPlayback === true,
      });
    }
  })();

  syncPromises.set(camera.id, pending);
  try {
    return await pending;
  } finally {
    if (syncPromises.get(camera.id) === pending) syncPromises.delete(camera.id);
  }
}

async function resyncBoardCamera(cameraId) {
  const camera = cameraStore.getCamera(cameraId);
  if (!camera) return { ok: false, error: 'Camera not found' };
  const synced = await ensureBoardCamera(camera, {
    force: true,
    startStream: true,
    forceStreamRestart: true,
    forceLocalPlayback: true,
  });
  return {
    ok: Boolean(synced?.backendId),
    camera: synced,
    backendId: synced?.backendId || null,
    error: synced?.backendId ? null : 'Camera could not be registered on vision backend',
  };
}

/**
 * Startup compatibility used by server.js. Synchronize every configured
 * camera without allowing one bad/offline camera to abort the remaining set.
 */
async function syncAllCamerasToBoard(options = {}) {
  const cameras = cameraStore.listCameras();
  const results = [];

  // Keep registration sequential. It avoids duplicate list/create races on
  // boards that serialize camera-store writes, while already-mapped cameras
  // still complete immediately.
  for (const camera of cameras) {
    if (!streamUrlOf(camera)) {
      results.push({
        cameraId: camera.id,
        name: camera.name || null,
        ok: false,
        skipped: true,
        error: 'No stream URL configured',
      });
      continue;
    }

    try {
      const synced = await ensureBoardCamera(camera, {
        force: options.force === true,
        startStream: true,
        // Server startup must recreate MediaMTX paths even when mappings were
        // persisted from the previous run.
        forceStreamRestart: options.forceStreamRestart !== false,
        forceLocalPlayback: options.forceLocalPlayback !== false,
      });
      // Detection APIs and browser playback have independent health.  Keep
      // both in the result so startup logs expose the exact failing side.
      const backendOk = Boolean(synced?.backendId) && !synced?.backendStreamError;
      const playbackOk = synced?.localMediaReady !== false;
      const ok = backendOk && playbackOk;
      results.push({
        cameraId: camera.id,
        name: camera.name || null,
        backendId: synced?.backendId || null,
        ok,
        skipped: false,
        error: ok
          ? null
          : (synced?.localMediaError
            || synced?.backendStreamError
            || 'Vision backend did not return a camera ID'),
      });
    } catch (err) {
      results.push({
        cameraId: camera.id,
        name: camera.name || null,
        ok: false,
        skipped: false,
        error: err.message,
      });
    }
  }

  const synced = results.filter((result) => result.ok).length;
  const skipped = results.filter((result) => result.skipped).length;
  const failed = results.length - synced - skipped;
  return {
    ok: failed === 0,
    total: results.length,
    synced,
    skipped,
    failed,
    results,
  };
}

module.exports = {
  ensureBoardCamera,
  attachLocalPlayback,
  restartBoardCameraStream,
  syncCameraToBoard: ensureBoardCamera,
  syncAllCamerasToBoard,
  resyncBoardCamera,
  streamUrlOf,
  unregisterLocalCameraPath,
  getLocalMediaStatus,
};
