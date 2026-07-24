const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { spawn, exec } = require('child_process');
const db = require('./db');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Serve static frontend files
app.use(express.static(path.join(__dirname, '../frontend')));
app.use('/uploads', express.static(db.UPLOADS_DIR));
app.use('/crops', express.static(db.CROPS_DIR));

// Configure Multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, db.UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `upload_${Date.now()}_${Math.random().toString(36).substr(2, 5)}${ext}`);
  }
});
const upload = multer({
  storage: storage,
  limits: { fileSize: 100 * 1024 * 1024 } // 100MB limit for video files
});

// App settings store
let settings = {
  threshold: 0.60,
  dis_type: 0 // 0 cosine, 1 norml2
};

// Load settings on startup if they exist in DB
function loadSettings() {
  try {
    const dbPath = path.join(db.DATA_DIR, 'database.json');
    if (fs.existsSync(dbPath)) {
      const data = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
      if (data.settings) {
        settings = { ...settings, ...data.settings };
      }
    }
  } catch (e) {
    console.error('Failed to load settings from DB:', e);
  }
}
loadSettings();

function saveSettings() {
  try {
    const dbPath = path.join(db.DATA_DIR, 'database.json');
    const data = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    data.settings = settings;
    fs.writeFileSync(dbPath, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('Failed to save settings to DB:', e);
  }
}

// -------------------------------------------------------------
// Spawn MediaMTX sub-process
// -------------------------------------------------------------
let mediamtxProcess = null;

function startMediaMTX() {
  console.log('Starting MediaMTX RTSP Server...');
  // Spawn mediamtx in the root directory
  mediamtxProcess = spawn('./mediamtx', [], { cwd: __dirname });

  mediamtxProcess.stdout.on('data', (data) => {
    // Only pipe important logs to keep console clean
    const logStr = data.toString().trim();
    if (logStr.includes('ERR') || logStr.includes('warn')) {
      console.log(`[MediaMTX] ${logStr}`);
    }
  });

  mediamtxProcess.stderr.on('data', (data) => {
    console.error(`[MediaMTX Err] ${data.toString().trim()}`);
  });

  mediamtxProcess.on('close', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`MediaMTX process closed with code ${code}. Re-spawning in 5 seconds...`);
      setTimeout(startMediaMTX, 5000);
    }
  });
}
startMediaMTX();

// -------------------------------------------------------------
// FFmpeg Mock Loop-Streaming Management
// -------------------------------------------------------------
const ffmpegProcesses = new Map(); // camera_id -> childProcess

function startMockFFmpegStream(cameraId, videoPath) {
  stopMockFFmpegStream(cameraId);
  
  console.log(`Starting FFmpeg loop stream for camera [${cameraId}] using file: ${videoPath}`);
  const rtspUrl = `rtsp://127.0.0.1:8554/${cameraId}`;
  
  // Re-encode to H264, ultrafast preset, low latency parameters
  const ffmpegProcess = spawn('ffmpeg', [
    '-re',
    '-stream_loop', '-1',
    '-i', videoPath,
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-an', // Disable audio
    '-f', 'rtsp',
    '-rtsp_transport', 'tcp',
    rtspUrl
  ]);
  
  ffmpegProcess.stderr.on('data', (data) => {
    // Enable for debugging ffmpeg streams if needed
    // console.log(`[FFmpeg-${cameraId}] ${data.toString()}`);
  });
  
  ffmpegProcess.on('close', (code) => {
    console.log(`FFmpeg loop stream for camera [${cameraId}] exited with code ${code}`);
    ffmpegProcesses.delete(cameraId);
  });
  
  ffmpegProcesses.set(cameraId, ffmpegProcess);
  return rtspUrl;
}

function stopMockFFmpegStream(cameraId) {
  if (ffmpegProcesses.has(cameraId)) {
    console.log(`Stopping FFmpeg loop stream for camera [${cameraId}]`);
    const proc = ffmpegProcesses.get(cameraId);
    proc.kill('SIGKILL');
    ffmpegProcesses.delete(cameraId);
  }
}

// -------------------------------------------------------------
// Live Stream Transcoding and Proxy Management
// -------------------------------------------------------------
const transcoderProcesses = new Map(); // camera_id -> childProcess

// Helper to detect stream codec using ffprobe
function getStreamCodec(rtspUrl) {
  return new Promise((resolve) => {
    // Set a 5-second timeout to prevent hanging on offline streams, and force TCP transport
    const cmd = `ffprobe -v error -rtsp_transport tcp -select_streams v:0 -show_entries stream=codec_name -of default=noprint_wrappers=1:nokey=1 "${rtspUrl}"`;
    exec(cmd, { timeout: 5000 }, (err, stdout, stderr) => {
      if (err) {
        console.warn(`[Codec Detector] ffprobe failed for URL: ${rtspUrl}, error: ${err.message}`);
        resolve('unknown');
      } else {
        resolve(stdout.trim().toLowerCase());
      }
    });
  });
}

