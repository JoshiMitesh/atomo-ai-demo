const path = require('path');
const { loadConfig } = require('../device-config');

function getMasterControlDbPath() {
  if (process.env.MASTER_CONTROL_DB) {
    return path.resolve(process.env.MASTER_CONTROL_DB);
  }
  const cfg = loadConfig();
  if (cfg.masterControlDb) {
    return path.resolve(path.join(__dirname, '..', '..', cfg.masterControlDb));
  }
  return path.join(__dirname, '..', '..', 'data', 'master-control.sqlite');
}

function getMasterControlEnvironment() {
  return process.env.MASTER_CONTROL_ENV || loadConfig().masterControlEnv || 'production';
}

module.exports = {
  getMasterControlDbPath,
  getMasterControlEnvironment,
};
