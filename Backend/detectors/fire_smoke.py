import os
os.environ["OMP_NUM_THREADS"] = "1"
os.environ["OPENBLAS_NUM_THREADS"] = "1"
os.environ["MKL_NUM_THREADS"] = "1"
os.environ["VECLIB_MAXIMUM_THREADS"] = "1"
os.environ["NUMEXPR_NUM_THREADS"] = "1"
os.environ["FFMPEG_NUM_THREADS"] = "1"
os.environ["OPENCV_THREAD_POOL_LIMIT"] = "1"

import numpy as np
import argparse
import sys
import time
import json
import base64
import faulthandler
from collections import deque
from queue import Queue, Empty
import threading
import cv2 as cv
cv.setNumThreads(1)
from asnn.api import asnn
from asnn.types import *

faulthandler.enable()

# ─── Constants ────────────────────────────────────────────────────────────────
GRID0, GRID1, GRID2 = 20, 40, 80
LISTSIZE   = 66
NUM_CLS    = 2
NMS_THRESH = 0.45
CLASSES    = ("Smoke", "Fire")

mean = np.array([0, 0, 0], dtype=np.float32)
var  = np.array([255],      dtype=np.float32)
constant_martix = np.array([[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15]]).T

DETECTION_DIR = "detection_photos"
os.makedirs(DETECTION_DIR, exist_ok=True)

# Pre-allocate grids
grids = {}
for _sz, _nm in [(20,'20'),(40,'40'),(80,'80')]:
    _col = np.tile(np.arange(0,_sz,dtype=np.float32),_sz).reshape(-1,_sz)
    _row = np.tile(np.arange(0,_sz,dtype=np.float32).reshape(-1,1),_sz)
    grids[_nm] = np.concatenate((_col.reshape(_sz,_sz,1,1),_row.reshape(_sz,_sz,1,1)),axis=-1)

CANVAS     = np.full((640,640,3),114,dtype=np.uint8)
FIRE_COLOR  = (0,0,255)
SMOKE_COLOR = (255,255,255)

# ─── stdout JSON emitter ──────────────────────────────────────────────────────
def emit(data: dict):
    print(json.dumps(data), flush=True)

# ─── Alert System ─────────────────────────────────────────────────────────────
class AlertSystem:
    def __init__(self, threshold=5):
        self.fire_count = self.smoke_count = 0
        self.threshold  = threshold
        self.fire_alerted = self.smoke_alerted = False
        self.fire_level = self.smoke_level = 0
        self.last_fire_alert = self.last_smoke_alert = 0
        self.last_fire_photo = self.last_smoke_photo = 0
        self.alert_cooldown = 3
        self.photo_cooldown = 1

    def update(self, fire_det, smoke_det):
        alerts, photos = [], []
        now = time.time()
        if fire_det:
            self.fire_count += 1
            lv = self.fire_count // self.threshold
            if lv > self.fire_level:
                self.fire_level = lv; self.fire_alerted = True
                alerts.append(f"FIRE DETECTED {self.threshold} TIMES! Total:{self.fire_count}")
                self.last_fire_alert = now
            elif self.fire_alerted and (now - self.last_fire_alert) >= self.alert_cooldown:
                alerts.append(f"FIRE CONTINUING! Total:{self.fire_count}")
                self.last_fire_alert = now
            if (now - self.last_fire_photo) >= self.photo_cooldown:
                photos.append('fire'); self.last_fire_photo = now
        if smoke_det:
            self.smoke_count += 1
            lv = self.smoke_count // self.threshold
            if lv > self.smoke_level:
                self.smoke_level = lv; self.smoke_alerted = True
                alerts.append(f"SMOKE DETECTED {self.threshold} TIMES! Total:{self.smoke_count}")
                self.last_smoke_alert = now
            elif self.smoke_alerted and (now - self.last_smoke_alert) >= self.alert_cooldown:
                alerts.append(f"SMOKE CONTINUING! Total:{self.smoke_count}")
                self.last_smoke_alert = now
            if (now - self.last_smoke_photo) >= self.photo_cooldown:
                photos.append('smoke'); self.last_smoke_photo = now
        return alerts, photos

    def status(self):
        return {
            'fire_count':   self.fire_count,  'smoke_count':   self.smoke_count,
            'fire_alerted': self.fire_alerted, 'smoke_alerted': self.smoke_alerted,
            'fire_level':   self.fire_level,   'smoke_level':   self.smoke_level,
        }

