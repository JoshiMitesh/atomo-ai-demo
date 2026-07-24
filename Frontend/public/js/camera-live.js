const CAMERA_SOURCES = [
  { id: 'rtsp', label: 'RTSP camera' },
  { id: 'onvif', label: 'ONVIF camera' },
  { id: 'usb', label: 'USB camera' },
  { id: 'ip', label: 'IP camera' },
  { id: 'http', label: 'HTTP stream' },
  { id: 'video-file', label: 'Video file' },
  { id: 'image-folder', label: 'Image folder' },
  { id: 'mipi', label: 'MIPI camera' },
  { id: 'local-test', label: 'Local test feed' },
];

const AI_MODELS = [
  { id: 'yolov8-perimeter', label: 'Person' },
  { id: 'fire-smoke', label: 'Fire & Smoke' },
  { id: 'face-recog', label: 'Face' },
  { id: 'ppe-detection', label: 'Safety model' },
];

const DEFAULT_CONFIDENCE = 0.7;
const CONFIDENCE_MIN = 25;
const CONFIDENCE_MAX = 95;

let confSaveTimer = null;

const ALERT_RULES = [
  { id: 'intrusion-perimeter', label: 'Perimeter intrusion' },
  { id: 'motion-dock', label: 'Motion — loading dock' },
  { id: 'fire-smoke-alert', label: 'Fire / smoke' },
  { id: 'face-watchlist', label: 'Face watchlist match' },
  { id: 'ppe-missing', label: 'PPE violation' },
  { id: 'loitering', label: 'Loitering detection' },
];

let viewPayload = null;
let analyticsTimer = null;
let streamPreviewTimer = null;
let activeStreamCloser = null;

function sessionUrl(path) {
  const sid = sessionStorage.getItem('atomoSessionId');
  if (!sid) return path;
  const join = path.includes('?') ? '&' : '?';
  return `${path}${join}sessionId=${encodeURIComponent(sid)}`;
}

function resolveStreamUrl(url) {
  if (!url) return url;
  if (window.WhepPlayer?.resolveLocalUrl) return window.WhepPlayer.resolveLocalUrl(url);
  try {
    const u = new URL(url, window.location.origin);
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') {
      const board = document.body.dataset.boardIp;
      u.hostname = board || window.location.hostname;
    }
    return u.href;
  } catch {
    return url;
  }
}

function getCameraIdFromPath() {
  const parts = window.location.pathname.split('/').filter(Boolean);
  const idx = parts.indexOf('cameras');
  return idx >= 0 ? parts[idx + 1] : null;
}

function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function typeLabel(type) {
  return CAMERA_SOURCES.find((s) => s.id === type)?.label || type;
}

function aiModelLabel(id) {
  return AI_MODELS.find((m) => m.id === id)?.label || id;
}

function alertRuleLabel(id) {
  return ALERT_RULES.find((r) => r.id === id)?.label || id;
}

function showToast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2200);
}

function getModelConfidence(cam, modelId) {
  const stored = cam?.modelConfidence?.[modelId];
  return stored != null ? stored : DEFAULT_CONFIDENCE;
}

function confidenceHint(pct) {
  if (pct < 50) return 'Sensitive — more detections, higher false-alert risk';
  if (pct < 75) return 'Balanced — recommended for most environments';
  return 'Strict — fewer false alerts, may miss distant objects';
}

function confidenceTier(pct) {
  if (pct < 50) return 'sensitive';
  if (pct < 75) return 'balanced';
  return 'strict';
}

