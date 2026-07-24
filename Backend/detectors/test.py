"""
rtsp_diag.py — RTSP / OpenCV connectivity diagnostic for VIM3
Run: python3 rtsp_diag.py <rtsp_url>
Example: python3 rtsp_diag.py rtsp://localhost:8554/cam_8d28bbeb
"""
import sys, os, time, subprocess, shutil

URL = sys.argv[1] if len(sys.argv) > 1 else "rtsp://localhost:8554/cam_8d28bbeb"

SEP  = "=" * 60
PASS = "[ OK ]"
FAIL = "[FAIL]"
WARN = "[WARN]"
INFO = "[INFO]"

def section(title):
    print(f"\n{SEP}\n  {title}\n{SEP}")

def run(cmd):
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=10)
    return r.stdout.strip(), r.stderr.strip(), r.returncode

# ── 1. Python / OpenCV build info ────────────────────────────────────────────
section("1. Python & OpenCV")
import cv2 as cv
print(f"{INFO} Python      : {sys.version.split()[0]}")
print(f"{INFO} OpenCV      : {cv.__version__}")
build = cv.getBuildInformation()
has_ffmpeg = "FFMPEG:                      YES" in build or "ffmpeg" in build.lower()
has_gst    = "GStreamer:" in build and "YES" in build[build.find("GStreamer:"):build.find("GStreamer:")+40]
print(f"{'PASS' if has_ffmpeg else FAIL} FFmpeg backend : {'YES' if has_ffmpeg else 'NO  <-- root cause'}")
print(f"{'PASS' if has_gst    else WARN} GStreamer      : {'YES' if has_gst    else 'NO'}")

# Print relevant lines from build info
for line in build.splitlines():
    l = line.strip()
    if any(k in l.lower() for k in ["ffmpeg","gstream","video i/o","v4l","avcodec"]):
        print(f"       {l}")

# ── 2. FFmpeg binary ──────────────────────────────────────────────────────────
section("2. FFmpeg binary on PATH")
ffmpeg_path = shutil.which("ffmpeg")
ffplay_path = shutil.which("ffplay")
print(f"{'PASS' if ffmpeg_path else FAIL} ffmpeg : {ffmpeg_path or 'NOT FOUND'}")
print(f"{'PASS' if ffplay_path else FAIL} ffplay : {ffplay_path or 'NOT FOUND'}")

if ffmpeg_path:
    out, err, _ = run("ffmpeg -version 2>&1 | head -3")
    for l in out.splitlines()[:2]: print(f"       {l}")

# ── 3. Network reachability ───────────────────────────────────────────────────
section("3. Network — can we reach MediaMTX :8554?")
host = URL.split("//")[1].split("/")[0].split(":")[0]
port_str = URL.split("//")[1].split("/")[0].split(":")[1] if ":" in URL.split("//")[1].split("/")[0] else "8554"
print(f"{INFO} host={host}  port={port_str}")

out, err, rc = run(f"nc -z -w2 {host} {port_str}")
print(f"{'PASS' if rc==0 else FAIL} TCP connect to {host}:{port_str} : {'OK' if rc==0 else 'FAILED'}")

# ── 4. Raw RTSP probe with ffprobe ────────────────────────────────────────────
section("4. FFprobe RTSP probe (30s timeout)")
if ffmpeg_path:
    cmd = f"ffprobe -v error -rtsp_transport tcp -i '{URL}' -show_streams -of compact 2>&1"
    print(f"       Running: {cmd}")
    try:
        r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=15)
        combined = (r.stdout + r.stderr).strip()
        if "codec_name" in combined or "Video" in combined:
            print(f"{PASS} ffprobe got stream info")
            for l in combined.splitlines():
                if any(k in l for k in ["codec","width","height","fps","Video","Audio"]):
                    print(f"       {l}")
        else:
            print(f"{FAIL} ffprobe got no stream info")
            for l in combined.splitlines()[-8:]: print(f"       {l}")
    except subprocess.TimeoutExpired:
        print(f"{FAIL} ffprobe timed out after 15s")
else:
    print(f"{WARN} Skipped — ffmpeg not on PATH")

# ── 5. OpenCV cap backends available ─────────────────────────────────────────
section("5. OpenCV VideoCapture backend test")
BACKENDS = [
    ("CAP_FFMPEG",  cv.CAP_FFMPEG),
    ("CAP_GSTREAMER", cv.CAP_GSTREAMER),
    ("CAP_ANY",     cv.CAP_ANY),
]
for name, backend in BACKENDS:
    try:
        os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = "rtsp_transport;tcp"
        cap = cv.VideoCapture(URL, backend)
        opened = cap.isOpened()
        cap.release()
        print(f"{'PASS' if opened else FAIL} cv.VideoCapture({name}) isOpened={opened}")
    except Exception as e:
        print(f"{FAIL} cv.VideoCapture({name}) exception: {e}")

