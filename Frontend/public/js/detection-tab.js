const slug = document.body.dataset.detectionSlug;
let payload = null;
let previewCameraId = null;
let refreshTimer = null;
let eventSearchQuery = '';
let personSaveTimer = null;
let dashEventWs = null;
let dashWsConnected = false;
let eventsVisibleLimit = 24;
let eventsView = localStorage.getItem('detEventsView') || 'gallery'; // 'gallery' | 'table'
let eventsTablePage = 1;
/** Face tab only: 'all' | 'face' | 'line' — separate Face recognition vs Line crossed events */
let faceEventsCategory = localStorage.getItem('detFaceEventsCategory') || 'line';
// Signature of the currently-rendered event set, so periodic broadcasts don't
// rebuild the gallery (and reload every <img>) when nothing actually changed.
let lastRenderedEventsSig = null;

function eventsSignature(events) {
  return (events || []).map((e) => `${e.id}:${e.hasSnapshot}:${e.personName || ''}:${e.title || ''}`).join('|');
}

const isPersonTab = slug === 'person';
const isFaceTab = slug === 'face';
const isSubscriptionGatedTab = slug === 'fire-smoke' || slug === 'safety';

const SUBSCRIPTION_COPY = {
  'fire-smoke': {
    icon: 'fire',
    headline: 'Subscribe to unlock Fire & Smoke detection',
    summary:
      'Detect flames and smoke early across your camera fleet with tuned confidence thresholds and instant alerts.',
    features: [
      'Real-time fire and smoke detection on live streams',
      'Perimeter intrusion alerts tied to heat and smoke events',
      'Confidence tuning for indoor and outdoor cameras',
      'Event gallery with snapshots for every alert',
    ],
    planLabel: 'Add-on model',
    ctaLabel: 'Request subscription',
  },
  safety: {
    icon: 'safety',
    headline: 'Subscribe to unlock Safety & PPE',
    summary:
      'Monitor helmets, vests, and site PPE compliance in industrial zones with automated violation alerts.',
    features: [
      'PPE detection for helmets, vests, and site gear',
      'Safety violation alerts with camera and zone context',
      'Compliance monitoring for industrial floors',
      'Exportable event history for audits',
    ],
    planLabel: 'Add-on model',
    ctaLabel: 'Request subscription',
  },
};

// Person events are cropped server-side to each bbox. Client crop is fallback only.
const ENABLE_EVENT_CROP = true;
const DISABLE_EVENT_BBOX_OVERLAY = true;

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

function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function severityBadge(sev) {
  const map = {
    critical: 'ov-badge-error',
    warning: 'ov-badge-warning',
    success: 'ov-badge-success',
    info: 'ov-badge-gold',
    vip: 'ov-badge-vip',
    unauthorized: 'ov-badge-unauthorized',
    blacklist: 'ov-badge-blacklist',
    known: 'ov-badge-known',
    unknown: 'ov-badge-unknown',
  };
  return map[sev] || 'ov-badge-gold';
}

function statusBadge(running) {
  return running
    ? '<span class="ov-badge ov-badge-success">Running</span>'
    : '<span class="ov-badge ov-badge-error">Stopped</span>';
}

function subscriptionIcon(kind) {
  if (kind === 'fire') {
    return `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22c3.9 0 7-2.7 7-6.4 0-2.9-1.7-4.8-3.5-6.5C14.1 7.7 13 6 12.4 3.8c-.4 2.1-1.1 3.6-2.3 5C8.5 10.5 6.8 12.4 6.8 15.6 6.8 19.3 9.9 22 12 22Z"/><path d="M12 22c1.9 0 3.3-1.3 3.3-3.1 0-1.5-1-2.4-2.1-3.3-.4 1.1-1.3 1.8-2.3 2.2.3-1.1.2-2.2-.4-3.2-1 1-1.8 2.2-1.8 4.3 0 1.8 1.4 3.1 3.3 3.1Z"/><path d="M16.8 5.2c.7-.7 1.1-1.5 1.1-2.4"/><path d="M18.6 6.6c.9-.7 1.4-1.6 1.4-2.6"/></svg>`;
  }
  return `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2 20 6v6c0 5-3.5 9.4-8 10-4.5-.6-8-5-8-10V6l8-4Z"/><path d="M9.5 12.5 11 14l3.5-3.5"/></svg>`;
}

function hideDetectionWorkspaces() {
  ['cameraManagement', 'personLiveRoot', 'faceLiveRoot', 'faceModuleRoot'].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.hidden = true;
    el.innerHTML = '';
  });
}

function renderSubscriptionGate(tabMeta) {
  hideDetectionWorkspaces();
  const root = document.getElementById('modelControl');
  if (!root) return;

  const copy = {
    ...(SUBSCRIPTION_COPY[slug] || {}),
    ...(tabMeta?.subscription || {}),
  };
  const title = tabMeta?.pageTitle || document.getElementById('detectionPageTitle')?.textContent || 'Model';
  const features = (copy.features || [])
    .map((f) => `<li><span aria-hidden="true">✓</span><span>${esc(f)}</span></li>`)
    .join('');

  root.innerHTML = `
    <section class="ov-sub-gate" aria-label="Subscription required">
      <div class="ov-sub-gate-card">
        <div class="ov-sub-gate-badge">${esc(copy.planLabel || 'Subscription required')}</div>
        <div class="ov-sub-gate-icon ${copy.icon === 'fire' ? 'is-fire' : copy.icon === 'safety' ? 'is-safety' : ''}" aria-hidden="true">${subscriptionIcon(copy.icon)}</div>
        <h2 class="ov-sub-gate-title">${esc(copy.headline || `Subscribe to unlock ${title}`)}</h2>
        <p class="ov-sub-gate-summary">${esc(copy.summary || tabMeta?.description || '')}</p>
        <ul class="ov-sub-gate-features">${features}</ul>
        <div class="ov-sub-gate-actions">
          <button type="button" class="ov-cam-add-btn" id="detSubscribeBtn">${esc(copy.ctaLabel || 'Request subscription')}</button>
          <a class="ov-quick-btn" href="/overview">Back to Overview</a>
        </div>
        <p class="ov-sub-gate-note">This model is available as a paid add-on. Contact Atomic Centre or your Atomo admin to activate it on this device.</p>
      </div>
    </section>
  `;

  document.getElementById('detSubscribeBtn')?.addEventListener('click', () => {
    showToast('Subscription request noted — contact Atomic Centre to activate this model.');
  });
}

function renderAssignedCameras() {
  const cams = payload?.assignedCameras || [];
  if (!cams.length) {
    return '<p class="ov-det-empty">No cameras assigned to this model yet.</p>';
  }
  return cams
    .map(
      (cam) => `
    <div class="ov-det-assigned-row">
      <div>
        <div class="ov-det-assigned-name">${esc(cam.name)}</div>
        <div class="ov-det-assigned-meta">${esc(cam.location || 'No location')} · ${esc(cam.resolution || '—')}</div>
      </div>
      <div class="ov-det-assigned-actions">
        <!-- Preview hidden — use Camera management for stream view -->
        <!-- <button type="button" class="ov-quick-btn" data-action="preview-camera" data-id="${cam.id}">Preview</button> -->
        <button type="button" class="ov-quick-btn ov-det-remove-btn" data-action="remove-camera" data-id="${cam.id}">Remove</button>
      </div>
    </div>`
    )
    .join('');
}

function renderAddCameraSelect() {
  const available = payload?.availableCameras || [];
  if (!available.length) {
    return '<p class="ov-det-empty">All registered cameras are already assigned.</p>';
  }
  return `
    <div class="ov-det-add-cam-row">
      <select id="detAddCameraSelect" class="ov-det-select" aria-label="Select camera to assign">
        <option value="">Choose a camera…</option>
        ${available.map((c) => `<option value="${c.id}">${esc(c.name)} — ${esc(c.location || 'No location')}</option>`).join('')}
      </select>
      <button type="button" class="ov-cam-add-btn" id="detAddCameraBtn">Add to model</button>
    </div>`;
}

function renderZones() {
  const zones = payload?.state?.zones || [];
  return zones
    .map(
      (z, i) => `
    <div class="ov-det-zone-row" data-zone-index="${i}">
      <input type="text" class="ov-det-input" data-zone-name value="${esc(z.name)}" aria-label="Zone name">
      <label class="ov-cam-check-inline">
        <input type="checkbox" data-zone-enabled ${z.enabled ? 'checked' : ''}>
        <span>Enabled</span>
      </label>
      <button type="button" class="ov-quick-btn" data-action="remove-zone" data-index="${i}">Remove</button>
    </div>`
    )
    .join('');
}

function renderAlerts() {
  const options = payload?.tab?.alertOptions || [];
  const alerts = payload?.state?.alerts || {};
  return options
    .map(
      (opt) => `
    <label class="ov-det-alert-item">
      <input type="checkbox" data-alert-id="${opt.id}" ${alerts[opt.id] ? 'checked' : ''}>
      <span>${esc(opt.label)}</span>
    </label>`
    )
    .join('');
}

function renderPersonFeatures() {
  const options = payload?.tab?.featureOptions || [];
  const features = payload?.state?.features || {};
  return options
    .map(
      (opt) => `
    <label class="ov-det-feature-item ${opt.locked ? 'is-locked' : ''}">
      <input type="checkbox" data-feature-id="${opt.id}" ${features[opt.id] ? 'checked' : ''} ${opt.locked ? 'checked disabled' : ''}>
      <span class="ov-det-feature-copy">
        <strong>${esc(opt.label)}</strong>
        <small>${esc(opt.description)}</small>
      </span>
    </label>`
    )
    .join('');
}

function confidenceHint(pct) {
  if (pct < 50) return 'Sensitive — more detections, higher false-alert risk';
  if (pct < 75) return 'Balanced — recommended for most environments';
  return 'Strict — fewer false alerts, may miss distant people';
}