function renderConfidenceControls(cam) {
  const models = cam?.aiModels || [];
  if (!models.length) {
    return '<p class="ov-cam-conf-empty">Assign AI models to tune detection confidence.</p>';
  }

  return models
    .map((modelId) => {
      const pct = Math.round(getModelConfidence(cam, modelId) * 100);
      const tier = confidenceTier(pct);
      return `
      <div class="ov-cam-conf-row is-${tier}" data-model-id="${esc(modelId)}">
        <div class="ov-cam-conf-head">
          <span class="ov-cam-conf-model">${esc(aiModelLabel(modelId))}</span>
          <span class="ov-cam-conf-val" data-conf-val="${esc(modelId)}">${pct}%</span>
        </div>
        <div class="ov-cam-conf-slider-wrap">
          <input
            type="range"
            class="ov-cam-conf-range"
            min="${CONFIDENCE_MIN}"
            max="${CONFIDENCE_MAX}"
            step="1"
            value="${pct}"
            data-model-id="${esc(modelId)}"
            aria-label="Detection confidence for ${esc(aiModelLabel(modelId))}"
          >
          <div class="ov-cam-conf-scale" aria-hidden="true">
            <span>Sensitive</span>
            <span>Balanced</span>
            <span>Strict</span>
          </div>
        </div>
        <p class="ov-cam-conf-hint" data-conf-hint="${esc(modelId)}">${confidenceHint(pct)}</p>
      </div>`;
    })
    .join('');
}

function formatUptime(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  return `${h}h ${m}m`;
}

function healthBadge(health) {
  if (health === 'good') return 'ov-badge-success';
  if (health === 'fair') return 'ov-badge-gold';
  return 'ov-badge-error';
}

function healthLabel(health) {
  if (health === 'good') return 'Healthy';
  if (health === 'fair') return 'Fair';
  return 'Poor';
}

function buildLocalLiveView(camera) {
  if (!camera) return null;
  const url = String(camera.rtspUrl || '').trim();
  const type = camera.type || 'rtsp';
  const fpsTarget = Number(camera.fpsLimit) || 25;
  const online = camera.status === 'online';

  let preview;
  if (url && /^rtsp:\/\//i.test(url)) {
    preview = {
      mode: 'mjpeg',
      url: `/api/cameras/${encodeURIComponent(camera.id)}/preview.mjpeg`,
      mjpegUrl: `/api/cameras/${encodeURIComponent(camera.id)}/preview.mjpeg`,
      hlsUrl: camera.hlsUrl || null,
      whepUrl: camera.whepUrl || null,
      simulated: false,
      label: 'Live RTSP preview (TCP)',
    };
  } else if (camera.whepUrl || camera.hlsUrl) {
    preview = {
      mode: 'whep',
      url: camera.whepUrl || null,
      hlsUrl: camera.hlsUrl || null,
      whepUrl: camera.whepUrl || null,
      mjpegUrl: null,
      simulated: false,
      label: 'Live stream',
    };
  } else if (url && type === 'http' && /^https?:\/\//i.test(url)) {
    preview = { mode: 'http', url, simulated: false };
  } else if (url && type === 'video-file' && /\.(mp4|webm|ogg)(\?|$)/i.test(url)) {
    preview = { mode: 'video', url, simulated: false };
  } else {
    preview = {
      mode: 'edge',
      url: null,
      simulated: true,
      label: url
        ? 'Stream relayed via Atomo edge decoder'
        : 'Simulated preview — no stream URL configured',
    };
  }

  const { password, ...safe } = camera;
  return {
    camera: { ...safe, hasCredentials: Boolean(camera.username || password) },
    preview,
    analytics: {
      timestamp: new Date().toISOString(),
      fps: fpsTarget,
      fpsTarget,
      bitrateMbps: 2.4,
      latencyMs: online ? 118 : 0,
      jitterMs: online ? 8 : 0,
      packetLossPercent: online ? 0.2 : 0,
      codec: 'H.264',
      resolution: camera.resolution || '1920x1080',
      uptimeSeconds: online ? 3600 : 0,
      framesReceived: online ? Math.floor(3600 * fpsTarget * 0.98) : 0,
      frameDrops: 0,
      streamHealth: online ? 'good' : 'poor',
      recording: Boolean(camera.recording),
      aiEventsLastHour: 0,
      alertsToday: 0,
      bandwidthInKbps: online ? 1700 : 0,
      bandwidthOutKbps: online ? 380 : 0,
    },
  };
}