# ─── Image helpers ────────────────────────────────────────────────────────────
def letterbox(frame):
    h, w = frame.shape[:2]
    scale = 640.0 / max(h, w)
    nh, nw = int(h*scale), int(w*scale)
    resized = cv.resize(frame, (nw,nh), interpolation=cv.INTER_NEAREST)
    canvas = CANVAS.copy()
    y0 = (640-nh)//2; x0 = (640-nw)//2
    canvas[y0:y0+nh, x0:x0+nw] = cv.cvtColor(resized, cv.COLOR_BGR2RGB)
    return canvas, scale, x0, y0

def unletterbox(boxes, scale, x0, y0, ow, oh):
    boxes = boxes * 640.0
    boxes[:,0] = np.clip((boxes[:,0]-x0)/scale, 0, ow)
    boxes[:,1] = np.clip((boxes[:,1]-y0)/scale, 0, oh)
    boxes[:,2] = np.clip((boxes[:,2]-x0)/scale, 0, ow)
    boxes[:,3] = np.clip((boxes[:,3]-y0)/scale, 0, oh)
    return boxes

def sigmoid(x): return 1.0/(1.0+np.exp(-x))

def softmax(x):
    e = np.exp(x - np.max(x, axis=-1, keepdims=True))
    return e / np.sum(e, axis=-1, keepdims=True)

def process_single(inp, grid, raw_thresh):
    m = np.max(inp[...,:NUM_CLS], axis=-1) >= raw_thresh
    if not np.any(m): return np.array([]), np.array([]), np.array([])
    mi = inp[m]; mg = grid[m]
    p  = sigmoid(mi[:,:NUM_CLS])
    bc = np.argmax(p, axis=-1); bs = np.max(p, axis=-1)
    b0=softmax(mi[:,NUM_CLS:NUM_CLS+16]); b1=softmax(mi[:,NUM_CLS+16:NUM_CLS+32])
    b2=softmax(mi[:,NUM_CLS+32:NUM_CLS+48]); b3=softmax(mi[:,NUM_CLS+48:NUM_CLS+64])
    r = np.zeros((b0.shape[0],4), dtype=np.float32)
    r[:,0]=np.dot(b0,constant_martix)[:,0]; r[:,1]=np.dot(b1,constant_martix)[:,0]
    r[:,2]=np.dot(b2,constant_martix)[:,0]; r[:,3]=np.dot(b3,constant_martix)[:,0]
    gh,gw = inp.shape[:2]
    gf = np.array([float(gw),float(gh)], dtype=np.float32)
    r[:,0:2]=(0.5-r[:,0:2]+mg)/gf; r[:,2:4]=(0.5+r[:,2:4]+mg)/gf
    return r, bc, bs

def nms(boxes, scores):
    if len(boxes)<2: return np.arange(len(boxes))
    x1,y1,x2,y2 = boxes[:,0],boxes[:,1],boxes[:,2],boxes[:,3]
    a=(x2-x1)*(y2-y1); o=scores.argsort()[::-1]; k=[]
    while o.size>0:
        i=o[0]; k.append(i)
        if o.size==1: break
        xx1=np.maximum(x1[i],x1[o[1:]]); yy1=np.maximum(y1[i],y1[o[1:]])
        xx2=np.minimum(x2[i],x2[o[1:]]); yy2=np.minimum(y2[i],y2[o[1:]])
        w=np.maximum(0.0,xx2-xx1+1e-5); h=np.maximum(0.0,yy2-yy1+1e-5)
        o=o[np.where(w*h/(a[i]+a[o[1:]]-w*h)<=NMS_THRESH)[0]+1]
    return np.array(k, dtype=np.int32)

def post_process(data_list, raw_thresh):
    ab,ac,as_ = [],[],[]
    for i,nm in enumerate(['20','40','80']):
        b,c,s = process_single(data_list[i], grids[nm], raw_thresh)
        if len(b)>0: ab.append(b); ac.append(c); as_.append(s)
    if not ab: return None
    boxes=np.concatenate(ab); classes=np.concatenate(ac).astype(np.int32); scores=np.concatenate(as_)
    fb,fc,fs=[],[],[]
    for uc in np.unique(classes):
        m=classes==uc; k=nms(boxes[m],scores[m])
        if len(k)>0: fb.append(boxes[m][k]); fc.append(np.full(len(k),uc,np.int32)); fs.append(scores[m][k])
    return (np.concatenate(fb),np.concatenate(fs),np.concatenate(fc)) if fb else None

