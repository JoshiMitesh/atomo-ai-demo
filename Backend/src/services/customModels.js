/**
 * customModels.js — extract & register custom model ZIPs.
 *
 * Supported ZIP layouts
 * ─────────────────────
 * Layout A — NPU (.nb + .so)        ← existing behaviour, unchanged
 *   animal.nb
 *   libnn_animal.so
 *   data.yaml          (class names)
 *
 * Layout B — TFLite                 ← NEW
 *   model.tflite
 *   classes.txt  (or labels.txt / names.txt / data.yaml)
 *
 * Layout C — ONNX                   ← NEW
 *   model.onnx
 *   classes.txt  (or labels.txt / names.txt / data.yaml)
 *
 * The registered model object always contains:
 *   format          'nb' | 'tflite' | 'onnx'
 *   model_path      absolute path to the model file
 *   library_path    absolute path to .so  (nb only, else null)
 *   script_path     absolute path to the detector Python script
 *   class_names     string[]
 *   input_size      number (default 640; read from yaml if present)
 *   default_conf    number
 *   default_nms     number
 */

'use strict';

const path    = require('path');
const fs      = require('fs');
const AdmZip  = require('adm-zip');
const yaml    = require('js-yaml');          // npm install js-yaml
const { models, uuidv4 } = require('../store');
const log     = require('../utils/logger').child('customModels');

// ── Directories ───────────────────────────────────────────────────────────────
const PROJECT_ROOT  = path.join(__dirname, '../..');
const UPLOAD_DIR    = path.join(PROJECT_ROOT, 'uploads');
const EXTRACT_BASE  = path.join(PROJECT_ROOT, 'models');
const DETECTORS_DIR = path.join(PROJECT_ROOT, 'detectors');

// Built-in detector scripts for each format
const DETECTOR_SCRIPTS = {
  nb:      path.join(DETECTORS_DIR, 'generic_detector.py'),
  tflite:  path.join(DETECTORS_DIR, 'tflite_detector.py'),
  onnx:    path.join(DETECTORS_DIR, 'onnx_detector.py'),
};

[UPLOAD_DIR, EXTRACT_BASE].forEach(d => fs.mkdirSync(d, { recursive: true }));

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Pick the first file in `files` whose extension matches one of `exts`. */
function pick(files, ...exts) {
  return files.find(f => exts.includes(path.extname(f).toLowerCase())) || null;
}

/**
 * Parse class names from whatever metadata file is present.
 * Supports:
 *   data.yaml / config.yaml  — YOLO-style: { names: ['dog','cat',...] }
 *   *.txt / *.names / *.labels — one class per line
 */
function parseClassNames(dir, files) {
  // 1. YAML first
  const yamlFile = files.find(f =>
    ['.yaml', '.yml'].includes(path.extname(f).toLowerCase())
  );
  if (yamlFile) {
    try {
      const doc = yaml.load(fs.readFileSync(path.join(dir, yamlFile), 'utf8'));
      if (Array.isArray(doc?.names) && doc.names.length > 0) return doc.names.map(String);
    } catch {}
  }

  // 2. Plain text file
  const txtFile = files.find(f =>
    ['.txt', '.names', '.labels'].includes(path.extname(f).toLowerCase())
  );
  if (txtFile) {
    const lines = fs.readFileSync(path.join(dir, txtFile), 'utf8')
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean);
    if (lines.length > 0) return lines;
  }

  return [];
}

/**
 * Read optional numeric fields from data.yaml.
 * Returns { input_size, default_conf, default_nms } with safe defaults.
 */