function renderAnalyticsGrid(analytics) {
  if (!analytics) return '';
  const items = [
    { label: 'FPS', value: `${analytics.fps} / ${analytics.fpsTarget}`, mono: true },
    { label: 'Bitrate', value: `${analytics.bitrateMbps} Mbps`, mono: true },
    { label: 'Latency', value: `${analytics.latencyMs} ms`, mono: true },
    { label: 'Jitter', value: `${analytics.jitterMs} ms`, mono: true },
    { label: 'Packet loss', value: `${analytics.packetLossPercent}%`, mono: true },
    { label: 'Codec', value: analytics.codec, mono: true },
    { label: 'Resolution', value: analytics.resolution, mono: true },
    { label: 'Uptime', value: formatUptime(analytics.uptimeSeconds) },
    { label: 'Frames', value: analytics.framesReceived.toLocaleString(), mono: true },
    { label: 'Frame drops', value: String(analytics.frameDrops), mono: true },
    { label: 'Stream health', value: healthLabel(analytics.streamHealth), badge: healthBadge(analytics.streamHealth) },
    { label: 'AI events (1h)', value: String(analytics.aiEventsLastHour), mono: true },
    { label: 'Alerts today', value: String(analytics.alertsToday), mono: true },
    { label: 'Bandwidth in', value: `${analytics.bandwidthInKbps} kbps`, mono: true },
    { label: 'Bandwidth out', value: `${analytics.bandwidthOutKbps} kbps`, mono: true },
  ];

  return items
    .map((item) => {
      const valueHtml = item.badge
        ? `<span class="ov-badge ${item.badge}">${esc(item.value)}</span>`
        : `<strong class="${item.mono ? 'ov-mono' : ''}">${esc(item.value)}</strong>`;
      return `<div class="ov-cam-analytics-stat"><span>${item.label}</span>${valueHtml}</div>`;
    })
    .join('');
}

