#!/usr/bin/env python3
"""
onnx_detector.py — Custom ONNX model detector.
Outputs same JSON shape as person.py so worker.js needs zero changes.

Supports --json-stream (worker.js) and --json-out (legacy).
Supports --enable-<classname> flags from worker.js.
"""

import argparse, sys, json, time, base64, re
import cv2
import numpy as np

try:
    import onnxruntime as ort
except ImportError:
    sys.exit("[onnx_detector] ERROR: pip install onnxruntime")


# ── Helpers ───────────────────────────────────────────────────────────────────

def load_classes(path):
    with open(path, 'r') as f:
        return [l.strip() for l in f if l.strip()]


def preprocess(frame, w, h, is_float):
    img = cv2.resize(frame, (w, h))
    img = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    img = np.expand_dims(img, axis=0)            # NHWC
    img = np.transpose(img, (0, 3, 1, 2))        # NCHW
    return img.astype(np.float32) / 255.0 if is_float else img.astype(np.uint8)


def _nms(boxes, scores, iou_thr):
    if len(boxes) == 0:
        return []
    x1, y1, x2, y2 = boxes[:,0], boxes[:,1], boxes[:,2], boxes[:,3]
    areas = (x2 - x1) * (y2 - y1)
    order = scores.argsort()[::-1]
    keep  = []
    while order.size > 0:
        i = order[0]; keep.append(i)
        xx1 = np.maximum(x1[i], x1[order[1:]])
        yy1 = np.maximum(y1[i], y1[order[1:]])
        xx2 = np.minimum(x2[i], x2[order[1:]])
        yy2 = np.minimum(y2[i], y2[order[1:]])
        inter = np.maximum(0, xx2-xx1) * np.maximum(0, yy2-yy1)
        iou   = inter / (areas[i] + areas[order[1:]] - inter + 1e-6)
        order = order[1:][iou <= iou_thr]
    return keep


def decode(outputs, classes, conf, nms_thr, enabled_set):
    """
    Handles all common YOLO ONNX export layouts:

    Layout A — post-processed [1, N, 6]:  x1,y1,x2,y2, score, class_id
    Layout B — raw YOLO      [1, 84, 8400] or [1, 8400, 84]
    Layout C — SSD 3-tensor  boxes[N,4], scores[N], labels[N]
    Layout D — classification [1, num_classes]
    """
    detections = []
    num_out = len(outputs)

    if num_out >= 3:
        # ── Layout C: SSD ───────────────────────────────────────────────────
        boxes  = outputs[0][0] if outputs[0].ndim == 3 else outputs[0]
        scores = outputs[1][0] if outputs[1].ndim == 2 else outputs[1]
        labels = outputs[2][0] if outputs[2].ndim == 2 else outputs[2]
        for i in range(len(scores)):
            score = float(scores[i])
            if score < conf: continue
            class_id = int(labels[i])
            label = classes[class_id] if class_id < len(classes) else str(class_id)
            if enabled_set and label not in enabled_set: continue
            detections.append({
                "class": label, "score": round(score, 4),
                "box": [round(float(v), 4) for v in boxes[i]],
            })
        return detections

    # Single output tensor
    raw   = outputs[0]
    shape = raw.shape  # e.g. (1, 84, 8400) or (1, 8400, 84) or (1, N, 6)

    # Remove batch dim → 2D
    pred = raw[0] if raw.ndim == 3 else raw

    nc = len(classes)

    if pred.shape[-1] == 6:
        # ── Layout A: post-processed [N, 6] ────────────────────────────────
        for row in pred:
            x1, y1, x2, y2, score, class_id = row
            score = float(score)
            if score < conf: continue
            class_id = int(class_id)
            label = classes[class_id] if class_id < len(classes) else str(class_id)
            if enabled_set and label not in enabled_set: continue
            detections.append({
                "class": label, "score": round(score, 4),
                "box": [round(float(x1),4), round(float(y1),4),
                        round(float(x2),4), round(float(y2),4)],
            })

    elif pred.shape[0] == 4 + nc or pred.shape[1] == 4 + nc:
        # ── Layout B: raw YOLO [4+nc, anchors] or [anchors, 4+nc] ──────────
        if pred.shape[1] == 4 + nc:
            pred = pred  # already [anchors, 4+nc]
        else:
            pred = pred.T  # transpose to [anchors, 4+nc]

        boxes_raw    = pred[:, :4]
        class_scores = pred[:, 4:]
        cx, cy, w, h = boxes_raw[:,0], boxes_raw[:,1], boxes_raw[:,2], boxes_raw[:,3]
        boxes_xyxy   = np.stack([cx-w/2, cy-h/2, cx+w/2, cy+h/2], axis=1)
        best_cls     = np.argmax(class_scores, axis=1)
        best_score   = class_scores[np.arange(len(class_scores)), best_cls]

        mask         = best_score >= conf
        kept_boxes   = boxes_xyxy[mask]
        kept_scores  = best_score[mask]
        kept_cls     = best_cls[mask]

        for i in _nms(kept_boxes, kept_scores, nms_thr):
            class_id = int(kept_cls[i])
            label = classes[class_id] if class_id < len(classes) else str(class_id)
            if enabled_set and label not in enabled_set: continue
            detections.append({
                "class": label, "score": round(float(kept_scores[i]), 4),
                "box": [round(float(v), 4) for v in kept_boxes[i]],
            })

    else:
        # ── Layout D: classification [num_classes] ──────────────────────────
        scores_arr = pred if pred.ndim == 1 else pred[0]
        top_i  = int(np.argmax(scores_arr))
        score  = float(scores_arr[top_i])
        if score >= conf:
            label = classes[top_i] if top_i < len(classes) else str(top_i)
            if not enabled_set or label in enabled_set:
                detections.append({"class": label, "score": round(score,4), "box": []})

    return detections


