import sys
import os
import queue
os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = "rtsp_transport;tcp"
import json
import time
import base64
import random
import threading
import subprocess
import cv2 as cv
# The edge device runs several camera workers at once.  One OpenCV thread per
# worker prevents its CPU pool from competing with the other active cameras.
cv.setNumThreads(1)
import numpy as np
from huggingface_hub import hf_hub_download

npu_lock = threading.Lock()

# Print to stderr for debugging so stdout remains clean JSON
def log(msg):
    sys.stderr.write(f"[Python Worker] {msg}\n")
    sys.stderr.flush()

# NPU / TIM-VX Configuration Constants
DNN_BACKEND_TIMVX = getattr(cv.dnn, 'DNN_BACKEND_TIMVX', 7)
DNN_TARGET_NPU = getattr(cv.dnn, 'DNN_TARGET_NPU', 9)

def configure_dnn_target(net):
    try:
        net.setPreferableBackend(DNN_BACKEND_TIMVX)
        net.setPreferableTarget(DNN_TARGET_NPU)
        log("ONNX model configured to use TIM-VX NPU.")
    except Exception as e:
        log(f"Failed to set TIM-VX NPU backend for ONNX model, using CPU fallback: {str(e)}")

class YuNet:
    def __init__(self, modelPath: str, confThreshold: float = 0.65, try_npu: bool = True):
        self.try_npu = try_npu
        # Default input size, will be set dynamically per frame
        self._model = None
        if try_npu:
            try:
                self._model = cv.FaceDetectorYN.create(
                    modelPath, "", (320, 320), confThreshold, 0.3, 5000,
                    DNN_BACKEND_TIMVX, DNN_TARGET_NPU
                )
                log("YuNet initialized successfully on TIM-VX NPU!")
            except Exception as e:
                log(f"Failed to load YuNet on TIM-VX NPU, falling back to CPU: {str(e)}")
                self._model = None
                
        if self._model is None:
            self._model = cv.FaceDetectorYN.create(
                modelPath, "", (320, 320), confThreshold, 0.3, 5000, 0, 0
            )

    def setInputSize(self, input_size):
        self._model.setInputSize(tuple(input_size))

    def infer(self, image):
        if self.try_npu:
            with npu_lock:
                faces = self._model.detect(image)
        else:
            faces = self._model.detect(image)
        return np.empty((0, 15), dtype=np.float32) if faces[1] is None else faces[1]

class SFace:
    def __init__(self, modelPath: str, disType: int = 0, try_npu: bool = False):
        self.try_npu = try_npu
        self._disType = disType  # 0 cosine, 1 norml2
        self._model = None
        if try_npu:
            try:
                self._model = cv.FaceRecognizerSF.create(
                    modelPath, "", DNN_BACKEND_TIMVX, DNN_TARGET_NPU
                )
                log("SFace initialized successfully on TIM-VX NPU!")
            except Exception as e:
                log(f"Failed to load SFace on TIM-VX NPU, falling back to CPU: {str(e)}")
                self._model = None
                
        if self._model is None:
            self._model = cv.FaceRecognizerSF.create(modelPath, "", 0, 0)

    def infer(self, image, face_bbox_landmarks_etc):
        try:
            if image is None or image.size == 0:
                return None
            if not np.isfinite(face_bbox_landmarks_etc).all():
                return None
            if self.try_npu:
                with npu_lock:
                    aligned = self._model.alignCrop(image, face_bbox_landmarks_etc.astype(np.float32))
                    if aligned is None or aligned.size == 0 or aligned.shape[0] == 0 or aligned.shape[1] == 0:
                        return None
                    feat = self._model.feature(aligned)
            else:
                aligned = self._model.alignCrop(image, face_bbox_landmarks_etc.astype(np.float32))
                if aligned is None or aligned.size == 0 or aligned.shape[0] == 0 or aligned.shape[1] == 0:
                    return None
                feat = self._model.feature(aligned)
                if feat is None or feat.size == 0:
                    return None
                return feat
        except Exception as e:
            log(f"Error in SFace.infer: {str(e)}")
            return None

    def score(self, feat1, feat2) -> float:
        if feat1 is None or feat2 is None:
            return 0.0
        try:
            return float(self._model.match(feat1, feat2, self._disType))
        except Exception as e:
            log(f"Error in SFace.score: {str(e)}")
            return 0.0

# Global variables for model paths and main thread instances
yunet_path = ""
sface_path = ""
detector = None
recog = None

candidates = []
candidates_lock = threading.Lock()

recognition_queue = queue.Queue()
recog_lock = threading.Lock()

# Multi-camera threads and stop events dictionaries
stream_threads = {}
stream_stop_events = {}
streams_lock = threading.Lock()
stream_line_configs = {}
stream_config_lock = threading.Lock()



def load_models():
    global detector, recog, yunet_path, sface_path
    log("Downloading models...")
    try:
        yunet_path = hf_hub_download("opencv/face_detection_yunet", "face_detection_yunet_2023mar_int8.onnx")
        sface_path = hf_hub_download("opencv/face_recognition_sface", "face_recognition_sface_2021dec_int8.onnx")
        log("Models downloaded successfully. Loading main thread instances...")
        detector = YuNet(yunet_path)
        recog = SFace(sface_path)
        log("Models loaded in memory.")
    except Exception as e:
        log(f"Error loading models: {str(e)}")
        sys.exit(1)





def extract_best_face_embedding(img_path, enforce_quality=True):
    img = cv.imread(img_path)
    if img is None:
        raise ValueError(f"Could not read image: {img_path}")
    
    cpu_detector = YuNet(yunet_path, try_npu=False)
    cpu_recog = SFace(sface_path, try_npu=False)
    
    cpu_detector.setInputSize((img.shape[1], img.shape[0]))
    faces = cpu_detector.infer(img)
    if faces.shape[0] == 0:
        return None
    
    # Get the largest face by bounding box area (w * h) to avoid enrolling background faces
    areas = faces[:, 2] * faces[:, 3]
    best_idx = np.argmax(areas)
    best_face = faces[best_idx]
    
    # Enforce quality checks for enrollment templates
    x, y, w, h = best_face[:4].astype(int)
    conf = best_face[-1]
    
    if enforce_quality:
        if conf < 0.60:
            raise ValueError(f"Face detection confidence is too low ({conf:.2f} < 0.60). Use a clearer photo.")
        if w < 50 or h < 50:
            raise ValueError(f"Face is too small ({w}x{h} < 50x50 pixels). Use a closer photo of the face.")
        
    feat = cpu_recog.infer(img, best_face[:-1])
    if feat is None:
        raise ValueError("Could not extract face embedding feature.")
    return feat.flatten().tolist()

