const TABS = {
  person: {
    slug: 'person',
    title: 'Person',
    pageTitle: 'Person Detection',
    aiModelId: 'yolov8-perimeter',
    modelName: 'YOLOv8 Perimeter',
    modelVersion: 'v8.2.1',
    description: 'Real-time person detection, counting, tracking, and zone-aware alerts across assigned cameras.',
    featureOptions: [
      { id: 'detectPeople', label: 'Detect people', description: 'Core person class detection on every frame', locked: true },
      { id: 'countPeople', label: 'Count people', description: 'Live headcount across assigned camera feeds' },
      { id: 'boundingBoxes', label: 'Show bounding boxes', description: 'Draw detection boxes on stream preview and snapshots' },
      { id: 'trackMovement', label: 'Track movement', description: 'Follow person paths across consecutive frames' },
      { id: 'peopleCountLogs', label: 'Generate people count logs', description: 'Write timestamped count entries to the activity log' },
      { id: 'personPresence', label: 'Detect person presence', description: 'Raise presence state when at least one person is visible' },
      { id: 'filterSmallObjects', label: 'Filter small objects', description: 'Ignore detections below the minimum object size' },
    ],
    alertOptions: [
      { id: 'person-detected', label: 'Person detected', defaultEnabled: true },
      { id: 'person-not-detected', label: 'Person not detected', defaultEnabled: false },
      { id: 'too-many-people', label: 'Too many people', defaultEnabled: false },
      { id: 'person-restricted-area', label: 'Danger zone', defaultEnabled: true, description: 'Alert when a person enters a drawn danger zone' },
    ],
  },
  'fire-smoke': {
    slug: 'fire-smoke',
    title: 'Fire & Smoke',
    pageTitle: 'Fire & Smoke Detection',
    aiModelId: 'fire-smoke',
    modelName: 'Fire & Smoke',
    modelVersion: 'v3.1.0',
    description: 'Early fire and smoke detection with thermal-friendly confidence tuning.',
    requiresSubscription: true,
    subscription: {
      headline: 'Subscribe to unlock Fire & Smoke detection',
      summary:
        'Detect flames and smoke early across your camera fleet with tuned confidence thresholds and instant alerts.',
      features: [
        'Real-time fire and smoke detection on live streams',
        'Perimeter intrusion alerts tied to heat and smoke events',
        'Confidence tuning for indoor and outdoor cameras',
        'Event gallery with snapshots for every alert',
      ],
      planLabel: 'Add-on model',
      ctaLabel: 'Request subscription',
    },
    alertOptions: [
      { id: 'fire-smoke-alert', label: 'Fire / smoke alert' },
      { id: 'intrusion-perimeter', label: 'Perimeter intrusion' },
    ],
  },
  face: {
    slug: 'face',
    title: 'Face',
    pageTitle: 'Face Recognition',
    aiModelId: 'face-recog',
    modelName: 'Face Recognition',
    modelVersion: 'v2.4.3',
    description: 'Face detection, enrollment, watchlist matching, and real-time recognition across assigned cameras.',
    featureOptions: [
      { id: 'faceDetection', label: 'Face detection', description: 'Detect faces in live camera streams', locked: true },
      { id: 'faceRecognition', label: 'Face recognition', description: 'Match detected faces against enrolled database' },
      { id: 'genderClassification', label: 'Gender classification', description: 'Estimate gender attribute on detected faces' },
      { id: 'boundingBoxes', label: 'Show bounding boxes', description: 'Draw face boxes on live preview' },
      { id: 'showMatchLabels', label: 'Show match labels', description: 'Display recognized person name on overlay' },
      { id: 'unknownFaceAlerts', label: 'Unknown face alerts', description: 'Generate alerts for unrecognized faces' },
    ],
    alertOptions: [
      { id: 'face-detected', label: 'Face detected (photo event)', defaultEnabled: true },
      { id: 'known-face-recognized', label: 'Known face recognized', defaultEnabled: true },
      { id: 'unknown-face-detected', label: 'Unknown face detected', defaultEnabled: true },
      { id: 'unauthorized-person', label: 'Unauthorized person detected', defaultEnabled: true },
      { id: 'vip-person', label: 'VIP person detected', defaultEnabled: true },
      { id: 'blacklisted-person', label: 'Blacklisted person detected', defaultEnabled: true },
    ],
  },
  safety: {
    slug: 'safety',
    title: 'Safety',
    pageTitle: 'Safety & PPE',
    aiModelId: 'ppe-detection',
    modelName: 'PPE Detection',
    modelVersion: 'v1.8.2',
    description: 'PPE and safety compliance monitoring for industrial zones.',
    requiresSubscription: true,
    subscription: {
      headline: 'Subscribe to unlock Safety & PPE',
      summary:
        'Monitor helmets, vests, and site PPE compliance in industrial zones with automated violation alerts.',
      features: [
        'PPE detection for helmets, vests, and site gear',
        'Safety violation alerts with camera and zone context',
        'Compliance monitoring for industrial floors',
        'Exportable event history for audits',
      ],
      planLabel: 'Add-on model',
      ctaLabel: 'Request subscription',
    },
    alertOptions: [
      { id: 'ppe-missing', label: 'PPE violation' },
      { id: 'intrusion-perimeter', label: 'Perimeter intrusion' },
    ],
  },
};

function getTab(slug) {
  return TABS[slug] || null;
}

function listSlugs() {
  return Object.keys(TABS);
}

module.exports = {
  TABS,
  getTab,
  listSlugs,
};
