const router = require('express').Router();
const path = require('path');
const fs = require('fs');
const { requireAuth } = require('../middleware/auth');
const eventStore = require('../services/eventStore');
const clusterStore = require('../services/clusterStore');
const personStore = require('../services/personStore');
const bridge = require('../services/faceWorkerBridge');
const log = require('../utils/logger').child('eventsRoute');

const PROJECT_ROOT = path.join(__dirname, '../..');
const CROPS_DIR    = path.join(PROJECT_ROOT, 'data', 'crops');
const UPLOADS_DIR  = path.join(PROJECT_ROOT, 'uploads');

// ── GET /api/events ───────────────────────────────────────────────────────────
router.get('/', requireAuth, (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  res.json(eventStore.getEvents(limit));
});

// ── POST /api/events/:eventId/move ────────────────────────────────────────────
// Promotes an event's crop face to a known person — mirrors small backend exactly.
// 1. Find the event
// 2. Try to retrieve embedding from cluster store (fast path)
// 3. Fall back to on-the-fly extract_embedding via face worker
// 4. Copy crop → uploads, add photo to person, update event record
router.post('/:eventId/move', requireAuth, async (req, res) => {
  const { eventId } = req.params;
  const { personId, name } = req.body || {};

  if (!personId && (!name || name.trim() === '')) {
    return res.status(400).json({ error: 'Person ID or Name is required.' });
  }

  const event = eventStore.getEvent(eventId);
  if (!event) {
    return res.status(404).json({ error: 'Event not found.' });
  }

  // ── Step 1: Try to get embedding from cluster ─────────────────────────────
  let embedding = null;
  const clusterId = event.person_id;
  let foundInCluster = false;

  if (clusterId && clusterId !== 'UNKNOWN') {
    const clusters = clusterStore.listClusters();
    const cluster = clusters.find(c => c.cluster_id === clusterId || c.id === clusterId);
    if (cluster) {
      const photo = (cluster.photos || []).find(p => p.filename === event.crop_filename);
      if (photo && photo.embedding) {
        embedding = photo.embedding;
        foundInCluster = true;
        log.debug({ eventId, clusterId }, 'found embedding in cluster');
      }
    }
  }

  // ── Step 2: Extract embedding on-the-fly if not in cluster ───────────────
  if (!foundInCluster) {
    const cropPath = path.join(CROPS_DIR, event.crop_filename);
    if (fs.existsSync(cropPath)) {
      log.info({ eventId, cropFile: event.crop_filename }, 'Extracting embedding on-the-fly from crop');
      try {
        if (!bridge.isReady()) await bridge.start();
        const response = await bridge.extractEmbedding(cropPath);
        if (response && response.embedding) {
          embedding = response.embedding;
        } else {
          log.warn({ eventId }, 'on-the-fly embedding extraction returned no embedding');
        }
      } catch (err) {
        log.error({ err, eventId }, 'on-the-fly embedding extraction failed');
      }
    } else {
      log.warn({ eventId, cropFile: event.crop_filename }, 'crop file does not exist on disk');
    }
  }

  if (!embedding) {
    return res.status(422).json({ error: 'Face embedding not found. The crop image may be missing.' });
  }

  // ── Step 3: Resolve or create the target person ───────────────────────────
  let person;
  try {
    if (personId) {
      person = personStore.getPerson(personId);
      if (!person) return res.status(404).json({ error: 'Person not found.' });
    } else {
      // Merge into an existing person of the same name (case-insensitive), or create new
      const existingPersons = personStore.listPersons();
      person = existingPersons.find(p => p.name.toLowerCase() === name.trim().toLowerCase());
      if (!person) {
        person = personStore.createPerson({ name: name.trim(), gender: 'Unknown' });
      } else {
        // getPerson returns the full object with embeddings
        person = personStore.getPerson(person.person_id || person.id);
      }
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  // ── Step 4: Copy crop → uploads and enroll as a photo ────────────────────
  const cropPath = path.join(CROPS_DIR, event.crop_filename);
  const uploadFilename = `enrolled_${Date.now()}_${event.crop_filename}`;
  const uploadPath = path.join(UPLOADS_DIR, uploadFilename);
  try {
    if (fs.existsSync(cropPath)) {
      fs.copyFileSync(cropPath, uploadPath);
    }
  } catch (err) {
    log.error({ err }, 'Failed to copy crop to uploads during event move');
  }

  personStore.addEmbeddings(person.person_id, [embedding], [uploadFilename]);

  // Remove from cluster if it was there
  if (foundInCluster && clusterId && clusterId !== 'UNKNOWN') {
    try {
      const cluster = clusterStore.getCluster(clusterId);
      if (cluster) {
        const photoIdx = (cluster.crop_filenames || []).findIndex(fn => fn === event.crop_filename);
        if (photoIdx !== -1) {
          cluster.crop_filenames.splice(photoIdx, 1);
          if (cluster.embeddings) cluster.embeddings.splice(photoIdx, 1);
          if (cluster.crop_filenames.length === 0) {
            clusterStore.deleteCluster(clusterId);
          }
        }
      }
    } catch (err) {
      log.warn({ err, clusterId }, 'failed to remove photo from cluster during event move');
    }
  }

  // ── Step 5: Update the event to mark it as known ──────────────────────────
  const updatedEvent = eventStore.updateEventPerson(eventId, person.person_id, person.name);

  // Sync candidate embeddings with running Python worker
  if (bridge.isReady()) {
    bridge.updateCandidates(personStore.getCandidatesPayload()).catch(() => {});
  }

  const { broadcast } = require('../store/websocketBroadcast');
  if (broadcast) {
    broadcast({ event: 'database_updated' });
    broadcast({ event: 'clusters_updated' });
  }

  log.info({ eventId, personId: person.person_id, personName: person.name }, 'event photo moved to person');
  res.json({ success: true, event: updatedEvent });
});

// ── DELETE /api/events ────────────────────────────────────────────────────────
router.delete('/', requireAuth, (req, res) => {
  eventStore.clearEvents();
  const { broadcast } = require('../store/websocketBroadcast');
  if (broadcast) broadcast({ event: 'events_cleared' });
  res.json({ success: true, message: 'Events cleared' });
});

module.exports = router;
