const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { promisify } = require('util');
const { getMeshcentralUrl, allowInsecureTls } = require('./device-config');
const { checkMeshGroupDownload } = require('./meshcentral-client');

const execFileAsync = promisify(execFile);
const AGENT_PATHS = ['/usr/local/mesh/meshagent', '/usr/mesh/meshagent'];
const MSH_PATHS = ['/usr/local/mesh/meshagent.msh', '/usr/mesh/meshagent.msh'];

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function getServerUrl() {
  const base = getMeshcentralUrl().replace(/\/$/, '');
  return base.startsWith('http') ? base : `https://${base}`;
}

function buildAgentInstallInfo(meshId, operatingSystem) {
  const serverUrl = getServerUrl();
  const meshShort = String(meshId).split('/')[2];
  if (!meshShort || meshShort.length < 64) {
    throw new Error(`Invalid device group id from Atomic Center: ${meshId || '(empty)'}`);
  }
  const scriptUrl = `${serverUrl}/meshagents?script=1`;
  const noCert = allowInsecureTls() ? ' --no-check-certificate' : '';
  const osName = String(operatingSystem || 'linux').toLowerCase();

  if (osName === 'windows') {
    return {
      platform: 'windows',
      installCommand: null,
      downloadUrl: `${serverUrl}/meshagents?id=3&meshid=${meshShort}&installflags=0`,
      message: 'Download and run the MeshAgent installer on this Windows device.',
    };
  }

  return {
    platform: osName,
    serverUrl,
    meshShort,
    scriptUrl,
    noCert,
    downloadUrl: null,
    message: 'MeshAgent install for Linux / macOS.',
  };
}

function canAutoInstall(operatingSystem) {
  const osName = String(operatingSystem || os.platform()).toLowerCase();
  if (osName === 'linux' || osName === 'embedded') return true;
  if (osName === 'macos' && (os.platform() === 'darwin' || os.platform() === 'linux')) return true;
  return os.platform() === 'linux' || os.platform() === 'darwin';
}

function isAgentInstalled() {
  return AGENT_PATHS.some((p) => fs.existsSync(p));
}

async function runShell(command, timeoutMs = 180000) {
  const { stdout, stderr } = await execFileAsync('/bin/bash', ['-lc', command], {
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' },
  });
  return { stdout: stdout || '', stderr: stderr || '' };
}

function sudoPrefix(sudoPassword) {
  return `printf '%s\\n' ${shellEscape(sudoPassword)} | sudo -S -p ''`;
}

async function verifySudoPassword(sudoPassword) {
  if (!sudoPassword) {
    return { ok: false, error: 'Device password (sudo) is required.' };
  }
  try {
    await runShell(`${sudoPrefix(sudoPassword)} true`, 20000);
    return { ok: true };
  } catch (e) {
    const output = `${e.stdout || ''}\n${e.stderr || ''}`.toLowerCase();
    if (output.includes('incorrect password') || output.includes('sorry')) {
      return { ok: false, error: 'Device password (sudo) is incorrect.' };
    }
    return { ok: false, error: 'Could not verify device password (sudo).' };
  }
}

async function verifyMeshGroupDownload(meshId) {
  const info = buildAgentInstallInfo(meshId, 'linux');
  return checkMeshGroupDownload(info.meshShort);
}

function classifyInstallOutput(output) {
  const text = String(output || '').toLowerCase();
  if (text.includes('must be root')) {
    return { ok: false, error: 'Agent install needs root — check the device password.' };
  }
  if (text.includes('password for') || text.includes('sorry, try again')) {
    return { ok: false, error: 'Sudo password was not accepted.' };
  }
  if (text.includes('unable to download device group settings')) {
    return { ok: false, error: 'Could not download mesh settings — device group may not exist on Atomic Center.' };
  }
  if (text.includes('unable to download agent')) {
    return { ok: false, error: 'Could not download MeshAgent binary from Atomic Center.' };
  }
  if (text.includes('device group identifier is not correct')) {
    return { ok: false, error: 'Invalid device group id for agent install.' };
  }
  if (text.includes('agent downloaded')) {
    return { ok: true };
  }
  if (text.includes('error')) {
    return { ok: false, error: 'MeshAgent install reported an error.' };
  }
  return { ok: false, error: 'MeshAgent install did not complete — no confirmation from install script.' };
}

