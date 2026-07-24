// App State
let currentTab = 'live';
let socket = null;
let currentPersonId = null;
let currentPersonName = null;
let cameras = [];
let systemSettings = {
  threshold: 0.55,
  dis_type: 0
};
let allPersons = [];
let allClusters = [];
const whepPeerConnections = new Map(); // camera_id -> RTCPeerConnection

// DOM Elements
const navItems = document.querySelectorAll('.nav-item');
const tabContents = document.querySelectorAll('.tab-content');
const tabTitle = document.getElementById('tab-title');
const tabSubtitle = document.getElementById('tab-subtitle');
const connectionDot = document.getElementById('connection-dot');
const connectionText = document.getElementById('connection-text');

// Tab 1: Live Monitor & Cameras Setup Elements
const liveStreamsGrid = document.getElementById('live-streams-grid');
const noStreamsPlaceholder = document.getElementById('no-streams-active-placeholder');
const cameraControlsList = document.getElementById('camera-controls-list');
const btnOpenCameramodal = document.getElementById('btn-open-camera-modal');
const modalAddCamera = document.getElementById('modal-add-camera');
const btnCancelCameraModal = document.getElementById('btn-cancel-camera-modal');
const btnSubmitCameraSource = document.getElementById('btn-submit-camera-source');
const cameraNameInput = document.getElementById('camera-name-input');
const cameraRtspInput = document.getElementById('camera-rtsp-input');
const eventsList = document.getElementById('events-list');
const eventsEmptyState = document.getElementById('events-empty-state');
const btnClearEvents = document.getElementById('btn-clear-events');

// Add Camera Modal Tabs Elements
const modalTabBtns = document.querySelectorAll('.modal-tab-btn');
const modalTabContents = document.querySelectorAll('.modal-tab-content');
let activeModalTab = 'ip-cam';

// Video Uploader (Mock Video Tab) Elements
const mockVideoDropzone = document.getElementById('mock-video-dropzone');
const mockVideoFileInput = document.getElementById('mock-video-file-input');
const mockUploadStatus = document.getElementById('mock-upload-status');

// Tab 2: Database Elements
const personsGrid = document.getElementById('persons-grid');
const dbSearchInput = document.getElementById('db-search-input');
const btnOpenCreatePersonModal = document.getElementById('btn-open-create-person-modal');
const modalCreatePerson = document.getElementById('modal-create-person');
const btnCloseCreateModal = document.getElementById('btn-close-create-modal');
const btnCancelCreateModal = document.getElementById('btn-cancel-create-modal');
const btnSubmitCreatePerson = document.getElementById('btn-submit-create-person');
const personNameInput = document.getElementById('person-name-input');
const personGenderSelect = document.getElementById('person-gender-select');

// Tab 5: Discovered Profiles Elements
const clustersGrid = document.getElementById('clusters-grid');
const clusterSearchInput = document.getElementById('cluster-search-input');
const modalEnrollCluster = document.getElementById('modal-enroll-cluster');
const btnCloseEnrollClusterModal = document.getElementById('btn-close-enroll-cluster-modal');
const btnCancelEnrollClusterModal = document.getElementById('btn-cancel-enroll-cluster-modal');
const btnSubmitEnrollCluster = document.getElementById('btn-submit-enroll-cluster');
const enrollClusterId = document.getElementById('enroll-cluster-id');
const enrollClusterNameInput = document.getElementById('enroll-cluster-name-input');

// Cluster Details Modal Elements
const modalClusterDetails = document.getElementById('modal-cluster-details');
const btnCloseClusterDetailsModal = document.getElementById('btn-close-cluster-details-modal');
const btnCloseClusterDetailsFooter = document.getElementById('btn-close-cluster-details-footer');
const clusterDetailsTitle = document.getElementById('cluster-details-title');
const clusterPhotosGrid = document.getElementById('cluster-photos-grid');

// Person Details Modal Elements
const modalPersonDetails = document.getElementById('modal-person-details');
const btnCloseDetailsModal = document.getElementById('btn-close-details-modal');
const btnCloseDetailsFooter = document.getElementById('btn-close-details-footer');
const detailsPersonName = document.getElementById('details-person-name');
const detailsPhotosCount = document.getElementById('details-photos-count');
const detailsPhotoDropzone = document.getElementById('details-photo-dropzone');
const detailsFileInput = document.getElementById('details-file-input');
const enrolledPhotosGrid = document.getElementById('enrolled-photos-grid');
const enrollProgressList = document.getElementById('enroll-progress-list');

// Image Preview Modal Elements
const modalImagePreview = document.getElementById('modal-image-preview');
const previewImageElement = document.getElementById('preview-image-element');
const previewImageTitle = document.getElementById('preview-image-title');
const btnClosePreviewModal = document.getElementById('btn-close-preview-modal');

// Tab 3: Photo Analyzer Elements
const analyzerDropzone = document.getElementById('analyzer-dropzone');
const analyzerFileInput = document.getElementById('analyzer-file-input');
const analyzerCanvas = document.getElementById('analyzer-canvas');
const canvasPlaceholder = document.getElementById('canvas-placeholder');
const analyzerMatchesList = document.getElementById('analyzer-matches-list');
const analysisLoader = document.getElementById('analysis-loader');

// Tab 4: Settings Elements
const disCosineRadio = document.getElementById('setting-dis-cosine');
const disL2Radio = document.getElementById('setting-dis-l2');
const settingGroupCosine = document.getElementById('setting-group-cosine');
const settingGroupL2 = document.getElementById('setting-group-l2');
const thresholdCosineSlider = document.getElementById('threshold-cosine-slider');
const thresholdL2Slider = document.getElementById('threshold-l2-slider');
const valCosine = document.getElementById('val-cosine');
const valL2 = document.getElementById('val-l2');
const btnSaveSettings = document.getElementById('btn-save-settings');

// Video Enrollment Elements & State
const btnModePhotos = document.getElementById('btn-mode-photos');
const btnModeVideo = document.getElementById('btn-mode-video');
const enrollSectionPhotos = document.getElementById('enroll-section-photos');
const enrollSectionVideo = document.getElementById('enroll-section-video');
const detailsVideoDropzone = document.getElementById('details-video-dropzone');
const detailsVideoInput = document.getElementById('details-video-input');
const webcamEnrollWrapper = document.getElementById('webcam-enroll-wrapper');
const webcamEnrollPreview = document.getElementById('webcam-enroll-preview');
const enrollRecordingIndicator = document.getElementById('enroll-recording-indicator');
const enrollRecordingTimer = document.getElementById('enroll-recording-timer');
const btnStartEnrollWebcam = document.getElementById('btn-start-enroll-webcam');
const btnRecordEnrollVideo = document.getElementById('btn-record-enroll-video');
const btnStopEnrollWebcam = document.getElementById('btn-stop-enroll-webcam');

let enrollStream = null;
let enrollMediaRecorder = null;
let enrollRecordedChunks = [];
let isWebcamEnrolling = false;
let enrollRecordTimerInterval = null;

// -------------------------------------------------------------
// Initialization & Tab Controller
// -------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  setupTabNavigation();
  setupModalTabs();
  initWebSocket();
  setupEventListeners();
  fetchPersons();
  fetchEvents();
  fetchCameras();
  fetchClusters();
});

function setupTabNavigation() {
  navItems.forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const tabName = item.getAttribute('data-tab');
      switchTab(tabName);
    });
  });
}

function switchTab(tabName) {
  currentTab = tabName;
  
  navItems.forEach(item => {
    if (item.getAttribute('data-tab') === tabName) {
      item.classList.add('active');
    } else {
      item.classList.remove('active');
    }
  });
  
  tabContents.forEach(content => {
    if (content.id === `tab-content-${tabName}`) {
      content.classList.add('active');
    } else {
      content.classList.remove('active');
    }
  });
  
  if (tabName === 'live') {
    tabTitle.textContent = 'Live Monitor';
    tabSubtitle.textContent = 'Multi-stream tiled surveillance camera views and face matching log.';
    fetchCameras();
  } else if (tabName === 'database') {
    tabTitle.textContent = 'Face Database';
    tabSubtitle.textContent = 'Manage registered profiles, facial templates, and embeddings.';
    fetchPersons();
  } else if (tabName === 'clusters') {
    tabTitle.textContent = 'Discovered Profiles';
    tabSubtitle.textContent = 'Browse automatically grouped clusters of unknown faces.';
    fetchClusters();
  } else if (tabName === 'analyzer') {
    tabTitle.textContent = 'Photo Analyzer';
    tabSubtitle.textContent = 'Perform instant face recognition on a static image file.';
  } else if (tabName === 'settings') {
    tabTitle.textContent = 'System Settings';
    tabSubtitle.textContent = 'Tune face detector confidence and recognizer matching thresholds.';
    syncSettingsUI();
  }
}

