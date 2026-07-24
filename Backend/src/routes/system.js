/**
 * system.js — System monitoring routes
 *
 * GET /api/system/stats           → live snapshot (CPU, RAM, temp, NPU, uptime)
 * GET /api/system/history         → time-series ring buffer (?minutes=60)
 * GET /api/system/models/usage    → per-model cpu/npu/fps from live workers
 * GET /api/system/cameras/usage   → per-camera fps + bandwidth estimate
 * GET /api/system/suggestions     → rule-based optimisation hints
 * GET /api/system/info            → device hardware / firmware metadata
 */

const router  = require('express').Router();
const os      = require('os');
const log = require('../utils/logger').child('system');
const { requireAuth, requireRole } = require('../middleware/auth');
const { workers, cameras, models }  = require('../store');
const { latest, since, collectSample, getDeviceInfo } = require('../services/systemStore');

// ── helpers ───────────────────────────────────────────────────────────────────
function bytes(n) { return Math.round(n); }  // keep raw bytes, let client format

// Estimate bandwidth: width × height × fps × 3 bytes (raw BGR) then assume
// ~10:1 H.264 compression. Pure heuristic — real value needs pcap.
function estimateBandwidthBps(w, h, fps) {
  return Math.round((w * h * 3 * fps) / 10);
}

