import sys
import subprocess
import numpy as np
import cv2 as cv

url = "rtsp://127.0.0.1:8554/cam_mrlp4z5ivpzu"
print(f"Reading frame from: {url}")

width = 960
height = 540
frame_size = width * height * 3

cmd = [
    'ffmpeg',
    '-rtsp_transport', 'tcp',
    '-i', url,
    '-vf', 'scale=960:540',
    '-f', 'image2pipe',
    '-pix_fmt', 'bgr24',
    '-vcodec', 'rawvideo',
    '-an',
    '-'
]

try:
    process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=frame_size * 2)
    print("Waiting for frame...")
    raw_data = process.stdout.read(frame_size)
    process.terminate()
    
    if len(raw_data) == frame_size:
        frame = np.frombuffer(raw_data, dtype=np.uint8).reshape((height, width, 3))
        # Save image
        cv.imwrite("debug_frame.png", frame)
        print("SUCCESS! Captured debug_frame.png.")
        print(f"Mean pixel brightness: {np.mean(frame):.2f} (0=black, 255=white)")
    else:
        print(f"FAILED! Expected {frame_size} bytes, read {len(raw_data)} bytes.")
        stderr_output = process.stderr.read().decode('utf-8', errors='ignore')
        print("FFmpeg stderr:")
        print(stderr_output)
except Exception as e:
    print("Error:", str(e))