// Setup inner tabs for add camera modal
function setupModalTabs() {
  modalTabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const tabTarget = btn.getAttribute('data-modal-tab');
      activeModalTab = tabTarget;
      
      modalTabBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      
      modalTabContents.forEach(c => {
        if (c.id === `modal-tab-content-${tabTarget}`) {
          c.classList.add('active');
        } else {
          c.classList.remove('active');
        }
      });
      
      // Hide or show save buttons depending on tab
      if (activeModalTab === 'mock-video') {
        btnSubmitCameraSource.classList.add('hidden');
      } else {
        btnSubmitCameraSource.classList.remove('hidden');
      }
    });
  });
}

// -------------------------------------------------------------
// WebSocket Connection
// -------------------------------------------------------------
function initWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}`;
  
  socket = new WebSocket(wsUrl);
  
  socket.onopen = () => {
    connectionDot.className = 'status-dot connected';
    connectionText.textContent = 'Connected';
  };
  
  socket.onclose = () => {
    connectionDot.className = 'status-dot disconnected';
    connectionText.textContent = 'Disconnected (Reconnecting...)';
    setTimeout(initWebSocket, 3000);
  };
  
  socket.onerror = (err) => {
    console.error('WebSocket Error:', err);
  };
  
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    handleSocketMessage(message);
  };
}

function handleSocketMessage(msg) {
  if (msg.event === 'connection_init') {
    systemSettings = msg.data.status;
    syncSettingsUI();
    
    cameras = msg.data.cameras;
    renderCameras();
    
    allEvents = msg.data.events;
    filterAndRenderEvents();
  } else if (msg.event === 'stream_status') {
    systemSettings = { ...systemSettings, ...msg.data };
    syncSettingsUI();
  } else if (msg.event === 'cameras_updated') {
    cameras = msg.data;
    renderCameras();
  } else if (msg.event === 'database_updated') {
    fetchPersons();
    fetchEvents();
    if (currentPersonId && modalPersonDetails && !modalPersonDetails.classList.contains('hidden')) {
      fetchPersonPhotos();
    }
  } else if (msg.event === 'clusters_updated') {
    fetchClusters();
    fetchEvents();
  } else if (msg.event === 'video_face_enrolled') {
    if (enrollProgressList) {
      const addedMsg = document.createElement('div');
      addedMsg.className = 'progress-item success';
      addedMsg.style.margin = '4px 0';
      addedMsg.innerHTML = `<i class="fa-solid fa-circle-check"></i> Enrolled frame template dynamically.`;
      enrollProgressList.appendChild(addedMsg);
      enrollProgressList.scrollTop = enrollProgressList.scrollHeight;
    }
  } else if (msg.event === 'live_frame') {
    // MediaMTX handles WebRTC/WHEP streaming directly, so live_frame base64 websocket events are ignored.
  } else if (msg.event === 'recognition_event') {
    prependRecognitionEvent(msg.data);
  } else if (msg.event === 'recognition_update') {
    updateRecognitionEvent(msg.data);
  } else if (msg.event === 'events_cleared') {
    allEvents = [];
    filterAndRenderEvents();
  }
}

// -------------------------------------------------------------
// Render Camera Stream Tiles and Sidebar Controls
// -------------------------------------------------------------
async function fetchCameras() {
  try {
    const res = await fetch('/api/cameras');
    cameras = await res.json();
    renderCameras();
  } catch (err) {
    console.error('Error fetching cameras:', err);
  }
}

function renderCameras() {
  // 1. Render sidebar list items under "Cameras Setup"
  cameraControlsList.innerHTML = '';
  if (cameras.length === 0) {
    cameraControlsList.innerHTML = `
      <div class="empty-state" style="padding: 16px 0;">
        <p style="font-size: 0.8rem;">No streams registered yet.</p>
      </div>
    `;
  } else {
    cameras.forEach(cam => {
      const item = document.createElement('div');
      item.className = 'camera-control-item';
      
      const toggleId = `toggle-${cam.id}`;
      const checked = cam.is_active ? 'checked' : '';
      
      item.innerHTML = `
        <div class="camera-control-info">
          <span class="camera-control-name">${cam.name}</span>
          <span class="camera-control-url">${cam.rtsp_url}</span>
          <div class="camera-line-crossing-row" style="margin-top: 6px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
            <label style="font-size: 0.7rem; color: var(--text-muted); display: flex; align-items: center; gap: 4px; cursor: pointer; user-select: none;">
              <input type="checkbox" class="chk-line-crossing" style="cursor: pointer;" ${cam.line_crossing_enabled ? 'checked' : ''}>
              Entry Line
            </label>
            ${cam.line_crossing_enabled ? `
              <div style="display: flex; align-items: center; gap: 4px;">
                <input type="range" class="rng-line-y" min="0.1" max="0.9" step="0.05" value="${cam.line_y || 0.6}" style="width: 50px; height: 3px; cursor: pointer;">
                <span class="lbl-line-y" style="font-size: 0.65rem; color: var(--primary); font-family: monospace;">${Math.round((cam.line_y || 0.6) * 100)}%</span>
              </div>
              <select class="sel-line-dir" style="font-size: 0.65rem; background: var(--bg-dark); border: 1px solid var(--border-color); color: #fff; padding: 1px 4px; border-radius: 4px;">
                <option value="in" ${cam.line_direction === 'in' ? 'selected' : ''}>Incoming</option>
                <option value="out" ${cam.line_direction === 'out' ? 'selected' : ''}>Outgoing</option>
                <option value="both" ${cam.line_direction === 'both' ? 'selected' : ''}>Both</option>
              </select>
            ` : ''}
          </div>
        </div>
        <div class="camera-control-actions">
          <label class="switch">
            <input type="checkbox" id="${toggleId}" ${checked}>
            <span class="toggle-slider"></span>
          </label>
          <button class="btn-delete-camera" data-id="${cam.id}" title="Delete Camera">
            <i class="fa-regular fa-trash-can"></i>
          </button>
        </div>
      `;
      
      const updateLineCrossingSettings = async () => {
        const chk = item.querySelector('.chk-line-crossing');
        const rng = item.querySelector('.rng-line-y');
        const sel = item.querySelector('.sel-line-dir');
        
        const enabled = chk ? chk.checked : false;
        const lineY = rng ? parseFloat(rng.value) : (cam.line_y || 0.6);
        const direction = sel ? sel.value : (cam.line_direction || 'in');
        
        try {
          await fetch(`/api/cameras/${cam.id}/line-settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              line_crossing_enabled: enabled,
              line_y: lineY,
              line_direction: direction
            })
          });
        } catch (err) {
          console.error('Failed to update line settings:', err);
        }
      };

      const chkLine = item.querySelector('.chk-line-crossing');
      if (chkLine) {
        chkLine.addEventListener('change', updateLineCrossingSettings);
      }
      
      const rngLine = item.querySelector('.rng-line-y');
      if (rngLine) {
        rngLine.addEventListener('input', (e) => {
          const val = Math.round(parseFloat(e.target.value) * 100);
          const lbl = item.querySelector('.lbl-line-y');
          if (lbl) lbl.textContent = `${val}%`;
        });
        rngLine.addEventListener('change', updateLineCrossingSettings);
      }
      
      const selLine = item.querySelector('.sel-line-dir');
      if (selLine) {
        selLine.addEventListener('change', updateLineCrossingSettings);
      }
      
      // Wire up active toggle switch
      item.querySelector('.switch input').addEventListener('change', async (e) => {
        const toggleBtn = e.target;
        toggleBtn.disabled = true;
        try {
          const res = await fetch(`/api/cameras/${cam.id}/toggle`, { method: 'POST' });
          const result = await res.json();
          if (!result.success) {
            alert('Toggle error: ' + result.error);
            toggleBtn.checked = !toggleBtn.checked; // Revert switch state
          }
        } catch (err) {
          console.error(err);
          toggleBtn.checked = !toggleBtn.checked;
        } finally {
          toggleBtn.disabled = false;
        }
      });
      
      // Wire up delete camera button
      item.querySelector('.btn-delete-camera').addEventListener('click', async () => {
        if (confirm(`Remove camera "${cam.name}"? Active stream analysis will be stopped.`)) {
          try {
            await fetch(`/api/cameras/${cam.id}`, { method: 'DELETE' });
          } catch (err) {
            console.error(err);
          }
        }
      });
      
      cameraControlsList.appendChild(item);
    });
  }
  
  // 2. Render tiled stream grids on viewport
  const activeCameras = cameras.filter(c => c.is_active);
  
  if (activeCameras.length === 0) {
    noStreamsPlaceholder.classList.remove('hidden');
    liveStreamsGrid.classList.add('hidden');
    // Close any lingering peer connections
    whepPeerConnections.forEach((pc, cid) => {
      console.log(`[WHEP] Closing WebRTC peer connection for camera ${cid}`);
      pc.close();
    });
    whepPeerConnections.clear();
    liveStreamsGrid.innerHTML = '';
  } else {
    noStreamsPlaceholder.classList.add('hidden');
    liveStreamsGrid.classList.remove('hidden');
    
    // Check for deleted active tiles
    const existingTiles = Array.from(liveStreamsGrid.querySelectorAll('.stream-tile'));
    existingTiles.forEach(tile => {
      const tileId = tile.getAttribute('data-cam-id');
      if (!activeCameras.some(c => c.id === tileId)) {
        tile.remove();
        if (whepPeerConnections.has(tileId)) {
          console.log(`[WHEP] Closing WebRTC peer connection for camera ${tileId}`);
          whepPeerConnections.get(tileId).close();
          whepPeerConnections.delete(tileId);
        }
      }
    });
    
    // Append or update active tiles
    activeCameras.forEach(cam => {
      let tile = document.getElementById(`stream-tile-${cam.id}`);
      
      if (!tile) {
        tile = document.createElement('div');
        tile.className = 'stream-tile';
        tile.id = `stream-tile-${cam.id}`;
        tile.setAttribute('data-cam-id', cam.id);
        
        tile.innerHTML = `
          <div class="stream-tile-loading" id="stream-spinner-${cam.id}">
            <div class="spinner"></div>
            <p style="font-size: 0.75rem;">Opening WebRTC pipeline...</p>
          </div>
          <video id="stream-video-${cam.id}" class="stream-tile-image hidden" autoplay playsinline muted></video>
          <div class="stream-tile-header">
            <span class="stream-tile-name">${cam.name}</span>
            <span class="stream-tile-badge">AI LIVE</span>
          </div>
        `;
        liveStreamsGrid.appendChild(tile);
      }
      
      // Update or create the red line overlay
      let lineEl = tile.querySelector('.stream-crossing-line');
      if (cam.line_crossing_enabled) {
        if (!lineEl) {
          lineEl = document.createElement('div');
          lineEl.className = 'stream-crossing-line';
          tile.appendChild(lineEl);
        }
        
        const curXStart = cam.line_x_start !== undefined ? cam.line_x_start : 0.0;
        const curXEnd = cam.line_x_end !== undefined ? cam.line_x_end : 1.0;
        
        lineEl.style.top = `${(cam.line_y || 0.6) * 100}%`;
        lineEl.style.left = `${curXStart * 100}%`;
        lineEl.style.width = `${(curXEnd - curXStart) * 100}%`;
        lineEl.style.display = 'block';
        
        let lineLabel = lineEl.querySelector('.stream-crossing-label');
        if (!lineLabel) {
          lineLabel = document.createElement('span');
          lineLabel.className = 'stream-crossing-label';
          lineLabel.style.cssText = 'position: absolute; right: 8px; top: -14px; font-size: 0.6rem; background: rgba(239, 68, 68, 0.9); color: #fff; padding: 1px 4px; border-radius: 3px; font-family: monospace; font-weight: bold; pointer-events: none;';
          lineEl.appendChild(lineLabel);
        }
        const dirText = cam.line_direction === 'in' ? 'IN ENTRY ONLY' : (cam.line_direction === 'out' ? 'OUT ONLY' : 'ANY CROSSING');
        lineLabel.textContent = `${dirText} (${Math.round((cam.line_y || 0.6) * 100)}%)`;
        
        // Circular handles for adjusting width/span
        let handleLeft = lineEl.querySelector('.line-handle-left');
        if (!handleLeft) {
          handleLeft = document.createElement('div');
          handleLeft.className = 'line-handle-left';
          handleLeft.style.cssText = 'position: absolute; left: 0; top: 50%; width: 12px; height: 12px; background: #fff; border: 2px solid #ef4444; border-radius: 50%; transform: translate(-50%, -50%); cursor: ew-resize; pointer-events: auto; box-shadow: 0 0 4px rgba(0,0,0,0.5); z-index: 12;';
          lineEl.appendChild(handleLeft);
        }
        
        let handleRight = lineEl.querySelector('.line-handle-right');
        if (!handleRight) {
          handleRight = document.createElement('div');
          handleRight.className = 'line-handle-right';
          handleRight.style.cssText = 'position: absolute; right: 0; top: 50%; width: 12px; height: 12px; background: #fff; border: 2px solid #ef4444; border-radius: 50%; transform: translate(50%, -50%); cursor: ew-resize; pointer-events: auto; box-shadow: 0 0 4px rgba(0,0,0,0.5); z-index: 12;';
          lineEl.appendChild(handleRight);
        }
        
        let activeDrag = null; // 'y', 'x_start', 'x_end'
        let curY = cam.line_y || 0.6;
        let dragXStart = curXStart;
        let dragXEnd = curXEnd;
        
        const onMouseDownLine = (e) => {
          activeDrag = 'y';
          e.preventDefault();
          e.stopPropagation();
          document.addEventListener('mousemove', onMouseMove);
          document.addEventListener('mouseup', onMouseUp);
        };
        
        const onMouseDownLeft = (e) => {
          activeDrag = 'x_start';
          e.preventDefault();
          e.stopPropagation();
          document.addEventListener('mousemove', onMouseMove);
          document.addEventListener('mouseup', onMouseUp);
        };
        
        const onMouseDownRight = (e) => {
          activeDrag = 'x_end';
          e.preventDefault();
          e.stopPropagation();
          document.addEventListener('mousemove', onMouseMove);
          document.addEventListener('mouseup', onMouseUp);
        };
        
        const onMouseMove = (e) => {
          if (!activeDrag) return;
          const rect = tile.getBoundingClientRect();
          
          if (activeDrag === 'y') {
            let y = e.clientY - rect.top;
            y = Math.max(rect.height * 0.05, Math.min(rect.height * 0.95, y));
            curY = y / rect.height;
            lineEl.style.top = `${curY * 100}%`;
          } else if (activeDrag === 'x_start') {
            let x = e.clientX - rect.left;
            x = Math.max(0, Math.min(rect.width * (dragXEnd - 0.1), x));
            dragXStart = x / rect.width;
            lineEl.style.left = `${dragXStart * 100}%`;
            lineEl.style.width = `${(dragXEnd - dragXStart) * 100}%`;
          } else if (activeDrag === 'x_end') {
            let x = e.clientX - rect.left;
            x = Math.max(rect.width * (dragXStart + 0.1), Math.min(rect.width, x));
            dragXEnd = x / rect.width;
            lineEl.style.width = `${(dragXEnd - dragXStart) * 100}%`;
          }
          
          if (lineLabel) {
            const dirText = cam.line_direction === 'in' ? 'IN ENTRY ONLY' : (cam.line_direction === 'out' ? 'OUT ONLY' : 'ANY CROSSING');
            lineLabel.textContent = `${dirText} (${Math.round(curY * 100)}%)`;
          }
        };
        
        const onMouseUp = async (e) => {
          if (!activeDrag) return;
          activeDrag = null;
          document.removeEventListener('mousemove', onMouseMove);
          document.removeEventListener('mouseup', onMouseUp);
          
          curY = parseFloat(curY.toFixed(3));
          dragXStart = parseFloat(dragXStart.toFixed(3));
          dragXEnd = parseFloat(dragXEnd.toFixed(3));
          
          try {
            await fetch(`/api/cameras/${cam.id}/line-settings`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                line_crossing_enabled: true,
                line_y: curY,
                line_direction: cam.line_direction || 'in',
                line_x_start: dragXStart,
                line_x_end: dragXEnd
              })
            });
          } catch (err) {
            console.error('Failed to save line settings after drag:', err);
          }
        };
        
        if (lineEl._dragHandler) {
          lineEl.removeEventListener('mousedown', lineEl._dragHandler);
        }
        lineEl._dragHandler = onMouseDownLine;
        lineEl.addEventListener('mousedown', onMouseDownLine);
        
        if (handleLeft._dragHandler) {
          handleLeft.removeEventListener('mousedown', handleLeft._dragHandler);
        }
        handleLeft._dragHandler = onMouseDownLeft;
        handleLeft.addEventListener('mousedown', onMouseDownLeft);
        
        if (handleRight._dragHandler) {
          handleRight.removeEventListener('mousedown', handleRight._dragHandler);
        }
        handleRight._dragHandler = onMouseDownRight;
        handleRight.addEventListener('mousedown', onMouseDownRight);
      } else {
        if (lineEl) {
          lineEl.style.display = 'none';
        }
      }
      
      // Auto-start WHEP stream if not already connected
      startWhepStream(cam.id);
    });
  }
}