function parseYamlConfig(dir, files) {
  const yamlFile = files.find(f =>
    ['.yaml', '.yml'].includes(path.extname(f).toLowerCase())
  );
  const cfg = { input_size: 640, default_conf: 0.45, default_nms: 0.56 };
  if (!yamlFile) return cfg;
  try {
    const doc = yaml.load(fs.readFileSync(path.join(dir, yamlFile), 'utf8')) || {};
    if (typeof doc.input_size  === 'number') cfg.input_size  = doc.input_size;
    if (typeof doc.conf        === 'number') cfg.default_conf = doc.conf;
    if (typeof doc.nms         === 'number') cfg.default_nms  = doc.nms;
  } catch {}
  return cfg;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Extract `zipPath`, detect model format, register in the models Map.
 * Returns the registered model object.
 * Throws on any validation error so the route can return HTTP 422.
 */
function registerModelFromZip(zipPath, { name, description } = {}) {
  const modelId   = 'mdl_custom_' + uuidv4().replace(/-/g, '').slice(0, 8);
  const extractDir = path.join(EXTRACT_BASE, modelId);
  fs.mkdirSync(extractDir, { recursive: true });

  // Extract
  try {
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(extractDir, /*overwrite*/ true);
  } catch (err) {
    fs.rmSync(extractDir, { recursive: true, force: true });
    throw new Error(`Failed to extract ZIP: ${err.message}`);
  }

  // Flat list of filenames (ignore sub-directories for now)
  const files = fs.readdirSync(extractDir).filter(f =>
    fs.statSync(path.join(extractDir, f)).isFile()
  );

  // ── Detect format ────────────────────────────────────────────────────────
  const nbFile      = pick(files, '.nb');
  const tfliteFile  = pick(files, '.tflite');
  const onnxFile    = pick(files, '.onnx');
  const soFile      = pick(files, '.so');

  let format, modelFile;

  if (tfliteFile) {
    format    = 'tflite';
    modelFile = tfliteFile;
  } else if (onnxFile) {
    format    = 'onnx';
    modelFile = onnxFile;
  } else if (nbFile) {
    format    = 'nb';
    modelFile = nbFile;
  } else {
    fs.rmSync(extractDir, { recursive: true, force: true });
    throw new Error('ZIP must contain a .tflite, .onnx, or .nb model file');
  }

  // .nb requires a matching .so
  if (format === 'nb' && !soFile) {
    fs.rmSync(extractDir, { recursive: true, force: true });
    throw new Error('ZIP with .nb model must also include a libnn_*.so library file');
  }

  // Class names are required for all formats
  const classNames = parseClassNames(extractDir, files);
  if (classNames.length === 0) {
    fs.rmSync(extractDir, { recursive: true, force: true });
    throw new Error(
      'ZIP must include a class-names file: data.yaml (YOLO format with `names:`), ' +
      'or a plain .txt / .names / .labels file (one class per line)'
    );
  }

  // Check the detector script exists on disk
  const scriptPath = DETECTOR_SCRIPTS[format];
  if (!fs.existsSync(scriptPath)) {
    fs.rmSync(extractDir, { recursive: true, force: true });
    throw new Error(
      `Detector script not found: ${scriptPath}. ` +
      `Please add detectors/${format}_detector.py to your project.`
    );
  }

  const yamlCfg = parseYamlConfig(extractDir, files);

  // ── Build model record ───────────────────────────────────────────────────
  const displayName = name?.trim() ||
    path.basename(modelFile, path.extname(modelFile))
        .replace(/[_-]/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase());

  const model = {
    id:           modelId,
    name:         displayName,
    description:  description || '',
    type:         'custom',
    format,                                             // 'nb' | 'tflite' | 'onnx'
    is_active:    true,
    tab_created:  true,
    version:      '1.0.0',

    // Paths
    extract_dir:  extractDir,
    script_path:  scriptPath,
    model_path:   path.join(extractDir, modelFile),
    library_path: format === 'nb'
                    ? path.join(extractDir, soFile)
                    : null,                             // ← null for tflite / onnx

    // Class info
    class_names:  classNames,
    capabilities: classNames,                          // alias used by detect routes

    // Inference defaults (from yaml or hard-coded)
    input_size:   yamlCfg.input_size,
    default_conf: yamlCfg.default_conf,
    default_nms:  yamlCfg.default_nms,

    assigned_cameras: [],
    created_at: new Date().toISOString(),
  };

  models.set(modelId, model);

  // Clean up the raw zip
  try { fs.unlinkSync(zipPath); } catch {}

  log.info({ modelId, format, class_count: classNames.length }, `Registered ${modelId}`);

  return model;
}

/**
 * Delete a custom model: remove its extracted files and deregister it.
 */
function deleteCustomModel(modelId) {
  const model = models.get(modelId);
  if (!model) throw new Error(`Model ${modelId} not found`);

  if (model.extract_dir && fs.existsSync(model.extract_dir)) {
    fs.rmSync(model.extract_dir, { recursive: true, force: true });
  }

  models.delete(modelId);
  log.info({ modelId }, `Deleted ${modelId}`);
}

module.exports = {
  UPLOAD_DIR,
  registerModelFromZip,
  deleteCustomModel,
};