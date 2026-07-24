const { checkHealth } = require('./meshcentral-client');

const CACHE_MS = 20000;

let reachable = false;
let lastCheck = Date.now();
let refreshPromise = null;

function getReachable() {
  return reachable;
}

function isStale() {
  return Date.now() - lastCheck > CACHE_MS;
}

function markUnreachable() {
  reachable = false;
  lastCheck = Date.now();
}

function markReachable() {
  reachable = true;
  lastCheck = Date.now();
}

async function refresh() {
  if (refreshPromise) return refreshPromise;

  refreshPromise = checkHealth()
    .then((health) => {
      reachable = health.ok;
      lastCheck = Date.now();
      return reachable;
    })
    .catch(() => {
      reachable = false;
      lastCheck = Date.now();
      return false;
    })
    .finally(() => {
      refreshPromise = null;
    });

  return refreshPromise;
}

function startBackgroundRefresh(intervalMs = CACHE_MS) {
  refresh().catch(() => {});
  setInterval(() => {
    refresh().catch(() => {});
  }, intervalMs);
}

module.exports = {
  getReachable,
  isStale,
  markUnreachable,
  markReachable,
  refresh,
  startBackgroundRefresh,
};
