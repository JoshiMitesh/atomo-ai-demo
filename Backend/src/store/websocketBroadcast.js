let broadcastFn = null;

function setBroadcast(fn) {
  broadcastFn = fn;
}

function broadcast(data) {
  if (typeof broadcastFn === 'function') {
    broadcastFn(data);
  }
}

module.exports = {
  setBroadcast,
  broadcast
};
