const routes = require('./routes');
const { ensureDefaultAdmin } = require('./permissions');
const { ensureDefaultTenant } = require('./tenants');
const { getPlatformState, isLoginAllowed, isRegistrationAllowed } = require('./platform-control');
const { isFlagEnabled } = require('./feature-flags');
const { attachMasterContext } = require('./middleware');

function bootstrapMasterControl({ meshUserId, username, organizationName }) {
  if (meshUserId) {
    ensureDefaultAdmin(meshUserId, username);
    ensureDefaultTenant({
      name: organizationName || 'Default Organization',
      slug: 'default',
      ownerUserId: meshUserId,
    });
  }
}

module.exports = {
  routes,
  bootstrapMasterControl,
  getPlatformState,
  isLoginAllowed,
  isRegistrationAllowed,
  isFlagEnabled,
  attachMasterContext,
};
