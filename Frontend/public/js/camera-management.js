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

const RESOLUTIONS = ['3840x2160', '2560x1440', '1920x1080', '1280x720', '640x480'];

const CHECK_ORDER = [
  'streamReachable',
  'credentialsValid',
  'frameReceived',
  'resolutionDetected',
  'fpsDetected',
  'codecDetected',
  'latencyMeasured',
  'audioPresence',
  'reconnectCapability',
];

const CHECK_LABELS = {
  streamReachable: 'Stream reachable',
  credentialsValid: 'Credentials valid',
  frameReceived: 'Frame received',
  resolutionDetected: 'Resolution detected',
  fpsDetected: 'FPS detected',
  codecDetected: 'Codec detected',
  latencyMeasured: 'Latency measured',
  audioPresence: 'Audio presence',
  reconnectCapability: 'Reconnect capability',
};

let cameras = [];
let stats = { total: 0, online: 0, offline: 0 };
let lastValidation = null;
let isTesting = false;
let modalOpen = false;

function sessionUrl(path) {
  const sid = sessionStorage.getItem('atomoSessionId');
  return sid ? `${path}?sessionId=${encodeURIComponent(sid)}` : path;
}

function showToast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2600);
}

function typeLabel(type) {
  return CAMERA_SOURCES.find((s) => s.id === type)?.label || type;
}

function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formValue(id) {
  const el = document.getElementById(id);
  if (!el) return '';
  if (el.type === 'checkbox') return el.checked;
  return el.value;
}

function selectedValues(id) {
  const el = document.getElementById(id);
  if (!el) return [];
  return Array.from(el.selectedOptions).map((o) => o.value);
}

function getFormPayload() {
  const detSlug = document.body.dataset.detectionSlug;
  const tabModelId = document.body.dataset.detectionModelId;
  let aiModels = selectedValues('camAiModels');
  // On a detection tab, bind camera only to this model (not other tabs).
  if (detSlug && tabModelId) {
    aiModels = [tabModelId];
  }
  return {
    name: formValue('camName'),
    type: formValue('camType'),
    rtspUrl: formValue('camRtspUrl'),
    location: formValue('camLocation'),
    zoneFloor: formValue('camZone'),
    department: formValue('camDepartment'),
    group: formValue('camGroup'),
    resolution: formValue('camResolution'),
    fpsLimit: Number(formValue('camFps')) || 25,
    aiModels,
    recording: formValue('camRecording'),
    mipiEnabled: formValue('camType') !== 'mipi' || formValue('camMipiHw'),
    checkAudio: true,
  };
}

function renderSources() {
  return CAMERA_SOURCES.map(
    (s) => `<button type="button" class="ov-quick-btn ov-cam-source-chip" data-type="${s.id}">${esc(s.label)}</button>`
  ).join('');
}

function isCameraStreaming(camId) {
  const detSlug = document.body.dataset.detectionSlug;
  if (detSlug === 'person') return window.PersonLive?.isStreamActive?.(camId) || false;
  if (detSlug === 'face') return window.FaceLive?.isStreamActive?.(camId) || false;
  return false;
}

function renderCameraTile(cam) {
  const online = cam.status === 'online';
  const detSlug = document.body.dataset.detectionSlug;
  const isPersonTab = detSlug === 'person';
  const isFaceTab = detSlug === 'face';
  const isDetTab = isPersonTab || isFaceTab;
  const selected = (isPersonTab && window.PersonLive?.getSelectedCameraId?.() === cam.id)
    || (isFaceTab && window.FaceLive?.getSelectedCameraId?.() === cam.id);
  const streaming = isCameraStreaming(cam.id);
  const clickable = isDetTab ? canSelectCameraForDetection() : canOpenLiveView();
  const hint = !clickable
    ? 'Status only'
    : isDetTab
      ? (selected ? 'Selected for detection' : 'Click card to select')
      : 'Open live view';
  const streamBtn = isDetTab && canControlDetection() ? `
      <div class="ov-cam-tile-actions">
        <button type="button" class="ov-cam-stream-btn ${streaming ? 'is-streaming' : ''}" data-action="toggle-stream" data-id="${cam.id}">
          <span class="ov-cam-stream-btn-dot" aria-hidden="true"></span>
          ${streaming ? 'Stop stream' : 'Start stream'}
        </button>
      </div>` : '';
  const interactAttrs = clickable
    ? `data-action="open-view" tabindex="0" role="button" aria-label="${isDetTab ? 'Select' : 'Open live view for'} ${esc(cam.name)}"`
    : `aria-label="${esc(cam.name)} — status only"`;
  return `
    <article class="ov-cam-tile ${clickable ? 'ov-cam-tile-clickable' : 'ov-cam-tile-readonly'} ${selected ? 'is-selected' : ''} ${streaming ? 'is-streaming' : ''}" data-id="${cam.id}" ${interactAttrs}>
      <div class="ov-cam-tile-head">
        <span class="ov-cam-tile-icon" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"/><rect x="2" y="6" width="14" height="12" rx="2"/></svg>
        </span>
        ${canWriteCameras() ? `
        <button type="button" class="ov-cam-icon-btn" data-action="delete" data-id="${cam.id}" title="Remove camera" aria-label="Remove ${esc(cam.name)}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
        </button>` : ''}
      </div>
      <h3 class="ov-cam-tile-name">${esc(cam.name)}</h3>
      <p class="ov-cam-tile-type">${esc(typeLabel(cam.type))}</p>
      <span class="ov-badge ${online ? 'ov-badge-success' : 'ov-badge-error'}">${online ? 'Online' : 'Offline'}</span>
      ${streaming ? '<span class="ov-badge ov-badge-live">Streaming</span>' : ''}
      <div class="ov-cam-tile-meta">
        <span>${esc(cam.location || 'No location')}</span>
        <span class="ov-mono">${esc(cam.resolution || '—')} · ${cam.fpsLimit || '—'} fps</span>
      </div>
      <span class="ov-cam-tile-hint">${hint}</span>
      ${streamBtn}
    </article>`;
}

