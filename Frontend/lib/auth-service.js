const { proxyJson, checkHealth, isNetworkError } = require('./meshcentral-client');
const meshcentralStatus = require('./meshcentral-status');
const deviceBinding = require('./device-binding');
const deviceProfile = require('./device-profile');
const session = require('./session');
const { offlineLoginEnabled } = require('./device-config');

function guessMeshUserId(username) {
  return `user//${String(username).trim().toLowerCase()}`;
}

function resolveAccountEmail({ email, username }) {
  if (email) return email;
  const binding = deviceBinding.getBinding();
  if (binding?.username?.toLowerCase() === String(username || '').trim().toLowerCase()) {
    return binding.email || null;
  }
  return null;
}

function buildLoginSuccess({ username, meshUserId, mode, offline, password, email }) {
  const accountEmail = resolveAccountEmail({ email, username });
  const sess = session.createSession({
    meshUserId,
    username,
    password,
    email: accountEmail,
  });
  const prefix = offline ? '(offline) ' : '';
  const onboardingComplete = deviceProfile.isUserOnboarded(meshUserId);
  return {
    status: 200,
    data: {
      success: true,
      message: `${prefix}Welcome back, ${username}!`,
      username,
      userId: meshUserId,
      email: accountEmail,
      offline: !!offline,
      mode,
      sessionId: sess.sessionId,
      onboardingComplete,
      redirectTo: onboardingComplete ? '/cluster-role' : '/device-registration',
    },
  };
}

async function bindAfterAuth({ meshUserId, username, email, password }) {
  const uid = meshUserId || guessMeshUserId(username);
  const existing = deviceBinding.getBinding();

  // Online login: bind on first use, refresh hash for same user; other users may sign in without rebinding.
  if (existing && existing.meshUserId !== uid) {
    return null;
  }

  await deviceBinding.bindUser({
    meshUserId: uid,
    username,
    email: email || existing?.email || null,
    password,
  });

  return null;
}

async function tryOfflineLogin(username, password) {
  const allowed = deviceBinding.checkUserAllowed(username);
  if (!allowed.ok) {
    return { status: allowed.status, data: { error: allowed.error } };
  }

  const local = await deviceBinding.authenticateBound(username, password);
  if (local.ok) {
    const accountEmail = resolveAccountEmail({ username: local.username });
    return buildLoginSuccess({
      username: local.username,
      meshUserId: local.meshUserId,
      mode: 'offline',
      offline: true,
      password,
      email: accountEmail,
    });
  }

  if (local.reason === 'not_bound') {
    return {
      status: 503,
      data: {
        error:
          'No internet and this device has no registered user. Sign up or log in once while online.',
      },
    };
  }

  if (local.reason === 'wrong_user') {
    const binding = deviceBinding.getBinding();
    return {
      status: 403,
      data: {
        error: `This device is registered to "${binding.username}". Only that user can sign in here.`,
      },
    };
  }

  return {
    status: 401,
    data: { error: 'Invalid username or password.' },
  };
}

async function login(username, password) {
  const canUseOfflineFast =
    offlineLoginEnabled() &&
    deviceBinding.isBound() &&
    !meshcentralStatus.getReachable() &&
    !meshcentralStatus.isStale();

  if (canUseOfflineFast) {
    console.warn('[Auth] Atomic Center offline (cached) — offline login for bound user');
    return tryOfflineLogin(username, password);
  }

  try {
    const result = await proxyJson('/api/atomoforge/login', 'POST', { username, password });

    if (result.status >= 200 && result.status < 300 && result.data.success) {
      meshcentralStatus.markReachable();
      const meshUserId = result.data.userId || guessMeshUserId(result.data.username || username);
      const loggedInUsername = result.data.username || username;
      const accountEmail = resolveAccountEmail({
        email: result.data.email,
        username: loggedInUsername,
      });
      await bindAfterAuth({
        meshUserId,
        username: loggedInUsername,
        email: accountEmail,
        password,
      });

      return buildLoginSuccess({
        username: loggedInUsername,
        meshUserId,
        mode: 'remote',
        offline: false,
        password,
        email: accountEmail,
      });
    }

    return result;
  } catch (e) {
    if (!offlineLoginEnabled() || !isNetworkError(e)) {
      throw e;
    }

    meshcentralStatus.markUnreachable();
    console.warn('[Auth] MeshCentral unreachable — offline login for bound user');

    return tryOfflineLogin(username, password);
  }
}

async function completeSignupBind({ username, email, password, userId }) {
  const meshUserId = userId || guessMeshUserId(username);
  await bindAfterAuth({ meshUserId, username, email, password });
  return buildLoginSuccess({
    username,
    meshUserId,
    mode: 'remote',
    offline: false,
    password,
    email,
  });
}

module.exports = {
  login,
  completeSignupBind,
};