function renderLivePage() {
  const cam = viewPayload?.camera;
  const analytics = viewPayload?.analytics;
  const preview = viewPayload?.preview;

  const aiTags = (cam?.aiModels || [])
    .map((id) => `<span class="ov-cam-tag">${esc(aiModelLabel(id))}</span>`)
    .join('') || '<span class="ov-cam-tag ov-cam-tag-muted">No AI models</span>';

  const alertTags = (cam?.alertRules || [])
    .map((id) => `<span class="ov-cam-tag">${esc(alertRuleLabel(id))}</span>`)
    .join('') || '<span class="ov-cam-tag ov-cam-tag-muted">No alert rules</span>';

  return `
    <article class="ov-card ov-cam-live-card">
      <div class="ov-cam-live-inner">
        <div class="ov-cam-live-video-row">
          <div class="ov-cam-stream-frame ov-cam-stream-frame-page" id="camStreamFrame">
            <div class="ov-cam-stream-live ${preview?.simulated ? 'ov-cam-stream-sim' : ''}">${preview?.simulated ? 'SIM' : 'LIVE'}</div>
            <div class="ov-cam-stream-inner" id="camStreamPreview">
              ${cam ? '' : '<div class="ov-cam-stream-placeholder">Loading preview…</div>'}
            </div>
            ${preview?.simulated || preview?.mode === 'edge' ? `<div class="ov-cam-stream-relay">${esc(preview?.label || 'Simulated preview')}</div>` : (preview?.label && preview?.mode === 'mjpeg' ? `<div class="ov-cam-stream-relay">${esc(preview.label)}</div>` : '')}
          </div>
        </div>

        <div class="ov-cam-live-info-row">
          <div class="ov-cam-view-section ov-cam-live-panel">
            <div class="ov-stat-headline">Stream analytics</div>
            <div class="ov-cam-analytics-grid ov-cam-analytics-grid-live" id="camAnalyticsGrid">${renderAnalyticsGrid(analytics)}</div>
          </div>
          ${cam ? `
          <div class="ov-cam-view-section ov-cam-live-panel">
            <div class="ov-stat-headline">Camera details</div>
            <div class="ov-cam-details-grid ov-cam-details-grid-live">
              <span>Location</span><strong>${esc(cam.location || '—')}</strong>
              <span>Zone / floor</span><strong>${esc(cam.zoneFloor || '—')}</strong>
              <span>Department</span><strong>${esc(cam.department || '—')}</strong>
              <span>Group</span><strong>${esc(cam.group || '—')}</strong>
              <span>Resolution</span><strong class="ov-mono">${esc(cam.resolution || '—')}</strong>
              <span>FPS limit</span><strong class="ov-mono">${cam.fpsLimit || '—'}</strong>
            </div>
          </div>` : ''}
          <div class="ov-cam-view-section ov-cam-live-panel">
            <div class="ov-stat-headline">AI &amp; alerts</div>
            <div class="ov-cam-assignment-block">
              <div class="ov-cam-assignment-label">AI models</div>
              <div class="ov-cam-tag-row">${aiTags}</div>
            </div>
            <div class="ov-cam-assignment-block ov-cam-conf-block">
              <div class="ov-cam-assignment-label">Detection confidence</div>
              <div class="ov-cam-conf-list" id="camConfidenceList">${renderConfidenceControls(cam)}</div>
            </div>
            <div class="ov-cam-assignment-block">
              <div class="ov-cam-assignment-label">Alert rules</div>
              <div class="ov-cam-tag-row">${alertTags}</div>
            </div>
          </div>
        </div>

        <div class="ov-cam-live-meta-bar">
          <span class="ov-mono">${cam ? esc(cam.rtspUrl || 'No stream URL — showing simulated feed') : '—'}</span>
          ${cam?.ipAddress ? `<span class="ov-cam-live-meta-ip">${esc(cam.ipAddress)}${cam.port ? `:${esc(cam.port)}` : ''}</span>` : ''}
        </div>
      </div>
      <div class="ov-merged-accent" aria-hidden="true"></div>
    </article>`;
}

function updatePageHeader() {
  const cam = viewPayload?.camera;
  const title = document.getElementById('camLiveTitle');
  const sub = document.getElementById('camLiveSub');
  const meta = document.getElementById('camLiveHeadMeta');

  if (title) title.textContent = cam?.name || 'Camera live view';
  if (sub) {
    sub.textContent = cam
      ? `${typeLabel(cam.type)} · ${cam.location || 'No location'}`
      : 'Loading camera…';
  }
  if (meta && cam) {
    const online = cam.status === 'online';
    meta.innerHTML = `
      <span class="ov-badge ${online ? 'ov-badge-success' : 'ov-badge-error'}">${online ? 'Online' : 'Offline'}</span>
      ${cam.recording ? '<span class="ov-badge ov-badge-gold">Recording</span>' : ''}`;
  }
  if (cam?.name) {
    document.title = `${cam.name} — Atomo Forge`;
  }
}

function stopStreamPreview() {
  if (streamPreviewTimer) {
    cancelAnimationFrame(streamPreviewTimer);
    streamPreviewTimer = null;
  }
  if (typeof activeStreamCloser === 'function') {
    try {
      activeStreamCloser();
    } catch {
      /* ignore */
    }
    activeStreamCloser = null;
  }
  const host = document.getElementById('camStreamPreview');
  const canvas = host?.querySelector('.ov-cam-stream-canvas');
  if (canvas?._resizeObserver) {
    canvas._resizeObserver.disconnect();
    canvas._resizeObserver = null;
  }
}

function showMjpegPreview(host, camera, mjpegUrl, onFailed) {
  host.innerHTML = '';
  const img = document.createElement('img');
  img.className = 'ov-cam-stream-img';
  img.alt = `${camera?.name || 'Camera'} live stream`;
  img.src = sessionUrl(mjpegUrl);
  let failed = false;
  img.onerror = () => {
    if (failed) return;
    failed = true;
    if (typeof onFailed === 'function') onFailed();
    else showSimulatedPreview(host, camera);
  };
  host.appendChild(img);
  activeStreamCloser = () => {
    img.src = '';
  };
}

