const { v4: uuidv4 } = require('uuid');
const { readDB, writeDB, CROPS_DIR, UPLOADS_DIR } = require('./dbStore');
const fs = require('fs');
const path = require('path');
const log = require('../utils/logger').child('cluster');

const DEFAULT_CLUSTER_MATCH_THRESHOLD = 0.60;
const MAX_EMBEDDINGS_PER_CLUSTER = 30;
const MAX_CROPS_PER_CLUSTER = 10;
const MAX_CLUSTERS = 500;

function parseThreshold(v, fallback) {
  const n = parseFloat(v);
  return Number.isFinite(n) && n > 0 && n < 1 ? n : fallback;
}

let clusterMatchThreshold = parseThreshold(process.env.CLUSTER_MATCH_THRESHOLD, DEFAULT_CLUSTER_MATCH_THRESHOLD);

function getThreshold() { return clusterMatchThreshold; }
function setThreshold(v) {
  const n = parseThreshold(v, null);
  if (n === null) throw new Error('threshold must be a number between 0 and 1 (exclusive)');
  clusterMatchThreshold = n;
  log.info({ threshold: clusterMatchThreshold }, 'cluster threshold updated');
  return clusterMatchThreshold;
}

const clusters = new Map();

function loadClustersFromDB() {
  try {
    const db = readDB();
    if (Array.isArray(db.clusters)) {
      db.clusters.forEach(c => {
        const id = c.cluster_id || c.id;
        const cropFilenames = (c.photos || []).map(p => p.filename || p).filter(Boolean);
        const embeddings = (c.photos || []).map(p => p.embedding).filter(Boolean);

        clusters.set(id, {
          cluster_id: id,
          id: id,
          name: c.name || `Profile #${id}`,
          gender: c.gender || 'Unknown',
          embeddings: c.embeddings || embeddings,
          centroid: (c.embeddings && c.embeddings.length) ? centroid(c.embeddings) : (embeddings.length ? centroid(embeddings) : []),
          crop_filenames: c.crop_filenames || cropFilenames,
          camera_ids: new Set(c.camera_ids || []),
          seen_count: c.seen_count || (c.photos ? c.photos.length : 1),
          first_seen: c.first_seen || c.created_at || new Date().toISOString(),
          last_seen: c.last_seen || new Date().toISOString(),
          last_gender: c.last_gender || c.gender || null,
        });
      });
      log.info({ count: clusters.size }, 'loaded clusters from database file');
    }
  } catch (err) {
    log.error({ err }, 'failed to load clusters from database');
  }
}

function saveClustersToDB() {
  const db = readDB();
  db.clusters = Array.from(clusters.values()).map(c => ({
    id: c.cluster_id,
    cluster_id: c.cluster_id,
    name: c.name || `Profile #${c.cluster_id}`,
    gender: c.last_gender || 'Unknown',
    photos: c.crop_filenames.map((fn, i) => ({
      id: `cph_${c.cluster_id}_${i}`,
      filename: fn,
      embedding: c.embeddings[i] || null
    })),
    seen_count: c.seen_count,
    first_seen: c.first_seen,
    last_seen: c.last_seen,
  }));
  writeDB(db);
}

loadClustersFromDB();

function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function centroid(embeddings) {
  if (!embeddings || !embeddings.length) return [];
  const dim = embeddings[0].length;
  const c = new Array(dim).fill(0);
  for (const e of embeddings) for (let i = 0; i < dim; i++) c[i] += e[i];
  for (let i = 0; i < dim; i++) c[i] /= embeddings.length;
  return c;
}

function findBestCluster(embedding) {
  let best = null, bestScore = -1;
  for (const cluster of clusters.values()) {
    if (!cluster.centroid || !cluster.centroid.length) continue;
    const score = cosineSim(embedding, cluster.centroid);
    if (score > bestScore) { bestScore = score; best = cluster; }
  }
  return { cluster: best, score: bestScore };
}

