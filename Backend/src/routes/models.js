/**
 * Model routes — 9 endpoints
 *
 * GET    /api/models                   List all models
 * GET    /api/models/:id               Single model detail
 * POST   /api/models/upload            Upload custom .atomomodel (admin+) — legacy
 * POST   /api/models/upload-zip        Upload ZIP package (.nb + .so + data.yaml) (admin+)
 * POST   /api/models/:id/validate      Re-validate model package
 * POST   /api/models/:id/test          Run test inference
 * DELETE /api/models/:id               Delete custom model (admin+)
 * GET    /api/models/:id/assignments   List camera assignments
 * GET    /api/models/:id/classes       List class-name checkboxes for a custom model
 */

const router = require('express').Router();
const path   = require('path');
const fs     = require('fs');
const multer = require('multer');
const { models, cameras, uuidv4 } = require('../store');
const { requireAuth, requireRole } = require('../middleware/auth');
const log = require('../utils/logger').child('models');
const customModels = require('../services/customModels');

function notFound(res, id) {
  return res.status(404).json({ error: `Model ${id} not found` });
}

// ── multer storage for zip uploads ────────────────────────────────────────────
const zipUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, customModels.UPLOAD_DIR),
    filename:    (req, file, cb) => cb(null, `${Date.now()}_${file.originalname}`),
  }),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB — .nb files can be large
  fileFilter: (req, file, cb) => {
    const ok = file.mimetype === 'application/zip' ||
               file.mimetype === 'application/x-zip-compressed' ||
               file.originalname.toLowerCase().endsWith('.zip');
    ok ? cb(null, true) : cb(new Error('Only .zip files are accepted'));
  },
});

// ── GET /api/models ───────────────────────────────────────────────────────────

router.get('/', requireAuth, (req, res) => {
  log.debug({ reqId: req.id, modelCount: models.size }, 'listing all models');
  const list = Array.from(models.values()).map(m => ({
    id: m.id,
    name: m.name,
    type: m.type,
    is_active: m.is_active,
    tab_created: m.tab_created,
    version: m.version,
    capabilities: m.capabilities,
  }));
  log.trace({ count: list.length }, 'models list retrieved');
  res.json(list);
});

// ── GET /api/models/:id ───────────────────────────────────────────────────────

router.get('/:id', requireAuth, (req, res) => {
  const model = models.get(req.params.id);
  if (!model) return notFound(res, req.params.id);

  res.json({
    id: model.id,
    name: model.name,
    type: model.type,
    script_path: model.script_path,
    model_path: model.model_path,
    version: model.version,
    capabilities: model.capabilities,
    assigned_cameras: model.assigned_cameras,
    is_active: model.is_active,
  });
});

// ── POST /api/models/upload ───────────────────────────────────────────────────
// Must be before /:id to avoid route clash

router.post('/upload', requireAuth, requireRole('admin'), (req, res) => {
  // In production: use multer to receive multipart/form-data
  // const upload = multer({ dest: 'uploads/' });
  // The .atomomodel package is a zip containing:
  //   model.nb / model.onnx, labels.yaml, config.json, pre/post-processing config

  // Simulated upload handling:
  const { name, format = 'onnx', version = '1.0.0' } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });

  const id = 'mdl_' + uuidv4().slice(0, 6);
  const model = {
    id,
    name,
    type: 'custom',
    is_active: true,
    tab_created: true,
    version,
    script_path: `detectors/${name.toLowerCase().replace(/\s+/g, '_')}.py`,
    model_path: `models/${name.toLowerCase().replace(/\s+/g, '_')}/model.${format}`,
    capabilities: ['custom_detection'],
    assigned_cameras: [],
    format,
    test_passed: true,
    created_at: new Date().toISOString(),
  };

  models.set(id, model);

  res.status(201).json({
    id,
    name: model.name,
    tab_created: true,
    test_passed: true,
    format,
  });
});

// ── POST /api/models/upload-zip ───────────────────────────────────────────────
/**
 * Upload a ZIP package containing a custom NPU model:
 *   animal.nb
 *   libnn_animal.so
 *   data.yaml          (defines class names)
 *
 * multipart/form-data:
 *   package      — the .zip file (required)
 *   name         — display name (optional, defaults to zip filename)
 *   description  — optional description
 *
 * On success, each class in data.yaml's `names` becomes a capability
 * checkbox (e.g. "cow", "goat", "dog") that can be selectively enabled
 * via POST /api/detect/start { capabilities: ["cow"] }.
 *
 * Response:
 * {
 *   "id": "mdl_custom_a1b2c3d4",
 *   "name": "Animal Detection",
 *   "tab_created": true,
 *   "format": "nb",
 *   "classes": ["cow", "goat", "dog"],
 *   "input_size": 640,
 *   "default_conf": 0.45,
 *   "default_nms": 0.56
 * }
 */