function renderPersonMetricsStrip() {
  const m = payload?.peopleMetrics || {};
  const r = payload?.report || {};
  return `
    <div class="ov-det-metrics-strip">
      <div class="ov-det-metric-pill">
        <div class="ov-det-metric-val">${m.current ?? 0}</div>
        <div class="ov-det-metric-label">People now</div>
      </div>
      <div class="ov-det-metric-pill">
        <div class="ov-det-metric-val">${r.peakPeopleToday ?? m.peakToday ?? 0}</div>
        <div class="ov-det-metric-label">Peak today</div>
      </div>
      <div class="ov-det-metric-pill">
        <div class="ov-det-metric-val">${r.eventsToday ?? 0}</div>
        <div class="ov-det-metric-label">Events today</div>
      </div>
      <div class="ov-det-metric-pill">
        <div class="ov-det-metric-val ov-det-metric-sm">${m.presenceActive ? 'Active' : 'None'}</div>
        <div class="ov-det-metric-label">Presence</div>
      </div>
    </div>`;
}

function renderPersonTuning() {
  const state = payload?.state || {};
  const pct = Math.round((state.confidence ?? 0.7) * 100);
  const minPx = state.minObjectSizePx ?? 48;
  const filterOn = Boolean(state.features?.filterSmallObjects);
  const tooManyOn = Boolean(state.alerts?.['too-many-people']);
  const maxPeople = state.maxPeopleAlert ?? 10;

  return `
    <div class="ov-det-tuning-grid">
      <div class="ov-det-tuning-card">
        <div class="ov-det-tuning-head">
          <span class="ov-det-tuning-title">Minimum confidence</span>
          <span class="ov-det-slider-val" id="detConfVal">${pct}%</span>
        </div>
        <div class="ov-det-slider-row">
          <input type="range" class="ov-det-range" id="detConfRange" min="25" max="95" step="1" value="${pct}" aria-label="Minimum detection confidence">
        </div>
        <p class="ov-det-tuning-hint" id="detConfHint">${confidenceHint(pct)}</p>
      </div>
      <div class="ov-det-tuning-card ${filterOn ? '' : 'is-disabled'}" id="detMinSizeCard">
        <div class="ov-det-tuning-head">
          <span class="ov-det-tuning-title">Min object size</span>
          <span class="ov-det-slider-val" id="detMinSizeVal">${minPx}px</span>
        </div>
        <div class="ov-det-slider-row">
          <input type="range" class="ov-det-range" id="detMinSizeRange" min="16" max="160" step="4" value="${minPx}" ${filterOn ? '' : 'disabled'} aria-label="Minimum object size in pixels">
        </div>
        <p class="ov-det-tuning-hint">Ignore detections smaller than this bounding-box size</p>
      </div>
    </div>
    <div class="ov-det-max-people-row ${tooManyOn ? '' : 'is-hidden'}" id="detMaxPeopleRow">
      <label for="detMaxPeople">Alert when count exceeds</label>
      <input type="number" class="ov-det-input ov-det-max-people-input" id="detMaxPeople" min="1" max="99" value="${maxPeople}">
      <span class="ov-det-max-people-suffix">people</span>
    </div>`;
}

function renderPersonControls() {
  const state = payload?.state || {};
  const running = state.inferenceRunning;
  const logsOn = Boolean(state.features?.peopleCountLogs);

  return `
    <article class="ov-card ov-det-model" id="personControlPanel">
      <div class="ov-det-model-inner">
        <div class="ov-merged-head ov-det-model-head">
          <div>
            <div class="ov-stat-headline ov-det-model-title">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
              <span>Person detection</span>
            </div>
            <p class="ov-det-overview-text">${esc(payload?.tab?.description || '')}</p>
          </div>
          <div class="ov-det-model-status-wrap">
            <span class="ov-det-status-label">Inference</span>
            ${statusBadge(running)}
            <button type="button" class="ov-quick-btn ${running ? 'ov-det-stop-btn' : ''}" id="detInferenceBtn">
              ${running ? 'Stop inference' : 'Start inference'}
            </button>
          </div>
        </div>

        <div class="ov-merged-divider" aria-hidden="true"></div>

        ${renderPersonMetricsStrip()}

        <section class="ov-det-section">
          <h3 class="ov-det-section-title">Detection features</h3>
          <div class="ov-det-feature-grid">${renderPersonFeatures()}</div>
        </section>

        <section class="ov-det-section">
          <h3 class="ov-det-section-title">Detection tuning</h3>
          ${renderPersonTuning()}
        </section>

        <section class="ov-det-section">
          <h3 class="ov-det-section-title">Alerts</h3>
          <div class="ov-det-alerts-grid">${renderAlerts()}</div>
        </section>

        <section class="ov-det-section">
          <div class="ov-det-section-head-row">
            <h3 class="ov-det-section-title">Restricted zones</h3>
            <button type="button" class="ov-quick-btn" id="detAddZoneBtn">Add zone</button>
          </div>
          <p class="ov-det-section-sub">Draw zones on the live video. With “Danger zone” alert on, detections inside the zone create events and can email via Alert Configuration.</p>
          <div class="ov-det-zones-list" id="detZonesList">${renderZones()}</div>
        </section>

        <section class="ov-det-section ${logsOn ? '' : 'is-hidden'}" id="detCountLogsSection">
          <h3 class="ov-det-section-title">People count logs</h3>
          ${renderLogs()}
        </section>
      </div>
      <div class="ov-merged-accent" aria-hidden="true"></div>
    </article>`;
}

function eventImageUrl(event) {
  const base = event.imageUrl || `/api/detection/events/${encodeURIComponent(event.id)}/snapshot`;
  const sid = sessionStorage.getItem('atomoSessionId');
  const sep = base.includes('?') ? '&' : '?';
  const auth = sid ? `${sep}sessionId=${encodeURIComponent(sid)}` : '';
  const bust = `${auth}${auth ? '&' : '?'}t=${encodeURIComponent(event.time || Date.now())}`;
  return `${base}${bust}`;
}

function isFaceCropEvent(event) {
  return event?.label === 'face' && (event.snapshotCropped || event.snapshotFullFrame === false);
}

function isPersonCropEvent(event) {
  return event?.label === 'person' && (event.snapshotCropped || event.snapshotFullFrame === false);
}

function isTightCropEvent(event) {
  return isFaceCropEvent(event) || isPersonCropEvent(event);
}

function isLineCrossedEvent(event) {
  if (!event) return false;
  if (event.lineCrossed === true) return true;
  const t = String(event.eventType || event.title || '').toLowerCase();
  return t === 'line-crossed' || t.includes('line crossed');
}

