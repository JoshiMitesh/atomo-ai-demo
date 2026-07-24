#!/usr/bin/env bash
# Runs on AWS via: ssh ubuntu@host 'bash -s' < scripts/meshcentral-remote-restart.sh
set -euo pipefail

NODE="${NODE:-$HOME/.nvm/versions/node/v24.16.0/bin/node}"
DIR="${DIR:-$HOME/new/atomic/MeshCentral-master}"

if [[ ! -x "$NODE" ]]; then
  export NVM_DIR="$HOME/.nvm"
  # shellcheck source=/dev/null
  [[ -s "$NVM_DIR/nvm.sh" ]] && . "$NVM_DIR/nvm.sh"
  NODE="$(command -v node)"
fi

for p in $(sudo lsof -t -i:4434 2>/dev/null || true); do
  sudo kill -9 "$p" 2>/dev/null || true
done
sleep 2

cd "$DIR"
nohup "$NODE" meshcentral.js >> /tmp/meshcentral.log 2>&1 &
echo "MeshCentral starting (pid $!) — log: /tmp/meshcentral.log"