function startTranscoder(cameraId, rtspUrl) {
  stopTranscoder(cameraId);
  console.log(`[Transcoder] Starting RTSP transcoding to H.264 for camera ${cameraId}: ${rtspUrl}`);
  
  const targetRtspUrl = `rtsp://127.0.0.1:8554/${cameraId}`;
  
  // Transcode video to H264, disable audio, preset ultrafast for low latency
  const ffmpegProcess = spawn('ffmpeg', [
    '-allowed_media_types', 'video', // Ignore audio tracks entirely at network level
    '-rtsp_transport', 'tcp',
    '-fflags', 'nobuffer',         // Disable input buffering
    '-probesize', '100000',         // Low probe size for instant start
    '-analyzeduration', '0',        // 0 analyze duration
    '-i', rtspUrl,
    '-vf', 'scale=960:-2,fps=8',  // Downscale to 960 width (540p), limit to 8 FPS
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-bf', '0',                   // Disable B-frames for zero latency
    '-g', '8',                    // Keyframe every 1 second (at 8 fps)
    '-crf', '22',                 // CRF 22 for lightweight CPU load
    '-threads', '1',              // Limit output encoder to 1 thread
    '-an',                        // Disable audio
    '-f', 'rtsp',
    '-rtsp_transport', 'tcp',
    targetRtspUrl
  ]);

  ffmpegProcess.stderr.on('data', (data) => {
    console.error(`[Transcoder-${cameraId} Err] ${data.toString().trim()}`);
  });

  ffmpegProcess.on('close', (code) => {
    console.log(`[Transcoder] FFmpeg transcoding for camera ${cameraId} exited with code ${code}`);
    transcoderProcesses.delete(cameraId);
  });

  transcoderProcesses.set(cameraId, ffmpegProcess);
}

function stopTranscoder(cameraId) {
  if (transcoderProcesses.has(cameraId)) {
    console.log(`[Transcoder] Stopping transcoder process for camera ${cameraId}`);
    const proc = transcoderProcesses.get(cameraId);
    try {
      proc.kill('SIGKILL');
    } catch (e) {
      console.error(`[Transcoder] Failed to kill process for camera ${cameraId}:`, e.message);
    }
    transcoderProcesses.delete(cameraId);
  }
}

async function startCameraStream(camera) {
  const isLocal = camera.rtsp_url.startsWith('rtsp://localhost') || camera.rtsp_url.startsWith('rtsp://127.0.0.1');
  
  if (!isLocal) {
    // Unregister any previous path configuration to prevent publish conflicts
    await unregisterMediaMtxPath(camera.id);
    
    const codec = await getStreamCodec(camera.rtsp_url);
    console.log(`[Server] Detected codec for camera ${camera.name} (${camera.id}): ${codec}`);
    
    if (codec === 'hevc' || codec === 'h265') {
      console.log(`[Server] Stream uses H.265. Starting on-the-fly H.264 transcoding...`);
      // Register publisher path configuration first
      await registerMediaMtxPublisherPath(camera.id);
      
      startTranscoder(camera.id, camera.rtsp_url);
      // Wait 1.5 seconds for transcoding start before letting Python worker connect
      await new Promise(r => setTimeout(r, 1500));
    } else {
      console.log(`[Server] Stream uses H.264 or unknown (${codec}). Proxying directly through MediaMTX...`);
      await registerMediaMtxPath(camera.id, camera.rtsp_url);
    }
  }
  
  const targetRtspUrl = isLocal ? camera.rtsp_url : `rtsp://127.0.0.1:8554/${camera.id}`;
  
  console.log(`[Server] Starting stream thread in Python worker for ${camera.name} using URL: ${targetRtspUrl}`);
  
  return await sendPythonCommand({
    cmd: 'start_stream',
    camera_id: camera.id,
    camera_name: camera.name,
    rtsp_url: targetRtspUrl,
    candidates: db.getAllCandidates(),
    threshold: settings.threshold,
    dis_type: settings.dis_type,
    crops_dir: db.CROPS_DIR,
    line_crossing_enabled: !!camera.line_crossing_enabled,
    line_y: camera.line_y !== undefined ? camera.line_y : 0.6,
    line_direction: camera.line_direction || 'in',
    line_x_start: camera.line_x_start !== undefined ? camera.line_x_start : 0.0,
    line_x_end: camera.line_x_end !== undefined ? camera.line_x_end : 1.0
  });
}

async function stopCameraStream(camera) {
  try {
    await sendPythonCommand({
      cmd: 'stop_stream',
      camera_id: camera.id
    });
  } catch (err) {
    console.warn(`[Server] Python stop_stream error for camera ${camera.id}:`, err.message);
  }

  stopMockFFmpegStream(camera.id);
  stopTranscoder(camera.id);

  const isLocal = camera.rtsp_url.startsWith('rtsp://localhost') || camera.rtsp_url.startsWith('rtsp://127.0.0.1');
  if (!isLocal) {
    await unregisterMediaMtxPath(camera.id);
  }
}

// -------------------------------------------------------------
// Python sidecar worker communication
// -------------------------------------------------------------
let pythonProcess = null;
let isPythonReady = false;
const pendingRequests = [];
let stdoutBuffer = '';