function canWriteCameras() {
  const role = window.__atomoUserRole;
  if (!role) return false;
  const perms = role.permissions || [];
  return perms.includes('*') || perms.includes('cameras.write');
}

function canControlDetection() {
  const role = window.__atomoUserRole;
  if (!role) return false;
  const perms = role.permissions || [];
  return perms.includes('*') || perms.includes('detection.control');
}

function canSelectCameraForDetection() {
  const role = window.__atomoUserRole;
  if (!role) return false;
  const perms = role.permissions || [];
  return perms.includes('*') || perms.includes('detection.view') || perms.includes('detection.control');
}

function canOpenLiveView() {
  const role = window.__atomoUserRole;
  if (!role) return false;
  const perms = role.permissions || [];
  return perms.includes('*') || perms.includes('live.view');
}

function renderCameraGrid() {
  const tiles = cameras.map(renderCameraTile).join('');
  const addTile = canWriteCameras()
    ? `
    <button type="button" class="ov-cam-tile ov-cam-tile-add" data-action="open-add" aria-label="Add camera">
      <span class="ov-cam-tile-plus" aria-hidden="true">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14"/><path d="M12 5v14"/></svg>
      </span>
      <span class="ov-cam-tile-add-label">Add camera</span>
      <span class="ov-cam-tile-add-sub">Connect a new source</span>
    </button>`
    : '';
  return `${tiles}${addTile}`;
}

function renderValidationPanel() {
  if (!lastValidation) {
    return `
      <div class="ov-cam-val-idle">
        <div class="ov-cam-val-icon" aria-hidden="true">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"/><rect x="2" y="6" width="14" height="12" rx="2"/></svg>
        </div>
        <h3>Stream validation</h3>
        <p>Test the stream before saving. The system checks reachability, credentials, frames, codec, latency, and reconnect behavior.</p>
      </div>`;
  }

  const { success, error, checks, detected } = lastValidation;
  const checksHtml = CHECK_ORDER.map((key) => {
    const item = checks?.[key];
    if (!item) return '';
    const badge = item.ok ? 'ov-badge-success' : 'ov-badge-error';
    return `
      <div class="ov-alert-activity-row ov-cam-check">
        <div class="ov-alert-activity-main">
          <div class="ov-alert-activity-title">${CHECK_LABELS[key]}</div>
          <div class="ov-alert-activity-time">${esc(item.message)}</div>
        </div>
        <span class="ov-badge ${badge}">${item.ok ? 'Pass' : 'Fail'}</span>
      </div>`;
  }).join('');

  const detectedHtml =
    success && detected
      ? `<div class="ov-merged-mini ov-cam-detected">
        <div class="ov-mini-label">Detected stream profile</div>
        <div class="ov-cam-detected-grid">
          <span>Resolution</span><strong class="ov-mono">${esc(detected.resolution)}</strong>
          <span>FPS</span><strong class="ov-mono">${detected.fps}</strong>
          <span>Codec</span><strong class="ov-mono">${esc(detected.codec)}</strong>
          <span>Latency</span><strong class="ov-mono">${detected.latencyMs} ms</strong>
        </div>
      </div>`
      : '';

  const bannerHtml = !success
    ? `<div class="ov-kpi ov-kpi-critical ov-cam-val-banner" role="alert">
        <div class="ov-kpi-label">Validation failed</div>
        <div class="ov-kpi-sub">${esc(error || 'Stream validation failed')}</div>
      </div>`
    : `<div class="ov-kpi ov-cam-val-banner ov-cam-val-banner-success" role="status">
        <div class="ov-kpi-label">Validation passed</div>
        <div class="ov-kpi-sub">Stream validated — ready to save</div>
      </div>`;

  return `${bannerHtml}${detectedHtml}<div class="ov-cam-checks">${checksHtml}</div>`;
}

