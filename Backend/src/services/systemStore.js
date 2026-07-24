/**
 * systemStore.js
 *
 * In-memory ring buffer for system metrics, consistent with the project's
 * pattern (cameras/workers/cameraLogs are all in-memory Maps).
 *
 * Sampled every SAMPLE_INTERVAL_MS, kept for HISTORY_MINUTES.
 * Imported once — Node's module cache ensures a single shared instance.
 */

const os   = require('os');
const fs   = require('fs');
const si   = require('systeminformation');
const { workers } = require('../store');   // shared worker map (src/store.js)
const log = require('../utils/logger').child('system');

// ── Tunables ──────────────────────────────────────────────────────────────────
const SAMPLE_INTERVAL_MS = 5_000;          // collect every 5 s
const HISTORY_MINUTES    = 60;             // keep 1 hr of samples
const MAX_SAMPLES        = (HISTORY_MINUTES * 60_000) / SAMPLE_INTERVAL_MS; // 720

// ── Ring buffer ───────────────────────────────────────────────────────────────
/** @type {Array<SystemSample>} */
const history = [];

// ── NPU sysfs helper ─────────────────────────────────────────────────────────
// Amlogic VIM3 / A311D — galcore kernel module exposes load at this path.
// Falls back gracefully on non-VIM3 hardware (dev laptop, etc.).
const NPU_LOAD_PATHS = [
  process.env.NPU_SYSFS_PATH,                    // allow override via .env
  '/sys/kernel/debug/galcore/load',              // ← Correct path for your board
  '/sys/kernel/debug/galcore/status',
  '/sys/devices/platform/ff100000.galcore/load',
];

function readNpuLoad() {
  for (const p of NPU_LOAD_PATHS.filter(Boolean)) {
    try {
      if (!fs.existsSync(p)) continue;

      const raw = fs.readFileSync(p, 'utf8').trim();
      log.debug({ path: p, raw }, 'NPU raw');

      // Parse formats like:
      // "core : 0\nload : 27%"
      const match = raw.match(/load\s*:\s*(\d+)/i);
      if (match) {
        const load = parseFloat(match[1]);
        return Math.min(100, Math.round(load));
      }

      // Fallback: extract any number
      const numMatch = raw.match(/(\d+(\.\d+)?)/);
      if (numMatch) {
        const load = parseFloat(numMatch[1]);
        return load <= 100 ? Math.round(load) : null;
      }
    } catch (err) {
      // silent - try next path
    }
  }
  return null;   // NPU not available on this hardware
}

// ── Device info (read once) ───────────────────────────────────────────────────
let _deviceInfo = null;

async function getDeviceInfo() {
  if (_deviceInfo) return _deviceInfo;

  const [cpu, osInfo, system, versions] = await Promise.all([
    si.cpu(),
    si.osInfo(),
    si.system(),
    si.versions(),
  ]);

  // NPU driver version from sysfs / dmesg fallback
  let npu_driver = 'unknown';
  try {
    npu_driver = fs.readFileSync('/sys/kernel/debug/galcore/version', 'utf8').trim();
  } catch {
    try {
      npu_driver = fs.readFileSync('/sys/module/galcore/version', 'utf8').trim();
    } catch {}
  }
  // License stub — replace with real license check in production
  let license_status = 'unlicensed';
  try {
    const lic = fs.readFileSync('/etc/atomo/license.key', 'utf8').trim();
    license_status = lic.length > 0 ? 'active' : 'missing';
  } catch { license_status = 'not_found'; }

  _deviceInfo = {
    serial:         system.serial || os.hostname(),
    hostname:       os.hostname(),
    platform:       osInfo.platform,
    distro:         osInfo.distro,
    os_version:     osInfo.release,
    kernel:         osInfo.kernel,
    arch:           osInfo.arch,
    cpu_model:      cpu.manufacturer + ' ' + cpu.brand,
    cpu_cores:      os.cpus().length,
    npu_driver,
    node_version:   versions.node || process.version,
    license_status,
  };
  return _deviceInfo;
}

// ── Single sample collection ──────────────────────────────────────────────────
async function collectSample() {
  try {
    const [load, mem, temp] = await Promise.all([
      si.currentLoad(),
      si.mem(),
      si.cpuTemperature(),
    ]);

    // Aggregate live worker metrics from the shared workers Map
    let total_fps = 0, total_inf_ms = 0, worker_count = 0;
    for (const w of workers.values()) {
      total_fps    += w.fps          || 0;
      total_inf_ms += w.inference_ms || 0;
      worker_count++;
    }

    /** @type {SystemSample} */
    const sample = {
      timestamp:    new Date().toISOString(),
      ts:           Date.now(),

      // CPU
      cpu_load:     Math.round(load.currentLoad * 10) / 10,        // %
      cpu_cores:    load.cpus?.map(c => Math.round(c.load * 10) / 10) ?? [],

      // RAM
      ram_total:    mem.total,
      ram_used:     mem.used,
      ram_free:     mem.available,
      ram_pct:      Math.round((mem.used / mem.total) * 1000) / 10, // %

      // Temperature
      cpu_temp:     temp.main ?? temp.max ?? null,   // °C, null if unavailable

      // NPU
      npu_load:     readNpuLoad(),                   // %, null if unavailable

      // Workers
      worker_count,
      total_fps:    Math.round(total_fps * 10) / 10,
      avg_inf_ms:   worker_count > 0
                      ? Math.round((total_inf_ms / worker_count) * 10) / 10
                      : 0,
    };

    history.push(sample);
    if (history.length > MAX_SAMPLES) history.shift();

    return sample;
  } catch (err) {
    log.error({ err: err.message }, 'collect error');
    return null;
  }
}

// ── Start background poller ───────────────────────────────────────────────────
let _started = false;
function startPoller() {
  if (_started) return;
  _started = true;
  // Collect immediately so first GET /stats has real data
  collectSample();
  setInterval(collectSample, SAMPLE_INTERVAL_MS);
}

// ── Public helpers ────────────────────────────────────────────────────────────

/** Latest sample, or null if none collected yet */
function latest() {
  return history.length > 0 ? history[history.length - 1] : null;
}

/**
 * Samples within the last `minutes` minutes (default 60).
 * Returns them oldest-first (natural time-series order).
 */
function since(minutes = 60) {
  const cutoff = Date.now() - minutes * 60_000;
  return history.filter(s => s.ts >= cutoff);
}

module.exports = { startPoller, latest, since, collectSample, getDeviceInfo, readNpuLoad };
