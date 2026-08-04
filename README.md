# Atomo AI – Face Recognition and Video Analytics Platform

Atomo AI is a real-time face recognition and video analytics platform for camera monitoring, person detection, face recognition, unknown-person clustering, event management, and alert configuration.

The system processes live RTSP camera streams, detects people and faces, compares detected faces with enrolled identities, groups unknown faces into clusters, and displays all results through a web dashboard.

---

## Main Features

* User registration and login
* Role-based access control
* Camera registration and management
* RTSP camera stream support
* Live camera viewing
* Real-time person detection
* Real-time face detection
* Face recognition using YuNet and SFace
* Enrolled-person management
* Face embedding generation and storage
* Unknown-person detection
* Automatic unknown-face clustering
* Cluster review and person enrollment
* Detection event history
* Event images and recognition details
* Camera stream logs
* Live system metrics
* Alert configuration
* Device registration
* User role management
* Cluster role management
* MediaMTX-based stream handling

---

## Project Structure

```text
atomo-ai-fronend-backend/
├── README.md
└── face_recognition/
    ├── package.json
    ├── server.js
    ├── db.js
    ├── face_worker.py
    ├── mediamtx
    ├── mediamtx.yml
    ├── public/
    ├── data/
    ├── uploads/
    └── crops/
```

---

## System Requirements

Recommended operating system:

* Ubuntu 22.04
* Ubuntu 24.04

Required software:

* Git
* Node.js 18 or newer
* npm
* Python 3
* Python virtual environment
* FFmpeg
* FFprobe
* MediaMTX
* Internet connection during first startup for downloading face detection and recognition models

---

# Installation

## 1. Clone the Repository

```bash
git clone -b final_demo https://github.com/Atomo-innovation/atomo-ai-fronend-backend.git
```

Open the project directory:

```bash
cd atomo-ai-fronend-backend/face_recognition
```

---

## 2. Install Required Ubuntu Packages

```bash
sudo apt update
```

```bash
sudo apt install -y \
git \
curl \
ffmpeg \
python3 \
python3-pip \
python3-venv \
build-essential \
libgl1 \
libglib2.0-0
```

Verify FFmpeg installation:

```bash
ffmpeg -version
```

Verify FFprobe installation:

```bash
ffprobe -version
```

---

## 3. Install Node.js

Node.js 20 is recommended.

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
```

```bash
sudo apt install -y nodejs
```

Verify Node.js:

```bash
node --version
```

Verify npm:

```bash
npm --version
```

The Node.js version should be 18 or newer.

---

## 4. Install Node.js Dependencies

Make sure you are inside the `face_recognition` directory:

```bash
cd atomo-ai-fronend-backend/face_recognition
```

Install dependencies:

```bash
npm install
```

The backend uses:

* Express
* WebSocket
* CORS
* Multer
* dotenv

---

## 5. Create Python Virtual Environment

```bash
python3 -m venv venv
```

Activate the virtual environment:

```bash
source venv/bin/activate
```

Upgrade pip:

```bash
python -m pip install --upgrade pip setuptools wheel
```

---

## 6. Install Python Dependencies

```bash
pip install numpy opencv-python-headless huggingface-hub
```

Verify the Python dependencies:

```bash
python -c "import cv2, numpy, huggingface_hub; print('Python dependencies installed successfully')"
```

Every time you open a new terminal, activate the environment again:

```bash
cd atomo-ai-fronend-backend/face_recognition
source venv/bin/activate
```

---

## 7. Prepare MediaMTX

The MediaMTX executable should be available inside:

```text
face_recognition/mediamtx
```

Give execution permission:

```bash
chmod +x mediamtx
```

Verify MediaMTX:

```bash
./mediamtx --version
```

The included MediaMTX binary must match your system architecture.

For example:

* Linux x86-64 requires an amd64 binary
* ARM64 requires an arm64 binary
* ARM32 requires an armv7 binary

---

## 8. Create Runtime Directories

```bash
mkdir -p data uploads crops
```

Give the current user permission:

```bash
chmod -R u+rwX data uploads crops
```

---

# Run the Application

## Start the Application

Open the project directory:

```bash
cd atomo-ai-fronend-backend/face_recognition
```

Activate the Python environment:

```bash
source venv/bin/activate
```

Start the application:

```bash
npm start
```

You can also use:

```bash
npm run dev
```

The application will start on:

```text
http://localhost:3000
```

Open this URL in your browser:

```text
http://localhost:3000
```

---

## Open the Application from Another Computer

Find the server IP address:

```bash
hostname -I
```

Example output:

```text
192.168.1.100
```

Open the application from another computer using:

```text
http://192.168.1.100:3000
```

Replace `192.168.1.100` with the actual IP address of the server.

---

# Complete Installation Command

You can use the following commands for a fresh Ubuntu installation:

```bash
git clone -b final_demo https://github.com/Atomo-innovation/atomo-ai-fronend-backend.git