function renderAddForm() {
  return `
    <form class="ov-cam-form" id="camAddForm" novalidate>
      <div class="ov-cam-form-section">
        <div class="ov-info-title">Identity</div>
        <div class="ov-cam-field">
          <label for="camName">Camera name <span class="req">*</span></label>
          <input id="camName" name="name" type="text" placeholder="e.g. North Gate — Entrance" required>
        </div>
        <div class="ov-cam-field">
          <label for="camType">Camera type <span class="req">*</span></label>
          <select id="camType" name="type">
            ${CAMERA_SOURCES.map((s) => `<option value="${s.id}">${esc(s.label)}</option>`).join('')}
          </select>
        </div>
      </div>

      <div class="ov-cam-form-section">
        <div class="ov-info-title">Connection</div>
        <div class="ov-cam-field">
          <label for="camRtspUrl">Stream URL / path</label>
          <input id="camRtspUrl" name="rtspUrl" type="text" placeholder="rtsp://192.168.1.50:554/stream1">
        </div>
        <label class="ov-cam-check-inline" id="camMipiWrap" hidden>
          <input id="camMipiHw" type="checkbox">
          <span>MIPI hardware detected on this device</span>
        </label>
      </div>

      <div class="ov-cam-form-section">
        <div class="ov-info-title">Placement</div>
        <div class="ov-cam-field-row">
          <div class="ov-cam-field">
            <label for="camLocation">Location</label>
            <input id="camLocation" name="location" type="text" placeholder="Building A — Main entrance">
          </div>
          <div class="ov-cam-field">
            <label for="camZone">Zone / Floor</label>
            <input id="camZone" name="zoneFloor" type="text" placeholder="Ground floor">
          </div>
        </div>
        <div class="ov-cam-field-row">
          <div class="ov-cam-field">
            <label for="camDepartment">Department</label>
            <input id="camDepartment" name="department" type="text" placeholder="Security">
          </div>
          <div class="ov-cam-field">
            <label for="camGroup">Camera group</label>
            <input id="camGroup" name="group" type="text" placeholder="Perimeter">
          </div>
        </div>
      </div>

      <div class="ov-cam-form-section">
        <div class="ov-info-title">Stream profile</div>
        <div class="ov-cam-field-row">
          <div class="ov-cam-field">
            <label for="camResolution">Resolution</label>
            <select id="camResolution" name="resolution">
              ${RESOLUTIONS.map((r) => `<option value="${r}" ${r === '1920x1080' ? 'selected' : ''}>${r}</option>`).join('')}
            </select>
          </div>
          <div class="ov-cam-field">
            <label for="camFps">FPS limit</label>
            <input id="camFps" name="fpsLimit" type="number" min="1" max="60" value="25">
          </div>
        </div>
      </div>

      <div class="ov-cam-form-section">
        <div class="ov-info-title">AI models</div>
        <div class="ov-cam-field">
          <label for="camAiModels">AI model assignment</label>
          <select id="camAiModels" name="aiModels" multiple size="3">
            ${AI_MODELS.map((m) => `<option value="${m.id}">${esc(m.label)}</option>`).join('')}
          </select>
        </div>
        <label class="ov-cam-check-inline">
          <input id="camRecording" name="recording" type="checkbox" checked>
          <span>Enable continuous recording</span>
        </label>
      </div>
    </form>`;
}

