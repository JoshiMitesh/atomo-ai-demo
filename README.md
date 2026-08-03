# Atomo AI – Face Recognition and Video Analytics Platform

Atomo AI is a real-time video analytics platform for camera monitoring, person detection, face recognition, unknown-person clustering, event management and alert configuration.

The system processes live camera streams, detects people and faces, compares detected faces with enrolled identities and displays the results through a web dashboard.

## Main Features

- User registration and login
- Role-based access control
- Camera registration and management
- RTSP camera-stream support
- Live camera viewing
- Real-time person detection
- Real-time face detection and recognition
- Enrolled-person management
- Face embedding generation and storage
- Unknown-person detection
- Automatic clustering of unknown faces
- Cluster review and person enrolment
- Detection event history
- Event images and recognition details
- Camera stream logs
- Live system metrics
- Alert configuration
- Device registration
- User and cluster role management
- MediaMTX-based stream handling

## System Workflow

```text
Camera/RTSP Stream
        ↓
MediaMTX Stream Processing
        ↓
Person and Face Detection
        ↓
Face Embedding Generation
        ↓
Compare With Enrolled Persons
        ↓
Recognized Person or Unknown Face
        ↓
Unknown Face Clustering
        ↓
Store Detection Event
        ↓
Display Result on Web Dashboard
