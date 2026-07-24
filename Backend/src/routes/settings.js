const router = require('express').Router();
const { requireAuth } = require('../middleware/auth');
const { readDB, writeDB } = require('../services/dbStore');
const bridge = require('../services/faceWorkerBridge');
const { cameras } = require('../store');
const log = require('../utils/logger').child('settings');

let settings = {
  threshold: 0.60,
  dis_type: 0
};

try {
  const db = readDB();
  if (db.settings) {
    settings = { ...settings, ...db.settings };
  }
} catch (e) {}

function getSettings() { return settings; }

function saveSettings() {
  const db = readDB();
  db.settings = settings;
  writeDB(db);
}

router.get('/', requireAuth, (req, res) => {
  res.json(settings);
});

// POST /api/settings — mirrors small backend exactly:
// 1. Updates threshold/dis_type
// 2. Saves to DB
// 3. Restarts all active camera streams with new settings (so Python uses updated threshold)
// 4. Broadcasts stream_status
router.post('/', requireAuth, async (req, res) => {
  const { threshold, dis_type } = req.body || {};
  if (threshold !== undefined) settings.threshold = parseFloat(threshold);
  if (dis_type   !== undefined) settings.dis_type  = parseInt(dis_type);
  saveSettings();

  // Restart all active camera streams with updated settings (mirrors small backend)
  const activeCameras = Array.from(cameras.values()).filter(c => c.is_active);
  for (const cam of activeCameras) {
    try {
      const isLocal = (cam.url || cam.rtsp_url || '').startsWith('rtsp://localhost') ||
                      (cam.url || cam.rtsp_url || '').startsWith('rtsp://127.0.0.1');
      const targetRtsp = isLocal
        ? (cam.url || cam.rtsp_url)
        : `rtsp://127.0.0.1:8554/${cam.id}`;

      const personStore   = require('../services/personStore');
      const lineConfigStore = require('../services/lineConfigStore');
      const lineConfig = lineConfigStore.getConfig(cam.id);

      if (bridge.isReady()) {
        await bridge.startStream(
          cam.id, cam.name, targetRtsp,
          personStore.getCandidatesPayload(),
          settings.threshold,
          settings.dis_type,
          undefined,
          lineConfig
        );
        log.info({ cameraId: cam.id, threshold: settings.threshold }, 'Restarted stream with new settings');
      }
    } catch (e) {
      log.error({ cameraId: cam.id, err: e.message }, 'Failed to apply updated settings on running camera');
    }
  }

  const { broadcast } = require('../store/websocketBroadcast');
  if (broadcast) {
    broadcast({ event: 'stream_status', data: settings });
  }

  res.json({ success: true, settings });
});

module.exports = router;
module.exports.getSettings = getSettings;
