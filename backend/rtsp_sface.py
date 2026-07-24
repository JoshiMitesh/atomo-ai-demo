import argparse
import time
from urllib.parse import urlparse, parse_qsl, urlencode, urlunparse

import cv2 as cv
import numpy as np
from huggingface_hub import hf_hub_download


class YuNet:
    def __init__(
        self,
        modelPath: str,
        inputSize=(320, 320),
        confThreshold: float = 0.9,
        nmsThreshold: float = 0.3,
        topK: int = 5000,
        backendId: int = 0,
        targetId: int = 0,
    ):
        self._model = cv.FaceDetectorYN.create(
            modelPath, "", inputSize, confThreshold, nmsThreshold, topK, backendId, targetId
        )

    def setInputSize(self, input_size):
        self._model.setInputSize(tuple(input_size))

    def infer(self, image):
        faces = self._model.detect(image)
        return np.empty((0, 15), dtype=np.float32) if faces[1] is None else faces[1]


class SFace:
    def __init__(self, modelPath: str, disType: int = 0, backendId: int = 0, targetId: int = 0):
        self._model = cv.FaceRecognizerSF.create(modelPath, "", backendId, targetId)
        self._disType = disType  # 0 cosine, 1 norml2

    def infer(self, image, face_bbox_landmarks_etc):
        # FaceRecognizerSF.alignCrop expects (x,y,w,h, l0x,l0y,...,l4x,l4y)
        aligned = self._model.alignCrop(image, face_bbox_landmarks_etc.astype(np.float32))
        return self._model.feature(aligned)

    def score(self, feat1, feat2) -> float:
        return float(self._model.match(feat1, feat2, self._disType))


def best_face(detector: YuNet, img_bgr):
    detector.setInputSize((img_bgr.shape[1], img_bgr.shape[0]))
    faces = detector.infer(img_bgr)
    if faces.shape[0] == 0:
        return None
    return faces[np.argmax(faces[:, -1])]


def _ensure_rtsp_transport_tcp(rtsp_url: str) -> str:
    """
    OpenCV/FFmpeg sometimes honors 'rtsp_transport=tcp' when provided as a query param.
    If the URL already contains it, keep as-is.
    """
    try:
        parsed = urlparse(rtsp_url)
        q = dict(parse_qsl(parsed.query, keep_blank_values=True))
        if "rtsp_transport" not in q:
            q["rtsp_transport"] = "tcp"
            parsed = parsed._replace(query=urlencode(q, doseq=True))
            return urlunparse(parsed)
    except Exception:
        pass
    return rtsp_url


def open_capture(rtsp_url: str, force_tcp: bool) -> cv.VideoCapture:
    url = _ensure_rtsp_transport_tcp(rtsp_url) if force_tcp else rtsp_url
    cap = cv.VideoCapture(url, cv.CAP_FFMPEG)
    # Try to reduce latency; may be ignored depending on backend/build.
    cap.set(cv.CAP_PROP_BUFFERSIZE, 1)
    return cap


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--enroll", required=True, help="Path to an image of the target person")
    ap.add_argument("--rtsp", required=True, help='RTSP URL, e.g. "rtsp://user:pass@ip:554/stream"')
    ap.add_argument("--force_tcp", action="store_true", help="Append rtsp_transport=tcp to RTSP URL")
    ap.add_argument("--dis_type", type=int, default=0, choices=[0, 1], help="0 cosine, 1 norml2")
    ap.add_argument(
        "--threshold",
        type=float,
        default=None,
        help="Override threshold (cosine: higher is same, norml2: lower is same)",
    )
    ap.add_argument("--conf", type=float, default=0.9, help="YuNet confidence threshold")
    ap.add_argument("--max_reconnects", type=int, default=0, help="0 = infinite reconnect attempts")
    args = ap.parse_args()

    # Download models (cached after first run)
    yunet_path = hf_hub_download("opencv/face_detection_yunet", "face_detection_yunet_2023mar.onnx")
    sface_path = hf_hub_download("opencv/face_recognition_sface", "face_recognition_sface_2021dec.onnx")

    detector = YuNet(yunet_path, confThreshold=args.conf)
    recog = SFace(sface_path, disType=args.dis_type)

    # Enroll target embedding
    enroll_img = cv.imread(args.enroll)
    if enroll_img is None:
        raise SystemExit(f"Cannot read enroll image: {args.enroll}")
    enroll_face = best_face(detector, enroll_img)
    if enroll_face is None:
        raise SystemExit("No face found in enroll image.")
    enroll_feat = recog.infer(enroll_img, enroll_face[:-1])

    # Defaults used by OpenCV's SFace demo
    threshold = args.threshold
    if threshold is None:
        threshold = 0.363 if args.dis_type == 0 else 1.128

    reconnects = 0
    cap = open_capture(args.rtsp, args.force_tcp)

    while True:
        if not cap.isOpened():
            reconnects += 1
            if args.max_reconnects and reconnects > args.max_reconnects:
                raise SystemExit("RTSP reconnect limit reached. Exiting.")
            cap.release()
            time.sleep(1.0)
            cap = open_capture(args.rtsp, args.force_tcp)
            continue

        ok, frame = cap.read()
        if not ok or frame is None:
            cap.release()
            time.sleep(0.5)
            cap = open_capture(args.rtsp, args.force_tcp)
            continue

        detector.setInputSize((frame.shape[1], frame.shape[0]))
        faces = detector.infer(frame)

        for f in faces:
            x, y, w, h = f[:4].astype(int)
            x, y = max(0, x), max(0, y)
            cv.rectangle(frame, (x, y), (x + w, y + h), (255, 200, 0), 2)

            feat = recog.infer(frame, f[:-1])
            s = recog.score(enroll_feat, feat)

            if args.dis_type == 0:  # cosine: bigger = more similar
                is_same = s >= threshold
            else:  # norml2: smaller = more similar
                is_same = s <= threshold

            label = f"{'MATCH' if is_same else 'NO'} {s:.3f}"
            cv.putText(
                frame,
                label,
                (x, max(0, y - 8)),
                cv.FONT_HERSHEY_SIMPLEX,
                0.6,
                (0, 255, 0) if is_same else (0, 0, 255),
                2,
            )

        cv.imshow("SFace RTSP", frame)
        k = cv.waitKey(1) & 0xFF
        if k == 27 or k == ord("q"):
            break

    cap.release()
    cv.destroyAllWindows()


if __name__ == "__main__":
    # Requires opencv-contrib-python (FaceDetectorYN + FaceRecognizerSF)
    main()

