import cv2 as cv
import numpy as np
import time
from huggingface_hub import hf_hub_download

print("Downloading yolov8n.onnx...")
try:
    model_path = hf_hub_download("webnn/yolov8n", "yolov8n.onnx")
    print("Model downloaded to:", model_path)
except Exception as e:
    print("Download failed:", e)
    import sys
    sys.exit(1)

# Load model
net = cv.dnn.readNetFromONNX(model_path)
net.setPreferableBackend(cv.dnn.DNN_BACKEND_OPENCV)
net.setPreferableTarget(cv.dnn.DNN_TARGET_CPU)

# Read test image (Lena)
img = cv.imread("lena.jpg")
if img is None:
    print("lena.jpg not found")
    import sys
    sys.exit(1)

h_img, w_img = img.shape[:2]

# Prepare blob at 320x320 for speed
t0 = time.time()
blob = cv.dnn.blobFromImage(img, 1.0/255.0, (320, 320), swapRB=True, crop=False)
net.setInput(blob)
outputs = net.forward()
dt = time.time() - t0
print(f"Inference time at 320x320: {dt*1000:.2f} ms")
print("Output shape:", outputs.shape)
