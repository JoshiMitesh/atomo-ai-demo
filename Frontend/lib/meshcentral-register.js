const WebSocket = require('ws');
const os = require('os');
const { getMeshcentralUrl, allowInsecureTls } = require('./device-config');
const { proxyJson } = require('./meshcentral-client');
const { buildAgentInstallInfo } = require('./mesh-agent-install');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildWssUrl() {
  const base = getMeshcentralUrl().replace(/\/$/, '');
  if (base.startsWith('https://')) return `wss://${base.slice(8)}/control.ashx`;
  if (base.startsWith('http://')) return `ws://${base.slice(7)}/control.ashx`;
  return `${base}/control.ashx`;
}

function isHtmlError(data) {
  const text = typeof data?.error === 'string' ? data.error : '';
  return text.includes('<!DOCTYPE') || text.includes('<html');
}

function shouldUseWebSocketFallback(cloud) {
  if (!cloud) return true;
  if (cloud.status === 404 || cloud.status === 403) return true;
  if (isHtmlError(cloud.data)) return true;
  return false;
}

function flattenMeshes(meshesRaw) {
  if (!meshesRaw) return [];
  if (Array.isArray(meshesRaw)) return meshesRaw;
  return Object.values(meshesRaw);
}

function flattenNodes(nodesRaw) {
  if (!nodesRaw) return [];
  if (Array.isArray(nodesRaw)) return nodesRaw;

  const flat = [];
  for (const key of Object.keys(nodesRaw)) {
    const bucket = nodesRaw[key];
    if (Array.isArray(bucket)) {
      flat.push(...bucket);
    } else if (bucket && typeof bucket === 'object') {
      for (const nodeId of Object.keys(bucket)) {
        const node = bucket[nodeId];
        if (node && typeof node === 'object') flat.push(node);
      }
    }
  }
  return flat;
}

function normalizeNodeList(nodesRaw) {
  const nodes = flattenNodes(nodesRaw);
  return Array.isArray(nodes) ? nodes : [];
}

const DEFAULT_AUTO_GROUP_NAMES = new Set(['my devices']);

function listMeshesViaWebSocket({ username, password }) {
  return withMeshWebSocket({
    username,
    password,
    onReady(ws, finish) {
      ws.on('message', (raw) => {
        let data;
        try {
          data = JSON.parse(raw);
        } catch {
          return;
        }

        if (data.action === 'close' || data.msg === 'noauth' || data.msg === 'notok') {
          finish(new Error(data.msg || 'Atomic Center authentication failed.'));
          return;
        }

        if (data.action === 'meshes') {
          finish(null, flattenMeshes(data.meshes));
        }
      });

      ws.send(JSON.stringify({ action: 'meshes', responseid: 'atomoforge' }));
    },
  });
}

function deleteMeshViaWebSocket({ username, password, meshId, meshName }) {
  return withMeshWebSocket({
    username,
    password,
    onReady(ws, finish) {
      ws.on('message', (raw) => {
        let data;
        try {
          data = JSON.parse(raw);
        } catch {
          return;
        }

        if (data.action === 'close' || data.msg === 'noauth' || data.msg === 'notok') {
          finish(new Error(data.msg || 'Atomic Center authentication failed.'));
          return;
        }

        if (data.action === 'deletemesh') {
          if (data.responseid && data.responseid !== 'atomoforge') return;
          if (data.result === 'ok') finish(null, true);
          else finish(new Error(String(data.result || 'Failed to delete device group.')));
        }
      });

      ws.send(
        JSON.stringify({
          action: 'deletemesh',
          meshid: meshId,
          meshname: meshName,
          responseid: 'atomoforge',
        })
      );
    },
  });
}

