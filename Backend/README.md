# Vision Backend

Express.js server for AI-powered camera surveillance — streams via MediaMTX, runs NPU inference workers (person, face, fire/smoke, PPE).

## Architecture

```
IP Camera (RTSP)
     │
     ▼
 MediaMTX ──► WHEP (browser live view)
     │
     │  rtsp://localhost:8554/<cam_id>
     ▼
Python Detector (person.py / face.py / ...)
  └─ NPU inference (Khadas Electron asnn)
  └─ Writes JSON results each frame
     │
     ▼
This Node server ◄── REST API / WebSocket clients
```

## Quick Start

> **If you're inside a folder that already has a `node_modules` above it** (e.g. `~/Neha/vision-backend/`), npm can resolve packages from the wrong place. Always do a clean install:

```bash
# Step 1 — delete any stale local modules
rm -rf node_modules package-lock.json

# Step 2 — install (the included .npmrc keeps everything local)
npm install

# Step 3 — start
node src/index.js
```

The server starts on port **3000** by default:

```
🚀  Vision Backend running on http://localhost:3000
📋  API overview:  http://localhost:3000/api
❤️   Health check:  http://localhost:3000/health
🔌  WebSocket:     ws://localhost:3000/ws?camera=<id>&model=<id>
```

Use a different port:
```bash
PORT=8080 node src/index.js
```

Run the full test suite (server must already be running in another terminal):
```bash
node test-api.js   # 32 tests — should all pass
```

## Default Credentials

| User    | Password   | Role   |
|---------|------------|--------|
| admin   | admin123   | admin  |
| viewer  | viewer123  | viewer |

## Authentication

All API endpoints require `Authorization: Bearer <token>`.

```bash
# 1. Login — get your token
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin123"}'
# → { "token": "eyJ...", "user": { "role": "admin" } }

# 2. Use the token on every subsequent request
curl http://localhost:3000/api/cameras \
  -H "Authorization: Bearer eyJ..."
```

## Camera Flow

### Add a camera
```bash
curl -X POST http://localhost:3000/api/cameras \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Front Door",
    "type": "rtsp",
    "url": "rtsp://192.168.1.10:554/stream",
    "username": "admin",
    "password": "pass123",
    "location": "Main Lobby"
  }'
```

What happens internally:
1. Stream is validated (codec, FPS, resolution detected)
2. Camera record is saved with a generated `cam_xxxx` ID
3. Path is registered in MediaMTX — it starts pulling the RTSP stream
4. Response includes `whep_url` for browser/WebRTC playback

### Stream in browser
```html
<video id="v" autoplay muted playsinline></video>
<script>
  // Use a WHEP client lib e.g. https://github.com/Eyevinn/webrtc-player
  const player = new WebRTCPlayer({ video: document.getElementById('v') });
  player.load(new URL('http://localhost:8889/cam_xxxxxxxx/whep'));
</script>
```

## Detection (Inference)

### Available Models & Their Capabilities

| Model ID   | Name                | Capabilities (checkboxes)                                                     |
|------------|---------------------|-------------------------------------------------------------------------------|
| mdl_person | Person Detection    | `person_detection`                                                            |
| mdl_face   | Face Analysis       | `face_detection`, `gender_classification`, `face_recognition`                |
| mdl_fire   | Fire & Smoke        | `fire_detection`, `smoke_detection`                                           |
| mdl_ppe    | Safety PPE          | `helmet_detection`, `vest_detection`, `gloves_detection`, `no_ppe_alert`     |

### Start person detection
```bash
curl -X POST http://localhost:3000/api/detect/start \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "camera_id": "cam_abc123",
    "model_id": "mdl_person",
    "confidence": 0.45,
    "fps": 5
  }'
```

### Start face detection — selective capabilities (checkbox model)
Send only the capabilities the user checked. Omit `capabilities` to enable all.

```bash
curl -X POST http://localhost:3000/api/detect/start \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "camera_id": "cam_abc123",
    "model_id": "mdl_face",
    "confidence": 0.5,
    "fps": 3,
    "capabilities": ["face_detection", "gender_classification"]
  }'
# face_recognition is NOT active — user didn't check it
# Worker spawns as: python3 face.py --enable-face-detection --enable-gender-classification
```