function startPythonWorker() {
  console.log('Starting Python face worker process...');
  isPythonReady = false;
  
  pythonProcess = spawn('python3', ['-u', 'face_worker.py'], {
    cwd: __dirname,
    env: { ...process.env, PYTHONUNBUFFERED: '1' }
  });

  pythonProcess.stdout.on('data', (data) => {
    stdoutBuffer += data.toString();
    let boundary = stdoutBuffer.indexOf('\n');
    
    while (boundary !== -1) {
      const line = stdoutBuffer.slice(0, boundary).trim();
      stdoutBuffer = stdoutBuffer.slice(boundary + 1);
      boundary = stdoutBuffer.indexOf('\n');
      
      if (!line) continue;
      
      try {
        const parsed = JSON.parse(line);
        handlePythonMessage(parsed);
      } catch (err) {
        console.error('Error parsing Python JSON:', err);
        console.error('Line was:', line);
      }
    }
  });

  pythonProcess.stderr.on('data', (data) => {
    process.stderr.write(`[Python] ${data.toString()}`);
  });

  pythonProcess.on('close', (code) => {
    console.error(`Python process exited with code ${code}. Re-spawning in 3 seconds...`);
    isPythonReady = false;
    
    // Clear pending requests
    while (pendingRequests.length > 0) {
      const req = pendingRequests.shift();
      req.reject(new Error('Python worker process exited.'));
    }
    
    setTimeout(startPythonWorker, 3000);
  });
}

function sendPythonCommand(cmdObj) {
  return new Promise((resolve, reject) => {
    if (!pythonProcess || pythonProcess.killed) {
      return reject(new Error('Python process is not running.'));
    }
    pendingRequests.push({ resolve, reject, cmd: cmdObj.cmd });
    pythonProcess.stdin.write(JSON.stringify(cmdObj) + '\n');
  });
}

async function registerMediaMtxPath(cameraId, rtspUrl) {
  if (rtspUrl.startsWith('rtsp://localhost') || rtspUrl.startsWith('rtsp://127.0.0.1')) {
    console.log(`[MediaMTX] Camera ${cameraId} is a localhost/mock stream. No proxy configuration needed.`);
    return;
  }

  console.log(`[MediaMTX] Registering remote RTSP camera ${cameraId} with URL: ${rtspUrl}`);
  try {
    const response = await fetch(`http://localhost:9997/v3/config/paths/add/${cameraId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: rtspUrl,
        sourceOnDemand: false,
        sourceProtocol: 'tcp'
      })
    });
    if (response.ok) {
      console.log(`[MediaMTX] Successfully configured remote path for ${cameraId}`);
    } else {
      console.warn(`[MediaMTX] Path add API returned status ${response.status}`);
    }
  } catch (err) {
    console.error(`[MediaMTX] Error registering path:`, err.message);
  }
}

async function registerMediaMtxPublisherPath(cameraId) {
  console.log(`[MediaMTX] Registering publisher path config for camera ${cameraId}`);
  try {
    const response = await fetch(`http://localhost:9997/v3/config/paths/add/${cameraId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: 'publisher'
      })
    });
    if (response.ok) {
      console.log(`[MediaMTX] Successfully configured publisher path for ${cameraId}`);
    } else {
      console.warn(`[MediaMTX] Publisher path add API returned status ${response.status}`);
    }
  } catch (err) {
    console.error(`[MediaMTX] Error registering publisher path:`, err.message);
  }
}

async function unregisterMediaMtxPath(cameraId) {
  console.log(`[MediaMTX] Unregistering path config for camera ${cameraId}`);
  try {
    const response = await fetch(`http://localhost:9997/v3/config/paths/delete/${cameraId}`, {
      method: 'POST'
    });
    if (response.ok) {
      console.log(`[MediaMTX] Successfully deleted path for ${cameraId}`);
    } else {
      console.warn(`[MediaMTX] Path delete API returned status ${response.status}`);
    }
  } catch (err) {
    console.error(`[MediaMTX] Error deleting path:`, err.message);
  }
}

async function resumeActiveStreams() {
  const activeCameras = db.getCameras().filter(c => c.is_active);
  if (activeCameras.length === 0) return;
  console.log(`[Server] Python worker ready. Auto-resuming ${activeCameras.length} active camera streams...`);
  for (const cam of activeCameras) {
    try {
      await startCameraStream(cam);
    } catch (err) {
      console.error(`[Server] Failed to auto-resume camera ${cam.name}:`, err.message);
    }
  }
}

const activeEvents = new Map();

