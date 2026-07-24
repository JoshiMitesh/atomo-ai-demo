/**
 * Dashboard face clusters — group recurring UNKNOWN faces from live recognition.
 *
 * Same person (high embedding similarity) → one bunch of crops.
 * Label → enroll as Person so recognition works next time.
 */
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STORE_PATH = path.join(DATA_DIR, 'face-clusters.json');
const SNAP_DIR = path.join(DATA_DIR, 'face-cluster-snaps');

const MAX_CLUSTERS = 120;
const MAX_EMBEDS = 16;
const MAX_CROPS = 12;
/** SFace cosine similarity — same person usually well above this. */
const DEFAULT_THRESHOLD = 0.50;
const MIN_EMBED_DIM = 64;

let threshold = DEFAULT_THRESHOLD;
/** @type {Map<string, object>} */
const clusters = new Map();
let loaded = false;
let saveTimer = null;

function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(SNAP_DIR, { recursive: true });
}

function cosineSim(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length < 8 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = Number(a[i]) || 0;
    const y = Number(b[i]) || 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na <= 1e-12 || nb <= 1e-12) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function l2Normalize(emb) {
  if (!Array.isArray(emb) || emb.length < 8) return null;
  let n = 0;
  const out = emb.map((v) => {
    const x = Number(v) || 0;
    n += x * x;
    return x;
  });
  n = Math.sqrt(n);
  if (n < 1e-9) return null;
  return out.map((v) => v / n);
}

function averageEmbedding(embeddings) {
  if (!embeddings?.length) return null;
  const dim = embeddings[0].length;
  const acc = new Array(dim).fill(0);
  let n = 0;
  for (const e of embeddings) {
    if (!Array.isArray(e) || e.length !== dim) continue;
    for (let i = 0; i < dim; i += 1) acc[i] += e[i];
    n += 1;
  }
  if (!n) return null;
  return l2Normalize(acc.map((v) => v / n));
}

/** Max similarity vs centroid + all member embeddings (tight one-person bunches). */
function similarityToCluster(embedding, cluster) {
  let best = 0;
  const centroid = cluster.centroid || averageEmbedding(cluster.embeddings);
  if (centroid) best = Math.max(best, cosineSim(embedding, centroid));
  for (const e of cluster.embeddings || []) {
    best = Math.max(best, cosineSim(embedding, e));
  }
  return best;
}

function load() {
  if (loaded) return;
  loaded = true;
  ensureDirs();
  if (!fs.existsSync(STORE_PATH)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    threshold = Number(raw.threshold) || DEFAULT_THRESHOLD;
    clusters.clear();
    for (const c of raw.clusters || []) {
      if (!c?.id) continue;
      if (!Array.isArray(c.crops) || !c.crops.length) continue;
      // Rehydrate embeddings array for runtime matching (centroid alone after restart).
      if (!Array.isArray(c.embeddings) && Array.isArray(c.centroid)) {
        c.embeddings = [c.centroid];
      }
      clusters.set(c.id, c);
    }
  } catch (err) {
    console.warn('[face-cluster-store] load:', err.message);
  }
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      ensureDirs();
      const slim = Array.from(clusters.values()).map((c) => {
        const { embeddings, ...rest } = c;
        return {
          ...rest,
          centroid: Array.isArray(c.centroid) ? c.centroid : averageEmbedding(embeddings),
          embedding_count: Array.isArray(embeddings) ? embeddings.length : (c.embedding_count || 0),
          // Keep last few embeds so restart still clusters correctly.
          embeddings: Array.isArray(embeddings) ? embeddings.slice(-4) : undefined,
        };
      });
      fs.writeFileSync(STORE_PATH, JSON.stringify({
        threshold,
        clusters: slim,
        updated_at: new Date().toISOString(),
      }));
    } catch (err) {
      console.warn('[face-cluster-store] save:', err.message);
    }
  }, 400);
}

function snapPath(clusterId, cropId) {
  const safeC = String(clusterId).replace(/[^a-zA-Z0-9._-]/g, '_');
  const safeP = String(cropId).replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(SNAP_DIR, `${safeC}__${safeP}.jpg`);
}

function saveCropJpeg(clusterId, cropId, jpegBase64) {
  if (!jpegBase64 || typeof jpegBase64 !== 'string' || jpegBase64.length < 64) return false;
  try {
    ensureDirs();
    const b64 = jpegBase64.replace(/^data:image\/\w+;base64,/, '');
    const buf = Buffer.from(b64, 'base64');
    if (buf.length < 64) return false;
    if (buf[0] !== 0xff || buf[1] !== 0xd8) return false;
    fs.writeFileSync(snapPath(clusterId, cropId), buf);
    return true;
  } catch {
    return false;
  }
}