function eventSearchText(event) {
  return [
    event.title,
    event.eventType,
    event.label,
    event.camera,
    event.location,
    event.zone,
    event.severity,
    event.timeLabel,
    event.dateLabel,
    event.lineCrossed ? 'line crossed tripwire' : 'face recognition',
    String(formatEventConfidencePct(event)),
    event.id,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function sortEventsNewestFirst(events) {
  return [...(events || [])].sort(
    (a, b) => new Date(b.time || 0).getTime() - new Date(a.time || 0).getTime()
  );
}

function getFilteredEvents() {
  let events = sortEventsNewestFirst(payload?.events || []);
  if (isFaceTab) {
    if (faceEventsCategory === 'line') {
      events = events.filter((e) => isLineCrossedEvent(e));
    } else if (faceEventsCategory === 'face') {
      events = events.filter((e) => !isLineCrossedEvent(e));
    }
  }
  const q = eventSearchQuery.trim().toLowerCase();
  if (!q) return events;
  return events.filter((e) => eventSearchText(e).includes(q));
}

function getDisplayedEvents() {
  return getFilteredEvents().slice(0, eventsVisibleLimit);
}

function getEventsTablePageSize() {
  return 12;
}

function getEventsTableTotalPages() {
  const total = getFilteredEvents().length;
  return Math.max(1, Math.ceil(total / getEventsTablePageSize()));
}

function getDisplayedEventsForTable() {
  const totalPages = getEventsTableTotalPages();
  if (eventsTablePage > totalPages) eventsTablePage = totalPages;
  if (eventsTablePage < 1) eventsTablePage = 1;
  const start = (eventsTablePage - 1) * getEventsTablePageSize();
  return getFilteredEvents().slice(start, start + getEventsTablePageSize());
}

function updateEventCountLabel() {
  const all = payload?.events || [];
  const faceRecog = isFaceTab ? all.filter((e) => !isLineCrossedEvent(e)).length : all.length;
  const lineCross = isFaceTab ? all.filter((e) => isLineCrossedEvent(e)).length : 0;
  const shown = getFilteredEvents().length;
  const sub = document.getElementById('detEventCountLabel');
  if (!sub) return;

  if (isFaceTab) {
    if (faceEventsCategory === 'line') {
      sub.textContent = shown
        ? `${shown} line-crossed event${shown === 1 ? '' : 's'}`
        : 'No line-crossed events yet — save a tripwire, then start recognition';
    } else if (faceEventsCategory === 'face') {
      sub.textContent = shown
        ? `${shown} face recognition event${shown === 1 ? '' : 's'}`
        : 'No face recognition events yet';
    } else {
      sub.textContent = `${faceRecog} face · ${lineCross} line crossed`;
    }
    return;
  }

  if (eventSearchQuery.trim()) {
    sub.textContent = shown
      ? `${shown} of ${all.length} event${all.length === 1 ? '' : 's'} match`
      : `No matches in ${all.length} event${all.length === 1 ? '' : 's'}`;
  } else {
    sub.textContent = all.length
      ? `${all.length} detection event${all.length === 1 ? '' : 's'}`
      : 'No detection events yet';
  }
}

function formatEventConfidencePct(event) {
  let c = Number(event?.confidence);
  if (!Number.isFinite(c) || c <= 0) {
    const match = Number(event?.matchConfidence);
    const det = Number(event?.detectionConfidence);
    if (Number.isFinite(match) && match > 0) c = match;
    else if (Number.isFinite(det) && det > 0) c = det;
    else c = event?.isKnown ? 0.72 : 0.55;
  }
  if (c > 1) c /= 100;
  return Math.max(1, Math.min(100, Math.round(c * 100)));
}

function renderEventCard(e) {
  // Server already crops person events to bbox. Client crop only if full-frame slipped through.
  const needsClientCrop = ENABLE_EVENT_CROP
    && !e.snapshotAnnotated
    && !e.snapshotCropped
    && e.snapshotFullFrame
    && e.bbox
    && e.bbox.length >= 4;
  const bboxAttr = needsClientCrop ? ` data-bbox="${esc(JSON.stringify(e.bbox))}"` : '';
  const cropClass = needsClientCrop ? ' has-bbox-crop' : '';
  const sev = String(e.severity || '').toLowerCase();
  const sevClass = sev ? ` is-sev-${esc(sev)}` : '';
  const isFaceCrop = isFaceCropEvent(e);
  const isPersonCrop = isPersonCropEvent(e);
  const tightCrop = isFaceCrop || isPersonCrop;
  const faceCardClass = e.label === 'face' ? ' ov-det-event-card--face' : '';
  const lineCardClass = isLineCrossedEvent(e) ? ' ov-det-event-card--line-cross' : '';
  const personCardClass = isPersonCrop ? ' ov-det-event-card--person-crop' : '';
  const faceImgClass = isFaceCrop ? ' ov-det-event-img--face-crop' : '';
  const personImgClass = isPersonCrop ? ' ov-det-event-img--person-crop' : '';

  return `
      <article class="ov-det-event-card${faceCardClass}${lineCardClass}${personCardClass}${sevClass}" role="listitem" data-event-id="${esc(e.id)}" tabindex="0">
        <button type="button" class="ov-det-event-thumb-btn" data-action="open-event" data-event-id="${esc(e.id)}" aria-label="View detection: ${esc(e.title)}">
          <div class="ov-det-event-thumb${tightCrop ? ' ov-det-event-thumb--tight-crop' : ''}${isFaceCrop ? ' ov-det-event-thumb--face-crop' : ''}">
            <img
              src="${eventImageUrl(e)}"
              alt="Detection snapshot: ${esc(e.title)}"
              class="ov-det-event-img${faceImgClass}${personImgClass} ${e.hasSnapshot ? '' : 'ov-det-event-img-placeholder'}${cropClass}"
              ${bboxAttr}
              loading="lazy"
              decoding="async"
              onerror="this.onerror=null;this.style.display='none';const fb=this.nextElementSibling;if(fb){fb.style.display='flex'}"
            >
            <div class="ov-det-event-img-fallback" style="display:none;align-items:center;justify-content:center;width:100%;height:100%;background:#0f172a;flex-direction:column;gap:6px;">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#475569" stroke-width="1.5"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>
              <span style="font-size:10px;color:#475569;font-family:Inter,sans-serif">${formatEventConfidencePct(e)}%</span>
            </div>
            <div class="ov-det-event-thumb-overlay">
              <span class="ov-badge ${severityBadge(e.severity)}">${esc(e.severity)}</span>
              <span class="ov-det-event-conf ov-mono">${formatEventConfidencePct(e)}%</span>
            </div>
            <span class="ov-det-event-time-badge ov-mono">${esc(e.timeLabel)}</span>
          </div>
        </button>
        <div class="ov-det-event-details">
          <h4 class="ov-det-event-title">${esc(e.title || e.eventType)}</h4>
          <dl class="ov-det-event-meta">
            <div class="ov-det-event-meta-row">
              <dt>Type</dt>
              <dd>${esc(isLineCrossedEvent(e)
                ? 'Line crossed'
                : (e.label === 'face'
                  ? (e.isKnown ? 'Recognized face' : 'Face recognition')
                  : (e.label || 'person')))}</dd>
            </div>
            <div class="ov-det-event-meta-row">
              <dt>Camera</dt>
              <dd>${esc(e.camera)}</dd>
            </div>
            <div class="ov-det-event-meta-row">
              <dt>${e.label === 'face' ? 'Person' : 'Track ID'}</dt>
              <dd>${e.label === 'face' ? esc(e.personName || (e.isKnown ? 'Known' : 'Unknown')) : (e.trackingId != null ? esc(`#${e.trackingId}`) : '—')}</dd>
            </div>
            <div class="ov-det-event-meta-row">
              <dt>Location</dt>
              <dd>${esc(e.location || '—')}</dd>
            </div>
            <div class="ov-det-event-meta-row">
              <dt>Zone</dt>
              <dd>${esc(e.zone || '—')}</dd>
            </div>
            <div class="ov-det-event-meta-row">
              <dt>Confidence</dt>
              <dd>${formatEventConfidencePct(e)}%${e.label === 'face' ? (e.isKnown ? ' match' : ' detect') : ''}</dd>
            </div>
            <div class="ov-det-event-meta-row">
              <dt>Captured</dt>
              <dd>${esc(e.dateLabel || '')} · ${esc(e.timeLabel)}</dd>
            </div>
          </dl>
        </div>
      </article>`;
}

function renderEventCards(events) {
  const displayed = events.length ? events : getDisplayedEvents();
  const total = getFilteredEvents().length;
  const hasMore = total > displayed.length;

  if (!displayed.length) {
    const q = eventSearchQuery.trim();
    if (q) return `<p class="ov-det-empty">No events match "${esc(q)}".</p>`;
    return `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:52px 24px;gap:12px;text-align:center;">
        <div style="width:56px;height:56px;border-radius:50%;background:var(--color-background-secondary,#f1f5f9);display:flex;align-items:center;justify-content:center;">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-tertiary,#94a3b8)" stroke-width="1.5" aria-hidden="true">
            <path d="M3 3v18h18"/><path d="m7 16 4-5 4 3 5-7"/>
          </svg>
        </div>
        <div>
          <p style="font-size:14px;font-weight:600;color:var(--color-text-primary);margin:0 0 4px">No detection events yet</p>
          <p style="font-size:12px;color:var(--color-text-secondary);margin:0">${isFaceTab ? 'Start face recognition to record detection photos' : 'Start detection to begin recording person events'}</p>
        </div>
      </div>`;
  }

  return `
    <div class="ov-det-gallery${isFaceTab ? ' ov-det-gallery--face' : ''}" role="list">
      ${displayed.map((e) => renderEventCard(e)).join('')}
    </div>
    ${hasMore ? `<div style="text-align:center;padding:16px 0;"><button type="button" class="ov-quick-btn" id="detEventsLoadMore">Load more (${total - displayed.length} remaining)</button></div>` : ''}`;
}

function renderEventsLightbox() {
  return `
    <div class="ov-det-event-lightbox" id="detEventLightbox" hidden>
      <div class="ov-det-event-lightbox-backdrop" data-action="close-event"></div>
      ${getDefaultLightboxDialogHtml()}
    </div>`;
}

function getDefaultLightboxDialogHtml() {
  return `
      <div class="ov-det-event-lightbox-dialog" role="dialog" aria-modal="true" aria-labelledby="detEventLightboxTitle">
        <header class="ov-det-event-lightbox-header">
          <p class="ov-det-event-lightbox-meta ov-mono" id="detEventLightboxMeta"></p>
          <div class="ov-det-event-lightbox-actions">
            <div class="ov-det-event-lightbox-zoom" role="group" aria-label="Zoom image">
              <button type="button" class="ov-quick-btn ov-det-event-zoom-btn" id="detEventZoomOutBtn" title="Zoom out" aria-label="Zoom out">−</button>
              <button type="button" class="ov-quick-btn ov-det-event-zoom-btn" id="detEventZoomResetBtn" title="Reset zoom">Reset</button>
              <button type="button" class="ov-quick-btn ov-det-event-zoom-btn" id="detEventZoomInBtn" title="Zoom in" aria-label="Zoom in">+</button>
            </div>
            <a class="ov-quick-btn ov-det-event-download-btn" id="detEventDownloadBtn" download>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>
              <span>Download</span>
            </a>
            <button type="button" class="ov-modal-close" data-action="close-event" aria-label="Close event view">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg>
            </button>
          </div>
        </header>
        <div class="ov-det-event-lightbox-media" id="detEventLightboxMedia"></div>
        <div class="ov-det-event-lightbox-info" id="detEventLightboxInfo"></div>
      </div>`;
}

function detectionEventDisplayTitle(event) {
  if (event.label === 'face') {
    if (event.isKnown && event.personName) return `Recognized: ${event.personName}`;
    if (isLineCrossedEvent(event)) return event.title || 'Line Crossed';
    return event.title || event.eventType || 'Face recognition';
  }
  return event.eventType || event.title || 'Person Detected';
}

function detectionEventIdentityLabel(event) {
  return event.label === 'face' ? 'Person' : 'Track ID';
}

function detectionEventIdentityValue(event) {
  if (event.label === 'face') {
    return event.personName || (event.isKnown ? 'Known' : 'Unknown');
  }
  return event.trackingId != null ? `#${event.trackingId}` : '—';
}

function detectionEventImageBadge(event) {
  if (event.label === 'face') {
    if (event.isKnown && event.personName) return esc(event.personName).toUpperCase();
    return 'UNKNOWN';
  }
  // Person photo stays clean — no track-id chip on the image (shown in details).
  return '';
}

function detectionEventBadgeClass(event) {
  if (event.label === 'face') return event.isKnown ? 'is-known' : 'is-unknown';
  return 'is-person';
}

function detectionEventTypeLabel(event) {
  if (event.label === 'face') return 'Face Detection';
  if (event.label === 'person') return 'Person Detection';
  return esc(event.label || 'Detection');
}

function detectionEventConfidenceLabel(event) {
  const pct = formatEventConfidencePct(event);
  if (event.label === 'face' && event.isKnown) return `${pct}% Match`;
  return `${pct}% Detect`;
}

function shouldProEventCrop(event) {
  const bbox = resolveEventBbox(event);
  // Fallback only: if server could not crop, crop in the browser to the person bbox.
  return Boolean(
    ENABLE_EVENT_CROP
    && bbox
    && (event.label === 'person' || event.label === 'face')
    && !event.snapshotAnnotated
    && !event.snapshotCropped
    && event.snapshotFullFrame !== false
  );
}

function wireProEventImageCrop(event) {
  const img = document.getElementById('detEventZoomImg');
  if (!img || !shouldProEventCrop(event)) return;
  const bbox = resolveEventBbox(event);
  const isPerson = event.label === 'person';
  const run = () => {
    if (img.dataset.cropApplied === 'true' || !img.naturalWidth) return;
    img.dataset.cropApplied = 'true';
    cropEventImageToBbox(img, bbox, isPerson ? 3 / 4 : 16 / 9, { letterbox: false, tight: true, pad: 0.06 });
  };
  if (img.complete) run();
  else img.addEventListener('load', run, { once: true });
}

function renderDetectionEventProDialog(event, eventId) {
  const title = detectionEventDisplayTitle(event);
  const identityLabel = detectionEventIdentityLabel(event);
  const identityValue = detectionEventIdentityValue(event);
  const badge = detectionEventImageBadge(event);
  const captured = `${event.dateLabel || ''} ${event.timeLabel || ''}`.trim();
  const confLabel = detectionEventConfidenceLabel(event);
  const typeLabel = detectionEventTypeLabel(event);
  const badgeClass = detectionEventBadgeClass(event);
  const bbox = resolveEventBbox(event);
  const bboxAttr = shouldProEventCrop(event) ? ` data-bbox="${esc(JSON.stringify(bbox))}"` : '';
  const proClass = event.label === 'person' ? ' ov-face-event-pro--person' : '';
  const showImgBadge = Boolean(badge);

  return `
    <div class="ov-face-event-pro${proClass}" role="dialog" aria-modal="true" aria-labelledby="detEventLightboxTitle">
      <header class="ov-face-event-pro__header">
        <div class="ov-face-event-pro__header-meta">
          <span class="ov-face-event-pro__meta-item">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
            ${esc(event.camera || 'Camera')}
          </span>
          <span class="ov-face-event-pro__meta-sep" aria-hidden="true"></span>
          <span class="ov-face-event-pro__meta-item">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>
            ${esc(event.dateLabel || '—')}
          </span>
          <span class="ov-face-event-pro__meta-sep" aria-hidden="true"></span>
          <span class="ov-face-event-pro__meta-item">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
            ${esc(event.timeLabel || '—')}
          </span>
        </div>
        <div class="ov-face-event-pro__header-actions">
          <a class="ov-face-event-pro__download" id="detEventDownloadBtn" href="${eventImageUrl(event)}" download="${esc((event.camera || 'camera').replace(/\s+/g, '_'))}_${esc(eventId)}.jpg">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>
            Download
          </a>
          <button type="button" class="ov-face-event-pro__close" data-action="close-event" aria-label="Close event view">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg>
          </button>
        </div>
      </header>

      <div class="ov-face-event-pro__body">
        <figure class="ov-face-event-pro__visual">
          <div class="ov-face-event-pro__frame">
            <img
              src="${eventImageUrl(event)}"
              alt="Detection snapshot: ${esc(title)}"
              id="detEventZoomImg"
              class="ov-face-event-pro__img"
              loading="eager"
              decoding="async"
              ${bboxAttr}
            >
            ${showImgBadge ? `<span class="ov-face-event-pro__img-badge ${badgeClass}">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
              ${badge}
            </span>` : ''}
          </div>
        </figure>

        <div class="ov-face-event-pro__details">
          <div class="ov-face-event-pro__details-head">
            <h3 id="detEventLightboxTitle" class="ov-face-event-pro__title">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>
              ${esc(title)}
            </h3>
            <div class="ov-face-event-pro__badges">
              <span class="ov-face-event-pro__pill is-warning">${esc(event.severity || 'warning')}</span>
              <span class="ov-face-event-pro__pill is-confidence">${formatEventConfidencePct(event)}% CONFIDENCE</span>
            </div>
          </div>

          <div class="ov-face-event-pro__grid">
            <div class="ov-face-event-pro__field">
              <span class="ov-face-event-pro__field-icon" aria-hidden="true">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/></svg>
              </span>
              <div>
                <span class="ov-face-event-pro__field-label">Type</span>
                <span class="ov-face-event-pro__field-value">${typeLabel}</span>
              </div>
            </div>
            <div class="ov-face-event-pro__field">
              <span class="ov-face-event-pro__field-icon" aria-hidden="true">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>
              </span>
              <div>
                <span class="ov-face-event-pro__field-label">Zone</span>
                <span class="ov-face-event-pro__field-value">${esc(event.zone || '—')}</span>
              </div>
            </div>
            <div class="ov-face-event-pro__field">
              <span class="ov-face-event-pro__field-icon" aria-hidden="true">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"/><rect x="2" y="6" width="14" height="12" rx="2"/></svg>
              </span>
              <div>
                <span class="ov-face-event-pro__field-label">Camera</span>
                <span class="ov-face-event-pro__field-value">${esc(event.camera || '—')}</span>
              </div>
            </div>
            <div class="ov-face-event-pro__field">
              <span class="ov-face-event-pro__field-icon" aria-hidden="true">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
              </span>
              <div>
                <span class="ov-face-event-pro__field-label">Captured</span>
                <span class="ov-face-event-pro__field-value">${esc(captured || '—')}</span>
              </div>
            </div>
            <div class="ov-face-event-pro__field">
              <span class="ov-face-event-pro__field-icon" aria-hidden="true">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
              </span>
              <div>
                <span class="ov-face-event-pro__field-label">${identityLabel}</span>
                <span class="ov-face-event-pro__field-value">${esc(identityValue)}</span>
              </div>
            </div>
            <div class="ov-face-event-pro__field">
              <span class="ov-face-event-pro__field-icon" aria-hidden="true">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v18h18"/><path d="m7 16 4-5 4 3 5-7"/></svg>
              </span>
              <div>
                <span class="ov-face-event-pro__field-label">Confidence</span>
                <span class="ov-face-event-pro__field-value">${confLabel}</span>
              </div>
            </div>
            <div class="ov-face-event-pro__field ov-face-event-pro__field--wide">
              <span class="ov-face-event-pro__field-icon" aria-hidden="true">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9h18v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9Z"/><path d="M3 9V7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2"/></svg>
              </span>
              <div>
                <span class="ov-face-event-pro__field-label">Location</span>
                <span class="ov-face-event-pro__field-value">${esc(event.location || '—')}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>`;
}

function renderEventsSearchBar() {
  return `
    <label class="ov-det-events-search" for="detEventSearch">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
      <input
        type="search"
        id="detEventSearch"
        placeholder="Search events, camera, zone…"
        value="${esc(eventSearchQuery)}"
        aria-label="Search detection events"
        autocomplete="off"
      >
    </label>`;
}

function renderEventsViewToggle() {
  const isGallery = eventsView === 'gallery';
  const isTable = eventsView === 'table';
  return `
    <div class="ov-det-events-view-toggle" role="group" aria-label="Event view">
      <button type="button" class="ov-quick-btn ov-det-events-view-btn ${isGallery ? 'is-active' : ''}" data-action="events-view" data-view="gallery">Gallery</button>
      <button type="button" class="ov-quick-btn ov-det-events-view-btn ${isTable ? 'is-active' : ''}" data-action="events-view" data-view="table">List</button>
    </div>`;
}

function refreshEventsGallery() {
  const host = document.getElementById('detEventsGalleryHost');
  if (host) host.innerHTML = (eventsView === 'table') ? renderEventsTable() : renderEventCards(getDisplayedEvents());
  lastRenderedEventsSig = eventsSignature(payload?.events);
  updateEventCountLabel();
  wireGalleryEvents();
  document.getElementById('detEventsLoadMore')?.addEventListener('click', () => {
    eventsVisibleLimit += 24;
    refreshEventsGallery();
  });
}

function renderEventsGallery() {
  return `${renderEventCards(getDisplayedEvents())}${renderEventsLightbox()}`;
}

function openProDetectionEventLightbox(box, event, eventId) {
  box.innerHTML = `
    <div class="ov-det-event-lightbox-backdrop" data-action="close-event"></div>
    <div class="ov-det-event-lightbox-dialog ov-det-event-lightbox-dialog--face-pro">
      ${renderDetectionEventProDialog(event, eventId)}
    </div>`;
  box.querySelectorAll('[data-action="close-event"]').forEach((el) => {
    el.addEventListener('click', closeEventLightbox);
  });
  wireProEventImageCrop(event);
  box.hidden = false;
  box.classList.add('is-open');
  document.body.classList.add('ov-modal-open');
}

function openEventLightbox(eventId) {
  const event = (payload?.events || []).find((e) => e.id === eventId);
  const box = document.getElementById('detEventLightbox');
  if (!event || !box) return;

  const useProDialog = event.label === 'face' || event.label === 'person';

  if (useProDialog) {
    openProDetectionEventLightbox(box, event, eventId);
    return;
  }

  box.innerHTML = `
    <div class="ov-det-event-lightbox-backdrop" data-action="close-event"></div>
    ${getDefaultLightboxDialogHtml()}`;
  box.querySelectorAll('[data-action="close-event"]').forEach((el) => {
    el.addEventListener('click', closeEventLightbox);
  });

  const media = document.getElementById('detEventLightboxMedia');
  const info = document.getElementById('detEventLightboxInfo');
  const meta = document.getElementById('detEventLightboxMeta');
  const dl = document.getElementById('detEventDownloadBtn');
  const isFaceCrop = isFaceCropEvent(event);
  const dialog = box.querySelector('.ov-det-event-lightbox-dialog');
  if (dialog) {
    dialog.classList.toggle('ov-det-event-lightbox-dialog--face', isFaceCrop);
  }
  if (media) {
    const bbox = resolveEventBbox(event);
    const shouldCrop = ENABLE_EVENT_CROP
      && bbox
      && !event.snapshotAnnotated
      && !event.snapshotCropped
      && event.snapshotFullFrame !== false
      && (event.label === 'person' || event.label === 'face');
    if (isFaceCrop) media.classList.add('ov-det-event-lightbox-media--face-crop');
    else media.classList.remove('ov-det-event-lightbox-media--face-crop');
    if (isFaceCrop) {
      media.innerHTML = `
        <figure class="ov-det-event-lightbox-face-frame">
          <img
            src="${eventImageUrl(event)}"
            alt="Detection snapshot: ${esc(event.title)}"
            id="detEventZoomImg"
            class="ov-det-event-lightbox-face-img"
            loading="eager"
            decoding="async"
          >
        </figure>`;
    } else {
      media.innerHTML = `
      <div id="detEventZoomStage" class="ov-det-event-zoom-stage">
        <div id="detEventZoomContent" class="ov-det-event-zoom-content">
          <img src="${eventImageUrl(event)}" alt="Detection snapshot: ${esc(event.title)}" id="detEventZoomImg" class="ov-det-event-lightbox-img"${shouldCrop ? ` data-bbox="${esc(JSON.stringify(bbox))}"` : ''}>
        </div>
      </div>`;
    }
  }
  if (info) {
    info.innerHTML = `
      <div class="ov-det-event-lightbox-info-head">
        <h3 id="detEventLightboxTitle" class="ov-det-event-lightbox-title">${esc(event.title)}</h3>
        <div class="ov-det-event-lightbox-badges">
          <span class="ov-badge ${severityBadge(event.severity)}">${esc(event.severity)}</span>
          <span class="ov-badge ov-badge-gold ov-mono">${formatEventConfidencePct(event)}% confidence</span>
        </div>
      </div>
      <dl class="ov-det-event-meta ov-det-event-meta-lightbox">
        <div class="ov-det-event-meta-row"><dt>Type</dt><dd>${esc(event.label || 'person')}</dd></div>
        <div class="ov-det-event-meta-row"><dt>Camera</dt><dd>${esc(event.camera)}</dd></div>
        <div class="ov-det-event-meta-row"><dt>${event.label === 'face' ? 'Person' : 'Track ID'}</dt><dd>${event.label === 'face' ? esc(event.personName || (event.isKnown ? 'Known' : 'Unknown')) : (event.trackingId != null ? `#${esc(String(event.trackingId))}` : '—')}</dd></div>
        <div class="ov-det-event-meta-row"><dt>Location</dt><dd>${esc(event.location || '—')}</dd></div>
        <div class="ov-det-event-meta-row"><dt>Zone</dt><dd>${esc(event.zone || '—')}</dd></div>
        <div class="ov-det-event-meta-row"><dt>Captured</dt><dd>${esc(event.dateLabel || '')} · ${esc(event.timeLabel)}</dd></div>
        <div class="ov-det-event-meta-row"><dt>Confidence</dt><dd>${formatEventConfidencePct(event)}%${event.label === 'face' ? (event.isKnown ? ' match' : ' detect') : ''}</dd></div>
      </dl>`;
  }

  if (meta) {
    meta.textContent = `${event.camera || 'Camera'} · ${formatEventConfidencePct(event)}% · ${event.dateLabel || ''} ${event.timeLabel || ''}`.trim();
  }
  if (dl) {
    dl.href = eventImageUrl(event);
    dl.setAttribute('download', `${(event.camera || 'camera').replace(/\s+/g, '_')}_${eventId}.jpg`);
  }

  // Pan/zoom — disabled for pre-cropped face snapshots.
  const stage = document.getElementById('detEventZoomStage');
  const content = document.getElementById('detEventZoomContent');
  const img = document.getElementById('detEventZoomImg');
  const eventBbox = resolveEventBbox(event);
  const zoomIn = document.getElementById('detEventZoomInBtn');
  const zoomOut = document.getElementById('detEventZoomOutBtn');
  const zoomReset = document.getElementById('detEventZoomResetBtn');

  const hideZoom = isFaceCrop;
  if (zoomIn) zoomIn.style.display = hideZoom ? 'none' : '';
  if (zoomOut) zoomOut.style.display = hideZoom ? 'none' : '';
  if (zoomReset) zoomReset.style.display = hideZoom ? 'none' : '';
  if (zoomIn?.parentElement) zoomIn.parentElement.style.display = hideZoom ? 'none' : '';

  const applyLightboxCrop = () => {
    if (!img || isFaceCrop || isPersonCropEvent(event) || !ENABLE_EVENT_CROP || event.snapshotAnnotated || event.snapshotCropped || !eventBbox || event.snapshotFullFrame === false) return;
    if (img.dataset.cropApplied === 'true') return;
    img.dataset.cropApplied = 'true';
    cropEventImageToBbox(img, eventBbox, event.label === 'person' ? 3 / 4 : 16 / 9, { letterbox: false, tight: true, pad: 0.08 });
  };
  if (img) {
    if (img.complete) applyLightboxCrop();
    else img.addEventListener('load', applyLightboxCrop, { once: true });
  }

  if (stage && content && img && !isFaceCrop) {
    let scale = 1;
    let tx = 0;
    let ty = 0;
    let dragging = false;
    let startX = 0;
    let startY = 0;

    const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
    const apply = () => {
      content.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    };
    const setScale = (next, cx = 0, cy = 0) => {
      const prev = scale;
      scale = clamp(next, 1, 6);
      tx = cx - ((cx - tx) * (scale / prev));
      ty = cy - ((cy - ty) * (scale / prev));
      apply();
    };

    stage.onwheel = (e) => {
      e.preventDefault();
      const r = stage.getBoundingClientRect();
      const cx = e.clientX - r.left;
      const cy = e.clientY - r.top;
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      setScale(scale * delta, cx, cy);
    };

    stage.onpointerdown = (e) => {
      dragging = true;
      startX = e.clientX - tx;
      startY = e.clientY - ty;
      img.style.cursor = 'grabbing';
      stage.setPointerCapture(e.pointerId);
    };
    stage.onpointermove = (e) => {
      if (!dragging) return;
      tx = e.clientX - startX;
      ty = e.clientY - startY;
      apply();
    };
    stage.onpointerup = () => {
      dragging = false;
      img.style.cursor = 'grab';
    };

    zoomIn && (zoomIn.onclick = () => setScale(scale * 1.2, stage.clientWidth / 2, stage.clientHeight / 2));
    zoomOut && (zoomOut.onclick = () => setScale(scale / 1.2, stage.clientWidth / 2, stage.clientHeight / 2));
    zoomReset && (zoomReset.onclick = () => {
      scale = 1;
      tx = 0;
      ty = 0;
      apply();
    });

    apply();
  }

  box.hidden = false;
  box.classList.add('is-open');
  document.body.classList.add('ov-modal-open');
}

function closeEventLightbox() {
  const box = document.getElementById('detEventLightbox');
  if (!box) return;
  box.hidden = true;
  box.classList.remove('is-open');
  document.body.classList.remove('ov-modal-open');
  box.innerHTML = `
    <div class="ov-det-event-lightbox-backdrop" data-action="close-event"></div>
    ${getDefaultLightboxDialogHtml()}`;
}

function renderEventsTable() {
  const displayed = getDisplayedEventsForTable();
  const total = getFilteredEvents().length;
  const totalPages = getEventsTableTotalPages();

  if (!displayed.length) {
    const q = eventSearchQuery.trim();
    if (q) return `<p class="ov-det-empty">No events match "${esc(q)}".</p>`;
    return `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:52px 24px;gap:12px;text-align:center;">
        <div style="width:56px;height:56px;border-radius:50%;background:var(--color-background-secondary,#f1f5f9);display:flex;align-items:center;justify-content:center;">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-tertiary,#94a3b8)" stroke-width="1.5" aria-hidden="true">
            <path d="M3 3v18h18"/><path d="m7 16 4-5 4 3 5-7"/>
          </svg>
        </div>
        <div>
          <p style="font-size:14px;font-weight:600;color:var(--color-text-primary);margin:0 0 4px">No detection events yet</p>
          <p style="font-size:12px;color:var(--color-text-secondary);margin:0">${isFaceTab ? 'Start face recognition to record detection photos' : 'Start detection to begin recording person events'}</p>
        </div>
      </div>`;
  }

  const serviceName = payload?.tab?.title || (isFaceTab ? 'Face Recognition' : isPersonTab ? 'Person Detection' : (slug || 'Detection'));

  return `
    <div class="ov-det-event-list-wrap">
      <div class="ov-det-event-list-head">
        <div class="ov-det-event-list-col is-thumb">Event</div>
        <div class="ov-det-event-list-col is-details">Details</div>
        <div class="ov-det-event-list-col is-service">Service</div>
        <div class="ov-det-event-list-col is-camera">Camera</div>
        <div class="ov-det-event-list-col is-time">Date &amp; Time</div>
      </div>
      <div class="ov-det-event-list-body" role="list">
        ${displayed.map((e) => {
          const faceCrop = isFaceCropEvent(e);
          return `
          <button type="button" class="ov-det-event-row" role="listitem" data-action="open-event" data-event-id="${esc(e.id)}">
            <div class="ov-det-event-row-thumb${faceCrop ? ' ov-det-event-row-thumb--face-crop' : ''}">
              <img src="${eventImageUrl(e)}" alt="Detection snapshot: ${esc(e.title)}" loading="lazy" decoding="async"
                onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
              <div class="ov-det-event-row-thumb-fallback" style="display:none;">
                <span class="ov-badge ${severityBadge(e.severity)}">${esc(e.severity)}</span>
              </div>
            </div>
            <div class="ov-det-event-row-cell">
              <div class="ov-det-event-row-title">${esc(e.title || e.eventType)}</div>
              <div class="ov-det-event-row-sub ov-mono">${formatEventConfidencePct(e)}%</div>
            </div>
            <div class="ov-det-event-row-cell">
              <div class="ov-det-event-row-title">${esc(e.label || '—')}</div>
              <div class="ov-det-event-row-sub">${esc(e.personName || (e.isKnown ? 'Known' : 'Unknown') || (e.trackingId != null ? `#${e.trackingId}` : '—'))}</div>
            </div>
            <div class="ov-det-event-row-cell">
              <div class="ov-det-event-row-title">${esc(serviceName)}</div>
              <div class="ov-det-event-row-sub">${esc(e.severity || '')}</div>
            </div>
            <div class="ov-det-event-row-cell">
              <div class="ov-det-event-row-title">${esc(e.camera || '—')}</div>
              <div class="ov-det-event-row-sub">${esc(e.location || '—')}</div>
            </div>
            <div class="ov-det-event-row-cell">
              <div class="ov-det-event-row-title">${esc(e.dateLabel || '')}</div>
              <div class="ov-det-event-row-sub ov-mono">${esc(e.timeLabel || '')}</div>
            </div>
          </button>
        `;
        }).join('')}
      </div>

      <div class="ov-det-event-list-foot">
        <div class="ov-det-event-list-count">${total} event${total === 1 ? '' : 's'}</div>
        <div class="ov-det-event-list-pager" role="group" aria-label="Pagination">
          <button type="button" class="ov-quick-btn" id="detEventsPrevPage" ${eventsTablePage <= 1 ? 'disabled' : ''}>Prev</button>
          <span class="ov-mono">Page ${eventsTablePage} / ${totalPages}</span>
          <button type="button" class="ov-quick-btn" id="detEventsNextPage" ${eventsTablePage >= totalPages ? 'disabled' : ''}>Next</button>
        </div>
      </div>
    </div>
    ${renderEventsLightbox()}`;
}

function renderLogs() {
  const logs = payload?.logs || [];
  return `<div class="ov-det-logs">${logs.map((line) => `<div class="ov-det-log-line">${esc(line)}</div>`).join('')}</div>`;
}

function renderPreview() {
  const cams = payload?.assignedCameras || [];
  const selected = cams.find((c) => c.id === previewCameraId) || cams[0] || null;
  if (!selected) {
    return `
      <div class="ov-det-preview ov-det-preview-empty">
        <div class="ov-det-preview-placeholder">Assign a camera to view live preview</div>
      </div>`;
  }
  previewCameraId = selected.id;
  return `
    <div class="ov-det-preview">
      <div class="ov-det-preview-frame">
        <div class="ov-det-preview-sim" aria-hidden="true"></div>
        <div class="ov-det-preview-overlay">
          <span class="ov-badge ov-badge-success">LIVE</span>
          <span>${esc(selected.name)}</span>
        </div>
      </div>
      <div class="ov-det-preview-meta">
        <span>${esc(selected.resolution || '—')} · ${selected.fpsLimit || '—'} fps</span>
        <a href="${sessionUrl(`/cameras/${encodeURIComponent(selected.id)}`)}" class="ov-det-preview-link">Open full view</a>
      </div>
    </div>`;
}

function renderReports() {
  const r = payload?.report || {};
  return `
    <div class="ov-det-report-grid">
      <div class="ov-det-report-card">
        <div class="ov-det-report-val">${r.eventsToday ?? 0}</div>
        <div class="ov-det-report-label">Events today</div>
      </div>
      <div class="ov-det-report-card">
        <div class="ov-det-report-val">${r.avgConfidence ?? 0}%</div>
        <div class="ov-det-report-label">Avg confidence</div>
      </div>
      <div class="ov-det-report-card">
        <div class="ov-det-report-val">${r.activeCameras ?? 0}</div>
        <div class="ov-det-report-label">Active cameras</div>
      </div>
      <div class="ov-det-report-card">
        <div class="ov-det-report-val ov-det-report-sm">${esc(r.inferenceUptime || '—')}</div>
        <div class="ov-det-report-label">Inference uptime</div>
      </div>
    </div>`;
}


function renderFaceEventsCategoryTabs() {
  if (!isFaceTab) return '';
  const all = payload?.events || [];
  const faceN = all.filter((e) => !isLineCrossedEvent(e)).length;
  const lineN = all.filter((e) => isLineCrossedEvent(e)).length;
  return `
        <div class="ov-det-events-cat-tabs" role="tablist" aria-label="Face event categories">
          <button type="button" role="tab" class="ov-det-events-cat-btn ${faceEventsCategory === 'line' ? 'is-active' : ''}" data-action="face-events-cat" data-cat="line" aria-selected="${faceEventsCategory === 'line'}">
            Line crossed <span class="ov-det-events-cat-count">${lineN}</span>
          </button>
          <button type="button" role="tab" class="ov-det-events-cat-btn ${faceEventsCategory === 'face' ? 'is-active' : ''}" data-action="face-events-cat" data-cat="face" aria-selected="${faceEventsCategory === 'face'}">
            Face recognition <span class="ov-det-events-cat-count">${faceN}</span>
          </button>
          <button type="button" role="tab" class="ov-det-events-cat-btn ${faceEventsCategory === 'all' ? 'is-active' : ''}" data-action="face-events-cat" data-cat="all" aria-selected="${faceEventsCategory === 'all'}">
            All
          </button>
        </div>`;
}

function renderEventsCard() {
  const events = payload?.events || [];
  const eventCountLabel = events.length
    ? `${events.length} detection event${events.length === 1 ? '' : 's'}`
    : 'No detection events yet';

  return `
    <article class="ov-card ov-det-events">
      <div class="ov-det-events-inner">
        <div class="ov-merged-head ov-det-events-head">
          <div class="ov-det-events-head-text">
            <div class="ov-stat-headline ov-det-events-title">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 3v18h18"/><path d="m7 16 4-5 4 3 5-7"/></svg>
              <span>Events</span>
            </div>
            <div class="ov-merged-sub" id="detEventCountLabel">${eventCountLabel}</div>
          </div>
          <div class="ov-det-events-head-actions">
            ${renderEventsViewToggle()}
            ${renderEventsSearchBar()}
          </div>
        </div>

        ${isFaceTab ? renderFaceEventsCategoryTabs() : ''}

        <div class="ov-merged-divider" aria-hidden="true"></div>

        <div class="ov-det-events-body" id="detEvents">
          <div id="detEventsGalleryHost">${eventsView === 'table' ? renderEventsTable() : renderEventCards(getDisplayedEvents())}</div>
          ${eventsView !== 'table' ? renderEventsLightbox() : ''}
        </div>
      </div>
      <div class="ov-merged-accent" aria-hidden="true"></div>
    </article>`;
}

function renderModelCard() {
  const root = document.getElementById('modelControl');
  if (!root || !payload) return;

  const hasCameras = (payload.assignedCameras || []).length > 0;
  if (!hasCameras) {
    root.innerHTML = '';
    return;
  }

  root.innerHTML = renderEventsCard();

  if (!isPersonTab) wireModelEvents();
  wireGalleryEvents();
  wireEventsViewControls();
  updateEventCountLabel();
}

function wireEventsViewControls() {
  document.querySelectorAll('[data-action="face-events-cat"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const next = btn.dataset.cat === 'face' ? 'face' : (btn.dataset.cat === 'all' ? 'all' : 'line');
      if (next === faceEventsCategory) return;
      faceEventsCategory = next;
      localStorage.setItem('detFaceEventsCategory', faceEventsCategory);
      eventsVisibleLimit = 24;
      eventsTablePage = 1;
      lastRenderedEventsSig = null;
      renderModelCard();
    });
  });

  document.querySelectorAll('[data-action="events-view"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const next = btn.dataset.view === 'table' ? 'table' : 'gallery';
      if (next === eventsView) return;
      eventsView = next;
      localStorage.setItem('detEventsView', eventsView);
      eventsVisibleLimit = 24;
      eventsTablePage = 1;
      renderModelCard();
    });
  });

  document.getElementById('detEventsPrevPage')?.addEventListener('click', () => {
    eventsTablePage = Math.max(1, eventsTablePage - 1);
    refreshEventsGallery();
  });
  document.getElementById('detEventsNextPage')?.addEventListener('click', () => {
    eventsTablePage = Math.min(getEventsTableTotalPages(), eventsTablePage + 1);
    refreshEventsGallery();
  });
}