/** Remove legacy empty "My Devices" groups left over before autodevicegroup was disabled. */
async function removeEmptyDefaultGroups({ username, password, keepMeshId }) {
  let meshes = [];
  try {
    meshes = await listMeshesViaWebSocket({ username, password });
  } catch (e) {
    console.warn('[Atomic Center] Could not list groups for cleanup:', e.message);
    return { removed: [] };
  }

  const removed = [];
  for (const mesh of meshes) {
    if (!mesh || mesh.deleted || mesh.mtype !== 2) continue;
    if (mesh._id === keepMeshId) continue;
    if (!DEFAULT_AUTO_GROUP_NAMES.has(String(mesh.name || '').trim().toLowerCase())) continue;

    let nodeCount = 0;
    try {
      nodeCount = await countNodesInMesh({ username, password, meshId: mesh._id });
    } catch {
      continue;
    }
    if (nodeCount > 0) continue;

    try {
      await deleteMeshViaWebSocket({
        username,
        password,
        meshId: mesh._id,
        meshName: mesh.name,
      });
      removed.push(mesh.name);
      console.log(`[Atomic Center] Removed empty default group "${mesh.name}"`);
    } catch (e) {
      console.warn(`[Atomic Center] Could not remove "${mesh.name}":`, e.message);
    }
  }

  return { removed };
}

function withMeshWebSocket({ username, password, onReady, timeoutMs = 45000 }) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(buildWssUrl(), {
      rejectUnauthorized: !allowInsecureTls(),
      headers: {
        'x-meshauth': `${Buffer.from(username).toString('base64')},${Buffer.from(password).toString('base64')}`,
      },
    });

    const timeout = setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      reject(new Error('Atomic Center connection timed out.'));
    }, timeoutMs);

    const finish = (err, result) => {
      clearTimeout(timeout);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      if (err) reject(err);
      else resolve(result);
    };

    ws.on('open', () => onReady(ws, finish));

    ws.on('error', (err) => finish(err));
  });
}

function registerViaWebSocket({ username, password, meshGroupName, profileDesc }) {
  let stage = 'list';

  return withMeshWebSocket({
    username,
    password,
    onReady(ws, finish) {
      ws.on('message', (raw) => {
        let data;
        try {
          data = JSON.parse(raw);
        } catch {
          return;
        }

        if (data.action === 'close' || data.msg === 'noauth' || data.msg === 'notok') {
          finish(new Error(data.msg || 'Atomic Center authentication failed.'));
          return;
        }

        if (stage === 'list' && data.action === 'meshes') {
          const meshes = flattenMeshes(data.meshes);
          const existing = meshes.find((m) => m.name === meshGroupName && m.mtype === 2 && !m.deleted);
          if (existing) {
            finish(null, {
              meshId: existing._id,
              meshGroupName: existing.name,
              meshGroupCreated: false,
              method: 'websocket',
            });
            return;
          }

          stage = 'create';
          ws.send(
            JSON.stringify({
              action: 'createmesh',
              meshname: meshGroupName,
              meshtype: 2,
              desc: profileDesc || 'Created via Atomo Forge device registration',
              responseid: 'atomoforge',
            })
          );
          return;
        }

        if (stage === 'create' && data.action === 'createmesh' && data.responseid === 'atomoforge') {
          if (data.result === 'ok' && data.meshid) {
            finish(null, {
              meshId: data.meshid,
              meshGroupName,
              meshGroupCreated: true,
              method: 'websocket',
            });
            return;
          }
          finish(new Error(String(data.result || 'Failed to create device group on Atomic Center.')));
        }
      });

      ws.send(JSON.stringify({ action: 'meshes', responseid: 'atomoforge' }));
    },
  });
}

function listNodesInMesh({ username, password, meshId }) {
  return withMeshWebSocket({
    username,
    password,
    onReady(ws, finish) {
      ws.on('message', (raw) => {
        let data;
        try {
          data = JSON.parse(raw);
        } catch {
          return;
        }

        if (data.action === 'close' || data.msg === 'noauth' || data.msg === 'notok') {
          finish(new Error(data.msg || 'Atomic Center authentication failed.'));
          return;
        }

        if (data.action === 'nodes') {
          if (data.responseid && data.responseid !== 'atomoforge') return;
          if (data.result && data.result !== 'ok') {
            finish(new Error(String(data.result)));
            return;
          }
          finish(null, normalizeNodeList(data.nodes));
        }
      });

      ws.send(JSON.stringify({ action: 'nodes', meshid: meshId, responseid: 'atomoforge' }));
    },
  });
}

async function countNodesInMesh({ username, password, meshId }) {
  const nodes = await listNodesInMesh({ username, password, meshId });
  return nodes.length;
}