function showHlsPreview(host, camera, hlsUrl, onFailed) {
  host.innerHTML = '';
  const video = document.createElement('video');
  video.className = 'ov-cam-stream-video';
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  video.controls = false;
  host.appendChild(video);

  const url = resolveStreamUrl(hlsUrl);
  let hls = null;

  if (window.Hls?.isSupported?.()) {
    hls = new window.Hls({ enableWorker: true, lowLatencyMode: true });
    hls.loadSource(url);
    hls.attachMedia(video);
    hls.on(window.Hls.Events.ERROR, (_evt, data) => {
      if (data?.fatal) {
        try {
          hls.destroy();
        } catch {
          /* ignore */
        }
        if (typeof onFailed === 'function') onFailed();
        else showSimulatedPreview(host, camera);
      }
    });
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = url;
    video.onerror = () => {
      if (typeof onFailed === 'function') onFailed();
      else showSimulatedPreview(host, camera);
    };
  } else if (typeof onFailed === 'function') {
    onFailed();
    return;
  } else {
    showSimulatedPreview(host, camera);
    return;
  }

  activeStreamCloser = () => {
    try {
      hls?.destroy();
    } catch {
      /* ignore */
    }
    video.src = '';
    video.srcObject = null;
  };
}

function showWhepPreview(host, camera, whepUrl, onFailed) {
  if (!window.WhepPlayer?.connectWhep) {
    if (typeof onFailed === 'function') onFailed();
    return;
  }
  host.innerHTML = '';
  const video = document.createElement('video');
  video.className = 'ov-cam-stream-video';
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  host.appendChild(video);

  const url = resolveStreamUrl(whepUrl);
  let player = null;
  let settled = false;
  const failTimer = setTimeout(() => {
    if (settled) return;
    settled = true;
    try {
      player?.close();
    } catch {
      /* ignore */
    }
    if (typeof onFailed === 'function') onFailed();
  }, 5000);

  window.WhepPlayer.connectWhep(url, video)
    .then((p) => {
      player = p;
      activeStreamCloser = () => {
        clearTimeout(failTimer);
        try {
          p.close();
        } catch {
          /* ignore */
        }
      };
      const markReady = () => {
        if (settled) return;
        settled = true;
        clearTimeout(failTimer);
      };
      video.addEventListener('wheptrack', markReady, { once: true });
      video.addEventListener('playing', markReady, { once: true });
    })
    .catch(() => {
      if (settled) return;
      settled = true;
      clearTimeout(failTimer);
      if (typeof onFailed === 'function') onFailed();
    });
}