function refreshPersonLiveSections() {
  if (!payload || !isPersonTab) return;
  const m = payload.peopleMetrics || {};
  const r = payload.report || {};
  const running = payload.state?.inferenceRunning;

  const vals = document.querySelectorAll('.ov-det-metrics-strip .ov-det-metric-val');
  if (vals[0]) vals[0].textContent = String(m.current ?? 0);
  if (vals[1]) vals[1].textContent = String(r.peakPeopleToday ?? m.peakToday ?? 0);
  if (vals[2]) vals[2].textContent = String(r.eventsToday ?? 0);
  if (vals[3]) vals[3].textContent = m.presenceActive ? 'Active' : 'None';

  const statusWrap = document.querySelector('.ov-det-model-status-wrap');
  if (statusWrap) {
    const badge = statusWrap.querySelector('.ov-badge');
    const btn = document.getElementById('detInferenceBtn');
    if (badge) {
      badge.className = `ov-badge ${running ? 'ov-badge-success' : 'ov-badge-error'}`;
      badge.textContent = running ? 'Running' : 'Stopped';
    }
    if (btn) {
      btn.textContent = running ? 'Stop inference' : 'Start inference';
      btn.classList.toggle('ov-det-stop-btn', Boolean(running));
    }
  }

  const logsSection = document.getElementById('detCountLogsSection');
  if (logsSection && !logsSection.classList.contains('is-hidden')) {
    const logsHost = logsSection.querySelector('.ov-det-logs');
    if (logsHost) logsHost.innerHTML = (payload.logs || []).map((line) => `<div class="ov-det-log-line">${esc(line)}</div>`).join('');
  }

  refreshEventsGallery();
}

