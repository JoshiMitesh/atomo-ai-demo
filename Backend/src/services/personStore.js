const { v4: uuidv4 } = require('uuid');
const { readDB, writeDB, UPLOADS_DIR } = require('./dbStore');
const fs = require('fs');
const path = require('path');
const log = require('../utils/logger').child('person');

const persons = new Map();
const MAX_EMBEDDINGS_PER_PERSON = 200;
const DUPLICATE_EMBEDDING_SIMILARITY = 0.995;

function normalizeName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || !b.length) return -1;
  let dot = 0, aa = 0, bb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += Number(a[i]) * Number(b[i]);
    aa += Number(a[i]) * Number(a[i]);
    bb += Number(b[i]) * Number(b[i]);
  }
  return aa > 0 && bb > 0 ? dot / Math.sqrt(aa * bb) : -1;
}

function findPersonByName(name, excludeId = null) {
  const wanted = normalizeName(name);
  if (!wanted) return null;
  return Array.from(persons.values()).find(
    p => p.person_id !== excludeId && normalizeName(p.name) === wanted
  ) || null;
}

function loadFromDB() {
  try {
    const db = readDB();
    if (Array.isArray(db.persons)) {
      db.persons.forEach(p => {
        const id = p.person_id || p.id;
        const pPhotos = (db.photos || []).filter(ph => ph.person_id === id);
        const embeddings = pPhotos.map(ph => ph.embedding).filter(Boolean);
        const cropFilenames = pPhotos.map(ph => ph.filename).filter(Boolean);
        
        persons.set(id, {
          person_id: id,
          id: id,
          name: p.name,
          gender: p.gender || 'Unknown',
          note: p.note || '',
          embeddings: p.embeddings || embeddings,
          crop_filenames: p.crop_filenames || cropFilenames,
          photos: pPhotos.map(ph => ({ id: ph.id || ph.filename, filename: ph.filename })),
          enrolled_at: p.enrolled_at || p.created_at || new Date().toISOString(),
          updated_at: p.updated_at || new Date().toISOString(),
        });
      });
      log.info({ count: persons.size }, 'loaded persons from database file');
    }
  } catch (err) {
    log.error({ err }, 'failed to load persons from database');
  }
}
loadFromDB();

function saveToDB() {
  const db = readDB();
  db.persons = Array.from(persons.values()).map(p => ({
    id: p.person_id,
    person_id: p.person_id,
    name: p.name,
    gender: p.gender,
    note: p.note,
    enrolled_at: p.enrolled_at,
    updated_at: p.updated_at
  }));
  
  // Update photos collection
  const allPhotos = [];
  persons.forEach(p => {
    (p.photos || []).forEach((ph, i) => {
      allPhotos.push({
        id: ph.id || `ph_${p.person_id}_${i}`,
        person_id: p.person_id,
        filename: ph.filename,
        embedding: p.embeddings[i] || null
      });
    });
  });
  db.photos = allPhotos;
  writeDB(db);
}