function handlePythonMessage(msg) {
  if (msg.event) {
    if (msg.event === 'ready') {
      console.log('Python face worker is ready.');
      isPythonReady = true;
      sendCandidatesToPython();
      resumeActiveStreams();
    } else if (msg.event === 'video_enroll_face') {
      try {
        const photo = db.addPhoto(msg.person_id, msg.filename, msg.embedding);
        broadcast({
          event: 'video_face_enrolled',
          person_id: msg.person_id,
          photo: { id: photo.id, filename: photo.filename }
        });
        sendCandidatesToPython();
        console.log(`[Video Enrollment] Dynamically enrolled face ${msg.filename} for person ${msg.person_id}`);
      } catch (err) {
        console.error('[Video Enrollment] Failed to dynamically enroll face:', err);
      }
    } else if (msg.event === 'stream_frame') {
      // Broadcast live video frame tagged with camera_id
      broadcast({
        event: 'live_frame',
        camera_id: msg.camera_id,
        frame: msg.frame
      });
    } else if (msg.event === 'stream_detect') {
      // Create and broadcast an UNKNOWN event immediately with the face crop
      const savedEvent = db.addEvent(
        'UNKNOWN',
        'UNKNOWN',
        0.0,
        msg.crop_filename,
        false,
        msg.camera_id,
        msg.camera_name
      );
      
      activeEvents.set(msg.event_uuid, savedEvent.id);
      
      broadcast({
        event: 'recognition_event',
        data: savedEvent
      });
    } else if (msg.event === 'stream_recognize') {
      const eventId = activeEvents.get(msg.event_uuid);
      console.log(`[Recognition] Received stream_recognize: is_known=${msg.is_known}, score=${msg.score ? msg.score.toFixed(3) : 0.0}, match=${msg.match ? JSON.stringify(msg.match) : 'None'}`);
      if (eventId) {
        activeEvents.delete(msg.event_uuid); // clean up
        
        let personId = 'UNKNOWN';
        let personName = 'UNKNOWN';
        let isKnownEvent = msg.is_known;
        
        if (msg.is_known) {
          const person = db.getPerson(msg.match.person_id);
          personId = msg.match.person_id;
          personName = msg.match.name;
        } else if (msg.embedding) {
          try {
            // Cluster the face if unknown
            const clusterResult = db.addFaceToCluster(msg.embedding, msg.crop_filename, null, settings);
            personId = clusterResult.id;
            personName = clusterResult.name;
            broadcast({ event: 'clusters_updated' });
          } catch (err) {
            console.error('[Clustering] Error clustering face:', err);
          }
        }
        
        const updatedEvent = db.updateEvent(eventId, {
          person_id: personId,
          person_name: personName,
          score: msg.score,
          is_known: isKnownEvent
        });
        
        if (updatedEvent) {
          broadcast({
            event: 'recognition_update',
            data: updatedEvent
          });
          
          // AUTO-LEARNING: If recognized match (>= Math.max(0.68, settings.threshold)) and embedding is returned
          if (msg.is_known && msg.score >= Math.max(0.68, settings.threshold) && msg.embedding) {
            const person = db.getPerson(msg.match.person_id);
            if (person) {
              const autoPhotos = person.photos.filter(p => p.filename.startsWith('auto_'));
              
              // Limit check: if total photos >= 1000, try to prune the oldest auto-learned photo
              if (person.photos.length >= 1000) {
                if (autoPhotos.length > 0) {
                  autoPhotos.sort((a, b) => a.filename.localeCompare(b.filename));
                  const oldest = autoPhotos[0];
                  db.deletePhoto(oldest.id);
                  console.log(`[Auto-Learning] Pruned oldest auto-learned template ${oldest.filename} for ${person.name}`);
                } else {
                  // If they have no auto-learned photos to prune (e.g. all are manual uploads),
                  // allow a buffer of up to 10 auto-learned photos
                  const maxCap = person.photos.length + 10;
                  if (person.photos.length >= maxCap) {
                    console.log(`[Auto-Learning] Max buffer limit reached for ${person.name}. Skipping.`);
                    return;
                  }
                }
              }
              
              const cropPath = path.join(db.CROPS_DIR, msg.crop_filename);
              const uploadFilename = `auto_${Date.now()}_${path.basename(msg.crop_filename)}`;
              const uploadPath = path.join(db.UPLOADS_DIR, uploadFilename);
              try {
                if (fs.existsSync(cropPath)) {
                  fs.copyFileSync(cropPath, uploadPath);
                  db.addPhoto(msg.match.person_id, uploadFilename, msg.embedding);
                  console.log(`[Auto-Learning] Automatically enrolled new template for ${msg.match.name} (Score: ${msg.score.toFixed(3)})`);
                  
                  sendPythonCommand({
                    cmd: 'add_template',
                    person_id: msg.match.person_id,
                    embedding: msg.embedding,
                    name: msg.match.name
                  }).catch(err => console.error('Error sending single template to Python:', err));
                  
                  broadcastDatabaseUpdate();
                }
              } catch (err) {
                console.error('[Auto-Learning] Error saving template:', err);
              }
            }
          }
        }
      }
    }
  } else if (msg.cmd) {
    // Response to a pending command
    const index = pendingRequests.findIndex(r => r.cmd === msg.cmd);
    if (index !== -1) {
      const req = pendingRequests.splice(index, 1)[0];
      req.resolve(msg.response);
    }
  }
}

function sendCandidatesToPython() {
  if (!isPythonReady) return;
  const candidates = db.getAllCandidates();
  sendPythonCommand({
    cmd: 'update_candidates',
    candidates: candidates
  }).catch(err => {
    console.error('Failed to update candidate embeddings in Python:', err.message);
  });
}

startPythonWorker();