function renderModal() {
  return `
    <div class="ov-modal ${modalOpen ? 'is-open' : ''}" id="camAddModal" role="dialog" aria-modal="true" aria-labelledby="camModalTitle" ${modalOpen ? '' : 'hidden'}>
      <div class="ov-modal-backdrop" data-action="close-modal"></div>
      <div class="ov-modal-dialog">
        <div class="ov-modal-head">
          <div>
            <h2 id="camModalTitle" class="ov-modal-title">Add camera</h2>
            <p class="ov-merged-sub">Fill in details, test the stream, then save to register the camera.</p>
          </div>
          <button type="button" class="ov-modal-close" data-action="close-modal" aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg>
          </button>
        </div>

        <div class="ov-modal-sources">
          <div class="ov-stat-headline">Supported sources</div>
          <div class="ov-cam-sources-chips">${renderSources()}</div>
        </div>

        <div class="ov-modal-body ov-cam-add-grid">
          <div class="ov-modal-form-wrap">${renderAddForm()}</div>
          <aside class="ov-cam-validation" id="camValidationPanel" aria-live="polite">${renderValidationPanel()}</aside>
        </div>

        <div class="ov-modal-foot">
          <button type="button" class="ov-quick-btn" id="camResetBtn">Reset</button>
          <button type="button" class="ov-quick-btn" id="camTestBtn" ${isTesting ? 'disabled' : ''}>
            ${isTesting ? 'Testing stream…' : 'Test stream'}
          </button>
          <button type="button" class="ov-quick-btn ov-cam-save-btn" id="camSaveBtn" ${!lastValidation?.success ? 'disabled' : ''}>Save camera</button>
        </div>
      </div>
    </div>`;
}

function navigateToCamera(id) {
  const detSlug = document.body.dataset.detectionSlug;
  if (detSlug === 'person' || detSlug === 'face') {
    if (!canSelectCameraForDetection()) return;
    if (detSlug === 'person' && window.PersonLive?.selectCamera) {
      window.PersonLive.selectCamera(id);
      return;
    }
    if (detSlug === 'face' && window.FaceLive?.selectCamera) {
      window.FaceLive.selectCamera(id);
      return;
    }
    return;
  }
  if (!canOpenLiveView()) return;
  window.location.href = sessionUrl(`/cameras/${encodeURIComponent(id)}`);
}

async function handleToggleStream(id) {
  const detSlug = document.body.dataset.detectionSlug;
  const live = detSlug === 'person' ? window.PersonLive : detSlug === 'face' ? window.FaceLive : null;
  if (!live) {
    window.CameraStreamLog?.report({
      source: 'camera-management',
      step: 'start-stream',
      level: 'error',
      cameraId: id,
      message: 'Start stream clicked but no live player is loaded',
      why: `detectionSlug="${detSlug || ''}" — expected person or face tab`,
    });
    return;
  }

  const cam = cameras.find((c) => c.id === id);

  if (live.isStreamActive?.(id)) {
    window.CameraStreamLog?.report({
      source: 'camera-management',
      step: 'stop-stream',
      cameraId: id,
      cameraName: cam?.name,
      message: 'Stop stream clicked',
    });
    await live.stopStream?.(id);
    showToast('Stream stopped');
  } else {
    window.CameraStreamLog?.report({
      source: 'camera-management',
      step: 'start-stream',
      cameraId: id,
      cameraName: cam?.name,
      message: 'Start stream clicked — selecting camera and starting playback',
      detail: { tab: detSlug, rtspUrl: cam?.rtspUrl || null },
    });
    await live.selectCamera?.(id);
    await live.startStream?.(id);
    showToast('Stream starting…');
  }
  refreshStreamStates();
}

