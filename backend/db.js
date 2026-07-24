const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../data');
const DB_FILE = path.join(DATA_DIR, 'database.json');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const CROPS_DIR = path.join(DATA_DIR, 'crops');

// Ensure directories exist
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(CROPS_DIR)) fs.mkdirSync(CROPS_DIR, { recursive: true });

// Initialize database file
function initDB() {
  let dbData = {
    persons: [],
    photos: [],
    events: [],
    cameras: [],
    clusters: [],
    cluster_counter: 0
  };

  if (fs.existsSync(DB_FILE)) {
    try {
      const existing = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      // Database migration: Ensure all collections exist
      dbData.persons = existing.persons || [];
      dbData.photos = existing.photos || [];
      dbData.events = existing.events || [];
      dbData.cameras = existing.cameras || [];
      dbData.clusters = existing.clusters || [];
      dbData.cluster_counter = typeof existing.cluster_counter === 'number' 
        ? existing.cluster_counter 
        : (existing.clusters ? existing.clusters.length : 0);
      
      // Save migrated data
      fs.writeFileSync(DB_FILE, JSON.stringify(dbData, null, 2));
    } catch (err) {
      console.error('Database migration failed, starting clean:', err);
      fs.writeFileSync(DB_FILE, JSON.stringify(dbData, null, 2));
    }
  } else {
    fs.writeFileSync(DB_FILE, JSON.stringify(dbData, null, 2));
  }
}
initDB();

function readDB() {
  try {
    const data = fs.readFileSync(DB_FILE, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    console.error('Error reading database file:', err);
    return { persons: [], photos: [], events: [], cameras: [] };
  }
}

function writeDB(data) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Error writing database file:', err);
  }
}