async function waitForDeviceInMesh({
  username,
  password,
  meshId,
  deviceName,
  hostName,
  maxWaitMs = 90000,
  baselineCount = 0,
  onProgress,
}) {
  const start = Date.now();
  const needles = [
    String(deviceName || '').trim().toLowerCase(),
    String(hostName || os.hostname() || '').trim().toLowerCase(),
  ].filter(Boolean);

  while (Date.now() - start < maxWaitMs) {
    if (onProgress) {
      const elapsed = Math.round((Date.now() - start) / 1000);
      onProgress(`Waiting for device on Atomic Center… (${elapsed}s)`);
    }

    let nodes = [];
    try {
      nodes = await listNodesInMesh({ username, password, meshId });
    } catch (e) {
      console.warn('[Atomic Center] Node poll failed:', e.message);
      await sleep(3000);
      continue;
    }

    if (!Array.isArray(nodes)) nodes = normalizeNodeList(nodes);

    const byName = needles.length
      ? nodes.find((n) => {
          const nodeName = String(n.name || '').toLowerCase();
          return needles.some((needle) => nodeName.includes(needle));
        })
      : null;
    if (byName) {
      return { ok: true, node: byName, waitedMs: Date.now() - start };
    }

    if (nodes.length > baselineCount) {
      return { ok: true, node: nodes[nodes.length - 1], waitedMs: Date.now() - start };
    }

    await sleep(3000);
  }

  return { ok: false, waitedMs: Date.now() - start };
}

async function saveDeviceProfileToCloud({ userId, username, profilePayload, meshId, meshGroupName }) {
  const body = {
    userId,
    username,
    meshId,
    meshGroupName,
    ...profilePayload,
  };

  try {
    const profileApi = await proxyJson('/api/atomoforge/devices/profile', 'POST', body);
    if (profileApi.status >= 200 && profileApi.status < 300 && profileApi.data.success) {
      return {
        ok: true,
        deviceRecordId: profileApi.data.deviceRecordId,
        method: 'profile',
      };
    }
    if (!shouldUseWebSocketFallback(profileApi) && profileApi.status !== 404) {
      return {
        ok: false,
        error: profileApi.data?.error || `Cloud profile save failed (HTTP ${profileApi.status}).`,
      };
    }
  } catch (e) {
    if (!meshId) {
      /* try register fallback below */
    }
  }

  try {
    const regApi = await proxyJson('/api/atomoforge/devices/register', 'POST', {
      ...body,
      registerMeshCentral: false,
    });
    if (regApi.status >= 200 && regApi.status < 300 && regApi.data.success) {
      if (regApi.data.profileStoredOnCloud || regApi.data.deviceRecordId) {
        return {
          ok: true,
          deviceRecordId: regApi.data.deviceRecordId,
          method: 'register',
          profileStoredOnCloud: true,
        };
      }
    }
    if (!shouldUseWebSocketFallback(regApi)) {
      const staleApi =
        regApi.data?.success &&
        !regApi.data?.profileStoredOnCloud &&
        !regApi.data?.deviceRecordId;
      return {
        ok: false,
        error: staleApi
          ? 'Atomic Center API is outdated — deploy latest atomoforge-api.js to AWS (./scripts/deploy-atomic-center-api.sh).'
          : regApi.data?.error || `Cloud save failed (HTTP ${regApi.status}).`,
      };
    }
  } catch (e) {
    if (!meshId) {
      return { ok: false, error: e.message };
    }
  }

  if (meshId) {
    return saveProfileOnCloud({ userId, username, profilePayload, meshId, meshGroupName });
  }

  return {
    ok: false,
    error:
      'Cloud profile API not deployed on Atomic Center. Run ./scripts/deploy-atomic-center-api.sh on AWS.',
  };
}

