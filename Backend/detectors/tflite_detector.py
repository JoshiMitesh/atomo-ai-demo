#!/usr/bin/env python3
import argparse, sys, json, time, base64, re
import cv2
import numpy as np
try:
    from ai_edge_litert.interpreter import Interpreter as _Interpreter
    # wrap it so the rest of the code stays identical
    class tflite:
        Interpreter = _Interpreter
except ImportError:
    try:
        import tflite_runtime.interpreter as tflite
    except ImportError:
        try:
            import tensorflow.lite as tflite
        except ImportError:
            sys.exit(
                "[tflite_detector] ERROR: No TFLite runtime found.\n"
                "  Python 3.12+: pip install ai-edge-litert\n"
                "  Python <=3.11: pip install tflite-runtime"
            )

def load_classes(path):
    with open(path, 'r') as f:
        return [l.strip() for l in f if l.strip()]


def preprocess(frame, w, h, dtype):
    img = cv2.resize(frame, (w, h))
    img = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    img = np.expand_dims(img, axis=0)
    if dtype == np.float32:
        return img.astype(np.float32) / 255.0
    return img.astype(dtype)


def decode(interpreter, out_details, classes, conf, enabled_set):
    """
    Handles all common YOLO TFLite export layouts:

    Layout A — Post-processed (with NMS baked in):
      1 output:  float32 [1, 300, 6]   → [x1,y1,x2,y2, score, class_id]
      OR
      1 output:  float32 [1, 300, 85]  → [x1,y1,x2,y2, obj, cls0..cls79]

    Layout B — Raw YOLO (no NMS):
      1 output:  float32 [1, 84, 8400] → [cx,cy,w,h, cls0..cls79] per anchor
      OR transposed:
      1 output:  float32 [1, 8400, 84]

    Layout C — 4-tensor SSD:
      output[0]: boxes   [1,N,4]
      output[1]: classes [1,N]
      output[2]: scores  [1,N]
      output[3]: count   [1]
    """
    detections = []
    num_outputs = len(out_details)

    if num_outputs >= 4:
        # ── Layout C: SSD 4-tensor ──────────────────────────────────────────
        boxes   = interpreter.get_tensor(out_details[0]['index'])[0]
        labels  = interpreter.get_tensor(out_details[1]['index'])[0]
        scores  = interpreter.get_tensor(out_details[2]['index'])[0]
        count   = int(interpreter.get_tensor(out_details[3]['index'])[0])
        for i in range(min(count, len(scores))):
            score = float(scores[i])
            if score < conf:
                continue
            class_id = int(labels[i])
            label = classes[class_id] if class_id < len(classes) else str(class_id)
            if enabled_set and label not in enabled_set:
                continue
            ymin, xmin, ymax, xmax = boxes[i]
            detections.append({
                "class": label,
                "score": round(score, 4),
                "box":   [round(float(xmin),4), round(float(ymin),4),
                          round(float(xmax),4), round(float(ymax),4)],
            })

    elif num_outputs == 1:
        raw = interpreter.get_tensor(out_details[0]['index'])[0]  # strip batch dim
        shape = raw.shape  # now 2D

        if shape[-1] == 6:
            # ── Layout A1: post-processed [300, 6] → x1,y1,x2,y2,score,cls ──
            for row in raw:
                x1, y1, x2, y2, score, class_id = row
                score = float(score)
                if score < conf:
                    continue
                class_id = int(class_id)
                label = classes[class_id] if class_id < len(classes) else str(class_id)
                if enabled_set and label not in enabled_set:
                    continue
                detections.append({
                    "class": label,
                    "score": round(score, 4),
                    "box":   [round(float(x1),4), round(float(y1),4),
                              round(float(x2),4), round(float(y2),4)],
                })

        elif shape[0] == 4 + len(classes) or shape[1] == 4 + len(classes):
            # ── Layout B: raw YOLO [84, 8400] or [8400, 84] ─────────────────
            pred = raw if shape[1] == 4 + len(classes) else raw.T  # → [anchors, 84]
            boxes_raw    = pred[:, :4]
            class_scores = pred[:, 4:]
            # cx,cy,w,h → x1,y1,x2,y2
            cx, cy, w, h = boxes_raw[:,0], boxes_raw[:,1], boxes_raw[:,2], boxes_raw[:,3]
            boxes_xyxy = np.stack([cx-w/2, cy-h/2, cx+w/2, cy+h/2], axis=1)
            best_cls   = np.argmax(class_scores, axis=1)
            best_score = class_scores[np.arange(len(class_scores)), best_cls]
            # confidence filter + NMS
            mask = best_score >= conf
            kept_boxes  = boxes_xyxy[mask]
            kept_scores = best_score[mask]
            kept_cls    = best_cls[mask]
            kept_idx    = _nms(kept_boxes, kept_scores, 0.45)
            for i in kept_idx:
                class_id = int(kept_cls[i])
                label = classes[class_id] if class_id < len(classes) else str(class_id)
                if enabled_set and label not in enabled_set:
                    continue
                detections.append({
                    "class": label,
                    "score": round(float(kept_scores[i]), 4),
                    "box":   [round(float(v),4) for v in kept_boxes[i]],
                })

        else:
            # ── Layout A2: post-processed [N, 5+num_classes] ────────────────
            # [x1,y1,x2,y2, obj_conf, cls0..clsN]
            for row in raw:
                obj_conf = float(row[4])
                if obj_conf < conf:
                    continue
                class_scores = row[5:]
                class_id     = int(np.argmax(class_scores))
                score        = obj_conf * float(class_scores[class_id])
                if score < conf:
                    continue
                label = classes[class_id] if class_id < len(classes) else str(class_id)
                if enabled_set and label not in enabled_set:
                    continue
                detections.append({
                    "class": label,
                    "score": round(score, 4),
                    "box":   [round(float(row[0]),4), round(float(row[1]),4),
                              round(float(row[2]),4), round(float(row[3]),4)],
                })
    return detections