function readCropJpeg(clusterId, cropId) {
  try {
    const p = snapPath(clusterId, cropId);
    if (!fs.existsSync(p)) return null;
    return fs.readFileSync(p);
  } catch {
    return null;
  }
}

function deleteClusterFiles(clusterId) {
  try {
    ensureDirs();
    const prefix = `${String(clusterId).replace(/[^a-zA-Z0-9._-]/g, '_')}__`;
    for (const name of fs.readdirSync(SNAP_DIR)) {
      if (name.startsWith(prefix)) fs.unlinkSync(path.join(SNAP_DIR, name));
    }
  } catch {
    /* ignore */
  }
}

function publicCluster(c) {
  if (!c) return null;
  const crops = (c.crops || []).filter((x) => x?.id);
  return {
    id: c.id,
    name: c.name || null,
    labeled: false,
    person_id: null,
    seen_count: c.seen_count || 0,
    cameras: Array.isArray(c.cameras) ? c.cameras : [],
    crops: crops.map((crop) => ({
      id: crop.id,
      filename: crop.id,
      camera_id: crop.camera_id || null,
      camera_name: crop.camera_name || null,
      seen_at: crop.seen_at,
      score: crop.score ?? null,
    })),
    preview_crop: crops[0]?.id || null,
    first_seen_at: c.first_seen_at,
    last_seen_at: c.last_seen_at,
    embedding_count: Array.isArray(c.embeddings) ? c.embeddings.length : (c.embedding_count || 0),
  };
}

function getThreshold() {
  load();
  return { threshold, default: DEFAULT_THRESHOLD };
}

function setThreshold(value) {
  load();
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0.35 || n > 0.9) {
    throw new Error('threshold must be between 0.35 and 0.90');
  }
  threshold = n;
  scheduleSave();
  return getThreshold();
}

function listClusters() {
  load();
  return Array.from(clusters.values())
    .filter((c) => Array.isArray(c.crops) && c.crops.length > 0)
    .sort((a, b) => new Date(b.last_seen_at || 0) - new Date(a.last_seen_at || 0))
    .map(publicCluster);
}

function getCluster(id) {
  load();
  return publicCluster(clusters.get(String(id)));
}

function deleteCluster(id) {
  load();
  const key = String(id);
  if (!clusters.has(key)) throw new Error(`Cluster ${id} not found`);
  clusters.delete(key);
  deleteClusterFiles(key);
  scheduleSave();
  return { ok: true, id: key };
}