def compare_face_features(feat, threshold, dis_type, thread_recog):
    with candidates_lock:
        local_candidates = list(candidates)
        
    if not local_candidates:
        return None, -1.0
        
    cand_scores = []
    for cand in local_candidates:
        cand_id = cand.get("person_id")
        cand_name = cand.get("name")
        embs = cand.get("embeddings", [])
        
        if not embs:
            continue
            
        scores = []
        for emb_list in embs:
            emb_arr = np.array(emb_list, dtype=np.float32).reshape(1, -1)
            score = thread_recog.score(feat, emb_arr)
            scores.append(score)
            
        # Sort scores: Cosine -> descending (highest first); L2 -> ascending (lowest first)
        scores.sort(reverse=(dis_type == 0))
        
        # Keep both the nearest template and consensus across the best few.
        # A single contaminated/outlier template must not identify a stranger.
        best_cand_score = scores[0]
        top_scores = scores[:min(3, len(scores))]
        consensus_score = float(sum(top_scores) / len(top_scores))
            
        cand_scores.append({
            "person_id": cand_id,
            "name": cand_name,
            "score": best_cand_score,
            "consensus_score": consensus_score,
            "scores": scores,
            "template_count": len(scores),
        })
        
    if not cand_scores:
        return None, -1.0
        
    # Sort candidates by score
    if dis_type == 0: # Cosine: higher score first
        cand_scores.sort(key=lambda x: x["score"], reverse=True)
    else: # L2: lower score first
        cand_scores.sort(key=lambda x: x["score"])
        
    best_cand = cand_scores[0]
    best_score = best_cand["score"]
    second_score = cand_scores[1]["score"] if len(cand_scores) > 1 else None
    
    is_match = False
    if dis_type == 0: # Cosine
        # Surveillance images need a stricter open-set threshold than clean
        # benchmark photos. Preserve the user's slider while enforcing a safe
        # floor; 64% becomes 0.61 rather than the previous permissive 0.456.
        slider_threshold = min(0.95, max(0.40, float(threshold)))
        effective_threshold = max(0.55, slider_threshold - 0.03)
        margin = best_score - second_score if second_score is not None else 1.0
        support_threshold = effective_threshold - 0.045
        support_count = sum(1 for score in best_cand["scores"] if score >= support_threshold)
        # A gallery with pose/lighting diversity must not make recognition
        # harder than a one-photo enrollment. Accept either two supporting
        # templates or one clearly strong nearest template.
        strong_single = best_score >= effective_threshold + 0.035
        enough_support = (
            best_cand["template_count"] < 3
            or support_count >= 2
            or strong_single
        )
        consensus_ok = (
            best_cand["template_count"] < 3
            or best_cand["consensus_score"] >= effective_threshold - 0.055
            or strong_single
        )
        # Require multiple enrolled photos to agree when a gallery is
        # available, plus separation from the next enrolled identity.
        is_match = (
            best_score >= effective_threshold
            and enough_support
            and consensus_ok
            and margin >= 0.035
        )
    else: # L2
        effective_threshold = threshold
        margin = second_score - best_score if second_score is not None else 1.0
        is_match = best_score <= threshold
                    
    if is_match:
        return {
            "person_id": best_cand["person_id"],
            "name": best_cand["name"],
            "margin": float(margin),
            "effective_threshold": float(effective_threshold),
            "consensus_score": float(best_cand.get("consensus_score", best_score)),
            "support_count": int(support_count if dis_type == 0 else 1),
        }, best_score
    else:
        return None, best_score


def _box_overlap(box_a, box_b):
    """Return (IoU, intersection / smaller-box area) for xywh boxes."""
    ax1, ay1, aw, ah = [float(v) for v in box_a[:4]]
    bx1, by1, bw, bh = [float(v) for v in box_b[:4]]
    ax2, ay2 = ax1 + max(0.0, aw), ay1 + max(0.0, ah)
    bx2, by2 = bx1 + max(0.0, bw), by1 + max(0.0, bh)

    inter_w = max(0.0, min(ax2, bx2) - max(ax1, bx1))
    inter_h = max(0.0, min(ay2, by2) - max(ay1, by1))
    intersection = inter_w * inter_h
    area_a = max(0.0, aw) * max(0.0, ah)
    area_b = max(0.0, bw) * max(0.0, bh)
    union = area_a + area_b - intersection
    smaller = min(area_a, area_b)

    iou = intersection / union if union > 0.0 else 0.0
    containment = intersection / smaller if smaller > 0.0 else 0.0
    return iou, containment


def deduplicate_faces(faces, iou_threshold=0.35, containment_threshold=0.75,
                      center_distance_factor=0.35):
    """Keep one high-confidence detection for each physical face."""
    if faces is None or len(faces) < 2:
        return faces

    order = sorted(range(len(faces)), key=lambda i: float(faces[i][-1]), reverse=True)
    kept = []
    for index in order:
        candidate = faces[index]
        duplicate = False
        for accepted in kept:
            iou, containment = _box_overlap(candidate[:4], accepted[:4])
            cx = float(candidate[0]) + float(candidate[2]) / 2.0
            cy = float(candidate[1]) + float(candidate[3]) / 2.0
            ax = float(accepted[0]) + float(accepted[2]) / 2.0
            ay = float(accepted[1]) + float(accepted[3]) / 2.0
            center_distance = np.hypot(cx - ax, cy - ay)
            max_face_size = max(
                float(candidate[2]), float(candidate[3]),
                float(accepted[2]), float(accepted[3]),
            )
            close_neighbors = (
                center_distance <= center_distance_factor * max_face_size
                and iou > 0.0
            )
            if (
                iou >= iou_threshold
                or containment >= containment_threshold
                or close_neighbors
            ):
                duplicate = True
                break
        if not duplicate:
            kept.append(candidate)

    return np.asarray(kept, dtype=faces.dtype)