async function verifyAgentRunning() {
  for (const p of AGENT_PATHS) {
    if (fs.existsSync(p)) return true;
  }
  for (const p of MSH_PATHS) {
    if (fs.existsSync(p)) return true;
  }
  try {
    const { stdout } = await runShell('systemctl is-active meshagent 2>/dev/null || true', 10000);
    if (String(stdout).trim() === 'active') return true;
  } catch {
    /* ignore */
  }
  try {
    const { stdout } = await runShell('pgrep -x meshagent >/dev/null && echo yes || true', 10000);
    if (String(stdout).trim() === 'yes') return true;
  } catch {
    /* ignore */
  }
  return false;
}

async function runMeshAgentInstall(meshId, operatingSystem, sudoPassword) {
  let info;
  try {
    info = buildAgentInstallInfo(meshId, operatingSystem);
  } catch (e) {
    return { ok: false, error: e.message };
  }

  if (info.platform === 'windows') {
    return { ok: false, skipped: true, reason: 'windows_manual', downloadUrl: info.downloadUrl };
  }

  const sudoCheck = await verifySudoPassword(sudoPassword);
  if (!sudoCheck.ok) {
    return { ok: false, skipped: true, reason: 'sudo_password_required', error: sudoCheck.error };
  }

  const meshCheck = await checkMeshGroupDownload(info.meshShort);
  if (!meshCheck.ok) {
    console.error('[Agent]', meshCheck.error);
    return { ok: false, error: meshCheck.error };
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomo-mesh-'));
  const scriptPath = path.join(workDir, 'meshinstall.sh');
  let combinedOutput = '';

  try {
    console.log('[Agent] Group verified on Atomic Center. Downloading install script…');
    const wgetCmd =
      `(wget ${shellEscape(info.scriptUrl)}${info.noCert} -O ${shellEscape(scriptPath)} ` +
      `|| curl -L -k -o ${shellEscape(scriptPath)} ${shellEscape(info.scriptUrl)})`;
    await runShell(wgetCmd, 120000);
    await runShell(`chmod 755 ${shellEscape(scriptPath)}`);

    const sudo = sudoPrefix(sudoPassword);

    if (isAgentInstalled()) {
      console.log('[Agent] Removing existing MeshCentral agent before reinstall…');
      const uninstallCmd =
        `timeout 120 ${sudo} ${shellEscape(scriptPath)} uninstall ` +
        `${shellEscape(info.serverUrl)} ${shellEscape(info.meshShort)}`;
      const uninstallResult = await runShell(uninstallCmd, 130000);
      combinedOutput += `${uninstallResult.stdout}\n${uninstallResult.stderr}\n`;
    }

    console.log('[Agent] Installing MeshCentral agent (group id …' + info.meshShort.slice(0, 8) + ')…');
    const installCmd =
      `timeout 240 ${sudo} ${shellEscape(scriptPath)} ` +
      `${shellEscape(info.serverUrl)} ${shellEscape(info.meshShort)}`;
    const result = await runShell(installCmd, 250000);
    combinedOutput += `${result.stdout}\n${result.stderr}`;

    if (combinedOutput.trim()) {
      console.log('[Agent] Install output:\n' + combinedOutput.trim().slice(-1500));
    }

    const verdict = classifyInstallOutput(combinedOutput);
    if (!verdict.ok) {
      return {
        ok: false,
        error: verdict.error,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    }

    const running = await verifyAgentRunning();
    if (!running) {
      return {
        ok: false,
        error: 'Agent install script finished but meshagent is not installed on this device.',
        stdout: result.stdout,
        stderr: result.stderr,
      };
    }

    console.log('[Agent] MeshCentral agent installed on this device.');
    return { ok: true, stdout: result.stdout, stderr: result.stderr, meshShort: info.meshShort };
  } catch (e) {
    const output = `${e.stdout || ''}\n${e.stderr || ''}`.trim();
    if (output) console.error('[Agent] Install failed:\n' + output.slice(-1500));
    return {
      ok: false,
      error: e.killed ? 'Agent install timed out — check network and device password.' : e.message,
      stdout: e.stdout || '',
      stderr: e.stderr || '',
    };
  } finally {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* ignore cleanup errors */
    }
  }
}

module.exports = {
  buildAgentInstallInfo,
  canAutoInstall,
  isAgentInstalled,
  verifySudoPassword,
  verifyMeshGroupDownload,
  runMeshAgentInstall,
};