def encode_jpeg(frame, quality=75):
    try:
        ok, buf = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, quality])
        if ok:
            return base64.b64encode(buf).decode('ascii')
    except Exception:
        pass
    return ''


# ── Main ─────────────────────────────────────────────────────────────────────

def run(args):
    classes     = load_classes(args.classes)
    enabled_set = set(args.enable) if args.enable else None

    sess_opts = ort.SessionOptions()
    sess_opts.log_severity_level = 3
    sess = ort.InferenceSession(
        args.model,
        sess_options=sess_opts,
        providers=['CPUExecutionProvider']
    )

    inp_meta  = sess.get_inputs()[0]
    out_names = [o.name for o in sess.get_outputs()]
    shape     = inp_meta.shape
    input_h   = int(shape[2]) if isinstance(shape[2], int) else 640
    input_w   = int(shape[3]) if isinstance(shape[3], int) else 640
    is_float  = 'float' in inp_meta.type.lower()

    print(f"[onnx_detector] model  : {args.model}", file=sys.stderr)
    print(f"[onnx_detector] input  : {input_w}x{input_h}  type={inp_meta.type}", file=sys.stderr)
    print(f"[onnx_detector] outputs: {out_names}", file=sys.stderr)
    print(f"[onnx_detector] classes: {len(classes)} — {classes[:5]}...", file=sys.stderr)
    if enabled_set:
        print(f"[onnx_detector] active : {sorted(enabled_set)}", file=sys.stderr)

    cap = cv2.VideoCapture(args.rtsp)
    if not cap.isOpened():
        sys.exit(f"[onnx_detector] ERROR: cannot open {args.rtsp}")

    frame_interval = 1.0 / max(args.fps, 1)
    last_t   = 0.0
    frame_n  = 0
    fps_win  = []

    while True:
        now = time.time()
        if now - last_t < frame_interval:
            time.sleep(0.005)
            continue

        ret, frame = cap.read()
        if not ret:
            time.sleep(0.1)
            continue

        last_t  = time.time()
        frame_n += 1

        t0      = time.perf_counter()
        tensor  = preprocess(frame, input_w, input_h, is_float)
        outputs = sess.run(out_names, {inp_meta.name: tensor})
        inference_ms = (time.perf_counter() - t0) * 1000

        detections = decode(outputs, classes, args.conf, args.nms, enabled_set)

        fps_win.append(time.time())
        if len(fps_win) > 10: fps_win.pop(0)
        fps = (len(fps_win)-1) / max(fps_win[-1]-fps_win[0], 1e-6) if len(fps_win) > 1 else 0.0

        jpeg = encode_jpeg(frame) if not args.headless else ''

        result = {
            "frame":        frame_n,
            "fps":          round(fps, 2),
            "inference_ms": round(inference_ms, 2),
            "detections":   detections,
            "jpeg":         jpeg,
        }
        if args.json_stream or args.json_out:
            print(json.dumps(result), flush=True)

    cap.release()


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--model',       required=True)
    p.add_argument('--classes',     required=True)
    p.add_argument('--rtsp',        required=True)
    p.add_argument('--conf',        type=float, default=0.5)
    p.add_argument('--nms',         type=float, default=0.45)
    p.add_argument('--fps',         type=int,   default=5)
    p.add_argument('--headless',    action='store_true')
    p.add_argument('--json-stream', dest='json_stream', action='store_true')
    p.add_argument('--json-out',    dest='json_out',    action='store_true')
    p.add_argument('--enable',      action='append', default=[], metavar='CLASS')

    # Normalise --enable-dog → --enable "dog"
    normalised = []
    for arg in sys.argv[1:]:
        m = re.match(r'^--enable-(.+)$', arg)
        if m:
            normalised += ['--enable', m.group(1).replace('-', ' ')]
        else:
            normalised.append(arg)

    args = p.parse_args(normalised)
    run(args)