function getContainImageRect(containerW, containerH, imgW, imgH) {
  const scale = Math.min(containerW / imgW, containerH / imgH);
  const width = imgW * scale;
  const height = imgH * scale;
  return {
    scale,
    offsetX: (containerW - width) / 2,
    offsetY: (containerH - height) / 2,
    width,
    height,
  };
}

function mapNormBoxToContainer(box, rect) {
  const [x1, y1, x2, y2] = box;
  return {
    x: rect.offsetX + x1 * rect.width,
    y: rect.offsetY + y1 * rect.height,
    w: (x2 - x1) * rect.width,
    h: (y2 - y1) * rect.height,
  };
}

function resolveEventBbox(event) {
  if (event?.bbox?.length >= 4) return event.bbox;
  if (event?.box?.length >= 4) return event.box;
  return null;
}

function eventBboxLabel(event) {
  const pct = formatEventConfidencePct(event);
  if (event?.label === 'face') {
    const name = event.personName || (event.isKnown ? 'Known' : 'Face');
    return `${name} ${pct}%`;
  }
  if (event?.trackingId != null) return `Person #${event.trackingId} ${pct}%`;
  return `Person ${pct}%`;
}

function drawEventBboxOverlay(stage, overlay, img, bbox, event) {
  if (!stage || !overlay || !img || !bbox || bbox.length < 4 || !img.naturalWidth) return;
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  if (!w || !h) return;
  overlay.width = w;
  overlay.height = h;
  const ctx = overlay.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  const rect = getContainImageRect(w, h, img.naturalWidth, img.naturalHeight);
  const mapped = mapNormBoxToContainer(bbox, rect);
  const label = eventBboxLabel(event);
  ctx.strokeStyle = '#22c55e';
  ctx.lineWidth = 2.5;
  ctx.strokeRect(mapped.x, mapped.y, mapped.w, mapped.h);
  const lw = Math.max(88, label.length * 7.5);
  const ly = Math.max(0, mapped.y - 24);
  ctx.fillStyle = 'rgba(34, 197, 94, 0.92)';
  ctx.fillRect(mapped.x, ly, lw, 24);
  ctx.fillStyle = '#ffffff';
  ctx.font = '600 12px Inter, sans-serif';
  ctx.fillText(label, mapped.x + 6, ly + 16);
}