def is_usable_live_face(frame, face, min_confidence=0.74):
    """Reject occluded, profile, blurry and non-face YuNet detections."""
    x, y, w, h = [float(v) for v in face[:4]]
    confidence = float(face[-1])
    if confidence < min_confidence or w < 18 or h < 18:
        return False
    aspect = w / max(h, 1.0)
    if aspect < 0.55 or aspect > 1.55:
        return False

    landmarks = np.asarray(face[4:14], dtype=np.float32).reshape(5, 2)
    right_eye, left_eye, nose, right_mouth, left_mouth = landmarks
    margin_x, margin_y = 0.18 * w, 0.18 * h
    for lx, ly in landmarks:
        if lx < x - margin_x or lx > x + w + margin_x:
            return False
        if ly < y - margin_y or ly > y + h + margin_y:
            return False

    eye_distance = abs(float(left_eye[0] - right_eye[0]))
    eye_y = float((left_eye[1] + right_eye[1]) / 2.0)
    mouth_y = float((left_mouth[1] + right_mouth[1]) / 2.0)
    if eye_distance < 0.10 * w or eye_distance > 0.82 * w:
        return False
    if abs(float(left_eye[1] - right_eye[1])) > 0.38 * h:
        return False
    if not (eye_y - 0.08 * h < float(nose[1]) < mouth_y + 0.08 * h):
        return False
    if mouth_y < eye_y + 0.08 * h:
        return False

    ih, iw = frame.shape[:2]
    x1, y1 = max(0, int(x)), max(0, int(y))
    x2, y2 = min(iw, int(x + w)), min(ih, int(y + h))
    if x2 <= x1 or y2 <= y1:
        return False
    crop = frame[y1:y2, x1:x2]
    gray = cv.cvtColor(crop, cv.COLOR_BGR2GRAY)
    if gray.size == 0 or cv.Laplacian(gray, cv.CV_64F).var() < 8.0:
        return False
    mean_light = float(gray.mean())
    return 10.0 <= mean_light <= 248.0


def crop_and_save_face(img, box, crops_dir):
    h_img, w_img = img.shape[:2]
    x, y, w, h = box.astype(int)
    
    # 60% margin padding to show clear face with surrounding head/shoulders context
    pad_w = int(w * 0.60)
    pad_h = int(h * 0.60)
    
    x1 = max(0, x - pad_w)
    y1 = max(0, y - pad_h)
    x2 = min(w_img, x + w + pad_w)
    y2 = min(h_img, y + h + pad_h)
    
    if x2 > x1 and y2 > y1:
        crop = img[y1:y2, x1:x2]
        
        # Upscale small crops to a minimum of 150x150 for consistent display quality
        crop_h, crop_w = crop.shape[:2]
        min_size = 150
        if crop_h < min_size or crop_w < min_size:
            scale_factor = max(min_size / crop_w, min_size / crop_h)
            new_w = int(crop_w * scale_factor)
            new_h = int(crop_h * scale_factor)
            crop = cv.resize(crop, (new_w, new_h), interpolation=cv.INTER_CUBIC)
        
        # Apply CLAHE (Contrast Limited Adaptive Histogram Equalization)
        # to enhance brightness and contrast for dark/distant camera crops
        try:
            lab = cv.cvtColor(crop, cv.COLOR_BGR2LAB)
            l, a, b = cv.split(lab)
            clahe = cv.createCLAHE(clipLimit=2.0, tileGridSize=(4, 4))
            l = clahe.apply(l)
            enhanced = cv.merge([l, a, b])
            crop = cv.cvtColor(enhanced, cv.COLOR_LAB2BGR)
        except Exception:
            pass  # If enhancement fails, save original crop
        
        crop_filename = f"crop_{int(time.time())}_{random.randint(1000, 9999)}.jpg"
        crop_path = os.path.join(crops_dir, crop_filename)
        cv.imwrite(crop_path, crop, [cv.IMWRITE_JPEG_QUALITY, 90])
        return crop_filename
    return None

def process_video_for_enrollment(video_path, crops_dir, person_id=None):
    import shutil
    
    # Create a unique temporary directory for frame images
    timestamp = int(time.time() * 1000)
    temp_frames_dir = os.path.join(os.path.dirname(video_path), f"temp_frames_{timestamp}")
    os.makedirs(temp_frames_dir, exist_ok=True)
    
    accepted_faces = []
    try:
        log(f"Extracting frames using system FFmpeg to {temp_frames_dir}...")
        # Extract 2 frames per second to get ~40 high-quality frames from a 20s scan
        cmd = [
            'ffmpeg',
            '-y',
            '-i', video_path,
            '-vf', 'fps=2',
            '-pix_fmt', 'yuv420p',
            os.path.join(temp_frames_dir, 'frame_%04d.jpg')
        ]
        subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
        
        # Read the extracted frame images
        frame_files = sorted([f for f in os.listdir(temp_frames_dir) if f.endswith('.jpg')])
        log(f"Extracted {len(frame_files)} frames. Running face detection on CPU...")
        
        cpu_detector = YuNet(yunet_path, try_npu=False)
        cpu_recog = SFace(sface_path, try_npu=False)
        
        # Set input size once before loop
        det_w = 640
        det_h = 480
        if len(frame_files) > 0:
            first_frame_path = os.path.join(temp_frames_dir, frame_files[0])
            first_frame = cv.imread(first_frame_path)
            if first_frame is not None:
                orig_h, orig_w = first_frame.shape[:2]
                det_h = int(orig_h * (det_w / orig_w))
                cpu_detector.setInputSize((det_w, det_h))
        
        for f_file in frame_files:
            f_path = os.path.join(temp_frames_dir, f_file)
            frame = cv.imread(f_path)
            if frame is None:
                continue
                
            orig_h, orig_w = frame.shape[:2]
            
            # Downscale frame for extremely fast CPU detection (takes ~25ms instead of 800ms)
            small_frame = cv.resize(frame, (det_w, det_h))
            faces = cpu_detector.infer(small_frame)
            
            if faces is not None and faces.shape[0] > 0:
                # Find the largest face bounding box
                areas = faces[:, 2] * faces[:, 3]
                best_idx = np.argmax(areas)
                best_face = faces[best_idx]
                
                # Scale coordinates back to original high-resolution size
                scale_x = orig_w / det_w
                scale_y = orig_h / det_h
                
                scaled_face = best_face.copy()
                scaled_face[0] = best_face[0] * scale_x
                scaled_face[1] = best_face[1] * scale_y
                scaled_face[2] = best_face[2] * scale_x
                scaled_face[3] = best_face[3] * scale_y
                
                # Scale landmarks
                for idx in range(5):
                    scaled_face[4 + idx*2] = best_face[4 + idx*2] * scale_x
                    scaled_face[4 + idx*2 + 1] = best_face[4 + idx*2 + 1] * scale_y
                
                w, h = scaled_face[2], scaled_face[3]
                conf = best_face[-1]
                
                # Minimum face size of 50x50 and detection confidence >= 0.60
                if conf >= 0.60 and w >= 50 and h >= 50:
                    # Run SFace on original high-resolution image using scaled landmarks
                    feat = cpu_recog.infer(frame, scaled_face[:-1])
                    if feat is not None:
                        # Crop and save from original high-resolution frame
                        crop_filename = crop_and_save_face(frame, scaled_face[:4], crops_dir)
                        if crop_filename:
                            embedding_list = feat.flatten().tolist()
                            
                            # Filter out duplicate/similar face angles (Cosine similarity >= 0.85)
                            # to keep the candidate list small, clean, and extremely fast to recognize.
                            is_unique = True
                            feat_arr = np.array(embedding_list, dtype=np.float32).reshape(1, -1)
                            for accepted in accepted_faces:
                                accepted_emb = np.array(accepted["embedding"], dtype=np.float32).reshape(1, -1)
                                sim = cpu_recog.score(feat_arr, accepted_emb)
                                if sim >= 0.85:
                                    is_unique = False
                                    break
                                    
                            if is_unique:
                                accepted_faces.append({
                                    "filename": crop_filename,
                                    "embedding": embedding_list
                                })
                                
                                # Emit real-time enrollment event
                                if person_id:
                                    sys.stdout.write(json.dumps({
                                        "event": "video_enroll_face",
                                        "person_id": person_id,
                                        "filename": crop_filename,
                                        "embedding": embedding_list
                                    }) + "\n")
                                    sys.stdout.flush()
                            
                        # Cap total enrollment count per video scan to 500 templates
                        if len(accepted_faces) >= 500:
                            break
                            
    except Exception as ex:
        log(f"Error extracting video frames: {str(ex)}")
        raise ex
    finally:
        # Clean up temporary frames directory
        try:
            shutil.rmtree(temp_frames_dir)
        except Exception as ec:
            log(f"Failed to remove temp directory {temp_frames_dir}: {str(ec)}")
            
    return accepted_faces