async function startWhepStream(cameraId) {
  if (whepPeerConnections.has(cameraId)) {
    return;
  }

  const video = document.getElementById(`stream-video-${cameraId}`);
  const spinner = document.getElementById(`stream-spinner-${cameraId}`);
  if (!video) return;

  console.log(`[WHEP] Starting WebRTC stream for camera ${cameraId}...`);
  
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
  });
  
  whepPeerConnections.set(cameraId, pc);

  pc.addTransceiver('video', { direction: 'recvonly' });

  pc.ontrack = (event) => {
    console.log(`[WHEP] Received track for camera ${cameraId}`);
    if (video.srcObject !== event.streams[0]) {
      video.srcObject = event.streams[0];
      video.classList.remove('hidden');
      if (spinner) {
        spinner.classList.add('hidden');
      }
    }
  };

  pc.oniceconnectionstatechange = () => {
    console.log(`[WHEP] Camera ${cameraId} ICE state: ${pc.iceConnectionState}`);
    if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
      console.warn(`[WHEP] Connection failed for ${cameraId}, retrying in 5s...`);
      pc.close();
      whepPeerConnections.delete(cameraId);
      setTimeout(() => startWhepStream(cameraId), 5000);
    }
  };

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const whepUrl = `http://${location.hostname}:8889/${cameraId}/whep`;
    
    const response = await fetch(whepUrl, {
      method: 'POST',
      body: offer.sdp,
      headers: {
        'Content-Type': 'application/sdp'
      }
    });

    if (!response.ok) {
      throw new Error(`MediaMTX WHEP returned status ${response.status}`);
    }

    const answerSdp = await response.text();
    await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
    console.log(`[WHEP] WebRTC connection established for camera ${cameraId}`);
  } catch (err) {
    console.error(`[WHEP] Failed to establish WebRTC for camera ${cameraId}:`, err);
    if (spinner) {
      spinner.querySelector('p').textContent = 'Stream offline or buffering...';
    }
    pc.close();
    whepPeerConnections.delete(cameraId);
    // Retry connection after 5 seconds
    setTimeout(() => startWhepStream(cameraId), 5000);
  }
}