// -------------------------------------------------------------
// WebSocket broadcasting
// -------------------------------------------------------------
function broadcast(data) {
  const message = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

function broadcastDatabaseUpdate() {
  broadcast({ event: 'database_updated' });
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({
    event: 'connection_init',
    data: {
      status: {
        threshold: settings.threshold,
        dis_type: settings.dis_type
      },
      cameras: db.getCameras(),
      events: db.getEvents(30)
    }
  }));
});

// -------------------------------------------------------------
// REST API Routes
// -------------------------------------------------------------

// Persons Profile APIs
app.get('/api/persons', (req, res) => {
  res.json(db.getPersons());
});

app.post('/api/persons', (req, res) => {
  const { name, gender } = req.body;
  if (!name || name.trim() === '') {
    return res.status(400).json({ error: 'Person name is required.' });
  }
  const person = db.addPerson(name.trim(), gender);
  broadcastDatabaseUpdate();
  res.status(201).json(person);
});

app.delete('/api/persons/:id', (req, res) => {
  const success = db.deletePerson(req.params.id);
  if (success) {
    sendCandidatesToPython();
    broadcastDatabaseUpdate();
    res.json({ success: true, message: 'Person deleted.' });
  } else {
    res.status(404).json({ error: 'Person not found.' });
  }
});

// Person Photos Management APIs
app.post('/api/persons/:id/photos', upload.array('photos'), async (req, res) => {
  const personId = req.params.id;
  const files = req.files;
  
  if (!files || files.length === 0) {
    return res.status(400).json({ error: 'No photos uploaded.' });
  }

  const person = db.getPerson(personId);
  if (!person) {
    files.forEach(f => {
      try { fs.unlinkSync(f.path); } catch (e) {}
    });
    return res.status(404).json({ error: 'Person not found.' });
  }

  const addedPhotos = [];
  const errors = [];

  for (const file of files) {
    try {
      const response = await sendPythonCommand({
        cmd: 'extract_embedding',
        img_path: file.path
      });

      if (response.status === 'success') {
        const filename = path.basename(file.path);
        const photo = db.addPhoto(personId, filename, response.embedding);
        addedPhotos.push({ id: photo.id, filename: photo.filename });
      } else {
        errors.push(`File ${file.originalname}: ${response.message}`);
        try { fs.unlinkSync(file.path); } catch (e) {}
      }
    } catch (err) {
      errors.push(`File ${file.originalname}: ${err.message}`);
      try { fs.unlinkSync(file.path); } catch (e) {}
    }
  }

  sendCandidatesToPython();
  broadcastDatabaseUpdate();
  res.json({
    success: addedPhotos.length > 0,
    added: addedPhotos,
    errors: errors
  });
});