// ── GET /api/system/stats ─────────────────────────────────────────────────────
router.get('/stats', requireAuth, async (req, res) => {
  try {
    // Always do a fresh collect for /stats (caller wants live data)
    log.trace('collecting fresh system sample');
    const s = await collectSample();
    if (!s) {
      log.warn('metrics not yet available');
      return res.status(503).json({ error: 'Metrics not yet available' });
    }

    log.trace({ cpu_load: s.cpu_load, ram_pct: s.ram_pct }, 'system stats collected');
    res.json({
      timestamp:    s.timestamp,
      uptime_s:     Math.floor(os.uptime()),
      uptime_human: fmtUptime(os.uptime()),

      cpu: {
        load_pct:  s.cpu_load,
        cores:     s.cpu_cores,
        temp_c:    s.cpu_temp,
      },
      ram: {
        total:    bytes(s.ram_total),
        used:     bytes(s.ram_used),
        free:     bytes(s.ram_free),
        used_pct: s.ram_pct,
      },
      npu: {
        load_pct:     s.npu_load,
        available:    s.npu_load !== null,
      },
      workers: {
        count:      s.worker_count,
        total_fps:  s.total_fps,
        avg_inf_ms: s.avg_inf_ms,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/system/history ───────────────────────────────────────────────────
// ?minutes=60   (default 60, max 60 regardless of ring buffer depth)
router.get('/history', requireAuth, (req, res) => {
  const minutes = Math.min(60, Math.max(1, parseInt(req.query.minutes) || 60));
  const samples = since(minutes);

  // Return a leaner time-series shape — no need to repeat per-core arrays
  res.json({
    device_id:  os.hostname(),
    minutes,
    count:      samples.length,
    interval_s: 5,
    series: samples.map(s => ({
      t:          s.ts,
      timestamp:  s.timestamp,
      cpu_pct:    s.cpu_load,
      ram_pct:    s.ram_pct,
      cpu_temp:   s.cpu_temp,
      npu_pct:    s.npu_load,
      workers:    s.worker_count,
      total_fps:  s.total_fps,
      avg_inf_ms: s.avg_inf_ms,
    })),
  });
});

// ── GET /api/system/models/usage ─────────────────────────────────────────────
router.get('/models/usage', requireAuth, (req, res) => {
  const usage = [];

  for (const [key, w] of workers.entries()) {
    const model = models.get(w.model_id);
    const cam   = cameras.get(w.camera_id);

    // Find any existing entry for this model (merge multiple cameras)
    let entry = usage.find(u => u.model_id === w.model_id);
    if (!entry) {
      entry = {
        model_id:    w.model_id,
        model_name:  model?.name ?? w.model_id,
        cameras:     [],
        total_fps:   0,
        avg_inf_ms:  0,
        inf_ms_sum:  0,
        worker_count: 0,
        npu_load:    null,   // per-model NPU breakdown not available via sysfs
        status:      'running',
      };
      usage.push(entry);
    }

    entry.cameras.push(w.camera_id);
    entry.total_fps    += w.fps          || 0;
    entry.inf_ms_sum   += w.inference_ms || 0;
    entry.worker_count += 1;
  }

  // Finalise averages
  for (const u of usage) {
    u.avg_inf_ms = u.worker_count > 0
      ? Math.round((u.inf_ms_sum / u.worker_count) * 10) / 10
      : 0;
    u.total_fps = Math.round(u.total_fps * 10) / 10;
    delete u.inf_ms_sum;  // internal accumulator, not useful to client
  }

  // Include inactive models with zero stats for completeness
  for (const [mid, m] of models.entries()) {
    if (!usage.find(u => u.model_id === mid)) {
      usage.push({
        model_id:     mid,
        model_name:   m.name,
        cameras:      [],
        total_fps:    0,
        avg_inf_ms:   0,
        worker_count: 0,
        npu_load:     null,
        status:       'idle',
      });
    }
  }

  res.json(usage);
});

// ── GET /api/system/cameras/usage ────────────────────────────────────────────
router.get('/cameras/usage', requireAuth, (req, res) => {
  // Build a map: camera_id → {fps_total, bandwidth_bps, models running}
  const camMap = new Map();

  for (const [key, w] of workers.entries()) {
    if (!camMap.has(w.camera_id)) {
      const cam = cameras.get(w.camera_id);
      camMap.set(w.camera_id, {
        camera_id:     w.camera_id,
        camera_name:   cam?.name ?? w.camera_id,
        rtsp_url:      cam?.rtsp_url ?? w.local_rtsp ?? null,
        width:         cam?.width  ?? 1920,
        height:        cam?.height ?? 1080,
        models:        [],
        fps_current:   0,
        bandwidth_bps: 0,
        worker_count:  0,
      });
    }
    const entry = camMap.get(w.camera_id);
    entry.models.push(w.model_id);
    entry.fps_current  += w.fps || 0;
    entry.worker_count += 1;
  }

  // Bandwidth estimate per camera (based on stream resolution × fps)
  const result = [];
  for (const [cid, entry] of camMap.entries()) {
    entry.fps_current   = Math.round(entry.fps_current * 10) / 10;
    // Use detected fps from first worker as stream fps; fall back to 25
    const streamFps = entry.fps_current || 25;
    entry.bandwidth_bps = estimateBandwidthBps(entry.width, entry.height, streamFps);
    entry.bandwidth_mbps = Math.round(entry.bandwidth_bps / 1_000_00) / 10;
    result.push(entry);
  }

  // Cameras with no active workers
  for (const [cid, cam] of cameras.entries()) {
    if (!camMap.has(cid)) {
      result.push({
        camera_id:     cid,
        camera_name:   cam.name ?? cid,
        rtsp_url:      cam.rtsp_url ?? null,
        width:         cam.width  ?? 1920,
        height:        cam.height ?? 1080,
        models:        [],
        fps_current:   0,
        bandwidth_bps: 0,
        bandwidth_mbps: 0,
        worker_count:  0,
      });
    }
  }

  res.json(result);
});

// ── GET /api/system/suggestions ──────────────────────────────────────────────
router.get('/suggestions', requireAuth, (req, res) => {
  const s    = latest();
  const hints = [];

  // ── CPU rules ──────────────────────────────────────────────────────────────
  if (s) {
    if (s.cpu_load > 85) {
      hints.push({
        severity: 'high',
        category: 'cpu',
        message:  `CPU load is ${s.cpu_load}% — consider reducing inference frequency.`,
        actions: [
          'Lower --fps flag on active workers (e.g. from 10 to 5)',
          'Disable unused capabilities (gender_classification, no_ppe_alert)',
          'Stop idle workers via POST /api/detect/stop',
        ],
      });
    } else if (s.cpu_load > 65) {
      hints.push({
        severity: 'medium',
        category: 'cpu',
        message:  `CPU load is ${s.cpu_load}% — system is under moderate load.`,
        actions:  ['Monitor trends; reduce fps if load continues rising.'],
      });
    }

    // ── RAM rules ────────────────────────────────────────────────────────────
    if (s.ram_pct > 85) {
      hints.push({
        severity: 'high',
        category: 'ram',
        message:  `RAM usage is ${s.ram_pct}% (${fmtBytes(s.ram_used)} / ${fmtBytes(s.ram_total)}).`,
        actions: [
          'Stop unused workers',
          'Reduce --jpeg-quality to lower frame buffer size',
          'Restart workers that have been running > 24 h',
        ],
      });
    }

    // ── Temperature rules ────────────────────────────────────────────────────
    if (s.cpu_temp !== null) {
      if (s.cpu_temp > 80) {
        hints.push({
          severity: 'high',
          category: 'thermal',
          message:  `CPU temperature is ${s.cpu_temp}°C — thermal throttling likely.`,
          actions: [
            'Check heatsink / fan on VIM3',
            'Reduce number of simultaneous inference workers',
            'Lower NPU performance level (--level 0)',
          ],
        });
      } else if (s.cpu_temp > 70) {
        hints.push({
          severity: 'medium',
          category: 'thermal',
          message:  `CPU temperature is ${s.cpu_temp}°C — approaching throttle threshold.`,
          actions:  ['Ensure adequate airflow; monitor over next 10 minutes.'],
        });
      }
    }

    // ── NPU rules ────────────────────────────────────────────────────────────
    if (s.npu_load !== null && s.npu_load > 90) {
      hints.push({
        severity: 'high',
        category: 'npu',
        message:  `NPU load is ${s.npu_load}% — inference queue saturated.`,
        actions: [
          'Reduce number of concurrent models on same NPU',
          'Lower input resolution (add --imgsz 320 for custom models)',
          'Stagger camera feeds to avoid simultaneous inference',
        ],
      });
    }
  }

  // ── Worker-level rules ────────────────────────────────────────────────────
  const camLoad = new Map();   // camera_id → worker count
  for (const w of workers.values()) {
    camLoad.set(w.camera_id, (camLoad.get(w.camera_id) || 0) + 1);
    if ((w.inference_ms || 0) > 200) {
      hints.push({
        severity: 'medium',
        category: 'inference',
        message:  `Worker ${w.camera_id}::${w.model_id} inference is ${w.inference_ms} ms — above 200 ms target.`,
        actions: [
          'Check NPU driver / library version',
          'Ensure no other processes are competing for NPU',
          'Try --level 1 (batched NPU scheduling)',
        ],
      });
    }
    if ((w.fps || 0) < 2 && s) {
      hints.push({
        severity: 'low',
        category: 'throughput',
        message:  `Worker ${w.camera_id}::${w.model_id} is processing at only ${w.fps} FPS.`,
        actions:  ['Check RTSP stream health and network latency.'],
      });
    }
  }

  for (const [camId, count] of camLoad.entries()) {
    if (count > 3) {
      hints.push({
        severity: 'medium',
        category: 'concurrency',
        message:  `Camera ${camId} is running ${count} simultaneous models.`,
        actions:  ['Consider reducing to ≤ 3 models per camera to keep NPU responsive.'],
      });
    }
  }

  if (workers.size === 0) {
    hints.push({
      severity: 'info',
      category: 'idle',
      message:  'No inference workers are currently running.',
      actions:  ['Start a worker via POST /api/detect/start to begin detection.'],
    });
  }

  if (hints.length === 0) {
    hints.push({
      severity: 'info',
      category: 'ok',
      message:  'System is operating within normal parameters.',
      actions:  [],
    });
  }

  res.json({
    evaluated_at: new Date().toISOString(),
    worker_count: workers.size,
    hints,
  });
});

// ── GET /api/system/info ──────────────────────────────────────────────────────
router.get('/info', requireAuth, async (req, res) => {
  try {
    const info = await getDeviceInfo();
    res.json({
      ...info,
      uptime_s:     Math.floor(os.uptime()),
      uptime_human: fmtUptime(os.uptime()),
      pid:          process.pid,
      node_version: process.version,
      env:          process.env.NODE_ENV || 'development',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Utility formatters ────────────────────────────────────────────────────────
function fmtUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

function fmtBytes(b) {
  if (b >= 1_073_741_824) return (b / 1_073_741_824).toFixed(1) + ' GB';
  if (b >= 1_048_576)     return (b / 1_048_576).toFixed(1) + ' MB';
  return (b / 1024).toFixed(0) + ' KB';
}

module.exports = router;
