const https = require('https');
const { URL } = require('url');
const { getMeshcentralUrl, allowInsecureTls, getAtomoforgeApiKey } = require('./device-config');

function getAgent() {
  if (!allowInsecureTls()) return undefined;
  return new https.Agent({ rejectUnauthorized: false });
}

function logMeshCentralError(context, url, err) {
  const cause = err?.cause || err;
  console.error(`[MeshCentral] ${context}`);
  if (url) console.error(`[MeshCentral] URL: ${url}`);
  if (cause?.message) console.error(`[MeshCentral] Message: ${cause.message}`);
  if (cause?.code) console.error(`[MeshCentral] Code: ${cause.code}`);
  if (cause?.errno) console.error(`[MeshCentral] Errno: ${cause.errno}`);
  if (cause?.syscall) console.error(`[MeshCentral] Syscall: ${cause.syscall}`);
  if (cause?.stack) console.error(cause.stack);
}

function getProxyHeaders(extraHeaders = {}) {
  const headers = { ...extraHeaders };
  const apiKey = getAtomoforgeApiKey();
  if (apiKey) headers['X-AtomoForge-Key'] = apiKey;
  return headers;
}

function requestJson(url, method, body, extraHeaders = {}) {
  return requestRaw(url, method, body, extraHeaders).then(({ status, text }) => {
    let data = {};
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { error: text.slice(0, 200) };
      }
    }
    return { status, data };
  });
}

function requestRaw(url, method = 'GET', body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const agent = getAgent();
    const options = {
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method,
      headers: {
        Accept: '*/*',
        ...getProxyHeaders(extraHeaders),
      },
    };
    if (body !== undefined) {
      options.headers['Content-Type'] = 'application/json';
    }
    if (agent) options.agent = agent;

    const req = https.request(options, (res) => {
      let text = '';
      res.on('data', (chunk) => {
        text += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.setTimeout(4000, () => {
      req.destroy();
      const err = new Error(`Request timed out after 4s: ${url}`);
      err.code = 'ETIMEDOUT';
      reject(err);
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

async function checkMeshGroupDownload(meshShort) {
  const baseUrl = getMeshcentralUrl();
  if (!baseUrl || !meshShort) {
    return { ok: false, error: 'MeshCentral URL or device group id is missing.' };
  }

  const url = `${baseUrl}/meshsettings?id=${encodeURIComponent(meshShort)}`;
  try {
    const { status, text } = await requestRaw(url, 'GET');
    if (status === 200 && text.includes('MeshID=')) {
      return { ok: true };
    }
    if (status === 401) {
      return {
        ok: false,
        error: 'Device group not found on Atomic Center (or agent download is locked). Check the group was created and lockagentdownload is false.',
      };
    }
    return {
      ok: false,
      error: `Atomic Center returned HTTP ${status} for meshsettings — agent cannot be installed.`,
    };
  } catch (e) {
    return { ok: false, error: `Cannot reach Atomic Center for agent install: ${e.message}` };
  }
}

async function proxyJson(apiPath, method, body, extraHeaders = {}) {
  const baseUrl = getMeshcentralUrl();
  if (!baseUrl) {
    throw new Error('MeshCentral URL is not configured.');
  }

  const url = `${baseUrl}${apiPath}`;

  let result;
  try {
    result = await requestJson(url, method, body, extraHeaders);
  } catch (e) {
    logMeshCentralError(`${method} ${apiPath} failed`, url, e);
    const err = new Error(
      `Cannot reach MeshCentral at ${baseUrl}. Check network, security group, and that MeshCentral is running.`
    );
    err.cause = e;
    throw err;
  }

  return result;
}

async function checkHealth() {
  const { status, data } = await proxyJson('/api/atomoforge/health', 'GET');
  return { ok: status === 200 && data.ok === true, status, data };
}

const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
  'ECONNRESET',
]);

function isNetworkError(err) {
  const code = err?.cause?.code || err?.code;
  return NETWORK_ERROR_CODES.has(code);
}

module.exports = {
  proxyJson,
  checkHealth,
  checkMeshGroupDownload,
  isNetworkError,
  getProxyHeaders,
  requestRaw,
};