function expandCropRectToAspect(px1, py1, px2, py2, frameW, frameH, targetAspect) {
  let x1 = px1;
  let y1 = py1;
  let x2 = px2;
  let y2 = py2;
  let w = Math.max(1, x2 - x1);
  let h = Math.max(1, y2 - y1);
  const aspect = w / h;

  if (aspect > targetAspect) {
    const newH = w / targetAspect;
    const cy = (y1 + y2) / 2;
    y1 = cy - newH / 2;
    y2 = cy + newH / 2;
  } else {
    const newW = h * targetAspect;
    const cx = (x1 + x2) / 2;
    x1 = cx - newW / 2;
    x2 = cx + newW / 2;
  }

  if (x1 < 0) {
    x2 -= x1;
    x1 = 0;
  }
  if (y1 < 0) {
    y2 -= y1;
    y1 = 0;
  }
  if (x2 > frameW) {
    const shift = x2 - frameW;
    x1 = Math.max(0, x1 - shift);
    x2 = frameW;
  }
  if (y2 > frameH) {
    const shift = y2 - frameH;
    y1 = Math.max(0, y1 - shift);
    y2 = frameH;
  }

  w = Math.max(1, x2 - x1);
  h = Math.max(1, y2 - y1);
  const finalAspect = w / h;
  if (finalAspect > targetAspect) {
    const newH = w / targetAspect;
    if (y2 + (newH - h) <= frameH) y2 = y1 + newH;
    else y1 = Math.max(0, y2 - newH);
  } else if (finalAspect < targetAspect) {
    const newW = h * targetAspect;
    if (x2 + (newW - w) <= frameW) x2 = x1 + newW;
    else x1 = Math.max(0, x2 - newW);
  }

  return {
    px1: Math.max(0, Math.round(x1)),
    py1: Math.max(0, Math.round(y1)),
    px2: Math.min(frameW, Math.round(x2)),
    py2: Math.min(frameH, Math.round(y2)),
  };
}

