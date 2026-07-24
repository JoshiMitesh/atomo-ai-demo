/**
 * Face tab — live stream + face recognition (aligned with person-live UX).
 */
(function () {
  const slug = document.body.dataset.detectionSlug;
  if (slug !== 'face') return;

  let selectedCameraId = null;
  let payload = null;
  let frameData = null;
  let pollTimer = null;
  let inferenceRunning = false;
  let inferenceStarting = false;
  let streamLocked = false;
  let hlsPlayer = null;
  let whepPlayer = null;
  let detWs = null;
  let currentMatchThreshold = 0.48;
  let streamInitialized = false;
  let usingWhepStream = false;
  let usingHlsStream = false;
  let hlsStreamFailed = false;
  let streamFirstFrameReceived = false;
  let pendingWsUrl = null;
  let overlayAnimTimer = null;
  let vfcActive = false;
  let displayFaces = [];
  // Track-id based smoothing state to eliminate order-jitter.
  const trackBoxEma = new Map(); // trackId -> { box:[x1,y1,x2,y2], seenAt:number }
  const TRACK_BOX_TTL_MS = 1500;

  const FACE_HOLD_MS = 350;
  // Reduce trailing: WHEP is low latency, so keep bias small.
  let WHEP_FACE_DELAY_MS = 500;
  const HLS_FACE_DELAY_MS = 0;
  const SYNC_MAX_AGE_MS = 450;
  const SYNC_BUFFER_MAX = 16;
  let lastNonEmptyFaces = [];
  let lastNonEmptyFacesAt = 0;
  let faceApplyTimer = null;
  let pendingFacePacket = null;
  let lastFaceFrameTs = 0;
  let syncPacketBuffer = [];
  let syncDisplayFaces = [];
  let inferenceFrameW = 1920;
  let inferenceFrameH = 1080;
  let streamStartedAt = 0;
  let streamDelayMs = 0;
  let overlayCacheW = 0;
  let overlayCacheH = 0;
  let streamActive = false;
  let savedHlsPlayer = null;
  let usingSyncedInferenceStream = false;
  let lastDisplayedFrameId = null;
  let pendingJpeg = null;
  let jpegDrawScheduled = false;

  // Tripwire line (2 dots → one line). Events only fire when a face crosses it.
  // Saved ONLY when user clicks Save (PUT /api/face/stream/line-config/:cameraId → board).
  let lineConfig = null; // { line_x1, line_y1, line_x2, line_y2, enabled }
  let lineDrawMode = false;
  let draftLinePoints = []; // normalized 0–1 in cover-video space
  let lineSaveInFlight = false;

  function tripwireLog(...args) {
    console.log('[FaceTripwire]', ...args);
  }

  function tripwireWarn(...args) {
    console.warn('[FaceTripwire]', ...args);
  }

  /** Map normalized box coords onto video with object-fit: cover (matches .ov-plive-media). */
  function getCoverVideoRect(video, containerW, containerH) {
    const vw = video?.videoWidth || inferenceFrameW || 0;
    const vh = video?.videoHeight || inferenceFrameH || 0;
    if (!vw || !vh || !containerW || !containerH) {
      return { offsetX: 0, offsetY: 0, drawW: containerW, drawH: containerH };
    }
    const scale = Math.max(containerW / vw, containerH / vh);
    const drawW = vw * scale;
    const drawH = vh * scale;
    return {
      offsetX: (containerW - drawW) / 2,
      offsetY: (containerH - drawH) / 2,
      drawW,
      drawH,
      vw,
      vh,
    };
  }

  function mapBoxToOverlay(box, rect) {
    const [x1, y1, x2, y2] = box.map(Number);
    return {
      x: rect.offsetX + x1 * rect.drawW,
      y: rect.offsetY + y1 * rect.drawH,
      w: (x2 - x1) * rect.drawW,
      h: (y2 - y1) * rect.drawH,
    };
  }

  function enterSyncedInferenceMode() {
    if (usingSyncedInferenceStream) return;
    tripwireLog('enterSyncedInferenceMode — keep overlay visible so tripwire line stays drawn');
    usingSyncedInferenceStream = true;
    lastDisplayedFrameId = null;
    stopOverlayLoop();
    stopWhep();
    stopHls();
    usingWhepStream = false;
    usingHlsStream = false;
    resetSyncEngine();
    const host = document.getElementById('fliveStreamHost');
    host?.querySelectorAll('.ov-plive-media').forEach((el) => el.remove());
    const canvas = document.getElementById('fliveCanvas');
    const overlay = document.getElementById('fliveOverlay');
    if (canvas) canvas.style.display = 'block';
    // Keep overlay ON so tripwire line remains visible during recognition.
    if (overlay) {
      overlay.style.display = 'block';
      overlay.style.pointerEvents = lineDrawMode ? 'auto' : 'none';
    }
    streamFirstFrameReceived = true;
    hideStreamLoadingOverlay();
    drawFacesOverlay();
  }

  function exitSyncedInferenceMode() {
    if (!usingSyncedInferenceStream) return;
    usingSyncedInferenceStream = false;
    lastDisplayedFrameId = null;
    const overlay = document.getElementById('fliveOverlay');
    if (overlay) overlay.style.display = 'block';
    if (frameData?.preview && streamActive) {
      initStreamWithPreview({ preview: frameData.preview, camera: frameData.camera });
    }
  }

  function scheduleJpegDraw(jpeg) {
    pendingJpeg = jpeg;
    if (jpegDrawScheduled) return;
    jpegDrawScheduled = true;
    requestAnimationFrame(() => {
      jpegDrawScheduled = false;
      if (pendingJpeg) showJpegFrame(pendingJpeg);
      pendingJpeg = null;
    });
  }

  function showJpegFrame(jpeg) {
    const host = document.getElementById('fliveStreamHost');
    const canvas = document.getElementById('fliveCanvas');
    if (!canvas || !host || !jpeg) return;
    canvas.style.display = 'block';
    const img = new Image();
    img.onload = () => {
      const w = host.clientWidth || 960;
      const h = Math.round(w * 9 / 16);
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      // Re-paint tripwire on top of inference JPEG so line never "disappears".
      drawTripwireLine(ctx, { offsetX: 0, offsetY: 0, drawW: w, drawH: h });
      drawFacesOverlay();
    };
    img.src = `data:image/jpeg;base64,${jpeg}`;
  }

  function handleSyncedFacePacket(data) {
    const frameId = data.frame_id ?? data.frame ?? null;
    if (frameId != null && frameId === lastDisplayedFrameId) return;

    const faces = processRawFaces(data.faces || [], data.frame_w, data.frame_h);
    lastDisplayedFrameId = frameId;
    ingestFaceSyncPacket(data, faces);

    frameData = {
      ...(frameData || {}),
      faces,
      syncFrameId: frameId,
      frame_w: data.frame_w,
      frame_h: data.frame_h,
      captureTs: data.capture_ts,
      inferenceStartTs: data.inference_start_ts,
      inferenceFinishTs: data.inference_finish_ts,
      metrics: {
        ...(frameData?.metrics || {}),
        fps: data.fps ?? frameData?.metrics?.fps,
        facesNow: faces.length,
        // Recognition is a separate layer; live stream tracks only.
        knownNow: 0,
        unknownNow: 0,
      },
    };

    if (inferenceStarting) {
      setInferenceStarting(false);
      updateInferenceUi(frameData || {});
    }

    if ((usingWhepStream || usingHlsStream) && !overlayAnimTimer && !vfcActive) {
      startOverlayLoop();
    }
    updateStatsOnly();
  }

  function resetSyncEngine() {
    syncPacketBuffer = [];
    syncDisplayFaces = [];
    streamStartedAt = 0;
    streamDelayMs = 0;
  }

  function getStreamBiasMs() {
    if (usingHlsStream) return HLS_FACE_DELAY_MS;
    if (usingWhepStream) return WHEP_FACE_DELAY_MS;
    return 0;
  }

  function smoothFaceBoxesByTrackId(nextFaces, alpha = 1) {
    if (!nextFaces?.length) return nextFaces || [];
    const now = Date.now();
    // Purge stale track boxes.
    for (const [tid, st] of trackBoxEma.entries()) {
      if (!st?.seenAt || now - st.seenAt > TRACK_BOX_TTL_MS) {
        trackBoxEma.delete(tid);
      }
    }
    return nextFaces.map((face) => {
      const tid = face?.track_id ?? face?.trackId;
      const box = face?.box;
      if (!tid || !box || box.length < 4) return face;
      const prev = trackBoxEma.get(String(tid));
      const next = box.map(Number);
      if (!next.every((v) => Number.isFinite(v))) return face;
      let out = next;
      if (prev?.box?.length === 4) {
        out = next.map((n, i) => n * alpha + Number(prev.box[i]) * (1 - alpha));
      }
      trackBoxEma.set(String(tid), { box: out, seenAt: now });
      return { ...face, box: out };
    });
  }

  /**
   * Pick face detections aligned to the video frame currently on screen.
   *
   * IMPORTANT: alignment is done purely by BROWSER ARRIVAL TIME (`receivedAt`),
   * never by the board's `capture_ts`. The board is a separate machine whose
   * clock is usually not NTP-synced with the PC, so any comparison against its
   * timestamps injects the clock-skew as bbox delay/lead. Arrival-time is on the
   * same clock as `now`, so the boxes stay real-time regardless of clock skew.
   */
  function pickSyncFacesForNow() {
    if (!syncPacketBuffer.length) return;

    const now = Date.now();
    // How far behind "live" we intentionally draw, to line boxes up with the
    // (slightly delayed) video. WHEP is low-latency so this is small.
    const targetTs = now - getStreamBiasMs();

    syncPacketBuffer = syncPacketBuffer.filter((pkt) => now - pkt.receivedAt <= SYNC_MAX_AGE_MS);
    if (!syncPacketBuffer.length) return;

    // Newest packet that is still no newer than our target arrival time. This
    // keeps boxes as fresh as possible without ever jumping ahead of the video.
    let best = null;
    for (const pkt of syncPacketBuffer) {
      if (pkt.receivedAt <= targetTs) {
        if (!best || pkt.receivedAt > best.receivedAt) best = pkt;
      }
    }
    // If every packet is newer than target (very low latency), just use latest.
    if (!best) best = syncPacketBuffer[syncPacketBuffer.length - 1];
    if (!best) return;

    if (best.frameW) inferenceFrameW = best.frameW;
    if (best.frameH) inferenceFrameH = best.frameH;

    const smoothed = smoothFaceBoxesByTrackId(best.faces);
    // Always keep detections visible; line-cross only changes event routing / styling.
    syncDisplayFaces = smoothed;
    if (syncDisplayFaces.length > 0) {
      displayFaces = syncDisplayFaces;
      lastNonEmptyFaces = syncDisplayFaces;
      lastNonEmptyFacesAt = now;
    } else if (!detWs && now - lastNonEmptyFacesAt >= FACE_HOLD_MS) {
      displayFaces = [];
      syncDisplayFaces = [];
    }
  }

  function ingestFaceSyncPacket(data, faces) {
    const receivedAt = Date.now();
    const captureTs = Number(data.capture_ts || data.ts) || receivedAt;
    if (data.frame_w) inferenceFrameW = data.frame_w;
    if (data.frame_h) inferenceFrameH = data.frame_h;

    syncPacketBuffer.push({
      frameId: data.frame_id ?? data.frame ?? null,
      captureTs,
      faces,
      frameW: data.frame_w || inferenceFrameW,
      frameH: data.frame_h || inferenceFrameH,
      receivedAt,
    });
    if (syncPacketBuffer.length > SYNC_BUFFER_MAX) {
      syncPacketBuffer = syncPacketBuffer.slice(-SYNC_BUFFER_MAX);
    }
    pickSyncFacesForNow();
  }

  function normalizeBox(box, frameW = 1920, frameH = 1080) {
    if (!Array.isArray(box) || box.length < 4) return null;
    const nums = box.map(Number);
    if (!nums.every((v) => Number.isFinite(v))) return null;

    const fw = Math.max(1, Number(frameW) || 1920);
    const fh = Math.max(1, Number(frameH) || 1080);

    if (nums.every((v) => v >= 0 && v <= 1) && nums[2] > nums[0] && nums[3] > nums[1]) {
      return nums;
    }

    const [a, b, c, d] = nums;
    if (c > fw || d > fh) {
      return [a / fw, b / fh, c / fw, d / fh];
    }
    return [a / fw, b / fh, (a + c) / fw, (b + d) / fh];
  }

  function enrichFaceClient(face) {
    const detectionScore = Number(face.detection_score ?? face.detection_conf ?? 0);
    return {
      ...face,
      // Live layer: detection + tracking only (no recognition fields).
      is_known: false,
      match: null,
      match_score: null,
      detection_score: Number.isFinite(detectionScore) ? detectionScore : 0,
      display_confidence: null,
    };
  }

  function processRawFaces(rawFaces, frameW, frameH) {
    return (rawFaces || [])
      .map((f) => {
        const box = normalizeBox(f.box, f.frame_w || frameW, f.frame_h || frameH);
        if (!box) return null;
        return enrichFaceClient({
          ...f,
          box,
          crossed: f.crossed === true || f.line_crossed === true || f.justCrossed === true,
          detection_score: f.detection_score ?? f.detection_conf ?? 0.9,
          match_score: f.match_score ?? f.match?.score ?? null,
        });
      })
      .filter(Boolean);
  }

  function applyDisplayFaces(faces) {
    const now = Date.now();
    if (faces.length > 0) {
      lastNonEmptyFaces = faces;
      lastNonEmptyFacesAt = now;
      displayFaces = faces;
    } else if (
      now - lastNonEmptyFacesAt < FACE_HOLD_MS
      && lastNonEmptyFaces.length > 0
    ) {
      displayFaces = lastNonEmptyFaces;
    } else {
      displayFaces = [];
    }
  }

  function getFaceDelay() {
    if (usingWhepStream) return WHEP_FACE_DELAY_MS;
    if (usingHlsStream) return HLS_FACE_DELAY_MS;
    return 0;
  }

  let lastInferenceMs = 500;

  function commitFacePacket(faces, ts) {
    if (ts < lastFaceFrameTs) return;
    lastFaceFrameTs = ts;
    applyDisplayFaces(smoothFaceBoxesByTrackId(faces));
    drawFacesOverlay();
  }

  function enqueueFaceUpdate(rawFaces, frameW, frameH, ts) {
    const processed = processRawFaces(rawFaces, frameW, frameH);
    const delay = getFaceDelay();
    if (delay <= 0) {
      commitFacePacket(processed, ts);
      return;
    }
    pendingFacePacket = { faces: processed, ts, applyAt: Date.now() + delay };
    if (faceApplyTimer) return;
    const flush = () => {
      faceApplyTimer = null;
      const pkt = pendingFacePacket;
      if (!pkt) return;
      if (Date.now() < pkt.applyAt) {
        faceApplyTimer = setTimeout(flush, Math.max(20, pkt.applyAt - Date.now()));
        return;
      }
      pendingFacePacket = null;
      commitFacePacket(pkt.faces, pkt.ts);
    };
    faceApplyTimer = setTimeout(flush, delay);
  }

  function resetFaceDisplay() {
    lastNonEmptyFaces = [];
    lastNonEmptyFacesAt = 0;
    pendingFacePacket = null;
    lastFaceFrameTs = 0;
    resetSyncEngine();
    if (faceApplyTimer) {
      clearTimeout(faceApplyTimer);
      faceApplyTimer = null;
    }
    displayFaces = [];
  }

  const STREAM_TIMEOUT_MS = 12000;
  let streamConnectTimeout = null;
  let streamReconnectTimer = null;
  let streamInitInFlight = false;

  function sessionUrl(path) {
    const sid = sessionStorage.getItem('atomoSessionId');
    return sid ? `${path}?sessionId=${encodeURIComponent(sid)}` : path;
  }

  function esc(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function showToast(msg) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 2600);
  }

  function getRoot() {
    return document.getElementById('faceLiveRoot');
  }

  function confidenceHint(pct) {
    if (pct < 50) return 'Sensitive';
    if (pct < 75) return 'Balanced';
    return 'Strict';
  }

  function renderFeatureChips() {
    const options = payload?.tab?.featureOptions || [];
    const features = payload?.state?.features || {};
    return options
      .filter((o) => o.id !== 'faceDetection')
      .map(
        (opt) => `
        <label class="ov-plive-chip ${opt.locked ? 'is-locked' : ''}" title="${esc(opt.description)}">
          <input type="checkbox" data-feature-id="${opt.id}" ${features[opt.id] ? 'checked' : ''} ${opt.locked ? 'checked disabled' : ''}>
          <span>${esc(opt.label)}</span>
        </label>`
      )
      .join('');
  }

  function renderAlertChips() {
    const options = payload?.tab?.alertOptions || [];
    const alerts = payload?.state?.alerts || {};
    return options
      .map(
        (opt) => `
        <label class="ov-plive-alert-chip">
          <input type="checkbox" data-alert-id="${opt.id}" ${alerts[opt.id] ? 'checked' : ''}>
          <span>${esc(opt.label)}</span>
        </label>`
      )
      .join('');
  }

  function renderWorkbench() {
    if (!selectedCameraId || !payload) return renderEmpty();

    const cam = frameData?.camera || payload.assignedCameras?.find((c) => c.id === selectedCameraId)
      || { name: 'Camera', status: 'online' };
    const state = payload.state || {};
    const m = frameData?.metrics || payload.faceMetrics || {};
    const pct = Math.round((state.matchThreshold ?? currentMatchThreshold ?? 0.48) * 100);
    const running = inferenceRunning || state.inferenceRunning;
    const backendConnected = Boolean(frameData?.backendConnected);

    const modeLabel = running
      ? backendConnected ? 'Live AI' : 'Worker offline'
      : 'Preview';

    return `
      <article class="ov-card ov-plive-workbench" id="faceWorkbench">
        <div class="ov-plive-inner">
          <div class="ov-plive-head">
            <div>
              <div class="ov-stat-headline ov-plive-title">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>
                <span>${esc(cam.name)}</span>
              </div>
              <p class="ov-plive-sub">${esc(cam.location || 'No location')} · ${esc(cam.resolution || '—')}</p>
            </div>
            <div class="ov-plive-head-actions">
              <button type="button" class="ov-quick-btn" id="fliveEnrollBtn" title="Open enrollment">Enroll person</button>
              <span class="ov-badge ${cam.status === 'online' ? 'ov-badge-success' : 'ov-badge-error'}">${cam.status === 'online' ? 'Online' : 'Offline'}</span>
              <span class="ov-badge ov-badge-gold" id="fliveModeBadge">${modeLabel}</span>
              <button type="button" class="ov-quick-btn ${running ? 'ov-det-stop-btn' : ''}" id="fliveToggleBtn">
                ${running ? 'Stop recognition' : 'Start recognition'}
              </button>
            </div>
          </div>

          <div class="ov-plive-stats" id="fliveStats">
            <div class="ov-plive-stat"><span class="ov-plive-stat-val" data-m="faces">${m.facesNow ?? 0}</span><span class="ov-plive-stat-lbl">Faces</span></div>
            <div class="ov-plive-stat"><span class="ov-plive-stat-val" data-m="known">${m.knownNow ?? 0}</span><span class="ov-plive-stat-lbl">Known</span></div>
            <div class="ov-plive-stat"><span class="ov-plive-stat-val" data-m="unknown">${m.unknownNow ?? 0}</span><span class="ov-plive-stat-lbl">Unknown</span></div>
            <div class="ov-plive-stat"><span class="ov-plive-stat-val" data-m="today">${m.recognitionsToday ?? 0}</span><span class="ov-plive-stat-lbl">Today</span></div>
            <div class="ov-plive-stat"><span class="ov-plive-stat-val" data-m="fps">${m.fps != null ? Number(m.fps).toFixed(1) : '—'}</span><span class="ov-plive-stat-lbl">FPS</span></div>
          </div>

          <div class="ov-plive-toolbar">
            <div class="ov-plive-toolbar-row">
              <span class="ov-plive-toolbar-label">Features</span>
              <div class="ov-plive-chips">${renderFeatureChips()}</div>
            </div>
            <div class="ov-plive-toolbar-row ov-plive-conf-row">
              <span class="ov-plive-toolbar-label">Match threshold</span>
              <input type="range" class="ov-det-range ov-plive-conf-range" id="fliveConfidence" min="40" max="95" value="${pct}">
              <span class="ov-det-slider-val" id="fliveConfVal">${pct}%</span>
              <span class="ov-plive-conf-hint" id="fliveConfHint">${confidenceHint(pct)}</span>
            </div>
            <div class="ov-plive-toolbar-row">
              <span class="ov-plive-toolbar-label">Alerts</span>
              <div class="ov-plive-alert-chips">${renderAlertChips()}</div>
            </div>
            <div class="ov-plive-toolbar-row ov-plive-zone-row">
              <span class="ov-plive-toolbar-label">Tripwire</span>
              <div class="ov-plive-zone-panel">
                <div class="ov-plive-zone-actions">
                  <button type="button" class="ov-quick-btn ov-plive-zone-btn" id="fliveLineDrawBtn">${lineDrawMode ? 'Cancel' : 'Draw line'}</button>
                  <button type="button" class="ov-quick-btn ov-plive-zone-btn" id="fliveLineUndoBtn" ${draftLinePoints.length ? '' : 'disabled'}>Undo</button>
                  <button type="button" class="ov-quick-btn ov-plive-zone-btn ov-plive-zone-done" id="fliveLineDoneBtn" ${draftLinePoints.length >= 2 ? '' : 'disabled'}>Save</button>
                  <button type="button" class="ov-quick-btn ov-plive-zone-btn" id="fliveLineClearBtn" ${lineConfig?.enabled || draftLinePoints.length ? '' : 'disabled'}>Clear</button>
                </div>
                <p class="ov-plive-zone-hint" id="fliveLineHint">${
                  lineDrawMode
                    ? (draftLinePoints.length === 0
                      ? 'Click first endpoint on the video'
                      : draftLinePoints.length === 1
                        ? 'Click second endpoint to finish the line'
                        : 'Both points set — click Save to store on board')
                    : (lineConfig?.enabled
                      ? 'Line active — events only when a face crosses it'
                      : 'Draw 2 points, then click Save. Start recognition after save.')
                }</p>
              </div>
            </div>
          </div>

          <div class="ov-plive-stream-wrap">
            <div class="ov-plive-stream ${lineDrawMode ? 'is-zone-drawing' : ''}" id="fliveStreamHost">
              <canvas class="ov-plive-canvas" id="fliveCanvas" aria-label="Live camera stream"></canvas>
              <canvas class="ov-plive-overlay" id="fliveOverlay" aria-hidden="true"></canvas>
              <div class="ov-plive-zone-draw-banner" id="fliveLineBanner" ${lineDrawMode ? '' : 'hidden'}>Click 2 points to draw the tripwire</div>
              <div class="ov-plive-stream-badge" id="fliveStreamBadge">${running ? 'RECOGNIZING' : 'LIVE PREVIEW'}</div>
              <div class="ov-plive-stream-meta" id="fliveStreamMeta"></div>
            </div>
          </div>
          <p class="ov-plive-backend-note" id="fliveBackendNote"></p>
        </div>
        <div class="ov-merged-accent" aria-hidden="true"></div>
      </article>`;
  }

  function renderEmpty() {
    return `
      <article class="ov-card ov-plive-empty">
        <div class="ov-plive-empty-inner">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="10" r="4"/><path d="M6 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/></svg>
          <h2>Select a camera</h2>
          <p>Choose a camera above, then click <strong>Start stream</strong> on its card. Use <strong>Start recognition</strong> when ready.</p>
        </div>
      </article>`;
  }

  function showStreamIdleState() {
    const host = document.getElementById('fliveStreamHost');
    if (!host) return;
    host.querySelectorAll('.ov-plive-media').forEach((el) => el.remove());
    if (!document.getElementById('fliveStreamIdle')) {
      host.insertAdjacentHTML('beforeend', `
        <div class="ov-plive-stream-idle" id="fliveStreamIdle" role="status">
          <div class="ov-plive-stream-idle-icon" aria-hidden="true">
            <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="10" r="4"/><path d="M6 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/></svg>
          </div>
          <div class="ov-plive-stream-idle-title">Stream is off</div>
          <p class="ov-plive-stream-idle-sub">Click <strong>Start stream</strong> on the camera card to open live preview.</p>
        </div>`);
    }
    hideStreamLoadingOverlay();
  }

  function hideStreamIdleState() {
    document.getElementById('fliveStreamIdle')?.remove();
  }

  function stopStreamPlayback() {
    streamActive = false;
    streamFirstFrameReceived = false;
    streamInitialized = false;
    streamInitInFlight = false;
    stopHls();
    stopWhep();
    stopOverlayLoop();
    clearStreamLoading();
    showStreamIdleState();
    window.CameraManagement?.refreshStreamStates?.();
  }

  function isStreamActive(cameraId) {
    if (cameraId && cameraId !== selectedCameraId) return false;
    return Boolean(streamActive && (streamFirstFrameReceived || usingWhepStream || usingHlsStream || streamInitInFlight));
  }

  async function startStream(cameraId) {
    const id = cameraId || selectedCameraId;
    if (!id) {
      window.CameraStreamLog?.report({
        source: 'face-live',
        step: 'start-stream',
        level: 'error',
        message: 'startStream called but no camera id',
        why: 'Select a camera first',
      });
      return;
    }
    if (id !== selectedCameraId) await selectCamera(id);
    if (isStreamActive(id) && streamFirstFrameReceived) {
      window.CameraStreamLog?.report({
        source: 'face-live',
        step: 'start-stream',
        cameraId: id,
        message: 'Stream already playing — skip restart',
      });
      return;
    }
    streamActive = true;
    hideStreamIdleState();
    syncStreamLoadingUi('Starting stream…');
    window.CameraManagement?.refreshStreamStates?.();
    window.CameraStreamLog?.report({
      source: 'face-live',
      step: 'start-stream',
      cameraId: id,
      cameraName: frameData?.camera?.name,
      message: 'FaceLive.startStream',
      mode: frameData?.preview?.mode || null,
      url: frameData?.preview?.url || frameData?.preview?.whepUrl || frameData?.preview?.hlsUrl || null,
      detail: {
        simulated: Boolean(frameData?.preview?.simulated),
        hasPreview: Boolean(frameData?.preview),
      },
    });
    if (frameData?.preview) {
      initStreamWithPreview({ preview: frameData.preview, camera: frameData.camera });
    } else {
      window.CameraStreamLog?.report({
        source: 'face-live',
        step: 'start-stream',
        level: 'warn',
        cameraId: id,
        message: 'No preview in frameData yet — selectCamera /live fetch should fill it',
        why: 'Waiting for face live payload with WHEP/HLS URLs',
        hint: 'If stuck, check /api/cameras/:id/live?slug=face&sync=1 in terminal logs',
      });
    }
  }

  async function stopStream(cameraId) {
    if (cameraId && cameraId !== selectedCameraId) return;
    if (inferenceRunning) {
      try {
        await fetch(sessionUrl(`/api/detection/face/live/${encodeURIComponent(selectedCameraId)}/stop`), { method: 'POST' });
      } catch { /* ignore */ }
      inferenceRunning = false;
      disconnectWs();
    }
    stopStreamPlayback();
    updateInferenceUi(frameData || {});
  }

  function stopHls() {
    if (hlsPlayer) {
      hlsPlayer.destroy();
      hlsPlayer = null;
    }
    savedHlsPlayer = null;
    usingHlsStream = false;
  }

  function stopWhep() {
    if (whepPlayer?.close) whepPlayer.close();
    whepPlayer = null;
    usingWhepStream = false;
  }

  function disconnectWs() {
    if (detWs) {
      detWs.close();
      detWs = null;
    }
    resetFaceDisplay();
    exitSyncedInferenceMode();
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function stopOverlayLoop() {
    if (overlayAnimTimer) cancelAnimationFrame(overlayAnimTimer);
    overlayAnimTimer = null;
    vfcActive = false;
  }

  function clearStreamLoading() {
    const canvas = document.getElementById('fliveCanvas');
    if (canvas?._loadingTimer) {
      clearInterval(canvas._loadingTimer);
      canvas._loadingTimer = null;
    }
    if (streamConnectTimeout) {
      clearTimeout(streamConnectTimeout);
      streamConnectTimeout = null;
    }
  }

  function markStreamConnected() {
    clearStreamLoading();
    const meta = document.getElementById('fliveStreamMeta');
    if (meta && frameData?.preview?.label) meta.textContent = frameData.preview.label;
  }

  function showCameraLoadingScreen() {
    const host = document.getElementById('fliveStreamHost');
    const canvas = document.getElementById('fliveCanvas');
    const overlay = document.getElementById('fliveOverlay');
    if (!host) return;

    host.querySelectorAll('.ov-plive-media').forEach((el) => el.remove());
    if (canvas) canvas.style.display = 'none';
    if (overlay) overlay.style.display = 'block';
    const badge = document.getElementById('fliveStreamBadge');
    if (badge) badge.textContent = 'CONNECTING';

    let loading = document.getElementById('fliveStreamLoadingOverlay');
    if (!loading) {
      loading = document.createElement('div');
      loading.id = 'fliveStreamLoadingOverlay';
      loading.className = 'ov-stream-loading-overlay';
      loading.innerHTML = `
        <div class="ov-stream-loading-card ov-stream-loading-card--simple" role="status" aria-live="polite">
          <div class="ov-stream-loading-spinner" aria-hidden="true"></div>
          <div class="ov-stream-loading-title">Stream starting soon</div>
          <div class="ov-stream-loading-sub" id="fliveStreamLoadingSub" hidden></div>
        </div>`;
      host.appendChild(loading);
    }
    const sub = document.getElementById('fliveStreamLoadingSub');
    if (sub) {
      sub.textContent = '';
      sub.hidden = true;
    }
    loading.style.display = 'flex';

    const meta = document.getElementById('fliveStreamMeta');
    if (meta) meta.textContent = 'Negotiating live stream…';
  }

  function hideStreamLoadingOverlay() {
    const loading = document.getElementById('fliveStreamLoadingOverlay');
    if (loading) loading.style.display = 'none';
  }

  function isMediaActuallyReady() {
    const host = document.getElementById('fliveStreamHost');
    if (!host) return false;
    const video = host.querySelector('video.ov-plive-media');
    if (!video) return false;
    return Boolean(video.videoWidth && video.videoHeight && video.readyState >= 2);
  }

  function ensureStreamLoadingOverlay(msg) {
    const host = document.getElementById('fliveStreamHost');
    if (!host) return;
    let loading = document.getElementById('fliveStreamLoadingOverlay');
    if (!loading) return; // created in showCameraLoadingScreen()
    const sub = document.getElementById('fliveStreamLoadingSub');
    if (sub) sub.textContent = msg || 'Negotiating live stream…';
    loading.style.display = 'flex';
  }

  function syncStreamLoadingUi(msg) {
    if (!selectedCameraId) return;
    if (streamFirstFrameReceived || isMediaActuallyReady()) {
      hideStreamLoadingOverlay();
      return;
    }
    ensureStreamLoadingOverlay(msg || 'Waiting for first frame…');
  }

  function drawFacesOverlay() {
    const overlay = document.getElementById('fliveOverlay');
    const host = document.getElementById('fliveStreamHost');
    const canvas = document.getElementById('fliveCanvas');
    const video = host?.querySelector('video.ov-plive-media');
    if (!overlay || !host) return;

    let w;
    let h;
    if (video?.videoWidth) {
      w = host.clientWidth || video.clientWidth;
      h = host.clientHeight || video.clientHeight;
    } else if (canvas?.width) {
      w = canvas.width;
      h = canvas.height;
    } else {
      w = host.clientWidth || 960;
      h = Math.round(w * 9 / 16);
    }

    if (w !== overlayCacheW || h !== overlayCacheH) {
      overlay.width = w;
      overlay.height = h;
      overlayCacheW = w;
      overlayCacheH = h;
    }

    const ctx = overlay.getContext('2d');
    ctx.clearRect(0, 0, w, h);

    const coverRect = video?.videoWidth ? getCoverVideoRect(video, w, h) : {
      offsetX: 0,
      offsetY: 0,
      drawW: w,
      drawH: h,
    };

    // Always draw tripwire (even during recognition / synced JPEG mode).
    drawTripwireLine(ctx, coverRect);

    // In synced inference mode the JPEG already has boxes — only keep the line.
    if (usingSyncedInferenceStream) return;

    const showBoxes = payload?.state?.features?.boundingBoxes !== false;
    if (!showBoxes) return;

    let facesToDraw = (usingWhepStream || usingHlsStream)
      ? (syncDisplayFaces.length ? syncDisplayFaces : displayFaces)
      : displayFaces;

    if (!facesToDraw?.length) return;

    facesToDraw.forEach((face) => {
      const box = face.box;
      if (!box || box.length < 4) return;
      const mapped = mapBoxToOverlay(box, coverRect);
      const { x, y, w: bw, h: bh } = mapped;
      const crossed = face.crossed === true || face.line_crossed === true || face.justCrossed === true;
      ctx.strokeStyle = crossed ? '#f59e0b' : '#22c55e';
      ctx.lineWidth = crossed ? 3 : 2;
      ctx.strokeRect(x, y, bw, bh);
    });
  }

  function drawTripwireLine(ctx, coverRect) {
    const pts = draftLinePoints.length
      ? draftLinePoints
      : (lineConfig?.enabled
        ? [
          { x: lineConfig.line_x1, y: lineConfig.line_y1 },
          { x: lineConfig.line_x2, y: lineConfig.line_y2 },
        ]
        : []);
    if (!pts.length) return;

    const toPx = (p) => ({
      x: coverRect.offsetX + Number(p.x) * coverRect.drawW,
      y: coverRect.offsetY + Number(p.y) * coverRect.drawH,
    });

    const px = pts.map(toPx);
    if (px.length >= 2) {
      ctx.save();
      ctx.strokeStyle = '#f59e0b';
      ctx.lineWidth = 3;
      ctx.setLineDash([10, 6]);
      ctx.beginPath();
      ctx.moveTo(px[0].x, px[0].y);
      ctx.lineTo(px[1].x, px[1].y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }
    px.forEach((p, i) => {
      ctx.beginPath();
      ctx.fillStyle = i === 0 ? '#f59e0b' : '#ef4444';
      ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.stroke();
    });
  }

  function startOverlayLoop() {
    if (overlayAnimTimer || vfcActive) return;
    const host = document.getElementById('fliveStreamHost');
    const video = host?.querySelector('video.ov-plive-media');
    if (video && typeof video.requestVideoFrameCallback === 'function') {
      vfcActive = true;
      const tick = () => {
        if (!vfcActive) return;
        if (usingWhepStream || usingHlsStream) {
          pickSyncFacesForNow();
        }
        drawFacesOverlay();
        try {
          video.requestVideoFrameCallback(tick);
        } catch {
          vfcActive = false;
          startOverlayLoop();
        }
      };
      try {
        video.requestVideoFrameCallback(tick);
        return;
      } catch {
        vfcActive = false;
      }
    }
    const tick = () => {
      if (usingWhepStream || usingHlsStream) {
        pickSyncFacesForNow();
      }
      drawFacesOverlay();
      overlayAnimTimer = requestAnimationFrame(tick);
    };
    overlayAnimTimer = requestAnimationFrame(tick);
  }

  function onStreamReady() {
    if (streamFirstFrameReceived) return;
    streamFirstFrameReceived = true;
    streamDelayMs = streamStartedAt ? Date.now() - streamStartedAt : 0;
    resetSyncEngine();
    clearStreamLoading();
    const canvas = document.getElementById('fliveCanvas');
    if (canvas) canvas.style.display = 'none';
    hideStreamLoadingOverlay();
    const badge = document.getElementById('fliveStreamBadge');
    if (badge) badge.textContent = inferenceRunning ? 'RECOGNIZING' : 'LIVE PREVIEW';
    markStreamConnected();
    startOverlayLoop();
    drawFacesOverlay();
    if (pendingWsUrl) {
      connectDetectionWs(pendingWsUrl);
      pendingWsUrl = null;
    }
  }

  function initHlsStream(hlsUrl, host, canvas, overlay, fallback) {
    if (canvas) canvas.style.display = 'none';
    if (overlay) overlay.style.display = 'block';
    const video = document.createElement('video');
    video.className = 'ov-plive-media is-preparing';
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    host.insertBefore(video, host.firstChild);

    const meta = document.getElementById('fliveStreamMeta');
    if (meta) meta.textContent = 'Live HLS stream';

    const url = window.WhepPlayer?.resolveLocalUrl(hlsUrl) || hlsUrl;
    const targetDelaySec = Math.max(0.8, Math.min(2.5, lastInferenceMs / 1000 + 0.2));
    if (window.Hls?.isSupported()) {
      hlsPlayer = new window.Hls({
        enableWorker: true,
        lowLatencyMode: true,
        backBufferLength: 0,
        maxBufferLength: targetDelaySec,
        maxMaxBufferLength: targetDelaySec + 1,
        maxBufferHole: 0.5,
        liveSyncDuration: targetDelaySec,
        liveMaxLatencyDuration: targetDelaySec + 2,
        liveDurationInfinity: true,
        maxLiveSyncPlaybackRate: 1.0,
      });
      hlsPlayer.loadSource(url);
      hlsPlayer.attachMedia(video);
      hlsPlayer.on(window.Hls.Events.ERROR, () => fallback());
      usingHlsStream = true;
      streamInitialized = true;
      streamInitInFlight = false;
      streamStartedAt = Date.now();
      markStreamConnected();
      const onReady = () => {
        hideStreamLoadingOverlay();
        video.classList.remove('is-preparing');
        video.classList.add('is-ready');
        onStreamReady();
      };
      video.addEventListener('loadeddata', onReady, { once: true });
      video.addEventListener('playing', onReady, { once: true });
      syncStreamLoadingUi('Starting live HLS…');
      return;
    }
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = url;
      video.onerror = fallback;
      usingHlsStream = true;
      streamInitialized = true;
      streamInitInFlight = false;
      streamStartedAt = Date.now();
      markStreamConnected();
      const onReady = () => {
        hideStreamLoadingOverlay();
        video.classList.remove('is-preparing');
        video.classList.add('is-ready');
        onStreamReady();
      };
      video.addEventListener('loadeddata', onReady, { once: true });
      video.addEventListener('playing', onReady, { once: true });
      syncStreamLoadingUi('Starting live HLS…');
    }
  }

  function scheduleStreamConnectTimeout() {
    if (streamConnectTimeout) clearTimeout(streamConnectTimeout);
    streamConnectTimeout = setTimeout(() => {
      if (streamFirstFrameReceived || streamInitInFlight) return;
      const host = document.getElementById('fliveStreamHost');
      const video = host?.querySelector('video.ov-plive-media');
      if (video?.srcObject || video?.videoWidth) return;
      if (whepPlayer?.pc?.connectionState === 'connected') {
        streamFirstFrameReceived = true;
        onStreamReady();
        return;
      }
      const meta = document.getElementById('fliveStreamMeta');
      if (meta) meta.textContent = 'Taking longer than expected… retrying';
      // IMPORTANT: always re-fetch the live preview payload from the server so
      // we get the correct (same-origin) proxy URLs for local face backend.
      if (!selectedCameraId) return;
      fetch(sessionUrl(`/api/cameras/${encodeURIComponent(selectedCameraId)}/live?slug=face&sync=1`))
        .then((r) => (r.ok ? r.json() : null))
        .then((live) => {
          if (live?.preview) initStreamWithPreview({ preview: live.preview, camera: live.camera });
          else if (frameData?.preview) initStreamWithPreview({ preview: frameData.preview, camera: frameData.camera });
        })
        .catch(() => {
          if (frameData?.preview) initStreamWithPreview({ preview: frameData.preview, camera: frameData.camera });
        });
    }, STREAM_TIMEOUT_MS);
  }

  function watchWhepConnection(player, preview, host, canvas, overlay, fallback) {
    const pc = player?.pc;
    if (!pc) return;
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'connected' || pc.connectionState === 'connecting') return;
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        if (streamReconnectTimer) clearTimeout(streamReconnectTimer);
        streamReconnectTimer = setTimeout(() => {
          if (!selectedCameraId || streamInitInFlight || streamFirstFrameReceived) return;
          streamFirstFrameReceived = false;
          if (preview.hlsUrl && !hlsStreamFailed) {
            initHlsStream(preview.hlsUrl, host, canvas, overlay, fallback);
          } else if (preview.url) {
            initStreamWithPreview({ preview, camera: frameData?.camera });
          }
        }, 5000);
      }
    });
  }

  function initStreamWithPreview(livePayload) {
    const host = document.getElementById('fliveStreamHost');
    const preview = livePayload?.preview;
    if (!host || !preview) return;
    if (streamInitInFlight) return;
    streamInitInFlight = true;
    clearStreamLoading();
    scheduleStreamConnectTimeout();

    stopHls();
    stopWhep();
    usingHlsStream = false;
    usingWhepStream = false;
    hlsStreamFailed = false;
    streamFirstFrameReceived = false;
    host.querySelectorAll('.ov-plive-media').forEach((el) => el.remove());
    const canvas = document.getElementById('fliveCanvas');
    const overlay = document.getElementById('fliveOverlay');

    const fallback = () => {
      if (preview.hlsUrl && !hlsStreamFailed) {
        hlsStreamFailed = true;
        window.CameraStreamLog?.report({
          source: 'face-live',
          step: 'playback-hls',
          level: 'warn',
          cameraId: selectedCameraId,
          message: 'WHEP failed — falling back to HLS',
          url: preview.hlsUrl,
        });
        initHlsStream(preview.hlsUrl, host, canvas, overlay, () => {
          showToast('Stream unavailable — check board MediaMTX');
          window.CameraStreamLog?.report({
            source: 'face-live',
            step: 'playback',
            level: 'error',
            cameraId: selectedCameraId,
            message: 'HLS fallback also failed — stream did not start',
            why: 'Neither WHEP nor HLS could play',
            hint: 'Check board MediaMTX (8888/8889), BOARD_IP, and camera RTSP',
          });
        });
        return;
      }
      showToast('Could not connect to live stream');
      streamInitInFlight = false;
      window.CameraStreamLog?.report({
        source: 'face-live',
        step: 'playback',
        level: 'error',
        cameraId: selectedCameraId,
        message: 'Could not connect to live stream',
        why: 'No working WHEP/HLS path',
        mode: preview?.mode,
        url: preview?.url || preview?.hlsUrl,
        hint: 'Check BOARD SYNC logs and MediaMTX',
      });
    };

    if (preview.mode === 'whep' && preview.url && !preview.simulated && window.WhepPlayer && !(inferenceRunning && preview.hlsUrl)) {
      if (canvas) canvas.style.display = 'none';
      if (overlay) overlay.style.display = 'block';
      const video = document.createElement('video');
      video.className = 'ov-plive-media is-preparing';
      video.autoplay = true;
      video.muted = true;
      video.playsInline = true;
      host.insertBefore(video, host.firstChild);

      const meta = document.getElementById('fliveStreamMeta');
      if (meta) meta.textContent = preview.label || 'Live WebRTC stream';

      const whepUrl = window.WhepPlayer.resolveLocalUrl(preview.url);
      streamStartedAt = Date.now();
      window.CameraStreamLog?.report({
        source: 'face-live',
        step: 'playback-whep',
        cameraId: selectedCameraId,
        message: 'Trying WHEP (WebRTC) playback',
        url: whepUrl,
      });
      window.WhepPlayer.connectWhep(whepUrl, video)
        .then((player) => {
          whepPlayer = { ...player, video };
          usingWhepStream = true;
          streamInitialized = true;
          streamInitInFlight = false;
          markStreamConnected();
          watchWhepConnection(whepPlayer, preview, host, canvas, overlay, fallback);
          startOverlayLoop();
          const onReady = () => {
            hideStreamLoadingOverlay();
            video.classList.remove('is-preparing');
            video.classList.add('is-ready');
            onStreamReady();
            window.CameraStreamLog?.report({
              source: 'face-live',
              step: 'first-frame',
              cameraId: selectedCameraId,
              message: `First video frame ready (${video.videoWidth || '?'}x${video.videoHeight || '?'})`,
              mode: 'whep',
            });
          };
          video.addEventListener('wheptrack', onReady, { once: true });
          video.addEventListener('loadeddata', onReady, { once: true });
          video.addEventListener('playing', onReady, { once: true });
          if (player.pc?.connectionState === 'connected') {
            setTimeout(onReady, 150);
          }
          syncStreamLoadingUi('Negotiating WebRTC…');
        })
        .catch((err) => {
          streamInitInFlight = false;
          window.CameraStreamLog?.report({
            source: 'face-live',
            step: 'playback-whep',
            level: 'warn',
            cameraId: selectedCameraId,
            message: 'WHEP connect failed',
            why: err?.message || 'WebRTC/WHEP negotiation failed',
            url: whepUrl,
          });
          if (preview.hlsUrl) initHlsStream(preview.hlsUrl, host, canvas, overlay, fallback);
          else fallback();
        });
      return;
    }

    if (!preview.simulated && (preview.hlsUrl || (preview.mode === 'hls' && preview.url))) {
      const url = preview.hlsUrl || preview.url;
      window.CameraStreamLog?.report({
        source: 'face-live',
        step: 'playback-hls',
        cameraId: selectedCameraId,
        message: 'Trying HLS playback',
        url,
      });
      initHlsStream(url, host, canvas, overlay, fallback);
      return;
    }

    streamInitInFlight = false;
    fallback();
  }

  function resolveWsUrl(wsUrl) {
    if (!wsUrl) return wsUrl;
    if (/^wss?:\/\//i.test(wsUrl)) return wsUrl;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const path = wsUrl.startsWith('/') ? wsUrl : `/${wsUrl}`;
    return `${proto}//${location.host}${path}`;
  }

  function connectDetectionWs(wsUrl) {
    if (!wsUrl || detWs) return;
    const resolvedUrl = resolveWsUrl(wsUrl);

    const connectNow = () => {
      if (detWs) return;
      try {
        detWs = new WebSocket(resolvedUrl);
        detWs.onmessage = (ev) => {
          try {
            const data = JSON.parse(ev.data);
            if (!data || data.error || data.connected) return;
            if (data.inference_ms) lastInferenceMs = data.inference_ms;
            if (data.inference_ms) WHEP_FACE_DELAY_MS = Math.round(WHEP_FACE_DELAY_MS * 0.7 + data.inference_ms * 0.3);
            const raw = data.faces || data.detections || [];
            const processed = processRawFaces(raw, data.frame_w, data.frame_h);
            if (usingWhepStream || usingHlsStream) {
              ingestFaceSyncPacket(data, processed);
            } else {
              const ts = data.capture_ts || data.server_ts || Date.now();
              enqueueFaceUpdate(raw, data.frame_w, data.frame_h, ts);
            }
            if (inferenceStarting) {
              setInferenceStarting(false);
              updateInferenceUi(frameData || {});
            }
            frameData = {
              ...(frameData || {}),
              metrics: {
                ...(frameData?.metrics || {}),
                facesNow: processed.length,
                fps: data.fps ?? frameData?.metrics?.fps,
              },
            };
            if ((usingWhepStream || usingHlsStream) && !overlayAnimTimer && !vfcActive) {
              startOverlayLoop();
            }
            updateStatsOnly();
            drawFacesOverlay();
          } catch {
            /* ignore */
          }
        };
        detWs.onclose = () => { detWs = null; };
      } catch {
        /* ignore */
      }
    };

    if (usingWhepStream || usingHlsStream) {
      const host = document.getElementById('fliveStreamHost');
      const video = host?.querySelector('video.ov-plive-media');
      if (video && video.readyState < 2) {
        const waitForVideo = () => {
          if (video.readyState >= 2 || !video.paused) connectNow();
        };
        video.addEventListener('loadeddata', waitForVideo, { once: true });
        video.addEventListener('playing', waitForVideo, { once: true });
        video.addEventListener('wheptrack', waitForVideo, { once: true });
        setTimeout(connectNow, 1200);
        return;
      }
    }
    connectNow();
  }

  function updateStatsOnly() {
    const m = frameData?.metrics || payload?.faceMetrics || {};
    const map = {
      faces: m.facesNow ?? 0,
      known: m.knownNow ?? 0,
      unknown: m.unknownNow ?? 0,
      today: m.recognitionsToday ?? 0,
      fps: m.fps != null ? Number(m.fps).toFixed(1) : '—',
    };
    Object.entries(map).forEach(([key, val]) => {
      const el = document.querySelector(`[data-m="${key}"]`);
      if (el) el.textContent = val;
    });
  }

  function updateInferenceUi(data) {
    const btn = document.getElementById('fliveToggleBtn');
    const badge = document.getElementById('fliveStreamBadge');
    const mode = document.getElementById('fliveModeBadge');
    const note = document.getElementById('fliveBackendNote');
    if (inferenceStarting) return;
    if (btn) {
      btn.disabled = false;
      btn.textContent = inferenceRunning ? 'Stop recognition' : 'Start recognition';
      btn.classList.toggle('ov-det-stop-btn', inferenceRunning);
    }
    if (badge) badge.textContent = inferenceRunning ? 'RECOGNIZING' : 'LIVE PREVIEW';
    if (mode) {
      mode.textContent = inferenceRunning
        ? (data?.backendConnected ? 'Live AI' : 'Worker offline')
        : 'Preview';
    }
    if (note) {
      if (data?.backendError) note.textContent = data.backendError;
      else if (data?.backendConnected && inferenceRunning) {
        note.textContent = lineConfig?.enabled
          ? 'Tripwire ON — no face events/boxes until someone crosses the orange line.'
          : 'Face recognition active on vision API.';
      } else if (!inferenceRunning) {
        note.textContent = lineConfig?.enabled
          ? 'Tripwire saved — Start recognition. Events/boxes only on line cross.'
          : '';
      } else note.textContent = 'Vision API not connected — check board is running';
    }
  }

  function ensureLoadingStyle() {
    if (document.getElementById('plive-spin-style')) return;
    const s = document.createElement('style');
    s.id = 'plive-spin-style';
    s.textContent = '@keyframes plive-spin{to{transform:rotate(360deg)}}';
    document.head.appendChild(s);
  }

  function setInferenceStarting(starting) {
    inferenceStarting = starting;
    ensureLoadingStyle();
    const btn = document.getElementById('fliveToggleBtn');
    const badge = document.getElementById('fliveStreamBadge');
    const mode = document.getElementById('fliveModeBadge');
    const note = document.getElementById('fliveBackendNote');

    if (btn) {
      btn.disabled = starting;
      if (starting) btn.textContent = 'Starting recognition…';
    }
    if (badge) badge.textContent = starting ? 'STARTING' : (inferenceRunning ? 'RECOGNIZING' : 'LIVE PREVIEW');
    if (mode && starting) mode.textContent = 'Starting…';
    if (note && starting) note.textContent = 'Starting face recognition…';

    const host = document.getElementById('fliveStreamHost');
    let overlay = document.getElementById('fliveStartingOverlay');
    if (starting && host) {
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'fliveStartingOverlay';
        overlay.className = 'ov-plive-starting-overlay';
        overlay.innerHTML = '<div class="ov-plive-starting-spinner" aria-hidden="true"></div><span>Starting recognition…</span>';
        host.appendChild(overlay);
      }
    } else if (overlay) {
      overlay.remove();
    }
  }

  async function toggleRecognition() {
    if (!selectedCameraId || inferenceStarting) return;
    const start = !inferenceRunning;
    const path = start ? 'start' : 'stop';
    tripwireLog(start ? 'Start recognition clicked' : 'Stop recognition clicked', {
      cameraId: selectedCameraId,
      lineConfigBefore: lineConfig,
      draftPoints: draftLinePoints.length,
    });
    if (start) setInferenceStarting(true);
    // Preserve local tripwire across recognition start / DetectionTab.reload remount.
    const preservedLine = lineConfig ? { ...lineConfig } : null;
    let resultData = null;
    try {
      const url = sessionUrl(`/api/detection/face/live/${encodeURIComponent(selectedCameraId)}/${path}`);
      tripwireLog('API call →', 'POST', url, '(dashboard → board /api/face/stream/' + path + ' with saved line_*)');
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await res.json();
      resultData = data;
      tripwireLog('Start/stop recognition response', { status: res.status, ok: data.ok, error: data.error, backendError: data.backendError });
      if (!res.ok || data.ok === false) {
        throw new Error(data.error || data.backendError || 'Could not start recognition');
      }
      inferenceRunning = start;
      streamLocked = start;
      frameData = { ...(frameData || {}), ...data };
      if (data.payload) payload = data.payload;
      if (data.backendError && start) showToast(data.backendError);
      else showToast(start ? 'Face recognition started' : 'Face recognition stopped');
      if (start && data.wsUrl) {
        if (streamFirstFrameReceived || (!usingWhepStream && !usingHlsStream)) {
          connectDetectionWs(data.wsUrl);
        } else {
          pendingWsUrl = data.wsUrl;
        }
      } else {
        disconnectWs();
      }
      if (!start) {
        exitSyncedInferenceMode();
        streamLocked = false;
      }
      startPolling();
      await pollFrame();
      // Remount/reload can wipe UI — restore tripwire AFTER reload completes.
      if (start && window.DetectionTab?.reload) {
        tripwireLog('DetectionTab.reload after recognition start (will remount Face UI)');
        await window.DetectionTab.reload();
      }
      if (preservedLine?.enabled) {
        lineConfig = preservedLine;
        tripwireLog('Restored tripwire after remount', lineConfig);
      }
      await loadLineConfig();
      if (!lineConfig && preservedLine?.enabled) {
        lineConfig = preservedLine;
        tripwireWarn('Board reload lost line — kept local saved tripwire');
      }
      syncLineDrawUi();
      drawFacesOverlay();
      tripwireLog('After Start recognition — tripwire still active?', {
        enabled: Boolean(lineConfig?.enabled),
        lineConfig,
        inferenceRunning,
      });
    } catch (err) {
      tripwireWarn('Recognition toggle failed', err);
      showToast(err.message || 'Could not update recognition');
    } finally {
      if (start) setInferenceStarting(false);
      updateInferenceUi(resultData || frameData);
      drawFacesOverlay();
    }
  }

  async function pollFrame() {
    if (!selectedCameraId) return;
    try {
      const res = await fetch(sessionUrl(`/api/detection/face/live/${encodeURIComponent(selectedCameraId)}/frame`));
      if (!res.ok) return;
      frameData = await res.json();
      if (streamLocked || inferenceStarting) {
        inferenceRunning = Boolean(frameData.inferenceRunning);
      }
      if (frameData.payload) payload = frameData.payload;

      if (usingSyncedInferenceStream) {
        /* synced inference stream renders annotated JPEG on canvas */
      } else if (detWs) {
        /* Real-time detection WebSocket is the single source of boxes; the slow
           HTTP poll must NOT inject stale/track-less faces into the sync buffer. */
      } else if (usingWhepStream || usingHlsStream) {
        const processed = processRawFaces(
          frameData.faces || [],
          frameData.frame_w || inferenceFrameW,
          frameData.frame_h || inferenceFrameH,
        );
        ingestFaceSyncPacket(
          {
            capture_ts: frameData.capture_ts || (frameData.updatedAt ? new Date(frameData.updatedAt).getTime() : Date.now()),
            server_ts: Date.now(),
            frame_w: frameData.frame_w || inferenceFrameW,
            frame_h: frameData.frame_h || inferenceFrameH,
          },
          processed,
        );
      } else {
        applyDisplayFaces(processRawFaces(
          frameData.faces || [],
          frameData.frame_w || inferenceFrameW,
          frameData.frame_h || inferenceFrameH,
        ));
      }

      if (usingWhepStream || usingHlsStream) {
        startOverlayLoop();
        syncStreamLoadingUi('Waiting for first frame…');
      }
      drawFacesOverlay();

      updateStatsOnly();
      updateInferenceUi(frameData);

      if (frameData.newEvents?.length && window.DetectionTab?.prependEvents) {
        window.DetectionTab.prependEvents(frameData.newEvents, frameData.payload);
      }
      if (frameData.newEvents?.length && window.FaceModule?.onNewEvents) {
        window.FaceModule.onNewEvents(frameData.newEvents);
      }

      if (inferenceRunning && frameData.wsUrl && !detWs) {
        if (streamFirstFrameReceived || (!usingWhepStream && !usingHlsStream)) {
          connectDetectionWs(frameData.wsUrl);
        } else {
          pendingWsUrl = frameData.wsUrl;
        }
      }
    } catch {
      /* ignore */
    }
  }

  function startPolling() {
    stopPolling();
    pollFrame();
    const ms = inferenceRunning ? (detWs ? 2000 : 800) : 2500;
    pollTimer = setInterval(pollFrame, ms);
  }

  function collectFeatures() {
    const features = { ...(payload?.state?.features || {}), faceDetection: true };
    document.querySelectorAll('[data-feature-id]').forEach((el) => {
      if (el.disabled) return;
      features[el.dataset.featureId] = el.checked;
    });
    return features;
  }

  function collectAlerts() {
    const alerts = {};
    document.querySelectorAll('[data-alert-id]').forEach((el) => {
      alerts[el.dataset.alertId] = el.checked;
    });
    return alerts;
  }

  let configSaveTimer = null;
  function scheduleConfigSave(patch) {
    clearTimeout(configSaveTimer);
    configSaveTimer = setTimeout(() => saveConfig(patch), 500);
  }

  async function saveConfig(patch) {
    if (!selectedCameraId) return;
    try {
      const res = await fetch(sessionUrl(`/api/detection/face/live/${encodeURIComponent(selectedCameraId)}/config`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error();
      const data = await res.json();
      if (data.payload) payload = data.payload;
    } catch {
      showToast('Could not save settings');
    }
  }

  function wireControls() {
    document.getElementById('fliveToggleBtn')?.addEventListener('click', toggleRecognition);
    document.getElementById('fliveEnrollBtn')?.addEventListener('click', () => {
      window.FaceModule?.openTab?.('enrollment');
    });

    document.querySelectorAll('[data-feature-id]').forEach((el) => {
      el.addEventListener('change', () => {
        scheduleConfigSave({ features: collectFeatures() });
        drawFacesOverlay();
      });
    });
    document.querySelectorAll('[data-alert-id]').forEach((el) => {
      el.addEventListener('change', () => scheduleConfigSave({ alerts: collectAlerts() }));
    });

    const conf = document.getElementById('fliveConfidence');
    const confVal = document.getElementById('fliveConfVal');
    const confHint = document.getElementById('fliveConfHint');
    conf?.addEventListener('input', () => {
      const pct = Number(conf.value);
      if (confVal) confVal.textContent = `${pct}%`;
      if (confHint) confHint.textContent = confidenceHint(pct);
      currentMatchThreshold = pct / 100;
      drawFacesOverlay();
    });
    conf?.addEventListener('change', () => {
      const pct = Number(conf.value);
      currentMatchThreshold = pct / 100;
      scheduleConfigSave({ matchThreshold: currentMatchThreshold });
      drawFacesOverlay();
    });

    wireLineControls();
  }

  function setLineHint(text) {
    const el = document.getElementById('fliveLineHint');
    if (el) el.textContent = text;
  }

  function syncLineDrawUi() {
    const host = document.getElementById('fliveStreamHost');
    const overlay = document.getElementById('fliveOverlay');
    const banner = document.getElementById('fliveLineBanner');
    const drawBtn = document.getElementById('fliveLineDrawBtn');
    const undoBtn = document.getElementById('fliveLineUndoBtn');
    const doneBtn = document.getElementById('fliveLineDoneBtn');
    const clearBtn = document.getElementById('fliveLineClearBtn');

    host?.classList.toggle('is-zone-drawing', lineDrawMode);
    host?.classList.toggle('is-tripwire-drawing', lineDrawMode);
    if (overlay) {
      overlay.style.pointerEvents = lineDrawMode ? 'auto' : 'none';
      overlay.style.cursor = lineDrawMode ? 'crosshair' : '';
    }
    if (banner) {
      banner.hidden = !lineDrawMode;
      banner.textContent = lineSaveInFlight
        ? 'Saving tripwire on board…'
        : 'Click 2 points to draw the tripwire';
    }
    if (drawBtn) {
      drawBtn.textContent = lineDrawMode ? 'Cancel' : 'Draw line';
      drawBtn.disabled = lineSaveInFlight;
    }
    if (undoBtn) undoBtn.disabled = lineSaveInFlight || !draftLinePoints.length;
    if (doneBtn) doneBtn.disabled = lineSaveInFlight || draftLinePoints.length < 2;
    if (clearBtn) clearBtn.disabled = lineSaveInFlight || !(lineConfig?.enabled || draftLinePoints.length);

    if (lineDrawMode) {
      if (draftLinePoints.length === 0) setLineHint('Click first endpoint on the video');
      else if (draftLinePoints.length === 1) setLineHint('Click second endpoint to finish the line');
      else setLineHint('Both points set — click Save to store on board');
    } else if (lineConfig?.enabled) {
      setLineHint('Line active — events only when a face crosses it');
    } else {
      setLineHint('Draw 2 points, then click Save. Start recognition after save.');
    }
    drawFacesOverlay();
  }

  function setLineDrawMode(on) {
    lineDrawMode = Boolean(on);
    if (!lineDrawMode) draftLinePoints = [];
    syncLineDrawUi();
  }

  function overlayClickToNormalized(ev) {
    const overlay = document.getElementById('fliveOverlay');
    const host = document.getElementById('fliveStreamHost');
    const video = host?.querySelector('video.ov-plive-media');
    if (!overlay) return null;
    const rect = overlay.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;
    const w = overlay.width || rect.width;
    const h = overlay.height || rect.height;
    const coverRect = video?.videoWidth
      ? getCoverVideoRect(video, w, h)
      : { offsetX: 0, offsetY: 0, drawW: w, drawH: h };
    if (!coverRect.drawW || !coverRect.drawH) return null;
    const nx = (x - coverRect.offsetX) / coverRect.drawW;
    const ny = (y - coverRect.offsetY) / coverRect.drawH;
    if (nx < 0 || ny < 0 || nx > 1 || ny > 1) return null;
    return { x: Math.min(1, Math.max(0, nx)), y: Math.min(1, Math.max(0, ny)) };
  }

  async function loadLineConfig() {
    if (!selectedCameraId) {
      tripwireLog('loadLineConfig skipped — no camera');
      lineConfig = null;
      return;
    }
    const url = sessionUrl(`/api/face/stream/line-config/${encodeURIComponent(selectedCameraId)}`);
    tripwireLog('API call → GET', url, '(dashboard → board GET /api/face/stream/line-config/:backendCameraId)');
    try {
      const res = await fetch(url);
      const data = await res.json().catch(() => ({}));
      tripwireLog('GET line-config response', { status: res.status, data });
      if (res.ok && data.enabled && data.line_x1 != null) {
        lineConfig = {
          enabled: true,
          line_x1: data.line_x1,
          line_y1: data.line_y1,
          line_x2: data.line_x2,
          line_y2: data.line_y2,
        };
        tripwireLog('Loaded saved tripwire from board', lineConfig);
      } else if (res.ok) {
        // Board answered: no line saved
        lineConfig = null;
        tripwireLog('Board has no saved tripwire for this camera');
      } else {
        // Keep existing local lineConfig on error (do not wipe UI line).
        tripwireWarn('GET line-config failed — keeping local lineConfig', lineConfig, data);
      }
    } catch (err) {
      tripwireWarn('GET line-config network error — keeping local lineConfig', err, lineConfig);
    }
    syncLineDrawUi();
    updateInferenceUi(frameData || {});
    drawFacesOverlay();
  }

  async function saveDraftLine() {
    if (!selectedCameraId || draftLinePoints.length < 2) {
      tripwireWarn('Save blocked — need 2 points', { cameraId: selectedCameraId, points: draftLinePoints.length });
      showToast('Place 2 points, then click Save');
      return;
    }
    if (lineSaveInFlight) {
      tripwireLog('Save ignored — already in flight');
      return;
    }
    const [a, b] = draftLinePoints;
    const body = {
      line_x1: a.x,
      line_y1: a.y,
      line_x2: b.x,
      line_y2: b.y,
      enabled: true,
    };
    const url = sessionUrl(`/api/face/stream/line-config/${encodeURIComponent(selectedCameraId)}`);
    tripwireLog('SAVE clicked — API call → PUT', url, body);
    tripwireLog('Flow: Browser → Dashboard PUT /api/face/stream/line-config/:dashboardCameraId → Board PUT /api/face/stream/line-config/:backendCameraId');
    lineSaveInFlight = true;
    syncLineDrawUi();
    try {
      const res = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      tripwireLog('PUT line-config response', { status: res.status, data });
      if (!res.ok || data.ok === false) {
        throw new Error(data.error || 'Could not save tripwire on board');
      }
      lineConfig = {
        enabled: true,
        line_x1: data.line_x1 ?? a.x,
        line_y1: data.line_y1 ?? a.y,
        line_x2: data.line_x2 ?? b.x,
        line_y2: data.line_y2 ?? b.y,
      };
      draftLinePoints = [];
      lineDrawMode = false;
      syncLineDrawUi();
      updateInferenceUi(frameData || {});
      drawFacesOverlay();
      showToast(data.restarted ? 'Tripwire saved on board — stream restarted' : 'Tripwire saved — click Start recognition');
      tripwireLog('Tripwire saved OK. Next: Start recognition. All face events also appear under Line crossed.', lineConfig);
    } catch (err) {
      tripwireWarn('Save failed', err);
      showToast(err.message || 'Could not save tripwire on board');
      syncLineDrawUi();
    } finally {
      lineSaveInFlight = false;
      syncLineDrawUi();
    }
  }

  async function clearLine() {
    if (!selectedCameraId || lineSaveInFlight) return;
    draftLinePoints = [];
    lineDrawMode = false;
    lineSaveInFlight = true;
    const url = sessionUrl(`/api/face/stream/line-config/${encodeURIComponent(selectedCameraId)}`);
    tripwireLog('CLEAR clicked — API call → DELETE', url);
    try {
      const res = await fetch(url, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      tripwireLog('DELETE line-config response', { status: res.status, data });
      if (!res.ok || data.ok === false) {
        throw new Error(data.error || 'Could not clear tripwire on board');
      }
      lineConfig = null;
      syncLineDrawUi();
      updateInferenceUi(frameData || {});
      drawFacesOverlay();
      showToast(data.restarted ? 'Tripwire cleared — stream restarted' : 'Tripwire cleared');
    } catch (err) {
      tripwireWarn('Clear failed', err);
      showToast(err.message || 'Could not clear tripwire on board');
      syncLineDrawUi();
    } finally {
      lineSaveInFlight = false;
      syncLineDrawUi();
    }
  }

  function wireLineControls() {
    document.getElementById('fliveLineDrawBtn')?.addEventListener('click', () => {
      const next = !lineDrawMode;
      tripwireLog(next ? 'Draw mode ON — click 2 points on video, then click Save' : 'Draw mode cancelled');
      setLineDrawMode(next);
    });
    document.getElementById('fliveLineUndoBtn')?.addEventListener('click', () => {
      if (!lineDrawMode) return;
      draftLinePoints = draftLinePoints.slice(0, -1);
      tripwireLog('Undo point', { remaining: draftLinePoints.length, draftLinePoints });
      syncLineDrawUi();
    });
    document.getElementById('fliveLineDoneBtn')?.addEventListener('click', () => {
      tripwireLog('Save button clicked');
      saveDraftLine();
    });
    document.getElementById('fliveLineClearBtn')?.addEventListener('click', () => {
      tripwireLog('Clear button clicked');
      clearLine();
    });

    const overlay = document.getElementById('fliveOverlay');
    overlay?.addEventListener('click', (ev) => {
      if (!lineDrawMode) return;
      const pt = overlayClickToNormalized(ev);
      if (!pt) {
        tripwireWarn('Click ignored — outside video cover area');
        return;
      }
      if (draftLinePoints.length >= 2) draftLinePoints = [];
      draftLinePoints.push(pt);
      tripwireLog(`Point ${draftLinePoints.length}/2 placed`, pt);
      if (draftLinePoints.length >= 2) {
        // Do NOT auto-save — user must click Save.
        tripwireLog('Both points ready — click Save to call PUT line-config API');
        setLineHint('Both points set — click Save to store on board');
        syncLineDrawUi();
      } else {
        syncLineDrawUi();
      }
    });
    syncLineDrawUi();
  }

  function mount(preserveStream, skipStreamInit) {
    const root = getRoot();
    if (!root) return;

    let savedStream = null;
    let savedPc = null;
    if (preserveStream && streamInitialized) {
      const oldVideo = root.querySelector('video.ov-plive-media');
      if (oldVideo?.srcObject) {
        savedStream = oldVideo.srcObject;
        savedPc = whepPlayer?.pc || null;
        whepPlayer = null;
      } else if (usingHlsStream && hlsPlayer) {
        savedHlsPlayer = hlsPlayer;
        hlsPlayer = null;
      }
    }

    root.hidden = false;
    root.innerHTML = renderWorkbench();
    wireControls();
    currentMatchThreshold = payload?.state?.matchThreshold ?? currentMatchThreshold;
    const conf = document.getElementById('fliveConfidence');
    if (conf) conf.value = Math.round(currentMatchThreshold * 100);

    if (preserveStream && (savedStream || savedHlsPlayer)) {
      const host = document.getElementById('fliveStreamHost');
      const canvas = document.getElementById('fliveCanvas');
      const overlay = document.getElementById('fliveOverlay');
      if (canvas) canvas.style.display = 'none';
      if (overlay) overlay.style.display = 'block';
      host?.querySelectorAll('.ov-plive-media').forEach((el) => el.remove());
      const video = document.createElement('video');
      video.className = 'ov-plive-media';
      video.autoplay = true;
      video.muted = true;
      video.playsInline = true;
      host?.insertBefore(video, host.firstChild);
      if (savedStream) {
        video.srcObject = savedStream;
        video.play().catch(() => {});
        if (savedPc) {
          whepPlayer = { pc: savedPc, video, close() { try { savedPc.close(); } catch { /* */ } video.srcObject = null; } };
          usingWhepStream = true;
        }
      } else if (savedHlsPlayer) {
        hlsPlayer = savedHlsPlayer;
        savedHlsPlayer = null;
        hlsPlayer.attachMedia(video);
        usingHlsStream = true;
        video.play().catch(() => {});
      }
      streamFirstFrameReceived = true;
      const meta = document.getElementById('fliveStreamMeta');
      if (meta && frameData?.preview?.label) meta.textContent = frameData.preview.label;
      startOverlayLoop();
      drawFacesOverlay();
    } else if (!skipStreamInit && (!preserveStream || !streamInitialized)) {
      showCameraLoadingScreen();
    }

    updateInferenceUi(frameData || {});
    if (selectedCameraId) loadLineConfig();
  }

  async function selectCamera(cameraId) {
    if (selectedCameraId === cameraId && !streamActive) {
      document.querySelectorAll('.ov-cam-tile-clickable').forEach((tile) => {
        tile.classList.toggle('is-selected', tile.dataset.id === cameraId);
      });
      return;
    }

    const keepInferenceUi = Boolean(
      inferenceRunning && selectedCameraId === cameraId,
    );

    // Switching cameras: stop local preview only. Server stops old recognition itself.
    if (selectedCameraId && selectedCameraId !== cameraId) stopStreamPlayback();
    else if (streamActive && !keepInferenceUi) stopStreamPlayback();

    selectedCameraId = cameraId;
    streamInitialized = false;
    streamFirstFrameReceived = false;
    streamInitInFlight = false;
    streamActive = false;
    hlsStreamFailed = false;
    pendingWsUrl = null;
    // Do not force recognition off — server tells us if it is still running.
    if (!keepInferenceUi) inferenceRunning = false;
    lineDrawMode = false;
    draftLinePoints = [];
    lineConfig = null;
    lineSaveInFlight = false;
    resetSyncEngine();

    stopHls();
    stopWhep();
    if (!keepInferenceUi) disconnectWs();
    stopOverlayLoop();
    stopPolling();
    if (streamReconnectTimer) {
      clearTimeout(streamReconnectTimer);
      streamReconnectTimer = null;
    }

    document.querySelectorAll('.ov-cam-tile-clickable').forEach((tile) => {
      tile.classList.toggle('is-selected', tile.dataset.id === cameraId);
    });

    mount(false);
    showStreamIdleState();

    try {
      const [selectResult, liveResult] = await Promise.allSettled([
        fetch(sessionUrl(`/api/detection/face/live/${encodeURIComponent(cameraId)}/select`), { method: 'POST' })
          .then((r) => r.json()),
        fetch(sessionUrl(`/api/cameras/${encodeURIComponent(cameraId)}/live?slug=face&sync=1`))
          .then((r) => (r.ok ? r.json() : null)),
      ]);

      const selData = selectResult.status === 'fulfilled' ? selectResult.value : null;
      const liveData = liveResult.status === 'fulfilled' ? liveResult.value : null;
      if (selData?.payload) payload = selData.payload;

      // Restore background recognition after tab switch (server keeps it running).
      inferenceRunning = Boolean(
        selData?.inferenceRunning
        ?? selData?.payload?.state?.inferenceRunning
        ?? keepInferenceUi,
      );

      const previewSource = liveData || selData;
      if (previewSource?.preview) {
        frameData = {
          ...(frameData || {}),
          preview: previewSource.preview,
          camera: previewSource.camera || liveData?.camera,
          whepUrl: selData?.whepUrl || previewSource.whepUrl,
          hlsUrl: selData?.hlsUrl || previewSource.hlsUrl,
          inferenceRunning,
          wsUrl: inferenceRunning
            ? `/ws/face-live?cameraId=${encodeURIComponent(cameraId)}`
            : null,
        };
      }

      if (selData?.backendReachable === false) {
        showToast('Vision API not connected — preview only');
      }
    } catch (err) {
      showToast(err.message || 'Could not connect to camera');
    }

    startPolling();
    await pollFrame();
    updateInferenceUi(frameData || {});
    window.CameraManagement?.refreshStreamStates?.();
    if (window.DetectionTab?.reload) window.DetectionTab.reload();
  }

  async function initFromPayload(detPayload) {
    payload = detPayload;
    currentMatchThreshold = payload?.state?.matchThreshold ?? 0.48;
    const hasCameras = (payload?.assignedCameras || []).length > 0;
    const root = getRoot();
    if (!hasCameras) {
      selectedCameraId = null;
      stopPolling();
      stopHls();
      stopWhep();
      disconnectWs();
      stopOverlayLoop();
      if (root) {
        root.hidden = true;
        root.innerHTML = '';
      }
      return;
    }

    const activeId = payload?.state?.activeCameraId;
    const wasRunning = Boolean(payload?.state?.inferenceRunning && activeId);

    if (activeId) {
      if (activeId === selectedCameraId && streamInitialized) {
        inferenceRunning = wasRunning || inferenceRunning;
        mount(true);
        syncStreamLoadingUi(wasRunning ? 'Recognition running…' : 'Reconnecting…');
        startPolling();
        await pollFrame();
        updateInferenceUi(frameData || {});
        return;
      }
      if (activeId !== selectedCameraId) {
        // Soft restore: selectCamera now preserves server-side recognition.
        if (wasRunning) inferenceRunning = true;
        await selectCamera(activeId);
        return;
      }
    }

    if (!selectedCameraId && payload.assignedCameras?.length === 1) {
      if (wasRunning && payload.assignedCameras[0].id === activeId) {
        inferenceRunning = true;
      }
      await selectCamera(payload.assignedCameras[0].id);
      return;
    }

    if (!selectedCameraId && root) {
      root.hidden = false;
      root.innerHTML = renderEmpty();
    }
  }

  window.FaceLive = {
    selectCamera,
    startStream,
    stopStream,
    isStreamActive,
    getSelectedCameraId: () => selectedCameraId,
    initFromPayload,
    clearCamera() {
      selectedCameraId = null;
      inferenceRunning = false;
      inferenceStarting = false;
      streamLocked = false;
      streamInitialized = false;
      stopPolling();
      stopHls();
      stopWhep();
      disconnectWs();
      stopOverlayLoop();
      const root = getRoot();
      const hasCameras = (payload?.assignedCameras || []).length > 0;
      if (root) {
        if (!hasCameras) {
          root.hidden = true;
          root.innerHTML = '';
        } else {
          root.hidden = false;
          root.innerHTML = renderEmpty();
        }
      }
    },
  };

  document.addEventListener('DOMContentLoaded', () => {
    const root = getRoot();
    if (root) root.hidden = true;
  });
})();
