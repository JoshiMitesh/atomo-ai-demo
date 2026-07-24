import sys
import os
import shutil
import numpy as np

print("=" * 60)
print("TIM-VX NPU VS CPU INFERENCE DIAGNOSTIC SCRIPT")
print("=" * 60)

try:
    import cv2 as cv
    print("OpenCV version:", cv.__version__)
except Exception as e:
    print("Failed to import cv2:", str(e))
    sys.exit(1)

# Look for a test face image in local directories
dst_image = "test_face.png"
found_img = None
search_paths = ["data/uploads", "data/crops", "data", "."]
for sp in search_paths:
    if os.path.exists(sp):
        for root, dirs, files in os.walk(sp):
            for f in files:
                if f.lower().endswith(('.png', '.jpg', '.jpeg')) and f != dst_image:
                    found_img = os.path.join(root, f)
                    break
            if found_img: break
    if found_img: break

if found_img:
    shutil.copyfile(found_img, dst_image)
    print(f"Using local image for test: {found_img}")
else:
    # Fallback to check if artifact directory is accessible
    src_image = "/home/mitesh/.gemini/antigravity/brain/38d72edc-6b84-4f96-ba64-9206bb8908b0/media__1784021817673.png"
    if os.path.exists(src_image):
        shutil.copyfile(src_image, dst_image)
        print("Copied test face image from artifacts.")
    else:
        print("FAILED to find any local or artifact face images for testing.")
        sys.exit(1)

# Load test image
img = cv.imread(dst_image)
if img is None:
    print("Failed to read test_face.png")
    sys.exit(1)
print(f"Loaded test_face.png of shape: {img.shape}")

# Model paths (download if not present)
from huggingface_hub import hf_hub_download
yunet_path = hf_hub_download("opencv/face_detection_yunet", "face_detection_yunet_2023mar.onnx")
sface_path = hf_hub_download("opencv/face_recognition_sface", "face_recognition_sface_2021dec.onnx")

DNN_BACKEND_TIMVX = getattr(cv.dnn, 'DNN_BACKEND_TIMVX', 7)
DNN_TARGET_NPU = getattr(cv.dnn, 'DNN_TARGET_NPU', 9)

# -------------------------------------------------------------
# 1. TEST YUNET FACE DETECTION
# -------------------------------------------------------------
print("\n" + "-" * 50)
print("1. TESTING YUNET FACE DETECTION")
print("-" * 50)

# CPU Detection
detector_cpu = cv.FaceDetectorYN.create(yunet_path, "", (img.shape[1], img.shape[0]), 0.5, 0.3, 5000, 0, 0)
faces_cpu = detector_cpu.detect(img)
faces_cpu_arr = faces_cpu[1]
print("CPU Detection Result:")
if faces_cpu_arr is None or faces_cpu_arr.shape[0] == 0:
    print("-> No faces detected on CPU.")
else:
    for idx, face in enumerate(faces_cpu_arr):
        print(f"-> Face #{idx+1}: Box={face[:4].astype(int)}, Conf={face[-1]:.3f}")

# NPU Detection
try:
    detector_npu = cv.FaceDetectorYN.create(yunet_path, "", (img.shape[1], img.shape[0]), 0.5, 0.3, 5000, DNN_BACKEND_TIMVX, DNN_TARGET_NPU)
    faces_npu = detector_npu.detect(img)
    faces_npu_arr = faces_npu[1]
    print("\nNPU Detection Result:")
    if faces_npu_arr is None or faces_npu_arr.shape[0] == 0:
        print("-> No faces detected on NPU.")
    else:
        for idx, face in enumerate(faces_npu_arr):
            print(f"-> Face #{idx+1}: Box={face[:4].astype(int)}, Conf={face[-1]:.3f}")
except Exception as e:
    print(f"NPU Detection failed with exception: {str(e)}")

# -------------------------------------------------------------
# 2. TEST SFACE FACE RECOGNITION
# -------------------------------------------------------------
print("\n" + "-" * 50)
print("2. TESTING SFACE FACE RECOGNITION")
print("-" * 50)

if faces_cpu_arr is not None and faces_cpu_arr.shape[0] > 0:
    face_coords = faces_cpu_arr[0]
    
    # CPU Recognition
    recog_cpu = cv.FaceRecognizerSF.create(sface_path, "", 0, 0)
    aligned_cpu = recog_cpu.alignCrop(img, face_coords[:-1].astype(np.float32))
    feat_cpu = recog_cpu.feature(aligned_cpu)
    print("CPU Feature extraction: SUCCESS" if feat_cpu is not None else "CPU Feature extraction: FAILED")
    
    # NPU Recognition
    try:
        recog_npu = cv.FaceRecognizerSF.create(sface_path, "", DNN_BACKEND_TIMVX, DNN_TARGET_NPU)
        aligned_npu = recog_npu.alignCrop(img, face_coords[:-1].astype(np.float32))
        feat_npu = recog_npu.feature(aligned_npu)
        print("NPU Feature extraction: SUCCESS" if feat_npu is not None else "NPU Feature extraction: FAILED")
        
        if feat_cpu is not None and feat_npu is not None:
            # Compare embeddings
            diff = np.linalg.norm(feat_cpu - feat_npu)
            print(f"L2 distance between CPU and NPU embeddings: {diff:.6f}")
    except Exception as e:
        print(f"NPU Recognition failed with exception: {str(e)}")
else:
    print("Skipping SFace test because no faces were detected by CPU.")
print("=" * 60)
