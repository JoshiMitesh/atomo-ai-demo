/**
 * Board system stats → flat shape for the live metrics strip.
 * Board API returns nested objects; the UI expects flat percentages.
 */

const { createVisionClient } = require('./vision-api');

const boardClient = createVisionClient(
  process.env.VISION_API_URL || process.env.BACKEND_API_URL,
  { label: 'system-stats' },
);

let lastBoardStats = null;
let lastBoardAt = 0;

function num(v, fallback = null) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function pct(v) {
  const n = num(v, null);
  if (n == null) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * Normalize either nested board payload or already-flat stats.
 */
function normalizeBoardStats(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const cpuObj = raw.cpu && typeof raw.cpu === 'object' ? raw.cpu : null;
  const ramObj = raw.ram && typeof raw.ram === 'object' ? raw.ram : null;
  const npuObj = raw.npu && typeof raw.npu === 'object' ? raw.npu : null;
  const storageObj = raw.storage && typeof raw.storage === 'object' ? raw.storage : null;
  const netObj = raw.net && typeof raw.net === 'object' ? raw.net : null;
  const tempObj = raw.temp && typeof raw.temp === 'object' ? raw.temp : null;
  const workersObj = raw.workers && typeof raw.workers === 'object' ? raw.workers : null;

  const cpu = pct(
    cpuObj?.load_pct
    ?? raw.cpu_detail?.load_pct
    ?? (typeof raw.cpu === 'number' ? raw.cpu : null),
  );

  const ram = pct(
    ramObj?.used_pct
    ?? raw.ram_detail?.used_pct
    ?? (typeof raw.ram === 'number' ? raw.ram : null),
  );

  const npu = pct(
    npuObj?.load_pct
    ?? raw.npu_detail?.load_pct
    ?? (typeof raw.npu === 'number' ? raw.npu : null),
  );

  const temp = num(
    cpuObj?.temp_c
    ?? tempObj?.temp_c
    ?? tempObj?.celsius
    ?? raw.temp_detail?.temp_c
    ?? (typeof raw.temp === 'number' ? raw.temp : null),
    null,
  );

  const storagePct = pct(
    storageObj?.used_pct
    ?? raw.storage_detail?.used_pct
    ?? (typeof raw.storage === 'number' ? raw.storage : null),
  );

  const storageUsed = num(storageObj?.used ?? raw.storage_detail?.used, 0);
  const storageTotal = num(storageObj?.total ?? raw.storage_detail?.total, 0);

  const downloadMbps = num(
    netObj?.download_mbps
    ?? netObj?.rx_mbps
    ?? raw.net_detail?.download_mbps
    ?? (typeof raw.net === 'number' ? raw.net : null),
    null,
  );

  const npuAvailable = npuObj?.available !== false && npu != null;

  return {
    timestamp: raw.timestamp || new Date().toISOString(),
    uptime_s: num(raw.uptime_s, null),
    uptime_human: raw.uptime_human || null,
    board_hostname: raw.board_hostname || raw.hostname || raw.device_id || null,
    board: raw.board_hostname || raw.hostname || null,

    // Flat fields used by live-metrics.js
    cpu: cpu ?? 0,
    ram: ram ?? 0,
    npu: npuAvailable ? npu : null,
    temp: temp != null ? Math.round(temp) : null,
    storage: storagePct ?? 0,
    net: downloadMbps,

    cpu_detail: {
      load_pct: cpu ?? 0,
      cores: cpuObj?.cores ?? raw.cpu_detail?.cores ?? null,
      temp_c: temp,
    },
    ram_detail: {
      used_pct: ram ?? 0,
      total: num(ramObj?.total ?? raw.ram_detail?.total, null),
      used: num(ramObj?.used ?? raw.ram_detail?.used, null),
      free: num(ramObj?.free ?? raw.ram_detail?.free, null),
    },
    npu_detail: {
      load_pct: npu,
      available: npuAvailable,
      source: npuObj?.source || raw.npu_detail?.source || (npu != null ? 'hardware' : null),
      label: npuObj?.label || raw.npu_detail?.label || (npu != null ? 'hardware' : null),
    },
    storage_detail: {
      used_pct: storagePct ?? 0,
      used: storageUsed,
      total: storageTotal,
      mount: storageObj?.mount || raw.storage_detail?.mount || '/',
    },
    temp_detail: {
      temp_c: temp,
      source: temp != null ? (tempObj?.source || 'thermal') : null,
    },
    net_detail: {
      download_mbps: downloadMbps,
      upload_mbps: num(netObj?.upload_mbps ?? netObj?.tx_mbps, null),
      iface: netObj?.iface || null,
    },
    workers: {
      count: num(workersObj?.count, 0),
      total_fps: num(workersObj?.total_fps, 0),
      avg_inf_ms: num(workersObj?.avg_inf_ms, 0),
    },
  };
}

function cacheBoardStats(stats) {
  if (!stats || typeof stats !== 'object') return;
  lastBoardStats = stats;
  lastBoardAt = Date.now();
}

function getCachedBoardStats() {
  if (!lastBoardStats || !lastBoardAt) return null;
  const ageMs = Date.now() - lastBoardAt;
  return {
    ...lastBoardStats,
    age_ms: ageMs,
    live: false,
    _cached: true,
  };
}

async function fetchSystemStats() {
  try {
    const raw = await boardClient.apiJson('/api/system/stats');
    const stats = normalizeBoardStats(raw);
    if (!stats) throw new Error('empty board stats');
    cacheBoardStats(stats);
    return { ...stats, age_ms: 0, live: true, _fromBoard: true };
  } catch (err) {
    console.warn('[system-stats] board unreachable:', err.message);
    const cached = getCachedBoardStats();
    if (cached) return cached;
    return null;
  }
}

function getLocalSystemStats() {
  const os = require('os');
  const load = os.loadavg()[0] || 0;
  const cores = Math.max(1, os.cpus()?.length || 1);
  const cpuPct = Math.max(0, Math.min(100, Math.round((load / cores) * 100)));
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const ramPct = totalMem > 0 ? Math.round(((totalMem - freeMem) / totalMem) * 100) : 0;

  return {
    timestamp: new Date().toISOString(),
    uptime_s: Math.floor(os.uptime()),
    board_hostname: os.hostname(),
    board: os.hostname(),
    cpu: cpuPct,
    npu: null,
    ram: ramPct,
    storage: null,
    temp: null,
    net: null,
    cpu_detail: { load_pct: cpuPct, cores: null, temp_c: null },
    ram_detail: { used_pct: ramPct, total: totalMem, used: totalMem - freeMem, free: freeMem },
    npu_detail: { load_pct: null, available: false, source: null, label: null },
    storage_detail: { used_pct: 0, used: 0, total: 0 },
    temp_detail: { temp_c: null, source: null },
    net_detail: { download_mbps: null, upload_mbps: null },
    workers: { count: 0, total_fps: 0, avg_inf_ms: 0 },
    live: false,
    _fallback: true,
    _boardOffline: true,
  };
}

module.exports = {
  fetchSystemStats,
  getLocalSystemStats,
  getCachedBoardStats,
  normalizeBoardStats,
};
