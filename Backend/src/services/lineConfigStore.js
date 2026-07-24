/**
 * lineConfigStore.js
 *
 * Holds the "tripwire" line-crossing configuration per camera, so a frontend
 * can let an operator draw a line over the video preview and persist it here
 * — the same config is then passed to face_worker.py's start_stream command
 * (see rtsp_stream_processor's line_crossing_enabled/line_y/line_direction/
 * line_x_start/line_x_end args) every time that camera's face stream starts.
 *
 * All coordinates are normalized (0.0–1.0) fractions of frame width/height,
 * NOT pixels — this keeps the config resolution-independent, matching how
 * the worker itself scales them (`y_line = h_img * line_y`, etc).
 */

const DEFAULTS = Object.freeze({
  enabled:  false,
  line_y:      0.6,   // horizontal line position, 0 = top, 1 = bottom
  direction:   'in',  // 'in' | 'out' | 'both'
  x_start:     0.0,   // line segment start, 0 = left edge
  x_end:       1.0,   // line segment end, 1 = right edge
});

const VALID_DIRECTIONS = new Set(['in', 'out', 'both']);

// camera_id -> config
const configs = new Map();
const log = require('../utils/logger').child('lineConfig');

function frac(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
}

/** Validate + normalize a partial config against current/defaults, throws on bad input. */
function buildConfig(camera_id, body = {}) {
  const current = configs.get(camera_id) || { ...DEFAULTS };

  const enabled = body.enabled !== undefined ? !!body.enabled : current.enabled;

  const line_y = body.line_y !== undefined ? frac(body.line_y, null) : current.line_y;
  if (line_y === null) throw new Error('line_y must be a number between 0 and 1');

  let x_start = body.x_start !== undefined ? frac(body.x_start, null) : current.x_start;
  if (x_start === null) throw new Error('x_start must be a number between 0 and 1');

  let x_end = body.x_end !== undefined ? frac(body.x_end, null) : current.x_end;
  if (x_end === null) throw new Error('x_end must be a number between 0 and 1');

  if (x_end < x_start) [x_start, x_end] = [x_end, x_start];
  // The worker currently evaluates crossings against a horizontal Y line.
  // A vertical/equal-X line from the UI must not make start recognition fail.
  if (x_end - x_start < 0.001) {
    x_start = 0;
    x_end = 1;
  }

  const direction = body.direction !== undefined ? body.direction : current.direction;
  if (!VALID_DIRECTIONS.has(direction))
    throw new Error(`direction must be one of: ${[...VALID_DIRECTIONS].join(', ')}`);

  return { enabled, line_y, direction, x_start, x_end };
}

/** Set (create or update) a camera's line config. Throws on invalid input. */
function setConfig(camera_id, body) {
  const cfg = buildConfig(camera_id, body);
  configs.set(camera_id, cfg);
  log.info({ camera_id, config: cfg }, 'set line config');
  return cfg;
}

/** Get a camera's line config, or the disabled default if none was ever set. */
function getConfig(camera_id) {
  return configs.get(camera_id) || { ...DEFAULTS };
}

function deleteConfig(camera_id) {
  configs.delete(camera_id);
  log.info({ camera_id }, 'deleted line config');
}

module.exports = { setConfig, getConfig, deleteConfig, DEFAULTS };
