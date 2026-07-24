#!/usr/bin/env bash
# Deploy updated atomoforge-api.js and config to AWS Atomic Center (MeshCentral).
#
# Usage:
#   export AWS_HOST=ubuntu@3.108.185.253
#   export AWS_SSH_KEY=/path/to/atomo_web.pem   # optional
#   ./scripts/deploy-atomic-center-api.sh
#
# Requires SSH access to the EC2 instance.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AWS_HOST="${AWS_HOST:-ubuntu@3.108.185.253}"
AWS_MESH_DIR="${AWS_MESH_DIR:-new/atomic/MeshCentral-master}"
LOCAL_API="$ROOT/atomic/MeshCentral-master/atomoforge-api.js"
LOCAL_CONFIG="$ROOT/atomic/MeshCentral-master/meshcentral-data/config.json"
AWS_SSH_KEY="${AWS_SSH_KEY:-$ROOT/atomo_web.pem}"
MESHCENTRAL_URL="${MESHCENTRAL_URL:-https://3.108.185.253:4434}"
RESTART_SCRIPT="$ROOT/scripts/meshcentral-remote-restart.sh"

SCP=(scp)
SSH=(ssh -o ConnectTimeout=20)
if [[ -f "$AWS_SSH_KEY" ]]; then
  SCP+=( -i "$AWS_SSH_KEY" -o StrictHostKeyChecking=accept-new )
  SSH+=( -i "$AWS_SSH_KEY" -o StrictHostKeyChecking=accept-new )
fi

if [[ ! -f "$LOCAL_API" ]]; then
  echo "Missing $LOCAL_API"
  exit 1
fi

if [[ ! -f "$RESTART_SCRIPT" ]]; then
  echo "Missing $RESTART_SCRIPT"
  exit 1
fi

echo "Uploading atomoforge-api.js to $AWS_HOST (via /tmp, sudo install)…"
"${SCP[@]}" "$LOCAL_API" "$AWS_HOST:/tmp/atomoforge-api.js"
"${SSH[@]}" "$AWS_HOST" "sudo cp /tmp/atomoforge-api.js ~/$AWS_MESH_DIR/atomoforge-api.js"

if [[ -f "$LOCAL_CONFIG" ]]; then
  echo "Uploading config.json…"
  "${SCP[@]}" "$LOCAL_CONFIG" "$AWS_HOST:/tmp/atomoforge-config.json"
  "${SSH[@]}" "$AWS_HOST" "sudo cp /tmp/atomoforge-config.json ~/$AWS_MESH_DIR/meshcentral-data/config.json"
fi

echo "Restarting MeshCentral on AWS…"
# Pipe restart script on stdin so SSH argv never contains "meshcentral.js" (pkill self-match).
"${SSH[@]}" "$AWS_HOST" "bash -s" < "$RESTART_SCRIPT" || {
  echo "Warning: remote restart command failed; checking health anyway…"
}

echo "Waiting for MeshCentral on 4434…"
health_ok=0
for _ in $(seq 1 15); do
  if curl -sk --connect-timeout 3 "$MESHCENTRAL_URL/api/atomoforge/health" | grep -q '"ok":true'; then
    health_ok=1
    break
  fi
  sleep 2
done

echo "Testing REST health…"
curl -sk "$MESHCENTRAL_URL/api/atomoforge/health" | head -c 200
echo
echo "Testing delete route…"
curl -sk -X POST -H "Content-Type: application/json" \
  -H "X-AtomoForge-Key: atomo-dev-key-change-in-production" \
  -d '{"deviceSerial":"TEST","adminDelete":true}' \
  "$MESHCENTRAL_URL/api/atomoforge/devices/delete" | head -c 200
echo

if [[ "$health_ok" -eq 1 ]]; then
  echo "Done. MeshCentral is up."
else
  echo "Upload OK, but health check failed. On AWS (SSH) run:"
  echo "  bash -s < scripts/meshcentral-remote-restart.sh"
  echo "  tail -30 /tmp/meshcentral.log"
  exit 1
fi
