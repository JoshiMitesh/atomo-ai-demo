const { registerOnAtomicCenter, waitForDeviceInMesh, countNodesInMesh, removeEmptyDefaultGroups, updateCloudDeviceStatus } = require('./meshcentral-register');
const { canAutoInstall, runMeshAgentInstall, verifyMeshGroupDownload } = require('./mesh-agent-install');
const os = require('os');

function createPhaseTracker() {
  const phases = [];
  return {
    phases,
    start(id, label) {
      phases.push({ id, label, status: 'running', message: label });
      return phases.length - 1;
    },
    done(index, message) {
      if (phases[index]) {
        phases[index].status = 'done';
        phases[index].message = message;
      }
    },
    fail(index, message) {
      if (phases[index]) {
        phases[index].status = 'failed';
        phases[index].message = message;
      }
    },
  };
}

async function runAtomicRegistration({
  username,
  atomicPassword,
  userId,
  profilePayload,
  operatingSystem,
  sudoPassword,
}) {
  const tracker = createPhaseTracker();
  let meshCentral = null;
  let agentInstall = null;
  let meshId = null;

  const groupIdx = tracker.start('group', 'Creating device group on Atomic Center…');
  try {
    const atomic = await registerOnAtomicCenter({
      username,
      password: atomicPassword,
      userId,
      profilePayload,
    });
    meshCentral = atomic.meshCentral;
    meshId = atomic.meshId;
    tracker.done(groupIdx, meshCentral.meshGroupCreated
      ? `Group "${meshCentral.meshGroupName}" created.`
      : `Using existing group "${meshCentral.meshGroupName}".`);

    if (meshId && atomicPassword) {
      const cleanup = await removeEmptyDefaultGroups({
        username,
        password: atomicPassword,
        keepMeshId: meshId,
      });
      if (cleanup.removed.length) {
        meshCentral.removedDefaultGroups = cleanup.removed;
      }
    }

    if (meshCentral.profileStoredOnCloud) {
      tracker.phases.push({
        id: 'cloud',
        label: 'Saving device profile to Atomic Center database…',
        status: 'done',
        message: 'Device profile saved on AWS.',
      });
    } else if (meshCentral.cloudSaveError) {
      tracker.phases.push({
        id: 'cloud',
        label: 'Saving device profile to Atomic Center database…',
        status: 'failed',
        message: meshCentral.cloudSaveError,
      });
    }
  } catch (e) {
    tracker.fail(groupIdx, e.message);
    const err = new Error(e.message);
    err.phases = tracker.phases;
    throw err;
  }

  let baselineCount = 0;
  if (meshId) {
    try {
      baselineCount = await countNodesInMesh({ username, password: atomicPassword, meshId });
    } catch {
      baselineCount = 0;
    }
  }

  if (canAutoInstall(operatingSystem)) {
    const agentIdx = tracker.start('agent', 'Installing MeshCentral agent on this device…');
    const meshCheck = await verifyMeshGroupDownload(meshId);
    if (!meshCheck.ok) {
      agentInstall = { ok: false, error: meshCheck.error };
      tracker.fail(agentIdx, meshCheck.error);
    } else {
      agentInstall = await runMeshAgentInstall(meshId, operatingSystem, sudoPassword);
      if (agentInstall.ok) {
        tracker.done(agentIdx, 'MeshCentral agent installed.');
      } else if (agentInstall.skipped && agentInstall.reason === 'sudo_password_required') {
        tracker.fail(agentIdx, agentInstall.error || 'Device password is required to install the agent.');
      } else {
        tracker.fail(agentIdx, agentInstall.error || 'Agent install failed.');
      }
    }
  }

  if (meshId) {
    const waitIdx = tracker.start('wait', 'Waiting for device to appear on Atomic Center…');
    try {
      const waitResult = await waitForDeviceInMesh({
        username,
        password: atomicPassword,
        meshId,
        deviceName: profilePayload.deviceName,
        hostName: os.hostname(),
        baselineCount,
        maxWaitMs: 120000,
      });
      meshCentral.deviceOnline = waitResult.ok;
      meshCentral.deviceWaitMs = waitResult.waitedMs;
      if (waitResult.ok && waitResult.node) {
        meshCentral.nodeId = waitResult.node._id;
        meshCentral.nodeName = waitResult.node.name;
        tracker.done(waitIdx, `Device "${waitResult.node.name}" is online.`);

        if (meshCentral.profileStoredOnCloud && userId) {
          const cloudUpdate = await updateCloudDeviceStatus({
            userId,
            username,
            deviceSerial: profilePayload.deviceSerial,
            meshId,
            meshGroupName: meshCentral.meshGroupName,
            nodeId: waitResult.node._id,
            nodeName: waitResult.node.name,
            agentStatus: 'online',
          });
          if (cloudUpdate.ok) {
            meshCentral.agentStatus = 'online';
          }
        }
      } else {
        tracker.fail(waitIdx, 'Device not visible yet — it may appear in Atomic Center shortly.');
      }
    } catch (e) {
      meshCentral.deviceOnline = false;
      tracker.fail(waitIdx, e.message);
    }
  }

  let message = meshCentral.message || 'Device registered on Atomic Center.';
  if (meshCentral.deviceOnline) {
    message = `Device "${meshCentral.nodeName || profilePayload.deviceName}" is now on Atomic Center.`;
  } else if (agentInstall?.ok) {
    message += ' Agent installed — refresh Atomic Center in a minute if the device is not visible yet.';
  } else if (agentInstall && !agentInstall.ok) {
    message += ` Agent install issue: ${agentInstall.error || 'check device password'}.`;
  }

  return {
    message,
    meshCentral,
    agentInstall,
    phases: tracker.phases,
    success: true,
    partial: !meshCentral.deviceOnline,
  };
}

module.exports = {
  runAtomicRegistration,
};
