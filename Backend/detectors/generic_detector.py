#!/usr/bin/env python3
"""
generic_detector.py — adapted for custom crowd model (multi-scale YOLO-style)
"""
from __future__ import annotations
import argparse
import json
import os
import sys
import time
import threading
os.environ["PYTHONUNBUFFERED"] = "1"
import cv2 as cv
import numpy as np
from asnn.api import asnn
from asnn.types import output_format

# ── Model-specific constants for crowd.nb ───────────────────────────────
GRID_SIZES = [20, 40, 80]
LISTSIZE = 65
NUM_CLS = 1
SPAN = 1
OBJ_THRESH = 0.4
NMS_THRESH = 0.5
LETTERBOX_PAD = 114
INV_255 = 1.0 / 255.0

constant_matrix = np.array([[0, 1, 2, 3, 4, 5, 6, 7,
                             8, 9, 10, 11, 12, 13, 14, 15]]).T

CLASSES = ["crowd"]   # Will be overridden by --classes from data.yaml

def log(msg: str) -> None:
    sys.stderr.write(f"[generic_detector] {msg}\n")
    sys.stderr.flush()

def sigmoid(x: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-np.clip(x, -50.0, 50.0)))

def softmax(x, axis=0):
    x = np.exp(x)
    return x / x.sum(axis=axis, keepdims=True)

# ── Letterbox (kept from template) ─────────────────────────────────────
def letterbox(rgb: np.ndarray, size: int):
    h, w = rgb.shape[:2]
    r = min(size / w, size / h)
    nw, nh = max(1, int(round(w * r))), max(1, int(round(h * r)))
    resized = cv.resize(rgb, (nw, nh), interpolation=cv.INTER_LINEAR)
    pad_x, pad_y = (size - nw) // 2, (size - nh) // 2
    out = np.full((size, size, 3), LETTERBOX_PAD, dtype=np.uint8)
    out[pad_y:pad_y + nh, pad_x:pad_x + nw] = resized
    return out, r, pad_x, pad_y, w, h

def map_box_to_frame(box, ratio, pad_x, pad_y, img_size, orig_w, orig_h):
    x1, y1, x2, y2 = box
    x1 = (x1 * img_size - pad_x) / ratio / orig_w
    y1 = (y1 * img_size - pad_y) / ratio / orig_h
    x2 = (x2 * img_size - pad_x) / ratio / orig_w
    y2 = (y2 * img_size - pad_y) / ratio / orig_h
    return [float(np.clip(x1, 0, 1)), float(np.clip(y1, 0, 1)),
            float(np.clip(x2, 0, 1)), float(np.clip(y2, 0, 1))]

# ── Multi-scale post-processing (from your reference) ───────────────────
def process(input_data):
    grid_h, grid_w = map(int, input_data.shape[0:2])
    box_class_probs = sigmoid(input_data[..., :NUM_CLS])

    box_0 = softmax(input_data[..., NUM_CLS:NUM_CLS+16], -1)
    box_1 = softmax(input_data[..., NUM_CLS+16:NUM_CLS+32], -1)
    box_2 = softmax(input_data[..., NUM_CLS+32:NUM_CLS+48], -1)
    box_3 = softmax(input_data[..., NUM_CLS+48:NUM_CLS+64], -1)

    result = np.zeros((grid_h, grid_w, 1, 4))
    result[..., 0] = np.dot(box_0, constant_matrix)[..., 0]
    result[..., 1] = np.dot(box_1, constant_matrix)[..., 0]
    result[..., 2] = np.dot(box_2, constant_matrix)[..., 0]
    result[..., 3] = np.dot(box_3, constant_matrix)[..., 0]

    col = np.tile(np.arange(0, grid_w), grid_w).reshape(-1, grid_w)
    row = np.tile(np.arange(0, grid_h).reshape(-1, 1), grid_h)
    col = col.reshape(grid_h, grid_w, 1, 1)
    row = row.reshape(grid_h, grid_w, 1, 1)
    grid = np.concatenate((col, row), axis=-1)

    result[..., 0:2] = (0.5 - result[..., 0:2] + grid) / (grid_w, grid_h)
    result[..., 2:4] = (0.5 + result[..., 2:4] + grid) / (grid_w, grid_h)

    return result, box_class_probs

