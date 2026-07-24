/**
 * Person tab — fetch-only bridge to vision board /api/detect/* APIs.
 */

const cameraStore = require('./camera-store');
const detectionStore = require('./detection-store');
const { getLiveViewPayload } = require('./camera-analytics');
const { createVisionClient } = require('./vision-api');
const { broadcastPersonUpdate } = require('./event-broadcast');
const { ensureBoardCamera } = require('./board-camera-sync');

const PERSON_SLUG = 'person';
const PERSON_MODEL = 'mdl_person';
const personClient = createVisionClient(
  process.env.VISION_API_URL || process.env.BACKEND_API_URL,
  { label: 'person' },
);

const streamClients = new Map();
const streamLoops = new Map();
const frameCounters = new Map();
const startPromises = new Map();
const PERSON_MIN_POLL_MS = Math.max(80, Number(process.env.PERSON_POLL_MS) || 120);

function isPersonCameraRunning(cameraId) {
  return detectionStore.isCameraRunning(PERSON_SLUG, cameraId);
}

function personPollMs(state) {
  const fps = Math.max(1, Math.min(15, Number(state?.fpsRate) || 10));
  return Math.max(PERSON_MIN_POLL_MS, Math.round(1000 / fps));
}

function scopeTrackIds(cameraId, detections) {
  return (Array.isArray(detections) ? detections : []).map((detection) => {
    const sourceId = detection?.track_id ?? detection?.trackId;
    if (sourceId == null || sourceId === '') return { ...detection };
    return {
      ...detection,
      source_track_id: detection?.source_track_id ?? sourceId,
      track_id: `${cameraId}:${String(sourceId)}`,
    };
  });
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

function stopPersonStreamLoop(cameraId) {
  streamLoops.get(cameraId)?.stop();
  streamLoops.delete(cameraId);
  frameCounters.delete(cameraId);
}

function startPersonStreamLoop(cameraId, backendId) {
  stopPersonStreamLoop(cameraId);
  const loop = { stopped: false, lastEventAt: 0, lastGoodJpeg: null, failStreak: 0 };
  frameCounters.set(cameraId, 0);
  async function tick() {
    if (loop.stopped) return;
    const state = detectionStore.getModelState(PERSON_SLUG);
    if (!isPersonCameraRunning(cameraId)) { loop.stopped = true; return; }
    let delayMs = personPollMs(state);
    try {
      const result = await personClient.apiJson(`/api/detect/result/${encodeURIComponent(backendId)}/${PERSON_MODEL}`);
      const detections = filterDetections(result?.detections || [], state);
      const frameId = (frameCounters.get(cameraId) || 0) + 1;
      frameCounters.set(cameraId, frameId);
      broadcastFrame(cameraId, {
        frame_id: frameId,
        detections,
        fps: result?.fps ?? result?.inference_fps ?? null,
        inference_ms: result?.inference_ms ?? null,
        capture_ts: Date.now(),
        server_ts: Date.now(),
      });
      loop.failStreak = 0;

      const freshJpeg = result?.snapshot_jpeg || result?.jpeg || null;
      if (freshJpeg && typeof freshJpeg === 'string' && freshJpeg.length >= 64) {
        loop.lastGoodJpeg = freshJpeg;
      }
      const snapshotJpeg = freshJpeg || loop.lastGoodJpeg || null;

      // Same path as live bboxes, throttled just enough to avoid store thrash.
      const now = Date.now();
      if (now - loop.lastEventAt >= 200) {
        loop.lastEventAt = now;
        const camera = cameraStore.getCamera(cameraId);
        if (camera) {
          // Do NOT pass stale full state — recordPersonDetection reads fresh tracks itself.
          const { newEvents } = await detectionStore.recordPersonDetection(
            camera,
            scopeTrackIds(cameraId, detections),
            {},
            snapshotJpeg,
          );
          if (newEvents.length) {
            broadcastPersonUpdate(detectionStore.getPayload(PERSON_SLUG), newEvents);
          }
        }
      }
    } catch (err) {
      loop.failStreak += 1;
      delayMs = Math.min(3000, Math.max(delayMs, loop.failStreak * 250));
      if (err.status !== 404) console.warn('[person-live] stream loop:', err.message);
    }
    if (!loop.stopped) setTimeout(tick, delayMs);
  }
  loop.stop = () => { loop.stopped = true; };
  streamLoops.set(cameraId, loop);
  tick();
}

function sanitizeCam(camera) {
  const { password, ...safe } = camera;
  return safe;
}

function backendCameraId(camera, state, cameraId = camera?.id) {
  return camera?.backendId
    || state?.backendCameraIds?.[cameraId]
    || (state?.activeCameraId === cameraId ? state?.backendCameraId : null)
    || null;
}

function filterDetections(detections, state) {
  let dets = Array.isArray(detections) ? [...detections] : [];
  const conf = state.confidence ?? 0.32;
  dets = dets.filter((d) => (d.score ?? 0) >= conf);

  if (state.features?.filterSmallObjects) {
    const minPx = state.minObjectSizePx ?? 48;
    const minNorm = minPx / 640;
    dets = dets.filter((d) => {
      const box = d.box || [];
      if (box.length < 4) return true;
      const w = Math.abs(box[2] - box[0]);
      const h = Math.abs(box[3] - box[1]);
      return w >= minNorm && h >= minNorm;
    });
  }

  return dets;
}

function getActiveZonePolygon(state, cameraId) {
  const zones = Array.isArray(state?.zones) ? state.zones : [];
  const match = zones.find(
    (z) =>
      z.enabled !== false
      && Array.isArray(z.points)
      && z.points.length >= 3
      && (!z.cameraId || z.cameraId === cameraId),
  );
  return match?.points || null;
}

async function pushZoneToBoard(backendId, cameraId, state) {
  if (!backendId || !(await personClient.isReachable())) return;
  const zone = getActiveZonePolygon(state, cameraId);
  if (!zone) return;
  try {
    await personClient.apiJson('/api/detect/zone', {
      method: 'POST',
      body: {
        camera_id: backendId,
        model_id: PERSON_MODEL,
        zone,
      },
    });
  } catch (err) {
    console.warn('[person-live] zone:', err.message);
  }
}

function buildMetrics(detections, state, workerMeta = {}, cameraId = null) {
  const count = detections.length;
  const running = cameraId ? isPersonCameraRunning(cameraId) : Boolean(state.inferenceRunning);
  const peak = Math.max(count, state._peakToday || 0);
  return {
    current: count,
    peakToday: peak,
    presenceActive: Boolean(running && state.features?.personPresence && count > 0),
    fps: workerMeta.fps ?? null,
    inferenceMs: workerMeta.inference_ms ?? workerMeta.inferenceMs ?? null,
  };
}

async function selectCamera(cameraId) {
  let camera = cameraStore.getCamera(cameraId);
  if (!camera) return { ok: false, error: 'Camera not found' };

  const state = detectionStore.getModelState(PERSON_SLUG);
  const keepRunning = isPersonCameraRunning(cameraId);

  camera = await ensureBoardCamera(camera) || camera;
  const backendId = backendCameraId(camera, state, cameraId);
  const reachable = await personClient.isReachable();
  const live = getLiveViewPayload(camera);

  const backendCameraIds = { ...(state.backendCameraIds || {}) };
  const streamModes = { ...(state.streamModes || {}) };
  if (backendId) backendCameraIds[cameraId] = backendId;
  streamModes[cameraId] = backendId && reachable ? 'backend' : 'preview';
  detectionStore.saveModelState(PERSON_SLUG, {
    activeCameraId: cameraId,
    runningCameraIds: state.runningCameraIds,
    inferenceRunning: state.runningCameraIds.length > 0,
    streamMode: backendId && reachable ? 'backend' : 'preview',
    backendCameraId: backendId,
    backendCameraIds,
    streamModes,
  });

  if (keepRunning && backendId) {
    const loop = streamLoops.get(cameraId);
    if (!loop || loop.stopped) {
      startPersonStreamLoop(cameraId, backendId);
    }
  }

  return {
    ok: true,
    camera: sanitizeCam(camera),
    preview: live.preview,
    backendReachable: reachable,
    hasStreamUrl: Boolean(live.preview?.whepUrl || live.preview?.hlsUrl || camera.rtspUrl),
    backendCameraId: backendId,
    inferenceRunning: keepRunning,
    hlsUrl: camera.hlsUrl || live.preview?.hlsUrl || null,
    whepUrl: camera.whepUrl || live.preview?.whepUrl || null,
    mjpegUrl: live.preview?.mjpegUrl || null,
    payload: detectionStore.getPayload(PERSON_SLUG),
  };
}

async function resyncStream(cameraId) {
  return { ok: false, error: 'Re-sync cameras on the vision board directly' };
}

async function prewarmWorker(cameraId) {
  const camera = cameraStore.getCamera(cameraId);
  if (!camera) return { ok: false, error: 'Camera not found' };
  const backendId = backendCameraId(camera, detectionStore.getModelState(PERSON_SLUG), cameraId);
  if (!backendId) return { ok: false, error: 'No board camera ID' };
  return { ok: true, prewarmed: false, backendId };
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

  if (!(await personClient.isReachable())) {
    return {
      ok: false,
      error: 'Vision board offline — start backend on the board',
      backendError: 'Vision board offline',
      backendConnected: false,
      payload: detectionStore.getPayload(PERSON_SLUG),
    };
  }

  camera = await ensureBoardCamera(camera) || camera;
  const backendId = backendCameraId(camera, detectionStore.getModelState(PERSON_SLUG), cameraId);
  if (!backendId) {
    return {
      ok: false,
      error: 'Camera has no board ID (backendId)',
      backendError: 'Missing backend camera ID',
      backendConnected: false,
      payload: detectionStore.getPayload(PERSON_SLUG),
    };
  }

  const existingLoop = streamLoops.get(cameraId);
  if (isPersonCameraRunning(cameraId) && existingLoop && !existingLoop.stopped) {
    const live = getLiveViewPayload(camera);
    return {
      ok: true,
      alreadyRunning: true,
      backendConnected: true,
      streamMode: 'backend',
      workerSource: 'backend',
      backendCameraId: backendId,
      preview: live.preview,
      hlsUrl: camera.hlsUrl || live.preview?.hlsUrl || null,
      whepUrl: camera.whepUrl || live.preview?.whepUrl || null,
      mjpegUrl: live.preview?.mjpegUrl || null,
      wsUrl: `/ws/person-live?cameraId=${encodeURIComponent(cameraId)}`,
      payload: detectionStore.getPayload(PERSON_SLUG),
    };
  }

  const state = detectionStore.getModelState(PERSON_SLUG);
  const conf = state.confidence ?? 0.32;
  const fps = Math.min(state.fpsRate || 15, 15);
  const zone = getActiveZonePolygon(state, cameraId);

  try {
    await personClient.apiJson('/api/detect/start', {
      method: 'POST',
      body: {
        camera_id: backendId,
        model_id: PERSON_MODEL,
        confidence: conf,
        fps,
        capabilities: ['person_detection'],
        ...(zone ? { zone } : {}),
      },
    });
  } catch (err) {
    return {
      ok: false,
      error: err.message || 'Could not start person worker',
      backendError: err.message,
      backendConnected: false,
      payload: detectionStore.getPayload(PERSON_SLUG),
    };
  }

  if (zone) {
    pushZoneToBoard(backendId, cameraId, state).catch((err) => {
      console.warn('[person-live] background zone sync:', err.message);
    });
  }

  detectionStore.setCameraRuntime(PERSON_SLUG, cameraId, {
    running: true,
    backendCameraId: backendId,
    streamMode: 'backend',
  });
  detectionStore.saveModelState(PERSON_SLUG, {
    workerSource: 'backend',
    _peakToday: state._peakToday || 0,
  });

  startPersonStreamLoop(cameraId, backendId);
  const live = getLiveViewPayload(camera);

  return {
    ok: true,
    backendConnected: true,
    streamMode: 'backend',
    workerSource: 'backend',
    backendError: null,
    backendCameraId: backendId,
    preview: live.preview,
    hlsUrl: camera.hlsUrl || live.preview?.hlsUrl || null,
    whepUrl: camera.whepUrl || live.preview?.whepUrl || null,
    mjpegUrl: live.preview?.mjpegUrl || null,
    wsUrl: `/ws/person-live?cameraId=${encodeURIComponent(cameraId)}`,
    payload: detectionStore.getPayload(PERSON_SLUG),
  };
}

async function stopLive(cameraId) {
  const camera = cameraStore.getCamera(cameraId);
  const state = detectionStore.getModelState(PERSON_SLUG);
  const backendId = backendCameraId(camera, state, cameraId);

  if (backendId && (await personClient.isReachable())) {
    try {
      await personClient.apiJson('/api/detect/stop', {
        method: 'POST',
        body: { camera_id: backendId, model_id: PERSON_MODEL },
      });
    } catch (err) {
      console.warn('[person-live] stop:', err.message);
    }
  }

  stopPersonStreamLoop(cameraId);
  const next = detectionStore.setCameraRuntime(PERSON_SLUG, cameraId, { running: false });
  if (!next.inferenceRunning) {
    detectionStore.saveModelState(PERSON_SLUG, { workerSource: null });
  }

  return { ok: true, payload: detectionStore.getPayload(PERSON_SLUG) };
}

async function getLiveFrame(cameraId) {
  const camera = cameraStore.getCamera(cameraId);
  if (!camera) {
    return {
      ok: true,
      error: 'Camera not found',
      inferenceRunning: false,
      backendConnected: false,
      metrics: { current: 0, peakToday: 0, fps: null, inferenceMs: null, presenceActive: false },
      detections: [],
      payload: detectionStore.getPayload(PERSON_SLUG),
    };
  }

  const state = detectionStore.getModelState(PERSON_SLUG);
  const live = getLiveViewPayload(camera);
  const backendId = backendCameraId(camera, state, cameraId);
  const cameraRunning = isPersonCameraRunning(cameraId);

  let detections = [];
  let backendConnected = false;
  let result = null;

  if (backendId && cameraRunning && (await personClient.isReachable())) {
    try {
      result = await personClient.apiJson(
        `/api/detect/result/${encodeURIComponent(backendId)}/${PERSON_MODEL}`,
      );
      backendConnected = true;
      detections = filterDetections(result?.detections || [], state);
    } catch (err) {
      if (err.status !== 404) console.warn('[person-live] poll:', err.message);
    }
  }

  const fps = result?.fps ?? result?.inference_fps ?? null;
  const inferenceMs = result?.inference_ms ?? null;
  const metrics = buildMetrics(detections, state, { fps, inference_ms: inferenceMs }, cameraId);

  const liveMetric = { current: metrics.current, fps: metrics.fps, inferenceMs: metrics.inferenceMs };
  const peakToday = Math.max(state._peakToday || 0, metrics.current);
  metrics.peakToday = peakToday;
  detectionStore.saveModelState(PERSON_SLUG, {
    _peakToday: peakToday,
    _liveMetricsByCamera: {
      ...(state._liveMetricsByCamera || {}),
      [cameraId]: liveMetric,
    },
    _liveMetrics: state.activeCameraId === cameraId ? liveMetric : state._liveMetrics,
  });

  if (cameraRunning && camera) {
    const snapshotJpeg = result?.snapshot_jpeg || result?.jpeg || null;
    const { newEvents } = await detectionStore.recordPersonDetection(
      camera,
      scopeTrackIds(cameraId, detections),
      {},
      snapshotJpeg,
    );
    const fullPayload = detectionStore.getPayload(PERSON_SLUG);
    if (newEvents.length) broadcastPersonUpdate(fullPayload, newEvents);
  }

  return {
    ok: true,
    camera: sanitizeCam(camera),
    preview: live.preview,
    streamMode: state.streamModes?.[cameraId] || (cameraRunning ? 'backend' : 'preview'),
    workerSource: cameraRunning ? 'backend' : null,
    backendConnected,
    inferenceRunning: cameraRunning,
    backendCameraId: backendId,
    hlsUrl: camera.hlsUrl || live.preview?.hlsUrl || null,
    whepUrl: camera.whepUrl || live.preview?.whepUrl || null,
    mjpegUrl: live.preview?.mjpegUrl || null,
    detections,
    peopleCount: state.features?.countPeople !== false ? detections.length : null,
    metrics: {
      ...metrics,
      skippedFrames: result?.skipped_frames ?? null,
      inferenceFps: result?.inference_fps ?? fps,
    },
    features: state.features,
    alerts: state.alerts,
    confidence: state.confidence,
    minObjectSizePx: state.minObjectSizePx,
    updatedAt: new Date().toISOString(),
    payload: detectionStore.getPayload(PERSON_SLUG),
  };
}

async function updateLiveConfig(cameraId, patch) {
  detectionStore.updateSettings(PERSON_SLUG, patch);
  const camera = cameraStore.getCamera(cameraId);
  const state = detectionStore.getModelState(PERSON_SLUG);
  const backendId = backendCameraId(camera, state, cameraId);

  if (backendId && isPersonCameraRunning(cameraId) && (await personClient.isReachable())) {
    try {
      await personClient.apiJson('/api/detect/config', {
        method: 'PUT',
        body: {
          camera_id: backendId,
          model_id: PERSON_MODEL,
          confidence: state.confidence,
          fps: Math.min(state.fpsRate || 15, 15),
        },
      });
    } catch (err) {
      console.warn('[person-live] config:', err.message);
    }
    if (patch.zones !== undefined) {
      await pushZoneToBoard(backendId, cameraId, state);
    }
  }

  return { ok: true, payload: detectionStore.getPayload(PERSON_SLUG) };
}

function getActiveCameraId() {
  return detectionStore.getModelState(PERSON_SLUG).activeCameraId || null;
}

async function startAllLive() {
  const state = detectionStore.getModelState(PERSON_SLUG);
  const assignedIds = state.assignedCameraIds || [];
  if (!assignedIds.length) {
    return { ok: false, error: 'No cameras assigned to person detection' };
  }
  if (!(await personClient.isReachable())) {
    return { ok: false, error: 'Vision board offline' };
  }

  const progress = await Promise.all(assignedIds.map(async (cameraId) => {
    try {
      const r = await startLive(cameraId);
      return { cameraId, ok: r.ok, error: r.error || null };
    } catch (err) {
      return { cameraId, ok: false, error: err.message };
    }
  }));

  return {
    ok: true,
    progress,
    payload: detectionStore.getPayload(PERSON_SLUG),
  };
}

module.exports = {
  selectCamera,
  startLive,
  stopLive,
  startAllLive,
  getLiveFrame,
  updateLiveConfig,
  resyncStream,
  prewarmWorker,
  getActiveCameraId,
  addStreamClient,
};
