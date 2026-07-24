# Atomo Fordge multi-camera API fix

These are complete replacement files for the corresponding backend integration modules.

## Replace these files

| File | Purpose |
|---|---|
| `face-live.js` | Starts each face stream independently, points the board camera at the shared local MediaMTX H.264 stream, sends the documented line-crossing fields, and polls at a controlled rate. |
| `person-live.js` | Starts/stops person detection per camera and keeps every other camera running. |
| `detection-store.js` | Stores selected-camera state separately from the set of running cameras and scopes tracks/metrics per camera. |
| `camera-store.js` | Normalizes API `url` and dashboard `rtspUrl` in both directions. |
| `camera-analytics.js` | Produces browser-reachable WHEP/HLS URLs without hard-coding one board IP. |
| `vision-api.js` | Adds bearer authentication, automatic login/token refresh, timeouts, JSON handling, and health checks. |
| `board-camera-sync.js` | Reuses/registers backend cameras for inference, while attaching the independent local browser-playback path. |
| `local-mediamtx.js` | Restores the original local MediaMTX pipeline, publishes paths by dashboard camera UUID, and transcodes H.265 to browser-compatible H.264. |

Keep your other modules (`face-store.js`, `face-confidence.js`, `event-broadcast.js`, routes, and so on) unchanged.

## Required setup

1. Copy all eight JavaScript files over files with the same names in `./lib/`.
2. Keep the working `mediamtx` binary in the project root and make it executable (`chmod +x ./mediamtx`).
3. Merge `.env.example` into your real environment. `VISION_API_URL`/`VISION_PUBLIC_HOST` point to the remote vision board; `LOCAL_MEDIA_HOST` points to the frontend Node machine opened by the browser.
4. Restart the Node backend once. Startup creates one local MediaMTX path per camera.

When face and camera endpoints share the same API at port `3001`, set `VISION_API_URL` and leave `VISION_FACE_API_URL` unset. Set `VISION_FACE_API_URL` only for a truly separate face service.

For the example topology in this issue:

```dotenv
VISION_API_URL=http://192.168.1.34:3001
VISION_PUBLIC_HOST=192.168.1.34
LOCAL_MEDIA_HOST=192.168.1.38
```

The browser URLs will then be:

```text
http://192.168.1.38:8889/<dashboard-camera-uuid>/whep
http://192.168.1.38:8888/<dashboard-camera-uuid>/index.m3u8
```

They intentionally do not use `cam_...` backend IDs. Those IDs are reserved for `/api/detect/*` and `/api/face/*` calls on the vision board.

The same local stream is also saved as the input URL for the board camera before
`POST /api/face/stream/start`:

```text
Camera H.265 RTSP -> frontend FFmpeg -> frontend MediaMTX H.264
                                      -> browser WHEP/HLS
                                      -> board face_worker RTSP reader
```

For example, `cam_689029f3` remains the face API camera ID, while its saved
worker input becomes:

```text
rtsp://192.168.1.38:8554/eebeae0d-77d1-4c7e-842d-cf820933e992
```

Port `8554` on the frontend machine must be reachable from the vision board.

The start APIs now behave as follows:

- `startLive(cameraA)` does not stop `cameraB`.
- `selectCamera(cameraB)` changes only the displayed camera.
- Face start does not wait 40–85 seconds for the first detected face/frame.
- Stopping one camera leaves every other camera worker and polling loop active.
- A saved tripwire is sent with `line_crossing_enabled`, `line_y`, `line_direction`, `line_x_start`, and `line_x_end`.
- Browser playback starts independently of face/person model warm-up.
- H.264 RTSP is proxied directly; H.265/HEVC is republished as low-latency H.264, matching the original implementation.
- Browser playback and face recognition now decode the same MediaMTX H.264 publication instead of opening the H.265 camera twice.
