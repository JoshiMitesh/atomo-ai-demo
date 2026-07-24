import sys
import os
import time
import subprocess
import numpy as np

print("=" * 60)
print("FFMPEG SUBPROCESS PIPE DIAGNOSTIC SCRIPT")
print("=" * 60)
print("Python version:", sys.version)

try:
    import cv2 as cv
    print("OpenCV version:", cv.__version__)
    print("TIM-VX support:", hasattr(cv.dnn, 'DNN_BACKEND_TIMVX'))
except Exception as e:
    print("Failed to import cv2:", str(e))
    sys.exit(1)

# We will test reading from the direct camera stream using FFmpeg pipe
url = "rtsp://admin:admin12345@192.168.1.16:554/Streaming/Channels/101"
print(f"\nAttempting to connect to: {url} using FFmpeg pipe...")

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
    # Spawn FFmpeg
    process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=frame_size * 2)
    print("FFmpeg process spawned successfully. Reading first frame...")
    
    # Read first frame
    raw_data = process.stdout.read(frame_size)
    
    if len(raw_data) == frame_size:
        print("SUCCESS! Successfully read a raw frame from FFmpeg pipe.")
        frame = np.frombuffer(raw_data, dtype=np.uint8).reshape((height, width, 3))
        print("NumPy array shape:", frame.shape)
        
        # Test drawing a line on the frame using OpenCV (verifying OpenCV works on the array)
        cv.line(frame, (0, 270), (960, 270), (0, 255, 0), 2)
        print("SUCCESS! OpenCV successfully manipulated the raw numpy frame.")
    else:
        print(f"FAILED! Expected {frame_size} bytes, but read {len(raw_data)} bytes.")
        # Print stderr error from FFmpeg
        process.terminate()
        stderr_output = process.stderr.read(1000).decode('utf-8', errors='ignore')
        print("FFmpeg error output:")
        print(stderr_output)
        
except Exception as e:
    print("Error during test:", str(e))
print("=" * 60)