async function saveProfileOnCloud({ userId, username, profilePayload, meshId, meshGroupName }) {
  try {
    const cloud = await proxyJson('/api/atomoforge/devices/save', 'POST', {
      userId,
      username,
      meshId,
      meshGroupName,
      ...profilePayload,
    });

    if (cloud.status >= 200 && cloud.status < 300 && cloud.data.success) {
      return {
        ok: true,
        deviceRecordId: cloud.data.deviceRecordId,
        agentStatus: cloud.data.agentStatus,
      };
    }

    if (shouldUseWebSocketFallback(cloud)) {
      return {
        ok: false,
        error: 'Cloud save API not deployed on Atomic Center. Upload atomoforge-api.js to AWS and restart MeshCentral.',
      };
    }

    return { ok: false, error: cloud.data?.error || `Cloud save failed (HTTP ${cloud.status}).` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function updateCloudDeviceStatus({ userId, username, deviceSerial, meshId, meshGroupName, nodeId, nodeName, agentStatus }) {
  try {
    const cloud = await proxyJson('/api/atomoforge/devices/update', 'POST', {
      userId,
      username,
      deviceSerial,
      meshId,
      meshGroupName,
      nodeId,
      nodeName,
      agentStatus: agentStatus || 'online',
    });

    if (cloud.status >= 200 && cloud.status < 300 && cloud.data.success) {
      return { ok: true, deviceRecordId: cloud.data.deviceRecordId };
    }

    if (shouldUseWebSocketFallback(cloud)) {
      return { ok: false, skipped: true };
    }

    return { ok: false, error: cloud.data?.error || `Cloud update failed (HTTP ${cloud.status}).` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function registerOnAtomicCenter({ username, password, userId, profilePayload }) {
  const meshGroupName = profilePayload.meshGroupName;
  const profileDesc = [
    profilePayload.deviceSerial,
    profilePayload.deviceName,
    profilePayload.organizationName,
    profilePayload.city,
    profilePayload.country,
  ]
    .filter(Boolean)
    .join(' | ');

  let cloud = null;
  try {
    cloud = await proxyJson('/api/atomoforge/devices/register', 'POST', {
      userId,
      username,
      password,
      deviceId: profilePayload.deviceId,
      ...profilePayload,
    });
  } catch (e) {
    cloud = { status: 503, data: { error: e.message } };
  }

  if (!shouldUseWebSocketFallback(cloud) && cloud.status >= 200 && cloud.status < 300 && cloud.data.success) {
    return {
      success: true,
      message: cloud.data.message,
      meshCentral: {
        ...cloud.data,
        profileStoredOnCloud: true,
        method: 'rest',
      },
      meshId: cloud.data.meshId,
      installCommand: cloud.data.installCommand,
      downloadUrl: cloud.data.downloadUrl,
      method: 'rest',
    };
  }

  if (!password) {
    throw new Error('Your session expired. Please sign in again, then register the device.');
  }

  console.warn('[Atomic Center] REST register unavailable — using WebSocket fallback');
  console.warn('[Atomic Center] Deploy atomoforge-api.js on AWS to enable REST registration.');
  const wsResult = await registerViaWebSocket({
    username,
    password,
    meshGroupName,
    profileDesc,
  });

  console.log('[Atomic Center] Device group ready:', wsResult.meshGroupName, wsResult.meshId);

  const saveResult = await saveDeviceProfileToCloud({
    userId,
    username,
    profilePayload,
    meshId: wsResult.meshId,
    meshGroupName: wsResult.meshGroupName,
  });

  if (saveResult.ok) {
    console.log('[Atomic Center] Device profile saved to AWS database:', saveResult.deviceRecordId);
  } else {
    console.warn('[Atomic Center] Could not save profile to AWS database:', saveResult.error);
  }

  const installInfo = buildAgentInstallInfo(wsResult.meshId, profilePayload.operatingSystem);
  const message = wsResult.meshGroupCreated
    ? 'Device group created on Atomic Center.'
    : 'Device added to existing group on Atomic Center.';

  return {
    success: true,
    message,
    meshId: wsResult.meshId,
    meshCentral: {
      success: true,
      message,
      meshCentralEnabled: true,
      meshId: wsResult.meshId,
      meshGroupName: wsResult.meshGroupName,
      meshGroupCreated: wsResult.meshGroupCreated,
      meshCentralUrl: getMeshcentralUrl(),
      downloadUrl: installInfo.downloadUrl || null,
      platform: installInfo.platform,
      installMessage: installInfo.message,
      method: 'websocket',
      profileStoredOnCloud: saveResult.ok,
      deviceRecordId: saveResult.deviceRecordId || null,
      cloudSaveError: saveResult.ok ? null : saveResult.error,
    },
    downloadUrl: installInfo.downloadUrl || null,
    method: 'websocket',
  };
}

module.exports = {
  registerOnAtomicCenter,
  waitForDeviceInMesh,
  countNodesInMesh,
  removeEmptyDefaultGroups,
  saveDeviceProfileToCloud,
  saveProfileOnCloud,
  updateCloudDeviceStatus,
  shouldUseWebSocketFallback,
};