function ingestUnknownFace({ embedding, crop_filename, camera_id, gender }) {
  if (!embedding || !embedding.length) return null;

  const { cluster, score } = findBestCluster(embedding);
  const now = new Date().toISOString();

  if (cluster && score >= clusterMatchThreshold) {
    cluster.embeddings.push(embedding);
    if (cluster.embeddings.length > MAX_EMBEDDINGS_PER_CLUSTER) cluster.embeddings.shift();
    cluster.centroid = centroid(cluster.embeddings);

    if (crop_filename) {
      cluster.crop_filenames.push(crop_filename);
      if (cluster.crop_filenames.length > MAX_CROPS_PER_CLUSTER) cluster.crop_filenames.shift();
    }
    if (camera_id) cluster.camera_ids.add(camera_id);
    cluster.seen_count += 1;
    cluster.last_seen = now;
    if (gender) cluster.last_gender = gender;
    saveClustersToDB();
    log.debug({ cluster_id: cluster.cluster_id, score }, 'added embedding to existing cluster');
    return cluster;
  }

  if (clusters.size >= MAX_CLUSTERS) return null;

  const id = 'cl_' + uuidv4().slice(0, 8);
  const newCluster = {
    cluster_id: id,
    id: id,
    name: `Profile #${clusters.size + 1}`,
    embeddings: [embedding],
    centroid: embedding.slice(),
    crop_filenames: crop_filename ? [crop_filename] : [],
    camera_ids: new Set(camera_id ? [camera_id] : []),
    seen_count: 1,
    first_seen: now,
    last_seen: now,
    last_gender: gender || null,
  };
  clusters.set(id, newCluster);
  saveClustersToDB();
  log.info({ cluster_id: id }, 'created new cluster');
  return newCluster;
}

function listClusters() {
  return Array.from(clusters.values())
    .sort((a, b) => new Date(b.last_seen) - new Date(a.last_seen))
    .map(c => ({
      cluster_id: c.cluster_id,
      id: c.cluster_id,
      name: c.name || `Profile #${c.cluster_id}`,
      gender: c.last_gender || 'Unknown',
      seen_count: c.seen_count,
      embedding_count: c.embeddings.length,
      camera_ids: Array.from(c.camera_ids),
      representative_crop: c.crop_filenames[c.crop_filenames.length - 1] || null,
      crop_filenames: c.crop_filenames,
      photos: c.crop_filenames.map((fn, i) => ({
        id: `cph_${c.cluster_id}_${i}`,
        filename: fn,
        embedding: c.embeddings[i] || null
      })),
      last_gender: c.last_gender,
      first_seen: c.first_seen,
      last_seen: c.last_seen,
    }));
}

function getCluster(id) { return clusters.get(id) || null; }

function deleteCluster(id) {
  const c = clusters.get(id);
  if (!c) throw new Error(`Cluster ${id} not found`);
  (c.crop_filenames || []).forEach(fn => {
    const cropPath = path.join(CROPS_DIR, fn);
    if (fs.existsSync(cropPath)) {
      try { fs.unlinkSync(cropPath); } catch (e) {}
    }
  });
  clusters.delete(id);
  saveClustersToDB();
  log.info({ cluster_id: id }, 'deleted cluster');
  return true;
}

function deleteAllClusters() {
  const ids = Array.from(clusters.keys());
  for (const id of ids) {
    const c = clusters.get(id);
    for (const fn of (c?.crop_filenames || [])) {
      const cropPath = path.join(CROPS_DIR, fn);
      if (fs.existsSync(cropPath)) {
        try { fs.unlinkSync(cropPath); } catch (e) {}
      }
    }
  }
  clusters.clear();
  saveClustersToDB();
  log.warn({ deleted: ids.length }, 'deleted all face clusters');
  return ids.length;
}

function movePhotoFromClusterToPerson(clusterId, photoId, personId, name) {
  const cluster = clusters.get(clusterId);
  if (!cluster) throw new Error('Cluster not found');

  const photoIndex = cluster.crop_filenames.findIndex((fn, i) => fn === photoId || `cph_${clusterId}_${i}` === photoId);
  if (photoIndex === -1) throw new Error('Photo not found in cluster');

  const cropFilename = cluster.crop_filenames[photoIndex];
  const embedding = cluster.embeddings[photoIndex];

  const personStore = require('./personStore');
  let person;
  if (personId) {
    person = personStore.getPerson(personId);
    if (!person) throw new Error('Person not found');
  } else {
    person = personStore.createPerson({ name });
  }

  const uploadFilename = `enrolled_${Date.now()}_${cropFilename}`;
  const cropPath = path.join(CROPS_DIR, cropFilename);
  const uploadPath = path.join(UPLOADS_DIR, uploadFilename);

  try {
    if (fs.existsSync(cropPath)) fs.copyFileSync(cropPath, uploadPath);
  } catch (err) {
    log.error({ err }, 'Failed to copy crop file to uploads during move');
  }

  personStore.addEmbeddings(person.person_id, [embedding], [uploadFilename]);

  cluster.crop_filenames.splice(photoIndex, 1);
  cluster.embeddings.splice(photoIndex, 1);

  if (cluster.crop_filenames.length === 0) {
    clusters.delete(clusterId);
  }
  saveClustersToDB();

  return { person, cropFilename: uploadFilename };
}

module.exports = {
  ingestUnknownFace,
  listClusters,
  getCluster,
  deleteCluster,
  deleteAllClusters,
  movePhotoFromClusterToPerson,
  getThreshold,
  setThreshold,
};