### Start PPE (helmet + vest only, no gloves)
```bash
curl -X POST http://localhost:3000/api/detect/start \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "camera_id": "cam_abc123",
    "model_id": "mdl_ppe",
    "capabilities": ["helmet_detection", "vest_detection", "no_ppe_alert"]
  }'
```

### Poll latest result
```bash
curl http://localhost:3000/api/detect/result/cam_abc123/mdl_person \
  -H "Authorization: Bearer $TOKEN"
```

### WebSocket live push (500ms interval)
```js
const ws = new WebSocket('ws://localhost:3000/ws?camera=cam_abc123&model=mdl_face');
ws.onmessage = e => {
  const data = JSON.parse(e.data);
  console.log('Faces detected:', data.face_count, data.faces);
};
```

### Update confidence/FPS without restarting the worker
```bash
curl -X PUT http://localhost:3000/api/detect/config \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"camera_id":"cam_abc123","model_id":"mdl_person","confidence":0.6,"fps":3}'
```

### Set a detection zone polygon (normalised 0.0–1.0 coords)
```bash
curl -X POST http://localhost:3000/api/detect/zone \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "camera_id": "cam_abc123",
    "model_id": "mdl_person",
    "zone": [[0.1,0.2],[0.6,0.2],[0.6,0.8],[0.1,0.8]]
  }'
```

## Connecting Real Python Detectors

In `src/services/worker.js`, the real spawn block is present but commented out. To go live:

1. Un-comment the `spawn()` block, delete the mock block
2. Ensure your Python scripts accept these flags:
   - `--rtsp <url>` — local MediaMTX re-stream URL
   - `--model <path>` — `.nb` model file
   - `--library <path>` — `libnn_*.so` NPU library
   - `--conf <float>` — confidence threshold
   - `--headless` — no display window
   - `--json-out` — print one JSON object per frame to stdout
   - `--enable-<capability>` — e.g. `--enable-gender-classification`

Your `person.py` already handles `--rtsp`, `--model`, `--library`, `--conf`, `--headless`. Just add `--json-out` stdout printing and the `--enable-*` flag parsing.

## Environment Variables (.env)

| Variable             | Default                      | Description                          |
|----------------------|------------------------------|--------------------------------------|
| `PORT`               | `3000`                       | HTTP listen port                     |
| `JWT_SECRET`         | *(change this!)*             | JWT signing secret                   |
| `MEDIAMTX_API_URL`   | `http://localhost:9997`      | MediaMTX REST API base URL           |
| `MEDIAMTX_RTSP_PORT` | `8554`                       | MediaMTX RTSP port                   |
| `MEDIAMTX_WHEP_PORT` | `8889`                       | MediaMTX WHEP port                   |
| `DETECTORS_PATH`     | `./detectors`                | Python scripts directory             |
| `MODELS_PATH`        | `./models`                   | `.nb` / `.onnx` model files          |
| `ASNN_LIBRARY_PATH`  | `./lib/libnn_yolo26s.so`     | NPU shared library                   |

## File Structure

```
vision-backend/
├── src/
│   ├── index.js              ← Express app + WebSocket server
│   ├── store.js              ← In-memory store (cameras, models, workers)
│   ├── middleware/
│   │   └── auth.js           ← JWT sign/verify + requireRole guard
│   ├── services/
│   │   ├── mediamtx.js       ← MediaMTX REST API wrapper
│   │   └── worker.js         ← Python process spawner (mock + real)
│   └── routes/
│       ├── auth.js           ← POST /api/auth/login
│       ├── cameras.js        ← 10 camera endpoints
│       ├── models.js         ← 7 model endpoints
│       └── detect.js         ← 6 inference endpoints + extras
├── test-api.js               ← 32-test suite
├── .npmrc                    ← Prevents parent node_modules interference
├── .env                      ← Config (edit before starting)
└── README.md
```