def filter_boxes(boxes, box_class_probs, conf_thresh):
    box_classes = np.argmax(box_class_probs, axis=-1)
    box_class_scores = np.max(box_class_probs, axis=-1)
    pos = np.where(box_class_scores >= conf_thresh)
    boxes = boxes[pos]
    classes = box_classes[pos]
    scores = box_class_scores[pos]
    return boxes, classes, scores

def nms_boxes(boxes, scores, iou_thresh):
    if len(boxes) == 0:
        return np.array([], dtype=np.int64)
    x1 = boxes[:, 0]
    y1 = boxes[:, 1]
    x2 = boxes[:, 2]
    y2 = boxes[:, 3]
    areas = (x2 - x1) * (y2 - y1)
    order = scores.argsort()[::-1]
    keep = []
    while order.size > 0:
        i = order[0]
        keep.append(i)
        if len(order) == 1:
            break
        xx1 = np.maximum(x1[i], x1[order[1:]])
        yy1 = np.maximum(y1[i], y1[order[1:]])
        xx2 = np.minimum(x2[i], x2[order[1:]])
        yy2 = np.minimum(y2[i], y2[order[1:]])
        w1 = np.maximum(0.0, xx2 - xx1 + 1e-5)
        h1 = np.maximum(0.0, yy2 - yy1 + 1e-5)
        inter = w1 * h1
        ovr = inter / (areas[i] + areas[order[1:]] - inter + 1e-6)
        inds = np.where(ovr <= iou_thresh)[0]
        order = order[inds + 1]
    return np.array(keep, dtype=np.int64)

def yolov3_post_process(input_data, conf_thresh, nms_thresh):
    boxes_list, classes_list, scores_list = [], [], []
    for inp in input_data:
        result, confidence = process(inp)
        b, c, s = filter_boxes(result, confidence, conf_thresh)
        boxes_list.append(b)
        classes_list.append(c)
        scores_list.append(s)

    boxes = np.concatenate(boxes_list) if boxes_list else np.empty((0, 4))
    classes = np.concatenate(classes_list) if classes_list else np.empty((0,))
    scores = np.concatenate(scores_list) if scores_list else np.empty((0,))

    if len(boxes) == 0:
        return np.empty((0, 4)), np.empty(0, np.int64), np.empty(0, np.float32)

    nboxes, nclasses, nscores = [], [], []
    for c in np.unique(classes):
        inds = np.where(classes == c)[0]
        b = boxes[inds]
        s = scores[inds]
        keep = nms_boxes(b, s, nms_thresh)
        if len(keep) > 0:
            nboxes.append(b[keep])
            nclasses.append(classes[inds][keep])
            nscores.append(s[keep])

    if not nboxes:
        return np.empty((0, 4)), np.empty(0, np.int64), np.empty(0, np.float32)

    return np.concatenate(nboxes), np.concatenate(nclasses), np.concatenate(nscores)

# ── Capture & FPS (unchanged) ───────────────────────────────────────────
class LatestFrameReader:
    def __init__(self, url: str, transport: str = "tcp"):
        self.url = url
        self.transport = transport
        self._lock = threading.Lock()
        self._frame = None
        self._ok = False
        self._stamp = 0
        self._stop = threading.Event()
        self._cap = None
        self._thread = None

    def _open(self):
        os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = (
            f"rtsp_transport;{self.transport}|fflags;nobuffer|flags;low_delay|max_delay;0"
        )
        cap = cv.VideoCapture(self.url, cv.CAP_FFMPEG)
        cap.set(cv.CAP_PROP_BUFFERSIZE, 1)
        return cap

    def start(self) -> bool:
        self._cap = self._open()
        if not self._cap.isOpened():
            return False
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()
        return True

    def _loop(self):
        while not self._stop.is_set():
            if self._cap is None or not self._cap.isOpened():
                time.sleep(0.5)
                self._cap = self._open()
                continue
            ret, frame = self._cap.read()
            if not ret:
                time.sleep(0.2)
                self._cap.release()
                self._cap = self._open()
                continue
            with self._lock:
                self._frame = frame
                self._ok = True
                self._stamp += 1

    def get_copy(self):
        with self._lock:
            if not self._ok or self._frame is None:
                return False, None, 0
            return True, self._frame.copy(), self._stamp

    def stop(self):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2.0)
        if self._cap:
            self._cap.release()