def process_single_image(img_path, threshold, dis_type, crops_dir):
    img = cv.imread(img_path)
    if img is None:
        raise ValueError(f"Could not read image: {img_path}")
        
    cpu_detector = YuNet(yunet_path, try_npu=False)
    cpu_recog = SFace(sface_path, disType=dis_type, try_npu=False)
    
    cpu_detector.setInputSize((img.shape[1], img.shape[0]))
    faces = cpu_detector.infer(img)
    
    results = []
    for f in faces:
        box = f[:4]
        conf = f[-1]
        
        is_known = False
        match = None
        score = 0.0
        feat = None
        
        # Only run SFace recognition on high-confidence face detections to prevent false matches
        if conf >= 0.80:
            feat = cpu_recog.infer(img, f[:-1])
            if feat is not None:
                match, score = compare_face_features(feat, threshold, dis_type, cpu_recog)
                is_known = match is not None
            
        crop_filename = crop_and_save_face(img, box, crops_dir)
        
        results.append({
            "box": box.astype(int).tolist(),
            "score": score,
            "match": match,
            "is_known": is_known,
            "crop_filename": crop_filename,
            "embedding": feat.flatten().tolist() if feat is not None else None
        })
        
    return results

class VideoGrabber(threading.Thread):
    def __init__(self, rtsp_url, camera_id, target_fps=2):
        super().__init__()
        self.rtsp_url = rtsp_url
        self.camera_id = camera_id
        self.target_fps = target_fps
        self.running = True
        self.latest_frame = None
        self.need_frame = True
        self.frame_lock = threading.Lock()
        self.frame_event = threading.Event()
        self.process = None
        self.daemon = True

    def run(self):
        log(f"[{self.camera_id}] Starting FFmpeg raw reader for RTSP...")
        
        # This is the *analysis* stream only; the browser continues to use the
        # original RTSP stream. The FFmpeg output size must exactly match
        # frame_size below; otherwise reads combine multiple smaller frames.
        # Preserve source detail for clear saved face crops. YuNet detection
        # is resized separately, so inference cost remains bounded.
        width = 1280
        height = 720
        frame_size = width * height * 3
        
        reconnect_delay = 1.0
        while self.running:
            try:
                cmd = [
                    'ffmpeg',
                    '-allowed_media_types', 'video', # Force video track only
                    '-rtsp_transport', 'tcp',
                    '-fflags', 'nobuffer',         # Disable input buffers
                    '-flags', 'low_delay',         # Force low latency flags
                    '-probesize', '100000',         # Minimal stream analysis probe
                    '-analyzeduration', '0',        # 0 analyze duration
                    '-threads', '1',              # Limit decoding threads to 1
                    # Keep I/P frames for motion tracking, but discard B-frames.
                    # Unlike keyframe-only decoding, this does not delay a
                    # line-crossing event until the next camera keyframe.
                    '-skip_frame', 'bidir',
                    '-skip_loop_filter', 'all',
                    '-i', self.rtsp_url,
                    '-vf', f'fps={self.target_fps},scale={width}:{height}:flags=fast_bilinear',
                    '-f', 'image2pipe',
                    '-pix_fmt', 'bgr24',
                    '-vcodec', 'rawvideo',
                    '-an',
                    '-'
                ]
                
                self.process = subprocess.Popen(
                    cmd,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.DEVNULL,
                    bufsize=frame_size * 2
                )
                
                log(f"[{self.camera_id}] FFmpeg subprocess pipe connected.")
                reconnect_delay = 1.0
                
                while self.running:
                    raw_data = self.process.stdout.read(frame_size)
                    if len(raw_data) < frame_size:
                        log(f"[{self.camera_id}] FFmpeg pipe EOF / connection dropped. Reconnecting...")
                        break
                        
                    if self.need_frame:
                        frame = np.frombuffer(raw_data, dtype=np.uint8).reshape((height, width, 3))
                        with self.frame_lock:
                            self.latest_frame = frame.copy()
                        self.frame_event.set()
                        self.need_frame = False
                        
                # Cleanup subprocess
                if self.process:
                    try:
                        self.process.stdout.close()
                    except:
                        pass
                    try:
                        self.process.terminate()
                        self.process.wait(timeout=1.0)
                    except:
                        try:
                            self.process.kill()
                        except:
                            pass
                    self.process = None
                    
            except Exception as e:
                log(f"[{self.camera_id}] Exception in VideoGrabber thread loop: {str(e)}")
                if self.process:
                    try: self.process.terminate()
                    except: pass
                    self.process = None
                time.sleep(reconnect_delay)
                reconnect_delay = min(reconnect_delay * 2, 10.0)

    def get_frame(self, timeout=0.2):
        got_new = self.frame_event.wait(timeout)
        if got_new:
            self.frame_event.clear()
            with self.frame_lock:
                frame = self.latest_frame
            self.need_frame = True
            return frame
        else:
            return None

    def stop(self):
        self.running = False
        if self.process:
            try:
                self.process.terminate()
            except:
                pass