function cropEventImageToBbox(img, bbox, targetAspect = 16 / 9, options = {}) {
  if (!bbox || bbox.length < 4 || !img.naturalWidth) return;
  const { letterbox = true, tight = false } = options;
  const [x1, y1, x2, y2] = bbox;
  const W = img.naturalWidth;
  const H = img.naturalHeight;
  // Tight crop = only the person/face region (small pad). Loose pad was adding empty office.
  const pad = tight || options.pad != null ? (options.pad ?? 0.06) : 0.06;
  const bw = (x2 - x1) * W;
  const bh = (y2 - y1) * H;
  let px1 = Math.max(0, x1 * W - bw * pad);
  let py1 = Math.max(0, y1 * H - bh * pad);
  let px2 = Math.min(W, x2 * W + bw * pad);
  let py2 = Math.min(H, y2 * H + bh * pad);

  if (!letterbox) {
    // Person events: keep the bbox crop as-is (do NOT expand to aspect — that adds empty space).
    const outW = Math.max(1, Math.round(px2 - px1));
    const outH = Math.max(1, Math.round(py2 - py1));
    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, px1, py1, outW, outH, 0, 0, outW, outH);
    try {
      img.src = canvas.toDataURL('image/jpeg', 0.92);
      img.classList.remove('has-bbox-crop');
      img.removeAttribute('data-bbox');
    } catch {
      /* cross-origin or tainted canvas */
    }
    return;
  }

  const pw = Math.max(1, px2 - px1);
  const ph = Math.max(1, py2 - py1);
  const cropAspect = pw / ph;
  let outW;
  let outH;
  let drawW;
  let drawH;
  let dx;
  let dy;
  if (cropAspect >= targetAspect) {
    outW = Math.round(pw);
    outH = Math.round(pw / targetAspect);
    drawW = outW;
    drawH = Math.round(ph * (outW / pw));
    dx = 0;
    dy = Math.round((outH - drawH) / 2);
  } else {
    outH = Math.round(ph);
    outW = Math.round(ph * targetAspect);
    drawH = outH;
    drawW = Math.round(pw * (outH / ph));
    dx = Math.round((outW - drawW) / 2);
    dy = 0;
  }
  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, outW, outH);
  ctx.drawImage(img, px1, py1, pw, ph, dx, dy, drawW, drawH);
  try {
    img.src = canvas.toDataURL('image/jpeg', 0.92);
    img.classList.remove('has-bbox-crop');
    img.removeAttribute('data-bbox');
  } catch {
    /* cross-origin or tainted canvas */
  }
}

function applyCropToEventImages(root) {
  const scope = root || document;
  scope.querySelectorAll('.ov-det-event-img.has-bbox-crop').forEach((img) => {
    if (img.dataset.cropApplied === 'true') return;
    let bbox = null;
    try {
      bbox = JSON.parse(img.dataset.bbox || 'null');
    } catch {
      bbox = null;
    }
    if (!bbox || bbox.length < 4) return;

    const run = () => {
      if (img.dataset.cropApplied === 'true' || !img.naturalWidth) return;
      img.dataset.cropApplied = 'true';
      cropEventImageToBbox(img, bbox, 3 / 4, { letterbox: false, tight: true, pad: 0.06 });
    };

    if (img.complete) run();
    else img.addEventListener('load', run, { once: true });
  });
}

function wireGalleryEvents() {
  const search = document.getElementById('detEventSearch');
  if (search && search.dataset.bound !== 'true') {
    search.dataset.bound = 'true';
    search.addEventListener('input', () => {
      eventSearchQuery = search.value;
      eventsTablePage = 1;
      refreshEventsGallery();
    });
    search.addEventListener('search', () => {
      eventSearchQuery = search.value;
      eventsTablePage = 1;
      refreshEventsGallery();
    });
  }
  document.querySelectorAll('[data-action="open-event"]').forEach((btn) => {
    btn.addEventListener('click', () => openEventLightbox(btn.dataset.eventId));
  });

  document.querySelectorAll('.ov-det-event-card').forEach((card) => {
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openEventLightbox(card.dataset.eventId);
      }
    });
  });

  document.querySelectorAll('[data-action="close-event"]').forEach((el) => {
    el.addEventListener('click', closeEventLightbox);
  });

  if (!document.body.dataset.detLightboxBound) {
    document.body.dataset.detLightboxBound = 'true';
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeEventLightbox();
    });
  }

  applyCropToEventImages();
}

/*
  Person tab: full model controls. Other tabs: events only.
*/

function collectFeatures() {
  const features = { ...(payload?.state?.features || {}) };
  document.querySelectorAll('[data-feature-id]').forEach((el) => {
    if (el.disabled) return;
    features[el.dataset.featureId] = el.checked;
  });
  return features;
}

async function toggleInference() {
  const running = !payload?.state?.inferenceRunning;
  try {
    const res = await fetch(sessionUrl(`/api/detection/${slug}/inference`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: running ? 'start' : 'stop' }),
    });
    if (!res.ok) throw new Error();
    payload = await res.json();
    showToast(running ? 'Inference started' : 'Inference stopped');
    renderModelCard();
  } catch {
    showToast('Could not update inference');
  }
}

function schedulePersonSave(patch) {
  clearTimeout(personSaveTimer);
  personSaveTimer = setTimeout(() => saveSettings(patch, true), 350);
}

function syncPersonTuningUi() {
  const filterOn = Boolean(document.querySelector('[data-feature-id="filterSmallObjects"]')?.checked);
  const card = document.getElementById('detMinSizeCard');
  const range = document.getElementById('detMinSizeRange');
  if (card) card.classList.toggle('is-disabled', !filterOn);
  if (range) range.disabled = !filterOn;

  const tooManyOn = Boolean(document.querySelector('[data-alert-id="too-many-people"]')?.checked);
  document.getElementById('detMaxPeopleRow')?.classList.toggle('is-hidden', !tooManyOn);

  const logsOn = Boolean(document.querySelector('[data-feature-id="peopleCountLogs"]')?.checked);
  document.getElementById('detCountLogsSection')?.classList.toggle('is-hidden', !logsOn);
}

