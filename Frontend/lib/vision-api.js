'use strict';

/**
 * Authenticated client for the Atomo Fordge Vision API.
 *
 * Supported environment variables:
 *   VISION_API_URL / BACKEND_API_URL
 *   VISION_API_TOKEN
 *   VISION_API_USERNAME (default: admin)
 *   VISION_API_PASSWORD (default: admin123)
 *   VISION_API_TIMEOUT_MS (default: 10000)
 *   VISION_HEALTH_TIMEOUT_MS (default: 2500)
 */

function normalizeBase(base) {
  return String(base || 'http://localhost:3001').trim().replace(/\/+$/, '');
}

function isBodyObject(body) {
  if (!body || typeof body !== 'object') return false;
  if (Buffer.isBuffer(body)) return false;
  if (typeof FormData !== 'undefined' && body instanceof FormData) return false;
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return false;
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return false;
  if (typeof body.pipe === 'function') return false;
  return true;
}

function errorMessageFromPayload(payload, fallback) {
  if (payload && typeof payload === 'object') {
    return payload.error || payload.message || payload.detail || fallback;
  }
  if (typeof payload === 'string' && payload.trim()) return payload.trim();
  return fallback;
}

function createVisionClient(baseUrl, options = {}) {
  const BASE = normalizeBase(
    baseUrl || process.env.VISION_API_URL || process.env.BACKEND_API_URL,
  );
  const label = options.label || 'vision';
  const username = options.username || process.env.VISION_API_USERNAME || 'admin';
  const password = options.password || process.env.VISION_API_PASSWORD || 'admin123';
  let token = options.token || process.env.VISION_API_TOKEN || null;
  let loginPromise = null;

  function urlFor(pathOrUrl) {
    const value = String(pathOrUrl || '');
    if (/^https?:\/\//i.test(value)) return value;
    return `${BASE}/${value.replace(/^\/+/, '')}`;
  }

  async function rawFetch(pathOrUrl, requestOptions = {}) {
    const timeoutMs = Math.max(
      250,
      Number(requestOptions.timeoutMs || process.env.VISION_API_TIMEOUT_MS) || 10000,
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const callerSignal = requestOptions.signal;
    const abortFromCaller = () => controller.abort();
    if (callerSignal) {
      if (callerSignal.aborted) controller.abort();
      else callerSignal.addEventListener('abort', abortFromCaller, { once: true });
    }

    const init = { ...requestOptions, signal: controller.signal };
    delete init.timeoutMs;
    delete init.auth;
    delete init.retryAuth;

    try {
      return await fetch(urlFor(pathOrUrl), init);
    } catch (err) {
      if (err?.name === 'AbortError') {
        const timeoutError = new Error(`${label} API request timed out after ${timeoutMs}ms`);
        timeoutError.code = 'VISION_API_TIMEOUT';
        timeoutError.cause = err;
        throw timeoutError;
      }
      const networkError = new Error(`${label} API is unreachable: ${err.message}`);
      networkError.code = 'VISION_API_UNREACHABLE';
      networkError.cause = err;
      throw networkError;
    } finally {
      clearTimeout(timer);
      if (callerSignal) callerSignal.removeEventListener('abort', abortFromCaller);
    }
  }

  async function login({ force = false } = {}) {
    if (token && !force) return token;
    if (loginPromise) return loginPromise;

    const pending = (async () => {
      const response = await rawFetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ username, password }),
        auth: false,
        timeoutMs: Math.max(2000, Number(process.env.VISION_LOGIN_TIMEOUT_MS) || 8000),
      });
      const text = await response.text();
      let payload = null;
      try { payload = text ? JSON.parse(text) : {}; } catch { payload = text; }
      if (!response.ok || !payload?.token) {
        const err = new Error(errorMessageFromPayload(
          payload,
          `Vision API login failed (${response.status})`,
        ));
        err.status = response.status;
        err.payload = payload;
        throw err;
      }
      token = payload.token;
      return token;
    })();

    loginPromise = pending;
    try {
      return await pending;
    } finally {
      if (loginPromise === pending) loginPromise = null;
    }
  }

  function prepareRequest(requestOptions, authToken) {
    const headers = new Headers(requestOptions.headers || {});
    headers.set('Accept', headers.get('Accept') || 'application/json');
    if (authToken) headers.set('Authorization', `Bearer ${authToken}`);

    let body = requestOptions.body;
    if (isBodyObject(body)) {
      body = JSON.stringify(body);
      if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    }
    return { ...requestOptions, headers, body };
  }

  async function apiFetch(pathOrUrl, requestOptions = {}) {
    const requiresAuth = requestOptions.auth !== false
      && !String(pathOrUrl).includes('/api/auth/login');
    let authToken = null;
    if (requiresAuth) authToken = await login();

    let response = await rawFetch(
      pathOrUrl,
      prepareRequest(requestOptions, authToken),
    );

    if (requiresAuth && response.status === 401 && requestOptions.retryAuth !== false) {
      try { await response.arrayBuffer(); } catch { /* ignore response drain errors */ }
      token = null;
      authToken = await login({ force: true });
      response = await rawFetch(
        pathOrUrl,
        prepareRequest({ ...requestOptions, retryAuth: false }, authToken),
      );
    }
    return response;
  }

  async function apiJson(pathOrUrl, requestOptions = {}) {
    const response = await apiFetch(pathOrUrl, requestOptions);
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = text; }
    if (!response.ok) {
      const err = new Error(errorMessageFromPayload(
        payload,
        `${label} API request failed (${response.status})`,
      ));
      err.status = response.status;
      err.payload = payload;
      err.path = pathOrUrl;
      throw err;
    }
    return payload;
  }

  async function isReachable() {
    try {
      const response = await rawFetch('/health', {
        method: 'GET',
        auth: false,
        timeoutMs: Math.max(
          500,
          Number(process.env.VISION_HEALTH_TIMEOUT_MS) || 2500,
        ),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  return {
    BASE,
    apiFetch,
    apiJson,
    isReachable,
    login,
    getToken: () => token,
    clearToken: () => { token = null; },
  };
}

const defaultClient = createVisionClient(
  process.env.VISION_API_URL || process.env.BACKEND_API_URL,
  { label: 'vision' },
);

module.exports = {
  createVisionClient,
  apiFetch: (...args) => defaultClient.apiFetch(...args),
  apiJson: (...args) => defaultClient.apiJson(...args),
  isReachable: (...args) => defaultClient.isReachable(...args),
  login: (...args) => defaultClient.login(...args),
  BASE: defaultClient.BASE,
};