// Math helpers for vector comparisons with L2 normalization
function dotProduct(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function l2Distance(a, b) {
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  normA = Math.sqrt(normA);
  normB = Math.sqrt(normB);
  
  if (normA === 0 || normB === 0) return 2.0; // Max possible L2 distance of normalized vectors
  
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = (a[i] / normA) - (b[i] / normB);
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

module.exports = {
  DATA_DIR,
  UPLOADS_DIR,
  CROPS_DIR,

  // Persons
  getPersons() {
    const db = readDB();
    return db.persons.map(p => {
      const pPhotos = db.photos.filter(ph => ph.person_id === p.id).map(ph => ({
        id: ph.id,
        filename: ph.filename
      }));
      return { ...p, photos: pPhotos };
    });
  },

  getPerson(id) {
    const db = readDB();
    const p = db.persons.find(p => p.id === id);
    if (!p) return null;
    const pPhotos = db.photos.filter(ph => ph.person_id === p.id).map(ph => ({
      id: ph.id,
      filename: ph.filename
    }));
    return { ...p, photos: pPhotos };
  },

  addPerson(name, gender = 'Unknown') {
    const db = readDB();
    const newPerson = {
      id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
      name,
      gender: gender || 'Unknown',
      created_at: new Date().toISOString()
    };
    db.persons.push(newPerson);
    writeDB(db);
    return newPerson;
  },

  deletePerson(id) {
    const db = readDB();
    const photosToDelete = db.photos.filter(p => p.person_id === id);
    photosToDelete.forEach(p => {
      const filePath = path.join(UPLOADS_DIR, p.filename);
      if (fs.existsSync(filePath)) {
        try { fs.unlinkSync(filePath); } catch (e) {}
      }
    });

    db.persons = db.persons.filter(p => p.id !== id);
    db.photos = db.photos.filter(p => p.person_id !== id);
    writeDB(db);
    return true;
  },

  // Photos
  addPhoto(personId, filename, embedding) {
    const db = readDB();
    const person = db.persons.find(p => p.id === personId);
    if (!person) throw new Error('Person not found');

    const newPhoto = {
      id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
      person_id: personId,
      filename,
      embedding
    };
    db.photos.push(newPhoto);
    writeDB(db);
    return newPhoto;
  },

  deletePhoto(photoId) {
    const db = readDB();
    const photo = db.photos.find(p => p.id === photoId);
    if (!photo) return false;

    const filePath = path.join(UPLOADS_DIR, photo.filename);
    if (fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch (e) {}
    }

    db.photos = db.photos.filter(p => p.id !== photoId);
    writeDB(db);
    return true;
  },

  getAllCandidates() {
    const db = readDB();
    return db.persons.map(p => {
      const embeddings = db.photos
        .filter(ph => ph.person_id === p.id)
        .map(ph => ph.embedding);
      return {
        person_id: p.id,
        name: p.name,
        embeddings: embeddings
      };
    }).filter(c => c.embeddings.length > 0);
  },

  // Cameras
  getCameras() {
    const db = readDB();
    return db.cameras || [];
  },

  getCamera(id) {
    const db = readDB();
    return db.cameras.find(c => c.id === id) || null;
  },

  addCamera(name, rtspUrl) {
    const db = readDB();
    const newCamera = {
      id: 'cam_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 4),
      name,
      rtsp_url: rtspUrl,
      is_active: false,
      line_crossing_enabled: false,
      line_y: 0.6,
      line_direction: 'in',
      line_x_start: 0.0,
      line_x_end: 1.0,
      created_at: new Date().toISOString()
    };
    db.cameras.push(newCamera);
    writeDB(db);
    return newCamera;
  },

  deleteCamera(id) {
    const db = readDB();
    db.cameras = db.cameras.filter(c => c.id !== id);
    writeDB(db);
    return true;
  },

  updateCameraStatus(id, isActive) {
    const db = readDB();
    const camera = db.cameras.find(c => c.id === id);
    if (camera) {
      camera.is_active = !!isActive;
      writeDB(db);
      return camera;
    }
    return null;
  },

  updateCameraLineSettings(id, enabled, lineY, direction, lineXStart, lineXEnd) {
    const db = readDB();
    const camera = db.cameras.find(c => c.id === id);
    if (camera) {
      camera.line_crossing_enabled = !!enabled;
      if (lineY !== undefined) camera.line_y = parseFloat(lineY);
      if (direction !== undefined) camera.line_direction = direction;
      if (lineXStart !== undefined) camera.line_x_start = parseFloat(lineXStart);
      if (lineXEnd !== undefined) camera.line_x_end = parseFloat(lineXEnd);
      writeDB(db);
      return camera;
    }
    return null;
  },

  // Events
  getEvents(limit = 100) {
    const db = readDB();
    return db.events
      .slice()
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, limit);
  },

  addEvent(personId, personName, score, cropFilename, isKnown, cameraId = null, cameraName = 'Manual Upload') {
    const db = readDB();
    const newEvent = {
      id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
      timestamp: new Date().toISOString(),
      person_id: personId,
      person_name: personName,
      score: score,
      crop_filename: cropFilename,
      is_known: isKnown,
      camera_id: cameraId,
      camera_name: cameraName
    };
    db.events.push(newEvent);
    
    // Capping at 1000 events
    if (db.events.length > 1000) {
      const removed = db.events.shift();
      if (removed && removed.crop_filename) {
        const cropPath = path.join(CROPS_DIR, removed.crop_filename);
        if (fs.existsSync(cropPath)) {
          try { fs.unlinkSync(cropPath); } catch (e) {}
        }
      }
    }
    writeDB(db);
    return newEvent;
  },

  updateEvent(eventId, updates) {
    const db = readDB();
    const eventIndex = db.events.findIndex(e => e.id === eventId);
    if (eventIndex !== -1) {
      db.events[eventIndex] = { ...db.events[eventIndex], ...updates };
      writeDB(db);
      return db.events[eventIndex];
    }
    return null;
  },

  clearEvents() {
    const db = readDB();
    db.events.forEach(ev => {
      if (ev.crop_filename) {
        const cropPath = path.join(CROPS_DIR, ev.crop_filename);
        if (fs.existsSync(cropPath)) {
          try { fs.unlinkSync(cropPath); } catch (e) {}
        }
      }
    });
    db.events = [];
    writeDB(db);
    return true;
  },

  // Clusters
  getClusters() {
    const db = readDB();
    return db.clusters || [];
  },

  addFaceToCluster(embedding, cropFilename, gender, settings) {
    const db = readDB();
    if (!db.clusters) db.clusters = [];
    if (typeof db.cluster_counter !== 'number') {
      db.cluster_counter = db.clusters.length;
    }
    
    const disType = settings.dis_type; // 0 cosine, 1 norml2
    
    // Apply a threshold for clustering to allow grouping of similar faces while separating different people
    let threshold;
    if (disType === 0) { // Cosine
      threshold = Math.max(0.58, settings.threshold + 0.02);
    } else { // L2
      threshold = Math.min(0.95, settings.threshold - 0.15);
    }
    
    let bestCluster = null;
    let bestScore = disType === 0 ? -1.0 : Infinity;
    
    for (const cluster of db.clusters) {
      let clusterScores = [];
      for (const photo of cluster.photos) {
        let score;
        if (disType === 0) { // Cosine
          score = dotProduct(embedding, photo.embedding);
        } else { // L2
          score = l2Distance(embedding, photo.embedding);
        }
        clusterScores.push(score);
      }
      
      const avgScore = clusterScores.reduce((sum, s) => sum + s, 0) / clusterScores.length;
      
      if (disType === 0) { // Cosine: higher score is better
        if (avgScore >= threshold && avgScore > bestScore) {
          bestScore = avgScore;
          bestCluster = cluster;
        }
      } else { // L2: lower score is better
        if (avgScore <= threshold && avgScore < bestScore) {
          bestScore = avgScore;
          bestCluster = cluster;
        }
      }
    }
    
    if (bestCluster) {
      bestCluster.photos.push({
        filename: cropFilename,
        embedding: embedding,
        gender: gender || 'Unknown'
      });
      
      // Calculate majority vote gender of cluster
      const votes = { 'Male': 0, 'Female': 0 };
      bestCluster.photos.forEach(ph => {
        if (ph.gender === 'Male' || ph.gender === 'Female') {
          votes[ph.gender]++;
        }
      });
      
      let finalGender = 'Unknown';
      if (votes['Male'] > votes['Female']) {
        finalGender = 'Male';
      } else if (votes['Female'] > votes['Male']) {
        finalGender = 'Female';
      }
      
      bestCluster.gender = finalGender;
      const genderSuffix = finalGender !== 'Unknown' ? ` (${finalGender})` : '';
      bestCluster.name = bestCluster.name.split(' (')[0] + genderSuffix;
      
      writeDB(db);
      return { id: bestCluster.id, name: bestCluster.name, gender: bestCluster.gender, isNew: false };
    } else {
      // Use persistent auto-incrementing counter
      db.cluster_counter = (db.cluster_counter || 0) + 1;
      const nextNum = db.cluster_counter;
      const genderSuffix = (gender && gender !== 'Unknown') ? ` (${gender})` : '';
      const clusterId = 'cluster_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 4);
      const newCluster = {
        id: clusterId,
        name: `Profile #${nextNum}${genderSuffix}`,
        gender: gender || 'Unknown',
        photos: [{
          filename: cropFilename,
          embedding: embedding,
          gender: gender || 'Unknown'
        }],
        created_at: new Date().toISOString()
      };
      db.clusters.push(newCluster);
      writeDB(db);
      return { id: clusterId, name: newCluster.name, gender: newCluster.gender, isNew: true };
    }
  },

  enrollCluster(clusterId, name) {
    const db = readDB();
    if (!db.clusters) db.clusters = [];
    
    const cluster = db.clusters.find(c => c.id === clusterId);
    if (!cluster) throw new Error('Cluster not found');
    
    // Check if person with same name already exists (case-insensitive) to merge them
    let person = db.persons.find(p => p.name.toLowerCase() === name.trim().toLowerCase());
    const isNew = !person;
    if (isNew) {
      person = {
        id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
        name: name.trim(),
        gender: cluster.gender || 'Unknown',
        created_at: new Date().toISOString()
      };
      db.persons.push(person);
    } else {
      // Merge: Update gender if existing was Unknown and cluster is not
      if (cluster.gender && cluster.gender !== 'Unknown' && (!person.gender || person.gender === 'Unknown')) {
        person.gender = cluster.gender;
      }
    }
    
    cluster.photos.forEach(ph => {
      const cropPath = path.join(CROPS_DIR, ph.filename);
      const uploadFilename = `enrolled_${Date.now()}_${ph.filename}`;
      const uploadPath = path.join(UPLOADS_DIR, uploadFilename);
      
      try {
        if (fs.existsSync(cropPath)) {
          fs.copyFileSync(cropPath, uploadPath);
        }
      } catch (err) {
        console.error('Failed to copy crop file to uploads during enrollment:', err);
      }
      
      db.photos.push({
        id: Date.now().toString(36) + Math.random().toString(36).substr(2, 4),
        person_id: person.id,
        filename: uploadFilename,
        embedding: ph.embedding
      });
    });
    
    db.events.forEach(ev => {
      if (ev.person_id === clusterId) {
        ev.person_id = person.id;
        ev.person_name = isNew ? person.name : `${person.name} (${person.gender && person.gender !== 'Unknown' ? person.gender : 'Unknown'})`;
        ev.is_known = true;
      }
    });
    
    db.clusters = db.clusters.filter(c => c.id !== clusterId);
    writeDB(db);
    return person;
  },

  movePhotoFromClusterToPerson(clusterId, photoId, personId, name) {
    const db = readDB();
    if (!db.clusters) db.clusters = [];
    
    const clusterIndex = db.clusters.findIndex(c => c.id === clusterId);
    if (clusterIndex === -1) throw new Error('Cluster not found');
    const cluster = db.clusters[clusterIndex];
    
    const photoIndex = cluster.photos.findIndex(p => p.id === photoId);
    if (photoIndex === -1) throw new Error('Photo not found in cluster');
    const photoObj = cluster.photos[photoIndex];
    
    let person;
    if (personId) {
      person = db.persons.find(p => p.id === personId);
      if (!person) throw new Error('Person not found');
    } else {
      // Check if a person with that name already exists (case-insensitive) to merge them
      person = db.persons.find(p => p.name.toLowerCase() === name.trim().toLowerCase());
      if (!person) {
        person = {
          id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
          name: name.trim(),
          gender: cluster.gender || 'Unknown',
          created_at: new Date().toISOString()
        };
        db.persons.push(person);
      }
    }
    
    // Copy the crop image from crops to uploads directory for enrollment
    const cropPath = path.join(CROPS_DIR, photoObj.filename);
    const uploadFilename = `enrolled_${Date.now()}_${photoObj.filename}`;
    const uploadPath = path.join(UPLOADS_DIR, uploadFilename);
    
    try {
      if (fs.existsSync(cropPath)) {
        fs.copyFileSync(cropPath, uploadPath);
      }
    } catch (err) {
      console.error('Failed to copy crop file to uploads during manual photo move:', err);
    }
    
    // Enroll the photo
    const newPhoto = {
      id: Date.now().toString(36) + Math.random().toString(36).substr(2, 4),
      person_id: person.id,
      filename: uploadFilename,
      embedding: photoObj.embedding
    };
    db.photos.push(newPhoto);
    
    // Remove the photo from the cluster
    cluster.photos.splice(photoIndex, 1);
    
    // If the cluster has no photos left, remove the cluster
    if (cluster.photos.length === 0) {
      db.clusters.splice(clusterIndex, 1);
    }
    
    writeDB(db);
    return newPhoto;
  },

  moveEventPhotoToPerson(eventId, personId, name, embedding) {
    const db = readDB();
    const event = db.events.find(e => e.id === eventId);
    if (!event) throw new Error('Event not found');
    
    let person;
    if (personId) {
      person = db.persons.find(p => p.id === personId);
      if (!person) throw new Error('Person not found');
    } else {
      person = db.persons.find(p => p.name.toLowerCase() === name.trim().toLowerCase());
      if (!person) {
        person = {
          id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
          name: name.trim(),
          gender: 'Unknown',
          created_at: new Date().toISOString()
        };
        db.persons.push(person);
      }
    }
    
    // Check if the photo is in a cluster
    let photoEmbedding = embedding;
    const clusterId = event.person_id;
    if (clusterId && clusterId !== 'UNKNOWN') {
      const clusterIndex = db.clusters.findIndex(c => c.id === clusterId);
      if (clusterIndex !== -1) {
        const cluster = db.clusters[clusterIndex];
        const photoIndex = cluster.photos.findIndex(p => p.filename === event.crop_filename);
        if (photoIndex !== -1) {
          const photoObj = cluster.photos[photoIndex];
          if (!photoEmbedding) {
            photoEmbedding = photoObj.embedding;
          }
          // Remove the photo from the cluster
          cluster.photos.splice(photoIndex, 1);
          if (cluster.photos.length === 0) {
            db.clusters.splice(clusterIndex, 1);
          }
        }
      }
    }
    
    if (!photoEmbedding) {
      throw new Error('Face embedding not found. Please try again.');
    }
    
    // Copy the crop image from crops to uploads directory for enrollment
    const cropPath = path.join(CROPS_DIR, event.crop_filename);
    const uploadFilename = `enrolled_${Date.now()}_${event.crop_filename}`;
    const uploadPath = path.join(UPLOADS_DIR, uploadFilename);
    
    try {
      if (fs.existsSync(cropPath)) {
        fs.copyFileSync(cropPath, uploadPath);
      }
    } catch (err) {
      console.error('Failed to copy crop file to uploads during event photo move:', err);
    }
    
    // Enroll the photo
    const newPhoto = {
      id: Date.now().toString(36) + Math.random().toString(36).substr(2, 4),
      person_id: person.id,
      filename: uploadFilename,
      embedding: photoEmbedding
    };
    db.photos.push(newPhoto);
    
    // Update the event itself to make it a KNOWN event!
    event.person_id = person.id;
    event.person_name = person.name;
    event.is_known = true;
    event.score = 1.0;
    
    writeDB(db);
    return event;
  },

  deleteCluster(clusterId) {
    const db = readDB();
    if (!db.clusters) db.clusters = [];
    
    const cluster = db.clusters.find(c => c.id === clusterId);
    if (!cluster) return false;
    
    cluster.photos.forEach(ph => {
      const cropPath = path.join(CROPS_DIR, ph.filename);
      if (fs.existsSync(cropPath)) {
        try { fs.unlinkSync(cropPath); } catch (e) {}
      }
    });
    
    db.clusters = db.clusters.filter(c => c.id !== clusterId);
    writeDB(db);
    return true;
  }
};