function renderShell() {
  const root = document.getElementById('cameraManagement');
  if (!root) return;

  if (!cameras.length) {
    const detSlug = document.body.dataset.detectionSlug;
    const emptyTitle = detSlug ? 'No cameras assigned' : 'No cameras added';
    const emptySub = detSlug
      ? 'Add a camera to use it with this detection model only.'
      : 'Add your first camera to start live streaming and person detection.';
    root.innerHTML = `
      <article class="ov-card ov-cam-mgmt">
        <div class="ov-cam-mgmt-inner">
          <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:72px 24px;gap:14px;text-align:center;">
            <div style="width:72px;height:72px;border-radius:18px;background:var(--color-background-secondary,#f1f5f9);display:flex;align-items:center;justify-content:center;">
              <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-tertiary,#94a3b8)" stroke-width="1.75" aria-hidden="true">
                <path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"/>
                <rect x="2" y="6" width="14" height="12" rx="2"/>
              </svg>
            </div>
            <div>
              <p style="font-size:16px;font-weight:700;color:var(--color-text-primary);margin:0 0 6px">${emptyTitle}</p>
              <p style="font-size:13px;color:var(--color-text-secondary);margin:0">${emptySub}</p>
            </div>
            ${canWriteCameras() ? `
            <button type="button" class="ov-cam-add-btn" data-action="open-add" aria-label="Add camera">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14"/><path d="M12 5v14"/></svg>
              <span>Add camera</span>
            </button>` : ''}
          </div>
        </div>
        <div class="ov-merged-accent" aria-hidden="true"></div>
      </article>`;

    mountModal();
    wireCardEvents();
    return;
  }

  root.innerHTML = `
    <article class="ov-card ov-cam-mgmt">
      <div class="ov-cam-mgmt-inner">
        <div class="ov-merged-head ov-cam-mgmt-head">
          <div>
            <div class="ov-stat-headline ov-cam-mgmt-title">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"/><rect x="2" y="6" width="14" height="12" rx="2"/></svg>
              <span>Camera management</span>
            </div>
            <div class="ov-merged-sub">${document.body.dataset.detectionSlug ? (cameras.length ? `${cameras.length} camera${cameras.length === 1 ? '' : 's'} assigned to this model` : 'No cameras assigned to this model yet') : (cameras.length ? `${cameras.length} registered camera${cameras.length === 1 ? '' : 's'}` : 'No cameras yet — add your first source')}</div>
          </div>
          <div style="display:flex;gap:10px;align-items:center;">
            ${canWriteCameras() ? `
            <button type="button" class="ov-cam-add-btn" data-action="open-add" aria-label="Add camera">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14"/><path d="M12 5v14"/></svg>
              <span>Add camera</span>
            </button>` : ''}
            ${canControlDetection() && (document.body.dataset.detectionSlug === 'person' || document.body.dataset.detectionSlug === 'face') ? `
            <button type="button" class="ov-quick-btn" id="camStartAllBtn">
              Start all streams
            </button>
            <span id="camStartAllProgress" class="ov-merged-sub" style="min-width:84px;text-align:right;"></span>` : ''}
          </div>
        </div>

        <div class="ov-merged-divider" aria-hidden="true"></div>

        <div class="ov-cam-grid" id="camGrid">${renderCameraGrid()}</div>
      </div>
      <div class="ov-merged-accent" aria-hidden="true"></div>
    </article>`;

  mountModal();
  wireCardEvents();
}

function mountModal() {
  let modal = document.getElementById('camAddModal');
  if (!modal) {
    const host = document.createElement('div');
    host.id = 'camModalHost';
    document.body.appendChild(host);
  }
  const host = document.getElementById('camModalHost');
  host.innerHTML = renderModal();
  wireModalEvents();
  syncTypeFields();
}

function updateGrid() {
  const grid = document.getElementById('camGrid');
  if (grid) grid.innerHTML = renderCameraGrid();
  wireCardEvents();
}

function syncTypeFields() {
  const type = formValue('camType');
  const urlField = document.getElementById('camRtspUrl');
  const mipiWrap = document.getElementById('camMipiWrap');
  if (!urlField) return;

  const placeholders = {
    rtsp: 'rtsp://192.168.1.50:554/stream1',
    onvif: 'onvif://192.168.1.50:80/onvif/device_service',
    usb: '/dev/video0',
    ip: '192.168.1.50:554',
    http: 'http://192.168.1.50/mjpeg/stream',
    'video-file': '/var/test/footage/sample.mp4',
    'image-folder': '/var/test/frames/gate-a/',
    mipi: 'mipi-csi0',
    'local-test': 'local://test-pattern',
  };
  urlField.placeholder = placeholders[type] || 'Stream address';

  document.querySelectorAll('.ov-cam-source-chip').forEach((chip) => {
    chip.classList.toggle('active', chip.dataset.type === type);
  });

  if (mipiWrap) mipiWrap.hidden = type !== 'mipi';
}