// -------------------------------------------------------------
// Real-Time Events Logs Rendering
// -------------------------------------------------------------
let currentEventFilter = 'all'; // 'all', 'known', 'unknown'

async function fetchEvents() {
  try {
    const res = await fetch('/api/events?limit=100');
    allEvents = await res.json();
    filterAndRenderEvents();
  } catch (err) {
    console.error('Error fetching events:', err);
  }
}

function filterAndRenderEvents() {
  let filtered = allEvents;
  if (currentEventFilter === 'known') {
    filtered = allEvents.filter(e => e.is_known === true);
  } else if (currentEventFilter === 'unknown') {
    filtered = allEvents.filter(e => e.is_known === false);
  }
  
  eventsList.innerHTML = '';
  if (filtered.length === 0) {
    eventsList.innerHTML = `
      <div class="empty-state" id="events-empty-state">
        <i class="fa-solid fa-bell-slash"></i>
        <p>No matching face events found.</p>
      </div>
    `;
    return;
  }
  
  filtered.forEach(ev => {
    appendEventHTML(ev, false);
  });
}

function renderEvents(events) {
  allEvents = events;
  filterAndRenderEvents();
}

function prependRecognitionEvent(ev) {
  allEvents.unshift(ev);
  if (allEvents.length > 100) allEvents.pop();
  filterAndRenderEvents();
}

function appendEventHTML(ev, prepend = false) {
  const item = document.createElement('div');
  item.className = 'event-item';
  item.style.position = 'relative';
  item.style.overflow = 'visible';
  item.setAttribute('data-event-id', ev.id);
  
  const scoreText = (ev.score * 100).toFixed(0) + '%';
  const scoreClass = ev.is_known ? 'match' : 'unknown';
  const cropUrl = ev.crop_filename ? `/crops/${ev.crop_filename}` : 'https://placehold.co/100x100?text=Face';
  
  const date = new Date(ev.timestamp);
  const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  
  // Show 3-dot dropdown only if person is unknown (not known)
  let actionsHTML = '';
  if (!ev.is_known) {
    actionsHTML = `
      <div class="event-actions-dropdown" style="position: absolute; top: 12px; right: 12px; z-index: 100;">
        <button class="btn-icon btn-event-dots" style="background: none; border: none; color: var(--text-muted); cursor: pointer;" title="Options">
          <i class="fa-solid fa-ellipsis-vertical"></i>
        </button>
        <div class="dropdown-menu hidden" style="position: absolute; top: 24px; right: 0; background: var(--modal-bg); border: 1px solid var(--border-color); border-radius: var(--radius-md); width: 180px; box-shadow: var(--shadow-lg); overflow: hidden; z-index: 10000;">
          <div class="dropdown-header">Move to Registered Person</div>
          <div class="dropdown-persons-list">
            <!-- Dynamic persons list -->
          </div>
        </div>
      </div>
    `;
  }
  
  item.innerHTML = `
    <div class="event-crop-wrapper">
      <img src="${cropUrl}" class="event-crop" style="cursor: pointer;" onerror="this.src='https://placehold.co/100x100?text=Face'">
    </div>
    <div class="event-details" style="padding-right: 20px;">
      <div class="event-header-row">
        <span class="event-name">${ev.person_name}</span>
        <span class="event-score-badge ${scoreClass}">${scoreText}</span>
      </div>
      <div class="event-time">
        <i class="fa-solid fa-camera"></i>
        <span style="font-weight: 500; color: #a5b4fc;">${ev.camera_name || 'Manual Upload'}</span>
        <span style="margin: 0 4px;">•</span>
        <span>${timeStr}</span>
      </div>
    </div>
    ${actionsHTML}
  `;
  
  const cropImg = item.querySelector('.event-crop');
  if (cropImg) {
    cropImg.addEventListener('click', () => {
      if (modalImagePreview && previewImageElement && previewImageTitle) {
        previewImageElement.src = cropUrl;
        previewImageTitle.textContent = `${ev.person_name} - ${ev.camera_name || 'Manual Upload'} @ ${timeStr}`;
        modalImagePreview.classList.remove('hidden');
      }
    });
  }
  
  if (!ev.is_known) {
    const btnDots = item.querySelector('.btn-event-dots');
    const dropdownMenu = item.querySelector('.dropdown-menu');
    if (btnDots && dropdownMenu) {
      btnDots.addEventListener('click', (e) => {
        e.stopPropagation();
        // Close other dropdowns first
        document.querySelectorAll('.photo-actions-dropdown .dropdown-menu, .event-actions-dropdown .dropdown-menu').forEach(el => {
          if (el !== dropdownMenu) el.classList.add('hidden');
        });
        dropdownMenu.classList.toggle('hidden');
      });
      
      const personsListContainer = item.querySelector('.dropdown-persons-list');
      
      // Add "Register New Person" option at the top
      const newPersonItem = document.createElement('div');
      newPersonItem.className = 'dropdown-item';
      newPersonItem.style.fontWeight = 'bold';
      newPersonItem.style.color = 'var(--primary)';
      newPersonItem.innerHTML = `<i class="fa-solid fa-plus" style="margin-right: 6px;"></i> Register New Person`;
      newPersonItem.addEventListener('click', async (e) => {
        e.stopPropagation();
        dropdownMenu.classList.add('hidden');
        const newName = prompt("Enter name for the new person:");
        if (newName && newName.trim() !== '') {
          await moveEventPhotoToPerson(ev.id, null, newName);
        }
      });
      personsListContainer.appendChild(newPersonItem);
      
      if (allPersons.length === 0) {
        // No existing registered persons
      } else {
        allPersons.forEach(person => {
          const pItem = document.createElement('div');
          pItem.className = 'dropdown-item';
          pItem.textContent = person.name;
          pItem.addEventListener('click', async (e) => {
            e.stopPropagation();
            dropdownMenu.classList.add('hidden');
            await moveEventPhotoToPerson(ev.id, person.id, person.name);
          });
          personsListContainer.appendChild(pItem);
        });
      }
    }
  }
  
  if (prepend) {
    eventsList.insertBefore(item, eventsList.firstChild);
  } else {
    eventsList.appendChild(item);
  }
}

function updateRecognitionEvent(ev) {
  const index = allEvents.findIndex(e => e.id === ev.id);
  if (index !== -1) {
    allEvents[index] = { ...allEvents[index], ...ev };
  }
  filterAndRenderEvents();
}