def frame_to_jpeg_b64(frame, quality=75):
    ok, buf = cv.imencode('.jpg', frame, [cv.IMWRITE_JPEG_QUALITY, quality])
    return base64.b64encode(buf.tobytes()).decode('ascii') if ok else None

# ─── Frame Reader ─────────────────────────────────────────────────────────────
class FrameReader:
    def __init__(self, source):
        self.source = source; self.frame = None
        self.current_frame = 0; self.lock = threading.Lock()
        self.running = False; self.fps = 25
        self.width = self.height = 0

    def start(self):
        self.cap = cv.VideoCapture(self.source, cv.CAP_FFMPEG)
        try: self.cap.set(cv.CAP_PROP_THREAD_COUNT, 1)
        except: pass
        self.cap.set(cv.CAP_PROP_BUFFERSIZE, 2)
        self.width  = int(self.cap.get(cv.CAP_PROP_FRAME_WIDTH)  or 1920)
        self.height = int(self.cap.get(cv.CAP_PROP_FRAME_HEIGHT) or 1080)
        fps = self.cap.get(cv.CAP_PROP_FPS)
        self.fps = fps if 0<fps<=60 else 25
        if not self.cap.isOpened(): return None
        self.running = True
        threading.Thread(target=self._loop, daemon=True).start()
        return self

    def _loop(self):
        fail=0
        while self.running:
            try: ret,frame=self.cap.read()
            except: ret=False; frame=None
            if not ret or frame is None or frame.size==0:
                fail+=1
                if fail>5:
                    self.cap.release(); time.sleep(2)
                    self.cap=cv.VideoCapture(self.source, cv.CAP_FFMPEG)
                    self.cap.set(cv.CAP_PROP_BUFFERSIZE,2); fail=0
                time.sleep(0.01); continue
            fail=0; self.current_frame+=1
            with self.lock: self.frame=frame

    def get_frame(self):
        with self.lock:
            if self.frame is not None and self.frame.size>0:
                return self.frame.copy(), self.current_frame
        return None, self.current_frame

    def stop(self):
        self.running=False; time.sleep(0.2)
        if hasattr(self,'cap'): self.cap.release()

# ─── NPU Worker ───────────────────────────────────────────────────────────────
class NPUWorker:
    def __init__(self, library, model_path, level=0):
        self.iq=Queue(maxsize=2); self.oq=Queue(maxsize=2)
        self.running=False; self.inf_times=deque(maxlen=10); self.model=None
        try:
            self.model=asnn('VIM3')
            self.model.nn_init(library=library, model=model_path, level=level)
        except Exception as e:
            print(f'[NPU] init error: {e}', file=sys.stderr)

    def start(self):
        if self.model is None: return None
        self.running=True
        threading.Thread(target=self._loop, daemon=True).start()
        return self

    def _loop(self):
        while self.running:
            try:
                item=self.iq.get(timeout=0.1)
                if item is None: continue
                frame,scale,px,py,ow,oh,raw_thresh=item
                t0=time.time()
                img=frame.astype(np.float32)
                if np.any(mean!=0): img-=mean
                if var[0]!=1.0: img*=(1.0/var[0])
                img=np.ascontiguousarray(img.transpose(2,0,1))
                data=self.model.nn_inference(
                    [img], platform='ONNX', reorder='2 1 0',
                    output_tensor=3, output_format=output_format.OUT_FORMAT_FLOAT32
                )
                d0=data[2].reshape(1,LISTSIZE,GRID0,GRID0).transpose(2,3,0,1)
                d1=data[1].reshape(1,LISTSIZE,GRID1,GRID1).transpose(2,3,0,1)
                d2=data[0].reshape(1,LISTSIZE,GRID2,GRID2).transpose(2,3,0,1)
                result=post_process([d0,d1,d2], raw_thresh)
                final=None
                if result is not None:
                    boxes,scores,classes=result
                    boxes=unletterbox(boxes,scale,px,py,ow,oh)
                    final=(boxes,scores,classes)
                self.inf_times.append(time.time()-t0)
                while self.oq.qsize()>1:
                    try: self.oq.get_nowait()
                    except: pass
                self.oq.put(final)
            except Empty: pass
            except Exception: pass

    def submit(self, item):
        if not self.running: return
        while self.iq.qsize()>1:
            try: self.iq.get_nowait()
            except: pass
        try: self.iq.put_nowait(item)
        except: pass

    def get_result(self):
        try: return self.oq.get_nowait()
        except: return None

    def avg_ms(self):
        return float(np.mean(self.inf_times)*1000) if self.inf_times else 0.0

    def stop(self): self.running=False