function wirePersonControls() {
  document.getElementById('detInferenceBtn')?.addEventListener('click', toggleInference);

  document.querySelectorAll('[data-feature-id]').forEach((el) => {
    el.addEventListener('change', () => {
      syncPersonTuningUi();
      saveSettings({ features: collectFeatures() }, true);
    });
  });

  document.querySelectorAll('[data-alert-id]').forEach((el) => {
    el.addEventListener('change', () => {
      syncPersonTuningUi();
      saveSettings({ alerts: collectAlerts() }, true);
    });
  });

  const confRange = document.getElementById('detConfRange');
  if (confRange) {
    confRange.addEventListener('input', () => {
      const pct = Number(confRange.value);
      const val = document.getElementById('detConfVal');
      const hint = document.getElementById('detConfHint');
      if (val) val.textContent = `${pct}%`;
      if (hint) hint.textContent = confidenceHint(pct);
    });
    confRange.addEventListener('change', () => {
      schedulePersonSave({ confidence: Number(confRange.value) / 100 });
    });
  }

  const minRange = document.getElementById('detMinSizeRange');
  if (minRange) {
    minRange.addEventListener('input', () => {
      const val = document.getElementById('detMinSizeVal');
      if (val) val.textContent = `${minRange.value}px`;
    });
    minRange.addEventListener('change', () => {
      schedulePersonSave({ minObjectSizePx: Number(minRange.value) });
    });
  }

  document.getElementById('detMaxPeople')?.addEventListener('change', (e) => {
    schedulePersonSave({ maxPeopleAlert: Number(e.target.value) });
  });

  document.getElementById('detAddZoneBtn')?.addEventListener('click', () => {
    const zones = collectZones();
    zones.push({ id: `zone-${Date.now()}`, name: `Zone ${zones.length + 1}`, enabled: true });
    saveSettings({ zones }, true);
  });

  document.querySelectorAll('[data-action="remove-zone"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.index);
      const zones = collectZones().filter((_, i) => i !== idx);
      saveSettings({ zones }, true);
    });
  });

  document.querySelectorAll('[data-zone-name], [data-zone-enabled]').forEach((el) => {
    el.addEventListener('change', () => schedulePersonSave({ zones: collectZones() }));
  });

  syncPersonTuningUi();
}

async function saveSettings(patch, silent = false) {
  try {
    await apiPatch(patch);
    if (!silent) showToast('Settings saved');
    renderModelCard();
  } catch {
    showToast('Could not save settings');
  }
}

function collectZones() {
  return Array.from(document.querySelectorAll('.ov-det-zone-row'))
    .map((row, i) => {
      const prev = payload?.state?.zones?.[i] || {};
      return {
        id: prev.id || `zone-${i + 1}`,
        name: row.querySelector('[data-zone-name]')?.value || `Zone ${i + 1}`,
        enabled: Boolean(row.querySelector('[data-zone-enabled]')?.checked),
        cameraId: prev.cameraId || null,
        points: Array.isArray(prev.points) ? prev.points : [],
      };
    })
    .filter((z) => z.name.trim());
}

function collectAlerts() {
  const alerts = {};
  document.querySelectorAll('[data-alert-id]').forEach((el) => {
    alerts[el.dataset.alertId] = el.checked;
  });
  return alerts;
}

function wireModelEvents() {
  /* person controls wired in wirePersonControls */
}

async function apiPatch(body) {
  const res = await fetch(sessionUrl(`/api/detection/${slug}`), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('Save failed');
  payload = await res.json();
}

async function loadDetectionTab() {
  if (!slug) return;
  try {
    if (isSubscriptionGatedTab) {
      const res = await fetch(sessionUrl(`/api/detection/${slug}`));
      let tabMeta = null;
      if (res.ok) {
        payload = await res.json();
        tabMeta = payload.tab;
      }
      const pageTitle = tabMeta?.pageTitle || (slug === 'safety' ? 'Safety & PPE' : 'Fire & Smoke Detection');
      document.title = `${pageTitle} — Atomo Forge`;
      const title = document.getElementById('detectionPageTitle');
      const crumb = document.getElementById('detectionBreadcrumb');
      if (title) title.textContent = pageTitle;
      if (crumb) crumb.textContent = `AI detection · ${tabMeta?.title || (slug === 'safety' ? 'Safety' : 'Fire & Smoke')} · Subscription`;
      renderSubscriptionGate(tabMeta);
      return;
    }

    const res = await fetch(sessionUrl(`/api/detection/${slug}`));
    if (!res.ok) {
      window.location.href = '/overview';
      return;
    }
    payload = await res.json();
    document.title = `${payload.tab.pageTitle} — Atomo Forge`;
    const title = document.getElementById('detectionPageTitle');
    const crumb = document.getElementById('detectionBreadcrumb');
    if (title) title.textContent = payload.tab.pageTitle;
    if (crumb) crumb.textContent = `AI detection · ${payload.tab.title}`;
    if (isPersonTab && window.PersonLive?.initFromPayload) {
      await window.PersonLive.initFromPayload(payload);
    }
    if (isFaceTab && window.FaceLive?.initFromPayload) {
      await window.FaceLive.initFromPayload(payload);
    }
    if (isFaceTab && window.FaceModule?.reload) {
      await window.FaceModule.reload();
    }
    renderModelCard();
    if (window.CameraManagement?.reload) await window.CameraManagement.reload();
  } catch {
    showToast('Failed to load detection tab');
  }
}

function prependEvents(newEvents, nextPayload) {
  if (!newEvents?.length) return;
  if (nextPayload) {
    payload = nextPayload;
    if (payload.events) payload.events = sortEventsNewestFirst(payload.events);
  } else if (payload) {
    const existing = new Set((payload.events || []).map((e) => e.id));
    const merged = sortEventsNewestFirst([
      ...newEvents.filter((e) => !existing.has(e.id)),
      ...(payload.events || []),
    ]);
    payload = { ...payload, events: merged };
  }
  refreshEventsGallery();
  updateEventCountLabel();
  wireGalleryEvents();
}

function refreshEventsOnly(nextPayload) {
  if (!nextPayload) return;
  payload = nextPayload;
  if (payload.events) payload.events = sortEventsNewestFirst(payload.events);
  // Skip a full gallery rebuild (which reloads every image and causes visible
  // flicker) unless the actual set of events changed.
  const sig = eventsSignature(payload.events);
  if (sig === lastRenderedEventsSig) {
    updateEventCountLabel();
    return;
  }
  lastRenderedEventsSig = sig;
  refreshEventsGallery();
  updateEventCountLabel();
}

function connectDashEventWs() {
  if ((!isPersonTab && !isFaceTab) || dashEventWs) return;
  try {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const sid = sessionStorage.getItem('atomoSessionId');
    const wsSlug = isFaceTab ? 'face' : 'person';
    const q = sid ? `?slug=${wsSlug}&sessionId=${encodeURIComponent(sid)}` : `?slug=${wsSlug}`;
    dashEventWs = new WebSocket(`${proto}//${window.location.host}/ws/detection${q}`);
    dashEventWs.onopen = () => {
      dashWsConnected = true;
    };
    dashEventWs.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (isPersonTab && msg.type === 'person_update') {
          if (msg.newEvents?.length) prependEvents(msg.newEvents, msg.payload);
          else if (msg.payload) refreshEventsOnly(msg.payload);
          if (msg.payload?.peopleMetrics && window.PersonLive) {
            const m = msg.payload.peopleMetrics;
            document.querySelectorAll('[data-m="current"]').forEach((el) => { el.textContent = m.current ?? 0; });
            document.querySelectorAll('[data-m="peak"]').forEach((el) => { el.textContent = m.peakToday ?? 0; });
            document.querySelectorAll('[data-m="fps"]').forEach((el) => { el.textContent = m.fps != null ? Number(m.fps).toFixed(1) : '—'; });
            document.querySelectorAll('[data-m="inf"]').forEach((el) => { el.textContent = m.inferenceMs != null ? `${Math.round(m.inferenceMs)}ms` : '—'; });
            document.querySelectorAll('[data-m="presence"]').forEach((el) => { el.textContent = m.presenceActive ? 'Active' : 'None'; });
          }
        }
        if (isFaceTab && msg.type === 'face_update') {
          if (msg.newEvents?.length) prependEvents(msg.newEvents, msg.payload);
          else if (msg.payload) refreshEventsOnly(msg.payload);
        }
      } catch {
        /* ignore */
      }
    };
    dashEventWs.onclose = () => {
      dashEventWs = null;
      dashWsConnected = false;
      setTimeout(connectDashEventWs, 3000);
    };
  } catch {
    /* ws unavailable */
  }
}

window.DetectionTab = { reload: loadDetectionTab, refreshEventsOnly, prependEvents };

function startRefresh() {
  if (isSubscriptionGatedTab) return;
  if (refreshTimer) clearInterval(refreshTimer);
  connectDashEventWs();
  refreshTimer = setInterval(async () => {
    if (!slug || document.hidden) return;
    if ((isPersonTab || isFaceTab) && dashWsConnected) return;
    try {
      const res = await fetch(sessionUrl(`/api/detection/${slug}`));
      if (!res.ok) return;
      const next = await res.json();
      payload = next;
      const search = document.getElementById('detEventSearch');
      if (search) eventSearchQuery = search.value;
      if (isPersonTab && document.getElementById('personWorkbench')) {
        if (window.PersonLive?.refresh) window.PersonLive.refresh();
      } else if (isFaceTab && document.getElementById('faceWorkbench')) {
        /* face-live polls independently */
      } else {
        refreshEventsGallery();
      }
    } catch {
      /* ignore */
    }
  }, isPersonTab || isFaceTab ? 30000 : 8000);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    loadDetectionTab();
    startRefresh();
  });
} else {
  loadDetectionTab();
  startRefresh();
}
