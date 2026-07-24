  /**
   * Person tab — in-page live stream + detection controls (above stream).
   */
  (function () {
    const slug = document.body.dataset.detectionSlug;
    if (slug !== 'person') return;

    let selectedCameraId = null;
    let payload = null;
    let frameData = null;
    let pollTimer = null;
    let simAnimTimer = null;
    let configSaveTimer = null;
    let inferenceRunning = false;
    let inferenceStarting = false;
    let hlsPlayer = null;
    let whepPlayer = null;
    let detWs = null;
    let usingHlsStream = false;
    let usingWhepStream = false;
    let hlsStreamFailed = false;
    let streamResyncTimer = null;
    let streamResyncAttempts = 0;
    let lastFrameTs = 0;
    let streamLocked = false;
    let streamInitialized = false;
    let currentConfidence = 0.32;
    let pendingJpeg = null;
    let jpegDrawScheduled = false;
    let detectionQueue = [];
    let detectionDelayTimer = null;
    let savedWhepPc = null;
    let savedHlsPlayer = null;
    let streamStartedAt = 0;
    let streamDelayMs = 0;
    let streamConnectTimeout = null;
    let streamConnectLoopTimer = null;
    let streamConnectLoopStartedAt = 0;
    let streamConnectInFlight = false;
    let streamFirstFrameReceived = false;
    let streamWatchdogTimer = null;
    let pendingWsUrl = null;
    let vfcActive = false;
    let usingSyncedInferenceStream = false;
    let lastDisplayedFrameId = null;
    let syncViolationCount = 0;

    const STREAM_TIMEOUT_MS = 10000;
    const WHEP_PIPELINE_MS = 150;
    const HLS_PIPELINE_MS = 2200;
    const DETECTION_HOLD_MS = 0;
    const SYNC_MAX_AGE_MS = 2000;
    const SYNC_BUFFER_MAX = 16;
    let WHEP_DETECTION_DELAY_MS = 500;
    const HLS_DETECTION_DELAY_MS = 0;
    let streamActive = false;
    let selectGeneration = 0;
    let syncPacketBuffer = [];
    let syncLatencyEma = 0;
    let syncDisplayDetections = [];
    let syncPipelineDelayMs = WHEP_PIPELINE_MS;
    let syncOffsetEma = 0;
    let syncVideoAheadEma = 0;
    let syncClockSkewEma = 0; // browser_now - backend_now (ms)
    let lastSyncCaptureTs = 0;
    let lastStableDetections = [];
    let lastStableDetectionsAt = 0;
    let streamHealthTimer = null;
    let lastVideoTime = 0;
    let lastVideoTimeAt = 0;
    let streamStallRecoveries = 0;
    let overlayCanvasW = 0;
    let overlayCanvasH = 0;
    let zoneDrawMode = false;
    let draftZonePoints = [];

    function enterSyncedInferenceMode() {
      if (usingSyncedInferenceStream) return;
      usingSyncedInferenceStream = true;
      lastDisplayedFrameId = null;
      syncViolationCount = 0;
      stopOverlayLoop();
      stopWhep();
      stopHls();
      usingWhepStream = false;
      usingHlsStream = false;
      resetSyncEngine();
      clearDetectionQueue();
      const host = document.getElementById('pliveStreamHost');
      host?.querySelectorAll('.ov-plive-media').forEach((el) => el.remove());
      const canvas = document.getElementById('pliveCanvas');
      const overlay = document.getElementById('pliveOverlay');
      if (canvas) canvas.style.display = 'block';
      if (overlay) overlay.style.display = 'none';
      streamFirstFrameReceived = true;
      hideStreamLoadingOverlay();
    }

    function exitSyncedInferenceMode() {
      if (!usingSyncedInferenceStream) return;
      usingSyncedInferenceStream = false;
      lastDisplayedFrameId = null;
      syncViolationCount = 0;
      const overlay = document.getElementById('pliveOverlay');
      if (overlay) overlay.style.display = 'block';
      if (frameData?.preview && streamActive) {
        initStreamWithPreview({ preview: frameData.preview, camera: frameData.camera });
      }
    }

    function verifyFrameSync(frameId, detectionFrameId) {
      if (frameId == null || detectionFrameId == null) return true;
      if (frameId !== detectionFrameId) {
        syncViolationCount += 1;
        console.error(
          '[person-live] SYNC VIOLATION: displayed frame %s != detection frame %s (count=%s)',
          frameId,
          detectionFrameId,
          syncViolationCount,
        );
        return false;
      }
      return true;
    }

    function handleSyncedDetectionPacket(data) {
      const frameId = data.frame_id ?? data.frame ?? null;
      if (frameId != null && frameId === lastDisplayedFrameId) return;

      const rawCaptureTs = data.capture_ts || data.ts || Date.now();
      const serverTs = data.server_ts || Date.now();
      updateClockSkew(serverTs, Date.now());
      const captureTs = toLocalTs(rawCaptureTs);
      const confThreshold = currentConfidence ?? payload?.state?.confidence ?? 0.32;
      const detections = (data.detections || []).filter((d) => (d.score ?? 0) >= confThreshold);

      lastDisplayedFrameId = frameId;
      measureSyncOffset(captureTs, serverTs);
      ingestSyncPacket(data, detections);

      frameData = {
        ...(frameData || {}),
        detections,
        syncFrameId: frameId,
        captureTs,
        inferenceStartTs: data.inference_start_ts,
        inferenceFinishTs: data.inference_finish_ts,
        metrics: {
          ...(frameData?.metrics || {}),
          fps: data.fps ?? frameData?.metrics?.fps,
          inferenceMs: data.inference_ms ?? frameData?.metrics?.inferenceMs,
          current: detections.length,
          presenceActive: detections.length > 0,
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
      syncLatencyEma = 0;
      syncDisplayDetections = [];
      syncPipelineDelayMs = WHEP_PIPELINE_MS;
      syncOffsetEma = 0;
      syncVideoAheadEma = 0;
      syncClockSkewEma = 0;
      lastSyncCaptureTs = 0;
      lastStableDetections = [];
      lastStableDetectionsAt = 0;
    }

    function updateClockSkew(serverTs, receivedAt = Date.now()) {
      const st = Number(serverTs);
      if (!Number.isFinite(st) || st <= 0) return;
      const skew = receivedAt - st;
      // accept within +/- 60s (covers NTP drift without exploding)
      if (skew > -60000 && skew < 60000) {
        syncClockSkewEma = syncClockSkewEma ? (syncClockSkewEma * 0.9 + skew * 0.1) : skew;
      }
    }

    function toLocalTs(backendTs) {
      const ts = Number(backendTs);
      if (!Number.isFinite(ts) || ts <= 0) return ts;
      return ts + (syncClockSkewEma || 0);
    }

    function getVideoDisplayTs(now = Date.now()) {
      return now - getStreamPipelineDelayMs();
    }

    function measureSyncOffset(captureTs, serverTs, receivedAt = Date.now()) {
      if (!captureTs) return;
      lastSyncCaptureTs = captureTs;
      const pipeline = getStreamPipelineDelayMs();
      const videoDisplayTs = receivedAt - pipeline;
      const ahead = videoDisplayTs - captureTs;
      if (ahead > -120 && ahead < 900) {
        syncVideoAheadEma = syncVideoAheadEma ? syncVideoAheadEma * 0.88 + ahead * 0.12 : ahead;
      }
      // Auto-tune pipeline offset: if our assumed displayed-video timestamp is
      // ahead of capture_ts, increase delay; if it's behind, decrease delay.
      // This reduces "bbox trailing behind the person" on WHEP.
      if (ahead > -450 && ahead < 450) {
        const target = ahead; // deltaPipeline ≈ ahead (see derivation above)
        syncOffsetEma = syncOffsetEma ? (syncOffsetEma * 0.9 + target * 0.1) : target;
      }
      const inferLag = serverTs - captureTs;
      if (inferLag >= 0 && inferLag < 2000) {
        syncLatencyEma = syncLatencyEma ? syncLatencyEma * 0.88 + inferLag * 0.12 : inferLag;
      }
    }

    function stopStreamHealthMonitor() {
      if (streamHealthTimer) clearInterval(streamHealthTimer);
      streamHealthTimer = null;
      lastVideoTime = 0;
      lastVideoTimeAt = 0;
    }

    function recoverStalledStream() {
      if (!selectedCameraId || streamStallRecoveries >= 3) return;
      streamStallRecoveries += 1;
      const preview = frameData?.preview;
      if (!preview?.url && !preview?.hlsUrl) return;
      streamFirstFrameReceived = false;
      const host = document.getElementById('pliveStreamHost');
      const canvas = document.getElementById('pliveCanvas');
      const overlay = document.getElementById('pliveOverlay');
      if (!host) return;
      stopWhep();
      stopHls();
      usingWhepStream = false;
      usingHlsStream = false;
      beginStreamPlayback(preview, host, canvas, overlay, { preview, camera: frameData?.camera });
    }

    function startStreamHealthMonitor(video) {
      stopStreamHealthMonitor();
      streamStallRecoveries = 0;
      lastVideoTime = video.currentTime || 0;
      lastVideoTimeAt = Date.now();

      streamHealthTimer = setInterval(() => {
        if (!selectedCameraId || !video?.isConnected) {
          stopStreamHealthMonitor();
          return;
        }
        if (video.paused && streamFirstFrameReceived) {
          video.play().catch(() => {});
        }
        if (usingWhepStream && !usingHlsStream) return;

        const t = video.currentTime;
        const now = Date.now();
        if (t > lastVideoTime + 0.01) {
          lastVideoTime = t;
          lastVideoTimeAt = now;
          return;
        }
        if (streamFirstFrameReceived && now - lastVideoTimeAt > 4000) {
          recoverStalledStream();
        }
      }, 800);
    }

    function getStreamPipelineDelayMs() {
      const host = document.getElementById('pliveStreamHost');
      const video = host?.querySelector('video.ov-plive-media');
      if (usingWhepStream && !usingHlsStream) {
        const base = streamDelayMs > 0 ? Math.round(streamDelayMs) : WHEP_PIPELINE_MS;
        const tuned = base + Math.round(syncOffsetEma || 0);
        return Math.max(60, Math.min(650, tuned));
      }
      if (usingHlsStream && video) {
        if (hlsPlayer?.latency > 0) return Math.round(hlsPlayer.latency * 1000);
        try {
          if (video.buffered?.length) {
            const end = video.buffered.end(video.buffered.length - 1);
            return Math.max(800, Math.round((end - video.currentTime) * 1000));
          }
        } catch {
          /* ignore */
        }
        return HLS_PIPELINE_MS;
      }
      return WHEP_PIPELINE_MS + Math.round(syncOffsetEma || 0);
    }

    function ingestSyncPacket(data, filtered) {
      const rawCaptureTs = data.capture_ts || data.ts || Date.now();
      const serverTs = data.server_ts || Date.now();
      const frameId = data.frame_id ?? data.frame ?? null;
      updateClockSkew(serverTs, Date.now());
      const captureTs = toLocalTs(rawCaptureTs);
      syncPacketBuffer.push({
        frameId,
        captureTs,
        serverTs,
        detections: filtered,
        receivedAt: Date.now(),
      });
      if (syncPacketBuffer.length > SYNC_BUFFER_MAX) {
        syncPacketBuffer = syncPacketBuffer.slice(-SYNC_BUFFER_MAX);
      }
      const relayLag = serverTs - rawCaptureTs;
      if (relayLag >= 0 && relayLag < 2000) {
        syncLatencyEma = syncLatencyEma ? syncLatencyEma * 0.85 + relayLag * 0.15 : relayLag;
      }
    }

    function buildPreviewFromCamera(cam) {
      if (!cam) return null;
      const whep = cam.whepUrl ? resolveStreamUrl(cam.whepUrl) : null;
      const hls = cam.hlsUrl ? resolveStreamUrl(cam.hlsUrl) : null;
      if (whep) {
        return {
          mode: 'whep',
          url: whep,
          hlsUrl: hls,
          whepUrl: whep,
          simulated: false,
          label: 'Live WebRTC stream',
        };
      }
      if (hls) {
        return { mode: 'hls', url: hls, hlsUrl: hls, whepUrl: whep, simulated: false, label: 'Live stream' };
      }
      if (cam.rtspUrl) {
        return {
          mode: 'edge',
          url: null,
          simulated: true,
          label: 'No board stream URL — register camera on board first',
        };
      }
      return null;
    }

    /** Map normalized box coords to overlay pixels (object-fit: cover aware). */
    function mapBoxToOverlay(box, video, img, containerW, containerH) {
      if (!box || box.length < 4) return null;
      let srcW;
      let srcH;
      if (video?.videoWidth) {
        srcW = video.videoWidth;
        srcH = video.videoHeight;
      } else if (img?.naturalWidth) {
        srcW = img.naturalWidth;
        srcH = img.naturalHeight;
      } else {
        // Fallback: if the media element hasn't reported intrinsic dimensions yet,
        // map directly in display space. This preserves overlay visibility while
        // the stream is warming up (some browsers report videoWidth=0 longer than expected).
        return {
          x1: box[0] * containerW,
          y1: box[1] * containerH,
          x2: box[2] * containerW,
          y2: box[3] * containerH,
        };
      }
      const scale = Math.max(containerW / srcW, containerH / srcH);
      const dw = srcW * scale;
      const dh = srcH * scale;
      const ox = (containerW - dw) / 2;
      const oy = (containerH - dh) / 2;
      return {
        x1: ox + box[0] * dw,
        y1: oy + box[1] * dh,
        x2: ox + box[2] * dw,
        y2: oy + box[3] * dh,
      };
    }

    function mapNormPointToOverlay(nx, ny, video, img, containerW, containerH) {
      const mapped = mapBoxToOverlay([nx, ny, nx, ny], video, img, containerW, containerH);
      if (!mapped) return null;
      return { x: mapped.x1, y: mapped.y1 };
    }

    function overlayClickToNorm(clientX, clientY) {
      const host = document.getElementById('pliveStreamHost');
      if (!host) return null;
      const video = host.querySelector('video.ov-plive-media');
      const img = host.querySelector('img.ov-plive-media');
      const rect = host.getBoundingClientRect();
      const cssW = Math.max(2, Math.round(rect.width));
      const cssH = Math.max(2, Math.round(rect.height));
      const px = clientX - rect.left;
      const py = clientY - rect.top;
      if (px < 0 || py < 0 || px > cssW || py > cssH) return null;

      let srcW = 0;
      let srcH = 0;
      if (video?.videoWidth) {
        srcW = video.videoWidth;
        srcH = video.videoHeight;
      } else if (img?.naturalWidth) {
        srcW = img.naturalWidth;
        srcH = img.naturalHeight;
      }

      if (!srcW || !srcH) {
        return [
          Math.max(0, Math.min(1, px / cssW)),
          Math.max(0, Math.min(1, py / cssH)),
        ];
      }

      const scale = Math.max(cssW / srcW, cssH / srcH);
      const dw = srcW * scale;
      const dh = srcH * scale;
      const ox = (cssW - dw) / 2;
      const oy = (cssH - dh) / 2;
      const nx = (px - ox) / dw;
      const ny = (py - oy) / dh;
      if (nx < 0 || ny < 0 || nx > 1 || ny > 1) return null;
      return [nx, ny];
    }

    function getCameraZones() {
      const zones = payload?.state?.zones || [];
      if (!selectedCameraId) return zones;
      return zones.filter((z) => !z.cameraId || z.cameraId === selectedCameraId);
    }

    function renderZoneToolbar() {
      const zones = getCameraZones().filter((z) => Array.isArray(z.points) && z.points.length >= 3);
      const list = zones.length
        ? zones
            .map(
              (z) => `
          <div class="ov-plive-zone-item" data-zone-id="${esc(z.id)}">
            <label class="ov-plive-zone-toggle" title="Enable danger alerts for this zone">
              <input type="checkbox" data-zone-enabled="${esc(z.id)}" ${z.enabled !== false ? 'checked' : ''}>
              <span class="ov-plive-zone-swatch" aria-hidden="true"></span>
              <span class="ov-plive-zone-name">${esc(z.name || 'Danger zone')}</span>
            </label>
            <button type="button" class="ov-plive-zone-del" data-zone-delete="${esc(z.id)}" title="Remove zone" aria-label="Remove zone">×</button>
          </div>`
            )
            .join('')
        : '<p class="ov-plive-zone-empty">No danger zone yet — click Draw, then tap corners on the video.</p>';

      return `
        <div class="ov-plive-toolbar-row ov-plive-zone-row">
          <span class="ov-plive-toolbar-label">Danger zone</span>
          <div class="ov-plive-zone-panel">
            <div class="ov-plive-zone-actions">
              <button type="button" class="ov-quick-btn ov-plive-zone-btn" id="pliveZoneDrawBtn">${zoneDrawMode ? 'Cancel' : 'Draw'}</button>
              <button type="button" class="ov-quick-btn ov-plive-zone-btn" id="pliveZoneUndoBtn" ${draftZonePoints.length ? '' : 'disabled'}>Undo</button>
              <button type="button" class="ov-quick-btn ov-plive-zone-btn ov-plive-zone-done" id="pliveZoneDoneBtn" ${draftZonePoints.length >= 3 ? '' : 'disabled'}>Done</button>
              <button type="button" class="ov-quick-btn ov-plive-zone-btn" id="pliveZoneClearBtn" ${zones.length || draftZonePoints.length ? '' : 'disabled'}>Clear</button>
            </div>
            <p class="ov-plive-zone-hint" id="pliveZoneHint">${
              zoneDrawMode
                ? `Click corners on the video (${draftZonePoints.length} point${draftZonePoints.length === 1 ? '' : 's'}). Need 3+, then Done.`
                : 'Mark a restricted area — anyone who steps inside triggers a Danger Zone event.'
            }</p>
            <div class="ov-plive-zone-list" id="pliveZoneList">${list}</div>
          </div>
        </div>`;
    }

    function pickSyncDetectionsForNow() {
      const now = Date.now();
      syncPacketBuffer = syncPacketBuffer.filter((pkt) => now - pkt.receivedAt <= SYNC_MAX_AGE_MS);
      if (!syncPacketBuffer.length) return;

      const targetTs = getVideoDisplayTs(now);
      let best = null;
      let bestScore = Infinity;
      for (const pkt of syncPacketBuffer) {
        const delta = pkt.captureTs - targetTs;
        const score = delta >= 0 ? delta * 0.65 : Math.abs(delta) * 1.2;
        if (score < bestScore) {
          bestScore = score;
          best = pkt;
        }
      }
      if (!best) return;

      const latest = syncPacketBuffer[syncPacketBuffer.length - 1];
      // Prefer the newest packet to minimize "bbox behind subject" feel.
      // If newest is slightly ahead/behind the target display ts, it's still better
      // than sticking to an older packet (especially at low inference FPS).
      if (latest && latest !== best) {
        const bestBehindMs = targetTs - best.captureTs;      // >0 means best is older than display
        const latestBehindMs = targetTs - latest.captureTs;  // >0 means latest is older than display
        const latestCloseEnough =
          Math.abs(latestBehindMs) <= 250
          || (bestBehindMs > 180 && latestBehindMs <= bestBehindMs);
        if (latestCloseEnough) best = latest;
      }

      const next = best.detections;
      syncDisplayDetections = next;
      lastStableDetections = next;
      lastStableDetectionsAt = now;
      lastSyncCaptureTs = best.captureTs;

      if (best.captureTs >= lastFrameTs) {
        lastFrameTs = best.captureTs;
        frameData = {
          ...(frameData || {}),
          detections: next,
          syncFrameId: best.frameId,
          metrics: {
            ...(frameData?.metrics || {}),
            current: next.length,
            presenceActive: next.length > 0,
          },
        };
      }
    }

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

    function confidenceHint(pct) {
      if (pct < 50) return 'Sensitive';
      if (pct < 75) return 'Balanced';
      return 'Strict';
    }

    function getRoot() {
      return document.getElementById('personLiveRoot');
    }

    function renderFeatureChips() {
      const options = payload?.tab?.featureOptions || [];
      const features = payload?.state?.features || {};
      return options
        .filter((o) => o.id !== 'detectPeople')
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

    function renderEmptyState() {
      return `
        <article class="ov-card ov-plive-empty">
          <div class="ov-plive-empty-inner">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"/><rect x="2" y="6" width="14" height="12" rx="2"/></svg>
            <h2>Select a camera</h2>
            <p>Choose a camera above, then click <strong>Start stream</strong> on its card. Use <strong>Start detection</strong> when you are ready for AI.</p>
          </div>
        </article>`;
    }

    function streamIdleMarkup() {
      return `
        <div class="ov-plive-stream-idle" id="pliveStreamIdle" role="status">
          <div class="ov-plive-stream-idle-icon" aria-hidden="true">
            <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"/><rect x="2" y="6" width="14" height="12" rx="2"/></svg>
          </div>
          <div class="ov-plive-stream-idle-title">Stream is off</div>
          <p class="ov-plive-stream-idle-sub">Click <strong>Start stream</strong> on the camera card to open live preview.</p>
        </div>`;
    }

    function clearLiveOverlay() {
      const overlay = document.getElementById('pliveOverlay');
      if (!overlay) return;
      const ctx = overlay.getContext('2d');
      if (ctx) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, overlay.width || 0, overlay.height || 0);
      }
      overlay.style.pointerEvents = 'none';
      overlay.style.cursor = '';
    }

    function showStreamIdleState() {
      const host = document.getElementById('pliveStreamHost');
      if (!host) return;
      host.querySelectorAll('.ov-plive-media').forEach((el) => el.remove());
      host.classList.remove('is-zone-drawing');
      if (!document.getElementById('pliveStreamIdle')) {
        host.insertAdjacentHTML('beforeend', streamIdleMarkup());
      }
      const idle = document.getElementById('pliveStreamIdle');
      if (idle) idle.hidden = false;
      const badge = document.getElementById('pliveStreamBadge');
      if (badge) badge.textContent = 'STREAM OFF';
      const banner = document.getElementById('pliveZoneBanner');
      if (banner) banner.hidden = true;
      const canvas = document.getElementById('pliveCanvas');
      if (canvas) {
        canvas.style.display = 'none';
        const cctx = canvas.getContext('2d');
        if (cctx) cctx.clearRect(0, 0, canvas.width || 0, canvas.height || 0);
      }
      clearLiveOverlay();
      hideStreamLoadingOverlay();
    }

    function hideStreamIdleState() {
      document.getElementById('pliveStreamIdle')?.remove();
    }

    function notifyStreamStateChange() {
      window.CameraManagement?.refreshStreamStates?.();
    }

    function prewarmDetectionWorker(cameraId) {
      const id = cameraId || selectedCameraId;
      if (!id) return;
      fetch(sessionUrl(`/api/detection/person/live/${encodeURIComponent(id)}/prewarm`), { method: 'POST' })
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (data?.wsUrl) {
            frameData = { ...(frameData || {}), wsUrl: data.wsUrl, prewarmed: true };
          }
        })
        .catch(() => {});
    }

    function stopStreamPlayback() {
      streamActive = false;
      streamFirstFrameReceived = false;
      streamInitialized = false;
      streamLocked = false;
      pendingWsUrl = null;
      zoneDrawMode = false;
      draftZonePoints = [];
      syncDisplayDetections = [];
      lastStableDetections = [];
      lastStableDetectionsAt = 0;
      if (frameData) {
        frameData = { ...frameData, detections: [], metrics: { ...(frameData.metrics || {}), current: 0, presenceActive: false } };
      }
      stopSimAnim();
      stopHls();
      stopWhep();
      stopOverlayLoop();
      stopStreamConnectLoop();
      stopStreamWatchdog();
      stopStreamHealthMonitor();
      clearStreamLoading();
      clearLiveOverlay();
      showStreamIdleState();
      notifyStreamStateChange();
    }

    function isStreamActive(cameraId) {
      if (cameraId && cameraId !== selectedCameraId) return false;
      return Boolean(streamActive && (streamFirstFrameReceived || usingWhepStream || usingHlsStream || streamConnectInFlight));
    }

    function ensureLoadingStyle() {
      if (document.getElementById('plive-spin-style')) return;
      const s = document.createElement('style');
      s.id = 'plive-spin-style';
      s.textContent = '@keyframes plive-spin{to{transform:rotate(360deg)}}';
      document.head.appendChild(s);
    }

    function renderLoadingState(cameraName) {
      return `
        <article class="ov-card ov-plive-workbench" id="personWorkbench">
          <div class="ov-plive-inner">
            <div class="ov-plive-stream-wrap">
              <div class="ov-plive-stream" id="pliveStreamHost" style="background:#0f172a;min-height:300px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;">
                <div style="width:48px;height:48px;border:3px solid #334155;border-top-color:#22c55e;border-radius:50%;animation:plive-spin 0.8s linear infinite;"></div>
                <div style="color:#94a3b8;font-size:14px;font-family:Inter,sans-serif;">Connecting to ${esc(cameraName || 'camera')}…</div>
                <div id="pliveLoadingStatus" style="color:#64748b;font-size:12px;font-family:Inter,sans-serif;">Registering stream</div>
              </div>
            </div>
          </div>
        </article>`;
    }

    function setLoadingStatus(msg) {
      const el = document.getElementById('pliveLoadingStatus');
      if (el) el.textContent = msg;
    }

    function clearStreamLoading() {
      const canvas = document.getElementById('pliveCanvas');
      if (canvas?._loadingTimer) {
        clearInterval(canvas._loadingTimer);
        canvas._loadingTimer = null;
      }
      if (streamConnectTimeout) {
        clearTimeout(streamConnectTimeout);
        streamConnectTimeout = null;
      }
    }

    function showStreamLoading() {
      const host = document.getElementById('pliveStreamHost');
      const canvas = document.getElementById('pliveCanvas');
      const overlay = document.getElementById('pliveOverlay');
      if (!host) return;

      stopSimAnim();
      host.querySelectorAll('.ov-plive-media').forEach((el) => el.remove());
      if (canvas) canvas.style.display = 'none';
      if (overlay) overlay.style.display = 'block';
      ensureStreamLoadingOverlay('Stream starting soon');
    }

    function showCameraLoadingScreen(cameraId) {
      const host = document.getElementById('pliveStreamHost');
      const canvas = document.getElementById('pliveCanvas');
      const overlay = document.getElementById('pliveOverlay');
      const badge = document.getElementById('pliveStreamBadge');
      if (!host) return;

      stopSimAnim();
      host.querySelectorAll('.ov-plive-media').forEach((el) => el.remove());
      if (canvas) canvas.style.display = 'none';
      if (overlay) overlay.style.display = 'block';
      if (badge) badge.textContent = 'CONNECTING';
      ensureStreamLoadingOverlay('Stream starting soon');
    }

    function markStreamConnected() {
      if (streamConnectTimeout) {
        clearTimeout(streamConnectTimeout);
        streamConnectTimeout = null;
      }
    }

    function watchWhepConnection(player, preview, host, canvas, overlay, onFailed) {
      const pc = player?.pc;
      if (!pc) return;
      pc.addEventListener('connectionstatechange', () => {
        if (pc.connectionState === 'connected' || pc.connectionState === 'connecting') return;
        if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
          if (streamFirstFrameReceived) return;
          stopWhep();
          usingWhepStream = false;
          const hlsUrl = preview?.hlsUrl
            || (preview?.mode === 'hls' ? preview.url : null)
            || (frameData?.camera?.hlsUrl ? resolveStreamUrl(frameData.camera.hlsUrl) : null);
          if (hlsUrl && !hlsStreamFailed) {
            initHlsStream(hlsUrl, host, canvas, overlay, onFailed);
            return;
          }
          if (typeof onFailed === 'function') onFailed();
        }
      });
    }

    function ensureStreamLoadingOverlay(message) {
      const host = document.getElementById('pliveStreamHost');
      if (!host) return;
      let overlay = document.getElementById('pliveStreamLoadingOverlay');
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'pliveStreamLoadingOverlay';
        overlay.className = 'ov-stream-loading-overlay';
        overlay.innerHTML = `
          <div class="ov-stream-loading-card ov-stream-loading-card--simple" role="status" aria-live="polite">
            <div class="ov-stream-loading-spinner" aria-hidden="true"></div>
            <div class="ov-stream-loading-title">Stream starting soon</div>
            <div class="ov-stream-loading-sub" id="pliveStreamLoadingSub" hidden></div>
          </div>`;
        host.appendChild(overlay);
      }
      const sub = document.getElementById('pliveStreamLoadingSub');
      // User asked: only show the title text.
      if (sub) {
        sub.textContent = message || '';
        sub.hidden = true;
      }
      overlay.style.display = 'flex';
    }

    function hideStreamLoadingOverlay() {
      const overlay = document.getElementById('pliveStreamLoadingOverlay');
      if (overlay) overlay.style.display = 'none';
    }

    function stopStreamWatchdog() {
      if (streamWatchdogTimer) clearTimeout(streamWatchdogTimer);
      streamWatchdogTimer = null;
    }

    function startStreamWatchdog() {
      stopStreamWatchdog();
      const tick = async () => {
        if (!selectedCameraId) return;
        if (streamFirstFrameReceived && isMediaActuallyReady()) {
          hideStreamLoadingOverlay();
          stopStreamWatchdog();
          return;
        }

        const host = document.getElementById('pliveStreamHost');
        if (!host) {
          streamWatchdogTimer = setTimeout(tick, 500);
          return;
        }

        if (
          usingWhepStream
          && !streamFirstFrameReceived
          && streamStartedAt
          && Date.now() - streamStartedAt > 8000
          && !hlsStreamFailed
        ) {
          const hlsUrl = frameData?.preview?.hlsUrl
            || (frameData?.preview?.mode === 'hls' ? frameData.preview.url : null)
            || (frameData?.camera?.hlsUrl ? resolveStreamUrl(frameData.camera.hlsUrl) : null);
          if (hlsUrl) {
            usingWhepStream = false;
            stopWhep();
            const canvas = document.getElementById('pliveCanvas');
            const overlay = document.getElementById('pliveOverlay');
            initHlsStream(hlsUrl, host, canvas, overlay, () => {});
          }
        }

        if (!usingWhepStream && !usingHlsStream && !streamConnectInFlight) {
          let preview = frameData?.preview;
          if (!preview?.url || preview.simulated) {
            try {
              const res = await fetch(sessionUrl(`/api/cameras/${encodeURIComponent(selectedCameraId)}/live?sync=1`));
              if (res.ok) {
                const data = await res.json();
                if (data.preview && !data.preview.simulated) {
                  preview = data.preview;
                  frameData = { ...(frameData || {}), preview: data.preview, camera: data.camera };
                }
              }
            } catch {
              /* retry */
            }
          }
          if (preview?.url && !preview.simulated) {
            const canvas = document.getElementById('pliveCanvas');
            const overlay = document.getElementById('pliveOverlay');
            beginStreamPlayback(preview, host, canvas, overlay, { preview, camera: frameData?.camera });
          }
        }

        streamWatchdogTimer = setTimeout(tick, 600);
      };
      tick();
    }

    function resolveStreamUrl(url) {
      if (!url) return url;
      if (url.startsWith('/')) return sessionUrl(url);
      return window.WhepPlayer?.resolveLocalUrl(url) || url;
    }

    function stopStreamConnectLoop() {
      if (streamConnectLoopTimer) clearTimeout(streamConnectLoopTimer);
      streamConnectLoopTimer = null;
      streamConnectLoopStartedAt = 0;
      streamConnectInFlight = false;
    }

    function startStreamConnectLoop(livePayload, { fastWindowMs = 2000 } = {}) {
      stopStreamConnectLoop();
      streamConnectLoopStartedAt = Date.now();

      const tick = async () => {
        if (!selectedCameraId) return;
        if (streamFirstFrameReceived || isMediaActuallyReady()) {
          syncStreamLoadingUi();
          stopStreamConnectLoop();
          return;
        }
        if (usingWhepStream || usingHlsStream) {
          streamConnectLoopTimer = setTimeout(tick, 500);
          return;
        }

        ensureStreamLoadingOverlay('Stream starting soon');

        const host = document.getElementById('pliveStreamHost');
        let preview = livePayload?.preview || frameData?.preview;
        const canvas = document.getElementById('pliveCanvas');
        const overlay = document.getElementById('pliveOverlay');
        if (!host) {
          streamConnectLoopTimer = setTimeout(tick, 300);
          return;
        }

        if (!preview?.url || preview.simulated) {
          try {
            const res = await fetch(sessionUrl(`/api/cameras/${encodeURIComponent(selectedCameraId)}/live?sync=1`));
            if (res.ok) {
              const data = await res.json();
              if (data.preview && !data.preview.simulated) {
                preview = data.preview;
                livePayload = { preview: data.preview, camera: data.camera };
                frameData = { ...(frameData || {}), preview: data.preview, camera: data.camera };
              }
            }
          } catch {
            /* retry */
          }
        }

        if (!preview?.url || preview.simulated) {
          streamConnectLoopTimer = setTimeout(tick, 400);
          return;
        }

        streamConnectInFlight = true;
        try {
          beginStreamPlayback(preview, host, canvas, overlay, livePayload);
        } finally {
          streamConnectInFlight = false;
        }

        const elapsed = Date.now() - streamConnectLoopStartedAt;
        const nextDelay = elapsed < fastWindowMs ? 400 : 1000;
        streamConnectLoopTimer = setTimeout(tick, nextDelay);
      };

      tick();
    }

    function beginStreamPlayback(preview, host, canvas, overlay, livePayload) {
      const onGiveUp = () => {
        if (streamFirstFrameReceived || isMediaActuallyReady()) return;
        ensureStreamLoadingOverlay('Stream starting soon');
        window.CameraStreamLog?.report({
          source: 'person-live',
          step: 'playback',
          level: 'warn',
          cameraId: selectedCameraId,
          cameraName: livePayload?.camera?.name,
          message: 'WHEP and HLS could not show first frame yet',
          why: 'Browser still waiting — connect loop will keep retrying',
          mode: preview?.mode,
          url: preview?.url || preview?.hlsUrl,
          hint: 'If this keeps happening: board MediaMTX down, wrong BOARD_IP, or camera RTSP blocked',
        });
      };

      const hlsUrl = preview.hlsUrl || (preview.mode === 'hls' ? preview.url : null);
      const tryHls = () => {
        if (!hlsUrl || hlsStreamFailed) {
          onGiveUp();
          return;
        }
        window.CameraStreamLog?.report({
          source: 'person-live',
          step: 'playback-hls',
          cameraId: selectedCameraId,
          message: 'Trying HLS playback',
          url: hlsUrl,
        });
        if (canvas) canvas.style.display = 'none';
        if (overlay) overlay.style.display = 'block';
        initHlsStream(hlsUrl, host, canvas, overlay, onGiveUp);
      };

      // When detection is running, ALWAYS use the buffered HLS stream (not WHEP)
      // so the video and bbox share the same intentional delay — this is the
      // only way to get frame-perfect visual sync given ~0.5-1s board inference time.
      const preferDelayedStream = Boolean(inferenceRunning && hlsUrl);
      if (preferDelayedStream) {
        tryHls();
        return;
      }

      // Otherwise: WHEP first — lowest latency (~300ms). HLS only as fallback.
      if (preview.mode === 'whep' && preview.url && !preview.simulated && window.WhepPlayer) {
        window.CameraStreamLog?.report({
          source: 'person-live',
          step: 'playback-whep',
          cameraId: selectedCameraId,
          message: 'Trying WHEP (WebRTC) playback',
          url: preview.url,
        });
        tryWhepPlayback(preview, host, canvas, overlay, livePayload, tryHls);
        return;
      }

      if (hlsUrl && !hlsStreamFailed) {
        tryHls();
        return;
      }

      onGiveUp();
    }

    function attachStreamReadyHandlers(video) {
      const onReady = () => {
        if (streamFirstFrameReceived) return;
        if (!video.videoWidth || !video.videoHeight) return;
        streamDelayMs = Date.now() - streamStartedAt;
        streamFirstFrameReceived = true;
        window.CameraStreamLog?.report({
          source: 'person-live',
          step: 'first-frame',
          cameraId: selectedCameraId,
          message: `First video frame received (${video.videoWidth}x${video.videoHeight}) in ${streamDelayMs}ms`,
          mode: usingWhepStream ? 'whep' : usingHlsStream ? 'hls' : null,
        });
        const canvas = document.getElementById('pliveCanvas');
        if (canvas) canvas.style.display = 'none';
        drawBoxesOverlay();
        syncZoneDrawUi();
        hideStreamLoadingOverlay();
        if (pendingWsUrl) {
          connectDetectionWs(pendingWsUrl);
          pendingWsUrl = null;
        } else if (frameData?.wsUrl && inferenceRunning) {
          connectDetectionWs(frameData.wsUrl);
        }
        notifyStreamStateChange();
        video.classList.remove('is-preparing');
        video.classList.add('is-ready');
        startStreamHealthMonitor(video);
        stopStreamConnectLoop();
        stopStreamWatchdog();
      };

      video.addEventListener('loadeddata', onReady);
      video.addEventListener('playing', onReady);
      video.addEventListener('wheptrack', onReady);
      video.addEventListener('resize', onReady);

      const poll = () => {
        if (streamFirstFrameReceived) return;
        if (video.videoWidth > 0 && video.videoHeight > 0) {
          onReady();
          return;
        }
        if (Date.now() - streamStartedAt < 12000) {
          setTimeout(poll, 120);
        }
      };
      setTimeout(poll, 120);
    }

    function tryWhepPlayback(preview, host, canvas, overlay, livePayload, onGiveUp) {
      if (preview.mode !== 'whep' || !preview.url || preview.simulated || !window.WhepPlayer) {
        onGiveUp();
        return;
      }
      if (canvas) canvas.style.display = 'none';
      if (overlay) overlay.style.display = 'block';
      host.querySelectorAll('.ov-plive-media').forEach((el) => el.remove());

      const video = document.createElement('video');
      video.className = 'ov-plive-media is-preparing';
      video.autoplay = true;
      video.muted = true;
      video.playsInline = true;
      video.controls = false;
      host.insertBefore(video, host.firstChild);

      streamStartedAt = Date.now();
      attachStreamReadyHandlers(video);

      const whepUrl = window.WhepPlayer.resolveLocalUrl(preview.url);
      window.WhepPlayer.connectWhep(whepUrl, video)
        .then((player) => {
          whepPlayer = { ...player, video };
          usingWhepStream = true;
          usingHlsStream = false;
          syncPipelineDelayMs = WHEP_PIPELINE_MS;
          syncOffsetEma = 0;
          streamInitialized = true;
          streamLocked = true;
          markStreamConnected();
          watchWhepConnection(whepPlayer, preview, host, canvas, overlay, () => {
            usingWhepStream = false;
            stopWhep();
            onGiveUp();
          });
          startOverlayLoop();
          if (video.videoWidth > 0) {
            video.dispatchEvent(new Event('playing'));
          }
        })
        .catch((err) => {
          usingWhepStream = false;
          stopWhep();
          window.CameraStreamLog?.report({
            source: 'person-live',
            step: 'playback-whep',
            level: 'warn',
            cameraId: selectedCameraId,
            message: 'WHEP connect failed — trying HLS fallback',
            why: err?.message || 'WebRTC/WHEP negotiation failed',
            url: whepUrl,
            hint: 'Check MediaMTX port 8889 and BOARD_IP from the browser machine',
          });
          const hlsUrl = preview.hlsUrl
            || (preview.mode === 'hls' ? preview.url : null)
            || (frameData?.camera?.hlsUrl ? resolveStreamUrl(frameData.camera.hlsUrl) : null);
          if (hlsUrl && !hlsStreamFailed) {
            initHlsStream(hlsUrl, host, canvas, overlay, onGiveUp);
            return;
          }
          onGiveUp();
        });
    }

    function isMediaActuallyReady() {
      const host = document.getElementById('pliveStreamHost');
      if (!host) return false;
      const video = host.querySelector('video.ov-plive-media');
      if (video) {
        return Boolean(video.videoWidth && video.videoHeight && video.readyState >= 2);
      }
      const img = host.querySelector('img.ov-plive-media');
      if (img) return Boolean(img.complete && img.naturalWidth);
      return false;
    }

    function syncStreamLoadingUi(message) {
      if (!selectedCameraId || !streamActive) return;
      if (streamFirstFrameReceived || isMediaActuallyReady()) {
        hideStreamLoadingOverlay();
        return;
      }
      ensureStreamLoadingOverlay(message || 'Connecting to stream…');
    }

    function scheduleStreamConnectTimeout(cameraId) {
      if (streamConnectTimeout) clearTimeout(streamConnectTimeout);
      streamConnectTimeout = setTimeout(() => {
        const meta = document.getElementById('pliveStreamMeta');
        if (meta && !usingWhepStream && !usingHlsStream) {
          meta.innerHTML = `Taking longer than expected… <button type="button" class="ov-plive-retry-btn" data-retry-camera="${esc(cameraId)}" style="text-decoration:underline;background:none;border:none;color:inherit;cursor:pointer;padding:0;font:inherit;">Retry</button>`;
          meta.querySelector('.ov-plive-retry-btn')?.addEventListener('click', () => {
            selectCamera(cameraId);
          });
        }
      }, STREAM_TIMEOUT_MS);
    }

    async function fetchLiveWithTimeout(cameraId) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), STREAM_TIMEOUT_MS);
      try {
        const res = await fetch(sessionUrl(`/api/cameras/${encodeURIComponent(cameraId)}/live`), {
          signal: controller.signal,
        });
        clearTimeout(timer);
        return res.ok ? res.json() : null;
      } catch {
        clearTimeout(timer);
        return null;
      }
    }

    function renderWorkbench() {
      if (!selectedCameraId || !payload) return renderEmptyState();

      const cam = frameData?.camera || payload.assignedCameras?.find((c) => c.id === selectedCameraId)
        || { name: 'Camera', status: 'online' };
      const state = payload.state || {};
      const m = frameData?.metrics || payload.peopleMetrics || {};
      const pct = Math.round((state.confidence ?? 0.7) * 100);
      const filterOn = Boolean(state.features?.filterSmallObjects);
      const tooManyOn = Boolean(state.alerts?.['too-many-people']);
      const streamMode = frameData?.streamMode || state.streamMode || 'preview';
      const backendConnected = Boolean(frameData?.backendConnected);
      const running = inferenceRunning || state.inferenceRunning;

      const modeLabel = running
        ? backendConnected
          ? (frameData?.workerSource === 'npu' ? 'Live AI (NPU)' : frameData?.workerSource === 'local-cpu' ? 'Live AI (CPU)' : 'Live AI')
          : 'Worker offline'
        : 'Preview';

      return `
        <article class="ov-card ov-plive-workbench" id="personWorkbench">
          <div class="ov-plive-inner">
            <div class="ov-plive-head">
              <div>
                <div class="ov-stat-headline ov-plive-title">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"/><rect x="2" y="6" width="14" height="12" rx="2"/></svg>
                  <span>${esc(cam.name)}</span>
                </div>
                <p class="ov-plive-sub">${esc(cam.location || 'No location')} · ${esc(cam.resolution || '—')}</p>
              </div>
              <div class="ov-plive-head-actions">
                <span class="ov-badge ${cam.status === 'online' ? 'ov-badge-success' : 'ov-badge-error'}">${cam.status === 'online' ? 'Online' : 'Offline'}</span>
                <span class="ov-badge ov-badge-gold" id="pliveModeBadge">${modeLabel}</span>
                <button type="button" class="ov-quick-btn ${running ? 'ov-det-stop-btn' : ''}" id="pliveInferenceBtn">
                  ${running ? 'Stop detection' : 'Start detection'}
                </button>
              </div>
            </div>

            <div class="ov-plive-stats" id="pliveStats">
              <div class="ov-plive-stat"><span class="ov-plive-stat-val" data-m="current">${m.current ?? 0}</span><span class="ov-plive-stat-lbl">People</span></div>
              <div class="ov-plive-stat"><span class="ov-plive-stat-val" data-m="peak">${m.peakToday ?? 0}</span><span class="ov-plive-stat-lbl">Peak</span></div>
              <div class="ov-plive-stat"><span class="ov-plive-stat-val" data-m="fps">${m.fps != null ? Number(m.fps).toFixed(1) : '—'}</span><span class="ov-plive-stat-lbl">FPS</span></div>
              <div class="ov-plive-stat"><span class="ov-plive-stat-val" data-m="inf">${m.inferenceMs != null ? Math.round(m.inferenceMs) + 'ms' : '—'}</span><span class="ov-plive-stat-lbl">Inference</span></div>
              <div class="ov-plive-stat"><span class="ov-plive-stat-val ov-plive-stat-sm" data-m="presence">${m.presenceActive ? 'Active' : 'None'}</span><span class="ov-plive-stat-lbl">Presence</span></div>
            </div>

            <div class="ov-plive-toolbar">
              <div class="ov-plive-toolbar-row">
                <span class="ov-plive-toolbar-label">Features</span>
                <div class="ov-plive-chips">${renderFeatureChips()}</div>
              </div>
              <div class="ov-plive-toolbar-row ov-plive-conf-row">
                <span class="ov-plive-toolbar-label">Confidence</span>
                <input type="range" class="ov-det-range ov-plive-conf-range" id="pliveConfRange" min="25" max="95" step="1" value="${pct}" aria-label="Minimum confidence">
                <span class="ov-det-slider-val" id="pliveConfVal">${pct}%</span>
                <span class="ov-plive-conf-hint" id="pliveConfHint">${confidenceHint(pct)}</span>
              </div>
              <div class="ov-plive-toolbar-row ${filterOn ? '' : 'is-hidden'}" id="pliveMinSizeRow">
                <span class="ov-plive-toolbar-label">Min size</span>
                <input type="range" class="ov-det-range" id="pliveMinSizeRange" min="16" max="160" step="4" value="${state.minObjectSizePx ?? 48}">
                <span class="ov-det-slider-val" id="pliveMinSizeVal">${state.minObjectSizePx ?? 48}px</span>
              </div>
              <div class="ov-plive-toolbar-row">
                <span class="ov-plive-toolbar-label">Alerts</span>
                <div class="ov-plive-alert-chips">${renderAlertChips()}</div>
              </div>
              <div class="ov-plive-toolbar-row ${tooManyOn ? '' : 'is-hidden'}" id="pliveMaxPeopleRow">
                <span class="ov-plive-toolbar-label">Max people</span>
                <input type="number" class="ov-det-input ov-det-max-people-input" id="pliveMaxPeople" min="1" max="99" value="${state.maxPeopleAlert ?? 10}">
              </div>
              ${renderZoneToolbar()}
            </div>

            <div class="ov-plive-stream-wrap">
              <div class="ov-plive-stream ${zoneDrawMode ? 'is-zone-drawing' : ''}" id="pliveStreamHost">
                <canvas class="ov-plive-canvas" id="pliveCanvas" aria-label="Live camera stream"></canvas>
                <canvas class="ov-plive-overlay" id="pliveOverlay" aria-hidden="true"></canvas>
                <div class="ov-plive-stream-badge" id="pliveStreamBadge">${running ? 'DETECTING' : (streamActive ? 'LIVE PREVIEW' : 'STREAM OFF')}</div>
                <div class="ov-plive-stream-meta" id="pliveStreamMeta"></div>
                <div class="ov-plive-zone-draw-banner" id="pliveZoneBanner" ${zoneDrawMode ? '' : 'hidden'}>Click to place zone corners · Done to save</div>
              </div>
            </div>

            <p class="ov-plive-backend-note" id="pliveBackendNote"></p>
          </div>
          <div class="ov-merged-accent" aria-hidden="true"></div>
        </article>`;
    }

    function mount(skipStreamInit) {
      const root = getRoot();
      if (!root) return;

      let savedMediaStream = null;
      if (skipStreamInit && streamInitialized) {
        const oldVideo = root.querySelector('video.ov-plive-media');
        if (oldVideo?.srcObject) {
          savedMediaStream = oldVideo.srcObject;
          savedWhepPc = whepPlayer?.pc || null;
          whepPlayer = null;
        } else if (usingHlsStream && hlsPlayer) {
          savedHlsPlayer = hlsPlayer;
          hlsPlayer = null;
        }
      }

      root.hidden = false;
      root.innerHTML = renderWorkbench();
      wireControls();
      currentConfidence = payload?.state?.confidence ?? currentConfidence;
      const confRange = document.getElementById('pliveConfRange');
      if (confRange) confRange.value = Math.round(currentConfidence * 100);

      if (skipStreamInit && streamInitialized && (savedMediaStream || savedHlsPlayer)) {
        reattachStream(savedMediaStream, savedWhepPc);
      } else if (!skipStreamInit || !streamInitialized) {
        initStreamDisplay();
      }
      startPolling();
    }

    function reattachStream(mediaStream, pc) {
      const host = document.getElementById('pliveStreamHost');
      const canvas = document.getElementById('pliveCanvas');
      const overlay = document.getElementById('pliveOverlay');
      if (!host) {
        initStreamDisplay();
        return;
      }

      stopSimAnim();
      if (canvas) canvas.style.display = 'none';
      if (overlay) overlay.style.display = 'block';
      host.querySelectorAll('.ov-plive-media').forEach((el) => el.remove());

      const video = document.createElement('video');
      video.className = 'ov-plive-media';
      video.autoplay = true;
      video.muted = true;
      video.playsInline = true;
      host.insertBefore(video, host.firstChild);

      if (mediaStream) {
        video.srcObject = mediaStream;
        video.play().catch(() => {});
        if (pc) {
          whepPlayer = {
            pc,
            video,
            close() {
              try { pc.close(); } catch { /* ignore */ }
              video.srcObject = null;
            },
          };
          usingWhepStream = true;
        }
      } else if (savedHlsPlayer) {
        hlsPlayer = savedHlsPlayer;
        savedHlsPlayer = null;
        hlsPlayer.attachMedia(video);
        usingHlsStream = true;
        video.play().catch(() => {});
      } else if (frameData?.preview) {
        initStreamWithPreview({ preview: frameData.preview, camera: frameData.camera });
        return;
      } else {
        initStreamDisplay();
        return;
      }

      const meta = document.getElementById('pliveStreamMeta');
      if (meta && frameData?.preview?.label) meta.textContent = frameData.preview.label;
      video.addEventListener('loadeddata', drawBoxesOverlay);
      // Keep overlay until real frames are available.
      syncStreamLoadingUi('Reconnecting…');
      video.addEventListener('loadeddata', () => {
        streamFirstFrameReceived = true;
        syncStreamLoadingUi();
        syncZoneDrawUi();
        video.classList.remove('is-preparing');
        video.classList.add('is-ready');
      }, { once: true });
      startOverlayLoop();
      drawBoxesOverlay();
    }

    function updateStatsOnly() {
      if (!frameData?.metrics) return;
      const m = frameData.metrics;
      const map = {
        current: m.current ?? 0,
        peak: m.peakToday ?? 0,
        fps: m.fps != null ? Number(m.fps).toFixed(1) : '—',
        inf: m.inferenceMs != null ? `${Math.round(m.inferenceMs)}ms` : '—',
        presence: m.presenceActive ? 'Active' : 'None',
      };
      Object.entries(map).forEach(([key, val]) => {
        const el = document.querySelector(`[data-m="${key}"]`);
        if (el) el.textContent = val;
      });
    }

    function collectFeatures() {
      const features = { ...(payload?.state?.features || {}), detectPeople: true };
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

    function scheduleConfigSave(patch) {
      clearTimeout(configSaveTimer);
      configSaveTimer = setTimeout(() => saveConfig(patch), 500);
    }

    function stopWhep() {
      if (whepPlayer) {
        whepPlayer.close();
        whepPlayer = null;
      }
      usingWhepStream = false;
      savedWhepPc = null;
      stopStreamHealthMonitor();
    }

    function clearDetectionQueue() {
      detectionQueue = [];
      if (detectionDelayTimer) {
        clearTimeout(detectionDelayTimer);
        detectionDelayTimer = null;
      }
    }

    function getDetectionDelay() {
      if (usingWhepStream) return WHEP_DETECTION_DELAY_MS;
      if (usingHlsStream) return HLS_DETECTION_DELAY_MS;
      return 0;
    }

    let lastInferenceMs = 500;

    function applyDetections(detections, ts) {
      if (ts < lastFrameTs) return;
      lastFrameTs = ts;
      frameData = {
        ...(frameData || {}),
        detections,
        metrics: {
          ...(frameData?.metrics || {}),
          current: detections.length,
          presenceActive: detections.length > 0,
        },
      };
      drawBoxesOverlay();
      updateStatsOnly();
    }

    function enqueueDetection(detections, ts) {
      const delay = getDetectionDelay();
      if (delay <= 0) {
        applyDetections(detections, ts);
        return;
      }
      detectionQueue.push({ detections, ts, applyAt: Date.now() + delay });
      scheduleDetectionFlush();
    }

    function scheduleDetectionFlush() {
      if (detectionDelayTimer) return;
      detectionDelayTimer = setTimeout(flushDetectionQueue, 50);
    }

    function flushDetectionQueue() {
      detectionDelayTimer = null;
      const now = Date.now();
      const ready = detectionQueue.filter((item) => item.applyAt <= now);
      detectionQueue = detectionQueue.filter((item) => item.applyAt > now);
      if (ready.length) {
        const latest = ready[ready.length - 1];
        applyDetections(latest.detections, latest.ts);
      }
      if (detectionQueue.length) scheduleDetectionFlush();
    }

    function stopHls() {
      if (hlsPlayer) {
        hlsPlayer.destroy();
        hlsPlayer = null;
      }
      savedHlsPlayer = null;
      usingHlsStream = false;
      stopStreamHealthMonitor();
    }

    function disconnectDetectionWs() {
      if (detWs) {
        detWs.close();
        detWs = null;
      }
      clearDetectionQueue();
      resetSyncEngine();
      exitSyncedInferenceMode();
    }

    function connectDetectionWs(wsUrl) {
      if (!wsUrl || detWs) return;

      const connectNow = () => {
        if (detWs) return;
        try {
          detWs = new WebSocket(wsUrl);
          detWs.onmessage = (ev) => {
            try {
              const data = JSON.parse(ev.data);
              if (!data || data.error || data.connected) return;
              if (Array.isArray(data.detections)) {
                if (inferenceStarting) {
                  setInferenceStarting(false);
                  updateInferenceUi(frameData || {});
                }
                const captureTs = data.capture_ts || data.ts || Date.now();
                if (data.inference_ms) WHEP_DETECTION_DELAY_MS = Math.round(WHEP_DETECTION_DELAY_MS * 0.7 + data.inference_ms * 0.3);
                const confThreshold = currentConfidence ?? payload?.state?.confidence ?? 0.32;
                const filtered = data.detections.filter((d) => (d.score ?? 0) >= confThreshold);
                enqueueDetection(filtered, captureTs);
                frameData = {
                  ...(frameData || {}),
                  metrics: {
                    ...(frameData?.metrics || {}),
                    fps: data.fps ?? frameData?.metrics?.fps,
                    inferenceMs: data.inference_ms ?? frameData?.metrics?.inferenceMs,
                    peakToday: frameData?.metrics?.peakToday,
                  },
                };
                updateStatsOnly();
              }
            } catch {
              /* ignore malformed ws payload */
            }
          };
          detWs.onclose = () => {
            detWs = null;
          };
        } catch {
          /* ws unavailable */
        }
      };

      if (usingWhepStream || usingHlsStream) {
        const host = document.getElementById('pliveStreamHost');
        const video = host?.querySelector('video.ov-plive-media');
        // Don't block WS connection on videoWidth/videoHeight.
        // Some WHEP/WebRTC streams can play while videoWidth stays 0, which would
        // prevent detections from ever connecting → no boxes on live stream.
        if (video && (video.readyState < 2)) {
          const waitForVideo = () => {
            // If we have enough playback state, start detections even if intrinsic
            // size isn't reported yet.
            if (video.readyState >= 2 || !video.paused) connectNow();
          };
          video.addEventListener('loadeddata', waitForVideo, { once: true });
          video.addEventListener('playing', waitForVideo, { once: true });
          video.addEventListener('wheptrack', waitForVideo, { once: true });
          // Safety net: connect anyway after a short delay.
          setTimeout(connectNow, 1200);
          return;
        }
      }

      connectNow();
    }

    async function saveConfig(patch) {
      if (!selectedCameraId) return;
      try {
        const res = await fetch(sessionUrl(`/api/detection/person/live/${encodeURIComponent(selectedCameraId)}/config`), {
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

    function syncToolbarUi() {
      const filterOn = Boolean(document.querySelector('[data-feature-id="filterSmallObjects"]')?.checked);
      document.getElementById('pliveMinSizeRow')?.classList.toggle('is-hidden', !filterOn);
      const tooManyOn = Boolean(document.querySelector('[data-alert-id="too-many-people"]')?.checked);
      document.getElementById('pliveMaxPeopleRow')?.classList.toggle('is-hidden', !tooManyOn);
    }

    function wireControls() {
      document.getElementById('pliveInferenceBtn')?.addEventListener('click', toggleInference);

      document.querySelectorAll('[data-feature-id]').forEach((el) => {
        el.addEventListener('change', () => {
          syncToolbarUi();
          saveConfig({ features: collectFeatures() });
        });
      });

      document.querySelectorAll('[data-alert-id]').forEach((el) => {
        el.addEventListener('change', () => {
          syncToolbarUi();
          saveConfig({ alerts: collectAlerts() });
        });
      });

      const confRange = document.getElementById('pliveConfRange');
      if (confRange) {
        confRange.addEventListener('input', () => {
          const pct = Number(confRange.value);
          currentConfidence = pct / 100;
          const val = document.getElementById('pliveConfVal');
          const hint = document.getElementById('pliveConfHint');
          if (val) val.textContent = `${pct}%`;
          if (hint) hint.textContent = confidenceHint(pct);
          drawBoxesOverlay();
        });
        confRange.addEventListener('change', () => {
          const newConf = Number(confRange.value) / 100;
          currentConfidence = newConf;
          if (payload?.state) payload.state.confidence = newConf;
          scheduleConfigSave({ confidence: newConf });
          drawBoxesOverlay();
        });
      }

      const minRange = document.getElementById('pliveMinSizeRange');
      if (minRange) {
        minRange.addEventListener('input', () => {
          const val = document.getElementById('pliveMinSizeVal');
          if (val) val.textContent = `${minRange.value}px`;
        });
        minRange.addEventListener('change', () => {
          scheduleConfigSave({ minObjectSizePx: Number(minRange.value) });
        });
      }

      document.getElementById('pliveMaxPeople')?.addEventListener('change', (e) => {
        scheduleConfigSave({ maxPeopleAlert: Number(e.target.value) });
      });

      wireZoneControls();
      syncZoneDrawUi();
      syncToolbarUi();
    }

    function setZoneHint(text) {
      const hint = document.getElementById('pliveZoneHint');
      if (hint) hint.textContent = text;
    }

    /** Live preview or detection is showing — zone Draw must stay clickable. */
    function isLiveViewReady() {
      if (streamActive || inferenceRunning || usingWhepStream || usingHlsStream || streamFirstFrameReceived) {
        return true;
      }
      const host = document.getElementById('pliveStreamHost');
      return Boolean(host?.querySelector('video.ov-plive-media, img.ov-plive-media'));
    }

    function syncZoneDrawUi() {
      const host = document.getElementById('pliveStreamHost');
      const overlay = document.getElementById('pliveOverlay');
      const banner = document.getElementById('pliveZoneBanner');
      const drawBtn = document.getElementById('pliveZoneDrawBtn');
      const undoBtn = document.getElementById('pliveZoneUndoBtn');
      const doneBtn = document.getElementById('pliveZoneDoneBtn');
      const clearBtn = document.getElementById('pliveZoneClearBtn');
      const canDraw = Boolean(selectedCameraId) && isLiveViewReady();
      if (!canDraw && zoneDrawMode) {
        zoneDrawMode = false;
        draftZonePoints = [];
      }
      host?.classList.toggle('is-zone-drawing', zoneDrawMode && canDraw);
      if (overlay) {
        overlay.style.pointerEvents = zoneDrawMode && canDraw ? 'auto' : 'none';
        overlay.style.cursor = zoneDrawMode && canDraw ? 'crosshair' : '';
      }
      if (banner) banner.hidden = !(zoneDrawMode && canDraw);
      // Draw must stay clickable whenever a camera is selected (click handler validates live view).
      if (drawBtn) {
        drawBtn.disabled = !selectedCameraId;
        drawBtn.removeAttribute('aria-disabled');
        drawBtn.textContent = zoneDrawMode ? 'Cancel' : 'Draw';
      }
      if (undoBtn) undoBtn.disabled = !draftZonePoints.length;
      if (doneBtn) doneBtn.disabled = draftZonePoints.length < 3;
      const hasSaved = getCameraZones().some((z) => Array.isArray(z.points) && z.points.length >= 3);
      if (clearBtn) clearBtn.disabled = !hasSaved && !draftZonePoints.length;
      if (!selectedCameraId) {
        setZoneHint('Select a camera first.');
        clearLiveOverlay();
        return;
      }
      if (!canDraw) {
        setZoneHint('Start the stream to draw or view the danger zone on video.');
        clearLiveOverlay();
        return;
      }
      if (zoneDrawMode) {
        setZoneHint(
          `Click corners on the video (${draftZonePoints.length} point${draftZonePoints.length === 1 ? '' : 's'}). Need 3+, then Done.`,
        );
      } else if (!hasSaved) {
        setZoneHint('Mark a restricted area — anyone who steps inside triggers a Danger Zone event.');
      } else {
        setZoneHint('Danger zone active. Toggle off to pause alerts, or Clear to remove.');
      }
      drawBoxesOverlay();
    }

    function setZoneDrawMode(on) {
      zoneDrawMode = Boolean(on);
      if (!zoneDrawMode) draftZonePoints = [];
      if (zoneDrawMode) {
        // Zone drawing needs the overlay canvas even during synced inference.
        const overlay = document.getElementById('pliveOverlay');
        if (overlay) overlay.style.display = 'block';
      }
      syncZoneDrawUi();
    }

    function refreshZoneListUi() {
      const list = document.getElementById('pliveZoneList');
      if (!list) return;
      const zones = getCameraZones().filter((z) => Array.isArray(z.points) && z.points.length >= 3);
      list.innerHTML = zones.length
        ? zones
            .map(
              (z) => `
          <div class="ov-plive-zone-item" data-zone-id="${esc(z.id)}">
            <label class="ov-plive-zone-toggle" title="Enable danger alerts for this zone">
              <input type="checkbox" data-zone-enabled="${esc(z.id)}" ${z.enabled !== false ? 'checked' : ''}>
              <span class="ov-plive-zone-swatch" aria-hidden="true"></span>
              <span class="ov-plive-zone-name">${esc(z.name || 'Danger zone')}</span>
            </label>
            <button type="button" class="ov-plive-zone-del" data-zone-delete="${esc(z.id)}" title="Remove zone" aria-label="Remove zone">×</button>
          </div>`
            )
            .join('')
        : '<p class="ov-plive-zone-empty">No danger zone yet — click Draw, then tap corners on the video.</p>';
      wireZoneListHandlers();
      syncZoneDrawUi();
    }

    async function persistZones(nextZones) {
      if (!selectedCameraId) return;
      try {
        const res = await fetch(sessionUrl(`/api/detection/person/live/${encodeURIComponent(selectedCameraId)}/config`), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ zones: nextZones }),
        });
        if (!res.ok) throw new Error();
        const data = await res.json();
        if (data.payload) payload = data.payload;
        refreshZoneListUi();
      } catch {
        showToast('Could not save danger zone');
      }
    }

    function mergeZonesForCamera(cameraZones) {
      const others = (payload?.state?.zones || []).filter(
        (z) => z.cameraId && selectedCameraId && z.cameraId !== selectedCameraId,
      );
      return [...others, ...cameraZones];
    }

    function finishDraftZone() {
      if (draftZonePoints.length < 3 || !selectedCameraId) {
        showToast('Add at least 3 points to close the zone');
        return;
      }
      const existing = getCameraZones().filter((z) => Array.isArray(z.points) && z.points.length >= 3);
      const nextCamZones = [
        ...existing,
        {
          id: `zone-${Date.now().toString(36)}`,
          name: existing.length ? `Danger zone ${existing.length + 1}` : 'Danger zone',
          enabled: true,
          cameraId: selectedCameraId,
          points: draftZonePoints.map((p) => [p[0], p[1]]),
        },
      ];
      draftZonePoints = [];
      zoneDrawMode = false;
      persistZones(mergeZonesForCamera(nextCamZones));
      showToast('Danger zone saved');
      // Enable danger zone alert if user drew a zone
      const alertEl = document.querySelector('[data-alert-id="person-restricted-area"]');
      if (alertEl && !alertEl.checked) {
        alertEl.checked = true;
        saveConfig({ alerts: collectAlerts() });
      }
    }

    function clearCameraZones() {
      draftZonePoints = [];
      zoneDrawMode = false;
      const kept = (payload?.state?.zones || []).filter(
        (z) => z.cameraId && selectedCameraId && z.cameraId !== selectedCameraId,
      );
      persistZones(kept);
      showToast('Danger zone cleared');
    }

    function onZoneOverlayClick(ev) {
      if (!zoneDrawMode) return;
      ev.preventDefault();
      ev.stopPropagation();
      const pt = overlayClickToNorm(ev.clientX, ev.clientY);
      if (!pt) {
        showToast('Click inside the video frame');
        return;
      }
      draftZonePoints.push(pt);
      syncZoneDrawUi();
    }

    function onZoneOverlayDblClick(ev) {
      if (!zoneDrawMode) return;
      ev.preventDefault();
      ev.stopPropagation();
      if (draftZonePoints.length >= 3) finishDraftZone();
    }

    function wireZoneListHandlers() {
      document.querySelectorAll('[data-zone-enabled]').forEach((el) => {
        el.addEventListener('change', () => {
          const id = el.getAttribute('data-zone-enabled');
          const all = (payload?.state?.zones || []).map((z) =>
            z.id === id ? { ...z, enabled: el.checked } : z,
          );
          persistZones(all);
        });
      });
      document.querySelectorAll('[data-zone-delete]').forEach((el) => {
        el.addEventListener('click', () => {
          const id = el.getAttribute('data-zone-delete');
          const all = (payload?.state?.zones || []).filter((z) => z.id !== id);
          persistZones(all);
          showToast('Zone removed');
        });
      });
    }

    function wireZoneControls() {
      document.getElementById('pliveZoneDrawBtn')?.addEventListener('click', () => {
        if (!selectedCameraId) {
          showToast('Select a camera first');
          return;
        }
        if (!isLiveViewReady()) {
          showToast('Start the camera stream first');
          return;
        }
        setZoneDrawMode(!zoneDrawMode);
      });
      document.getElementById('pliveZoneUndoBtn')?.addEventListener('click', () => {
        draftZonePoints.pop();
        syncZoneDrawUi();
      });
      document.getElementById('pliveZoneDoneBtn')?.addEventListener('click', finishDraftZone);
      document.getElementById('pliveZoneClearBtn')?.addEventListener('click', clearCameraZones);
      wireZoneListHandlers();

      const overlay = document.getElementById('pliveOverlay');
      if (overlay) {
        overlay.addEventListener('click', onZoneOverlayClick);
        overlay.addEventListener('dblclick', onZoneOverlayDblClick);
      }
    }

    if (!window.__pliveZoneKeydownBound) {
      window.__pliveZoneKeydownBound = true;
      document.addEventListener('keydown', (ev) => {
        if (document.body.dataset.detectionSlug !== 'person') return;
        if (!zoneDrawMode) return;
        if (ev.key === 'Escape') {
          setZoneDrawMode(false);
        } else if (ev.key === 'Enter' && draftZonePoints.length >= 3) {
          finishDraftZone();
        }
      });
    }

    function drawZonePolygon(ctx, points, video, img, cssW, cssH, opts = {}) {
      if (!points?.length) return;
      const mapped = points
        .map(([nx, ny]) => mapNormPointToOverlay(nx, ny, video, img, cssW, cssH))
        .filter(Boolean);
      if (mapped.length < 1) return;

      ctx.beginPath();
      mapped.forEach((p, i) => {
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      if (opts.closed && mapped.length >= 3) ctx.closePath();

      if (opts.closed && mapped.length >= 3) {
        ctx.fillStyle = opts.fill || 'rgba(220, 38, 38, 0.22)';
        ctx.fill();
      }

      ctx.strokeStyle = opts.stroke || 'rgba(239, 68, 68, 0.95)';
      ctx.lineWidth = opts.lineWidth || 2;
      ctx.setLineDash(opts.dashed ? [6, 5] : []);
      ctx.stroke();
      ctx.setLineDash([]);

      mapped.forEach((p, i) => {
        ctx.beginPath();
        ctx.arc(p.x, p.y, opts.dotRadius || 4.5, 0, Math.PI * 2);
        ctx.fillStyle = opts.dotFill || '#ef4444';
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        if (opts.showIndex) {
          ctx.fillStyle = '#fff';
          ctx.font = '600 10px ui-sans-serif, system-ui, sans-serif';
          ctx.fillText(String(i + 1), p.x + 7, p.y - 7);
        }
      });

      if (opts.label && mapped.length) {
        const p0 = mapped[0];
        ctx.fillStyle = 'rgba(127, 29, 29, 0.88)';
        const label = opts.label;
        ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
        const tw = ctx.measureText(label).width;
        ctx.fillRect(p0.x + 8, p0.y - 22, tw + 10, 18);
        ctx.fillStyle = '#fecaca';
        ctx.fillText(label, p0.x + 13, p0.y - 9);
      }
    }

    function drawZonesOnOverlay(ctx, cssW, cssH, video, img) {
      const zones = getCameraZones().filter((z) => Array.isArray(z.points) && z.points.length >= 3);
      zones.forEach((z) => {
        drawZonePolygon(ctx, z.points, video, img, cssW, cssH, {
          closed: true,
          fill: z.enabled === false ? 'rgba(148, 163, 184, 0.14)' : 'rgba(220, 38, 38, 0.22)',
          stroke: z.enabled === false ? 'rgba(148, 163, 184, 0.7)' : 'rgba(239, 68, 68, 0.95)',
          label: z.enabled === false ? `${z.name || 'Zone'} (off)` : (z.name || 'Danger zone'),
        });
      });
      if (draftZonePoints.length) {
        drawZonePolygon(ctx, draftZonePoints, video, img, cssW, cssH, {
          closed: draftZonePoints.length >= 3,
          dashed: true,
          fill: 'rgba(239, 68, 68, 0.16)',
          stroke: '#f87171',
          showIndex: true,
          label: draftZonePoints.length >= 3 ? 'Close with Done' : 'Drawing…',
        });
      }
    }

    function setInferenceStarting(starting) {
      inferenceStarting = starting;
      ensureLoadingStyle();
      const btn = document.getElementById('pliveInferenceBtn');
      const badge = document.getElementById('pliveStreamBadge');
      const mode = document.getElementById('pliveModeBadge');
      const note = document.getElementById('pliveBackendNote');

      if (btn) {
        btn.disabled = starting;
        if (starting) btn.textContent = 'Starting detection…';
      }
      if (badge) badge.textContent = starting ? 'STARTING' : (inferenceRunning ? 'DETECTING' : 'LIVE PREVIEW');
      if (mode) mode.textContent = starting ? 'Starting…' : mode.textContent;
      if (note) note.textContent = starting ? 'Starting person detection…' : note.textContent;

      const host = document.getElementById('pliveStreamHost');
      let overlay = document.getElementById('pliveStartingOverlay');
      if (starting && host) {
        if (!overlay) {
          overlay = document.createElement('div');
          overlay.id = 'pliveStartingOverlay';
          overlay.className = 'ov-plive-starting-overlay';
          overlay.innerHTML = '<div class="ov-plive-starting-spinner" aria-hidden="true"></div><span>Starting detection…</span>';
          host.appendChild(overlay);
        }
      } else if (overlay) {
        overlay.remove();
      }
    }

    async function toggleInference() {
      if (!selectedCameraId || inferenceStarting) return;
      const start = !inferenceRunning;
      if (start && !isStreamActive()) {
        showToast('Start the camera stream first');
        return;
      }
      const path = start ? 'start' : 'stop';
      if (start) {
        setInferenceStarting(true);
        if (frameData?.wsUrl && frameData?.prewarmed) {
          connectDetectionWs(frameData.wsUrl);
        }
      }
      let resultData = null;
      try {
        const res = await fetch(sessionUrl(`/api/detection/person/live/${encodeURIComponent(selectedCameraId)}/${path}`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
        const data = await res.json();
        resultData = data;
        if (!res.ok || data.ok === false) throw new Error(data.error || data.backendError || 'Could not start detection');
        inferenceRunning = start;
        streamLocked = start;
        if (data.payload) payload = data.payload;
        if (data.backendError && start) showToast(data.backendError);
        else if (!start) showToast('Detection stopped');
        else if (!frameData?.prewarmed) showToast('Person detection started');
        if (start && data.wsUrl) {
          if (streamFirstFrameReceived || (!usingWhepStream && !usingHlsStream)) {
            connectDetectionWs(data.wsUrl);
          } else {
            pendingWsUrl = data.wsUrl;
          }
        } else {
          disconnectDetectionWs();
          setInferenceStarting(false);
        }
        if (!start) {
          exitSyncedInferenceMode();
          streamLocked = false;
        }
        startPolling();
        await pollFrame();
      } catch (err) {
        setInferenceStarting(false);
        showToast(err.message || 'Could not update detection');
      } finally {
        if (!inferenceRunning) setInferenceStarting(false);
        updateInferenceUi(resultData);
      }
    }

    function updateInferenceUi(data) {
      const btn = document.getElementById('pliveInferenceBtn');
      const badge = document.getElementById('pliveStreamBadge');
      const mode = document.getElementById('pliveModeBadge');
      const note = document.getElementById('pliveBackendNote');
      if (inferenceStarting) return;
      if (btn) {
        btn.disabled = false;
        btn.textContent = inferenceRunning ? 'Stop detection' : 'Start detection';
        btn.classList.toggle('ov-det-stop-btn', inferenceRunning);
      }
      if (badge) badge.textContent = inferenceRunning ? 'DETECTING' : (streamActive ? 'LIVE PREVIEW' : 'STREAM OFF');
      if (mode) {
        const npu = data?.workerSource === 'npu';
        const cpu = data?.workerSource === 'local-cpu';
        mode.textContent = inferenceRunning
          ? data?.backendConnected
            ? (npu ? 'Live AI (NPU)' : cpu ? 'Live AI (CPU)' : 'Live AI')
            : 'Worker offline'
          : 'Preview';
      }
      if (note) {
        if (data?.backendError) note.textContent = data.backendError;
        else if (data?.backendConnected) {
          if (data.workerSource === 'npu') {
            note.textContent = 'Khadas NPU person detection active (YOLO26s).';
          } else if (data.workerSource === 'local-cpu') {
            note.textContent = 'CPU dev fallback active. On Khadas use NPU backend only.';
          } else {
            note.textContent = 'Connected to vision API — real-time person inference active.';
          }
        }
        else if (inferenceRunning) note.textContent = 'Vision API not connected — check board is running';
        else note.textContent = '';
      }
      syncZoneDrawUi();
    }

    let overlayAnimTimer = null;

    function startOverlayLoop() {
      if (overlayAnimTimer || vfcActive) return;
      const host = document.getElementById('pliveStreamHost');
      const video = host?.querySelector('video.ov-plive-media');

      // Draw boxes locked to video frames; detections come from WebSocket when live.
      if (video && typeof video.requestVideoFrameCallback === 'function') {
        vfcActive = true;
        const tick = () => {
          if (!vfcActive) return;
          if (usingWhepStream || usingHlsStream) pickSyncDetectionsForNow();
          drawBoxesOverlay();
          try {
            video.requestVideoFrameCallback(tick);
          } catch {
            vfcActive = false;
            startOverlayLoop();
          }
        };
        try {
          video.requestVideoFrameCallback(tick);
        } catch {
          vfcActive = false;
        }
        if (vfcActive) return;
      }

      const tick = () => {
        if (usingWhepStream || usingHlsStream) pickSyncDetectionsForNow();
        drawBoxesOverlay();
        overlayAnimTimer = requestAnimationFrame(tick);
      };
      overlayAnimTimer = requestAnimationFrame(tick);
    }

    function stopOverlayLoop() {
      if (overlayAnimTimer) cancelAnimationFrame(overlayAnimTimer);
      overlayAnimTimer = null;
      vfcActive = false;
    }

    function stopSimAnim() {
      stopOverlayLoop();
      if (simAnimTimer) cancelAnimationFrame(simAnimTimer);
      simAnimTimer = null;
    }

    function startSimAnim() {
      ensureStreamLoadingOverlay('Stream starting soon');
    }

    function drawBoxesOverlay() {
      if (usingSyncedInferenceStream) return;
      const overlay = document.getElementById('pliveOverlay');
      const host = document.getElementById('pliveStreamHost');
      const canvas = document.getElementById('pliveCanvas');
      const video = host?.querySelector('video.ov-plive-media');
      const img = host?.querySelector('img.ov-plive-media');

      if (!overlay || !host) return;

      // Stream off → clean idle screen (no danger zone, no leftover bboxes).
      if (!isLiveViewReady()) {
        clearLiveOverlay();
        return;
      }

      // Important: don't hard-require intrinsic video dimensions (videoWidth/videoHeight).
      // Some browsers (esp. WebRTC/WHEP) can display frames while videoWidth stays 0 briefly.
      // `mapBoxToOverlay()` already has a display-space fallback for this case.
      const hasMediaEl = Boolean(video || img || (canvas && canvas.style.display !== 'none'));
      if (!hasMediaEl) {
        clearLiveOverlay();
        return;
      }

      // Use layout rect (not clientWidth) and render at devicePixelRatio for stable lines.
      const rect = host.getBoundingClientRect?.();
      const cssW = Math.max(2, Math.round(rect?.width || host.clientWidth || video?.clientWidth || img?.clientWidth || 0));
      const cssH = Math.max(2, Math.round(rect?.height || host.clientHeight || video?.clientHeight || img?.clientHeight || 0));
      if (!cssW || !cssH) return;

      const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
      const pxW = Math.round(cssW * dpr);
      const pxH = Math.round(cssH * dpr);

      if (overlayCanvasW !== cssW || overlayCanvasH !== cssH || overlay.width !== pxW || overlay.height !== pxH) {
        overlay.width = pxW;
        overlay.height = pxH;
        overlayCanvasW = cssW;
        overlayCanvasH = cssH;
      }
      const ctx = overlay.getContext('2d');
      if (!ctx) return;
      // Draw in CSS pixels while backing store is scaled.
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);

      drawZonesOnOverlay(ctx, cssW, cssH, video, img);

      // Show boxes based on the UI checkbox (not backend payload state).
      // Backend payload can lag behind UI if PATCH failed or feature flag didn't persist.
      const bboxToggle = document.querySelector('[data-feature-id="boundingBoxes"]');
      const showBoxes = bboxToggle ? Boolean(bboxToggle.checked) : (payload?.state?.features?.boundingBoxes !== false);
      // For smooth live tracking, prefer WS-synced detections when available.
      // Fall back to polled `/frame` detections only when WS isn't feeding.
      const hasSynced = (usingWhepStream || usingHlsStream) && Array.isArray(syncDisplayDetections) && syncDisplayDetections.length;
      const rawDets = hasSynced
        ? syncDisplayDetections
        : (frameData?.detections || []);
      const detsForDraw = rawDets;
      if (!showBoxes || !detsForDraw.length) return;

      const confThreshold = currentConfidence ?? (payload?.state?.confidence ?? 0.32);
      const filteredDets = detsForDraw.filter((d) => (d.score ?? 0) >= confThreshold);
      if (!filteredDets.length) return;

      filteredDets.forEach((det) => {
        const box = det.box || [];
        if (box.length < 4) return;
        const mapped = mapBoxToOverlay(box, video, img, cssW, cssH);
        if (!mapped) return;
        let { x1, y1, x2, y2 } = mapped;
        x1 = Math.max(0, Math.min(x1, cssW - 2));
        y1 = Math.max(0, Math.min(y1, cssH - 2));
        x2 = Math.max(x1 + 2, Math.min(x2, cssW));
        y2 = Math.max(y1 + 2, Math.min(y2, cssH));
        // Requested: green bbox only (no labels).
        // Highlight red if person bbox intersects an enabled danger zone.
        const inDanger = getCameraZones().some(
          (z) =>
            z.enabled !== false
            && Array.isArray(z.points)
            && z.points.length >= 3
            && boxIntersectsZoneClient(box, z.points),
        );
        ctx.strokeStyle = inDanger ? '#ef4444' : '#22c55e';
        ctx.lineWidth = 2;
        ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
      });
    }

    function pointInPolygonClient(x, y, points) {
      if (!Array.isArray(points) || points.length < 3) return false;
      let inside = false;
      for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const xi = points[i][0];
        const yi = points[i][1];
        const xj = points[j][0];
        const yj = points[j][1];
        const denom = (yj - yi) || 1e-12;
        const intersect = ((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / denom + xi);
        if (intersect) inside = !inside;
      }
      return inside;
    }

    function boxIntersectsZoneClient(box, points) {
      if (!Array.isArray(box) || box.length < 4 || !Array.isArray(points) || points.length < 3) return false;
      const bx1 = Math.min(Number(box[0]), Number(box[2]));
      const by1 = Math.min(Number(box[1]), Number(box[3]));
      const bx2 = Math.max(Number(box[0]), Number(box[2]));
      const by2 = Math.max(Number(box[1]), Number(box[3]));
      if (![bx1, by1, bx2, by2].every((v) => Number.isFinite(v))) return false;
      // Same as server: center or upper-torso inside zone (edge-only clips ignored).
      const cx = (bx1 + bx2) / 2;
      const cy = (by1 + by2) / 2;
      if (pointInPolygonClient(cx, cy, points)) return true;
      const torsoY = by1 + (by2 - by1) * 0.35;
      return pointInPolygonClient(cx, torsoY, points);
    }

    function scheduleStreamResync() {
      if (!selectedCameraId || streamResyncAttempts >= 5) return;
      if (streamResyncTimer) return;
      streamResyncTimer = setTimeout(async () => {
        streamResyncTimer = null;
        streamResyncAttempts += 1;
        try {
          const res = await fetch(
            sessionUrl(`/api/detection/person/live/${encodeURIComponent(selectedCameraId)}/resync`),
            { method: 'POST' }
          );
          const data = await res.json();
          if (res.ok && data.preview) {
            hlsStreamFailed = false;
            usingHlsStream = false;
            streamResyncAttempts = 0;
            frameData = { ...(frameData || {}), preview: data.preview, camera: data.camera };
            initStreamWithPreview({ preview: data.preview, camera: data.camera });
            showToast('Stream reconnected');
            return;
          }
        } catch {
          /* retry */
        }
        if (streamResyncAttempts < 5) scheduleStreamResync();
      }, 2000);
    }

    function onHlsStreamFailed(preview) {
      usingHlsStream = false;
      hlsStreamFailed = true;
      stopHls();
      const host = document.getElementById('pliveStreamHost');
      host?.querySelectorAll('.ov-plive-media').forEach((el) => el.remove());
      const canvas = document.getElementById('pliveCanvas');
      const overlay = document.getElementById('pliveOverlay');
      if (canvas) canvas.style.display = 'none';
      if (overlay) overlay.style.display = 'block';
      const meta = document.getElementById('pliveStreamMeta');
      if (meta) {
        meta.textContent = preview?.streamWarning || 'Stream unavailable — reconnecting…';
      }
      if (frameData?.jpeg && inferenceRunning) {
        showJpegFrame(frameData.jpeg);
      } else {
        ensureStreamLoadingOverlay('Stream starting soon');
        if (frameData?.preview) {
          startStreamConnectLoop({ preview: frameData.preview, camera: frameData.camera });
        }
      }
      scheduleStreamResync();
    }

    function scheduleJpegDraw(jpeg) {
      pendingJpeg = jpeg;
      if (jpegDrawScheduled) return;
      jpegDrawScheduled = true;
      requestAnimationFrame(() => {
        jpegDrawScheduled = false;
        if (pendingJpeg) showJpegFrame(pendingJpeg, true);
        pendingJpeg = null;
      });
    }

    function showJpegFrame(jpeg, skipStop) {
      if (!skipStop) stopSimAnim();
      if (!skipStop && !usingSyncedInferenceStream) {
        stopHls();
        stopWhep();
      }
      const host = document.getElementById('pliveStreamHost');
      if (!usingSyncedInferenceStream) {
        host?.querySelectorAll('.ov-plive-media').forEach((el) => el.remove());
      }
      const canvas = document.getElementById('pliveCanvas');
      if (canvas) canvas.style.display = 'block';
      const overlay = document.getElementById('pliveOverlay');
      if (overlay && usingSyncedInferenceStream) overlay.style.display = 'none';
      else if (overlay) overlay.style.display = 'block';
      if (!canvas || !host || !jpeg) return;

      const img = new Image();
      img.onload = () => {
        const w = host.clientWidth || 960;
        const h = Math.round(w * 9 / 16);
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        if (!usingSyncedInferenceStream) {
          const ov = document.getElementById('pliveOverlay');
          if (ov) {
            ov.width = w;
            ov.height = h;
          }
          drawBoxesOverlay();
        }
      };
      img.src = `data:image/jpeg;base64,${jpeg}`;
    }

    function initStreamWithPreview(livePayload) {
      const host = document.getElementById('pliveStreamHost');
      const preview = livePayload?.preview;
      clearStreamLoading();
      if (!host || !preview) {
        initStreamDisplay();
        return;
      }

      stopSimAnim();
      stopHls();
      stopWhep();
      usingHlsStream = false;
      usingWhepStream = false;
      hlsStreamFailed = false;
      streamConnectInFlight = false;
      stopStreamConnectLoop();
      host.querySelectorAll('.ov-plive-media').forEach((el) => el.remove());
      const canvas = document.getElementById('pliveCanvas');
      const overlay = document.getElementById('pliveOverlay');

      const fallbackSim = () => {
        ensureStreamLoadingOverlay('Stream starting soon');
        startStreamConnectLoop(livePayload);
      };

      const hlsUrl = preview.hlsUrl || (preview.mode === 'hls' ? preview.url : null);
      if (hlsUrl && !preview.simulated) {
        ensureStreamLoadingOverlay('Stream starting soon');
        beginStreamPlayback(preview, host, canvas, overlay, livePayload);
        return;
      }

      if (preview.mode === 'whep' && preview.url && !preview.simulated && window.WhepPlayer) {
        ensureStreamLoadingOverlay('Stream starting soon');
        tryWhepPlayback(preview, host, canvas, overlay, livePayload, fallbackSim);
        return;
      }

      if (preview.mode === 'hls' && preview.url && !preview.simulated) {
        ensureStreamLoadingOverlay('Starting live HLS…');
        initHlsStream(preview.url, host, canvas, overlay, fallbackSim);
        return;
      }

      if (preview.mode === 'http' && preview.url && !preview.simulated) {
        if (canvas) canvas.style.display = 'none';
        if (overlay) overlay.style.display = 'block';
        ensureStreamLoadingOverlay('Loading stream…');
        const img = document.createElement('img');
        img.className = 'ov-plive-media is-preparing';
        img.alt = `${livePayload.camera?.name || 'Camera'} live stream`;
        img.src = preview.url;
        img.onload = () => {
          hideStreamLoadingOverlay();
          img.classList.remove('is-preparing');
          img.classList.add('is-ready');
        };
        img.onerror = fallbackSim;
        host.insertBefore(img, host.firstChild);
        return;
      }

      if (preview.mode === 'video' && preview.url && !preview.simulated) {
        if (canvas) canvas.style.display = 'none';
        if (overlay) overlay.style.display = 'block';
        ensureStreamLoadingOverlay('Preparing video…');
        const video = document.createElement('video');
        video.className = 'ov-plive-media is-preparing';
        video.src = preview.url;
        video.autoplay = true;
        video.muted = true;
        video.loop = true;
        video.playsInline = true;
        const onReady = () => {
          hideStreamLoadingOverlay();
          video.classList.remove('is-preparing');
          video.classList.add('is-ready');
        };
        video.addEventListener('loadeddata', onReady, { once: true });
        video.addEventListener('playing', onReady, { once: true });
        video.onerror = fallbackSim;
        host.insertBefore(video, host.firstChild);
        return;
      }

      fallbackSim();
    }

    function initHlsStream(hlsUrl, host, canvas, overlay, fallbackSim) {
      if (canvas) canvas.style.display = 'none';
      if (overlay) overlay.style.display = 'block';
      const video = document.createElement('video');
      video.className = 'ov-plive-media is-preparing';
      video.autoplay = true;
      video.muted = true;
      video.playsInline = true;
      video.controls = false;
      host.insertBefore(video, host.firstChild);

      const meta = document.getElementById('pliveStreamMeta');
      if (meta) meta.textContent = 'Live HLS stream (fallback)';

      const url = resolveStreamUrl(hlsUrl);
      const targetDelaySec = Math.max(0.8, Math.min(2.5, lastInferenceMs / 1000 + 0.2));
      if (window.Hls && window.Hls.isSupported()) {
        hlsPlayer = new window.Hls({
          enableWorker: true,
          lowLatencyMode: true,
          backBufferLength: 0,
          // Buffer target matched to board inference latency so video and bbox stay locked.
          maxBufferLength: targetDelaySec,
          maxMaxBufferLength: targetDelaySec + 1,
          liveSyncDuration: targetDelaySec,
          liveMaxLatencyDuration: targetDelaySec + 2,
          // Industrial pacing: never speed up/slow down playback to chase latency.
          maxLiveSyncPlaybackRate: 1.0,
          startFragPrefetch: true,
        });
        hlsPlayer.loadSource(url);
        hlsPlayer.attachMedia(video);
        hlsPlayer.on(window.Hls.Events.ERROR, (_evt, data) => {
          if (!data?.fatal) return;
          if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) {
            hlsPlayer.startLoad();
            return;
          }
          fallbackSim();
        });
        usingHlsStream = true;
        usingWhepStream = false;
        syncPipelineDelayMs = HLS_PIPELINE_MS;
        syncOffsetEma = 0;
        streamInitialized = true;
        streamLocked = true;
        streamStartedAt = Date.now();
        markStreamConnected();
        startOverlayLoop();
        attachStreamReadyHandlers(video);
        return;
      }
      if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = url;
        video.onerror = fallbackSim;
        usingHlsStream = true;
        usingWhepStream = false;
        syncPipelineDelayMs = HLS_PIPELINE_MS;
        syncOffsetEma = 0;
        streamInitialized = true;
        streamLocked = true;
        streamStartedAt = Date.now();
        markStreamConnected();
        startOverlayLoop();
        attachStreamReadyHandlers(video);
        return;
      }
      fallbackSim();
    }

    function initStreamDisplay() {
      const meta = document.getElementById('pliveStreamMeta');
      const preview = frameData?.preview;
      if (meta && preview?.label) meta.textContent = preview.label;

      // Never show the simulated green screen. Keep the loader until real stream is ready.
      syncStreamLoadingUi('Stream starting soon');
    }

    async function pollFrame() {
      if (!selectedCameraId) return;
      try {
        const res = await fetch(sessionUrl(`/api/detection/person/live/${encodeURIComponent(selectedCameraId)}/frame`));
        if (!res.ok) return;
        frameData = await res.json();
        if (streamLocked || inferenceStarting) {
          inferenceRunning = Boolean(frameData.inferenceRunning);
        }
        if (frameData.payload) {
          payload = frameData.payload;
          if (document.activeElement?.id !== 'pliveConfRange') {
            currentConfidence = payload?.state?.confidence ?? currentConfidence;
          }
        }

        if (usingSyncedInferenceStream) {
          /* synced inference stream renders annotated JPEG on canvas — no WHEP overlay */
        } else if (usingWhepStream || usingHlsStream) {
          // Fallback: if WebSocket sync stream isn't available, still draw boxes from
          // the polled `/frame` payload. This keeps bbox overlay working even when
          // the browser can't reach ws://... (network policies, DNS, etc.).
          if (Array.isArray(frameData?.detections)) {
            syncDisplayDetections = frameData.detections;
            lastStableDetections = frameData.detections;
            lastStableDetectionsAt = Date.now();
          }
          if (!overlayAnimTimer && !vfcActive) startOverlayLoop();
          drawBoxesOverlay();
          if (!streamFirstFrameReceived && !isMediaActuallyReady()) {
            syncStreamLoadingUi('Stream starting soon');
          } else {
            hideStreamLoadingOverlay();
          }
        } else if (streamActive && frameData.preview?.simulated) {
          syncStreamLoadingUi('Stream starting soon');
          if (!streamConnectLoopTimer) {
            startStreamConnectLoop({ preview: frameData.preview, camera: frameData.camera });
          }
        } else if (!streamActive) {
          showStreamIdleState();
          clearLiveOverlay();
        } else {
          drawBoxesOverlay();
        }

        updateStatsOnly();
        updateInferenceUi(frameData);

        if (inferenceRunning && frameData.wsUrl && frameData.workerSource !== 'local-cpu' && !detWs) {
          connectDetectionWs(frameData.wsUrl);
        }
      } catch {
        /* ignore */
      }
    }

    function startPolling() {
      stopPolling();
      pollFrame();
      const ms = inferenceRunning ? (detWs ? 2000 : 1000) : 2500;
      pollTimer = setInterval(pollFrame, ms);
    }

    function stopPolling() {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
    }

    async function startStream(cameraId) {
      const id = cameraId || selectedCameraId;
      if (!id) {
        window.CameraStreamLog?.report({
          source: 'person-live',
          step: 'start-stream',
          level: 'error',
          message: 'startStream called but no camera id',
          why: 'Select a camera first',
        });
        return;
      }
      if (id !== selectedCameraId) {
        await selectCamera(id);
      }
      if (isStreamActive(id) && streamFirstFrameReceived) {
        window.CameraStreamLog?.report({
          source: 'person-live',
          step: 'start-stream',
          cameraId: id,
          message: 'Stream already playing — skip restart',
        });
        return;
      }

      streamActive = true;
      hideStreamIdleState();
      ensureStreamLoadingOverlay('Starting stream…');
      notifyStreamStateChange();
      syncZoneDrawUi();

      const cachedCam = frameData?.camera
        || payload?.assignedCameras?.find((c) => c.id === id)
        || { id };
      let preview = frameData?.preview || buildPreviewFromCamera(cachedCam);

      window.CameraStreamLog?.report({
        source: 'person-live',
        step: 'start-stream',
        cameraId: id,
        cameraName: cachedCam.name,
        message: 'PersonLive.startStream — fetching / building preview',
        mode: preview?.mode || null,
        url: preview?.url || preview?.whepUrl || preview?.hlsUrl || null,
        detail: {
          simulated: Boolean(preview?.simulated),
          hasWhep: Boolean(preview?.whepUrl || (preview?.mode === 'whep' && preview?.url)),
          hasHls: Boolean(preview?.hlsUrl),
          rtspUrl: cachedCam.rtspUrl || null,
        },
      });

      if (!preview?.url || preview.simulated) {
        try {
          const liveData = await fetch(sessionUrl(`/api/cameras/${encodeURIComponent(id)}/live?sync=1`))
            .then((r) => (r.ok ? r.json() : null));
          if (liveData?.preview && !liveData.preview.simulated) {
            preview = liveData.preview;
            frameData = { ...(frameData || {}), preview: liveData.preview, camera: liveData.camera || cachedCam };
            window.CameraStreamLog?.report({
              source: 'person-live',
              step: 'live-sync',
              cameraId: id,
              cameraName: liveData.camera?.name || cachedCam.name,
              message: 'Got real preview from /live?sync=1',
              mode: preview.mode,
              url: preview.url || preview.whepUrl || preview.hlsUrl,
            });
          } else {
            window.CameraStreamLog?.report({
              source: 'person-live',
              step: 'live-sync',
              level: 'warn',
              cameraId: id,
              cameraName: cachedCam.name,
              message: '/live?sync=1 did not return a playable preview yet',
              why: liveData?.preview?.label || 'preview missing or still simulated',
              hint: 'Check BOARD SYNC logs above — vision board / MediaMTX may be offline',
              detail: liveData?.preview || null,
            });
          }
        } catch (err) {
          window.CameraStreamLog?.report({
            source: 'person-live',
            step: 'live-sync',
            level: 'error',
            cameraId: id,
            message: 'Failed to fetch /live?sync=1',
            why: err?.message || 'network error',
          });
        }
      }

      if (preview?.url && !preview.simulated) {
        frameData = { ...(frameData || {}), preview, camera: cachedCam };
        initStreamWithPreview({ preview, camera: cachedCam });
        startStreamConnectLoop({ preview, camera: cachedCam });
        startStreamWatchdog();
      } else {
        window.CameraStreamLog?.report({
          source: 'person-live',
          step: 'start-stream',
          level: 'warn',
          cameraId: id,
          cameraName: cachedCam.name,
          message: 'No playable URL yet — retry loop started',
          why: 'Need WHEP or HLS from board before <video> can play',
          hint: 'Watch terminal for BOARD SYNC / START STREAM — URLs NOT ready',
        });
        startStreamConnectLoop({ preview: null, camera: cachedCam });
        startStreamWatchdog();
      }
      prewarmDetectionWorker(id);
      syncZoneDrawUi();
    }

    async function stopStream(cameraId) {
      if (cameraId && cameraId !== selectedCameraId) return;
      if (inferenceRunning) {
        try {
          await fetch(sessionUrl(`/api/detection/person/live/${encodeURIComponent(selectedCameraId)}/stop`), {
            method: 'POST',
          });
        } catch {
          /* ignore */
        }
        inferenceRunning = false;
        disconnectDetectionWs();
      }
      stopStreamPlayback();
      syncZoneDrawUi();
      updateInferenceUi(frameData || {});
    }

    async function selectCamera(cameraId) {
      if (selectedCameraId === cameraId && !streamActive) {
        document.querySelectorAll('.ov-cam-tile-clickable').forEach((tile) => {
          tile.classList.toggle('is-selected', tile.dataset.id === cameraId);
        });
        return;
      }
      if (selectedCameraId === cameraId && streamActive && streamFirstFrameReceived && isMediaActuallyReady()) {
        return;
      }

      const keepInferenceUi = Boolean(
        inferenceRunning && selectedCameraId === cameraId,
      );

      const myGen = ++selectGeneration;
      if (selectedCameraId && selectedCameraId !== cameraId) {
        stopStreamPlayback();
      } else if (streamActive && !keepInferenceUi) {
        stopStreamPlayback();
      }

      selectedCameraId = cameraId;
      if (!keepInferenceUi) inferenceRunning = false;
      hlsStreamFailed = false;
      streamResyncAttempts = 0;
      streamFirstFrameReceived = false;
      streamInitialized = false;
      streamLocked = false;
      streamActive = false;
      pendingWsUrl = null;
      zoneDrawMode = false;
      draftZonePoints = [];
      resetSyncEngine();
      if (streamResyncTimer) {
        clearTimeout(streamResyncTimer);
        streamResyncTimer = null;
      }

      stopSimAnim();
      stopHls();
      stopWhep();
      if (!keepInferenceUi) disconnectDetectionWs();
      stopOverlayLoop();
      stopStreamConnectLoop();
      stopStreamWatchdog();

      document.querySelectorAll('.ov-cam-tile-clickable').forEach((tile) => {
        tile.classList.toggle('is-selected', tile.dataset.id === cameraId);
      });

      mount(false);
      showStreamIdleState();

      const cachedCam = payload?.assignedCameras?.find((c) => c.id === cameraId)
        || { id: cameraId };
      const optimisticPreview = buildPreviewFromCamera(cachedCam);
      if (optimisticPreview) {
        frameData = { ...(frameData || {}), preview: optimisticPreview, camera: cachedCam };
      }

      const liveSyncUrl = optimisticPreview?.mode === 'whep'
        ? sessionUrl(`/api/cameras/${encodeURIComponent(cameraId)}/live`)
        : sessionUrl(`/api/cameras/${encodeURIComponent(cameraId)}/live?sync=1`);

      const apiWork = Promise.allSettled([
        fetch(sessionUrl(`/api/detection/person/live/${encodeURIComponent(cameraId)}/select`), { method: 'POST' })
          .then((r) => r.json()),
        fetch(liveSyncUrl).then((r) => (r.ok ? r.json() : null)),
      ]);

      try {
        const [selectResult, liveResult] = await apiWork;
        if (myGen !== selectGeneration) return;

        const selData = selectResult.status === 'fulfilled' ? selectResult.value : null;
        const liveData = liveResult.status === 'fulfilled' ? liveResult.value : null;
        if (selData?.payload) payload = selData.payload;

        inferenceRunning = Boolean(
          selData?.inferenceRunning
          ?? selData?.payload?.state?.inferenceRunning
          ?? keepInferenceUi,
        );

        const previewSource = liveData || selData;
        if (previewSource?.preview || previewSource?.camera) {
          frameData = {
            ...(frameData || {}),
            preview: previewSource.preview || frameData?.preview,
            camera: previewSource.camera || cachedCam,
            whepUrl: selData?.whepUrl || previewSource.whepUrl,
            hlsUrl: selData?.hlsUrl || previewSource.hlsUrl,
            inferenceRunning,
            wsUrl: inferenceRunning
              ? `/ws/person-live?cameraId=${encodeURIComponent(cameraId)}`
              : null,
          };
        }

        if (selData?.backendReachable === false) {
          showToast('Vision API not connected — preview only');
        }
      } catch (err) {
        if (myGen !== selectGeneration) return;
        showToast(err.message || 'Could not connect to camera');
      }

      if (myGen !== selectGeneration) return;

      startPolling();
      await pollFrame();
      updateInferenceUi(frameData || {});
      notifyStreamStateChange();
    }

    function getSelectedCameraId() {
      return selectedCameraId;
    }

    async function initFromPayload(detPayload) {
      payload = detPayload;
      currentConfidence = payload?.state?.confidence ?? 0.32;
      const hasAnyCameras = (payload?.assignedCameras || []).length > 0;
      const root = getRoot();
      if (!hasAnyCameras) {
        selectedCameraId = null;
        frameData = null;
        inferenceRunning = false;
        stopPolling();
        stopSimAnim();
        stopHls();
        stopWhep();
        disconnectDetectionWs();
        stopOverlayLoop();
        if (root) {
          root.hidden = true;
          root.innerHTML = '';
        }
        return;
      }
      const activeId = detPayload?.state?.activeCameraId;
      const cams = detPayload?.assignedCameras || [];
      const wasRunning = Boolean(detPayload?.state?.inferenceRunning && activeId);

      if (!selectedCameraId && cams.length === 1) {
        if (wasRunning && cams[0].id === activeId) inferenceRunning = true;
        await selectCamera(cams[0].id);
        return;
      }
      if (activeId) {
        if (activeId === selectedCameraId && streamInitialized && isMediaActuallyReady()) {
          payload = detPayload;
          inferenceRunning = wasRunning || inferenceRunning;
          updateInferenceUi(frameData || {});
          return;
        }
        if (activeId !== selectedCameraId) {
          if (wasRunning) inferenceRunning = true;
          await selectCamera(activeId);
          return;
        }
      }
      if (!selectedCameraId) {
        if (root) {
          root.hidden = false;
          root.innerHTML = renderEmptyState();
        }
      }
    }

    window.PersonLive = {
      selectCamera,
      startStream,
      stopStream,
      isStreamActive,
      getSelectedCameraId,
      initFromPayload,
      refresh: pollFrame,
      clearCamera() {
        selectedCameraId = null;
        inferenceRunning = false;
        streamActive = false;
        streamFirstFrameReceived = false;
        pendingWsUrl = null;
        stopPolling();
        stopSimAnim();
        stopHls();
        stopWhep();
        disconnectDetectionWs();
        stopOverlayLoop();
        stopStreamConnectLoop();
        stopStreamWatchdog();
        frameData = null;
        const root = getRoot();
        const hasAnyCameras = (payload?.assignedCameras || []).length > 0;
        if (root) {
          if (!hasAnyCameras) {
            root.hidden = true;
            root.innerHTML = '';
          } else {
            root.hidden = false;
            root.innerHTML = renderEmptyState();
          }
        }
      },
    };

    document.addEventListener('DOMContentLoaded', () => {
      const root = getRoot();
      if (root && !selectedCameraId) {
        root.hidden = false;
        root.innerHTML = renderEmptyState();
      }

      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible' || !selectedCameraId || !streamActive) return;
        const host = document.getElementById('pliveStreamHost');
        const hasVideo = host?.querySelector('video.ov-plive-media');
        if (!hasVideo && !usingWhepStream && !usingHlsStream) {
          if (frameData?.preview) {
            initStreamWithPreview({ preview: frameData.preview, camera: frameData.camera });
          }
        }
        if ((usingWhepStream || usingHlsStream) && !overlayAnimTimer) {
          startOverlayLoop();
        }
      });
    });
  })();
