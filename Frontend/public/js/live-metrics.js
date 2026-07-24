(function () {
  const POLL_MS = 2000;
  const STALE_MS = 8000;
  const EMA = 0.4;
  const API_BASE = window.__ATOMO_API_URL__ || '';

  const ICONS = {
    cpu: '<svg class="ov-metric-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2"/></svg>',
    brain: '<svg class="ov-metric-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/></svg>',
    temp: '<svg class="ov-metric-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z"/></svg>',
    net: '<svg class="ov-metric-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m7 7 10 10M17 7v10H7"/></svg>',
    ram: '<svg class="ov-metric-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 19v-3M10 19v-3M14 19v-3M18 19v-3M8 11V9M16 11V9M6 7h12v4H6z"/></svg>',
    disk: '<svg class="ov-metric-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/></svg>',
  };

  let display = null;
  let meta = { live: false, board: '', fetchedAt: 0, offline: false };
  let pollTimer = null;

  function sessionUrl(path) {
    const sid = sessionStorage.getItem('atomoSessionId');
    const base = `${API_BASE}${path}`;
    if (!sid) return base;
    const sep = base.includes('?') ? '&' : '?';
    return `${base}${sep}sessionId=${encodeURIComponent(sid)}`;
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

  function ema(prev, next) {
    if (prev === null || prev === undefined) return next;
    if (next === null || next === undefined) return prev;
    return prev * (1 - EMA) + next * EMA;
  }

  function formatBytesGb(bytes) {
    if (!bytes || bytes <= 0) return null;
    return (bytes / (1024 ** 3)).toFixed(1);
  }

  function safePct(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return Math.max(0, Math.min(100, Math.round(n)));
  }

  function mapStats(data) {
    if (!data || data._boardOffline) {
      meta.offline = true;
      meta.live = false;
      return display;
    }

    // Nested board payload fallback (if server didn't normalize yet)
    const cpuNested = data.cpu && typeof data.cpu === 'object' ? data.cpu : null;
    const ramNested = data.ram && typeof data.ram === 'object' ? data.ram : null;
    const npuNested = data.npu && typeof data.npu === 'object' ? data.npu : null;
    const storageNested = data.storage && typeof data.storage === 'object' ? data.storage : null;
    const netNested = data.net && typeof data.net === 'object' ? data.net : null;

    const prev = display || {};
    meta.offline = false;
    meta.live = data.live !== false && !data._fallback;
    meta.board = data.board_hostname || data.board || data.hostname || '';
    meta.fetchedAt = Date.now();
    meta.ageMs = data.age_ms ?? 0;
    meta.npuSource = data.npu_detail?.source || npuNested?.source || null;

    const cpuRaw = data.cpu_detail?.load_pct
      ?? (typeof data.cpu === 'number' ? data.cpu : null)
      ?? cpuNested?.load_pct
      ?? 0;
    const ramRaw = data.ram_detail?.used_pct
      ?? (typeof data.ram === 'number' ? data.ram : null)
      ?? ramNested?.used_pct
      ?? 0;
    const storageRaw = data.storage_detail?.used_pct
      ?? (typeof data.storage === 'number' ? data.storage : null)
      ?? storageNested?.used_pct
      ?? prev.storagePct
      ?? 0;

    const cpu = safePct(ema(prev.cpu, cpuRaw)) ?? 0;
    const ramPct = safePct(ema(prev.ramPct, ramRaw)) ?? 0;
    const storagePct = safePct(storageRaw) ?? 0;
    const storageUsed = Number(data.storage_detail?.used ?? storageNested?.used ?? prev.storageUsed ?? 0) || 0;
    const storageTotal = Number(data.storage_detail?.total ?? storageNested?.total ?? prev.storageTotal ?? 0) || 0;

    const tempRaw = data.temp_detail?.temp_c
      ?? (typeof data.temp === 'number' ? data.temp : null)
      ?? data.cpu_detail?.temp_c
      ?? cpuNested?.temp_c
      ?? null;
    const temp = tempRaw !== null && tempRaw !== undefined && Number.isFinite(Number(tempRaw))
      ? Math.round(ema(prev.temp, Number(tempRaw)))
      : (prev.temp ?? null);

    const npuRaw = data.npu_detail?.load_pct
      ?? (typeof data.npu === 'number' ? data.npu : null)
      ?? npuNested?.load_pct
      ?? null;
    const npu = npuRaw !== null && npuRaw !== undefined && Number.isFinite(Number(npuRaw))
      ? safePct(ema(prev.npu, Number(npuRaw)))
      : (prev.npu ?? null);

    const netRaw = data.net_detail?.download_mbps
      ?? (typeof data.net === 'number' ? data.net : null)
      ?? netNested?.download_mbps
      ?? netNested?.rx_mbps
      ?? null;
    const download = netRaw !== null && netRaw !== undefined && Number.isFinite(Number(netRaw))
      ? ema(prev.download, Number(netRaw))
      : (prev.download ?? null);

    return {
      cpu,
      npu,
      ramPct,
      storagePct,
      storageUsed,
      storageTotal,
      temp,
      download,
      npuLabel: data.npu_detail?.label || npuNested?.label || meta.npuSource,
      tempSource: data.temp_detail?.source,
      workers: data.workers?.count || 0,
    };
  }

  async function fetchLiveStats() {
    try {
      const res = await fetch(sessionUrl('/api/system/stats'));
      if (!res.ok) {
        meta.offline = true;
        meta.live = false;
        return display;
      }
      const data = await res.json();
      display = mapStats(data);
      return display;
    } catch {
      meta.offline = true;
      meta.live = false;
      return display;
    }
  }

  function formatNpu(d) {
    if (meta.offline) return '—';
    if (d.npu !== null && d.npu !== undefined && !Number.isNaN(d.npu)) {
      const suffix = d.npuLabel === 'duty-cycle' ? '~' : '';
      return `${Math.round(d.npu)}%${suffix}`;
    }
    return '—';
  }

  function formatNet(d) {
    if (meta.offline || d.download === null || d.download === undefined || Number.isNaN(d.download)) return '—';
    return `${Number(d.download).toFixed(1)} Mbps`;
  }

  function npuTitle(d) {
    if (d.npuLabel === 'hardware') return 'NPU hardware load (sysfs)';
    if (d.npuLabel === 'duty-cycle') {
      return `NPU duty cycle from inference (${d.workers} worker(s)). ~ = estimated, not silicon counter.`;
    }
    if (d.npu != null) return 'NPU utilization';
    return 'NPU not available — start detection on board';
  }

  function renderMetricItem(m) {
    return `
    <div class="ov-metric-item" title="${m.title || ''}">
      ${m.icon}
      <span class="ov-metric-label">${m.label}</span>
      <span class="ov-metric-value ${m.cls}">${m.value}</span>
    </div>`;
  }

  function renderStorageItem(d) {
    const pct = Math.max(0, Math.min(100, Math.round(d.storagePct)));
    const cls = navPctClass(pct);
    const usedGb = formatBytesGb(d.storageUsed);
    const totalGb = formatBytesGb(d.storageTotal);
    const hasDetail = usedGb && totalGb && d.storageTotal > 0;
    const title = hasDetail
      ? `Disk: ${usedGb} GB used of ${totalGb} GB (${pct}%) — board root filesystem`
      : 'Disk usage on board';
    const valueText = meta.offline ? '—' : (hasDetail ? `${pct}%` : (pct > 0 ? `${pct}%` : '—'));

    return `
    <div class="ov-metric-item ov-metric-item--storage" title="${title}">
      ${ICONS.disk}
      <span class="ov-metric-label">Disk</span>
      <span class="ov-metric-bar-inline" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="Storage used">
        <span class="ov-metric-bar-fill ${cls}" style="width:${hasDetail && !meta.offline ? pct : 0}%"></span>
      </span>
      <span class="ov-metric-value ${cls}">${valueText}</span>
    </div>`;
  }

  function render(d) {
    const strip = document.getElementById('liveMetricsStrip');
    if (!strip) return;

    const stale = meta.fetchedAt && Date.now() - meta.fetchedAt > STALE_MS;
    const offline = meta.offline || stale;
    strip.classList.toggle('ov-metrics-strip--offline', offline);
    strip.classList.toggle('ov-metrics-strip--live', !offline && meta.live);

    if (!d && offline) {
      strip.innerHTML = '<div class="ov-metric-item ov-metric-item--offline">Board offline</div>';
      return;
    }
    if (!d) return;

    const boardHint = meta.board ? ` · ${meta.board}` : '';
    const items = [
      {
        icon: ICONS.cpu,
        label: 'CPU',
        value: offline || d.cpu == null || Number.isNaN(d.cpu) ? '—' : `${d.cpu}%`,
        cls: offline || d.cpu == null || Number.isNaN(d.cpu) ? 'muted' : navPctClass(d.cpu),
        title: `CPU load on vision board${boardHint}`,
      },
      {
        icon: ICONS.brain,
        label: 'NPU',
        value: formatNpu(d),
        cls: offline ? 'muted' : (d.npu != null && !Number.isNaN(d.npu) ? navPctClass(d.npu) : 'muted'),
        title: npuTitle(d),
      },
      {
        icon: ICONS.ram,
        label: 'RAM',
        value: offline || d.ramPct == null || Number.isNaN(d.ramPct) ? '—' : `${d.ramPct}%`,
        cls: offline || d.ramPct == null || Number.isNaN(d.ramPct) ? 'muted' : navPctClass(d.ramPct),
        title: `RAM pressure on board (unavailable memory)${boardHint}`,
      },
      null,
      {
        icon: ICONS.temp,
        label: 'Temp',
        value: offline || d.temp == null || Number.isNaN(d.temp) ? '—' : `${d.temp}°C`,
        cls: offline || d.temp == null || Number.isNaN(d.temp) ? 'muted' : tempClass(d.temp),
        title: d.tempSource === 'thermal'
          ? `SoC max thermal zone${boardHint}`
          : `Board temperature${boardHint}`,
      },
      {
        icon: ICONS.net,
        label: 'Net ↓',
        value: formatNet(d),
        cls: offline ? 'muted' : '',
        title: 'Download throughput on primary network interface',
      },
    ];

    strip.innerHTML = items
      .map((m, i) => (i === 3 ? renderStorageItem(d) : renderMetricItem(m)))
      .join('');
  }

  async function poll() {
    if (document.hidden) return;
    const d = await fetchLiveStats();
    render(d);
  }

  async function init() {
    const strip = document.getElementById('liveMetricsStrip');
    if (!strip) return;

    await poll();
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(poll, POLL_MS);
  }

  function stop() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  window.LiveMetrics = { init, render, stop, fetchLiveStats, POLL_MS };
})();
