const DONUT_C = 163.4;
const CAM_RING_C = 301.6;
const ICONS = {
  cpu: '<svg class="ov-metric-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2"/></svg>',
  brain: '<svg class="ov-metric-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/></svg>',
  temp: '<svg class="ov-metric-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z"/></svg>',
  net: '<svg class="ov-metric-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m7 7 10 10M17 7v10H7"/></svg>',
  ram: '<svg class="ov-metric-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 19v-3M10 19v-3M14 19v-3M18 19v-3M8 11V9M16 11V9M6 7h12v4H6z"/></svg>',
  disk: '<svg class="ov-metric-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/></svg>',
};

let basePayload = null;
let liveState = null;
let uptimeBaseSecs = 0;
let uptimeTick = 0;
let tempHistory = [];
let statCardOrder = null;

const STAT_ORDER_KEY = 'atomo-overview-stat-order-v1';

function loadStatOrder() {
  try {
    const raw = localStorage.getItem(STAT_ORDER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveStatOrder(order) {
  try {
    localStorage.setItem(STAT_ORDER_KEY, JSON.stringify(order));
  } catch {
    // ignore
  }
}

function resetStatOrder() {
  statCardOrder = null;
  try {
    localStorage.removeItem(STAT_ORDER_KEY);
  } catch {
    // ignore
  }
  if (liveState) renderDonuts(liveState);
  showToast('Layout reset');
}

function sessionUrl(path) {
  const sid = sessionStorage.getItem('atomoSessionId');
  return sid ? `${path}?sessionId=${encodeURIComponent(sid)}` : path;
}

/** Map /api/overview payload → UI state. No random jitter — values are real. */
function liveStateFromPayload(b) {
  const cameras = b.cameras || { total: 0, active: 0, offline: 0 };
  const resources = b.resources || {};
  const network = b.network || {};
  const health = b.health || {};
  const alerts = b.alerts || {};
  const trendToday = b.alertTrend?.today || [0];
  const aiModels = (b.aiModels || []).map((m) => ({
    name: m.shortLabel || m.name || m.id,
    status: m.running ? 'running' : 'idle',
  }));
  const aiRunning = b.aiModelsRunning ?? aiModels.filter((m) => m.status === 'running').length;
  const aiTotal = b.aiModelsTotal ?? aiModels.length;
  const cpu = Number(resources.cpuPercent) || 0;
  const temp = health.temperatureC != null ? Number(health.temperatureC) : null;
  if (temp != null) {
    tempHistory.push(temp);
    if (tempHistory.length > 10) tempHistory.shift();
  }

  return {
    cameras: {
      total: cameras.total || 0,
      active: cameras.active || 0,
      offline: cameras.offline || 0,
    },
    cpu,
    npu: resources.npuAvailable === false ? 0 : (Number(resources.npuPercent) || 0),
    temp: temp != null ? temp : 0,
    download: Number(network.downloadMbps) || 0,
    upload: Number(network.uploadMbps) || 0,
    ramUsed: Number(resources.ramUsedGb) || 0,
    ramTotal: Number(resources.ramTotalGb) || 0,
    ramPct: Number(resources.ramPercent)
      || (resources.ramTotalGb
        ? Math.round((resources.ramUsedGb / resources.ramTotalGb) * 100)
        : 0),
    storageUsed: Number(resources.storageUsedGb) || 0,
    storageTotal: Number(resources.storageTotalGb) || 0,
    storagePct: Number(resources.storagePercent) || 0,
    alertsToday: Number(alerts.todayTotal) || 0,
    alertDelta: 0,
    critical: Number(alerts.criticalOpen) || 0,
    aiRunning,
    aiTotal,
    aiIdle: Math.max(0, aiTotal - aiRunning),
    aiError: 0,
    aiModels,
    fanRpm: health.fanRpm != null ? health.fanRpm : '—',
    throttling: health.throttling || (cpu > 85 ? 'Active' : 'None'),
    statistic: b.statistic || {
      labels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
      cameraEvents: [0, 0, 0, 0, 0, 0, 0],
      alertEvents: [0, 0, 0, 0, 0, 0, 0],
      totalEvents: 0,
    },
    alertTrend: {
      ...(b.alertTrend || {}),
      today: trendToday,
      week: b.alertTrend?.week || [0, 0, 0, 0, 0, 0, 0],
      month: b.alertTrend?.month || [0, 0, 0, 0, 0, 0, 0],
    },
    recentAlerts: b.recentAlerts || [],
    alertsLastHour: Number(b.alertsLastHour) || 0,
    alertsAvgPerHour: Number(b.alertsAvgPerHour) || 0,
    alertsPeakTime: b.alertsPeakTime || '—',
    networkHistory: {
      download: padHistory(network.downloadHistory, Number(network.downloadMbps) || 0),
      upload: padHistory(network.uploadHistory, Number(network.uploadMbps) || 0),
    },
    device: b.device || {},
    deviceIp: network.deviceIp || '—',
    deviceRole: b.deviceRole || { clusterMode: 'master' },
    sync: b.sync || { atomicCentreHost: '—', status: 'local' },
    license: b.license || { edition: '—', daysRemaining: null },
    username: b.username || 'operator',
    lastAlertAt: alerts.lastAlertAt,
  };
}

function padHistory(arr, fallback = 0) {
  const out = Array.isArray(arr) ? arr.map(Number) : [];
  while (out.length < 3) out.unshift(fallback);
  return out;
}

function barPctClass(pct) {
  if (pct > 80) return 'hot';
  if (pct > 60) return 'warn';
  return '';
}

function navPctClass(pct) {
  if (pct > 80) return 'accent';
  if (pct > 60) return 'warn';
  return '';
}

function tempClass(temp) {
  if (temp > 75) return 'hot';
  if (temp > 60) return 'warn';
  return '';
}

function donutSvg(pct, strokeVar, centerText, pulse = false) {
  const dash = Math.max(0, Math.min(100, pct)) / 100 * DONUT_C;
  return `
    <svg class="ov-donut-svg" viewBox="0 0 64 64" aria-hidden="true">
      <circle cx="32" cy="32" r="26" stroke="var(--color-border)" stroke-width="7" fill="none" opacity="0.35"/>
      <circle class="ov-donut-arc${pulse ? ' pulse' : ''}" cx="32" cy="32" r="26"
        stroke="${strokeVar}" stroke-width="7" fill="none" stroke-linecap="round"
        stroke-dasharray="${dash} ${DONUT_C}" transform="rotate(-90 32 32)"/>
      <text x="32" y="37" text-anchor="middle" font-family="Inter, sans-serif" font-size="13" font-weight="700" fill="var(--color-text-primary)">${centerText}</text>
    </svg>`;
}

function segmentedDonutSvg(segments, centerValue, centerLabel) {
  const safeSegs = segments
    .map((s) => ({ ...s, pct: Math.max(0, Math.min(100, s.pct)) }))
    .filter((s) => s.pct > 0.001);

  let offset = 0;
  const rings = safeSegs
    .map((s) => {
      const dash = (s.pct / 100) * DONUT_C;
      const ring = `<circle class="ov-ring-seg" cx="32" cy="32" r="26"
        stroke="${s.stroke}" stroke-width="7" fill="none" stroke-linecap="round"
        stroke-dasharray="${dash} ${DONUT_C - dash}" stroke-dashoffset="${-offset}"
        transform="rotate(-90 32 32)"/>`;
      offset += dash;
      return ring;
    })
    .join('');

  return `
    <svg class="ov-donut-svg ov-donut-lg" viewBox="0 0 64 64" aria-hidden="true">
      <circle cx="32" cy="32" r="26" stroke="var(--color-border)" stroke-width="7" fill="none" opacity="0.35"/>
      ${rings}
      <text x="32" y="32" text-anchor="middle" font-family="Inter, sans-serif" font-size="16" font-weight="800" fill="var(--color-text-primary)">${centerValue}</text>
      <text x="32" y="44" text-anchor="middle" font-family="var(--font-sans)" font-size="8.5" font-weight="700" letter-spacing="0.08em" fill="var(--color-text-muted)">${centerLabel}</text>
    </svg>`;
}

function cameraRingSvg(segments) {
  const safeSegs = segments
    .map((s) => ({ ...s, pct: Math.max(0, Math.min(100, s.pct)) }))
    .filter((s) => s.pct > 0.001);

  let offset = 0;
  const rings = safeSegs
    .map((s) => {
      const dash = (s.pct / 100) * CAM_RING_C;
      const ring = `<circle class="ov-ring-seg" cx="60" cy="60" r="48"
        stroke="${s.stroke}" stroke-width="11" fill="none" stroke-linecap="round"
        stroke-dasharray="${dash} ${CAM_RING_C - dash}" stroke-dashoffset="${-offset}"
        transform="rotate(-90 60 60)"/>`;
      offset += dash;
      return ring;
    })
    .join('');

  return `
    <svg viewBox="0 0 120 120" aria-hidden="true">
      <circle cx="60" cy="60" r="48" stroke="var(--color-border)" stroke-width="11" fill="none" opacity="0.55"/>
      ${rings}
    </svg>`;
}

const STAT_ICONS = {
  ai: '<svg class="ov-stat-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/></svg>',
  alerts: '<svg class="ov-stat-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>',
  critical: '<svg class="ov-stat-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  trend: '<svg class="ov-stat-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m3 17 6-6 4 4 8-8"/><path d="M14 7h7v7"/></svg>',
};

function renderAiModelRow(model) {
  const running = model.status === 'running';
  return `
    <div class="ov-ai-model-row">
      <div class="ov-ai-model-name">
        <span class="ov-ai-model-dot ${running ? 'running' : 'idle'}"></span>
        <span>${model.name}</span>
      </div>
      <span class="ov-ai-model-badge ${running ? 'running' : 'idle'}">${running ? 'Running' : 'Idle'}</span>
    </div>`;
}

function renderAlertActivityRow(alert) {
  const labels = { warning: 'Warning', critical: 'Critical', info: 'Info', success: 'Resolved' };
  return `
    <div class="ov-alert-activity-row">
      <div class="ov-alert-activity-main">
        <span class="ov-alert-activity-dot ${alert.severity}"></span>
        <span class="ov-alert-activity-title">${alert.title}</span>
      </div>
      <div class="ov-alert-activity-meta">
        <span class="ov-alert-activity-badge ${alert.severity}">${labels[alert.severity] || 'Alert'}</span>
        <span class="ov-alert-activity-time ov-mono">${alert.time}</span>
      </div>
    </div>`;
}

function renderDonuts(d) {
  const totalRegistered = Math.max(0, d.cameras.total || 0);
  const active = Math.max(0, d.cameras.active || 0);
  const offline = Math.max(0, d.cameras.offline || 0);
  const totalSeen = Math.min(totalRegistered, active + offline);
  const unregistered = Math.max(0, totalRegistered - totalSeen);

  const pct = (n) => (totalRegistered > 0 ? (n / totalRegistered) * 100 : 0);
  const segments = [
    { stroke: 'var(--color-success)', pct: pct(active) },
    { stroke: 'var(--color-error)', pct: pct(offline) },
    { stroke: 'var(--color-accent)', pct: pct(unregistered) },
  ];

  const fmtPct = (n) => (totalRegistered > 0 ? Math.round((n / totalRegistered) * 100) : 0);

  const cameraCard = `
    <article class="ov-card ov-camera-card" draggable="true" data-card-id="camera">
      <div class="ov-camera-left">
        <div class="ov-camera-donut">
          ${cameraRingSvg(segments)}
          <div class="ov-camera-center">
            <div class="ov-camera-center-val">${totalSeen}</div>
            <div class="ov-camera-center-label">Total</div>
          </div>
        </div>
      </div>
      <div class="ov-camera-legend" aria-label="Camera status legend">
        <div class="ov-camera-legend-title">Camera status</div>
        <div class="ov-camera-legend-wrap">
          <div class="ov-divider-v" aria-hidden="true"></div>
          <div class="ov-camera-legend-rows">
            <div class="ov-legend-row">
              <span class="ov-dot success"></span>
              <span class="ov-legend-label">Active</span>
              <span class="ov-legend-meta"><span class="ov-legend-val ov-mono">${active}</span><span>${fmtPct(active)}%</span></span>
            </div>
            <div class="ov-legend-row">
              <span class="ov-dot error"></span>
              <span class="ov-legend-label">Offline</span>
              <span class="ov-legend-meta"><span class="ov-legend-val ov-mono">${offline}</span><span>${fmtPct(offline)}%</span></span>
            </div>
            <div class="ov-legend-row">
              <span class="ov-dot accent"></span>
              <span class="ov-legend-label">Unregistered</span>
              <span class="ov-legend-meta"><span class="ov-legend-val ov-mono">${unregistered}</span><span>${fmtPct(unregistered)}%</span></span>
            </div>
            <div class="ov-legend-row total">
              <span class="ov-dot border"></span>
              <span class="ov-legend-label">Registered total</span>
              <span class="ov-legend-val ov-mono">${totalRegistered}</span>
            </div>
          </div>
        </div>
      </div>
    </article>`;

  const utilPct = Math.max(0, Math.min(100, Math.round((d.aiTotal > 0 ? (d.aiRunning / d.aiTotal) : 0) * 100)));
  const modelListHtml = (d.aiModels || []).map(renderAiModelRow).join('');
  const aiCard = `
    <article class="ov-card ov-stat-card ov-ai-card" draggable="true" data-card-id="ai" style="--ov-accent: var(--color-accent)">
      <div class="ov-ai-inner">
        <div class="ov-ai-top">
          <div class="ov-stat-headline">AI models running</div>
          <div class="ov-stat-top">
            <div class="ov-stat-number ov-mono">${d.aiRunning}<span class="ov-stat-suffix">/${d.aiTotal}</span></div>
            ${STAT_ICONS.ai}
          </div>
          <div class="ov-stat-sub">of ${d.aiTotal} models loaded</div>
          <div class="ov-util-row"><span>Utilization</span><strong>${utilPct}%</strong></div>
          <div class="ov-util-bar"><div class="ov-util-fill" style="width:${utilPct}%"></div></div>
        </div>
        <div class="ov-ai-bottom">
          <div class="ov-ai-pills">
            <div class="ov-ai-pill">
              <div class="ov-ai-pill-val ov-mono">${d.aiIdle}</div>
              <div class="ov-ai-pill-label">Idle</div>
            </div>
            <div class="ov-ai-pill active">
              <div class="ov-ai-pill-val ov-mono">${d.aiRunning}</div>
              <div class="ov-ai-pill-label">Active</div>
            </div>
            <div class="ov-ai-pill">
              <div class="ov-ai-pill-val ov-mono">${d.aiError}</div>
              <div class="ov-ai-pill-label">Error</div>
            </div>
          </div>
          <div class="ov-ai-model-list">${modelListHtml}</div>
        </div>
      </div>
      <div class="ov-accent-bar"></div>
    </article>`;

  const mergedAlerts = `
    <article class="ov-card ov-merged-alerts" data-card-id="alerts-merged" style="--ov-accent: var(--color-warning)">
      <div class="ov-merged-inner">
        <div class="ov-merged-head">
          <div>
            <div class="ov-stat-headline">Alerts & incidents</div>
            <div class="ov-merged-sub">Live overview of today’s alert activity</div>
          </div>
          <div class="ov-merged-icons">
            ${STAT_ICONS.alerts}
            ${STAT_ICONS.critical}
          </div>
        </div>

        <div class="ov-merged-kpis">
          <div class="ov-kpi">
            <div class="ov-kpi-label">Alerts today</div>
            <div class="ov-kpi-val ov-mono" id="mergedAlertCount">${d.alertsToday}</div>
            <div class="ov-kpi-sub">Last at <span class="ov-mono" id="mergedAlertTime">${formatTime(d.lastAlertAt)}</span></div>
          </div>
          <div class="ov-kpi ov-kpi-critical">
            <div class="ov-kpi-label">Critical</div>
            <div class="ov-kpi-val ov-mono" style="color:var(--color-error)" id="mergedCriticalCount">${d.critical}</div>
            <div class="ov-kpi-sub" id="mergedCriticalSub">${d.critical > 0 ? 'Immediate action required' : 'No active incidents'}</div>
          </div>
        </div>

        <div class="ov-merged-trend">
          <div class="ov-kpi-sub">${STAT_ICONS.trend}<span id="mergedAlertDelta">${d.alertDelta >= 0 ? '+' : ''}${d.alertDelta} vs. yesterday</span></div>
          <div class="ov-pill ${d.critical > 0 ? '' : 'is-muted'}"><span class="ov-dot error"></span><span>${d.critical > 0 ? 'Active incident' : 'All clear'}</span></div>
        </div>

        <div class="ov-merged-divider" aria-hidden="true"></div>

        <div class="ov-merged-quick-stats">
          <div class="ov-merged-mini">
            <div class="ov-mini-label">Last hour</div>
            <div class="ov-mini-val ov-mono">${d.alertsLastHour}</div>
            <div class="ov-mini-sub">alerts</div>
          </div>
          <div class="ov-merged-mini">
            <div class="ov-mini-label">Avg/hour</div>
            <div class="ov-mini-val ov-mono">${d.alertsAvgPerHour}</div>
            <div class="ov-mini-sub">today</div>
          </div>
          <div class="ov-merged-mini peak">
            <div class="ov-mini-label">Peak time</div>
            <div class="ov-mini-val ov-mono">${d.alertsPeakTime}</div>
            <div class="ov-mini-sub">busiest window</div>
          </div>
        </div>

        <div class="ov-merged-divider" aria-hidden="true"></div>

        <div class="ov-merged-activity">
          <div class="ov-stat-headline">Recent activity</div>
          <div class="ov-alert-activity-list">
            ${(d.recentAlerts || []).map(renderAlertActivityRow).join('')}
          </div>
        </div>
      </div>
      <div class="ov-merged-accent"></div>
    </article>`;

  const cardsById = { camera: cameraCard, ai: aiCard };
  const defaultOrder = ['camera', 'ai'];
  if (!statCardOrder) statCardOrder = loadStatOrder() || defaultOrder;
  statCardOrder = Array.from(new Set(statCardOrder.filter((id) => defaultOrder.includes(id))));
  defaultOrder.forEach((id) => {
    if (!statCardOrder.includes(id)) statCardOrder.push(id);
  });

  const leftHtml = statCardOrder
    .map((id, idx) => {
      const card = cardsById[id] || '';
      return card.replace('<article ', `<article style="order:${idx};" `);
    })
    .join('');

  const grid = document.getElementById('donutGrid');
  grid.innerHTML = `
    <div class="ov-col-left" id="statsLeft">
      ${leftHtml}
    </div>
    <div class="ov-col-right">
      ${mergedAlerts}
    </div>
  `;

  const leftEl = document.getElementById('statsLeft');
  if (leftEl) wireStatDragAndDrop(leftEl);
}

function wireStatDragAndDrop(gridEl) {
  const cards = Array.from(gridEl.querySelectorAll('.ov-card[draggable="true"]'));
  let draggingId = null;

  cards.forEach((card) => {
    card.addEventListener('dragstart', (e) => {
      draggingId = card.dataset.cardId;
      card.classList.add('is-dragging');
      try {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', draggingId);
      } catch {
        // ignore
      }
    });

    card.addEventListener('dragend', () => {
      draggingId = null;
      cards.forEach((c) => c.classList.remove('is-dragging', 'is-drop-target'));
    });

    card.addEventListener('dragover', (e) => {
      if (!draggingId) return;
      e.preventDefault();
      if (card.dataset.cardId && card.dataset.cardId !== draggingId) {
        card.classList.add('is-drop-target');
      }
    });

    card.addEventListener('dragleave', () => {
      card.classList.remove('is-drop-target');
    });

    card.addEventListener('drop', (e) => {
      e.preventDefault();
      const targetId = card.dataset.cardId;
      const sourceId = draggingId || (e.dataTransfer ? e.dataTransfer.getData('text/plain') : null);
      if (!sourceId || !targetId || sourceId === targetId) return;

      const order = (statCardOrder || ['camera', 'ai', 'alerts', 'critical']).slice();
      const a = order.indexOf(sourceId);
      const b = order.indexOf(targetId);
      if (a === -1 || b === -1) return;

      order.splice(a, 1);
      order.splice(b, 0, sourceId);
      statCardOrder = order;
      saveStatOrder(order);

      // re-render once using latest liveState if present
      if (liveState) renderDonuts(liveState);
    });
  });
}

function resourceCard(title, icon, value, pct, footLeft, footRight) {
  const barCls = barPctClass(pct);
  return `
    <article class="ov-resource-card">
      <div class="ov-resource-head">
        ${icon}
        <span class="ov-resource-title">${title}</span>
        <span class="ov-resource-value">${value}</span>
      </div>
      <div class="ov-progress"><div class="ov-progress-fill ${barCls}" style="width:${pct}%"></div></div>
      <div class="ov-resource-foot"><span>${footLeft}</span><span>${footRight}</span></div>
    </article>`;
}

const RES_ICONS = {
  cpu: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/></svg>',
  brain: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/></svg>',
  ram: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 19v-3M10 19v-3M14 19v-3M18 19v-3M8 11V9M16 11V9M6 7h12v4H6z"/></svg>',
  disk: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/></svg>',
};

function renderResources(d) {
  document.getElementById('resourceGrid').innerHTML = [
    resourceCard('CPU Load', RES_ICONS.cpu, `${Math.round(d.cpu)}%`, d.cpu, '8 cores · 2.4GHz', `Temp: ${Math.round(d.temp)}°C`),
    resourceCard('NPU Load', RES_ICONS.brain, `${Math.round(d.npu)}%`, d.npu, 'AtomicNPU v2', '4 TOPS'),
    resourceCard('RAM Usage', RES_ICONS.ram, `${d.ramUsed.toFixed(1)} / ${d.ramTotal} GB`, d.ramPct, `Available: ${(d.ramTotal - d.ramUsed).toFixed(1)}GB`, 'Swap: 0MB'),
    resourceCard('Storage', RES_ICONS.disk, `${d.storageUsed} / ${d.storageTotal} GB`, d.storagePct, `Available: ${d.storageTotal - d.storageUsed}GB`, 'Type: NVMe'),
  ].join('');
}

function formatUptime(totalSecs) {
  const d = Math.floor(totalSecs / 86400);
  const h = Math.floor((totalSecs % 86400) / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = totalSecs % 60;
  return `${d}d ${h}h ${m}m ${s}s`;
}

function sparklineSvg(values) {
  if (!values.length) return '';
  const w = 280;
  const h = 48;
  const min = Math.min(...values) - 2;
  const max = Math.max(...values) + 2;
  const pts = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * w;
      const y = h - ((v - min) / (max - min || 1)) * h;
      return `${x},${y}`;
    })
    .join(' ');
  return `<svg class="ov-sparkline" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="var(--color-warning)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function roleLabel(mode) {
  const m = (mode || 'master').toLowerCase();
  return m.charAt(0).toUpperCase() + m.slice(1);
}

function renderInfoCards(d) {
  const uptime = formatUptime(uptimeBaseSecs + uptimeTick);
  const deviceCard = `
    <article class="ov-info-card">
      <div class="ov-info-title"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/></svg> Device Info</div>
      <div class="ov-info-row"><span>Role</span><span class="ov-badge ov-badge-accent">${roleLabel(d.deviceRole.clusterMode)}</span></div>
      <div class="ov-info-row"><span>Status</span><span class="ov-badge ov-badge-success"><span class="ov-dot-pulse"></span> Online</span></div>
      <div class="ov-info-row"><span>Uptime</span><span class="ov-mono" id="uptimeVal">${uptime}</span></div>
      <div class="ov-info-row"><span>Firmware</span><span class="ov-mono">AtomicOS v2.4.1</span></div>
      <div class="ov-info-row"><span>Serial</span><span class="ov-mono">ATM-EL-20240312</span></div>
      <div class="ov-info-row"><span>IP Address</span><span class="ov-mono">${d.deviceIp}</span></div>
    </article>`;

  const centreCard = `
    <article class="ov-info-card">
      <div class="ov-info-title"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/></svg> Atomic Centre</div>
      <div class="ov-info-row"><span>Endpoint</span><span class="ov-mono">${d.sync.atomicCentreHost}</span></div>
      <div class="ov-info-row"><span>Sync</span><span class="ov-badge ov-badge-success"><span class="ov-dot-pulse"></span> Connected</span></div>
      <div class="ov-info-row"><span>Last sync</span><span class="ov-mono">2 min ago</span></div>
      <div class="ov-info-row"><span>License</span><span class="ov-badge ov-badge-gold">${d.license.edition}</span></div>
      <div class="ov-info-row"><span>Valid until</span><span class="ov-mono">Dec 2025</span></div>
      <div class="ov-info-row"><span>Slave Devices</span><span class="ov-mono">0 connected</span></div>
    </article>`;

  const grid = document.getElementById('infoGrid');
  grid.innerHTML = `${deviceCard}${centreCard}`;
}

function formatTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function svgBarChart(container, labels, seriesA, seriesB) {
  const w = 480;
  const h = 180;
  const pad = { t: 10, r: 10, b: 28, l: 10 };
  const max = Math.max(...seriesA, ...seriesB, 1) * 1.1;
  const bw = (w - pad.l - pad.r) / labels.length / 2.5;
  const gap = bw * 0.3;
  let bars = '';
  labels.forEach((lbl, i) => {
    const x0 = pad.l + i * ((w - pad.l - pad.r) / labels.length) + gap;
    const hA = ((seriesA[i] || 0) / max) * (h - pad.t - pad.b);
    const hB = ((seriesB[i] || 0) / max) * (h - pad.t - pad.b);
    bars += `<rect x="${x0}" y="${h - pad.b - hA}" width="${bw}" height="${hA}" rx="4" fill="var(--color-accent)" opacity="0.85"/>`;
    bars += `<rect x="${x0 + bw + gap}" y="${h - pad.b - hB}" width="${bw}" height="${hB}" rx="4" fill="var(--color-warning)" opacity="0.75"/>`;
    bars += `<text x="${x0 + bw}" y="${h - 6}" text-anchor="middle" font-size="10" fill="var(--color-text-muted)">${lbl}</text>`;
  });
  container.innerHTML = `<svg width="100%" height="100%" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet">${bars}</svg>`;
}


function svgAreaChart(container, down, up) {
  const w = 400;
  const h = 100;
  const pad = 4;
  const max = Math.max(...down, ...up, 1) * 1.1;
  const line = (vals, dashed) => {
    const pts = vals
      .map((v, i) => {
        const x = pad + (i / (vals.length - 1 || 1)) * (w - pad * 2);
        const y = h - pad - (v / max) * (h - pad * 2);
        return `${x},${y}`;
      })
      .join(' ');
    return `<polyline points="${pts}" fill="none" stroke="var(--color-accent)" stroke-width="2" ${dashed ? 'stroke-dasharray="4 4" opacity="0.6"' : ''}/>`;
  };
  const downPts = down
    .map((v, i) => {
      const x = pad + (i / (down.length - 1 || 1)) * (w - pad * 2);
      const y = h - pad - (v / max) * (h - pad * 2);
      return `${x},${y}`;
    })
    .join(' ');
  const area = `${pad},${h - pad} ${downPts} ${w - pad},${h - pad}`;
  container.innerHTML = `<svg width="100%" height="100%" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <polygon points="${area}" fill="var(--color-accent-muted)"/>
    ${line(down, false)}
    ${line(up, true)}
  </svg>`;
}

function renderCharts(d) {
  const statTotalEl = document.getElementById('statTotal');
  if (statTotalEl) statTotalEl.textContent = d.statistic.totalEvents;

  const netDownloadEl = document.getElementById('netDownload');
  if (netDownloadEl) netDownloadEl.textContent = d.download.toFixed(2);

  const netUploadEl = document.getElementById('netUpload');
  if (netUploadEl) netUploadEl.textContent = d.upload.toFixed(2);

  const statChartEl = document.getElementById('chartStatistic');
  if (statChartEl) {
    svgBarChart(statChartEl, d.statistic.labels, d.statistic.cameraEvents, d.statistic.alertEvents);
  }

  const networkChartEl = document.getElementById('chartNetwork');
  if (networkChartEl) svgAreaChart(networkChartEl, d.networkHistory.download, d.networkHistory.upload);
}

function renderAll(d) {
  liveState = d;
  renderDonuts(d);
  renderInfoCards(d);
  renderCharts(d);

  const uptimeEl = document.getElementById('uptimeVal');
  if (uptimeEl) uptimeEl.textContent = formatUptime(uptimeBaseSecs + uptimeTick);
}

function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2200);
}