function startEdgePreview(canvas, label) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let frame = 0;

  function draw() {
    const w = canvas.width;
    const h = canvas.height;
    const t = frame * 0.02;
    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, `hsl(${140 + Math.sin(t) * 20}, 28%, ${22 + Math.sin(t * 0.7) * 4}%)`);
    g.addColorStop(1, `hsl(${160 + Math.cos(t) * 15}, 22%, ${14 + Math.cos(t * 0.5) * 3}%)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    for (let i = 0; i < 8; i += 1) {
      const y = ((frame * 2 + i * 40) % (h + 80)) - 40;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y + 30);
      ctx.stroke();
    }

    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.font = '600 14px Inter, system-ui, sans-serif';
    ctx.fillText(label || 'Live stream', 16, h - 20);
    ctx.font = '11px Inter, system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fillText(new Date().toLocaleTimeString(), 16, h - 44);

    frame += 1;
    streamPreviewTimer = requestAnimationFrame(draw);
  }

  draw();
}

function showSimulatedPreview(host, camera) {
  host.innerHTML = '';
  const canvas = document.createElement('canvas');
  canvas.className = 'ov-cam-stream-canvas';
  host.appendChild(canvas);

  const fitCanvas = () => {
    const w = host.clientWidth || 960;
    const h = host.clientHeight || 540;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  };

  fitCanvas();
  const sublabel = camera?.status !== 'online' ? `${camera?.name || 'Camera'} · offline demo` : camera?.name || 'Camera';
  startEdgePreview(canvas, sublabel);

  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(fitCanvas);
    ro.observe(host);
    canvas._resizeObserver = ro;
  }
}

function initStreamPreview() {
  stopStreamPreview();
  const host = document.getElementById('camStreamPreview');
  if (!host || !viewPayload) return;

  const { preview, camera } = viewPayload;
  host.innerHTML = '';

  const mjpegUrl = preview?.mjpegUrl
    || (preview?.mode === 'mjpeg' ? preview.url : null)
    || (camera?.id && camera?.rtspUrl && /^rtsp:\/\//i.test(camera.rtspUrl)
      ? `/api/cameras/${encodeURIComponent(camera.id)}/preview.mjpeg`
      : null);

  const showMjpegOrSim = () => {
    if (mjpegUrl) showMjpegPreview(host, camera, mjpegUrl);
    else showSimulatedPreview(host, camera);
  };

  // Prefer local RTSP→MJPEG (ffmpeg -rtsp_transport tcp) for RTSP cams —
  // board WHEP often fails on HEVC / UDP-only pulls.
  if (mjpegUrl && (preview?.mode === 'mjpeg' || /^rtsp:\/\//i.test(camera?.rtspUrl || ''))) {
    showMjpegPreview(host, camera, mjpegUrl, () => {
      if (preview?.mode === 'whep' && preview.url) {
        showWhepPreview(host, camera, preview.url, () => {
          if (preview.hlsUrl) showHlsPreview(host, camera, preview.hlsUrl, () => showSimulatedPreview(host, camera));
          else showSimulatedPreview(host, camera);
        });
      } else if (preview?.hlsUrl) {
        showHlsPreview(host, camera, preview.hlsUrl, () => showSimulatedPreview(host, camera));
      } else {
        showSimulatedPreview(host, camera);
      }
    });
    return;
  }

  if (preview.mode === 'http' && preview.url && !preview.simulated) {
    const img = document.createElement('img');
    img.className = 'ov-cam-stream-img';
    img.alt = `${camera.name} live stream`;
    img.src = preview.url;
    img.onerror = () => showMjpegOrSim();
    host.appendChild(img);
    return;
  }

  if (preview.mode === 'video' && preview.url && !preview.simulated) {
    const video = document.createElement('video');
    video.className = 'ov-cam-stream-video';
    video.src = preview.url;
    video.autoplay = true;
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.onerror = () => showMjpegOrSim();
    host.appendChild(video);
    return;
  }

  if (preview.mode === 'whep' && preview.url && !preview.simulated) {
    showWhepPreview(host, camera, preview.url, () => {
      if (preview.hlsUrl) showHlsPreview(host, camera, preview.hlsUrl, showMjpegOrSim);
      else showMjpegOrSim();
    });
    return;
  }

  if ((preview.mode === 'hls' || preview.hlsUrl) && !preview.simulated) {
    showHlsPreview(host, camera, preview.hlsUrl || preview.url, showMjpegOrSim);
    return;
  }

  showMjpegOrSim();
}

function updateViewAnalytics() {
  const grid = document.getElementById('camAnalyticsGrid');
  if (grid && viewPayload?.analytics) {
    grid.innerHTML = renderAnalyticsGrid(viewPayload.analytics);
  }
}

function renderPage() {
  const root = document.getElementById('cameraLiveRoot');
  if (!root) return;
  root.innerHTML = renderLivePage();
  updatePageHeader();
  wireConfidenceControls();
  if (viewPayload) initStreamPreview();
}

function wireConfidenceControls() {
  document.querySelectorAll('.ov-cam-conf-range').forEach((input) => {
    input.addEventListener('input', onConfidenceInput);
    input.addEventListener('change', onConfidenceCommit);
  });
}

function onConfidenceInput(e) {
  const modelId = e.target.dataset.modelId;
  const pct = Number(e.target.value);
  const valEl = document.querySelector(`[data-conf-val="${modelId}"]`);
  const hintEl = document.querySelector(`[data-conf-hint="${modelId}"]`);
  const row = e.target.closest('.ov-cam-conf-row');

  if (valEl) valEl.textContent = `${pct}%`;
  if (hintEl) hintEl.textContent = confidenceHint(pct);
  if (row) {
    row.classList.remove('is-sensitive', 'is-balanced', 'is-strict');
    row.classList.add(`is-${confidenceTier(pct)}`);
  }
}

function onConfidenceCommit(e) {
  const modelId = e.target.dataset.modelId;
  const confidence = Number(e.target.value) / 100;
  if (!viewPayload?.camera) return;

  if (!viewPayload.camera.modelConfidence) viewPayload.camera.modelConfidence = {};
  viewPayload.camera.modelConfidence[modelId] = confidence;

  clearTimeout(confSaveTimer);
  confSaveTimer = setTimeout(() => saveModelConfidence(modelId, confidence), 350);
}

async function saveModelConfidence(modelId, confidence) {
  const camId = viewPayload?.camera?.id;
  if (!camId) return;

  try {
    const res = await fetch(sessionUrl(`/api/cameras/${encodeURIComponent(camId)}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelConfidence: { [modelId]: confidence } }),
    });
    if (!res.ok) throw new Error('save failed');
    const data = await res.json();
    viewPayload.camera = data.camera;
    showToast('Detection confidence saved');
  } catch {
    showToast('Could not save confidence');
  }
}