app.post('/api/persons/:id/video', upload.single('video'), async (req, res) => {
  const personId = req.params.id;
  const file = req.file;
  
  if (!file) {
    return res.status(400).json({ error: 'No video file uploaded.' });
  }

  const person = db.getPerson(personId);
  if (!person) {
    try { fs.unlinkSync(file.path); } catch (e) {}
    return res.status(404).json({ error: 'Person not found.' });
  }

  try {
    const response = await sendPythonCommand({
      cmd: 'process_video_enrollment',
      person_id: personId,
      video_path: file.path,
      crops_dir: db.UPLOADS_DIR
    });

    // Clean up temporary uploaded video file
    try { fs.unlinkSync(file.path); } catch (e) {}

    if (response.status === 'success') {
      const addedPhotos = [];
      const faces = response.faces || [];
      
      for (const face of faces) {
        const person = db.getPerson(personId);
        const alreadyExists = person && person.photos.some(p => p.filename === face.filename);
        if (!alreadyExists) {
          const photo = db.addPhoto(personId, face.filename, face.embedding);
          addedPhotos.push({ id: photo.id, filename: photo.filename });
        } else {
          const existingPhoto = person.photos.find(p => p.filename === face.filename);
          if (existingPhoto) {
            addedPhotos.push({ id: existingPhoto.id, filename: existingPhoto.filename });
          }
        }
      }

      sendCandidatesToPython();
      broadcastDatabaseUpdate();

      res.json({
        success: true,
        addedCount: addedPhotos.length,
        added: addedPhotos
      });
    } else {
      res.status(500).json({ error: response.message || 'Failed to process video.' });
    }
  } catch (err) {
    try { fs.unlinkSync(file.path); } catch (e) {}
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/photos/:id', (req, res) => {
  const success = db.deletePhoto(req.params.id);
  if (success) {
    sendCandidatesToPython();
    broadcastDatabaseUpdate();
    res.json({ success: true, message: 'Photo deleted.' });
  } else {
    res.status(404).json({ error: 'Photo not found.' });
  }
});

// Clusters API Endpoints
app.get('/api/clusters', (req, res) => {
  res.json(db.getClusters());
});

app.post('/api/clusters/:id/enroll', async (req, res) => {
  const clusterId = req.params.id;
  const { name } = req.body;
  if (!name || name.trim() === '') {
    return res.status(400).json({ error: 'Person name is required.' });
  }
  try {
    const person = db.enrollCluster(clusterId, name);
    sendCandidatesToPython();
    broadcastDatabaseUpdate();
    broadcast({ event: 'clusters_updated' });
    res.json({ success: true, person });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/clusters/:clusterId/photos/:photoId/move', async (req, res) => {
  const { clusterId, photoId } = req.params;
  const { personId, name } = req.body;
  
  if (!personId && (!name || name.trim() === '')) {
    return res.status(400).json({ error: 'Person ID or Name is required.' });
  }
  
  try {
    const photo = db.movePhotoFromClusterToPerson(clusterId, photoId, personId, name);
    
    // Sync templates with running Python thread
    sendCandidatesToPython();
    broadcastDatabaseUpdate();
    broadcast({ event: 'clusters_updated' });
    
    res.json({ success: true, photo });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/clusters/:id', (req, res) => {
  const success = db.deleteCluster(req.params.id);
  if (success) {
    broadcast({ event: 'clusters_updated' });
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Cluster not found.' });
  }
});

// Static Image Face Recognition Upload API
app.post('/api/recognize', upload.single('photo'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No photo uploaded.' });
  }

  try {
    const candidates = db.getAllCandidates();
    const response = await sendPythonCommand({
      cmd: 'recognize_image',
      img_path: req.file.path,
      candidates: candidates,
      threshold: settings.threshold,
      dis_type: settings.dis_type,
      crops_dir: db.CROPS_DIR
    });

    if (response.status === 'success') {
      response.faces.forEach(face => {
        let personId = 'UNKNOWN';
        let personName = face.gender ? `UNKNOWN (${face.gender})` : 'UNKNOWN';
        let isKnownEvent = face.is_known;

        if (face.is_known) {
          const person = db.getPerson(face.match.person_id);
          const gender = (person && person.gender && person.gender !== 'Unknown') ? person.gender : (face.gender || 'Unknown');
          const genderSuffix = gender !== 'Unknown' ? ` (${gender})` : '';
          personId = face.match.person_id;
          personName = `${face.match.name}${genderSuffix}`;
          face.match.name = personName; // Update face record match name for the UI
        } else if (face.embedding) {
          try {
            const clusterResult = db.addFaceToCluster(face.embedding, face.crop_filename, face.gender, settings);
            personId = clusterResult.id;
            personName = clusterResult.name;
            broadcast({ event: 'clusters_updated' });
            face.cluster_id = clusterResult.id;
            face.cluster_name = clusterResult.name;
          } catch (err) {
            console.error('[Clustering] Error clustering face:', err);
          }
        }

        const savedEvent = db.addEvent(
          personId,
          personName,
          face.score,
          face.crop_filename,
          isKnownEvent,
          null,
          'Manual Upload'
        );

        broadcast({
          event: 'recognition_event',
          data: savedEvent
        });

        // AUTO-LEARNING: If recognized match (>= Math.max(0.68, settings.threshold)) and embedding is returned
        if (face.is_known && face.score >= Math.max(0.68, settings.threshold) && face.embedding) {
          const person = db.getPerson(face.match.person_id);
          if (person) {
            const autoPhotos = person.photos.filter(p => p.filename.startsWith('auto_'));
            
            // Limit check: if total photos >= 1000, try to prune the oldest auto-learned photo
            if (person.photos.length >= 1000) {
              if (autoPhotos.length > 0) {
                autoPhotos.sort((a, b) => a.filename.localeCompare(b.filename));
                const oldest = autoPhotos[0];
                db.deletePhoto(oldest.id);
                console.log(`[Auto-Learning] Pruned oldest auto-learned template ${oldest.filename} for ${person.name}`);
              } else {
                // If they have no auto-learned photos to prune (e.g. all are manual uploads),
                // allow a buffer of up to 10 auto-learned photos
                const maxCap = person.photos.length + 10;
                if (person.photos.length >= maxCap) {
                  console.log(`[Auto-Learning] Max buffer limit reached for ${person.name}. Skipping.`);
                  return;
                }
              }
            }

            const cropPath = path.join(db.CROPS_DIR, face.crop_filename);
            const uploadFilename = `auto_${Date.now()}_${path.basename(face.crop_filename)}`;
            const uploadPath = path.join(db.UPLOADS_DIR, uploadFilename);
            try {
              if (fs.existsSync(cropPath)) {
                fs.copyFileSync(cropPath, uploadPath);
                db.addPhoto(face.match.person_id, uploadFilename, face.embedding);
                console.log(`[Auto-Learning] Automatically enrolled new template for ${face.match.name} (Score: ${face.score.toFixed(3)})`);
                sendCandidatesToPython();
                broadcastDatabaseUpdate();
              }
            } catch (err) {
              console.error('[Auto-Learning] Error saving template:', err);
            }
          }
        }
      });

      try { fs.unlinkSync(req.file.path); } catch (e) {}
      res.json({ success: true, faces: response.faces });
    } else {
      try { fs.unlinkSync(req.file.path); } catch (e) {}
      res.status(500).json({ error: response.message });
    }
  } catch (err) {
    try { fs.unlinkSync(req.file.path); } catch (e) {}
    res.status(500).json({ error: err.message });
  }
});

// Camera Management REST API Routes
app.get('/api/cameras', (req, res) => {
  res.json(db.getCameras());
});

app.post('/api/cameras', (req, res) => {
  const { name, rtsp_url } = req.body;
  if (!name || !rtsp_url) {
    return res.status(400).json({ error: 'Name and RTSP URL are required.' });
  }
  const camera = db.addCamera(name.trim(), rtsp_url.trim());
  broadcast({ event: 'cameras_updated', data: db.getCameras() });
  res.status(201).json(camera);
});

app.delete('/api/cameras/:id', async (req, res) => {
  const cameraId = req.params.id;
  const camera = db.getCamera(cameraId);
  
  if (camera) {
    // Stop streams if active
    if (camera.is_active) {
      await stopCameraStream(camera);
    }
    
    db.deleteCamera(cameraId);
    broadcast({ event: 'cameras_updated', data: db.getCameras() });
    res.json({ success: true, message: 'Camera deleted.' });
  } else {
    res.status(404).json({ error: 'Camera not found.' });
  }
});

// Start/Stop recognition stream on a camera
app.post('/api/cameras/:id/toggle', async (req, res) => {
  const cameraId = req.params.id;
  const camera = db.getCamera(cameraId);

  if (!camera) {
    return res.status(404).json({ error: 'Camera not found.' });
  }

  const activate = !camera.is_active;

  try {
    if (activate) {
      const response = await startCameraStream(camera);

      if (response.status === 'success') {
        db.updateCameraStatus(cameraId, true);
        broadcast({ event: 'cameras_updated', data: db.getCameras() });
        res.json({ success: true, message: 'Camera stream started.' });
      } else {
        await stopCameraStream(camera);
        res.status(500).json({ error: response.message });
      }
    } else {
      await stopCameraStream(camera);
      db.updateCameraStatus(cameraId, false);
      broadcast({ event: 'cameras_updated', data: db.getCameras() });
      res.json({ success: true, message: 'Camera stream stopped.' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update camera line crossing settings
app.post('/api/cameras/:id/line-settings', async (req, res) => {
  const cameraId = req.params.id;
  const { line_crossing_enabled, line_y, line_direction, line_x_start, line_x_end } = req.body;
  
  const camera = db.updateCameraLineSettings(cameraId, line_crossing_enabled, line_y, line_direction, line_x_start, line_x_end);
  if (!camera) {
    return res.status(404).json({ error: 'Camera not found.' });
  }
  
  // If the camera is active, restart the stream in Python with new settings
  if (camera.is_active) {
    try {
      const isLocal = camera.rtsp_url.startsWith('rtsp://localhost') || camera.rtsp_url.startsWith('rtsp://127.0.0.1');
      const targetRtspUrl = isLocal ? camera.rtsp_url : `rtsp://127.0.0.1:8554/${camera.id}`;
      
      await sendPythonCommand({
        cmd: 'start_stream',
        camera_id: camera.id,
        camera_name: camera.name,
        rtsp_url: targetRtspUrl,
        candidates: db.getAllCandidates(),
        threshold: settings.threshold,
        dis_type: settings.dis_type,
        crops_dir: db.CROPS_DIR,
        line_crossing_enabled: camera.line_crossing_enabled,
        line_y: camera.line_y,
        line_direction: camera.line_direction,
        line_x_start: camera.line_x_start !== undefined ? camera.line_x_start : 0.0,
        line_x_end: camera.line_x_end !== undefined ? camera.line_x_end : 1.0
      });
    } catch (e) {
      console.error(`Failed to update settings for active camera ${camera.id}:`, e.message);
    }
  }
  
  broadcast({ event: 'cameras_updated', data: db.getCameras() });
  res.json({ success: true, camera });
});

// Upload video and stream via ffmpeg into mediamtx as an RTSP feed
app.post('/api/cameras/upload-mock', upload.single('video'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No video file uploaded.' });
  }

  try {
    const originalName = path.basename(req.file.originalname, path.extname(req.file.originalname));
    const name = `Mock Stream (${originalName})`;
    
    // 1. Create a camera placeholder in DB
    const camera = db.addCamera(name, 'temp');
    
    // 2. Start the FFmpeg streaming loop to MediaMTX
    const rtspUrl = startMockFFmpegStream(camera.id, req.file.path);
    
    // 3. Update the camera's RTSP URL
    camera.rtsp_url = rtspUrl;
    
    // Save to database by recreating structure
    const dbData = JSON.parse(fs.readFileSync(path.join(db.DATA_DIR, 'database.json'), 'utf8'));
    const dbCam = dbData.cameras.find(c => c.id === camera.id);
    if (dbCam) {
      dbCam.rtsp_url = rtspUrl;
      fs.writeFileSync(path.join(db.DATA_DIR, 'database.json'), JSON.stringify(dbData, null, 2));
    }
    
    // 4. Immediately trigger recognition start on Python worker
    const response = await sendPythonCommand({
      cmd: 'start_stream',
      camera_id: camera.id,
      camera_name: camera.name,
      rtsp_url: rtspUrl,
      candidates: db.getAllCandidates(),
      threshold: settings.threshold,
      dis_type: settings.dis_type,
      crops_dir: db.CROPS_DIR
    });
    
    if (response.status === 'success') {
      db.updateCameraStatus(camera.id, true);
      broadcast({ event: 'cameras_updated', data: db.getCameras() });
      res.status(201).json(camera);
    } else {
      stopMockFFmpegStream(camera.id);
      db.deleteCamera(camera.id);
      res.status(500).json({ error: response.message });
    }
  } catch (err) {
    console.error('Failed to start mock loop stream:', err);
    res.status(500).json({ error: err.message });
  }
});

// Events Log APIs
app.get('/api/events', (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  res.json(db.getEvents(limit));
});

app.post('/api/events/:eventId/move', async (req, res) => {
  const { eventId } = req.params;
  const { personId, name } = req.body;
  
  if (!personId && (!name || name.trim() === '')) {
    return res.status(400).json({ error: 'Person ID or Name is required.' });
  }
  
  try {
    const event = db.getEvents(1000).find(e => e.id === eventId);
    if (!event) {
      return res.status(404).json({ error: 'Event not found.' });
    }
    
    // Determine if we need to extract the embedding from the crop image file
    let embedding = null;
    const clusterId = event.person_id;
    let foundInCluster = false;
    
    if (clusterId && clusterId !== 'UNKNOWN') {
      const cluster = db.getClusters().find(c => c.id === clusterId);
      if (cluster) {
        const photo = cluster.photos.find(p => p.filename === event.crop_filename);
        if (photo) {
          embedding = photo.embedding;
          foundInCluster = true;
        }
      }
    }
    
    if (!foundInCluster) {
      // Extract embedding using CPU face worker on-the-fly
      const cropPath = path.join(db.CROPS_DIR, event.crop_filename);
      if (fs.existsSync(cropPath)) {
        console.log(`[Event Promotion] Extracting embedding on-the-fly from crop: ${event.crop_filename}`);
        const response = await sendPythonCommand({
          cmd: 'extract_embedding',
          img_path: cropPath,
          enforce_quality: false
        });
        if (response.status === 'success') {
          embedding = response.embedding;
        } else {
          console.warn(`[Event Promotion] Failed to extract embedding: ${response.message}`);
        }
      }
    }
    
    const result = db.moveEventPhotoToPerson(eventId, personId, name, embedding);
    
    // Sync templates with running Python thread
    sendCandidatesToPython();
    broadcastDatabaseUpdate();
    broadcast({ event: 'clusters_updated' });
    
    res.json({ success: true, event: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/events', (req, res) => {
  const success = db.clearEvents();
  broadcast({ event: 'events_cleared' });
  res.json({ success });
});

// Settings Update API
app.post('/api/settings', async (req, res) => {
  const { threshold, dis_type } = req.body;
  if (threshold !== undefined) settings.threshold = parseFloat(threshold);
  if (dis_type !== undefined) settings.dis_type = parseInt(dis_type);
  
  saveSettings();
  sendCandidatesToPython();
  
  // Apply settings to running camera streams by restarting them dynamically in Python
  const activeCameras = db.getCameras().filter(c => c.is_active);
  for (const cam of activeCameras) {
    try {
      const isLocal = cam.rtsp_url.startsWith('rtsp://localhost') || cam.rtsp_url.startsWith('rtsp://127.0.0.1');
      const targetRtspUrl = isLocal ? cam.rtsp_url : `rtsp://127.0.0.1:8554/${cam.id}`;
      
      await sendPythonCommand({
        cmd: 'start_stream',
        camera_id: cam.id,
        camera_name: cam.name,
        rtsp_url: targetRtspUrl,
        candidates: db.getAllCandidates(),
        threshold: settings.threshold,
        dis_type: settings.dis_type,
        crops_dir: db.CROPS_DIR,
        line_crossing_enabled: !!cam.line_crossing_enabled,
        line_y: cam.line_y !== undefined ? cam.line_y : 0.6,
        line_direction: cam.line_direction || 'in',
        line_x_start: cam.line_x_start !== undefined ? cam.line_x_start : 0.0,
        line_x_end: cam.line_x_end !== undefined ? cam.line_x_end : 1.0
      });
    } catch (e) {
      console.error(`Failed to apply updated settings on running camera ${cam.id}:`, e.message);
    }
  }
  
  broadcast({
    event: 'stream_status',
    data: {
      threshold: settings.threshold,
      dis_type: settings.dis_type
    }
  });
  
  res.json({ success: true, settings });
});

// Clean up processes on termination
function cleanup() {
  console.log('Cleaning up sub-processes...');
  if (pythonProcess) {
    try { pythonProcess.kill('SIGKILL'); } catch (e) {}
  }
  if (mediamtxProcess) {
    try { mediamtxProcess.kill('SIGKILL'); } catch (e) {}
  }
  ffmpegProcesses.forEach((proc) => {
    try { proc.kill('SIGKILL'); } catch (e) {}
  });
  transcoderProcesses.forEach((proc) => {
    try { proc.kill('SIGKILL'); } catch (e) {}
  });
}

// Attach listeners for server shutdown
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(); });
process.on('SIGTERM', () => { cleanup(); process.exit(); });

// Start Express server
server.listen(PORT, () => {
  console.log(`Face Recognition Server is listening on http://localhost:${PORT}`);
});