router.post('/upload-zip', requireAuth, requireRole('admin'), zipUpload.single('package'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'package file required (multipart field: "package", a .zip)' });
  }

  const { name, description } = req.body || {};

  try {
    const model = customModels.registerModelFromZip(req.file.path, { name, description });

    res.status(201).json({
      id:            model.id,
      name:          model.name,
      tab_created:   true,
      format:        model.format,
      classes:       model.class_names,
      input_size:    model.input_size,
      default_conf:  model.default_conf,
      default_nms:   model.default_nms,
      message: `Model registered with ${model.class_names.length} classes: ${model.class_names.join(', ')}`,
    });
  } catch (err) {
    // Clean up the uploaded zip on failure
    try { fs.unlinkSync(req.file.path); } catch {}
    res.status(422).json({ error: err.message });
  }
});

// ── GET /api/models/:id/classes ───────────────────────────────────────────────
/**
 * Returns the list of class-name checkboxes for a custom model,
 * to render as a checkbox UI before calling /api/detect/start.
 *
 * Response:
 * {
 *   "model_id": "mdl_custom_a1b2c3d4",
 *   "model_name": "Animal Detection",
 *   "classes": ["cow", "goat", "dog"],
 *   "default_conf": 0.45,
 *   "default_nms": 0.56,
 *   "input_size": 640
 * }
 */
router.get('/:id/classes', requireAuth, (req, res) => {
  const model = models.get(req.params.id);
  if (!model) return notFound(res, req.params.id);

  res.json({
    model_id:     model.id,
    model_name:   model.name,
    classes:      model.class_names || model.capabilities || [],
    default_conf: model.default_conf ?? 0.45,
    default_nms:  model.default_nms ?? 0.56,
    input_size:   model.input_size ?? 640,
  });
});


// ── POST /api/models/:id/validate ─────────────────────────────────────────────

router.post('/:id/validate', requireAuth, (req, res) => {
  const model = models.get(req.params.id);
  if (!model) return notFound(res, req.params.id);

  // In production: actually inspect the model file for shape compatibility
  res.json({
    valid: true,
    format: model.format || 'nb',
    input_shape: [1, 3, 640, 640],
    output_shape: [1, 84, 8400],
  });
});

// ── POST /api/models/:id/test ─────────────────────────────────────────────────

router.post('/:id/test', requireAuth, (req, res) => {
  const model = models.get(req.params.id);
  if (!model) return notFound(res, req.params.id);

  const { image_b64 } = req.body || {};
  if (!image_b64) return res.status(400).json({ error: 'image_b64 required' });

  // In production: run actual inference on the provided image
  const mockDetections = {
    mdl_person: [{ class: 'person', score: 0.87, box: [0.1, 0.15, 0.4, 0.85] }],
    mdl_face:   [{ class: 'face', score: 0.92, box: [0.3, 0.1, 0.6, 0.5] }],
    mdl_fire:   [{ class: 'fire', score: 0.76, box: [0.5, 0.3, 0.9, 0.7] }],
    mdl_ppe:    [
      { class: 'helmet', score: 0.91, box: [0.2, 0.05, 0.45, 0.3] },
      { class: 'vest',   score: 0.83, box: [0.15, 0.3, 0.55, 0.8] },
    ],
  };

  res.json({
    inference_ms: parseFloat((30 + Math.random() * 25).toFixed(1)),
    detections: mockDetections[req.params.id] || [{ class: 'object', score: 0.78, box: [0.1, 0.1, 0.6, 0.6] }],
  });
});

// ── DELETE /api/models/:id ────────────────────────────────────────────────────

router.delete('/:id', requireAuth, requireRole('admin'), (req, res) => {
  const model = models.get(req.params.id);
  if (!model) return notFound(res, req.params.id);

  if (model.type === 'builtin') {
    return res.status(403).json({ error: 'Built-in models cannot be deleted' });
  }

  // Stop any running workers for this model
  const { workers } = require('../store');
  const { stopWorker } = require('../services/worker');
  for (const [key] of workers.entries()) {
    if (key.endsWith('::' + req.params.id)) {
      const camId = key.split('::')[0];
      try { stopWorker(camId, req.params.id); } catch {}
    }
  }

  // For ZIP-uploaded models, also remove extracted files from disk
  if (model.extract_dir) {
    try { customModels.deleteCustomModel(req.params.id); }
    catch { models.delete(req.params.id); }
  } else {
    models.delete(req.params.id);
  }

  res.json({ ok: true });
});

// ── GET /api/models/:id/assignments ──────────────────────────────────────────

router.get('/:id/assignments', requireAuth, (req, res) => {
  const model = models.get(req.params.id);
  if (!model) return notFound(res, req.params.id);

  const { workers } = require('../store');

  const assignments = model.assigned_cameras.map(camId => {
    const cam = cameras.get(camId);
    const key = `${camId}::${req.params.id}`;
    const worker = workers.get(key);
    return {
      camera_id: camId,
      camera_name: cam?.name || 'Unknown',
      confidence: worker?.config?.confidence || 0.45,
      fps: worker?.fps || 0,
      status: worker ? 'running' : 'idle',
      enabled_capabilities: worker?.enabled_capabilities || model.capabilities,
    };
  });

  res.json(assignments);
});

module.exports = router;