def _nms(boxes, scores, iou_threshold):
    if len(boxes) == 0:
        return []
    x1,y1,x2,y2 = boxes[:,0], boxes[:,1], boxes[:,2], boxes[:,3]
    areas = (x2-x1) * (y2-y1)
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
        order = order[1:][iou <= iou_threshold]
    return keep

def encode_jpeg(frame, quality=75):
    try:
        ok, buf = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, quality])
        if ok:
            return base64.b64encode(buf).decode('ascii')
    except Exception:
        pass
    return ''


def run(args):
    classes     = load_classes(args.classes)
    enabled_set = set(args.enable) if args.enable else None

    interpreter = tflite.Interpreter(model_path=args.model)
    interpreter.allocate_tensors()
    inp         = interpreter.get_input_details()[0]
    out_details = interpreter.get_output_details()
    _, ih, iw, _ = inp['shape']
    dtype       = inp['dtype']

    print(f"[tflite_detector] model  : {args.model}", file=sys.stderr)
    print(f"[tflite_detector] input  : {iw}x{ih} dtype={dtype.__name__}", file=sys.stderr)
    print(f"[tflite_detector] classes: {len(classes)} — {classes[:5]}...", file=sys.stderr)
    if enabled_set:
        print(f"[tflite_detector] active : {sorted(enabled_set)}", file=sys.stderr)

    cap = cv2.VideoCapture(args.rtsp)
    if not cap.isOpened():
        sys.exit(f"[tflite_detector] ERROR: cannot open {args.rtsp}")

    frame_interval = 1.0 / max(args.fps, 1)
    last_t = 0.0
    frame_n = 0
    fps_win = []

    while True:
        now = time.time()
        if now - last_t < frame_interval:
            time.sleep(0.005)
            continue

        ret, frame = cap.read()
        if not ret:
            time.sleep(0.1)
            continue

        last_t = time.time()
        frame_n += 1

        t0 = time.perf_counter()
        tensor = preprocess(frame, iw, ih, dtype)
        interpreter.set_tensor(inp['index'], tensor)
        interpreter.invoke()
        inference_ms = (time.perf_counter() - t0) * 1000

        detections = decode(interpreter, out_details, classes, args.conf, enabled_set)

        fps_win.append(time.time())
        if len(fps_win) > 10:
            fps_win.pop(0)
        fps = (len(fps_win)-1) / max(fps_win[-1]-fps_win[0], 1e-6) if len(fps_win) > 1 else 0.0

        jpeg = encode_jpeg(frame) if not args.headless else ''

        result = {
            "frame":        frame_n,
            "fps":          round(fps, 2),
            "inference_ms": round(inference_ms, 2),
            "detections":   detections,
            "jpeg":         jpeg,
        }
        # supports both --json-stream (worker.js) and --json-out (legacy)
        if args.json_stream or args.json_out:
            print(json.dumps(result), flush=True)

    cap.release()


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--model',       required=True)
    p.add_argument('--classes',     required=True)
    p.add_argument('--rtsp',        required=True)
    p.add_argument('--conf',        type=float, default=0.5)
    p.add_argument('--fps',         type=int,   default=5)
    p.add_argument('--headless',    action='store_true')
    p.add_argument('--json-stream', dest='json_stream', action='store_true')
    p.add_argument('--json-out',    dest='json_out',    action='store_true')
    p.add_argument('--enable',      action='append', default=[], metavar='CLASS')

    # normalise --enable-dog  →  --enable "dog"
    normalised = []
    for arg in sys.argv[1:]:
        m = re.match(r'^--enable-(.+)$', arg)
        if m:
            normalised += ['--enable', m.group(1).replace('-', ' ')]
        else:
            normalised.append(arg)

    args = p.parse_args(normalised)
    run(args)