async function startAllStreams() {
  const prog = document.getElementById('camStartAllProgress');
  const btn = document.getElementById('camStartAllBtn');
  if (!cameras.length) {
    showToast('Add cameras first');
    return;
  }
  if (!window.confirm(`Start all camera streams and ${document.body.dataset.detectionSlug === 'face' ? 'face recognition' : 'person detection'}?`)) return;
  if (btn) btn.disabled = true;
  if (prog) prog.textContent = 'Starting cameras…';

  try {
    const detSlug = document.body.dataset.detectionSlug;
    const endpoint = detSlug === 'face' ? '/api/detection/face/start-all' : '/api/detection/person/start-all';
    const res = await fetch(sessionUrl(endpoint), { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Start all failed');

    const results = data.board?.results || data.results || data.progress || [];
    const lines = results.map((r) => {
      const name = r.name || r.camera_id || r.cameraId || 'Camera';
      return r.ok === false ? `${name}: failed` : `${name}: started`;
    });
    const started = data.board?.started ?? results.filter((r) => r.ok !== false).length;
    const total = data.board?.total ?? cameras.length;
    if (prog) prog.textContent = `Started ${started}/${total}`;
    showToast(`Started ${started} camera stream(s)`);

    if (window.DetectionTab?.reload) window.DetectionTab.reload();
    const first = cameras[0]?.id;
    if (first && detSlug === 'person' && window.PersonLive?.selectCamera) {
      await window.PersonLive.selectCamera(first);
      await window.PersonLive.startStream?.(first);
    }
    if (first && detSlug === 'face' && window.FaceLive?.selectCamera) {
      await window.FaceLive.selectCamera(first);
      await window.FaceLive.startStream?.(first);
    }
  } catch (err) {
    if (prog) prog.textContent = '';
    showToast(err.message || 'Could not start all streams');
  } finally {
    if (btn) btn.disabled = false;
  }
}

function refreshStreamStates() {
  updateGrid();
}

function wireCardEvents() {
  document.querySelectorAll('[data-action="open-add"]').forEach((btn) => {
    btn.addEventListener('click', openAddModal);
  });

  document.getElementById('camStartAllBtn')?.addEventListener('click', startAllStreams);

  document.querySelectorAll('[data-action="delete"]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      handleDelete(e);
    });
  });

  document.querySelectorAll('[data-action="toggle-stream"]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      handleToggleStream(btn.dataset.id);
    });
  });

  document.querySelectorAll('.ov-cam-tile-clickable[data-id]').forEach((tile) => {
    tile.addEventListener('click', (e) => {
      if (e.target.closest('[data-action="delete"]')) return;
      if (e.target.closest('[data-action="toggle-stream"]')) return;
      navigateToCamera(tile.dataset.id);
    });
    tile.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        navigateToCamera(tile.dataset.id);
      }
    });
  });
}

function wireModalEvents() {
  document.querySelectorAll('[data-action="close-modal"]').forEach((el) => {
    el.addEventListener('click', closeAddModal);
  });

  document.getElementById('camType')?.addEventListener('change', () => {
    syncTypeFields();
    lastValidation = null;
    updateValidationPanel();
    document.getElementById('camSaveBtn')?.setAttribute('disabled', 'disabled');
  });

  document.querySelectorAll('.ov-cam-source-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const select = document.getElementById('camType');
      if (select) {
        select.value = chip.dataset.type;
        select.dispatchEvent(new Event('change'));
      }
    });
  });

  document.getElementById('camTestBtn')?.addEventListener('click', testStream);
  document.getElementById('camResetBtn')?.addEventListener('click', resetForm);
  document.getElementById('camSaveBtn')?.addEventListener('click', saveCamera);
}

function onModalKeydown(e) {
  if (e.key === 'Escape' && modalOpen) closeAddModal();
}

function preselectDetectionModel() {
  const modelId = document.body.dataset.detectionModelId;
  if (!modelId) return;
  const select = document.getElementById('camAiModels');
  if (!select) return;
  Array.from(select.options).forEach((opt) => {
    opt.selected = opt.value === modelId || opt.selected;
  });
}

function openAddModal() {
  if (!canWriteCameras()) {
    showToast('Viewers cannot add cameras');
    return;
  }
  modalOpen = true;
  lastValidation = null;
  mountModal();
  preselectDetectionModel();
  document.body.classList.add('ov-modal-open');
  document.getElementById('camName')?.focus();
}

function closeAddModal() {
  modalOpen = false;
  const modal = document.getElementById('camAddModal');
  if (modal) {
    modal.classList.remove('is-open');
    modal.hidden = true;
  }
  document.body.classList.remove('ov-modal-open');
}

function updateValidationPanel() {
  const panel = document.getElementById('camValidationPanel');
  if (panel) panel.innerHTML = renderValidationPanel();
  const saveBtn = document.getElementById('camSaveBtn');
  if (saveBtn) {
    if (lastValidation?.success) saveBtn.removeAttribute('disabled');
    else saveBtn.setAttribute('disabled', 'disabled');
  }
}

function resetForm() {
  document.getElementById('camAddForm')?.reset();
  const fps = document.getElementById('camFps');
  const res = document.getElementById('camResolution');
  const rec = document.getElementById('camRecording');
  if (fps) fps.value = '25';
  if (res) res.value = '1920x1080';
  if (rec) rec.checked = true;
  lastValidation = null;
  syncTypeFields();
  updateValidationPanel();
}