function createPerson({ name, gender = 'Unknown', note = '' }) {
  if (!name) throw new Error('name is required');
  const existing = findPersonByName(name);
  if (existing) return existing;
  const id = 'p_' + uuidv4().slice(0, 8);
  const p = {
    person_id: id,
    id: id,
    name,
    gender,
    note,
    embeddings: [],
    crop_filenames: [],
    photos: [],
    enrolled_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  persons.set(id, p);
  saveToDB();
  log.info({ person_id: id, name }, 'created person');
  return p;
}

function getPerson(id) {
  return persons.get(id) || null;
}

function listPersons() {
  return Array.from(persons.values()).map(p => ({
    person_id: p.person_id,
    id: p.person_id,
    name: p.name,
    gender: p.gender,
    note: p.note,
    photos: p.photos || [],
    embedding_count: p.embeddings.length,
    crop_filenames: p.crop_filenames,
    enrolled_at: p.enrolled_at,
    updated_at: p.updated_at
  }));
}

function updatePerson(id, patch) {
  const p = persons.get(id);
  if (!p) throw new Error(`Person ${id} not found`);
  if (patch.name) {
    const sameNamePerson = findPersonByName(patch.name, id);
    if (sameNamePerson) {
      addEmbeddings(
        sameNamePerson.person_id,
        p.embeddings || [],
        (p.photos || []).map(ph => ph.filename),
      );
      if (patch.note !== undefined) sameNamePerson.note = patch.note;
      if (patch.gender) sameNamePerson.gender = patch.gender;
      persons.delete(id);
      sameNamePerson.updated_at = new Date().toISOString();
      saveToDB();
      log.info(
        { source_person_id: id, target_person_id: sameNamePerson.person_id, name: sameNamePerson.name },
        'merged same-name person'
      );
      return { ...sameNamePerson, merged_from: id };
    }
    p.name = String(patch.name).trim().replace(/\s+/g, ' ');
  }
  if (patch.gender) p.gender = patch.gender;
  if (patch.note !== undefined) p.note = patch.note;
  p.updated_at = new Date().toISOString();
  saveToDB();
  log.info({ person_id: id }, 'updated person');
  return p;
}

function deletePerson(id) {
  const p = persons.get(id);
  if (!p) throw new Error(`Person ${id} not found`);
  (p.photos || []).forEach(ph => {
    const filePath = path.join(UPLOADS_DIR, ph.filename);
    if (fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch (e) {}
    }
  });
  persons.delete(id);
  saveToDB();
  log.info({ person_id: id }, 'deleted person');
}

function deleteAllPersons() {
  const ids = Array.from(persons.keys());
  for (const id of ids) deletePerson(id);
  log.warn({ deleted: ids.length }, 'deleted all enrolled persons');
  return ids.length;
}

function deletePhoto(photoId) {
  let foundPerson = null;
  let photoIndex = -1;

  for (const p of persons.values()) {
    const idx = (p.photos || []).findIndex(ph => ph.id === photoId || ph.filename === photoId);
    if (idx !== -1) {
      foundPerson = p;
      photoIndex = idx;
      break;
    }
  }

  if (!foundPerson || photoIndex === -1) return false;

  const photoObj = foundPerson.photos[photoIndex];
  const filePath = path.join(UPLOADS_DIR, photoObj.filename);
  if (fs.existsSync(filePath)) {
    try { fs.unlinkSync(filePath); } catch (e) {}
  }

  foundPerson.photos.splice(photoIndex, 1);
  foundPerson.embeddings.splice(photoIndex, 1);
  foundPerson.crop_filenames.splice(photoIndex, 1);
  foundPerson.updated_at = new Date().toISOString();
  saveToDB();
  log.info({ photoId, person_id: foundPerson.person_id }, 'deleted photo');
  return true;
}

function addEmbeddings(id, embeddings, cropFilenames = []) {
  const p = persons.get(id);
  if (!p) throw new Error(`Person ${id} not found`);
  
  for (let i = 0; i < embeddings.length; i++) {
    const embedding = embeddings[i];
    if (!Array.isArray(embedding) || !embedding.length) continue;
    const duplicate = p.embeddings.some(
      existing => cosineSimilarity(existing, embedding) >= DUPLICATE_EMBEDDING_SIMILARITY
    );
    if (duplicate) continue;
    const fn = cropFilenames[i] || `photo_${Date.now()}_${i}.jpg`;
    p.embeddings.push(embedding);
    p.crop_filenames.push(fn);
    if (!p.photos) p.photos = [];
    p.photos.push({ id: Date.now().toString(36) + Math.random().toString(36).substr(2, 4), filename: fn });
  }

  while (p.embeddings.length > MAX_EMBEDDINGS_PER_PERSON) {
    let removeAt = (p.photos || []).findIndex(ph => (ph.filename || '').startsWith('auto_'));
    if (removeAt < 0) removeAt = 0;
    p.embeddings.splice(removeAt, 1);
    p.crop_filenames.splice(removeAt, 1);
    p.photos.splice(removeAt, 1);
  }

  p.updated_at = new Date().toISOString();
  saveToDB();
  log.debug({ person_id: id, added: embeddings.length }, 'added embeddings');
  return p;
}

function getCandidatesPayload() {
  return Array.from(persons.values())
    .filter(p => p.embeddings.length > 0)
    .map(p => ({ person_id: p.person_id, name: p.name, embeddings: p.embeddings }));
}

module.exports = {
  createPerson,
  getPerson,
  listPersons,
  updatePerson,
  deletePerson,
  deleteAllPersons,
  deletePhoto,
  addEmbeddings,
  getCandidatesPayload,
  findPersonByName,
};