def rtsp_stream_processor(camera_id, camera_name, rtsp_url, threshold, dis_type, crops_dir, 
                          line_crossing_enabled, line_y, line_direction, line_x_start, line_x_end, stop_event):
    log(f"[{camera_id}] Starting camera stream thread: {camera_name} (Line Crossing: {line_crossing_enabled}, Y: {line_y}, Dir: {line_direction}, X: {line_x_start}-{line_x_end})")
    
    # Separate thread-local models to prevent race conditions on inference
    thread_detector = YuNet(yunet_path)
    thread_recog = SFace(sface_path, disType=dis_type)
    

        

        
    # A crossing needs at least one face position on each side of the line.
    # Four line-analysis samples/sec reliably retain two people crossing
    # together while browser playback remains on its separate WHEP stream.
    grabber = VideoGrabber(rtsp_url, camera_id, target_fps=4 if line_crossing_enabled else 2)
    grabber.start()
    
    last_event_time = {}
    # Keep enough detail in tripwire mode to separate nearby/smaller faces.
    det_width = 480
    recent_events = []

    # Face tracking state (line-crossing mode)
    tracked_faces = []
    next_track_id = 0
    LINE_TRACK_STALE_S = 1.0  # longer than the 3-FPS interval, short enough to avoid track reuse

    # Face tracking state (standard mode) — lets a visible face keep the
    # same event_uuid across frames instead of being gated to one detection
    # every 3 seconds. Box position updates every frame (instant/continuous);
    # recognition is only re-queued periodically per-track to control SFace cost.
    std_tracked_faces = []
    next_std_track_id = 0
    STD_TRACK_MAX_DIST_FACTOR = 0.12   # fraction of frame width used as match radius
    STD_TRACK_STALE_S = 1.5            # survive missed frames at the 2-FPS analysis rate
    STD_RECOGNIZE_RETRY_S = 2.0        # re-attempt recognition for an unknown track this often
    FACE_DETECTION_MIN_CONF = 0.74

    last_frame_time = 0.0
    last_line_mode = bool(line_crossing_enabled)
    
    try:
        while not stop_event.is_set():
            frame = grabber.get_frame()
            if frame is None:
                time.sleep(0.05)
                continue
                
            now = time.time()
            dt = now - last_frame_time if last_frame_time > 0.0 else 0.2
            last_frame_time = now

            # Tripwire settings are hot-updated by update_line_config. Reading
            # them here avoids stopping FFmpeg or restarting face recognition.
            with stream_config_lock:
                live_line = dict(stream_line_configs.get(camera_id, {}))
            line_crossing_enabled = bool(live_line.get("enabled", line_crossing_enabled))
            line_y = float(live_line.get("line_y", line_y))
            line_direction = live_line.get("direction", line_direction)
            line_x_start = float(live_line.get("x_start", line_x_start))
            line_x_end = float(live_line.get("x_end", line_x_end))
            line_x1 = float(live_line.get("line_x1", line_x_start))
            line_y1 = float(live_line.get("line_y1", line_y))
            line_x2 = float(live_line.get("line_x2", line_x_end))
            line_y2 = float(live_line.get("line_y2", line_y))
            if line_crossing_enabled != last_line_mode:
                tracked_faces = []
                std_tracked_faces = []
                last_line_mode = line_crossing_enabled
            
            h_img, w_img = frame.shape[:2]
            
            # Optimization: Resize frame for YuNet face detection (reduces CPU by up to 90% for 1080p feeds)
            if w_img > det_width:
                scale = det_width / float(w_img)
                det_h = int(h_img * scale)
                det_frame = cv.resize(frame, (det_width, det_h))
            else:
                scale = 1.0
                det_frame = frame
                det_h, det_width = h_img, w_img
                
            thread_detector.setInputSize((det_width, det_h))
            faces = thread_detector.infer(det_frame)
            faces = deduplicate_faces(faces)
            
            detected_faces_data = []
            now = time.time()
            
            if line_crossing_enabled:
                # ---------------------------------------------------------
                # Line Crossing Face Detection & Tracking Mode
                # ---------------------------------------------------------
                current_tracked = []
                matched_ids = set()
                y_line = h_img * line_y
                x_start = w_img * line_x_start
                x_end = w_img * line_x_end
                segment_dx = line_x2 - line_x1
                segment_dy = line_y2 - line_y1
                segment_len_sq = max(segment_dx * segment_dx + segment_dy * segment_dy, 1e-8)
                segment_len = np.sqrt(segment_len_sq)
                
                for f in faces:
                    f_orig = f.copy()
                    if scale != 1.0:
                        f_orig[:14] = f_orig[:14] / scale
                        
                    box = f_orig[:4]
                    x, y, w, h = box.astype(int)
                    conf = f_orig[-1]
                    
                    if not is_usable_live_face(frame, f_orig, FACE_DETECTION_MIN_CONF):
                        continue
                        
                    cx = x + w / 2
                    cy = y + h / 2
                    ncx = cx / max(1.0, w_img)
                    ncy = cy / max(1.0, h_img)
                    # Signed perpendicular distance from the actual two-point
                    # tripwire. Positive is the below/"in" side for a line
                    # stored left-to-right.
                    line_side = (
                        segment_dx * (ncy - line_y1)
                        - segment_dy * (ncx - line_x1)
                    ) / segment_len
                    segment_t = (
                        (ncx - line_x1) * segment_dx
                        + (ncy - line_y1) * segment_dy
                    ) / segment_len_sq
                    
                    best_match = None
                    best_dist = float('inf')
                    # Scale search radius dynamically based on frame-step time (dt) to prevent track splits on slow hardware
                    base_max_dist = w_img * 0.08
                    max_dist = min(base_max_dist * (dt / 0.2), w_img * 0.20)
                    
                    for tf in tracked_faces:
                        if tf["id"] in matched_ids:
                            continue
                        # If a track has already crossed and exited the line, do not match it with a new face above the line
                        if tf["crossed"] and cy <= y_line:
                            continue
                        tx, ty = tf["last_center"]
                        # Prevent hijacking: if track is crossed, don't match with a face behind the track's movement direction
                        if tf["crossed"] and len(tf["ys"]) >= 2:
                            track_dir = tf["ys"][-1] - tf["ys"][0]
                            if track_dir > 0 and cy < ty: # Moving down, face is above track
                                continue
                            elif track_dir < 0 and cy > ty: # Moving up, face is below track
                                continue
                        dist = np.sqrt((cx - tx)**2 + (cy - ty)**2)
                        if dist < max_dist and dist < best_dist:
                            best_dist = dist
                            best_match = tf
                            
                    if best_match is not None:
                        matched_ids.add(best_match["id"])
                        prev_cy = best_match["last_center"][1]
                        best_match["last_bbox"] = [x, y, w, h]
                        best_match["last_center"] = (cx, cy)
                        best_match["last_seen"] = now
                        best_match["ys"].append(cy)
                        previous_sides = list(best_match.get("sides", []))
                        best_match.setdefault("sides", []).append(line_side)
                        if len(best_match["ys"]) > 10:
                            best_match["ys"].pop(0)
                        if len(best_match["sides"]) > 10:
                            best_match["sides"].pop(0)
                            
                        crossed_trigger = False
                        if not best_match["crossed"]:
                            # Evaluate the actual drawn segment instead of its
                            # old horizontal average. History survives one or
                            # two missed frames, which is important when nearby
                            # people partially occlude one another.
                            side_band = 0.012
                            prior = previous_sides or [best_match.get("initial_side", line_side)]
                            crossed_in = (
                                line_side >= side_band
                                and min(prior) <= -side_band
                            )
                            crossed_out = (
                                line_side <= -side_band
                                and max(prior) >= side_band
                            )
                            direction_ok = (
                                (line_direction == 'in' and crossed_in)
                                or (line_direction == 'out' and crossed_out)
                                or (line_direction == 'both' and (crossed_in or crossed_out))
                            )
                            # Allow a small endpoint tolerance equal to 5% of
                            # line length so a face centered on an endpoint is
                            # not lost due to detector jitter.
                            if direction_ok and -0.05 <= segment_t <= 1.05:
                                crossed_trigger = True
                                    
                        if crossed_trigger:
                            # Detection confidence was already quality-filtered above.
                            if conf >= FACE_DETECTION_MIN_CONF:
                                best_match["crossed"] = True
                                log(f"[{camera_id}] Track #{best_match['id']} crossed drawn segment in direction: {line_direction}")
                                
                                event_uuid = best_match["event_uuid"]
                                crop_filename = crop_and_save_face(frame, box, crops_dir)
                                
                                # Emit DETECT immediately!
                                sys.stdout.write(json.dumps({
                                    "event": "stream_detect",
                                    "camera_id": camera_id,
                                    "camera_name": camera_name,
                                    "event_uuid": event_uuid,
                                    "box": [int(x), int(y), int(w), int(h)],
                                    "crop_filename": crop_filename,
                                    "detection_score": float(conf)
                                }) + "\n")
                                sys.stdout.flush()
                                
                                # Queue recognition task to the background thread asynchronously
                                # Create a copy of the frame to prevent it from being modified by the next frame read
                                recognition_queue.put({
                                    "camera_id": camera_id,
                                    "camera_name": camera_name,
                                    "event_uuid": event_uuid,
                                    "frame": frame.copy(),
                                    "f_orig": f_orig.copy(),
                                    "crop_filename": crop_filename,
                                    "threshold": threshold,
                                    "dis_type": dis_type,
                                    "recog_model": thread_recog
                                })
                        current_tracked.append(best_match)
                    else:
                        new_tf = {
                            "id": next_track_id,
                            "event_uuid": f"{camera_id}_line_{next_track_id}_{int(now*1000)}",
                            "last_bbox": [x, y, w, h],
                            "last_center": (cx, cy),
                            "crossed": False,
                            "last_seen": now,
                            "ys": [cy],
                            "initial_y": cy,
                            "sides": [line_side],
                            "initial_side": line_side
                        }
                        next_track_id += 1
                        current_tracked.append(new_tf)
                        best_match = new_tf

                    # Tripwire controls event creation, not the live overlay.
                    # Publish the current tracked position on every analyzed
                    # frame so recognition never appears frozen while waiting
                    # for a crossing.
                    sys.stdout.write(json.dumps({
                        "event": "stream_box_update",
                        "camera_id": camera_id,
                        "camera_name": camera_name,
                        "event_uuid": best_match["event_uuid"],
                        "box": [int(x), int(y), int(w), int(h)]
                    }) + "\n")
                    sys.stdout.flush()
                        
                # Preserve tracks long enough to match the next reduced-FPS
                # analysis frame; otherwise every frame becomes a new face.
                for tf in tracked_faces:
                    if tf["id"] not in matched_ids:
                        if now - tf["last_seen"] < LINE_TRACK_STALE_S:
                            current_tracked.append(tf)
                            
                tracked_faces = current_tracked
            else:
                # ---------------------------------------------------------
                # Standard Mode (continuous per-track detection)
                # ---------------------------------------------------------
                # Each visible face keeps the same event_uuid/track across
                # frames (matched by centroid distance, same approach as the
                # line-crossing tracker). The box is emitted on every frame
                # so downstream consumers (e.g. GET /stream/boxes) always
                # reflect the current position instantly instead of only
                # every 3 seconds. Recognition (SFace) is comparatively
                # expensive, so it's only queued when a track first appears
                # and then re-queued periodically until it's confirmed known.
                current_std_tracked = []
                matched_std_ids = set()
                max_dist = w_img * STD_TRACK_MAX_DIST_FACTOR

                for f in faces:
                    f_orig = f.copy()
                    if scale != 1.0:
                        f_orig[:14] = f_orig[:14] / scale

                    box = f_orig[:4]
                    x, y, w, h = box.astype(int)
                    conf = f_orig[-1]

                    if not is_usable_live_face(frame, f_orig, FACE_DETECTION_MIN_CONF):
                        continue

                    cx = x + w / 2
                    cy = y + h / 2

                    best_match = None
                    best_dist = float('inf')
                    for tf in std_tracked_faces:
                        if tf["id"] in matched_std_ids:
                            continue
                        tx, ty = tf["last_center"]
                        dist = np.sqrt((cx - tx) ** 2 + (cy - ty) ** 2)
                        if dist < max_dist and dist < best_dist:
                            best_dist = dist
                            best_match = tf


                    if best_match is None:
                        # New face entering the frame — start a fresh track
                        event_uuid = f"{camera_id}_{int(now*1000)}_std{next_std_track_id}"
                        crop_filename = crop_and_save_face(frame, box, crops_dir)
                        best_match = {
                            "id": next_std_track_id,
                            "event_uuid": event_uuid,
                            "last_center": (cx, cy),
                            "last_seen": now,
                            "recognized": False,
                            "last_recognize_attempt": 0.0,
                            "detect_emitted": False,
                        }
                        next_std_track_id += 1

                    matched_std_ids.add(best_match["id"])
                    best_match["last_center"] = (cx, cy)
                    best_match["last_seen"] = now

                    # Emit stream_detect ONCE per track (when the face first appears)
                    # — not every frame. This matches the small backend behaviour of
                    # creating one event per unique face appearance.
                    if not best_match.get("detect_emitted"):
                        crop_filename = crop_and_save_face(frame, box, crops_dir)
                        best_match["detect_emitted"] = True
                        best_match["crop_filename"] = crop_filename

                        sys.stdout.write(json.dumps({
                            "event": "stream_detect",
                            "camera_id": camera_id,
                            "camera_name": camera_name,
                            "event_uuid": best_match["event_uuid"],
                            "box": [int(x), int(y), int(w), int(h)],
                            "crop_filename": crop_filename,
                            "detection_score": float(conf)
                        }) + "\n")
                        sys.stdout.flush()
                    else:
                        crop_filename = best_match.get("crop_filename")
                        # Box-only update (no new event, no new crop) — keeps UI overlay accurate
                        sys.stdout.write(json.dumps({
                            "event": "stream_box_update",
                            "camera_id": camera_id,
                            "event_uuid": best_match["event_uuid"],
                            "box": [int(x), int(y), int(w), int(h)]
                        }) + "\n")
                        sys.stdout.flush()

                    # Queue recognition when the track is new, or periodically
                    # retry while it's still unrecognized — stop re-queuing once known.
                    should_recognize = (
                        not best_match["recognized"]
                        and (now - best_match["last_recognize_attempt"]) >= STD_RECOGNIZE_RETRY_S
                    )
                    if should_recognize and crop_filename:
                        best_match["last_recognize_attempt"] = now
                        recognition_queue.put({
                            "camera_id": camera_id,
                            "camera_name": camera_name,
                            "event_uuid": best_match["event_uuid"],
                            "frame": frame.copy(),
                            "f_orig": f_orig.copy(),
                            "crop_filename": crop_filename,
                            "threshold": threshold,
                            "dis_type": dis_type,
                            "recog_model": thread_recog,
                            "std_track": best_match,
                        })

                    current_std_tracked.append(best_match)

                # Preserve unmatched tracks briefly to survive a missed frame or two
                for tf in std_tracked_faces:
                    if tf["id"] not in matched_std_ids and (now - tf["last_seen"]) < STD_TRACK_STALE_S:
                        current_std_tracked.append(tf)

                std_tracked_faces = current_std_tracked


            # Regulate thread loop rate adaptively to conserve CPU on ARM64 while preventing frame skips
            if len(tracked_faces) > 0 or len(std_tracked_faces) > 0:
                # High-speed tracking mode: sleep minimal time to capture every frame
                time.sleep(0.01)
            else:
                # Low-power standby mode: sleep 0.25s (~4 FPS) to save CPU when scene is empty
                time.sleep(0.25)
            
    except Exception as e:
        log(f"[{camera_id}] Error in processor loop: {str(e)}")
    finally:
        grabber.stop()
        log(f"[{camera_id}] Camera stream thread terminated.")