cd atomo-ai-fronend-backend/face_recognition

sudo apt update

sudo apt install -y \
git \
curl \
ffmpeg \
python3 \
python3-pip \
python3-venv \
build-essential \
libgl1 \
libglib2.0-0

curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -

sudo apt install -y nodejs

npm install

python3 -m venv venv

source venv/bin/activate

python -m pip install --upgrade pip setuptools wheel

pip install numpy opencv-python-headless huggingface-hub

chmod +x mediamtx

mkdir -p data uploads crops

chmod -R u+rwX data uploads crops

npm start
```

---

# Daily Run Command

After installation, use these commands whenever you want to start the project:

```bash
cd atomo-ai-fronend-backend/face_recognition
```

```bash
source venv/bin/activate
```

```bash
npm start
```

Or run everything in one command:

```bash
cd atomo-ai-fronend-backend/face_recognition && source venv/bin/activate && npm start
```

---

# Run in Background Using PM2

PM2 can keep the application running after closing the terminal.

## Install PM2

```bash
sudo npm install -g pm2
```

## Start the Application with PM2

```bash
cd atomo-ai-fronend-backend/face_recognition
```

```bash
source venv/bin/activate
```

```bash
pm2 start npm --name atomo-ai -- start
```

## Check Application Status

```bash
pm2 status
```

## View Application Logs

```bash
pm2 logs atomo-ai
```

## Restart the Application

```bash
pm2 restart atomo-ai
```

## Stop the Application

```bash
pm2 stop atomo-ai
```

## Remove the Application from PM2

```bash
pm2 delete atomo-ai
```

---

## Enable Automatic Startup

Save the PM2 process:

```bash
pm2 save
```

Generate the startup command:

```bash
pm2 startup
```

PM2 will display a command beginning with `sudo`.

Copy and run that command.

Then save the PM2 configuration again:

```bash
pm2 save
```

The application will now start automatically after system reboot.

---

# Database Reset

The project includes a database reset command.

Warning: this command may delete application data, uploaded files, stored events, enrolled persons, and generated runtime files.

Run:

```bash
cd atomo-ai-fronend-backend/face_recognition
```

```bash
npm run reset-db
```

---

# Camera Configuration

The application supports RTSP cameras.

The common RTSP URL format is:

```text
rtsp://USERNAME:PASSWORD@CAMERA_IP:554/STREAM_PATH
```

Example:

```text
rtsp://admin:password@192.168.1.116:554/stream1
```

Add the full RTSP URL through the camera management page.

The camera and server should be connected to the same network.

---

## Test RTSP Camera Using FFprobe

```bash
ffprobe \
-v error \
-rtsp_transport tcp \
-select_streams v:0 \
-show_entries stream=codec_name,width,height \
-of default=noprint_wrappers=1 \
"rtsp://USERNAME:PASSWORD@CAMERA_IP:554/STREAM_PATH"
```

Example:

```bash
ffprobe \
-v error \
-rtsp_transport tcp \
-select_streams v:0 \
-show_entries stream=codec_name,width,height \
-of default=noprint_wrappers=1 \
"rtsp://admin:password@192.168.1.116:554/stream1"
```

---

## Test RTSP Camera Using FFmpeg

```bash
ffmpeg \
-hide_banner \
-loglevel warning \
-rtsp_transport tcp \
-i "rtsp://USERNAME:PASSWORD@CAMERA_IP:554/STREAM_PATH" \
-t 10 \
-an \
-f null -
```

If the stream is working, FFmpeg will process the video for 10 seconds.

---

# Application Ports

The application commonly uses the following ports:

|       Port | Purpose                             |
| ---------: | ----------------------------------- |
|     `3000` | Atomo AI web application and API    |
|     `8554` | MediaMTX RTSP server                |
|     `8888` | MediaMTX HLS server                 |
|     `8889` | MediaMTX WebRTC or WHEP HTTP server |
| `8189/UDP` | MediaMTX WebRTC media               |

---

## Allow Ports Through Ubuntu Firewall

```bash
sudo ufw allow 3000/tcp
```

```bash
sudo ufw allow 8554/tcp
```

```bash
sudo ufw allow 8888/tcp
```

```bash
sudo ufw allow 8889/tcp
```

Check firewall status:

```bash
sudo ufw status
```

---

# Troubleshooting

## MediaMTX Permission Denied

Error:

```text
Permission denied
```

Fix:

```bash
chmod +x mediamtx
```

Then restart:

```bash
npm start
```

---

## MediaMTX Port Already in Use

Check port `8554`:

```bash
sudo lsof -i :8554
```

Check port `8888`:

```bash
sudo lsof -i :8888
```

Check port `8889`:

```bash
sudo lsof -i :8889
```

Stop the existing MediaMTX process:

```bash
pkill -f mediamtx
```

Then restart the project:

```bash
npm start
```

---

## Port 3000 Already in Use

Check which process is using port `3000`:

```bash
sudo lsof -i :3000
```

Stop the process using its PID:

```bash
sudo kill -9 PID
```

Replace `PID` with the actual process ID.

You can also run the project on another port:

```bash
PORT=3001 npm start
```

Then open:

```text
http://localhost:3001
```

---

## Python Module Not Found

Activate the virtual environment:

```bash
source venv/bin/activate
```

Install the required modules:

```bash
pip install numpy opencv-python-headless huggingface-hub
```

---

## OpenCV Shared Library Error

Install the required libraries:

```bash
sudo apt install -y libgl1 libglib2.0-0
```

Then test OpenCV:

```bash
python -c "import cv2; print(cv2.__version__)"
```

---

## Face Models Are Not Downloading

The Python worker downloads YuNet and SFace models from Hugging Face during the first startup.

Check internet connectivity:

```bash
ping -c 4 huggingface.co
```

Check DNS:

```bash
ping -c 4 google.com
```

Restart the application after internet connectivity is available:

```bash
npm start
```

---

## RTSP Camera Is Not Connecting

Check whether the camera is reachable:

```bash
ping CAMERA_IP
```

Example:

```bash
ping 192.168.1.116
```

Check the following:

* Camera IP address
* RTSP username
* RTSP password
* RTSP stream path
* Camera and server network connection
* Firewall settings
* Camera RTSP option is enabled
* Correct camera codec
* Correct RTSP port

Test the camera directly using FFmpeg:

```bash
ffmpeg \
-hide_banner \
-loglevel warning \
-rtsp_transport tcp \
-i "rtsp://USERNAME:PASSWORD@CAMERA_IP:554/STREAM_PATH" \
-t 10 \
-an \
-f null -
```

---

## Node.js Dependencies Error

Remove the existing dependencies:

```bash
rm -rf node_modules package-lock.json
```

Install them again:

```bash
npm install
```

Then start:

```bash
npm start
```

---

## View Running Processes

Check Node.js:

```bash
ps aux | grep node
```

Check MediaMTX:

```bash
ps aux | grep mediamtx
```

Check Python worker:

```bash
ps aux | grep face_worker
```

Check FFmpeg:

```bash
ps aux | grep ffmpeg
```

---

## Stop All Project Processes

Stop Node.js:

```bash
pkill -f "node server.js"
```

Stop MediaMTX:

```bash
pkill -f mediamtx
```

Stop Python worker:

```bash
pkill -f face_worker.py
```

Stop FFmpeg:

```bash
pkill -f ffmpeg
```

---

# Update the Project

Open the repository:

```bash
cd atomo-ai-fronend-backend
```

Switch to the `final_demo` branch:

```bash
git checkout final_demo
```

Pull the latest code:

```bash
git pull origin final_demo
```

Open the application directory:

```bash
cd face_recognition
```

Install updated Node.js dependencies:

```bash
npm install
```

Activate the Python environment:

```bash
source venv/bin/activate
```

Update Python packages:

```bash
pip install --upgrade numpy opencv-python-headless huggingface-hub
```

Restart the application:

```bash
npm start
```

For PM2:

```bash
pm2 restart atomo-ai
```

---

# Stop the Application

When running directly in the terminal, press:

```text
Ctrl + C
```

When running through PM2:

```bash
pm2 stop atomo-ai
```

---

# Quick Commands

## Start

```bash
cd atomo-ai-fronend-backend/face_recognition
source venv/bin/activate
npm start
```

## Stop

Press:

```text
Ctrl + C
```

## PM2 Start

```bash
pm2 start npm --name atomo-ai -- start
```

## PM2 Restart

```bash
pm2 restart atomo-ai
```

## PM2 Logs

```bash
pm2 logs atomo-ai
```

## Reset Database

```bash
npm run reset-db
```

## Application URL

```text
http://localhost:3000
```