# ─── Main ─────────────────────────────────────────────────────────────────────
if __name__ == '__main__':
    ap = argparse.ArgumentParser(description='Fire & Smoke Detector — Atomo Backend')

    # ── Args that match worker.js exactly ──────────────────────────────────────
    ap.add_argument('--library',   required=True)
    ap.add_argument('--model',     required=True)
    ap.add_argument('--type',      required=True, choices=['rtsp','video'])  # worker passes --type rtsp
    ap.add_argument('--device',    required=True)                            # worker passes --device <url>
    ap.add_argument('--conf',      type=float, default=0.35)
    ap.add_argument('--nms',       type=float, default=0.45)                 # worker passes --nms (accepted, unused — model uses its own)
    ap.add_argument('--transport', default='tcp', choices=['tcp','udp'])     # worker passes --transport tcp
    ap.add_argument('--jpeg-quality', type=int, default=75,
                    dest='jpeg_quality')                                     # worker passes --jpeg-quality
    ap.add_argument('--json-stream', action='store_true',
                    dest='json_stream')                                      # worker passes --json-stream  ← KEY FLAG

    # ── Capability flags (from detect.js capabilityDescriptions) ───────────────
    ap.add_argument('--enable-fire-detection',  action='store_true', dest='enable_fire')
    ap.add_argument('--enable-smoke-detection', action='store_true', dest='enable_smoke')

    # ── Extra options ───────────────────────────────────────────────────────────
    ap.add_argument('--level',       default='0', choices=['0','1','2'])
    ap.add_argument('--alert-count', type=int, default=5, dest='alert_count')
    ap.add_argument('--headless',    action='store_true')  # accepted, no-op (always headless in worker)
    ap.add_argument('--low-light',   action='store_true', dest='low_light')  # future CLAHE hook

    args = ap.parse_args()

    # If neither capability flag passed → enable both (backward compat)
    fire_enabled  = args.enable_fire  or (not args.enable_fire and not args.enable_smoke)
    smoke_enabled = args.enable_smoke or (not args.enable_fire and not args.enable_smoke)

    for fpath, label in [(args.model,'model'),(args.library,'library')]:
        if not os.path.exists(fpath):
            sys.exit(f'[ERROR] {label} not found: {fpath}')

    OBJ_THRESH = max(0.01, min(0.99, args.conf))
    RAW_THRESH = np.log(OBJ_THRESH / (1.0 - OBJ_THRESH))
    NMS_THRESH = max(0.01, min(0.99, args.nms))       # honour the flag
    level      = int(args.level) if args.level in ('1','2') else 0

    alert = AlertSystem(threshold=max(1, args.alert_count))

    # Startup JSON — worker ignores non-detection lines, but useful for debugging
    if args.json_stream:
        emit({
            'type': 'startup', 'model_id': 'mdl_fire',
            'fire_enabled': fire_enabled, 'smoke_enabled': smoke_enabled,
            'conf': OBJ_THRESH,
        })

    # ── Init NPU ────────────────────────────────────────────────────────────────
    npu = NPUWorker(args.library, args.model, level)
    if npu.start() is None:
        sys.exit('[ERROR] Failed to initialise NPU')

    # ── Connect stream ──────────────────────────────────────────────────────────
    # Honour --transport for RTSP (prepend options via OpenCV environment)
    source = args.device
    if args.transport == 'tcp':
        os.environ['OPENCV_FFMPEG_CAPTURE_OPTIONS'] = 'rtsp_transport;tcp'

    reader = FrameReader(source)
    if reader.start() is None:
        sys.exit('[ERROR] Failed to open source')

    for _ in range(500):
        f, _ = reader.get_frame()
        if f is not None: break
        time.sleep(0.02)
    else:
        sys.exit('[ERROR] Stream timeout')

    # ── Main loop ───────────────────────────────────────────────────────────────
    frame_count  = photos = 0
    batch_frames = 0
    batch_start  = time.time()
    fps_val      = 0.0
    start_time   = time.time()
    last_fid     = -1
    last_result  = None

    try:
        while reader.running:
            frame, fid = reader.get_frame()
            if frame is None or fid == last_fid:
                time.sleep(0.005); continue

            last_fid      = fid
            frame_count  += 1
            batch_frames += 1
            oh, ow = frame.shape[:2]

            if npu.iq.qsize() < 2:
                lb, scale, px, py = letterbox(frame)
                npu.submit((lb, scale, px, py, ow, oh, RAW_THRESH))

            res = npu.get_result()
            if res is not None:
                last_result = res

            inf_ms = npu.avg_ms()
            fire_det = smoke_det = False
            detections = []

            if last_result is not None:
                boxes, scores, classes = last_result
                for i in range(len(boxes)):
                    cid  = int(classes[i])
                    cname = CLASSES[cid].lower()
                    if cid == 1 and not fire_enabled:  continue
                    if cid == 0 and not smoke_enabled: continue
                    l,t,r,b = int(boxes[i,0]),int(boxes[i,1]),int(boxes[i,2]),int(boxes[i,3])
                    if r<=l or b<=t: continue
                    if cid==1: fire_det  = True
                    else:      smoke_det = True
                    detections.append({
                        'class':      cname,
                        'confidence': round(float(scores[i]),3),
                        'box':        [l,t,r,b],
                    })
                    color = FIRE_COLOR if cid==1 else SMOKE_COLOR
                    cv.rectangle(frame,(l,t),(r,b),color,2)
                    cv.putText(frame,f'{CLASSES[cid]} {scores[i]:.2f}',
                               (l,max(t-5,0)),cv.FONT_HERSHEY_SIMPLEX,0.45,color,1)

            alerts, photo_types = alert.update(fire_det, smoke_det)
            st = alert.status()

            # Photos
            for pt in photo_types:
                ts_str = time.strftime('%Y%m%d_%H%M%S')
                cnt    = st['fire_count'] if pt=='fire' else st['smoke_count']
                fname  = f'{DETECTION_DIR}/{pt}_{ts_str}_{cnt}.jpg'
                cv.imwrite(fname, frame)
                photos += 1

            # Batch FPS
            if batch_frames >= 30:
                fps_val      = 30.0 / max(time.time()-batch_start, 0.001)
                batch_start  = time.time()
                batch_frames = 0

            # ── JSON line to stdout (consumed by worker.js) ────────────────────
            if args.json_stream:
                jpeg_b64 = frame_to_jpeg_b64(frame, args.jpeg_quality) if detections else None
                payload = {
                    # ── Fields worker.js reads directly ──
                    'frame':        frame_count,
                    'fps':          round(fps_val, 1),
                    'inference_ms': round(inf_ms, 1),
                    'detections':   detections,
                    'jpeg':         jpeg_b64,           # base64 JPEG, None when no detection

                    # ── Fire-specific extras (available via /result endpoint) ──
                    'fire_detected':  fire_det,
                    'smoke_detected': smoke_det,
                    'fire_count':     st['fire_count'],
                    'smoke_count':    st['smoke_count'],
                    'fire_alert':     st['fire_alerted'],
                    'smoke_alert':    st['smoke_alerted'],
                    'fire_level':     st['fire_level'],
                    'smoke_level':    st['smoke_level'],
                    'photos_saved':   photos,
                    'alerts':         alerts,
                }
                emit(payload)

    except KeyboardInterrupt:
        pass
    finally:
        reader.stop(); npu.stop()
        elapsed = time.time() - start_time
        st = alert.status()
        if args.json_stream:
            emit({
                'type':        'summary',
                'frames':      frame_count,
                'elapsed_s':   round(elapsed,1),
                'avg_fps':     round(frame_count/max(elapsed,0.1),1),
                'fire_count':  st['fire_count'],
                'smoke_count': st['smoke_count'],
                'photos':      photos,
            })