async function refreshOverview() {
  try {
    const res = await fetch(sessionUrl('/api/overview'));
    if (!res.ok) return;
    basePayload = await res.json();
    uptimeBaseSecs = basePayload.health?.uptimeBaseSecs || uptimeBaseSecs;
    uptimeTick = 0;
    if (basePayload.username) {
      const nameEl = document.getElementById('userName');
      const avEl = document.getElementById('userAvatar');
      if (nameEl) nameEl.textContent = basePayload.username;
      if (avEl) avEl.textContent = (basePayload.username || 'A')[0].toUpperCase();
    }
    const crumb = document.getElementById('breadcrumb');
    if (crumb) {
      crumb.textContent = `${basePayload.device?.hostname || 'Device'} · ${(basePayload.deviceRole?.clusterMode || 'master').toUpperCase()} · ${basePayload.sync?.atomicCentreHost || '—'}`;
    }
    renderAll(liveStateFromPayload(basePayload));
  } catch {
    /* keep last good frame */
  }
}

async function loadOverview() {
  const sessionRes = await fetch(sessionUrl('/api/session'));
  const session = await sessionRes.json();
  if (!session.authenticated) {
    window.location.href = '/login';
    return;
  }
  if (session.redirectTo && !['/overview', '/dashboard'].includes(session.redirectTo)) {
    window.location.href = session.redirectTo;
    return;
  }
  if (session.sessionId) sessionStorage.setItem('atomoSessionId', session.sessionId);

  if (window.LiveMetrics) window.LiveMetrics.init();

  await refreshOverview();

  // Poll real overview data (no fake jitter).
  setInterval(() => {
    refreshOverview();
  }, 5000);

  setInterval(() => {
    uptimeTick += 1;
    const el = document.getElementById('uptimeVal');
    if (el) el.textContent = formatUptime(uptimeBaseSecs + uptimeTick);
  }, 1000);
}

// Alerts panel removed; merged into enterprise stats card.

loadOverview();

document.getElementById('resetStatsLayout')?.addEventListener('click', resetStatOrder);