function stopAnalyticsPolling() {
  if (analyticsTimer) {
    clearInterval(analyticsTimer);
    analyticsTimer = null;
  }
}

async function refreshLiveView(cameraId) {
  try {
    const res = await fetch(sessionUrl(`/api/cameras/${encodeURIComponent(cameraId)}/live`));
    if (!res.ok) return;
    viewPayload = await res.json();
    updatePageHeader();
    updateViewAnalytics();
  } catch {
    /* keep current payload */
  }
}

function startAnalyticsPolling(cameraId) {
  stopAnalyticsPolling();
  analyticsTimer = setInterval(() => refreshLiveView(cameraId), 2000);
}

async function initCameraLivePage() {
  const root = document.getElementById('cameraLiveRoot');
  if (!root) return;

  const cameraId = getCameraIdFromPath();
  const back = document.getElementById('camLiveBack');
  if (back) back.href = sessionUrl('/overview');

  const sessionRes = await fetch(sessionUrl('/api/session'));
  const session = await sessionRes.json();
  if (!session.authenticated) {
    window.location.href = '/login';
    return;
  }
  if (session.sessionId) sessionStorage.setItem('atomoSessionId', session.sessionId);

  if (!cameraId) {
    window.location.href = sessionUrl('/overview');
    return;
  }

  let localCamera = null;
  try {
    const listRes = await fetch(sessionUrl('/api/cameras'));
    if (listRes.ok) {
      const data = await listRes.json();
      localCamera = (data.cameras || []).find((c) => c.id === cameraId) || null;
    }
  } catch {
    /* ignore */
  }

  if (!localCamera) {
    window.location.href = sessionUrl('/overview');
    return;
  }

  viewPayload = buildLocalLiveView(localCamera);
  renderPage();
  startAnalyticsPolling(cameraId);

  try {
    const res = await fetch(sessionUrl(`/api/cameras/${encodeURIComponent(cameraId)}/live`));
    if (res.ok) {
      viewPayload = await res.json();
      renderPage();
    }
  } catch {
    /* keep local preview */
  }

  window.addEventListener('beforeunload', () => {
    stopAnalyticsPolling();
    stopStreamPreview();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initCameraLivePage);
} else {
  initCameraLivePage();
}