def recognition_worker_thread():
    while True:
        try:
            task = recognition_queue.get()
            if task is None:
                break
                
            camera_id = task["camera_id"]
            camera_name = task["camera_name"]
            event_uuid = task["event_uuid"]
            frame = task["frame"]
            f_orig = task["f_orig"]
            crop_filename = task["crop_filename"]
            threshold = task["threshold"]
            dis_type = task["dis_type"]
            recog_model = task["recog_model"]
            
            # Run SFace inference on the background thread
            feat = recog_model.infer(frame, f_orig[:-1])
            is_known = False
            match = None
            score = 0.0
            if feat is not None:
                match, score = compare_face_features(feat, threshold, dis_type, recog_model)
                is_known = match is not None

            # For standard-mode continuous tracks: stop re-queuing recognition
            # once a face is confirmed known (saves SFace calls); unknown faces
            # keep retrying every STD_RECOGNIZE_RETRY_S in case of a bad angle.
            std_track = task.get("std_track")
            if std_track is not None and is_known:
                std_track["recognized"] = True

            # Emit RECOGNIZE event immediately once SFace completes
            sys.stdout.write(json.dumps({
                "event": "stream_recognize",
                "camera_id": camera_id,
                "event_uuid": event_uuid,
                "score": score,
                "match": match,
                "is_known": is_known,
                "crop_filename": crop_filename,
                "embedding": feat.flatten().tolist() if feat is not None else None
            }) + "\n")
            sys.stdout.flush()
            
        except Exception as e:
            log(f"Error in recognition worker thread: {str(e)}")
        finally:
            recognition_queue.task_done()