async function handleDelete(e) {
  if (!canWriteCameras()) {
    showToast('Viewers cannot remove cameras');
    return;
  }
  const btn = e.currentTarget;
  const id = btn.dataset.id;
  if (!id || !window.confirm('Remove this camera from the system?')) return;

  const isActiveCamera = window.PersonLive?.getSelectedCameraId?.() === id
    || window.FaceLive?.getSelectedCameraId?.() === id;
  if (isActiveCamera) {
    try {
      if (window.PersonLive?.getSelectedCameraId?.() === id) {
        await fetch(sessionUrl(`/api/detection/person/live/${encodeURIComponent(id)}/stop`), { method: 'POST' });
      }
      if (window.FaceLive?.getSelectedCameraId?.() === id) {
        await fetch(sessionUrl(`/api/detection/face/live/${encodeURIComponent(id)}/stop`), { method: 'POST' });
      }
    } catch {
      /* ignore */
    }
  }

  const res = await fetch(sessionUrl(`/api/cameras/${encodeURIComponent(id)}`), { method: 'DELETE' });
  if (!res.ok) {
    showToast('Could not remove camera');
    return;
  }
  const data = await res.json();
  stats = data.stats;

  if (isActiveCamera && window.PersonLive?.clearCamera) {
    window.PersonLive.clearCamera();
  }
  if (isActiveCamera && window.FaceLive?.clearCamera) {
    window.FaceLive.clearCamera();
  }

  await loadCameras();
  if (window.DetectionTab?.reload) window.DetectionTab.reload();
  showToast('Camera removed');
}

async function loadCameras() {
  try {
    const res = await fetch(sessionUrl('/api/cameras'));
    if (!res.ok) return;
    const data = await res.json();
    let list = data.cameras || [];
    const detSlug = document.body.dataset.detectionSlug;

    if (detSlug) {
      try {
        const detRes = await fetch(sessionUrl(`/api/detection/${detSlug}`));
        if (detRes.ok) {
          const detPayload = await detRes.json();
          const assignedIds = new Set((detPayload.assignedCameras || []).map((c) => c.id));
          list = list.filter((c) => assignedIds.has(c.id));
        } else {
          const modelId = document.body.dataset.detectionModelId;
          if (modelId) {
            list = list.filter((c) => Array.isArray(c.aiModels) && c.aiModels.includes(modelId));
          }
        }
      } catch {
        const modelId = document.body.dataset.detectionModelId;
        if (modelId) {
          list = list.filter((c) => Array.isArray(c.aiModels) && c.aiModels.includes(modelId));
        }
      }
    }

    cameras = list;
    stats = data.stats || { total: cameras.length, online: 0, offline: 0 };
    if (document.getElementById('camGrid')) {
      updateGrid();
    } else if (document.getElementById('cameraManagement')) {
      renderShell();
    }
    const sub = document.querySelector('.ov-cam-mgmt-head .ov-merged-sub');
    if (sub) {
      const detSlug = document.body.dataset.detectionSlug;
      sub.textContent = cameras.length
        ? detSlug
          ? `${cameras.length} camera${cameras.length === 1 ? '' : 's'} assigned to this model`
          : `${cameras.length} registered camera${cameras.length === 1 ? '' : 's'}`
        : detSlug
          ? 'No cameras assigned to this model yet'
          : 'No cameras yet — add your first source';
    }
  } catch {
    /* ignore */
  }
}