class FpsMeter:
    def __init__(self, interval=0.5):
        self.interval, self.count, self.fps, self.t0 = interval, 0, 0.0, time.perf_counter()
    def tick(self):
        self.count += 1
        elapsed = time.perf_counter() - self.t0
        if elapsed >= self.interval:
            self.fps = self.count / elapsed
            self.count = 0
            self.t0 = time.perf_counter()
        return self.fps

# ── Main ────────────────────────────────────────────────────────────────
def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--library", required=True)
    p.add_argument("--model", required=True)
    p.add_argument("--classes", required=True)
    p.add_argument("--type", default="rtsp")
    p.add_argument("--device", required=True)
    p.add_argument("--conf", type=float, default=0.4)
    p.add_argument("--nms", type=float, default=0.5)
    p.add_argument("--imgsz", type=int, default=640)
    p.add_argument("--transport", default="tcp", choices=["tcp", "udp"])
    p.add_argument("--json-stream", action="store_true")
    p.add_argument("--jpeg-quality", type=int, default=75)
    p.add_argument("--headless", action="store_true")
    return p.parse_known_args()

def main():
    args, unknown = parse_args()
    class_names = json.loads(args.classes)
    num_classes = len(class_names)

    enabled_classes = set()
    for u in unknown:
        if u.startswith("--enable-"):
            cls = u[len("--enable-"):].replace("-", "_")
            enabled_classes.add(cls)
    if not enabled_classes:
        enabled_classes = set(c.replace(" ", "_") for c in class_names)

    log(f"Classes: {class_names}")
    log(f"Enabled: {sorted(enabled_classes)}")

    net = asnn("Electron")
    net.nn_init(library=args.library, model=args.model, level=0)
    log("Neural network initialized.")

    reader = LatestFrameReader(args.device, args.transport)
    if not reader.start():
        sys.exit(f"cannot open stream: {args.device}")

    cam_fps_m = FpsMeter()
    npu_fps_m = FpsMeter()
    last_stamp = -1
    frame_idx = 0

    try:
        while True:
            ok, frame, stamp = reader.get_copy()
            if not ok or frame is None:
                time.sleep(0.005)
                continue

            if stamp != last_stamp:
                cam_fps_m.tick()
                last_stamp = stamp

            rgb = cv.cvtColor(frame, cv.COLOR_BGR2RGB)
            lettered, ratio, pad_x, pad_y, orig_w, orig_h = letterbox(rgb, args.imgsz)

            # Preprocessing matching reference (mean=0, /255)
            tensor = lettered.astype(np.float32).transpose(2, 0, 1)   # CHW
            tensor = (tensor - 0.0) / 255.0
            tensor = tensor[None, ...]   # add batch

            t0 = time.perf_counter()

            outputs = net.nn_inference(
                [tensor],
                platform="ONNX",
                reorder="2 1 0",
                output_tensor=3,                    # 3 heads
                output_format=output_format.OUT_FORMAT_FLOAT32,
            )

            # Reshape the 3 outputs
            input_data = []
            for i, gs in enumerate(GRID_SIZES):
                tensor = np.asarray(outputs[2 - i], dtype=np.float32)   # often reversed
                tensor = tensor.reshape(SPAN, LISTSIZE, gs, gs)
                input_data.append(np.transpose(tensor, (2, 3, 0, 1)))

            boxes, class_ids, scores = yolov3_post_process(input_data, args.conf, args.nms)

            inference_ms = (time.perf_counter() - t0) * 1000.0
            npu_fps_m.tick()

            detections = []
            for box, cid, score in zip(boxes, class_ids, scores):
                cls_name = class_names[int(cid)] if int(cid) < len(class_names) else str(cid)
                cls_key = cls_name.replace(" ", "_")
                if cls_key not in enabled_classes:
                    continue
                mapped = map_box_to_frame(box, ratio, pad_x, pad_y, args.imgsz, orig_w, orig_h)
                detections.append({
                    "class": cls_name,
                    "class_id": int(cid),
                    "score": float(score),
                    "box": mapped,
                })

            payload = {
                "frame": frame_idx,
                "fps": round(cam_fps_m.fps, 1),
                "inference_ms": round(inference_ms, 1),
                "detections": detections,
            }
            print(json.dumps(payload), flush=True)
            frame_idx += 1

    except KeyboardInterrupt:
        pass
    finally:
        reader.stop()

if __name__ == "__main__":
    main()