def main():
    global candidates, stream_threads, stream_stop_events
    load_models()
    
    # Start background asynchronous recognition worker thread
    threading.Thread(target=recognition_worker_thread, daemon=True).start()
    
    sys.stdout.write(json.dumps({"event": "ready"}) + "\n")
    sys.stdout.flush()
    
    while True:
        try:
            line = sys.stdin.readline()
            if not line:
                break
                
            req = json.loads(line.strip())
            cmd = req.get("cmd")
            
            if cmd == "extract_embedding":
                img_path = req.get("img_path")
                enforce_quality = req.get("enforce_quality", True)
                try:
                    emb = extract_best_face_embedding(img_path, enforce_quality=enforce_quality)
                    if emb:
                        res = {"status": "success", "embedding": emb}
                    else:
                        res = {"status": "error", "message": "No face detected in image."}
                except Exception as e:
                    res = {"status": "error", "message": str(e)}
                sys.stdout.write(json.dumps({"cmd": "extract_embedding", "response": res}) + "\n")
                sys.stdout.flush()
                
            elif cmd == "process_video_enrollment":
                video_path = req.get("video_path")
                crops_dir = req.get("crops_dir")
                person_id = req.get("person_id")
                try:
                    faces = process_video_for_enrollment(video_path, crops_dir, person_id)
                    res = {"status": "success", "faces": faces}
                except Exception as e:
                    res = {"status": "error", "message": str(e)}
                sys.stdout.write(json.dumps({"cmd": "process_video_enrollment", "response": res}) + "\n")
                sys.stdout.flush()
                
            elif cmd == "recognize_image":
                img_path = req.get("img_path")
                local_candidates = req.get("candidates", [])
                threshold = req.get("threshold", 0.60)
                dis_type = req.get("dis_type", 0)
                crops_dir = req.get("crops_dir", ".")
                
                with candidates_lock:
                    candidates = local_candidates
                    
                try:
                    faces = process_single_image(img_path, threshold, dis_type, crops_dir)
                    res = {"status": "success", "faces": faces}
                except Exception as e:
                    res = {"status": "error", "message": str(e)}
                sys.stdout.write(json.dumps({"cmd": "recognize_image", "response": res}) + "\n")
                sys.stdout.flush()
                
            elif cmd == "start_stream":
                camera_id = req.get("camera_id")
                camera_name = req.get("camera_name", "Unnamed Camera")
                rtsp_url = req.get("rtsp_url")
                local_candidates = req.get("candidates", [])
                threshold = req.get("threshold", 0.60)
                dis_type = req.get("dis_type", 0)
                crops_dir = req.get("crops_dir", ".")
                line_crossing_enabled = req.get("line_crossing_enabled", False)
                line_y = req.get("line_y", 0.6)
                line_direction = req.get("line_direction", "in")
                line_x_start = req.get("line_x_start", 0.0)
                line_x_end = req.get("line_x_end", 1.0)
                line_x1 = req.get("line_x1", line_x_start)
                line_y1 = req.get("line_y1", line_y)
                line_x2 = req.get("line_x2", line_x_end)
                line_y2 = req.get("line_y2", line_y)
                
                with candidates_lock:
                    candidates = local_candidates

                with stream_config_lock:
                    stream_line_configs[camera_id] = {
                        "enabled": bool(line_crossing_enabled),
                        "line_y": float(line_y),
                        "direction": line_direction,
                        "x_start": float(line_x_start),
                        "x_end": float(line_x_end),
                        "line_x1": float(line_x1),
                        "line_y1": float(line_y1),
                        "line_x2": float(line_x2),
                        "line_y2": float(line_y2),
                    }
                
                with streams_lock:
                    # Stop stream if running
                    if camera_id in stream_threads:
                        log(f"Restarting camera {camera_id}...")
                        stream_stop_events[camera_id].set()
                        stream_threads[camera_id].join(timeout=2.0)
                        
                    stop_event = threading.Event()
                    stream_stop_events[camera_id] = stop_event
                    
                    thread = threading.Thread(
                        target=rtsp_stream_processor,
                        args=(camera_id, camera_name, rtsp_url, threshold, dis_type, crops_dir, 
                              line_crossing_enabled, line_y, line_direction, line_x_start, line_x_end, stop_event),
                        daemon=True
                    )
                    stream_threads[camera_id] = thread
                    thread.start()
                
                res = {"status": "success", "message": f"Camera stream thread {camera_id} started."}
                sys.stdout.write(json.dumps({"cmd": "start_stream", "camera_id": camera_id, "response": res}) + "\n")
                sys.stdout.flush()

            elif cmd == "update_line_config":
                camera_id = req.get("camera_id")
                with stream_config_lock:
                    stream_line_configs[camera_id] = {
                        "enabled": bool(req.get("enabled", False)),
                        "line_y": float(req.get("line_y", 0.6)),
                        "direction": req.get("direction", "in"),
                        "x_start": float(req.get("x_start", 0.0)),
                        "x_end": float(req.get("x_end", 1.0)),
                        "line_x1": float(req.get("line_x1", req.get("x_start", 0.0))),
                        "line_y1": float(req.get("line_y1", req.get("line_y", 0.6))),
                        "line_x2": float(req.get("line_x2", req.get("x_end", 1.0))),
                        "line_y2": float(req.get("line_y2", req.get("line_y", 0.6))),
                    }
                res = {
                    "status": "success",
                    "message": f"Line config for {camera_id} updated without restarting stream."
                }
                sys.stdout.write(json.dumps({
                    "cmd": "update_line_config",
                    "camera_id": camera_id,
                    "response": res
                }) + "\n")
                sys.stdout.flush()
                
            elif cmd == "stop_stream":
                camera_id = req.get("camera_id")
                
                with streams_lock:
                    if camera_id in stream_threads:
                        stream_stop_events[camera_id].set()
                        
                        # Join in background to not block the main reading thread
                        def cleanup_thread(cid):
                            if cid in stream_threads:
                                stream_threads[cid].join(timeout=2.0)
                                del stream_threads[cid]
                                if cid in stream_stop_events:
                                    del stream_stop_events[cid]
                                with stream_config_lock:
                                    stream_line_configs.pop(cid, None)
                        
                        threading.Thread(target=cleanup_thread, args=(camera_id,), daemon=True).start()
                        res = {"status": "success", "message": f"Camera {camera_id} stopped."}
                    else:
                        res = {"status": "success", "message": "Camera stream was not running."}
                        
                sys.stdout.write(json.dumps({"cmd": "stop_stream", "camera_id": camera_id, "response": res}) + "\n")
                sys.stdout.flush()
                
            elif cmd == "update_candidates":
                local_candidates = req.get("candidates", [])
                with candidates_lock:
                    candidates = local_candidates
                res = {"status": "success", "message": "Candidates synced across all stream threads."}
                sys.stdout.write(json.dumps({"cmd": "update_candidates", "response": res}) + "\n")
                sys.stdout.flush()
                
            elif cmd == "add_template":
                person_id = req.get("person_id")
                embedding = req.get("embedding")
                with candidates_lock:
                    found = False
                    for cand in candidates:
                        if cand.get("person_id") == person_id:
                            if "embeddings" not in cand:
                                cand["embeddings"] = []
                            cand["embeddings"].append(embedding)
                            found = True
                            break
                    if not found:
                        candidates.append({
                            "person_id": person_id,
                            "name": req.get("name", "Unknown"),
                            "embeddings": [embedding]
                        })
                res = {"status": "success", "message": "Embedding appended successfully."}
                sys.stdout.write(json.dumps({"cmd": "add_template", "response": res}) + "\n")
                sys.stdout.flush()
                
            else:
                res = {"status": "error", "message": f"Unknown command: {cmd}"}
                sys.stdout.write(json.dumps({"cmd": cmd, "response": res}) + "\n")
                sys.stdout.flush()
                
        except Exception as e:
            log(f"Error reading/processing command: {str(e)}")
            res = {"status": "error", "message": str(e)}
            sys.stdout.write(json.dumps({"response": res}) + "\n")
            sys.stdout.flush()

if __name__ == "__main__":
    main()