function findBestCluster(embedding) {
  let best = null;
  let bestScore = -1;
  for (const c of clusters.values()) {
    const score = similarityToCluster(embedding, c);
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return { cluster: best, score: bestScore };
}

function prune() {
  if (clusters.size <= MAX_CLUSTERS) return;
  const ranked = Array.from(clusters.values())
    .sort((a, b) => new Date(a.last_seen_at || 0) - new Date(b.last_seen_at || 0));
  while (clusters.size > MAX_CLUSTERS && ranked.length) {
    const old = ranked.shift();
    if (!old) break;
    clusters.delete(old.id);
    deleteClusterFiles(old.id);
  }
}

/**
 * Ingest one unknown face. Needs embedding + jpeg — never creates empty "?" cards.
 */
function ingestUnknownFace({
  embedding,
  cropJpeg,
  cameraId,
  cameraName,
  score,
  gender,
  trackId,
} = {}) {
  load();
  const norm = l2Normalize(embedding);
  if (!norm || norm.length < MIN_EMBED_DIM) return null;
  if (!cropJpeg || typeof cropJpeg !== 'string' || cropJpeg.length < 64) return null;

  const now = new Date().toISOString();
  const { cluster: match, score: sim } = findBestCluster(norm);

  let cluster = match;
  if (!cluster || sim < threshold) {
    const id = `clu_${randomUUID().slice(0, 10)}`;
    cluster = {
      id,
      name: null,
      embeddings: [norm],
      centroid: norm.slice(),
      crops: [],
      cameras: [],
      seen_count: 0,
      first_seen_at: now,
      last_seen_at: now,
      track_hints: trackId ? [String(trackId)] : [],
    };
    clusters.set(id, cluster);
  } else if (trackId) {
    const hints = new Set(cluster.track_hints || []);
    hints.add(String(trackId));
    cluster.track_hints = [...hints].slice(-8);
  }

  cluster.seen_count = (cluster.seen_count || 0) + 1;
  cluster.last_seen_at = now;
  cluster.embeddings = [...(cluster.embeddings || []), norm].slice(-MAX_EMBEDS);
  cluster.centroid = averageEmbedding(cluster.embeddings) || cluster.centroid;

  const cropId = `crop_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  if (!saveCropJpeg(cluster.id, cropId, cropJpeg)) {
    if ((cluster.crops || []).length === 0 && cluster.seen_count <= 1) {
      clusters.delete(cluster.id);
    }
    return null;
  }

  const cropEntry = {
    id: cropId,
    camera_id: cameraId || null,
    camera_name: cameraName || null,
    seen_at: now,
    score: score ?? null,
    gender: gender || null,
  };
  cluster.crops = [cropEntry, ...(cluster.crops || []).filter((c) => c.id !== cropId)]
    .slice(0, MAX_CROPS);

  const camLabel = cameraName || cameraId;
  if (camLabel) {
    const cams = new Set(cluster.cameras || []);
    cams.add(camLabel);
    cluster.cameras = [...cams].slice(0, 10);
  }

  prune();
  scheduleSave();
  return publicCluster(cluster);
}

function takeClusterForLabel(id) {
  load();
  const cluster = clusters.get(String(id));
  if (!cluster) throw new Error(`Cluster ${id} not found`);
  const crops = [];
  for (const crop of cluster.crops || []) {
    const buf = readCropJpeg(cluster.id, crop.id);
    if (buf) {
      crops.push({
        id: crop.id,
        jpegBase64: buf.toString('base64'),
        camera_name: crop.camera_name,
      });
    }
  }
  if (!crops.length) throw new Error('Cluster has no photos to enroll');
  return {
    cluster: publicCluster(cluster),
    embeddings: Array.isArray(cluster.embeddings) ? cluster.embeddings : [],
    crops,
  };
}

function finalizeLabeled(id) {
  load();
  const key = String(id);
  if (!clusters.has(key)) return;
  clusters.delete(key);
  deleteClusterFiles(key);
  scheduleSave();
}

function getCropBuffer(clusterId, cropId) {
  load();
  return readCropJpeg(clusterId, cropId);
}

/**
 * Remove cluster crops/groups that came from a deleted camera.
 * Empty clusters are deleted entirely (photos + files).
 */
function purgeCameraData(cameraId, { name } = {}) {
  load();
  const id = String(cameraId || '').trim();
  if (!id && !name) return { ok: false, removedClusters: 0, trimmedClusters: 0 };
  const nameLower = name ? String(name).trim().toLowerCase() : '';

  function cropFromCamera(crop) {
    if (!crop) return false;
    if (id && crop.camera_id && String(crop.camera_id) === id) return true;
    if (nameLower && crop.camera_name && String(crop.camera_name).trim().toLowerCase() === nameLower) {
      return true;
    }
    return false;
  }

  function camLabelMatch(label) {
    const s = String(label || '').trim();
    if (!s) return false;
    if (id && s === id) return true;
    if (name && s === name) return true;
    if (nameLower && s.toLowerCase() === nameLower) return true;
    return false;
  }

  let removedClusters = 0;
  let trimmedClusters = 0;

  for (const [cid, cluster] of [...clusters.entries()]) {
    const before = (cluster.crops || []).length;
    const crops = (cluster.crops || []).filter((crop) => !cropFromCamera(crop));
    if (crops.length === before) continue;

    if (!crops.length) {
      clusters.delete(cid);
      deleteClusterFiles(cid);
      removedClusters += 1;
      continue;
    }

    cluster.crops = crops;
    cluster.cameras = (cluster.cameras || []).filter((cam) => !camLabelMatch(cam));
    cluster.seen_count = Math.max(crops.length, Number(cluster.seen_count) || 0);
    cluster.last_seen_at = crops[0]?.seen_at || cluster.last_seen_at;
    trimmedClusters += 1;
  }

  if (removedClusters || trimmedClusters) scheduleSave();
  return { ok: true, removedClusters, trimmedClusters };
}

module.exports = {
  getThreshold,
  setThreshold,
  listClusters,
  getCluster,
  deleteCluster,
  ingestUnknownFace,
  takeClusterForLabel,
  finalizeLabeled,
  getCropBuffer,
  purgeCameraData,
  DEFAULT_THRESHOLD,
};