# ── 6. Try reading one frame with timeout ────────────────────────────────────
section("6. Frame grab test (CAP_FFMPEG, 8s)")
import threading
result = {"frame": None, "error": None}

def grab():
    try:
        os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = "rtsp_transport;tcp"
        cap = cv.VideoCapture(URL, cv.CAP_FFMPEG)
        if not cap.isOpened():
            result["error"] = "cap.isOpened() returned False"
            return
        for _ in range(50):
            ret, frame = cap.read()
            if ret and frame is not None and frame.size > 0:
                result["frame"] = frame.shape
                break
            time.sleep(0.1)
        cap.release()
        if result["frame"] is None:
            result["error"] = "50 reads returned no frame"
    except Exception as e:
        result["error"] = str(e)

t = threading.Thread(target=grab); t.start(); t.join(timeout=10)
if result["frame"]:
    print(f"{PASS} Got frame: {result['frame']} (HxWxC)")
else:
    print(f"{FAIL} No frame — {result.get('error','thread timeout')}")

# ── 7. GStreamer pipeline test (if available) ─────────────────────────────────
section("7. GStreamer pipeline test")
gst_cmd = f"gst-launch-1.0 -e rtspsrc location={URL} protocols=tcp ! fakesink sync=false"
gst_bin = shutil.which("gst-launch-1.0")
if gst_bin:
    print(f"{INFO} Running 5s GStreamer test…")
    try:
        r = subprocess.run(gst_cmd, shell=True, capture_output=True, text=True, timeout=6)
        combined = r.stdout + r.stderr
        ok = "Pipeline is live" in combined or "Setting pipeline" in combined
        print(f"{'PASS' if ok else FAIL} GStreamer: {'pipeline started' if ok else 'failed'}")
        for l in combined.splitlines()[-5:]: print(f"       {l}")
    except subprocess.TimeoutExpired:
        print(f"{PASS} GStreamer ran for 5s (expected timeout = stream is alive)")
else:
    print(f"{WARN} gst-launch-1.0 not found — GStreamer not installed")

# ── 8. subprocess ffmpeg pipe (workaround) ────────────────────────────────────
section("8. FFmpeg pipe workaround test (reads 5 frames via subprocess)")
if ffmpeg_path:
    import numpy as np
    W, H = 1920, 1080
    cmd = [
        "ffmpeg", "-loglevel", "error",
        "-rtsp_transport", "tcp",
        "-i", URL,
        "-vf", f"scale={W}:{H}",
        "-f", "rawvideo", "-pix_fmt", "bgr24",
        "-vframes", "5", "pipe:1"
    ]
    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        raw = proc.stdout.read(W * H * 3 * 5)
        proc.terminate()
        frames_got = len(raw) // (W * H * 3)
        if frames_got > 0:
            frame = np.frombuffer(raw[:W*H*3], dtype=np.uint8).reshape(H, W, 3)
            print(f"{PASS} FFmpeg pipe: got {frames_got} frame(s) — shape={frame.shape}")
            print(f"       --> FFmpeg pipe workaround WILL WORK for inference")
        else:
            print(f"{FAIL} FFmpeg pipe: 0 bytes received")
            err = proc.stderr.read().decode()
            for l in err.splitlines()[-5:]: print(f"       {l}")
    except Exception as e:
        print(f"{FAIL} FFmpeg pipe: {e}")
else:
    print(f"{WARN} Skipped — ffmpeg not on PATH")

# ── Summary ───────────────────────────────────────────────────────────────────
section("SUMMARY & RECOMMENDED FIX")
if not has_ffmpeg:
    print("""
  OpenCV was built WITHOUT FFmpeg support on this device.
  This is the root cause — cv.VideoCapture cannot open RTSP.

  Options (in order of preference):
  1. Rebuild OpenCV with FFmpeg:
       sudo apt install libavcodec-dev libavformat-dev libswscale-dev
       pip uninstall opencv-python
       pip install opencv-python  (or rebuild from source with cmake)

  2. Use the FFmpeg subprocess pipe workaround (no rebuild needed):
       The fire_smoke.py will be patched to use subprocess+pipe
       instead of cv.VideoCapture.
       Run rtsp_diag.py again — if section 8 passed, we can use this.
""")
elif result["frame"]:
    print(f"\n  OpenCV RTSP works — frame received. Run fire_smoke.py normally.")
else:
    print("""
  OpenCV has FFmpeg but still can't open the stream.
  Check:
  - Is MediaMTX running? (mediamtx.yml configured?)
  - Is the stream URL correct?
  - Try: OPENCV_FFMPEG_CAPTURE_OPTIONS="rtsp_transport;tcp" python3 ...
  - Does section 8 (FFmpeg pipe) pass? If so, use the pipe workaround.
""")