async function moveEventPhotoToPerson(eventId, personId, name) {
  try {
    const res = await fetch(`/api/events/${eventId}/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ personId, name })
    });
    const result = await res.json();
    if (result.success) {
      // Re-fetch everything to keep UI perfectly synchronized
      await fetchClusters();
      await fetchPersons();
      await fetchEvents();
    } else {
      alert('Error: ' + result.error);
    }
  } catch (err) {
    console.error('Error moving event photo:', err);
  }
}

// -------------------------------------------------------------
// Face Database Tab Management
// -------------------------------------------------------------
async function fetchPersons() {
  try {
    const res = await fetch('/api/persons');
    const data = await res.json();
    allPersons = data;
    renderPersons(data);
  } catch (err) {
    console.error('Error fetching persons:', err);
  }
}

function renderPersons(persons) {
  personsGrid.innerHTML = '';
  const query = dbSearchInput.value.toLowerCase().trim();
  const filtered = persons.filter(p => p.name.toLowerCase().includes(query));
  
  if (filtered.length === 0) {
    personsGrid.innerHTML = `
      <div class="empty-state" style="grid-column: 1 / -1;">
        <i class="fa-solid fa-users-slash"></i>
        <p>${query ? 'No matching profiles found.' : 'Database is empty. Register your first candidate profile.'}</p>
      </div>
    `;
    return;
  }
  
  filtered.forEach(p => {
    const card = document.createElement('div');
    card.className = 'person-card';
    
    let thumbsHTML = '';
    if (p.photos && p.photos.length > 0) {
      p.photos.slice(0, 5).forEach(ph => {
        thumbsHTML += `<img src="/uploads/${ph.filename}" class="person-thumb" onerror="this.style.display='none'">`;
      });
      if (p.photos.length > 5) {
        thumbsHTML += `<span class="badge">+${p.photos.length - 5}</span>`;
      }
    } else {
      thumbsHTML = '<span class="person-thumbs-empty">No photos enrolled</span>';
    }
    
    const formattedDate = new Date(p.created_at).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
    
    card.innerHTML = `
      <div class="person-top">
        <div class="person-info">
          <span class="person-title">${p.name}</span>
          <span class="person-date">Enrolled ${formattedDate}</span>
        </div>
        <button class="person-delete-btn" title="Delete Profile" data-id="${p.id}">
          <i class="fa-regular fa-trash-can"></i>
        </button>
      </div>
      <div class="person-thumbs-row">
        ${thumbsHTML}
      </div>
      <div class="person-footer">
        <span class="photos-count">
          <i class="fa-solid fa-image"></i>
          <span>${p.photos.length} templates</span>
        </span>
        <button class="btn btn-secondary btn-manage" data-id="${p.id}" data-name="${p.name}">
          Manage Templates
        </button>
      </div>
    `;
    
    card.querySelector('.person-delete-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirm(`Delete profile for "${p.name}"? This removes all their templates.`)) {
        deletePerson(p.id);
      }
    });
    
    card.querySelector('.btn-manage').addEventListener('click', () => {
      openPersonDetailsModal(p.id, p.name);
    });
    
    personsGrid.appendChild(card);
  });
}

async function deletePerson(id) {
  try {
    const res = await fetch(`/api/persons/${id}`, { method: 'DELETE' });
    const result = await res.json();
    if (result.success) {
      fetchPersons();
    }
  } catch (err) {
    console.error('Failed to delete person:', err);
  }
}

async function openPersonDetailsModal(id, name) {
  currentPersonId = id;
  currentPersonName = name;
  detailsPersonName.textContent = name;
  enrolledPhotosGrid.innerHTML = '<div class="spinner" style="margin: 30px auto; grid-column: 1 / -1;"></div>';
  enrollProgressList.innerHTML = '';
  modalPersonDetails.classList.remove('hidden');
  await fetchPersonPhotos();
}

async function fetchPersonPhotos() {
  try {
    const res = await fetch(`/api/persons/${currentPersonId}`);
    const person = await res.json();
    detailsPhotosCount.textContent = `${person.photos.length} photos enrolled`;
    renderEnrolledPhotos(person.photos);
  } catch (err) {
    console.error('Error fetching person photos:', err);
  }
}

function renderEnrolledPhotos(photos) {
  enrolledPhotosGrid.innerHTML = '';
  if (photos.length === 0) {
    enrolledPhotosGrid.innerHTML = `
      <div class="empty-state" style="grid-column: 1 / -1; padding: 24px 0;">
        <i class="fa-solid fa-images" style="font-size: 1.8rem;"></i>
        <p style="font-size: 0.8rem;">No templates enrolled yet.</p>
      </div>
    `;
    return;
  }
  
  photos.forEach(ph => {
    const wrapper = document.createElement('div');
    wrapper.className = 'enroll-photo-card';
    wrapper.innerHTML = `
      <img src="/uploads/${ph.filename}" onerror="this.src='https://placehold.co/200x200?text=Error'">
      <button class="photo-delete-btn" title="Delete Template" data-photo-id="${ph.id}">
        <i class="fa-solid fa-xmark"></i>
      </button>
    `;
    wrapper.querySelector('.photo-delete-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (confirm('Delete this face template?')) {
        await deletePhoto(ph.id);
      }
    });
    enrolledPhotosGrid.appendChild(wrapper);
  });
}

async function deletePhoto(photoId) {
  try {
    const res = await fetch(`/api/photos/${photoId}`, { method: 'DELETE' });
    const result = await res.json();
    if (result.success) {
      await fetchPersonPhotos();
      fetchPersons();
    }
  } catch (err) {
    console.error('Failed to delete photo:', err);
  }
}

async function handlePhotoEnrollUpload(files) {
  if (!files || files.length === 0) return;
  
  const formData = new FormData();
  for (let i = 0; i < files.length; i++) {
    formData.append('photos', files[i]);
  }
  
  const progItem = document.createElement('div');
  progItem.className = 'progress-item';
  progItem.textContent = `Uploading and extracting embeddings for ${files.length} file(s)...`;
  enrollProgressList.appendChild(progItem);
  
  try {
    const res = await fetch(`/api/persons/${currentPersonId}/photos`, {
      method: 'POST',
      body: formData
    });
    const result = await res.json();
    enrollProgressList.innerHTML = '';
    
    if (result.success) {
      const addedMsg = document.createElement('div');
      addedMsg.className = 'progress-item success';
      addedMsg.innerHTML = `<i class="fa-solid fa-circle-check"></i> Enrolled ${result.added.length} templates.`;
      enrollProgressList.appendChild(addedMsg);
    }
    if (result.errors && result.errors.length > 0) {
      result.errors.forEach(err => {
        const errorMsg = document.createElement('div');
        errorMsg.className = 'progress-item error';
        errorMsg.innerHTML = `<i class="fa-solid fa-circle-exclamation"></i> ${err}`;
        enrollProgressList.appendChild(errorMsg);
      });
    }
    await fetchPersonPhotos();
    fetchPersons();
  } catch (err) {
    enrollProgressList.innerHTML = '';
    const errorMsg = document.createElement('div');
    errorMsg.className = 'progress-item error';
    errorMsg.innerHTML = `<i class="fa-solid fa-circle-exclamation"></i> Upload failed: ${err.message}`;
    enrollProgressList.appendChild(errorMsg);
  }
}

async function handleVideoEnrollUpload(file) {
  if (!file) return;
  
  const formData = new FormData();
  formData.append('video', file);
  
  const progItem = document.createElement('div');
  progItem.className = 'progress-item';
  progItem.textContent = `Uploading and processing face scan video (extracting unique frame angles)...`;
  enrollProgressList.appendChild(progItem);
  
  try {
    const res = await fetch(`/api/persons/${currentPersonId}/video`, {
      method: 'POST',
      body: formData
    });
    
    const result = await res.json();
    enrollProgressList.innerHTML = '';
    
    if (res.ok && result.success) {
      const addedMsg = document.createElement('div');
      addedMsg.className = 'progress-item success';
      addedMsg.innerHTML = `<i class="fa-solid fa-circle-check"></i> Enrolled ${result.addedCount} templates from video scan.`;
      enrollProgressList.appendChild(addedMsg);
    } else {
      const errorMsg = document.createElement('div');
      errorMsg.className = 'progress-item error';
      errorMsg.innerHTML = `<i class="fa-solid fa-circle-exclamation"></i> ${result.error || 'Failed to process video'}`;
      enrollProgressList.appendChild(errorMsg);
    }
    await fetchPersonPhotos();
    fetchPersons();
  } catch (err) {
    enrollProgressList.innerHTML = '';
    const errorMsg = document.createElement('div');
    errorMsg.className = 'progress-item error';
    errorMsg.innerHTML = `<i class="fa-solid fa-circle-exclamation"></i> Video upload failed: ${err.message}`;
    enrollProgressList.appendChild(errorMsg);
  }
}

async function startWebcamEnroll() {
  if (isWebcamEnrolling) return;
  
  enrollProgressList.innerHTML = '';
  if (detailsVideoDropzone) detailsVideoDropzone.classList.add('hidden');
  webcamEnrollWrapper.classList.remove('hidden');
  btnStartEnrollWebcam.classList.add('hidden');
  btnRecordEnrollVideo.classList.remove('hidden');
  btnStopEnrollWebcam.classList.remove('hidden');
  
  try {
    enrollStream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: 'user' },
      audio: false
    });
    webcamEnrollPreview.srcObject = enrollStream;
    isWebcamEnrolling = true;
  } catch (err) {
    console.error('Webcam access failed:', err);
    const errorMsg = document.createElement('div');
    errorMsg.className = 'progress-item error';
    errorMsg.innerHTML = `<i class="fa-solid fa-circle-exclamation"></i> Webcam permission denied or camera not found.`;
    enrollProgressList.appendChild(errorMsg);
    stopWebcamEnroll();
  }
}

function stopWebcamEnroll() {
  if (enrollStream) {
    enrollStream.getTracks().forEach(track => track.stop());
    enrollStream = null;
  }
  
  webcamEnrollPreview.srcObject = null;
  webcamEnrollWrapper.classList.add('hidden');
  if (detailsVideoDropzone) detailsVideoDropzone.classList.remove('hidden');
  btnStartEnrollWebcam.classList.remove('hidden');
  btnRecordEnrollVideo.classList.add('hidden');
  btnStopEnrollWebcam.classList.add('hidden');
  enrollRecordingIndicator.classList.add('hidden');
  webcamEnrollWrapper.classList.remove('recording');
  
  if (enrollRecordTimerInterval) {
    clearInterval(enrollRecordTimerInterval);
    enrollRecordTimerInterval = null;
  }
  
  isWebcamEnrolling = false;
  enrollMediaRecorder = null;
  enrollRecordedChunks = [];
}

function startRecordingEnrollVideo() {
  if (!enrollStream || !isWebcamEnrolling) return;
  
  enrollRecordedChunks = [];
  
  let options = { mimeType: 'video/webm;codecs=vp9' };
  if (!MediaRecorder.isTypeSupported(options.mimeType)) {
    options = { mimeType: 'video/webm;codecs=vp8' };
  }
  if (!MediaRecorder.isTypeSupported(options.mimeType)) {
    options = { mimeType: 'video/webm' };
  }
  if (!MediaRecorder.isTypeSupported(options.mimeType)) {
    options = {};
  }
  
  try {
    enrollMediaRecorder = new MediaRecorder(enrollStream, options);
  } catch (err) {
    console.error('MediaRecorder initialization failed:', err);
    enrollMediaRecorder = new MediaRecorder(enrollStream);
  }
  
  enrollMediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) {
      enrollRecordedChunks.push(e.data);
    }
  };
  
  enrollMediaRecorder.onstop = () => {
    const videoBlob = new Blob(enrollRecordedChunks, { type: enrollMediaRecorder.mimeType || 'video/webm' });
    const videoFile = new File([videoBlob], `face_scan_${Date.now()}.webm`, { type: videoBlob.type });
    handleVideoEnrollUpload(videoFile);
    stopWebcamEnroll();
  };
  
  enrollMediaRecorder.start(1000);
  
  webcamEnrollWrapper.classList.add('recording');
  enrollRecordingIndicator.classList.remove('hidden');
  
  let timeLeft = 20.0;
  enrollRecordingTimer.textContent = '20.0s';
  btnRecordEnrollVideo.disabled = true;
  btnStopEnrollWebcam.disabled = true;
  
  enrollRecordTimerInterval = setInterval(() => {
    timeLeft -= 0.1;
    if (timeLeft <= 0) {
      timeLeft = 0;
      clearInterval(enrollRecordTimerInterval);
      enrollRecordTimerInterval = null;
      
      if (enrollMediaRecorder && enrollMediaRecorder.state !== 'inactive') {
        enrollMediaRecorder.stop();
      }
      btnRecordEnrollVideo.disabled = false;
      btnStopEnrollWebcam.disabled = false;
    }
    enrollRecordingTimer.textContent = `${timeLeft.toFixed(1)}s`;
  }, 100);
}

// -------------------------------------------------------------
// Photo Analyzer Logic (Static File Upload)
// -------------------------------------------------------------
function handleManualAnalyzeUpload(file) {
  if (!file) return;
  
  analysisLoader.classList.remove('hidden');
  canvasPlaceholder.classList.add('hidden');
  analyzerCanvas.classList.add('hidden');
  analyzerMatchesList.innerHTML = '';
  
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      analyzerCanvas.width = img.naturalWidth;
      analyzerCanvas.height = img.naturalHeight;
      const ctx = analyzerCanvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      analyzerCanvas.classList.remove('hidden');
      uploadAndProcessAnalyze(file, img);
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

async function uploadAndProcessAnalyze(file, loadedImg) {
  const formData = new FormData();
  formData.append('photo', file);
  
  try {
    const res = await fetch('/api/recognize', {
      method: 'POST',
      body: formData
    });
    
    const result = await res.json();
    analysisLoader.classList.add('hidden');
    
    if (result.success) {
      renderAnalysisResults(result.faces, loadedImg);
    } else {
      analyzerMatchesList.innerHTML = `
        <div class="empty-state-list text-red">
          <i class="fa-solid fa-triangle-exclamation"></i>
          <p>Processing error: ${result.error}</p>
        </div>
      `;
    }
  } catch (err) {
    analysisLoader.classList.add('hidden');
    analyzerMatchesList.innerHTML = `
      <div class="empty-state-list text-red">
        <i class="fa-solid fa-triangle-exclamation"></i>
        <p>Error: ${err.message}</p>
      </div>
    `;
  }
}

function renderAnalysisResults(faces, img) {
  analyzerMatchesList.innerHTML = '';
  const ctx = analyzerCanvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  
  if (faces.length === 0) {
    analyzerMatchesList.innerHTML = `
      <div class="empty-state-list">
        <i class="fa-solid fa-user-slash" style="font-size: 1.5rem; display: block; margin-bottom: 8px;"></i>
        <p>No faces detected in this image.</p>
      </div>
    `;
    return;
  }
  
  faces.forEach((face, idx) => {
    const box = face.box;
    const isKnown = face.is_known;
    const name = isKnown ? face.match.name : (face.gender ? `UNKNOWN (${face.gender})` : 'UNKNOWN');
    const score = (face.score * 100).toFixed(0) + '%';
    const cropFilename = face.crop_filename;
    
    ctx.lineWidth = Math.max(3, Math.round(img.naturalWidth / 250));
    ctx.strokeStyle = isKnown ? '#10b981' : '#ef4444';
    ctx.strokeRect(box[0], box[1], box[2], box[3]);
    
    ctx.fillStyle = isKnown ? '#10b981' : '#ef4444';
    const fontSize = Math.max(12, Math.round(img.naturalWidth / 50));
    ctx.font = `600 ${fontSize}px var(--font-family-body)`;
    const textLabel = `${idx + 1}. ${name} (${score})`;
    const textWidth = ctx.measureText(textLabel).width;
    
    ctx.fillRect(box[0], box[1] - fontSize - 6, textWidth + 10, fontSize + 6);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(textLabel, box[0] + 5, box[1] - 5);
    
    const card = document.createElement('div');
    card.className = 'event-item';
    const cropUrl = cropFilename ? `/crops/${cropFilename}` : 'https://placehold.co/100x100?text=Face';
    const scoreClass = isKnown ? 'match' : 'unknown';
    
    card.innerHTML = `
      <div class="event-crop-wrapper" style="width: 50px; height: 50px;">
        <img src="${cropUrl}" class="event-crop" onerror="this.src='https://placehold.co/100x100?text=Face'">
      </div>
      <div class="event-details" style="gap: 1px;">
        <div class="event-header-row">
          <span class="event-name">${idx + 1}. ${name}</span>
          <span class="event-score-badge ${scoreClass}">${score}</span>
        </div>
        <div class="event-time" style="font-size: 0.7rem;">
          <span>Coords: [${box[0]}, ${box[1]}, ${box[2]}, ${box[3]}]</span>
        </div>
      </div>
    `;
    analyzerMatchesList.appendChild(card);
  });
}

// -------------------------------------------------------------
// Settings UI Syncing & Submitting
// -------------------------------------------------------------
function syncSettingsUI() {
  if (systemSettings.dis_type === 0) {
    disCosineRadio.checked = true;
    settingGroupCosine.classList.remove('hidden');
    settingGroupL2.classList.add('hidden');
  } else {
    disL2Radio.checked = true;
    settingGroupCosine.classList.add('hidden');
    settingGroupL2.classList.remove('hidden');
  }
  
  thresholdCosineSlider.value = systemSettings.threshold;
  valCosine.textContent = Number(systemSettings.threshold).toFixed(3);
  
  thresholdL2Slider.value = systemSettings.threshold;
  valL2.textContent = Number(systemSettings.threshold).toFixed(3);
}

async function saveSettings(settingsObj) {
  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settingsObj)
    });
    const result = await res.json();
    if (result.success) {
      systemSettings = { ...systemSettings, ...result.settings };
      syncSettingsUI();
      alert('Recognition thresholds updated successfully across all stream pipelines!');
    }
  } catch (err) {
    console.error('Failed to save settings:', err);
    alert('Failed to save settings: ' + err.message);
  }
}

// -------------------------------------------------------------
// Mock Video File Loop-Streaming Uploader
// -------------------------------------------------------------
async function handleMockVideoUpload(file) {
  if (!file) return;
  
  mockUploadStatus.innerHTML = `
    <div class="progress-item">
      <div class="spinner" style="width:20px; height:20px; border-width:2px; margin-bottom:8px; display:inline-block; vertical-align:middle; margin-right:8px;"></div>
      <span>Uploading video file and starting FFmpeg RTSP loop stream...</span>
    </div>
  `;
  
  const formData = new FormData();
  formData.append('video', file);
  
  try {
    const res = await fetch('/api/cameras/upload-mock', {
      method: 'POST',
      body: formData
    });
    
    mockUploadStatus.innerHTML = '';
    
    if (res.ok) {
      const camera = await res.json();
      modalAddCamera.classList.add('hidden');
      fetchCameras(); // Update stream viewport and controls sidebar
    } else {
      const err = await res.json();
      mockUploadStatus.innerHTML = `
        <div class="progress-item error">
          <i class="fa-solid fa-circle-exclamation"></i> Upload error: ${err.error}
        </div>
      `;
    }
  } catch (err) {
    mockUploadStatus.innerHTML = `
      <div class="progress-item error">
        <i class="fa-solid fa-circle-exclamation"></i> Network error: ${err.message}
      </div>
    `;
  }
}

// -------------------------------------------------------------
// Event Listeners Configuration
// -------------------------------------------------------------
function setupEventListeners() {
  
  // Clear Events logs
  btnClearEvents.addEventListener('click', async () => {
    if (confirm('Are you sure you want to clear the entire events log history? This will also remove saved cropped faces.')) {
      try {
        await fetch('/api/events', { method: 'DELETE' });
      } catch (err) {
        console.error('Failed to clear events:', err);
      }
    }
  });

  // Event Filter Tabs
  const eventTabBtns = document.querySelectorAll('.event-tab-btn');
  eventTabBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      eventTabBtns.forEach(b => {
        b.classList.remove('active');
        b.style.color = 'var(--text-muted)';
      });
      btn.classList.add('active');
      btn.style.color = 'var(--text-light)';
      currentEventFilter = btn.getAttribute('data-event-filter');
      filterAndRenderEvents();
    });
  });
  
  // Search Database
  dbSearchInput.addEventListener('input', fetchPersons);
  
  // Register New Person Modals
  btnOpenCreatePersonModal.addEventListener('click', () => {
    personNameInput.value = '';
    modalCreatePerson.classList.remove('hidden');
    personNameInput.focus();
  });
  
  const closeCreateModal = () => {
    modalCreatePerson.classList.add('hidden');
  };
  btnCloseCreateModal.addEventListener('click', closeCreateModal);
  btnCancelCreateModal.addEventListener('click', closeCreateModal);
  
  btnSubmitCreatePerson.addEventListener('click', async () => {
    const name = personNameInput.value.trim();
    if (!name) {
      alert('Please enter a name.');
      return;
    }
    const gender = personGenderSelect.value;
    
    try {
      const res = await fetch('/api/persons', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, gender })
      });
      
      if (res.ok) {
        closeCreateModal();
        fetchPersons();
      } else {
        const error = await res.json();
        alert('Error: ' + error.error);
      }
    } catch (err) {
      console.error('Error creating person:', err);
    }
  });
  
  // Close Person Details modal
  const closeDetailsModal = () => {
    stopWebcamEnroll();
    modalPersonDetails.classList.add('hidden');
    currentPersonId = null;
    currentPersonName = null;
  };
  btnCloseDetailsModal.addEventListener('click', closeDetailsModal);
  btnCloseDetailsFooter.addEventListener('click', closeDetailsModal);
  
  // Cluster Details Modal Listeners
  const closeClusterDetailsModal = () => {
    modalClusterDetails.classList.add('hidden');
    document.querySelectorAll('.photo-actions-dropdown .dropdown-menu').forEach(el => el.classList.add('hidden'));
  };
  btnCloseClusterDetailsModal.addEventListener('click', closeClusterDetailsModal);
  btnCloseClusterDetailsFooter.addEventListener('click', closeClusterDetailsModal);
  modalClusterDetails.addEventListener('click', (e) => {
    if (e.target === modalClusterDetails) {
      closeClusterDetailsModal();
    }
  });
  
  // Global click listener to close dropdowns when clicking outside
  document.addEventListener('click', () => {
    document.querySelectorAll('.photo-actions-dropdown .dropdown-menu').forEach(el => el.classList.add('hidden'));
  });
  
  // Mode toggling (Photos vs. Video Enroll)
  btnModePhotos.addEventListener('click', () => {
    btnModePhotos.classList.add('active');
    btnModeVideo.classList.remove('active');
    enrollSectionPhotos.classList.remove('hidden');
    enrollSectionVideo.classList.add('hidden');
    stopWebcamEnroll();
  });
  
  btnModeVideo.addEventListener('click', () => {
    btnModeVideo.classList.add('active');
    btnModePhotos.classList.remove('active');
    enrollSectionVideo.classList.remove('hidden');
    enrollSectionPhotos.classList.add('hidden');
  });

  // File Uploader Setup: Face Database Person details modal (Photos)
  detailsPhotoDropzone.addEventListener('click', () => detailsFileInput.click());
  detailsFileInput.addEventListener('change', (e) => {
    handlePhotoEnrollUpload(e.target.files);
  });
  setupDragDrop(detailsPhotoDropzone, (files) => {
    handlePhotoEnrollUpload(files);
  });

  // File Uploader Setup: Face Database Person details modal (Video)
  detailsVideoDropzone.addEventListener('click', () => detailsVideoInput.click());
  detailsVideoInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      handleVideoEnrollUpload(e.target.files[0]);
    }
  });
  setupDragDrop(detailsVideoDropzone, (files) => {
    if (files.length > 0) {
      handleVideoEnrollUpload(files[0]);
    }
  });

  // Webcam Scanner Action Bindings
  btnStartEnrollWebcam.addEventListener('click', startWebcamEnroll);
  btnRecordEnrollVideo.addEventListener('click', startRecordingEnrollVideo);
  btnStopEnrollWebcam.addEventListener('click', stopWebcamEnroll);
  
  // File Uploader Setup: Photo Analyzer page
  analyzerDropzone.addEventListener('click', () => analyzerFileInput.click());
  analyzerFileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      handleManualAnalyzeUpload(e.target.files[0]);
    }
  });
  setupDragDrop(analyzerDropzone, (files) => {
    if (files.length > 0) {
      handleManualAnalyzeUpload(files[0]);
    }
  });
  
  // Settings view slider interaction listeners
  thresholdCosineSlider.addEventListener('input', (e) => {
    valCosine.textContent = Number(e.target.value).toFixed(3);
  });
  thresholdL2Slider.addEventListener('input', (e) => {
    valL2.textContent = Number(e.target.value).toFixed(3);
  });
  
  // Settings radio check toggles
  disCosineRadio.addEventListener('change', () => {
    settingGroupCosine.classList.remove('hidden');
    settingGroupL2.classList.add('hidden');
  });
  disL2Radio.addEventListener('change', () => {
    settingGroupCosine.classList.add('hidden');
    settingGroupL2.classList.remove('hidden');
  });
  
  // Save Settings Clicked
  btnSaveSettings.addEventListener('click', () => {
    const dis_type = parseInt(document.querySelector('input[name="dis_type"]:checked').value);
    const threshold = dis_type === 0 ? parseFloat(thresholdCosineSlider.value) : parseFloat(thresholdL2Slider.value);
    saveSettings({ dis_type, threshold });
  });

  // Cluster Search Input
  clusterSearchInput.addEventListener('input', fetchClusters);

  // Enroll Cluster Modal Close
  const closeEnrollModal = () => {
    closeEnrollClusterModal();
  };
  btnCloseEnrollClusterModal.addEventListener('click', closeEnrollModal);
  btnCancelEnrollClusterModal.addEventListener('click', closeEnrollModal);

  // Enroll Cluster Submit
  btnSubmitEnrollCluster.addEventListener('click', async () => {
    const clusterId = enrollClusterId.value;
    const name = enrollClusterNameInput.value.trim();
    if (!name) {
      alert('Please enter a name.');
      return;
    }
    
    try {
      const res = await fetch(`/api/clusters/${clusterId}/enroll`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
      });
      
      if (res.ok) {
        closeEnrollModal();
        fetchClusters();
        fetchPersons();
      } else {
        const error = await res.json();
        alert('Error: ' + error.error);
      }
    } catch (err) {
      console.error('Error enrolling cluster:', err);
    }
  });

  // Image Preview Modal Close
  const closePreviewModal = () => {
    modalImagePreview.classList.add('hidden');
  };
  btnClosePreviewModal.addEventListener('click', closePreviewModal);
  modalImagePreview.addEventListener('click', (e) => {
    if (e.target === modalImagePreview) {
      closePreviewModal();
    }
  });

  // -------------------------------------------------------------
  // Add Camera Modal Actions
  // -------------------------------------------------------------
  btnOpenCameramodal.addEventListener('click', () => {
    cameraNameInput.value = '';
    cameraRtspInput.value = '';
    mockUploadStatus.innerHTML = '';
    
    // Activate first modal tab default
    const firstTabBtn = document.querySelector('.modal-tab-btn[data-modal-tab="ip-cam"]');
    if (firstTabBtn) firstTabBtn.click();
    
    modalAddCamera.classList.remove('hidden');
  });

  const closeCameraModal = () => {
    modalAddCamera.classList.add('hidden');
  };
  btnCancelCameraModal.addEventListener('click', closeCameraModal);
  modalAddCamera.querySelector('.btn-close-modal').addEventListener('click', closeCameraModal);

  btnSubmitCameraSource.addEventListener('click', async () => {
    if (activeModalTab !== 'ip-cam') return;

    const name = cameraNameInput.value.trim();
    const url = cameraRtspInput.value.trim();

    if (!name || !url) {
      alert('Please fill in both Name and RTSP URL fields.');
      return;
    }

    try {
      const res = await fetch('/api/cameras', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, type: 'rtsp', url })
      });

      if (res.ok) {
        closeCameraModal();
        fetchCameras();
      } else {
        const error = await res.json();
        alert('Failed to register camera: ' + error.error);
      }
    } catch (err) {
      console.error(err);
      alert('Error: ' + err.message);
    }
  });

  // Mock Video Uploader drag drop setup
  mockVideoDropzone.addEventListener('click', () => mockVideoFileInput.click());
  mockVideoFileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      handleMockVideoUpload(e.target.files[0]);
    }
  });
  setupDragDrop(mockVideoDropzone, (files) => {
    if (files.length > 0) {
      handleMockVideoUpload(files[0]);
    }
  });
}

// -------------------------------------------------------------
// Discovered Profiles (Clusters) Tab Management
// -------------------------------------------------------------
async function fetchClusters() {
  try {
    const res = await fetch('/api/clusters');
    const data = await res.json();
    allClusters = data;
    renderClusters(data);
  } catch (err) {
    console.error('Error fetching clusters:', err);
  }
}

function renderClusters(clusters) {
  clustersGrid.innerHTML = '';
  const query = clusterSearchInput.value.toLowerCase().trim();
  const filtered = clusters.filter(c => c.name.toLowerCase().includes(query));
  
  if (filtered.length === 0) {
    clustersGrid.innerHTML = `
      <div class="empty-state" style="grid-column: 1 / -1;">
        <i class="fa-solid fa-folder-open"></i>
        <p>${query ? 'No matching profiles found.' : 'No discovered profiles yet. Unknown faces detected in live streams will appear here.'}</p>
      </div>
    `;
    return;
  }
  
  filtered.forEach(c => {
    const card = document.createElement('div');
    card.className = 'person-card';
    
    let thumbsHTML = '';
    if (c.photos && c.photos.length > 0) {
      c.photos.slice(0, 5).forEach(ph => {
        thumbsHTML += `<img src="/crops/${ph.filename}" class="person-thumb" onerror="this.style.display='none'">`;
      });
      if (c.photos.length > 5) {
        thumbsHTML += `<span class="badge">+${c.photos.length - 5}</span>`;
      }
    } else {
      thumbsHTML = '<span class="person-thumbs-empty">No photos</span>';
    }
    
    const formattedDate = new Date(c.created_at).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
    
    card.innerHTML = `
      <div class="person-top">
        <div class="person-info">
          <span class="person-title">${c.name}</span>
          <span class="person-date">Discovered ${formattedDate}</span>
        </div>
        <button class="person-delete-btn" title="Delete Profile" data-id="${c.id}">
          <i class="fa-regular fa-trash-can"></i>
        </button>
      </div>
      <div class="person-thumbs-row" style="cursor: pointer;" title="Manage Photos">
        ${thumbsHTML}
      </div>
      <div class="person-footer">
        <span class="photos-count">
          <i class="fa-solid fa-image"></i>
          <span>${c.photos.length} detections</span>
        </span>
        <button class="btn btn-primary btn-enroll-cluster" data-id="${c.id}">
          Enroll Profile
        </button>
      </div>
    `;
    
    card.querySelector('.person-delete-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirm(`Delete discovered profile "${c.name}"? This will delete all its temporary crops.`)) {
        deleteCluster(c.id);
      }
    });
    
    card.querySelector('.btn-enroll-cluster').addEventListener('click', (e) => {
      e.stopPropagation();
      openEnrollClusterModal(c.id, c.name);
    });
    
    card.querySelector('.person-thumbs-row').addEventListener('click', () => {
      openClusterDetailsModal(c.id, c.name);
    });
    
    clustersGrid.appendChild(card);
  });
}

async function deleteCluster(id) {
  try {
    const res = await fetch(`/api/clusters/${id}`, { method: 'DELETE' });
    const result = await res.json();
    if (result.success) {
      fetchClusters();
    }
  } catch (err) {
    console.error('Failed to delete cluster:', err);
  }
}

function openEnrollClusterModal(id, name) {
  enrollClusterId.value = id;
  enrollClusterNameInput.value = name.split(' (')[0];
  modalEnrollCluster.classList.remove('hidden');
  enrollClusterNameInput.focus();
}

function closeEnrollClusterModal() {
  modalEnrollCluster.classList.add('hidden');
  enrollClusterId.value = '';
  enrollClusterNameInput.value = '';
}

function openClusterDetailsModal(clusterId, name) {
  const cluster = allClusters.find(c => c.id === clusterId);
  if (!cluster) return;
  
  clusterDetailsTitle.textContent = `${name} - Detections`;
  clusterPhotosGrid.innerHTML = '';
  
  cluster.photos.forEach(ph => {
    const card = document.createElement('div');
    card.className = 'photo-card';
    card.innerHTML = `
      <img src="/crops/${ph.filename}" class="photo-img" onerror="this.src='/img/placeholder.png'">
      <div class="photo-actions-dropdown">
        <button class="btn-icon btn-dots" title="Options">
          <i class="fa-solid fa-ellipsis-vertical"></i>
        </button>
        <div class="dropdown-menu hidden">
          <div class="dropdown-header">Move to Registered Person</div>
          <div class="dropdown-persons-list">
            <!-- Dynamic persons list -->
          </div>
        </div>
      </div>
    `;
    
    const btnDots = card.querySelector('.btn-dots');
    const dropdownMenu = card.querySelector('.dropdown-menu');
    btnDots.addEventListener('click', (e) => {
      e.stopPropagation();
      document.querySelectorAll('.photo-actions-dropdown .dropdown-menu').forEach(el => {
        if (el !== dropdownMenu) el.classList.add('hidden');
      });
      dropdownMenu.classList.toggle('hidden');
    });
    
    const personsListContainer = card.querySelector('.dropdown-persons-list');
    
    // Add "Register New Person" option at the top
    const newPersonItem = document.createElement('div');
    newPersonItem.className = 'dropdown-item';
    newPersonItem.style.fontWeight = 'bold';
    newPersonItem.style.color = 'var(--primary)';
    newPersonItem.innerHTML = `<i class="fa-solid fa-plus" style="margin-right: 6px;"></i> Register New Person`;
    newPersonItem.addEventListener('click', async (e) => {
      e.stopPropagation();
      dropdownMenu.classList.add('hidden');
      const newName = prompt("Enter name for the new person:");
      if (newName && newName.trim() !== '') {
        await movePhotoToPerson(clusterId, ph.id, null, newName);
      }
    });
    personsListContainer.appendChild(newPersonItem);
    
    if (allPersons.length === 0) {
      // No existing registered persons
    } else {
      allPersons.forEach(person => {
        const item = document.createElement('div');
        item.className = 'dropdown-item';
        item.textContent = person.name;
        item.addEventListener('click', async (e) => {
          e.stopPropagation();
          dropdownMenu.classList.add('hidden');
          await movePhotoToPerson(clusterId, ph.id, person.id, person.name);
        });
        personsListContainer.appendChild(item);
      });
    }
    
    clusterPhotosGrid.appendChild(card);
  });
  
  modalClusterDetails.classList.remove('hidden');
}

function closeClusterDetailsModal() {
  modalClusterDetails.classList.add('hidden');
  document.querySelectorAll('.photo-actions-dropdown .dropdown-menu').forEach(el => el.classList.add('hidden'));
}

async function movePhotoToPerson(clusterId, photoId, personId, name) {
  try {
    const res = await fetch(`/api/clusters/${clusterId}/photos/${photoId}/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ personId, name })
    });
    const result = await res.json();
    if (result.success) {
      // Re-fetch clusters and database, and update the open modal!
      await fetchClusters();
      await fetchPersons();
      
      // Update modal view if the cluster still has photos
      const updatedCluster = allClusters.find(c => c.id === clusterId);
      if (updatedCluster && updatedCluster.photos.length > 0) {
        openClusterDetailsModal(clusterId, updatedCluster.name);
      } else {
        closeClusterDetailsModal();
      }
    } else {
      alert('Error: ' + result.error);
    }
  } catch (err) {
    console.error('Error moving photo:', err);
  }
}

// Drag & Drop helper utility
function setupDragDrop(element, callback) {
  ['dragenter', 'dragover'].forEach(eventName => {
    element.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      element.classList.add('dragover');
    }, false);
  });
  
  ['dragleave', 'drop'].forEach(eventName => {
    element.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      element.classList.remove('dragover');
    }, false);
  });
  
  element.addEventListener('drop', (e) => {
    const dt = e.dataTransfer;
    const files = dt.files;
    callback(files);
  }, false);
}