async function testStream() {
  if (isTesting) return;
  isTesting = true;
  lastValidation = null;

  const testBtn = document.getElementById('camTestBtn');
  const saveBtn = document.getElementById('camSaveBtn');
  if (testBtn) {
    testBtn.disabled = true;
    testBtn.textContent = 'Testing stream…';
  }
  if (saveBtn) saveBtn.setAttribute('disabled', 'disabled');

  const panel = document.getElementById('camValidationPanel');
  if (panel) {
    panel.innerHTML = `<div class="ov-cam-val-loading"><span class="ov-cam-spinner"></span> Running stream validation…</div>`;
  }

  const payload = getFormPayload();
  window.CameraStreamLog?.report({
    source: 'camera-management',
    step: 'test-stream',
    message: 'Test stream clicked — sending validate request',
    cameraName: payload.name,
    url: payload.rtspUrl,
    detail: { type: payload.type },
  });

  try {
    const res = await fetch(sessionUrl('/api/cameras/validate'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    lastValidation = await res.json();
    if (lastValidation.success) {
      window.CameraStreamLog?.report({
        source: 'camera-management',
        step: 'test-stream',
        message: 'Test PASSED in UI — Save camera is now enabled',
        cameraName: payload.name,
        url: payload.rtspUrl,
        detail: lastValidation.detected || null,
      });
      showToast('Stream validated successfully');
    } else {
      window.CameraStreamLog?.report({
        source: 'camera-management',
        step: 'test-stream',
        level: 'error',
        message: 'Test FAILED in UI',
        cameraName: payload.name,
        url: payload.rtspUrl,
        why: lastValidation.error || 'Validation failed',
        detail: lastValidation.checks || null,
        hint: 'Fix the RTSP URL / network, then test again',
      });
      showToast(lastValidation.error || 'Validation failed');
    }
  } catch (err) {
    lastValidation = { success: false, error: 'Network timeout', checks: {} };
    window.CameraStreamLog?.report({
      source: 'camera-management',
      step: 'test-stream',
      level: 'error',
      message: 'Test request failed (network)',
      cameraName: payload.name,
      url: payload.rtspUrl,
      why: err?.message || 'Network timeout',
    });
    showToast('Network timeout');
  } finally {
    isTesting = false;
    if (testBtn) {
      testBtn.disabled = false;
      testBtn.textContent = 'Test stream';
    }
    updateValidationPanel();
  }
}

async function saveCamera() {
  if (!lastValidation?.success) {
    showToast('Test the stream before saving');
    window.CameraStreamLog?.report({
      source: 'camera-management',
      step: 'save-camera',
      level: 'warn',
      message: 'Save blocked — test stream has not passed yet',
    });
    return;
  }

  const saveBtn = document.getElementById('camSaveBtn');
  if (saveBtn) saveBtn.disabled = true;
  const payload = getFormPayload();
  window.CameraStreamLog?.report({
    source: 'camera-management',
    step: 'save-camera',
    message: 'Save camera clicked',
    cameraName: payload.name,
    url: payload.rtspUrl,
  });

  try {
    const res = await fetch(sessionUrl('/api/cameras'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) {
      lastValidation = { success: false, error: data.error, checks: data.checks || {} };
      updateValidationPanel();
      window.CameraStreamLog?.report({
        source: 'camera-management',
        step: 'save-camera',
        level: 'error',
        message: 'Save camera failed',
        cameraName: payload.name,
        why: data.error || 'Could not save camera',
      });
      showToast(data.error || 'Could not save camera');
      if (saveBtn) saveBtn.disabled = false;
      return;
    }
    stats = data.stats;
    closeAddModal();
    const detSlug = document.body.dataset.detectionSlug;
    if (detSlug && data.camera?.id) {
      try {
        await fetch(sessionUrl(`/api/detection/${detSlug}/cameras`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cameraId: data.camera.id }),
        });
      } catch {
        /* ignore */
      }
    }
    await loadCameras();
    showToast('Saved camera');
    const savedId = data.camera?.id;
    if (savedId) {
      try {
        window.CameraStreamLog?.report({
          source: 'camera-management',
          step: 'live-sync',
          cameraId: savedId,
          cameraName: data.camera?.name,
          message: 'Requesting live?sync=1 after save (board WHEP/HLS URLs)',
        });
        await fetch(sessionUrl(`/api/cameras/${encodeURIComponent(savedId)}/live?sync=1`));
      } catch {
        /* stream sync continues in background */
      }
    }
    if (window.DetectionTab?.reload) await window.DetectionTab.reload();
    if (detSlug === 'person' && savedId && window.PersonLive?.selectCamera) {
      await window.PersonLive.selectCamera(savedId);
    }
    if (detSlug === 'face' && savedId && window.FaceLive?.selectCamera) {
      await window.FaceLive.selectCamera(savedId);
    }
  } catch (err) {
    window.CameraStreamLog?.report({
      source: 'camera-management',
      step: 'save-camera',
      level: 'error',
      message: 'Save camera network error',
      why: err?.message || 'Failed to save camera',
    });
    showToast('Failed to save camera');
    if (saveBtn) saveBtn.disabled = false;
  }
}

function openAddCameraModal() {
  const root = document.getElementById('cameraManagement');
  if (root) root.scrollIntoView({ behavior: 'smooth', block: 'start' });
  openAddModal();
}

async function ensureRoleLoaded() {
  try {
    const res = await fetch(sessionUrl('/api/session'));
    const data = await res.json();
    if (data?.userRole) window.__atomoUserRole = data.userRole;
  } catch {
    /* ignore */
  }
}

async function initCameraManagement() {
  if (!document.getElementById('cameraManagement')) return;
  const detSlug = document.body.dataset.detectionSlug;
  if (detSlug === 'fire-smoke' || detSlug === 'safety') return;
  document.addEventListener('keydown', onModalKeydown);
  await ensureRoleLoaded();
  await loadCameras();
}

window.CameraManagement = {
  reload: loadCameras,
  refreshStreamStates,
};

window.openOverviewAddCamera = openAddCameraModal;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initCameraManagement);
} else {
  initCameraManagement();
}
