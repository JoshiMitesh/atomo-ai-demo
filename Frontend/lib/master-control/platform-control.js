const { getDb } = require('./db');

function mapPlatformState(row) {
  return {
    platformEnabled: row.platform_enabled === 1,
    maintenanceMode: row.maintenance_mode === 1,
    emergencyLockdown: row.emergency_lockdown === 1,
    readOnlyMode: row.read_only_mode === 1,
    featureFreeze: row.feature_freeze === 1,
    registrationDisabled: row.registration_disabled === 1,
    loginDisabled: row.login_disabled === 1,
    apiDisabled: row.api_disabled === 1,
    maintenanceMessage: row.maintenance_message,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    updatedBy: row.updated_by,
  };
}

function getPlatformState() {
  const row = getDb().prepare('SELECT * FROM platform_state WHERE id = 1').get();
  return mapPlatformState(row);
}

function updatePlatformState(patch, updatedBy) {
  const current = getPlatformState();
  const next = { ...current, ...patch };
  getDb()
    .prepare(`
      UPDATE platform_state SET
        platform_enabled = ?,
        maintenance_mode = ?,
        emergency_lockdown = ?,
        read_only_mode = ?,
        feature_freeze = ?,
        registration_disabled = ?,
        login_disabled = ?,
        api_disabled = ?,
        maintenance_message = ?,
        updated_at = ?,
        updated_by = ?
      WHERE id = 1
    `)
    .run(
      next.platformEnabled ? 1 : 0,
      next.maintenanceMode ? 1 : 0,
      next.emergencyLockdown ? 1 : 0,
      next.readOnlyMode ? 1 : 0,
      next.featureFreeze ? 1 : 0,
      next.registrationDisabled ? 1 : 0,
      next.loginDisabled ? 1 : 0,
      next.apiDisabled ? 1 : 0,
      next.maintenanceMessage || null,
      Date.now(),
      updatedBy || null
    );
  return { previous: current, current: getPlatformState() };
}

function isLoginAllowed() {
  const state = getPlatformState();
  if (!state.platformEnabled) return false;
  if (state.emergencyLockdown) return false;
  if (state.loginDisabled) return false;
  return true;
}

function isRegistrationAllowed() {
  const state = getPlatformState();
  if (!state.platformEnabled) return false;
  if (state.emergencyLockdown) return false;
  if (state.registrationDisabled) return false;
  return true;
}

function isApiAllowed() {
  const state = getPlatformState();
  if (!state.platformEnabled) return false;
  if (state.emergencyLockdown) return false;
  if (state.apiDisabled) return false;
  return true;
}

function isReadOnly() {
  const state = getPlatformState();
  return state.readOnlyMode || state.featureFreeze;
}

function isMaintenanceMode() {
  return getPlatformState().maintenanceMode;
}

module.exports = {
  getPlatformState,
  updatePlatformState,
  isLoginAllowed,
  isRegistrationAllowed,
  isApiAllowed,
  isReadOnly,
  isMaintenanceMode,
};
