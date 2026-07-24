'use strict';

const base = String(
  process.env.VISION_API_URL
  || process.env.BACKEND_API_URL
  || 'http://localhost:3001',
).replace(/\/+$/, '');
const username = process.env.VISION_API_USERNAME
  || process.env.BACKEND_API_USERNAME
  || process.env.BACKEND_API_USER
  || 'admin';
const password = process.env.VISION_API_PASSWORD
  || process.env.BACKEND_API_PASSWORD
  || '';

async function request(path, options = {}) {
  const response = await fetch(`${base}${path}`, options);
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = text; }
  if (!response.ok) {
    const error = new Error(data?.error || `${path} returned HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

async function main() {
  console.log(`Checking final Backend at ${base}`);
  if (!password) {
    throw new Error('Set VISION_API_PASSWORD in Frontend/.env before running this check');
  }

  await request('/health');
  console.log('  OK  health');

  const login = await request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!login.token) throw new Error('Backend login returned no JWT token');
  console.log('  OK  authentication');

  const headers = { Authorization: `Bearer ${login.token}` };
  const checks = [
    ['cameras', '/api/cameras'],
    ['models', '/api/models'],
    ['settings', '/api/settings'],
    ['system stats', '/api/system/stats'],
    ['face worker', '/api/face/worker/status'],
  ];

  for (const [label, path] of checks) {
    await request(path, { headers });
    console.log(`  OK  ${label}`);
  }

  console.log('Backend compatibility check passed.');
}

main().catch((err) => {
  console.error(`Backend compatibility check failed: ${err.message}`);
  process.exitCode = 1;
});
